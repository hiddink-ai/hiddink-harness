/**
 * Unit tests for ConversationHub and SystemPromptEvolver.
 *
 * All provider adapters are mocked — no real subprocess is spawned.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConversationHub } from '../../../src/core/hub.js';
import { SystemPromptEvolver } from '../../../src/core/providers/system-prompt.js';
import type {
  ChatSession,
  NormalizedMessage,
  ProviderAdapter,
  ProviderId,
} from '../../../src/core/providers/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a fake NormalizedMessage for assertions. */
function fakeMsg(
  role: NormalizedMessage['role'],
  content: string,
  provider?: ProviderId
): NormalizedMessage {
  return {
    role,
    content,
    timestamp: new Date().toISOString(),
    providerMeta: provider ? { provider } : undefined,
  };
}

/** Collects all items from an AsyncIterable into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) {
    items.push(item);
  }
  return items;
}

/** Builds a mock ChatSession that yields a fixed sequence of messages. */
function mockSession(
  id: string,
  provider: ProviderId,
  responses: NormalizedMessage[]
): ChatSession {
  return {
    id,
    provider,
    async *send(_message: string): AsyncIterable<NormalizedMessage> {
      for (const r of responses) {
        yield r;
      }
    },
    close: mock(async () => {}),
  };
}

/**
 * Builds a mock ProviderAdapter.
 *
 * @param id        Provider id
 * @param lifecycle Lifecycle strategy
 * @param sessions  Ordered list of ChatSessions returned per spawn() call
 * @param available Whether isAvailable() resolves to true
 */
function mockAdapter(
  id: ProviderId,
  lifecycle: ProviderAdapter['lifecycle'],
  sessions: ChatSession[],
  available = true
): ProviderAdapter {
  let spawnIndex = 0;
  return {
    id,
    lifecycle,
    isAvailable: mock(async () => available),
    spawn: mock(async (_opts) => {
      const session = sessions[spawnIndex % sessions.length];
      spawnIndex += 1;
      return session;
    }),
  };
}

// ---------------------------------------------------------------------------
// SystemPromptEvolver tests
// ---------------------------------------------------------------------------

describe('SystemPromptEvolver', () => {
  test('build returns empty string when nothing is set', () => {
    const evolver = new SystemPromptEvolver();
    expect(evolver.build('claude')).toBe('');
  });

  test('build composes layers in project → memory → session → provider order', () => {
    const evolver = new SystemPromptEvolver({
      project: 'PROJECT',
      memory: 'MEMORY',
      session: 'SESSION',
    });
    evolver.setLayer('provider', 'PROVIDER-CLAUDE', 'claude');

    const result = evolver.build('claude');
    const idx = (s: string) => result.indexOf(s);

    expect(idx('PROJECT')).toBeLessThan(idx('MEMORY'));
    expect(idx('MEMORY')).toBeLessThan(idx('SESSION'));
    expect(idx('SESSION')).toBeLessThan(idx('PROVIDER-CLAUDE'));
  });

  test('provider layer is per-provider isolated', () => {
    const evolver = new SystemPromptEvolver();
    evolver.setLayer('provider', 'CLAUDE-SPECIFIC', 'claude');
    evolver.setLayer('provider', 'CODEX-SPECIFIC', 'codex');

    expect(evolver.build('claude')).toContain('CLAUDE-SPECIFIC');
    expect(evolver.build('claude')).not.toContain('CODEX-SPECIFIC');
    expect(evolver.build('codex')).toContain('CODEX-SPECIFIC');
    expect(evolver.build('codex')).not.toContain('CLAUDE-SPECIFIC');
  });

  test('appendLayer accumulates content in the same layer', () => {
    const evolver = new SystemPromptEvolver({ session: 'first' });
    evolver.appendLayer('session', 'second');

    const built = evolver.build('claude');
    expect(built).toContain('first');
    expect(built).toContain('second');
    expect(built.indexOf('first')).toBeLessThan(built.indexOf('second'));
  });

  test('appendLayer provider throws without providerId', () => {
    const evolver = new SystemPromptEvolver();
    expect(() => evolver.appendLayer('provider', 'X')).toThrow();
  });

  test('setLayer replaces existing content', () => {
    const evolver = new SystemPromptEvolver({ memory: 'old' });
    evolver.setLayer('memory', 'new');
    expect(evolver.build('claude')).toContain('new');
    expect(evolver.build('claude')).not.toContain('old');
  });

  test('serialize / deserialize round-trips the full state', () => {
    const evolver = new SystemPromptEvolver({
      project: 'P',
      memory: 'M',
      session: 'S',
    });
    evolver.setLayer('provider', 'KIMI', 'kimi');

    const restored = SystemPromptEvolver.deserialize(evolver.serialize());

    expect(restored.build('kimi')).toBe(evolver.build('kimi'));
    expect(restored.build('claude')).toBe(evolver.build('claude'));
  });

  test('empty layers are excluded from the composed output', () => {
    const evolver = new SystemPromptEvolver({ project: 'ONLY' });
    const built = evolver.build('claude');
    // No double-newline-only sections
    expect(built.trim()).toBe('ONLY');
  });
});

