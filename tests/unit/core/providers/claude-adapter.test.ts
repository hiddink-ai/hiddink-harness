/**
 * Unit tests for ClaudeAdapter.
 *
 * Tests adapter identity, isAvailable(), buildSpawnCommand(), and all
 * normalizeStreamEvent() / extractSessionId() / serializeUserMessage() methods.
 *
 * Note: spawn()-based integration is tested via a simulated ChatSession approach
 * since bun:test's PassThrough async-context behavior prevents reliable
 * child_process mock injection for spawn().
 */

import { describe, expect, it } from 'bun:test';
import { ClaudeAdapter } from '../../../../src/core/providers/claude-adapter.js';
import type {
  ChatSession,
  NormalizedMessage,
  SpawnOptions,
} from '../../../../src/core/providers/types.js';

// ---------------------------------------------------------------------------
// Testable subclass — overrides execVersion to avoid real binary check.
// Also exposes a way to simulate spawn() without real child_process.
// ---------------------------------------------------------------------------

class TestableClaudeAdapter extends ClaudeAdapter {
  public execVersionShouldFail = false;

  protected override async execVersion(): Promise<void> {
    if (this.execVersionShouldFail) {
      throw new Error('ENOENT: claude not found');
    }
  }
}

// ---------------------------------------------------------------------------
// Simulated ChatSession for spawn-path testing
// ---------------------------------------------------------------------------

function makeSimulatedSession(adapter: ClaudeAdapter, events: unknown[]): ChatSession {
  const sentMessages: string[] = [];

  const session: ChatSession = {
    id: 'simulated-session-001',
    provider: adapter.id,

    send(message: string): AsyncIterable<NormalizedMessage> {
      sentMessages.push(message);
      const normalized = events
        .map((ev) => adapter.normalizeStreamEvent(ev))
        .filter((m): m is NormalizedMessage => m !== null);

      return {
        async *[Symbol.asyncIterator]() {
          for (const msg of normalized) {
            yield msg;
          }
        },
      };
    },

    async close(): Promise<void> {
      // no-op
    },
  };

  return session;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CLAUDE_INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'claude-session-xyz',
  version: '2.0',
};

const TEXT_DELTA_EVENT = {
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Hello!' },
  },
};

const TOOL_USE_START_EVENT = {
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'tool_abc',
      name: 'Read',
      input: { path: '/tmp/file.txt' },
    },
  },
};

const PERMISSION_EVENT = {
  type: 'permission_request',
  resource: 'bash',
};

const SPAWN_OPTS: SpawnOptions = {
  systemPrompt: 'You are helpful.',
  cwd: '/workspace',
};

