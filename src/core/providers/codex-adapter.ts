/**
 * CodexAdapter — ProviderAdapter implementation for OpenAI Codex CLI.
 *
 * Lifecycle: `per-turn-resume`
 *   - Every turn spawns a fresh `codex exec` subprocess.
 *   - Thread context is chained via `codex exec resume <thread_id>` on subsequent turns.
 *   - The subprocess exits naturally after each turn (one-shot process).
 *
 * System prompt injection (MVP approach):
 *   The Codex CLI does not expose a direct `--system-prompt` flag in its exec mode.
 *   We synthesise system + user content as a single stdin payload:
 *
 *     [SYSTEM]\n<systemPrompt>\n\n[USER]\n<userMessage>
 *
 *   This is repeated every turn because the Hub's SystemPromptEvolver may produce
 *   a different evolved prompt each time. The token overhead is accepted in exchange
 *   for correctness and simplicity.
 *
 *   Alternative considered: `--profile` config file — ruled out for MVP because it
 *   requires file I/O per turn and complicates cleanup.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import type { ChatSession, NormalizedMessage, ProviderAdapter, SpawnOptions } from './types.js';

// ---------------------------------------------------------------------------
// Internal JSONL event types emitted by `codex exec --json`
// ---------------------------------------------------------------------------

interface CodexThreadStartedEvent {
  type: 'thread.started';
  thread_id: string;
}

interface CodexTurnStartedEvent {
  type: 'turn.started';
}

interface CodexItemStartedEvent {
  type: 'item.started';
  item: {
    type: string;
    id?: string;
    name?: string;
    arguments?: unknown;
    [key: string]: unknown;
  };
}

interface CodexItemCompletedEvent {
  type: 'item.completed';
  item: {
    type: string;
    text?: string;
    id?: string;
    output?: unknown;
    [key: string]: unknown;
  };
}

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

interface CodexTurnCompletedEvent {
  type: 'turn.completed';
  usage?: CodexUsage;
}

interface CodexErrorEvent {
  type: 'error';
  message?: string;
  code?: string;
  [key: string]: unknown;
}

type CodexEvent =
  | CodexThreadStartedEvent
  | CodexTurnStartedEvent
  | CodexItemStartedEvent
  | CodexItemCompletedEvent
  | CodexTurnCompletedEvent
  | CodexErrorEvent;

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a single line of JSONL output from `codex exec --json`.
 * Returns null for blank lines or lines that are not valid JSON.
 */
function parseLine(line: string): CodexEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as CodexEvent;
  } catch {
    // Non-JSON diagnostic output — silently ignore.
    return null;
  }
}

/**
 * Convert a parsed CodexEvent into zero or one NormalizedMessage.
 *
 * Returns null for events that carry no user-visible content
 * (e.g. `thread.started`, `turn.started`).
 *
 * Side-effects: updates `sessionIdRef.current` when a `thread.started` event
 * is observed so the calling CodexSession can capture the thread ID.
 */