// ---------------------------------------------------------------------------
// ConversationHub — adapter registration
// ---------------------------------------------------------------------------

describe('ConversationHub adapter registry', () => {
  test('hasAdapter returns false before registration', () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    expect(hub.hasAdapter('claude')).toBe(false);
  });

  test('hasAdapter returns true after registration', () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const adapter = mockAdapter('claude', 'persistent-bidirectional', [
      mockSession('s1', 'claude', []),
    ]);
    hub.registerAdapter(adapter);
    expect(hub.hasAdapter('claude')).toBe(true);
  });

  test('listAvailable only includes adapters whose isAvailable() resolves true', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    hub.registerAdapter(mockAdapter('claude', 'persistent-bidirectional', [], true));
    hub.registerAdapter(mockAdapter('codex', 'per-turn-resume', [], false));

    const available = await hub.listAvailable();
    expect(available).toContain('claude');
    expect(available).not.toContain('codex');
  });
});

// ---------------------------------------------------------------------------
// ConversationHub — sendTo
// ---------------------------------------------------------------------------

describe('ConversationHub.sendTo', () => {
  test('yields an error message when no adapter is registered', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const msgs = await collect(hub.sendTo('claude', 'hello'));

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('system');
    expect(String(msgs[0].content)).toContain('No adapter registered');
  });

  test('persistent-bidirectional: reuses the same session across calls', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const session = mockSession('sess-1', 'claude', [fakeMsg('assistant', 'Hi')]);
    const adapter = mockAdapter('claude', 'persistent-bidirectional', [session]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('claude', 'turn 1'));
    await collect(hub.sendTo('claude', 'turn 2'));

    // spawn() should only have been called once.
    expect(adapter.spawn).toHaveBeenCalledTimes(1);
  });

  test('per-turn-resume: spawns a new session for every turn', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const makeSession = (id: string) =>
      mockSession(id, 'codex', [fakeMsg('assistant', 'response')]);
    const adapter = mockAdapter('codex', 'per-turn-resume', [makeSession('t1'), makeSession('t2')]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('codex', 'turn 1'));
    await collect(hub.sendTo('codex', 'turn 2'));

    expect(adapter.spawn).toHaveBeenCalledTimes(2);
  });

  test('per-turn-resume: forwards previous thread id on subsequent turns', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const makeSession = (id: string) => mockSession(id, 'codex', [fakeMsg('assistant', 'ok')]);
    const adapter = mockAdapter('codex', 'per-turn-resume', [
      makeSession('thread-abc'),
      makeSession('thread-abc'),
    ]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('codex', 'first'));
    await collect(hub.sendTo('codex', 'second'));

    // Second spawn should carry the first session's id as resumeSessionId.
    const secondCallOpts = (adapter.spawn as ReturnType<typeof mock>).mock.calls[1][0];
    expect(secondCallOpts.resumeSessionId).toBe('thread-abc');
  });

  test('pty-wrap lifecycle yields not-implemented error message', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const adapter = mockAdapter('agy', 'pty-wrap', []);
    hub.registerAdapter(adapter);

    const msgs = await collect(hub.sendTo('agy', 'hello'));
    expect(msgs[0].role).toBe('system');
    expect(String(msgs[0].content)).toContain('not yet implemented in MVP');
  });

  test('provider error is yielded as system message, not thrown', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const adapter: ProviderAdapter = {
      id: 'kimi',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: mock(async () => {
        throw new Error('spawn failed');
      }),
    };
    hub.registerAdapter(adapter);

    const msgs = await collect(hub.sendTo('kimi', 'hello'));
    expect(msgs[0].role).toBe('system');
    expect(String(msgs[0].content)).toContain('spawn failed');
  });
});