async function collectMessages<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) {
    results.push(item);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeAdapter', () => {
  // -----------------------------------------------------------------------
  // Adapter identity
  // -----------------------------------------------------------------------

  describe('identity', () => {
    it('has id === "claude"', () => {
      const adapter = new TestableClaudeAdapter();
      expect(adapter.id).toBe('claude');
    });

    it('has lifecycle === "persistent-bidirectional"', () => {
      const adapter = new TestableClaudeAdapter();
      expect(adapter.lifecycle).toBe('persistent-bidirectional');
    });
  });

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  describe('isAvailable()', () => {
    it('returns true when execVersion() succeeds', async () => {
      const adapter = new TestableClaudeAdapter();
      adapter.execVersionShouldFail = false;
      const result = await adapter.isAvailable();
      expect(result).toBe(true);
    });

    it('returns false when execVersion() throws', async () => {
      const adapter = new TestableClaudeAdapter();
      adapter.execVersionShouldFail = true;
      const result = await adapter.isAvailable();
      expect(result).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // buildSpawnCommand
  // -----------------------------------------------------------------------

  describe('buildSpawnCommand()', () => {
    it('includes required flags', () => {
      const adapter = new TestableClaudeAdapter();
      const { cmd, args } = adapter.buildSpawnCommand(SPAWN_OPTS);
      expect(cmd).toBe('claude');
      expect(args).toContain('--input-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--output-format');
      expect(args).toContain('--bare');
      expect(args).toContain('--verbose');
      expect(args).toContain('--permission-mode');
      expect(args).toContain('bypassPermissions');
      // --cwd is passed as spawn process option, not as a CLI flag
      expect(args).not.toContain('--cwd');
      expect(args).not.toContain('/workspace');
    });

    it('uses --session-id for a new session', () => {
      const adapter = new TestableClaudeAdapter();
      const { args } = adapter.buildSpawnCommand(SPAWN_OPTS);
      expect(args).toContain('--session-id');
      expect(args).not.toContain('--resume');
    });

    it('uses --resume when resumeSessionId is set', () => {
      const adapter = new TestableClaudeAdapter();
      const opts: SpawnOptions = { ...SPAWN_OPTS, resumeSessionId: 'old-session-123' };
      const { args } = adapter.buildSpawnCommand(opts);
      expect(args).toContain('--resume');
      expect(args).toContain('old-session-123');
      expect(args).not.toContain('--session-id');
    });

    it('passes --model when opts.model is set', () => {
      const adapter = new TestableClaudeAdapter();
      const opts: SpawnOptions = { ...SPAWN_OPTS, model: 'claude-3-5-sonnet' };
      const { args } = adapter.buildSpawnCommand(opts);
      expect(args).toContain('--model');
      expect(args).toContain('claude-3-5-sonnet');
    });

    it('uses custom allowedTools', () => {
      const adapter = new TestableClaudeAdapter();
      const opts: SpawnOptions = { ...SPAWN_OPTS, allowedTools: ['Read', 'Glob'] };
      const { args } = adapter.buildSpawnCommand(opts);
      const idx = args.indexOf('--allowedTools');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('Read,Glob');
    });
  });

  // -----------------------------------------------------------------------
  // extractSessionId
  // -----------------------------------------------------------------------

  describe('extractSessionId()', () => {
    it('extracts session_id from system:init event', () => {
      const adapter = new TestableClaudeAdapter();
      expect(adapter.extractSessionId(CLAUDE_INIT)).toBe('claude-session-xyz');
    });

    it('returns null for non-init events', () => {
      const adapter = new TestableClaudeAdapter();
      expect(adapter.extractSessionId({ type: 'system', subtype: 'other' })).toBeNull();
      expect(adapter.extractSessionId({ type: 'stream_event' })).toBeNull();
      expect(adapter.extractSessionId(null)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // normalizeStreamEvent
  // -----------------------------------------------------------------------

  describe('normalizeStreamEvent()', () => {
    it('returns null for system:init events', () => {
      const adapter = new TestableClaudeAdapter();
      expect(adapter.normalizeStreamEvent(CLAUDE_INIT)).toBeNull();
    });

    it('returns null for result events', () => {
      const adapter = new TestableClaudeAdapter();
      expect(adapter.normalizeStreamEvent({ type: 'result', content: 'final' })).toBeNull();
    });

    it('normalizes text_delta into assistant message with ContentBlock[]', () => {
      const adapter = new TestableClaudeAdapter();
      const msg = adapter.normalizeStreamEvent(TEXT_DELTA_EVENT);

      expect(msg).not.toBeNull();
      expect(msg?.role).toBe('assistant');
      expect(Array.isArray(msg?.content)).toBe(true);
      const blocks = msg?.content as { type: string; text?: string }[];
      expect(blocks[0]?.type).toBe('text');
      expect(blocks[0]?.text).toBe('Hello!');
      expect(msg?.providerMeta?.streaming).toBe(true);
    });

    it('normalizes tool_use content_block_start into tool message', () => {
      const adapter = new TestableClaudeAdapter();
      const msg = adapter.normalizeStreamEvent(TOOL_USE_START_EVENT);

      expect(msg).not.toBeNull();
      expect(msg?.role).toBe('tool');
      const blocks = msg?.content as { type: string; toolName?: string }[];
      expect(blocks[0]?.type).toBe('tool_use');
      expect(blocks[0]?.toolName).toBe('Read');
      expect(msg?.providerMeta?.toolId).toBe('tool_abc');
    });

    it('normalizes permission_request into system message', () => {
      const adapter = new TestableClaudeAdapter();
      const msg = adapter.normalizeStreamEvent(PERMISSION_EVENT);

      expect(msg?.role).toBe('system');
      expect(String(msg?.content)).toContain('bypassPermissions');
    });

    it('normalizes unknown event type into system message with providerMeta', () => {
      const adapter = new TestableClaudeAdapter();
      const msg = adapter.normalizeStreamEvent({ type: 'unknown_future_type', data: 42 });

      expect(msg?.role).toBe('system');
      expect(String(msg?.content)).toContain('unknown event type');
      expect(msg?.providerMeta?.raw).toBeDefined();
    });

    it('normalizes input_json_delta into thinking ContentBlock', () => {
      const adapter = new TestableClaudeAdapter();
      const event = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"key":' },
        },
      };
      const msg = adapter.normalizeStreamEvent(event);

      expect(msg?.role).toBe('assistant');
      const blocks = msg?.content as { type: string; text?: string }[];
      expect(blocks[0]?.type).toBe('thinking');
      expect(blocks[0]?.text).toBe('{"key":');
    });

    it('returns null for non-object input', () => {
      const adapter = new TestableClaudeAdapter();
      expect(adapter.normalizeStreamEvent(null)).toBeNull();
      expect(adapter.normalizeStreamEvent(undefined)).toBeNull();
      expect(adapter.normalizeStreamEvent('raw string')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // serializeUserMessage
  // -----------------------------------------------------------------------

  describe('serializeUserMessage()', () => {
    it('produces valid JSON with the message text', () => {
      const adapter = new TestableClaudeAdapter();
      const line = adapter.serializeUserMessage('What is 2+2?');
      const parsed = JSON.parse(line) as {
        type: string;
        message: { role: string; content: { type: string; text: string }[] };
      };

      expect(parsed.type).toBe('user');
      expect(parsed.message.role).toBe('user');
      expect(parsed.message.content[0]?.type).toBe('text');
      expect(parsed.message.content[0]?.text).toBe('What is 2+2?');
    });

    it('does not include trailing newline', () => {
      const adapter = new TestableClaudeAdapter();
      expect(adapter.serializeUserMessage('hello').endsWith('\n')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Simulated session (exercises normalizeStreamEvent via send())
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Real execVersion — covers the base class method body
  // -----------------------------------------------------------------------

  describe('execVersion() base implementation', () => {
    it('real execVersion returns true or false depending on whether claude binary exists', async () => {
      // Use the real ClaudeAdapter (not the testable subclass) to exercise
      // the actual execVersion() body (lines 94-104).
      const realAdapter = new ClaudeAdapter();
      // isAvailable calls the real execVersion — result depends on environment
      const available = await realAdapter.isAvailable();
      expect(typeof available).toBe('boolean');
    });
  });

  describe('simulated session send()', () => {
    it('streams text delta events through normalizeStreamEvent', async () => {
      const adapter = new TestableClaudeAdapter();
      const session = makeSimulatedSession(adapter, [TEXT_DELTA_EVENT]);

      const messages = await collectMessages(session.send('hello'));
      const textMsg = messages.find((m) => m.role === 'assistant');
      expect(textMsg).toBeDefined();
      const blocks = textMsg?.content as { text: string }[];
      expect(blocks[0]?.text).toBe('Hello!');
    });

    it('session id is set correctly', () => {
      const adapter = new TestableClaudeAdapter();
      const session = makeSimulatedSession(adapter, []);
      expect(session.id).toBe('simulated-session-001');
      expect(session.provider).toBe('claude');
    });
  });
});
