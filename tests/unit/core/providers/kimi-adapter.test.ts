/**
 * Unit tests for KimiAdapter.
 *
 * Tests adapter identity, isAvailable(), buildSpawnCommand(), and all
 * normalizeStreamEvent() / extractSessionId() / serializeUserMessage() methods.
 *
 * Note: spawn()-based integration is tested via a simulated ChatSession approach
 * since bun:test's PassThrough async-context behavior prevents reliable
 * child_process mock injection for spawn().
 */

import { describe, expect, it } from 'bun:test';
import { KimiAdapter } from '../../../../src/core/providers/kimi-adapter.js';
import type {
  ChatSession,
  NormalizedMessage,
  SpawnOptions,
} from '../../../../src/core/providers/types.js';

// ---------------------------------------------------------------------------
// Testable subclass
// ---------------------------------------------------------------------------

class TestableKimiAdapter extends KimiAdapter {
  public execVersionShouldFail = false;

  protected override async execVersion(): Promise<void> {
    if (this.execVersionShouldFail) {
      throw new Error('ENOENT: kimi not found');
    }
  }
}

// ---------------------------------------------------------------------------
// Simulated ChatSession
// ---------------------------------------------------------------------------

function makeSimulatedSession(adapter: KimiAdapter, events: unknown[]): ChatSession {
  const session: ChatSession = {
    id: 'kimi-simulated-session',
    provider: adapter.id,

    send(_message: string): AsyncIterable<NormalizedMessage> {
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

const KIMI_INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'kimi-session-abc',
};

const DELTA_EVENT = {
  type: 'delta',
  content: 'Bonjour!',
  index: 0,
};

const MESSAGE_EVENT_STRING = {
  type: 'message',
  role: 'assistant',
  content: 'This is a complete message.',
};

const MESSAGE_EVENT_BLOCKS = {
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', name: 'bash', input: { cmd: 'ls' } },
  ],
};

const TOOL_CALL_EVENT = {
  type: 'tool_call',
  id: 'tool-001',
  name: 'Read',
  input: { path: '/etc/hosts' },
};

const TOOL_RESULT_EVENT = {
  type: 'tool_result',
  tool_call_id: 'tool-001',
  output: '127.0.0.1 localhost',
};

const ERROR_EVENT = {
  type: 'error',
  message: 'Rate limit exceeded',
  code: 429,
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

describe('KimiAdapter', () => {
  // -----------------------------------------------------------------------
  // Adapter identity
  // -----------------------------------------------------------------------

  describe('identity', () => {
    it('has id === "kimi"', () => {
      const adapter = new TestableKimiAdapter();
      expect(adapter.id).toBe('kimi');
    });

    it('has lifecycle === "persistent-bidirectional"', () => {
      const adapter = new TestableKimiAdapter();
      expect(adapter.lifecycle).toBe('persistent-bidirectional');
    });
  });

  // -----------------------------------------------------------------------
  // isAvailable
  // -----------------------------------------------------------------------

  describe('isAvailable()', () => {
    it('returns true when execVersion() succeeds', async () => {
      const adapter = new TestableKimiAdapter();
      adapter.execVersionShouldFail = false;
      const result = await adapter.isAvailable();
      expect(result).toBe(true);
    });

    it('returns false when execVersion() throws', async () => {
      const adapter = new TestableKimiAdapter();
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
      const adapter = new TestableKimiAdapter();
      const { cmd, args } = adapter.buildSpawnCommand(SPAWN_OPTS);
      expect(cmd).toBe('kimi');
      expect(args).toContain('--print');
      expect(args).toContain('--output-format');
      expect(args).toContain('stream-json');
      expect(args).toContain('--input-format');
      expect(args).toContain('--yolo');
      expect(args).toContain('--model');
    });

    it('uses default model kimi-k2.5 when opts.model is absent', () => {
      const adapter = new TestableKimiAdapter();
      const { args } = adapter.buildSpawnCommand(SPAWN_OPTS);
      const idx = args.indexOf('--model');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('kimi-k2.5');
    });

    it('uses opts.model when provided', () => {
      const adapter = new TestableKimiAdapter();
      const opts: SpawnOptions = { ...SPAWN_OPTS, model: 'kimi-moonshot-v2' };
      const { args } = adapter.buildSpawnCommand(opts);
      const idx = args.indexOf('--model');
      expect(args[idx + 1]).toBe('kimi-moonshot-v2');
    });

    it('uses --session for a new session', () => {
      const adapter = new TestableKimiAdapter();
      const { args } = adapter.buildSpawnCommand(SPAWN_OPTS);
      expect(args).toContain('--session');
      expect(args).not.toContain('--resume');
    });

    it('uses --resume when resumeSessionId is set', () => {
      const adapter = new TestableKimiAdapter();
      const opts: SpawnOptions = { ...SPAWN_OPTS, resumeSessionId: 'old-kimi-session' };
      const { args } = adapter.buildSpawnCommand(opts);
      expect(args).toContain('--resume');
      expect(args).toContain('old-kimi-session');
      expect(args).not.toContain('--session');
    });
  });

  // -----------------------------------------------------------------------
  // extractSessionId
  // -----------------------------------------------------------------------

  describe('extractSessionId()', () => {
    it('extracts session_id from system:init event', () => {
      const adapter = new TestableKimiAdapter();
      expect(adapter.extractSessionId(KIMI_INIT)).toBe('kimi-session-abc');
    });

    it('returns null for non-init events', () => {
      const adapter = new TestableKimiAdapter();
      expect(adapter.extractSessionId({ type: 'delta', content: 'hi' })).toBeNull();
      expect(adapter.extractSessionId(null)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // normalizeStreamEvent
  // -----------------------------------------------------------------------

  describe('normalizeStreamEvent()', () => {
    it('returns null for system events', () => {
      const adapter = new TestableKimiAdapter();
      expect(adapter.normalizeStreamEvent(KIMI_INIT)).toBeNull();
    });

    it('returns null for done/stop events', () => {
      const adapter = new TestableKimiAdapter();
      expect(adapter.normalizeStreamEvent({ type: 'done' })).toBeNull();
      expect(adapter.normalizeStreamEvent({ type: 'stop' })).toBeNull();
    });

    it('normalizes delta event into assistant ContentBlock[]', () => {
      const adapter = new TestableKimiAdapter();
      const msg = adapter.normalizeStreamEvent(DELTA_EVENT);

      expect(msg?.role).toBe('assistant');
      const blocks = msg?.content as { type: string; text: string }[];
      expect(blocks[0]?.type).toBe('text');
      expect(blocks[0]?.text).toBe('Bonjour!');
      expect(msg?.providerMeta?.streaming).toBe(true);
    });

    it('returns null for delta with empty content', () => {
      const adapter = new TestableKimiAdapter();
      const msg = adapter.normalizeStreamEvent({ type: 'delta', content: '' });
      expect(msg).toBeNull();
    });

    it('normalizes message event with string content', () => {
      const adapter = new TestableKimiAdapter();
      const msg = adapter.normalizeStreamEvent(MESSAGE_EVENT_STRING);

      expect(msg?.role).toBe('assistant');
      expect(msg?.content).toBe('This is a complete message.');
    });

    it('normalizes message event with block array content', () => {
      const adapter = new TestableKimiAdapter();
      const msg = adapter.normalizeStreamEvent(MESSAGE_EVENT_BLOCKS);

      expect(msg?.role).toBe('assistant');
      const blocks = msg?.content as { type: string; text?: string; toolName?: string }[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.type).toBe('text');
      expect(blocks[0]?.text).toBe('Hello');
      expect(blocks[1]?.type).toBe('tool_use');
      expect(blocks[1]?.toolName).toBe('bash');
    });

    it('normalizes tool_call event into tool role message', () => {
      const adapter = new TestableKimiAdapter();
      const msg = adapter.normalizeStreamEvent(TOOL_CALL_EVENT);

      expect(msg?.role).toBe('tool');
      const blocks = msg?.content as { type: string; toolName?: string }[];
      expect(blocks[0]?.type).toBe('tool_use');
      expect(blocks[0]?.toolName).toBe('Read');
      expect(msg?.providerMeta?.toolId).toBe('tool-001');
    });

    it('normalizes tool_result event into tool role message', () => {
      const adapter = new TestableKimiAdapter();
      const msg = adapter.normalizeStreamEvent(TOOL_RESULT_EVENT);

      expect(msg?.role).toBe('tool');
      const blocks = msg?.content as { type: string; toolOutput?: unknown }[];
      expect(blocks[0]?.type).toBe('tool_result');
      expect(blocks[0]?.toolOutput).toBe('127.0.0.1 localhost');
      expect(msg?.providerMeta?.toolCallId).toBe('tool-001');
    });

    it('normalizes error event into system message', () => {
      const adapter = new TestableKimiAdapter();
      const msg = adapter.normalizeStreamEvent(ERROR_EVENT);

      expect(msg?.role).toBe('system');
      expect(String(msg?.content)).toContain('Rate limit exceeded');
    });

    it('normalizes unknown event type into system message with providerMeta', () => {
      const adapter = new TestableKimiAdapter();
      const msg = adapter.normalizeStreamEvent({ type: 'future_unknown', data: 'x' });

      expect(msg?.role).toBe('system');
      expect(String(msg?.content)).toContain('unknown event type');
      expect(msg?.providerMeta?.raw).toBeDefined();
    });

    it('returns null for non-object input', () => {
      const adapter = new TestableKimiAdapter();
      expect(adapter.normalizeStreamEvent(null)).toBeNull();
      expect(adapter.normalizeStreamEvent(undefined)).toBeNull();
      expect(adapter.normalizeStreamEvent(42)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // serializeUserMessage
  // -----------------------------------------------------------------------

  describe('serializeUserMessage()', () => {
    it('produces valid JSON with the message text', () => {
      const adapter = new TestableKimiAdapter();
      const line = adapter.serializeUserMessage('Tell me a joke.');
      const parsed = JSON.parse(line) as {
        type: string;
        message: { role: string; content: { type: string; text: string }[] };
      };

      expect(parsed.type).toBe('user');
      expect(parsed.message.role).toBe('user');
      expect(parsed.message.content[0]?.type).toBe('text');
      expect(parsed.message.content[0]?.text).toBe('Tell me a joke.');
    });

    it('does not include trailing newline', () => {
      const adapter = new TestableKimiAdapter();
      expect(adapter.serializeUserMessage('hello').endsWith('\n')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Simulated session — exercises normalizeStreamEvent via send()
  // -----------------------------------------------------------------------

  describe('simulated session send()', () => {
    it('streams delta events through normalizeStreamEvent', async () => {
      const adapter = new TestableKimiAdapter();
      const session = makeSimulatedSession(adapter, [DELTA_EVENT]);

      const messages = await collectMessages(session.send('hello'));
      const textMsg = messages.find((m) => m.role === 'assistant');
      expect(textMsg).toBeDefined();
      const blocks = textMsg?.content as { text: string }[];
      expect(blocks[0]?.text).toBe('Bonjour!');
    });

    it('streams message events through normalizeStreamEvent', async () => {
      const adapter = new TestableKimiAdapter();
      const session = makeSimulatedSession(adapter, [MESSAGE_EVENT_STRING]);

      const messages = await collectMessages(session.send('hello'));
      const textMsg = messages.find((m) => m.role === 'assistant');
      expect(textMsg?.content).toBe('This is a complete message.');
    });

    it('session id and provider are set correctly', () => {
      const adapter = new TestableKimiAdapter();
      const session = makeSimulatedSession(adapter, []);
      expect(session.id).toBe('kimi-simulated-session');
      expect(session.provider).toBe('kimi');
    });
  });
});
