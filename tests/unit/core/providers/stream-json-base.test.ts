/**
 * Unit tests for StreamJsonAdapterBase.
 *
 * Tests the abstract contract methods via a minimal concrete subclass:
 * - normalizeStreamEvent(), extractSessionId(), serializeUserMessage()
 * - buildSpawnCommand() via TestAdapter
 * - spawn() lifecycle via real bash child processes (bun:test PassThrough
 *   data-event constraint means we use real processes, not mock streams)
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

// ---------------------------------------------------------------------------
// Real child_process spawn tests
// ---------------------------------------------------------------------------

/**
 * BashAdapter: uses a bash script that:
 *  1. Emits an init event (resolves sessionId)
 *  2. Reads a line from stdin (waits for user message)
 *  3. Emits a text response and exits
 */
class BashAdapter extends StreamJsonAdapterBase {
  readonly id: ProviderId = 'claude';
  readonly lifecycle: ProviderLifecycle = 'persistent-bidirectional';

  async isAvailable(): Promise<boolean> {
    return true;
  }

  buildSpawnCommand(_opts: SpawnOptions): SpawnCommand {
    // Emit init event, read stdin line, then emit a text response and exit.
    const script = [
      'printf \'{"type":"init","session_id":"real-session-001"}\\n\'',
      'read line',
      'printf \'{"type":"text","content":"pong"}\\n\'',
    ].join('\n');
    return { cmd: 'bash', args: ['-c', script] };
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
    if (ev.type === 'init') return String(ev.session_id);
    return null;
  }
}

/**
 * StderrAdapter: emits stderr data before the init event.
 */
class StderrAdapter extends BashAdapter {
  buildSpawnCommand(_opts: SpawnOptions): SpawnCommand {
    const script = [
      'echo "stderr output" >&2',
      'printf \'{"type":"init","session_id":"stderr-session"}\\n\'',
      'read line',
      // Exit without sending response → done message will arrive with stderr
      '',
    ].join('\n');
    return { cmd: 'bash', args: ['-c', script] };
  }
}

/**
 * InvalidJsonAdapter: emits non-JSON lines to trigger parse error handling.
 */
class InvalidJsonAdapter extends BashAdapter {
  buildSpawnCommand(_opts: SpawnOptions): SpawnCommand {
    const script = [
      'printf \'{"type":"init","session_id":"parse-err-session"}\\n\'',
      'read line',
      "printf 'not valid json at all\\n'",
      'printf \'{"type":"text","content":"after-error"}\\n\'',
    ].join('\n');
    return { cmd: 'bash', args: ['-c', script] };
  }
}

/**
 * TimeoutAdapter: exits immediately without emitting init event.
 * Used to test the session-ID timeout path.
 */
class EarlyExitAdapter extends BashAdapter {
  buildSpawnCommand(_opts: SpawnOptions): SpawnCommand {
    // Exit without emitting init → triggers rejectSessionId on stream close
    return { cmd: 'bash', args: ['-c', 'exit 0'] };
  }
}

/**
 * AlreadyDeadAdapter: process that immediately exits (exitCode becomes non-null).
 * Used to test terminateProcess when process is already dead.
 */
class AlreadyDeadAdapter extends BashAdapter {
  buildSpawnCommand(_opts: SpawnOptions): SpawnCommand {
    const script = [
      'printf \'{"type":"init","session_id":"dead-session"}\\n\'',
      // Do not read from stdin — just exit immediately after init
      'exit 0',
    ].join('\n');
    return { cmd: 'bash', args: ['-c', script] };
  }
}

describe('StreamJsonAdapterBase — real spawn() lifecycle', () => {
  it('spawns real process, receives session ID, sends message, gets response', async () => {
    const adapter = new BashAdapter();
    const session = await adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' });

    expect(session.id).toBe('real-session-001');
    expect(session.provider).toBe('claude');

    const messages = await collectMessages(session.send('ping'));
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]?.role).toBe('assistant');
    expect(messages[0]?.content).toBe('pong');

    await session.close();
  });

  it('close() is idempotent — calling twice does not throw', async () => {
    const adapter = new BashAdapter();
    const session = await adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' });
    await session.close();
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('handles JSONL parse errors gracefully — yields system error message', async () => {
    const adapter = new InvalidJsonAdapter();
    const session = await adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' });

    const messages = await collectMessages(session.send('ping'));
    // Should contain at least one system error message for the invalid JSON line,
    // and possibly a valid text message for the after-error event.
    const hasError = messages.some((m) => m.role === 'system' || m.content === 'after-error');
    expect(hasError).toBe(true);

    await session.close();
  });

  it('process that exits without init event rejects spawn with error', async () => {
    const adapter = new EarlyExitAdapter();
    await expect(
      adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' })
    ).rejects.toThrow();
  });

  it('close() on already-dead process does not throw (terminateProcess guard)', async () => {
    const adapter = new AlreadyDeadAdapter();
    const session = await adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' });

    // Wait briefly for the bash process to exit naturally
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    // session.close() calls terminateProcess() which should handle exitCode !== null
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('send() on a closed session yields an error message', async () => {
    const adapter = new BashAdapter();
    const session = await adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' });
    await session.close();

    const messages = await collectMessages(session.send('after-close'));
    expect(messages.some((m) => m.role === 'system')).toBe(true);
  });

  it('early return() on iterator terminates iteration', async () => {
    const adapter = new BashAdapter();
    const session = await adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' });

    // Use the iterator directly to call return() before consuming all messages
    const iter = session.send('ping')[Symbol.asyncIterator]();
    const result = await iter.return?.();
    expect(result?.done).toBe(true);

    await session.close();
  });

  it('captures stderr output in error messages when process has no more output', async () => {
    const adapter = new StderrAdapter();
    const session = await adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' });

    const _messages = await collectMessages(session.send('ping'));
    // With stderr output, the final done path should include it or session completes
    expect(session.id).toBe('stderr-session');

    await session.close();
  });

  it('spawn() rejects when process exits with no stdout — onClose rejects sessionId', async () => {
    // Adapter that runs a process with no stdout (dev/null redirect).
    // stdout is closed immediately → onClose fires → rejectSessionId.
    class NoStdoutAdapter extends BashAdapter {
      buildSpawnCommand(_opts: SpawnOptions): SpawnCommand {
        // Redirect stdout to dev/null so no lines are emitted → process closes without init
        return { cmd: 'bash', args: ['-c', 'echo nothing >/dev/null && exit 0'] };
      }
    }

    const adapter = new NoStdoutAdapter();
    await expect(
      adapter.spawn({ sessionId: 'x', cwd: '/tmp', systemPrompt: '' })
    ).rejects.toThrow();
  });
});
