/**
 * StreamJsonAdapterBase — shared base for persistent-bidirectional CLI adapters.
 *
 * Concrete adapters (ClaudeAdapter, KimiAdapter) extend this class and override
 * the four provider-specific hooks:
 *   - buildSpawnCommand  → CLI binary + args
 *   - normalizeStreamEvent → raw JSONL event → NormalizedMessage | null
 *   - serializeUserMessage → user text → JSONL line to write to stdin
 *   - extractSessionId → pull session/thread ID from init event
 *
 * Shared responsibility surface (≈90% of adapter code):
 *   - child_process.spawn lifecycle
 *   - stdin JSONL framer (line-by-line write, newline-terminated)
 *   - stdout JSONL framer (line-by-line read via data events, single reader)
 *   - async-iterator streaming
 *   - error → NormalizedMessage{role:'system'} yield (never throws)
 *   - close() with SIGTERM → 5-second SIGKILL escalation
 *
 * Design: a single stdout reader dispatches all lines to a pluggable
 * `onLine` callback.  The spawn() phase uses this to build the lineBuffer;
 * send() replaces the callback so the iterator receives all subsequent lines.
 */

// Import both spawn and execFile from the same require() to avoid
// bun:test async-context divergence when sub-modules import different symbols.
import { type ChildProcess, spawn } from 'node:child_process';
import { devLog } from '../../utils/dev-log.js';
import type {
  ChatSession,
  NormalizedMessage,
  ProviderAdapter,
  ProviderId,
  ProviderLifecycle,
  SpawnOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Result of buildSpawnCommand — the binary and its arguments. */
export interface SpawnCommand {
  cmd: string;
  args: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a NormalizedMessage for error/system notices — never throws. */
function systemMessage(content: string, meta?: Record<string, unknown>): NormalizedMessage {
  return {
    role: 'system',
    content,
    timestamp: new Date().toISOString(),
    ...(meta ? { providerMeta: meta } : {}),
  };
}

/** Gracefully terminate a child process: SIGTERM → wait 5 s → SIGKILL. */
async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill('SIGTERM');

  await new Promise<void>((resolve) => {
    const killTimeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 5_000);

    child.once('exit', () => {
      clearTimeout(killTimeout);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// JSONL reader — single reader per session, dispatches via pluggable callback
// ---------------------------------------------------------------------------

/**
 * Attaches JSONL line splitter to a readable stream using raw data events.
 * Calls `onLine` for each complete line.  Calls `onClose` when the stream ends.
 *
 * Returns a control object:
 * - `setLineHandler(fn)`: replace the active per-line callback
 * - `close()`: detach all listeners
 *
 * Avoids node:readline to prevent async-context sensitivity in bun:test.
 */
function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  initialOnLine: (line: string) => void,
  onClose: () => void
): {
  notifyEnd: () => void;
  setLineHandler: (fn: (line: string) => void) => void;
  close: () => void;
} {
  let buf = '';
  let closed = false;
  let lineHandler = initialOnLine;

  function processBuffer(): void {
    let idx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic buffer-split loop
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) {
        lineHandler(line.trim());
      }
    }
  }

  function onData(chunk: Buffer | string): void {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    processBuffer();
  }

  function onEnd(): void {
    const remaining = buf.trim();
    if (remaining) {
      lineHandler(remaining);
    }
    buf = '';
    if (!closed) {
      closed = true;
      onClose();
    }
  }

  // Register data/end/close event handlers.
  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onEnd);

  // Force flowing mode immediately — necessary in some bun:test configurations
  // where PassThrough doesn't automatically enter flowing mode.
  const readable = stream as NodeJS.ReadableStream & {
    resume?: () => void;
    read?: (n?: number) => Buffer | null;
  };
  if (readable.resume) {
    readable.resume();
  }

  return {
    notifyEnd(): void {
      onEnd();
    },
    setLineHandler(fn: (line: string) => void): void {
      lineHandler = fn;
    },
    close(): void {
      if (!closed) {
        closed = true;
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('close', onEnd);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// StreamJsonAdapterBase
// ---------------------------------------------------------------------------

/**
 * Abstract base class for stream-json bidirectional CLI adapters.
 *
 * Subclasses MUST implement:
 *   - id / lifecycle (readonly fields)
 *   - isAvailable()
 *   - buildSpawnCommand(opts)
 *   - normalizeStreamEvent(event)
 *   - serializeUserMessage(message)
 *   - extractSessionId(event) — return session ID string if this is the init event
 */
export abstract class StreamJsonAdapterBase implements ProviderAdapter {
  abstract readonly id: ProviderId;
  abstract readonly lifecycle: ProviderLifecycle;

  /**
   * Some stream-json CLIs emit their init/session event only after the first
   * JSONL user message is written. Claude Code 2.1.x behaves this way with
   * `--input-format stream-json`, so adapters can opt out of blocking spawn()
   * on the init event and let send() capture it instead.
   */
  protected readonly waitForSessionInitBeforeSpawn: boolean = true;

  abstract isAvailable(): Promise<boolean>;

  /**
   * Return the binary and arguments to spawn.
   * Called once per spawn(); result is forwarded to child_process.spawn.
   */
  abstract buildSpawnCommand(opts: SpawnOptions): SpawnCommand;

  /**
   * Parse a single parsed JSON event from stdout into a NormalizedMessage.
   * Return null to silently discard the event (e.g. heartbeat, init).
   */
  abstract normalizeStreamEvent(event: unknown): NormalizedMessage | null;

  /**
   * Serialize a user text message into a JSONL line written to stdin.
   * The returned string MUST NOT include a trailing newline — the base
   * class appends '\n' before writing.
   */
  abstract serializeUserMessage(message: string): string;

  /**
   * If the given event is the provider's session-init event, return the
   * session ID string.  Otherwise return null.
   */
  abstract extractSessionId(event: unknown): string | null;

  /**
   * Return true for provider events that mark the current user turn complete
   * while the process may remain alive for more JSONL input.
   */
  isTurnCompleteEvent(_event: unknown): boolean {
    return false;
  }

  /**
   * Session ID to expose before an init event arrives. Defaults to an explicit
   * resume ID when present; adapters that create their own session ID in
   * buildSpawnCommand() can override this.
   */
  protected getProvisionalSessionId(_opts: SpawnOptions, _command: SpawnCommand): string {
    return _opts.resumeSessionId ?? '';
  }

  // -------------------------------------------------------------------------
  // _spawn — replaceable in tests
  // -------------------------------------------------------------------------

  /**
   * Factory function used to start the CLI subprocess.
   * Tests can replace this with a function that returns a fake ChildProcess:
   *
   * ```ts
   * adapter._spawn = () => fakeProcess;
   * ```
   *
   * Production code MUST NOT replace this field.
   */
  public _spawn: (cmd: string, args: string[], cwd: string) => ChildProcess = (cmd, args, cwd) =>
    spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });

  // -------------------------------------------------------------------------
  // spawn() — the shared implementation
  // -------------------------------------------------------------------------

  async spawn(opts: SpawnOptions): Promise<ChatSession> {
    const command = this.buildSpawnCommand(opts);
    const { cmd, args } = command;

    devLog('provider.spawn', {
      provider: this.id,
      cmd,
      args,
      cwd: opts.cwd,
      model: opts.model,
      resumeSessionId: opts.resumeSessionId,
    });

    const child = this._spawn(cmd, args, opts.cwd);

    // Capture stderr for error reporting but don't block on it.
    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      devLog('provider.stderr', {
        provider: this.id,
        text: chunk.toString('utf8').slice(0, 2000),
      });
    });

    // -----------------------------------------------------------------------
    // Resolve session ID from the first init event on stdout.
    // -----------------------------------------------------------------------
    let resolveSessionId: ((id: string) => void) | null = null;
    let rejectSessionId: ((err: Error) => void) | null = null;
    const sessionIdPromise = this.waitForSessionInitBeforeSpawn
      ? new Promise<string>((res, rej) => {
          resolveSessionId = res;
          rejectSessionId = rej;
        })
      : null;

    const stdout = child.stdout;
    if (!stdout) {
      throw new Error(`${this.id} subprocess stdout is not available`);
    }

    // lineBuffer holds lines that arrive before send() is called.
    const lineBuffer: string[] = [];
    let sessionId = this.getProvisionalSessionId(opts, command);
    let sessionIdResolved = false;

    const captureSessionId = (extractedId: string): void => {
      sessionId = extractedId;
      devLog('provider.session_id', { provider: this.id, sessionId: extractedId });
      if (!sessionIdResolved) {
        sessionIdResolved = true;
        resolveSessionId?.(extractedId);
      }
    };

    // Single reader for the entire session lifetime.  send() will call
    // reader.setLineHandler() to route subsequent lines to the iterator.
    const reader = attachJsonlReader(
      stdout,
      // Initial handler: buffer all lines and extract session ID.
      (line) => {
        if (!sessionIdResolved) {
          try {
            const parsed: unknown = JSON.parse(line);
            const extractedId = this.extractSessionId(parsed);
            if (extractedId !== null) {
              captureSessionId(extractedId);
            }
          } catch {
            // Not JSON or not init event — fall through.
          }
        }
        lineBuffer.push(line);
      },
      // onClose: only reject if session ID was never resolved.
      () => {
        if (this.waitForSessionInitBeforeSpawn && !sessionIdResolved) {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          rejectSessionId?.(
            new Error(
              `${this.id} subprocess exited before emitting session ID.${stderr ? ` stderr: ${stderr}` : ''}`
            )
          );
        }
      }
    );

    child.on('error', (err) => {
      devLog('provider.process_error', { provider: this.id, error: err });
      if (this.waitForSessionInitBeforeSpawn && !sessionIdResolved) {
        rejectSessionId?.(err);
      }
    });

    // When the child exits, notify the reader so it can flush and trigger onClose.
    // This replaces stream.on('end'/'close') which has async-context issues in bun:test.
    child.once('exit', () => {
      devLog('provider.exit', {
        provider: this.id,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      });
      reader.notifyEnd();
    });

    if (this.waitForSessionInitBeforeSpawn) {
      // Wait for session ID with a reasonable timeout.
      try {
        sessionId = await Promise.race([
          // biome-ignore lint/style/noNonNullAssertion: created when waitForSessionInitBeforeSpawn is true
          sessionIdPromise!,
          new Promise<string>((_, rej) =>
            setTimeout(
              () => rej(new Error(`${this.id} timed out waiting for session init event (10 s)`)),
              10_000
            )
          ),
        ]);
      } catch (err) {
        reader.close();
        await terminateProcess(child);
        throw err;
      }
    }

    const provider = this.id;
    let closed = false;

    // -----------------------------------------------------------------------
    // Build the ChatSession
    // -----------------------------------------------------------------------
    const session: ChatSession = {
      get id(): string {
        return sessionId;
      },
      provider,

      send(message: string): AsyncIterable<NormalizedMessage> {
        // Access the adapter instance stored on the session object (set below).
        const adapter = (session as unknown as { _adapter: StreamJsonAdapterBase })._adapter;

        return {
          [Symbol.asyncIterator](): AsyncIterator<NormalizedMessage> {
            return createMessageIterator(
              child,
              reader,
              lineBuffer,
              message,
              adapter,
              () => closed,
              stderrChunks,
              captureSessionId
            );
          },
        };
      },

      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        devLog('provider.session_close', { provider, sessionId });
        reader.close();
        await terminateProcess(child);
      },

      // Expose the outer adapter instance for the send() closure above.
      _adapter: this,
    } as ChatSession & { _adapter: StreamJsonAdapterBase };

    return session;
  }
}