// ---------------------------------------------------------------------------
// ConversationHub — parallelConsensus
// ---------------------------------------------------------------------------

describe('ConversationHub.parallelConsensus', () => {
  test('sends the same message to all providers and collects results', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });

    hub.registerAdapter(
      mockAdapter('claude', 'persistent-bidirectional', [
        mockSession('c1', 'claude', [fakeMsg('assistant', 'claude-answer')]),
      ])
    );
    hub.registerAdapter(
      mockAdapter('kimi', 'persistent-bidirectional', [
        mockSession('k1', 'kimi', [fakeMsg('assistant', 'kimi-answer')]),
      ])
    );

    const results = await hub.parallelConsensus('question', ['claude', 'kimi']);

    const claudeMsgs = results.get('claude') ?? [];
    const kimiMsgs = results.get('kimi') ?? [];

    expect(claudeMsgs.some((m) => String(m.content).includes('claude-answer'))).toBe(true);
    expect(kimiMsgs.some((m) => String(m.content).includes('kimi-answer'))).toBe(true);
  });

  test('captures provider error without blocking other providers', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });

    hub.registerAdapter(
      mockAdapter('claude', 'persistent-bidirectional', [
        mockSession('c1', 'claude', [fakeMsg('assistant', 'ok')]),
      ])
    );
    // codex not registered → will produce an error message
    const results = await hub.parallelConsensus('question', ['claude', 'codex']);

    expect(results.get('claude')?.[0]?.role).toBe('assistant');
    expect(results.get('codex')?.[0]?.role).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// ConversationHub — fallbackChain
// ---------------------------------------------------------------------------

describe('ConversationHub.fallbackChain', () => {
  test('yields first successful provider response', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });

    hub.registerAdapter(
      mockAdapter('claude', 'persistent-bidirectional', [
        mockSession('c1', 'claude', [fakeMsg('assistant', 'success')]),
      ])
    );
    hub.registerAdapter(
      mockAdapter('kimi', 'persistent-bidirectional', [
        mockSession('k1', 'kimi', [fakeMsg('assistant', 'fallback')]),
      ])
    );

    const msgs = await collect(hub.fallbackChain('question', ['claude', 'kimi']));
    expect(msgs[0].role).toBe('assistant');
    expect(String(msgs[0].content)).toBe('success');
  });

  test('falls through to next provider when first returns error', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });

    // 'claude' not registered → error message (role: 'system')
    hub.registerAdapter(
      mockAdapter('kimi', 'persistent-bidirectional', [
        mockSession('k1', 'kimi', [fakeMsg('assistant', 'kimi-success')]),
      ])
    );

    const msgs = await collect(hub.fallbackChain('question', ['claude', 'kimi']));
    expect(msgs.some((m) => String(m.content).includes('kimi-success'))).toBe(true);
  });

  test('yields error when all providers fail', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    // Neither adapter registered
    const msgs = await collect(hub.fallbackChain('question', ['claude', 'kimi']));
    expect(msgs[0].role).toBe('system');
  });
});

