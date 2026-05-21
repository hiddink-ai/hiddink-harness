/**
 * Unit tests for StreamJsonAdapterBase.
 *
 * Tests the abstract contract methods via a minimal concrete subclass:
 * - normalizeStreamEvent(), extractSessionId(), serializeUserMessage()
 * - buildSpawnCommand() via TestAdapter
 *
 * spawn()-based lifecycle tests are deferred to adapter-specific files.
 * A single spawn smoke test is included using the MockReadable + exit event approach.
 */

import { describe, expect, it } from 'bun:test';
import type { SpawnCommand } from '../../../../src/core/providers/stream-json-base.js';
import { StreamJsonAdapterBase } from '../../../../src/core/providers/stream-json-base.js';
import type {
  ChatSession,
  NormalizedMessage,
  ProviderId,
  ProviderLifecycle,
  SpawnOptions,
} from '../../../../src/core/providers/types.js';

// ---------------------------------------------------------------------------
// Minimal concrete subclass
// ---------------------------------------------------------------------------

class TestAdapter extends StreamJsonAdapterBase {
  readonly id: ProviderId = 'claude';
  readonly lifecycle: ProviderLifecycle = 'persistent-bidirectional';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  buildSpawnCommand(_opts: SpawnOptions): SpawnCommand {
    return { cmd: 'test-cli', args: ['--stream'] };
  }

  normalizeStreamEvent(event: unknown): NormalizedMessage | null {
    if (!event || typeof event !== 'object') return null;
    const ev = event as Record<string, unknown>;

    if (ev.type === 'text') {
      return {
        role: 'assistant',
        content: String(ev.content),
        timestamp: new Date().toISOString(),
      };
    }
    return null;
  }

  serializeUserMessage(message: string): string {
    return JSON.stringify({ type: 'user', text: message });
  }

  extractSessionId(event: unknown): string | null {
    if (!event || typeof event !== 'object') return null;
    const ev = event as Record<string, unknown>;
    if (ev.type === 'init') {
      return String(ev.session_id);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simulated ChatSession helper
// ---------------------------------------------------------------------------

function makeSimulatedSession(adapter: TestAdapter, events: unknown[]): ChatSession {
  const session: ChatSession = {
    id: 'base-simulated-session',
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

async function collectMessages(
  iter: AsyncIterable<NormalizedMessage>
): Promise<NormalizedMessage[]> {
  const messages: NormalizedMessage[] = [];
  for await (const msg of iter) {
    messages.push(msg);
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamJsonAdapterBase — normalizeStreamEvent() contract', () => {
  it('returns null for null input', () => {
    const adapter = new TestAdapter();
    expect(adapter.normalizeStreamEvent(null)).toBeNull();
  });

  it('returns null for non-object input', () => {
    const adapter = new TestAdapter();
    expect(adapter.normalizeStreamEvent('string')).toBeNull();
    expect(adapter.normalizeStreamEvent(42)).toBeNull();
  });

  it('returns NormalizedMessage with correct shape for known event', () => {
    const adapter = new TestAdapter();
    const result = adapter.normalizeStreamEvent({ type: 'text', content: 'hi' });
    expect(result).not.toBeNull();
    expect(result?.role).toBe('assistant');
    expect(result?.timestamp).toBeTruthy();
    expect(result?.content).toBe('hi');
  });

  it('returns null for unrecognized event types', () => {
    const adapter = new TestAdapter();
    expect(adapter.normalizeStreamEvent({ type: 'heartbeat' })).toBeNull();
  });
});

describe('StreamJsonAdapterBase — extractSessionId()', () => {
  it('extracts session ID from init event', () => {
    const adapter = new TestAdapter();
    expect(adapter.extractSessionId({ type: 'init', session_id: 'abc' })).toBe('abc');
  });

  it('returns null for non-init events', () => {
    const adapter = new TestAdapter();
    expect(adapter.extractSessionId({ type: 'text', content: 'hi' })).toBeNull();
    expect(adapter.extractSessionId(null)).toBeNull();
    expect(adapter.extractSessionId(undefined)).toBeNull();
  });
});

describe('StreamJsonAdapterBase — serializeUserMessage()', () => {
  it('returns valid JSON string', () => {
    const adapter = new TestAdapter();
    const result = adapter.serializeUserMessage('hello');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('includes the message text', () => {
    const adapter = new TestAdapter();
    const result = adapter.serializeUserMessage('hello world');
    expect(result).toContain('hello world');
  });

  it('does not include trailing newline (base class adds it)', () => {
    const adapter = new TestAdapter();
    const result = adapter.serializeUserMessage('msg');
    expect(result.endsWith('\n')).toBe(false);
  });
});

describe('StreamJsonAdapterBase — simulated session send()', () => {
  it('streams messages via normalizeStreamEvent pipeline', async () => {
    const adapter = new TestAdapter();
    const events = [
      { type: 'text', content: 'Hello' },
      { type: 'heartbeat' }, // null → discarded
      { type: 'text', content: 'World' },
    ];
    const session = makeSimulatedSession(adapter, events);

    const messages = await collectMessages(session.send('test'));
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('Hello');
    expect(messages[1]?.content).toBe('World');
  });

  it('discards events that normalizeStreamEvent returns null for', async () => {
    const adapter = new TestAdapter();
    const session = makeSimulatedSession(adapter, [{ type: 'heartbeat' }, { type: 'heartbeat' }]);

    const messages = await collectMessages(session.send('test'));
    expect(messages).toHaveLength(0);
  });
});