function normalizeEvent(
  event: CodexEvent,
  sessionIdRef: { current: string }
): NormalizedMessage | null {
  switch (event.type) {
    case 'thread.started': {
      // Capture the thread ID for future resume calls — no message emitted.
      sessionIdRef.current = event.thread_id;
      return null;
    }

    case 'turn.started': {
      // Informational only.
      return null;
    }

    case 'item.started': {
      const { item } = event;
      // Translate tool / command execution starts into tool_use content blocks.
      if (item.type === 'command_execution' || item.type === 'function_call') {
        return {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              toolName: item.name ?? item.type,
              toolInput: item.arguments ?? null,
            },
          ],
          timestamp: new Date().toISOString(),
          providerMeta: { codexItemType: item.type, codexItemId: item.id },
        };
      }
      // Other item types (e.g. reasoning steps) — skip.
      return null;
    }

    case 'item.completed': {
      const { item } = event;
      // Agent message completion — primary text output.
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        return {
          role: 'assistant',
          content: [{ type: 'text', text: item.text }],
          timestamp: new Date().toISOString(),
          providerMeta: { codexItemType: item.type },
        };
      }
      // Tool result completion.
      if (item.type === 'function_call_output' || item.type === 'command_output') {
        return {
          role: 'tool',
          content: [{ type: 'tool_result', toolOutput: item.output ?? null }],
          timestamp: new Date().toISOString(),
          providerMeta: { codexItemType: item.type, codexItemId: item.id },
        };
      }
      return null;
    }

    case 'turn.completed': {
      // Surface token usage in providerMeta; no conversational content.
      return {
        role: 'system',
        content: '',
        timestamp: new Date().toISOString(),
        providerMeta: { codexEvent: 'turn.completed', usage: event.usage ?? null },
      };
    }

    case 'error': {
      const errText = event.message ?? `Codex error (code=${event.code ?? 'unknown'})`;
      return {
        role: 'system',
        content: errText,
        timestamp: new Date().toISOString(),
        providerMeta: { codexEvent: 'error', codexError: event },
      };
    }

    default: {
      // Forward compatibility: unknown event types are silently dropped.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt synthesis
// ---------------------------------------------------------------------------

/**
 * Compose the stdin payload for `codex exec` by prefixing the system prompt
 * before the user message.
 *
 * Format (MVP — plain text synthesis):
 *   [SYSTEM]
 *   <systemPrompt>
 *
 *   [USER]
 *   <userMessage>
 *
 * When systemPrompt is empty, only the user message is sent.
 */
function buildStdinPayload(systemPrompt: string, userMessage: string): string {
  if (!systemPrompt.trim()) {
    return userMessage;
  }
  return `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userMessage}`;
}

// ---------------------------------------------------------------------------
// CodexSession
// ---------------------------------------------------------------------------

/**
 * Per-turn session for the Codex provider.
 *
 * `id` starts as the value supplied by the Hub (resumeSessionId) or an empty
 * placeholder. After the first `send()` call completes, `id` is updated to the
 * thread_id reported by the `thread.started` event so the Hub can persist it
 * for the next turn.
 *
 * Note: `id` is declared as `readonly` in the ChatSession interface, but we
 * need to mutate it internally after observing the thread.started event.
 * We satisfy the contract by exposing `id` as a public getter and holding the
 * mutable value in a private field.
 */
class CodexSession implements ChatSession {
  readonly provider = 'codex' as const;

  private _id: string;
  private readonly opts: SpawnOptions;

  /** True after close() has been called. */
  private closed = false;

  constructor(opts: SpawnOptions) {
    this.opts = opts;
    // Use the resume ID supplied by the Hub as the initial session ID.
    // It will be overwritten once the first `thread.started` event arrives.
    this._id = opts.resumeSessionId ?? '';
  }

  get id(): string {
    return this._id;
  }

  /**
   * Send a user message to Codex and stream the response.
   *
   * First call (no resumeSessionId):
   *   codex exec --json --sandbox workspace-write --ask-for-approval never
   *              --skip-git-repo-check --cd <cwd> -
   *   (prompt written to stdin)
   *
   * Subsequent calls (resumeSessionId present):
   *   codex exec resume <thread_id> "<prompt>" --json --sandbox workspace-write
   *              --ask-for-approval never
   */
  async *send(message: string): AsyncIterable<NormalizedMessage> {
    if (this.closed) {
      yield {
        role: 'system',
        content: 'CodexSession: send() called on a closed session',
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const sessionIdRef: { current: string } = { current: this._id };
    const stdinPayload = buildStdinPayload(this.opts.systemPrompt, message);

    const { cmd, args, useStdin } = this.buildCommand(message);
    const child = this.spawnProcess(cmd, args);

    try {
      yield* this.streamProcess(child, stdinPayload, useStdin, sessionIdRef);
    } finally {
      // Update the session's thread ID so Hub.acquireSession can persist it.
      if (sessionIdRef.current) {
        this._id = sessionIdRef.current;
      }
    }
  }

  /** close() is a no-op for per-turn sessions — the subprocess exits naturally. */
  async close(): Promise<void> {
    this.closed = true;
  }

  // -------------------------------------------------------------------------
  // Private: command construction
  // -------------------------------------------------------------------------

  private buildCommand(message: string): {
    cmd: string;
    args: string[];
    useStdin: boolean;
  } {
    const baseFlags = ['--json', '--sandbox', 'workspace-write', '--ask-for-approval', 'never'];

    if (this.opts.resumeSessionId) {
      // Resume an existing thread — pass the message as a positional argument.
      return {
        cmd: 'codex',
        args: ['exec', 'resume', this.opts.resumeSessionId, message, ...baseFlags],
        useStdin: false,
      };
    }

    // First turn — stream prompt via stdin using the `-` sentinel.
    return {
      cmd: 'codex',
      args: ['exec', '--skip-git-repo-check', '--cd', this.opts.cwd, ...baseFlags, '-'],
      useStdin: true,
    };
  }

  // -------------------------------------------------------------------------
  // Private: process spawning (extracted for testability)
  // -------------------------------------------------------------------------

  /**
   * Spawns the codex child process.
   * Separated from buildCommand so unit tests can inject a mock via spyOn.
   */
  protected spawnProcess(cmd: string, args: string[]): ChildProcess {
    return spawn(cmd, args, {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
  }

  // -------------------------------------------------------------------------
  // Private: streaming JSONL
  // -------------------------------------------------------------------------

  private async *streamProcess(
    child: ChildProcess,
    stdinPayload: string,
    useStdin: boolean,
    sessionIdRef: { current: string }
  ): AsyncIterable<NormalizedMessage> {
    // Write to stdin then close the write end.
    if (useStdin && child.stdin) {
      child.stdin.write(stdinPayload, 'utf-8');
      child.stdin.end();
    }

    // Buffer to accumulate partial lines across chunks.
    let lineBuffer = '';
    const pendingMessages: NormalizedMessage[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    // Typed as unknown to accommodate TypeScript's narrowing on event handler callbacks.
    // Validated as Error instance before use.
    let processError: unknown = null;

    // Push a normalised message into the async queue.
    const enqueue = (msg: NormalizedMessage): void => {
      pendingMessages.push(msg);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    const processChunk = (chunk: Buffer): void => {
      lineBuffer += chunk.toString('utf-8');
      const lines = lineBuffer.split('\n');
      // The last element may be an incomplete line — keep it in the buffer.
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const event = parseLine(line);
        if (!event) {
          continue;
        }
        const normalized = normalizeEvent(event, sessionIdRef);
        if (normalized !== null) {
          enqueue(normalized);
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      processChunk(chunk);
    });

    child.stderr?.on('data', (_chunk: Buffer) => {
      // Diagnostic stderr output — intentionally ignored in MVP.
      // Surface as system message if needed in a future iteration.
    });

    child.on('error', (err: unknown) => {
      processError = err;
      done = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    });

    child.on('close', (exitCode: number | null) => {
      // Flush any remaining buffered content.
      if (lineBuffer.trim()) {
        const event = parseLine(lineBuffer);
        lineBuffer = '';
        if (event) {
          const normalized = normalizeEvent(event, sessionIdRef);
          if (normalized !== null) {
            enqueue(normalized);
          }
        }
      }

      if (exitCode !== null && exitCode !== 0 && !processError) {
        enqueue({
          role: 'system',
          content: `Codex process exited with code ${exitCode}`,
          timestamp: new Date().toISOString(),
          providerMeta: { codexExitCode: exitCode },
        });
      }

      done = true;
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    });

    // Yield from the async queue until the process terminates.
    while (!done || pendingMessages.length > 0) {
      if (pendingMessages.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        yield pendingMessages.shift()!;
      } else if (!done) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    }

    // Propagate spawn errors as a system message (never throw per contract).
    if (processError !== null) {
      const errMsg = processError instanceof Error ? processError.message : String(processError);
      yield {
        role: 'system',
        content: `Codex spawn error: ${errMsg}`,
        timestamp: new Date().toISOString(),
        providerMeta: { codexEvent: 'spawn-error', error: errMsg },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

/**
 * ProviderAdapter implementation for the OpenAI Codex CLI.
 *
 * Spawns a new `codex exec` process for every turn and chains context via the
 * thread ID from the previous turn's `thread.started` event.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly id = 'codex' as const;
  readonly lifecycle = 'per-turn-resume' as const;

  /**
   * Returns true when the `codex` binary is reachable on PATH.
   * Uses `codex --version` which exits 0 on a healthy installation.
   */
  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn('codex', ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  /**
   * Create a lightweight CodexSession.
   *
   * For `per-turn-resume` providers the session object is transient — the
   * Hub will close it after collecting the response and store `session.id`
   * as the next turn's `resumeSessionId`.
   */
  async spawn(opts: SpawnOptions): Promise<ChatSession> {
    return new CodexSession(opts);
  }
}

// ---------------------------------------------------------------------------
// Exports (internal helpers exported for testing)
// ---------------------------------------------------------------------------

export type { CodexEvent };
export { buildStdinPayload, normalizeEvent, parseLine };
