/**
 * Kimi CLI adapter — persistent-bidirectional stream-json provider.
 *
 * Spawns: kimi --print
 *           --output-format stream-json --input-format stream-json
 *           --yolo
 *           --model kimi-k2.5  (or opts.model)
 *           --session <id>     [--resume <id>]
 *
 * Reference: https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html
 *
 * Kimi's JSONL envelope closely mirrors Claude's but uses slightly different
 * field names and event taxonomy.  normalizeStreamEvent maps Kimi events to
 * the same NormalizedMessage shape so consumers are provider-agnostic.
 *
 * Session init event: {type:"system", subtype:"init", session_id:"...", ...}
 * (Same shape as Claude — Kimi follows the same JSONL convention.)
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { SpawnCommand } from './stream-json-base.js';
import { StreamJsonAdapterBase } from './stream-json-base.js';
import type {
  ContentBlock,
  NormalizedMessage,
  ProviderId,
  ProviderLifecycle,
  SpawnOptions,
} from './types.js';

const execFileAsync = promisify(execFile);

// Default model if opts.model is not supplied.
const DEFAULT_KIMI_MODEL = 'kimi-k2.5';

// ---------------------------------------------------------------------------
// Kimi JSONL event shapes (stdout)
// Reference: https://moonshotai.github.io/kimi-cli/en/customization/print-mode.html
// ---------------------------------------------------------------------------

interface KimiSystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  [key: string]: unknown;
}

/** Streaming text delta. */
interface KimiTextDeltaEvent {
  type: 'delta';
  content: string;
  index?: number;
  [key: string]: unknown;
}

/** Completed assistant turn (non-streaming summary). */
interface KimiMessageEvent {
  type: 'message';
  role: 'assistant' | 'user' | 'system' | 'tool';
  content: string | KimiContentBlock[];
  [key: string]: unknown;
}

interface KimiContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

/** Tool call event. */
interface KimiToolCallEvent {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
  [key: string]: unknown;
}

/** Tool result event. */
interface KimiToolResultEvent {
  type: 'tool_result';
  tool_call_id: string;
  output: unknown;
  [key: string]: unknown;
}

/** Error event. */
interface KimiErrorEvent {
  type: 'error';
  message: string;
  code?: string | number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// KimiAdapter
// ---------------------------------------------------------------------------

export class KimiAdapter extends StreamJsonAdapterBase {
  readonly id: ProviderId = 'kimi';
  readonly lifecycle: ProviderLifecycle = 'persistent-bidirectional';

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  /**
   * Override in tests to avoid hitting the real filesystem.
   * Returns the stdout of `kimi --version` or throws if the binary is absent.
   */
  protected async execVersion(): Promise<void> {
    await execFileAsync('kimi', ['--version'], { timeout: 5_000 });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.execVersion();
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // buildSpawnCommand
  // -------------------------------------------------------------------------

  buildSpawnCommand(opts: SpawnOptions): SpawnCommand {
    const sessionId = opts.resumeSessionId ?? randomUUID();
    const model = opts.model ?? DEFAULT_KIMI_MODEL;

    const args: string[] = [
      '--print',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--yolo',
      '--model',
      model,
    ];

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    } else {
      args.push('--session', sessionId);
    }

    return { cmd: 'kimi', args };
  }

  // -------------------------------------------------------------------------
  // normalizeStreamEvent
  // -------------------------------------------------------------------------

