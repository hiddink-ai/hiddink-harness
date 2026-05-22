/**
 * Antigravity `agy` CLI adapter.
 *
 * The current agy CLI exposes a non-interactive print mode rather than a JSONL
 * streaming protocol:
 *
 *   agy --print --dangerously-skip-permissions --print-timeout 5m0s "<prompt>"
 *
 * It does not expose a model flag in `agy --help`; model selection is managed
 * by the local Antigravity/Gemini configuration.  The adapter therefore treats
 * each turn as a fresh print-mode process and returns the captured stdout as a
 * single assistant message.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ChatSession,
  NormalizedMessage,
  ProviderAdapter,
  ProviderId,
  ProviderLifecycle,
  SpawnOptions,
} from './types.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_AGY_MODEL_LABEL = 'gemini-3.5-flash-high';

export function buildAgyPrompt(systemPrompt: string, userMessage: string): string {
  if (!systemPrompt.trim()) return userMessage;
  return `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${userMessage}`;
}

export function buildAgyArgs(prompt: string): string[] {
  return ['--print', '--dangerously-skip-permissions', '--print-timeout', '5m0s', prompt];
}

function systemMessage(content: string, meta?: Record<string, unknown>): NormalizedMessage {
  return {
    role: 'system',
    content,
    timestamp: new Date().toISOString(),
    ...(meta ? { providerMeta: meta } : {}),
  };
}

class AgySession implements ChatSession {
  readonly id: string;
  readonly provider: ProviderId = 'agy';
  private closed = false;

  constructor(private readonly opts: SpawnOptions) {
    this.id = opts.resumeSessionId ?? '';
  }

  async *send(message: string): AsyncIterable<NormalizedMessage> {
    if (this.closed) {
      yield systemMessage('[agy] session is already closed');
      return;
    }

    const prompt = buildAgyPrompt(this.opts.systemPrompt, message);
    const args = buildAgyArgs(prompt);

    const child = spawn('agy', args, {
      cwd: this.opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('error', (err) => {
        stderrChunks.push(Buffer.from(err.message));
        resolve(1);
      });
      child.once('close', (code) => resolve(code));
    });

    const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();

    if (exitCode !== 0) {
      yield systemMessage(
        `[agy] process exited with code ${exitCode}${stderr ? `: ${stderr}` : ''}`,
        {
          agyExitCode: exitCode,
        }
      );
      return;
    }

    if (!stdout) {
      yield systemMessage(`[agy] empty response${stderr ? `: ${stderr}` : ''}`, {
        agyExitCode: exitCode,
      });
      return;
    }

    yield {
      role: 'assistant',
      content: [{ type: 'text', text: stdout }],
      timestamp: new Date().toISOString(),
      providerMeta: {
        model: this.opts.model ?? DEFAULT_AGY_MODEL_LABEL,
        agyExitCode: exitCode,
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class AgyAdapter implements ProviderAdapter {
  readonly id: ProviderId = 'agy';
  readonly lifecycle: ProviderLifecycle = 'per-turn-resume';

  protected async execVersion(): Promise<void> {
    await execFileAsync('agy', ['--version'], { timeout: 5_000 });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.execVersion();
      return true;
    } catch {
      return false;
    }
  }

  async spawn(opts: SpawnOptions): Promise<ChatSession> {
    return new AgySession(opts);
  }
}
