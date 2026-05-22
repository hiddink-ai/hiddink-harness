/**
 * Claude CLI adapter — persistent-bidirectional stream-json provider.
 *
 * Spawns: claude -p "" --verbose --input-format stream-json --output-format stream-json
 *           --include-partial-messages --include-hook-events
 *           --permission-mode bypassPermissions
 *           --allowedTools "Read,Write,Edit,Bash,Glob,Grep"
 *           --session-id <uuid>  [--resume <id>]
 *           (cwd는 spawn options으로 전달, CLI flag 아님)
 *
 * Note: --verbose is required when using --output-format=stream-json with -p (claude CLI 2.1.147+).
 * Do not pass --bare here: it disables OAuth/keychain auth and makes a locally
 * logged-in Claude CLI look unauthenticated.
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

const CLAUDE_CLI_MODEL_ALIASES: Record<string, string> = {
  // UI-facing labels stay version-shaped, but Claude Code currently accepts
  // the stable aliases or full model IDs on --model.
  'sonnet-4.7': 'sonnet',
  'opus-4.7': 'opus',
};

function resolveClaudeCliModel(model: string): string {
  return CLAUDE_CLI_MODEL_ALIASES[model] ?? model;
}

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

interface ClaudeAssistantMessageEvent {
  type: 'assistant';
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
      id?: string;
      [key: string]: unknown;
    }>;
    model?: string;
    [key: string]: unknown;
  };
  error?: string;
  [key: string]: unknown;
}

interface ClaudeResultEvent {
  type: 'result';
  is_error?: boolean;
  result?: string;
  error?: string;
  api_error_status?: number | null;
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
  protected override readonly waitForSessionInitBeforeSpawn = false;

  protected override getProvisionalSessionId(opts: SpawnOptions, command: SpawnCommand): string {
    if (opts.resumeSessionId) return opts.resumeSessionId;
    const sessionFlagIndex = command.args.indexOf('--session-id');
    const sessionId = command.args[sessionFlagIndex + 1];
    return typeof sessionId === 'string' ? sessionId : '';
  }

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
      '--verbose', // required for --output-format=stream-json with -p (claude CLI 2.1.147+)
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
    ];

    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    } else {
      args.push('--session-id', sessionId);
    }

    if (opts.model) {
      args.push('--model', resolveClaudeCliModel(opts.model));
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

    // system:init and echoed user envelopes carry no assistant-visible text.
    if (eventType === 'system' || eventType === 'user') return null;

    // Claude Code emits rate-limit telemetry envelopes in stream-json mode.
    if (eventType === 'rate_limit_event') return null;

    // stream_event wraps the Anthropic streaming API event envelope.
    if (eventType === 'stream_event') {
      return this.normalizeStreamEventInner(ev as StreamEvent);
    }

    // Claude Code 2.1.x emits completed assistant envelopes after partial
    // stream_event deltas. Ignore normal envelopes to avoid duplicate text;
    // only surface explicit error envelopes.
    if (eventType === 'assistant') {
      return this.normalizeAssistantMessageError(ev as ClaudeAssistantMessageEvent);
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

    // result event — final turn summary. Successful results are discarded
    // because assistant content is emitted separately; error results are
    // surfaced when no assistant envelope carried the text.
    if (eventType === 'result') {
      const result = ev as ClaudeResultEvent;
      if (!result.is_error) return null;
      return {
        role: 'system',
        content: `[claude] ${result.result ?? result.error ?? 'provider error'}`,
        timestamp: new Date().toISOString(),
        providerMeta: { raw: result },
      };
    }

    // Unrecognised event — preserve in providerMeta.
    return {
      role: 'system',
      content: `[claude] unknown event type: ${String(eventType)}`,
      timestamp: new Date().toISOString(),
      providerMeta: { raw: ev },
    };
  }

  private normalizeAssistantMessageError(
    ev: ClaudeAssistantMessageEvent
  ): NormalizedMessage | null {
    if (!ev.error) return null;

    const blocks = ev.message?.content;
    const text = Array.isArray(blocks)
      ? blocks
          .map((block) =>
            block.type === 'text' && typeof block.text === 'string' ? block.text : ''
          )
          .join('')
          .trim()
      : '';

    return {
      role: 'system',
      content: `[claude] ${text || ev.error}`,
      timestamp: new Date().toISOString(),
      providerMeta: {
        claudeModel: ev.message?.model,
        claudeError: ev.error,
      },
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

  override isTurnCompleteEvent(event: unknown): boolean {
    return Boolean(
      event && typeof event === 'object' && (event as Record<string, unknown>).type === 'result'
    );
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