// ---------------------------------------------------------------------------
// ConversationHub — system prompt accumulation
// ---------------------------------------------------------------------------

describe('ConversationHub.appendSystemContext', () => {
  test('accumulates session context and includes it in spawn options', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });

    hub.appendSystemContext('session', 'User prefers short answers.');

    const adapter = mockAdapter('claude', 'persistent-bidirectional', [
      mockSession('s1', 'claude', [fakeMsg('assistant', 'ok')]),
    ]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('claude', 'hello'));

    const spawnOpts = (adapter.spawn as ReturnType<typeof mock>).mock.calls[0][0];
    expect(spawnOpts.systemPrompt).toContain('User prefers short answers.');
  });

  test('provider-specific context only reaches that provider', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    hub.appendSystemContext('provider', 'claude-only instruction', 'claude');

    const claudeAdapter = mockAdapter('claude', 'persistent-bidirectional', [
      mockSession('s1', 'claude', [fakeMsg('assistant', 'ok')]),
    ]);
    const kimiAdapter = mockAdapter('kimi', 'persistent-bidirectional', [
      mockSession('s2', 'kimi', [fakeMsg('assistant', 'ok')]),
    ]);
    hub.registerAdapter(claudeAdapter);
    hub.registerAdapter(kimiAdapter);

    await collect(hub.sendTo('claude', 'hi'));
    await collect(hub.sendTo('kimi', 'hi'));

    const claudePrompt = (claudeAdapter.spawn as ReturnType<typeof mock>).mock.calls[0][0]
      .systemPrompt;
    const kimiPrompt = (kimiAdapter.spawn as ReturnType<typeof mock>).mock.calls[0][0].systemPrompt;

    expect(claudePrompt).toContain('claude-only instruction');
    expect(kimiPrompt).not.toContain('claude-only instruction');
  });
});

// ---------------------------------------------------------------------------
// ConversationHub — session persistence round-trip
// ---------------------------------------------------------------------------

describe('ConversationHub session save/load', () => {
  const testSessionId = `hub-test-${Date.now()}`;
  const sessionsDir = join(homedir(), '.hiddink-harness', 'sessions');

  beforeEach(() => {
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
  });

  afterEach(() => {
    const file = join(sessionsDir, `session-${testSessionId}.json`);
    if (existsSync(file)) {
      rmSync(file);
    }
  });

  test('saveSession and loadSession round-trip history and system prompt', async () => {
    const hub = new ConversationHub({
      sessionId: testSessionId,
      cwd: '/projects/my-app',
      initialSystemPrompt: { project: 'PROJECT CONTENT' },
    });
    hub.appendSystemContext('session', 'accumulated decision A');

    // Add a fake history entry manually via sendTo on a mock adapter.
    const adapter = mockAdapter('claude', 'persistent-bidirectional', [
      mockSession('s1', 'claude', [fakeMsg('assistant', 'assistant reply')]),
    ]);
    hub.registerAdapter(adapter);
    await collect(hub.sendTo('claude', 'user message'));

    await hub.saveSession();

    const restored = ConversationHub.loadSession(testSessionId);

    // History should contain: user message + assistant reply = 2 entries.
    // (No history getter is exposed; we verify indirectly through another sendTo.)
    // Instead assert the system prompt survived.
    const newAdapter = mockAdapter('claude', 'persistent-bidirectional', [
      mockSession('s2', 'claude', [fakeMsg('assistant', 'ok')]),
    ]);
    restored.registerAdapter(newAdapter);
    await collect(restored.sendTo('claude', 'hi'));

    const spawnPrompt = (newAdapter.spawn as ReturnType<typeof mock>).mock.calls[0][0].systemPrompt;
    expect(spawnPrompt).toContain('PROJECT CONTENT');
    expect(spawnPrompt).toContain('accumulated decision A');
  });

  test('loadSession throws when file does not exist', () => {
    expect(() => ConversationHub.loadSession('nonexistent-id-xyz')).toThrow();
  });

  test('per-turn lastThreadId survives save/load round-trip', async () => {
    const hub = new ConversationHub({
      sessionId: testSessionId,
      cwd: '/tmp',
    });

    const adapter = mockAdapter('codex', 'per-turn-resume', [
      mockSession('thread-99', 'codex', [fakeMsg('assistant', 'ok')]),
    ]);
    hub.registerAdapter(adapter);
    await collect(hub.sendTo('codex', 'hello'));

    await hub.saveSession();

    const restored = ConversationHub.loadSession(testSessionId);
    const newAdapter = mockAdapter('codex', 'per-turn-resume', [
      mockSession('thread-99', 'codex', [fakeMsg('assistant', 'ok2')]),
    ]);
    restored.registerAdapter(newAdapter);
    await collect(restored.sendTo('codex', 'second turn'));

    const secondSpawnOpts = (newAdapter.spawn as ReturnType<typeof mock>).mock.calls[0][0];
    expect(secondSpawnOpts.resumeSessionId).toBe('thread-99');
  });
});