  normalizeStreamEvent(event: unknown): NormalizedMessage | null {
    if (!event || typeof event !== 'object') return null;

    const ev = event as Record<string, unknown>;
    const eventType = ev.type;

    // system:init — session ID extraction handled by extractSessionId; discard.
    if (eventType === 'system') return null;

    // Streaming text delta.
    if (eventType === 'delta') {
      return this.normalizeDelta(ev as unknown as KimiTextDeltaEvent);
    }

    // Completed message turn.
    if (eventType === 'message') {
      return this.normalizeMessage(ev as unknown as KimiMessageEvent);
    }

    // Tool call.
    if (eventType === 'tool_call') {
      return this.normalizeToolCall(ev as unknown as KimiToolCallEvent);
    }

    // Tool result.
    if (eventType === 'tool_result') {
      return this.normalizeToolResult(ev as unknown as KimiToolResultEvent);
    }

    // Error from provider.
    if (eventType === 'error') {
      const errEv = ev as unknown as KimiErrorEvent;
      return {
        role: 'system',
        content: `[kimi] error: ${errEv.message}`,
        timestamp: new Date().toISOString(),
        providerMeta: { raw: errEv },
      };
    }

    // Completion/done marker — discard.
    if (eventType === 'done' || eventType === 'stop') return null;

    // Unrecognised event — preserve for debugging.
    return {
      role: 'system',
      content: `[kimi] unknown event type: ${String(eventType)}`,
      timestamp: new Date().toISOString(),
      providerMeta: { raw: ev },
    };
  }

  private normalizeDelta(ev: KimiTextDeltaEvent): NormalizedMessage | null {
    if (typeof ev.content !== 'string' || ev.content === '') return null;

    const block: ContentBlock = { type: 'text', text: ev.content };
    return {
      role: 'assistant',
      content: [block],
      timestamp: new Date().toISOString(),
      providerMeta: { streaming: true, index: ev.index ?? 0 },
    };
  }

  private normalizeMessage(ev: KimiMessageEvent): NormalizedMessage | null {
    const role = ev.role ?? 'assistant';

    // Normalize role — Kimi may emit roles not in NormalizedMessage.
    const normalizedRole =
      role === 'assistant' || role === 'user' || role === 'system' || role === 'tool'
        ? role
        : 'assistant';

    if (typeof ev.content === 'string') {
      return {
        role: normalizedRole,
        content: ev.content,
        timestamp: new Date().toISOString(),
        providerMeta: { raw: ev },
      };
    }

    if (Array.isArray(ev.content)) {
      const blocks: ContentBlock[] = ev.content.map((cb): ContentBlock => {
        if (cb.type === 'text' && typeof cb.text === 'string') {
          return { type: 'text', text: cb.text };
        }
        if (cb.type === 'tool_use') {
          return { type: 'tool_use', toolName: cb.name, toolInput: cb.input };
        }
        if (cb.type === 'tool_result') {
          return { type: 'tool_result', toolOutput: cb.output };
        }
        // Fallback — surface unknown block as text.
        return { type: 'text', text: JSON.stringify(cb) };
      });

      return {
        role: normalizedRole,
        content: blocks,
        timestamp: new Date().toISOString(),
        providerMeta: { raw: ev },
      };
    }

    return null;
  }

  private normalizeToolCall(ev: KimiToolCallEvent): NormalizedMessage {
    const block: ContentBlock = {
      type: 'tool_use',
      toolName: ev.name,
      toolInput: ev.input,
    };
    return {
      role: 'tool',
      content: [block],
      timestamp: new Date().toISOString(),
      providerMeta: { toolId: ev.id, raw: ev },
    };
  }

  private normalizeToolResult(ev: KimiToolResultEvent): NormalizedMessage {
    const block: ContentBlock = {
      type: 'tool_result',
      toolOutput: ev.output,
    };
    return {
      role: 'tool',
      content: [block],
      timestamp: new Date().toISOString(),
      providerMeta: { toolCallId: ev.tool_call_id, raw: ev },
    };
  }

  // -------------------------------------------------------------------------
  // extractSessionId
  // -------------------------------------------------------------------------

  extractSessionId(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null;

    const ev = event as Record<string, unknown>;
    if (ev.type === 'system' && ev.subtype === 'init') {
      const init = ev as unknown as KimiSystemInitEvent;
      return typeof init.session_id === 'string' ? init.session_id : null;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // serializeUserMessage
  // -------------------------------------------------------------------------

  serializeUserMessage(message: string): string {
    return JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    });
  }
}