// ---------------------------------------------------------------------------
// Async iterator factory
// ---------------------------------------------------------------------------

function createMessageIterator(
  child: ChildProcess,
  reader: ReturnType<typeof attachJsonlReader>,
  lineBuffer: string[],
  message: string,
  adapter: StreamJsonAdapterBase,
  isClosed: () => boolean,
  stderrChunks: Buffer[],
  onSessionId: (sessionId: string) => void
): AsyncIterator<NormalizedMessage> {
  let done = false;
  const pendingQueue: NormalizedMessage[] = [];
  let resolveNext: (() => void) | null = null;
  let iteratorError: Error | null = null;

  function enqueue(msg: NormalizedMessage): void {
    pendingQueue.push(msg);
    resolveNext?.();
    resolveNext = null;
  }

  function parseLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const extractedId = adapter.extractSessionId(parsed);
      if (extractedId !== null) {
        onSessionId(extractedId);
      }
      const eventType =
        parsed && typeof parsed === 'object' && 'type' in parsed
          ? String((parsed as { type?: unknown }).type)
          : 'unknown';
      devLog('provider.event', { provider: adapter.id, type: eventType });
      const normalized = adapter.normalizeStreamEvent(parsed);
      if (normalized !== null) {
        enqueue(normalized);
      }
      if (adapter.isTurnCompleteEvent(parsed)) {
        devLog('provider.turn_complete', { provider: adapter.id, type: eventType });
        onIteratorClose();
      }
    } catch {
      enqueue(systemMessage(`[${adapter.id}] JSONL parse error: ${trimmed.slice(0, 200)}`));
    }
  }

  function onIteratorClose(): void {
    done = true;
    resolveNext?.();
    resolveNext = null;
  }

  // Flush any lines buffered before send() was called.
  for (const buffered of lineBuffer.splice(0)) {
    parseLine(buffered);
  }

  // Switch the reader's line handler to our parseLine so subsequent lines
  // from stdout go directly into the iterator queue.
  if (!isClosed()) {
    reader.setLineHandler((line) => {
      parseLine(line);
    });

    // Detect when the reader closes (process exits).
    // We register on the child directly to avoid managing another reader.
    child.once('exit', () => {
      onIteratorClose();
    });
  } else {
    done = true;
    iteratorError = new Error(`${adapter.id} session is already closed`);
  }

  // Write user message to stdin (JSONL framer: one line per message).
  if (!isClosed() && child.stdin) {
    const serialized = adapter.serializeUserMessage(message);
    child.stdin.write(`${serialized}\n`, (err) => {
      if (err) {
        iteratorError = err;
        resolveNext?.();
        resolveNext = null;
      }
    });
  }

  return {
    async next(): Promise<IteratorResult<NormalizedMessage>> {
      // Drain queue first.
      while (pendingQueue.length === 0 && !done && !iteratorError) {
        await new Promise<void>((res) => {
          resolveNext = res;
        });
      }

      if (iteratorError) {
        const err = iteratorError;
        iteratorError = null;

        const errMsg = systemMessage(`[${adapter.id}] stream error: ${err.message}`, {
          originalError: err.message,
        });

        const drainHead = pendingQueue.length > 0 ? pendingQueue.shift() : undefined;
        if (drainHead !== undefined) {
          return { value: drainHead, done: false };
        }
        done = true;
        return { value: errMsg, done: false };
      }

      if (pendingQueue.length > 0) {
        const head = pendingQueue.shift();
        if (head !== undefined) {
          return { value: head, done: false };
        }
      }

      // done === true and queue is empty.
      if (!done) {
        const stderr = Buffer.concat(stderrChunks).toString().trim();
        if (stderr) {
          return {
            value: systemMessage(`[${adapter.id}] stderr: ${stderr}`),
            done: false,
          };
        }
      }

      return { value: undefined as unknown as NormalizedMessage, done: true };
    },

    async return(): Promise<IteratorResult<NormalizedMessage>> {
      done = true;
      return { value: undefined as unknown as NormalizedMessage, done: true };
    },
  };
}
