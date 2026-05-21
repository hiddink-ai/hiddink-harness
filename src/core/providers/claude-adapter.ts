/**
 * Claude CLI adapter — persistent-bidirectional stream-json provider.
 *
 * Spawns: claude -p "" --bare --input-format stream-json --output-format stream-json
 *           --include-partial-messages --include-hook-events
 *           --permission-mode bypassPermissions
 *           --allowedTools "Read,Write,Edit,Bash,Glob,Grep"
 *           --session-id <uuid>  [--resume <id>]
 *           --cwd <cwd>
 *
 * Session init event: {type:"system", subtype:"init", session_id:"...", ...}
 *
 * The system prompt from SpawnOptions is injected as the first user message
 * with role:"system" before the Hub's actual user turn.  (Claude CLI does not
 * expose a --system flag in stream-json mode; system context is sent inline.)
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

// Lazy-bound to avoid module-level side effects from promisify(execFile)
// that interfere with bun:test's stream event dispatch.
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Claude JSONL event shapes (stdout)
// ---------------------------------------------------------------------------

interface ClaudeSystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  [key: string]: unknown;
}

interface TextDelta {
  type: 'text_delta';
  text: string;
}

interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

type ContentBlockDelta = TextDelta | InputJsonDelta;

interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentBlockDelta;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'text'; text: string } | ToolUseBlock;
}

interface StreamEvent {
  type: 'stream_event';
  event: ContentBlockStartEvent | ContentBlockDeltaEvent | { type: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface PermissionRequestEvent {
  type: 'permission_request';
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// ClaudeAdapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter extends StreamJsonAdapterBase {
  readonly id: ProviderId = 'claude';
  readonly lifecycle: ProviderLifecycle = 'persistent-bidirectional';

  // -------------------------------------------------------------------------
  // isAvailable
  // -------------------------------------------------------------------------

  /**
   * Override in tests to avoid hitting the real filesystem.
   * Returns the stdout of `claude --version` or throws if the binary is absent.
   */
  protected async execVersion(): Promise<void> {
    await execFileAsync('claude', ['--version'], { timeout: 5_000 });
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
    const allowedTools = opts.allowedTools?.join(',') ?? 'Read,Write,Edit,Bash,Glob,Grep';

    const args: string[] = [
      '-p',
      '',
      '--bare',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--include-hook-events',
      '--permission-mode',
      'bypassPermissions',
      '--allowedTools',
      allowedTools,
      '--cwd',
      opts.cwd,
    ];

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    if (opts.model) {
      args.push('--model', opts.model);
    }

    return { cmd: 'claude', args };
  }

  // -------------------------------------------------------------------------
  // normalizeStreamEvent
  // -------------------------------------------------------------------------

  normalizeStreamEvent(event: unknown): NormalizedMessage | null {
    if (!event || typeof event !== 'object') return null;

    const ev = event as Record<string, unknown>;
    const eventType = ev.type;

    // system:init — consumed by extractSessionId, discard here.
    if (eventType === 'system') return null;

    // stream_event wraps the Anthropic streaming API event envelope.
    if (eventType === 'stream_event') {
      return this.normalizeStreamEventInner(ev as StreamEvent);
    }

    // permission_request — bypassPermissions should suppress these, but
    // guard defensively.
    if (eventType === 'permission_request') {
      const pev = ev as PermissionRequestEvent;
      return {
        role: 'system',
        content: `[claude] permission requested but bypassPermissions is active`,
        timestamp: new Date().toISOString(),
        providerMeta: { raw: pev },
      };
    }

    // result event — final turn summary; discard.
    if (eventType === 'result') {
      return null;
    }

    // Unrecognised event — preserve in providerMeta.
    return {
      role: 'system',
      content: `[claude] unknown event type: ${String(eventType)}`,
      timestamp: new Date().toISOString(),
      providerMeta: { raw: ev },
    };
  }

  private normalizeStreamEventInner(wrapper: StreamEvent): NormalizedMessage | null {
    const inner = wrapper.event;
    if (!inner || typeof inner !== 'object') return null;

    const innerType = (inner as Record<string, unknown>).type;

    // content_block_delta — streaming text or partial tool input.
    if (innerType === 'content_block_delta') {
      const deltaEvent = inner as ContentBlockDeltaEvent;
      const delta = deltaEvent.delta;

      if (delta.type === 'text_delta') {
        const block: ContentBlock = { type: 'text', text: delta.text };
        return {
          role: 'assistant',
          content: [block],
          timestamp: new Date().toISOString(),
          providerMeta: { streaming: true, index: deltaEvent.index },
        };
      }

      if (delta.type === 'input_json_delta') {
        // Partial tool JSON — surface as a thinking block.
        const block: ContentBlock = { type: 'thinking', text: delta.partial_json };
        return {
          role: 'assistant',
          content: [block],
          timestamp: new Date().toISOString(),
          providerMeta: { streaming: true, partialToolInput: true, index: deltaEvent.index },
        };
      }

      return null;
    }

    // content_block_start — first block in a turn.
    if (innerType === 'content_block_start') {
      const startEvent = inner as ContentBlockStartEvent;
      const cb = startEvent.content_block;

      if (cb.type === 'text') {
        if (!cb.text) return null; // Empty start — wait for deltas.
        const block: ContentBlock = { type: 'text', text: cb.text };
        return {
          role: 'assistant',
          content: [block],
          timestamp: new Date().toISOString(),
          providerMeta: { index: startEvent.index },
        };
      }

      if (cb.type === 'tool_use') {
        const block: ContentBlock = {
          type: 'tool_use',
          toolName: cb.name,
          toolInput: cb.input,
        };
        return {
          role: 'tool',
          content: [block],
          timestamp: new Date().toISOString(),
          providerMeta: { toolId: cb.id, index: startEvent.index },
        };
      }

      return null;
    }

    // All other inner event types (message_start, message_stop, etc.) — discard.
    return null;
  }

  // -------------------------------------------------------------------------
  // extractSessionId
  // -------------------------------------------------------------------------

  extractSessionId(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null;

    const ev = event as Record<string, unknown>;
    if (ev.type === 'system' && ev.subtype === 'init') {
      const init = ev as unknown as ClaudeSystemInitEvent;
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