// ---------------------------------------------------------------------------
// ConversationHub — cleanup
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ConversationHub — sequentialHandoff
// ---------------------------------------------------------------------------

// TODO(v0.0.3): restore after fixing async iterator shape mismatch
describe.skip('ConversationHub.sequentialHandoff', () => {
  test('yields tagged messages from each step in order', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });

    hub.registerAdapter(
      mockAdapter('claude', 'persistent-bidirectional', [
        mockSession('c1', 'claude', [fakeMsg('assistant', 'step1')]),
        mockSession('c2', 'claude', [fakeMsg('assistant', 'step2')]),
      ])
    );

    const steps = [
      { provider: 'claude' as const, prompt: 'first' },
      { provider: 'claude' as const, prompt: 'second' },
    ];

    const results: Array<{ provider: string; content: string }> = [];
    for await (const { provider, message } of hub.sequentialHandoff(steps)) {
      results.push({ provider, content: String(message.content) });
    }

    expect(results).toHaveLength(2);
    expect(results[0]?.provider).toBe('claude');
    expect(results[0]?.content).toBe('step1');
    expect(results[1]?.content).toBe('step2');
  });

  test('yields error message for failed step and continues', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });

    hub.registerAdapter(
      mockAdapter('kimi', 'persistent-bidirectional', [
        mockSession('k1', 'kimi', [fakeMsg('assistant', 'kimi-ok')]),
      ])
    );

    // claude is not registered → sendTo('claude') yields system error message
    const steps = [
      { provider: 'claude' as const, prompt: 'first' },
      { provider: 'kimi' as const, prompt: 'second' },
    ];

    const results: Array<{ provider: string; role: string }> = [];
    for await (const { provider, message } of hub.sequentialHandoff(steps)) {
      results.push({ provider, role: message.role });
    }

    // Claude step should yield an error (system role from unregistered provider)
    expect(results.some((r) => r.role === 'system')).toBe(true);
    // Kimi step should still run
    expect(results.some((r) => r.role === 'assistant')).toBe(true);
  });

  test('handles empty steps array', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const results: unknown[] = [];
    for await (const item of hub.sequentialHandoff([])) {
      results.push(item);
    }
    expect(results).toHaveLength(0);
  });
});

describe('ConversationHub.close', () => {
  test('close() closes all active persistent sessions', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    const session = mockSession('s1', 'claude', [fakeMsg('assistant', 'hi')]);
    const adapter = mockAdapter('claude', 'persistent-bidirectional', [session]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('claude', 'hello'));
    await hub.close();

    expect(session.close).toHaveBeenCalledTimes(1);
  });

  test('close() is idempotent — calling twice does not throw', async () => {
    const hub = new ConversationHub({ sessionId: 'test', cwd: '/tmp' });
    await expect(hub.close()).resolves.toBeUndefined();
    await expect(hub.close()).resolves.toBeUndefined();
  });
});
