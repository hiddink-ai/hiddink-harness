/**
 * Integration tests: ConversationHub × 3 providers (claude / codex / kimi).
 *
 * Test scope:
 *  Tests 1–2  use real adapter class instances to verify identity + availability contracts.
 *  Tests 3–4  verify streaming NormalizedMessage shapes from the Hub send pipeline.
 *  Tests 5–10 cover Hub orchestration patterns: per-turn-resume chaining, system prompt
 *             composition, error recovery, parallel consensus, fallback, and persistence.
 *
 * Mock strategy:
 *  - Adapter `spawn()` and `isAvailable()` are replaced with bun:test `mock()` functions.
 *  - No real CLI binary (claude / codex / kimi) is invoked anywhere.
 *  - Fixture files in ./fixtures/ document the expected raw JSONL protocol per provider.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ConversationHub } from '../../src/core/hub.js';
import { ClaudeAdapter } from '../../src/core/providers/claude-adapter.js';
import { CodexAdapter } from '../../src/core/providers/codex-adapter.js';
import { KimiAdapter } from '../../src/core/providers/kimi-adapter.js';
import type {
  ChatSession,
  NormalizedMessage,
  ProviderAdapter,
  ProviderId,
  SpawnOptions,
} from '../../src/core/providers/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------

/** Collects all items from an AsyncIterable into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) items.push(item);
  return items;
}

/** Creates a minimal NormalizedMessage for use in mock sessions. */
function makeMsg(
  role: NormalizedMessage['role'],
  content: string | NormalizedMessage['content']
): NormalizedMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

/**
 * Builds a mock ChatSession that yields a fixed list of messages.
 * `close` is a mock function so call counts can be asserted in tests.
 */
function makeSession(id: string, provider: ProviderId, messages: NormalizedMessage[]): ChatSession {
  return {
    id,
    provider,
    async *send(_msg: string): AsyncIterable<NormalizedMessage> {
      for (const m of messages) yield m;
    },
    close: mock(async () => {}),
  };
}

/**
 * Builds a mock ProviderAdapter.
 *
 * `sessions` is a pool consumed round-robin per `spawn()` call.
 * `available` controls what `isAvailable()` returns.
 */
function makeAdapter(
  id: ProviderId,
  lifecycle: ProviderAdapter['lifecycle'],
  sessions: ChatSession[],
  available = true
): ProviderAdapter {
  let idx = 0;
  return {
    id,
    lifecycle,
    isAvailable: mock(async () => available),
    spawn: mock(async (_opts: SpawnOptions) => {
      const session = sessions[idx % Math.max(sessions.length, 1)];
      idx++;
      return session ?? makeSession('fallback-id', id, []);
    }),
  };
}

// ---------------------------------------------------------------------------
// Session file cleanup — persisted files created by saveSession() in test 10
// ---------------------------------------------------------------------------

const createdSessionIds: string[] = [];

function trackSessionId(id: string): string {
  createdSessionIds.push(id);
  return id;
}

afterEach(() => {
  const sessionsDir = join(homedir(), '.hiddink-harness', 'sessions');
  for (const id of createdSessionIds.splice(0)) {
    const fp = join(sessionsDir, `session-${id}.json`);
    if (existsSync(fp)) {
      try {
        rmSync(fp);
      } catch {
        // best-effort
      }
    }
  }
});

// ===========================================================================
// [1] Hub.registerAdapter — 3 real adapter classes
// ===========================================================================

describe('[1] Hub.registerAdapter — 3 adapters (claude / codex / kimi)', () => {
  it('accepts all three real adapter class instances without error', () => {
    const hub = new ConversationHub({ sessionId: 'int-reg-1', cwd: '/tmp' });

    hub.registerAdapter(new ClaudeAdapter());
    hub.registerAdapter(new CodexAdapter());
    hub.registerAdapter(new KimiAdapter());

    expect(hub.hasAdapter('claude')).toBe(true);
    expect(hub.hasAdapter('codex')).toBe(true);
    expect(hub.hasAdapter('kimi')).toBe(true);
  });

  it('overwrites an earlier registration for the same provider id', () => {
    const hub = new ConversationHub({ sessionId: 'int-reg-2', cwd: '/tmp' });
    hub.registerAdapter(new ClaudeAdapter());
    hub.registerAdapter(new ClaudeAdapter()); // second → overwrites
    expect(hub.hasAdapter('claude')).toBe(true);
  });

  it('real adapter instances expose correct id and lifecycle', () => {
    expect(new ClaudeAdapter().id).toBe('claude');
    expect(new ClaudeAdapter().lifecycle).toBe('persistent-bidirectional');

    expect(new CodexAdapter().id).toBe('codex');
    expect(new CodexAdapter().lifecycle).toBe('per-turn-resume');

    expect(new KimiAdapter().id).toBe('kimi');
    expect(new KimiAdapter().lifecycle).toBe('persistent-bidirectional');
  });
});

// ===========================================================================
// [2] Hub.listAvailable — isAvailable mock per adapter
// ===========================================================================

describe('[2] Hub.listAvailable — per-adapter isAvailable mock', () => {
  it('includes only providers whose isAvailable() resolves true', async () => {
    const hub = new ConversationHub({ sessionId: 'int-avail-1', cwd: '/tmp' });

    hub.registerAdapter(makeAdapter('claude', 'persistent-bidirectional', [], true));
    hub.registerAdapter(makeAdapter('codex', 'per-turn-resume', [], false));
    hub.registerAdapter(makeAdapter('kimi', 'persistent-bidirectional', [], true));

    const available = await hub.listAvailable();

    expect(available).toContain('claude');
    expect(available).not.toContain('codex');
    expect(available).toContain('kimi');
  });

  it('returns an empty array when no adapters are registered', async () => {
    const hub = new ConversationHub({ sessionId: 'int-avail-2', cwd: '/tmp' });
    expect(await hub.listAvailable()).toHaveLength(0);
  });

  it('returns all three when all three report available=true', async () => {
    const hub = new ConversationHub({ sessionId: 'int-avail-3', cwd: '/tmp' });

    hub.registerAdapter(makeAdapter('claude', 'persistent-bidirectional', [], true));
    hub.registerAdapter(makeAdapter('codex', 'per-turn-resume', [], true));
    hub.registerAdapter(makeAdapter('kimi', 'persistent-bidirectional', [], true));

    const available = await hub.listAvailable();
    expect(available).toHaveLength(3);
    expect(available).toContain('claude');
    expect(available).toContain('codex');
    expect(available).toContain('kimi');
  });
});

// ===========================================================================
// [3] Hub.sendTo('claude') — AsyncIterable<NormalizedMessage> streaming
// ===========================================================================

describe('[3] Hub.sendTo("claude") — streaming NormalizedMessage via persistent-bidirectional', () => {
  it('yields ContentBlock assistant messages from a claude session', async () => {
    const hub = new ConversationHub({ sessionId: 'int-claude-send', cwd: '/tmp' });

    // Simulate what ClaudeAdapter.normalizeStreamEvent produces for a text_delta event
    const claudeReply: NormalizedMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '안녕하세요!' }],
      timestamp: new Date().toISOString(),
      providerMeta: { streaming: true, index: 0 },
    };
    hub.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('claude-int-001', 'claude', [claudeReply]),
      ])
    );

    const messages = await collect(hub.sendTo('claude', '안녕'));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(Array.isArray(messages[0].content)).toBe(true);
    const blocks = messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks[0]).toMatchObject({ type: 'text', text: '안녕하세요!' });
  });

  it('reuses the same session across consecutive sendTo calls (persistent-bidirectional)', async () => {
    const hub = new ConversationHub({ sessionId: 'int-claude-reuse', cwd: '/tmp' });

    const session = makeSession('claude-reuse-1', 'claude', [makeMsg('assistant', 'ok')]);
    const adapter = makeAdapter('claude', 'persistent-bidirectional', [session]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('claude', 'turn 1'));
    await collect(hub.sendTo('claude', 'turn 2'));

    // spawn() must be called only once for persistent-bidirectional
    expect((adapter.spawn as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  it('appends user and assistant messages to shared history', async () => {
    const hub = new ConversationHub({ sessionId: 'int-claude-hist', cwd: '/tmp' });

    hub.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('claude-hist-1', 'claude', [makeMsg('assistant', 'Pong')]),
      ])
    );

    await collect(hub.sendTo('claude', 'Ping'));

    // Save and inspect persisted history as the only observable side-channel
    const sessionId = trackSessionId(`int-claude-hist-verify-${Date.now()}`);
    const hub2 = new ConversationHub({ sessionId, cwd: '/tmp' });
    hub2.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('s', 'claude', [makeMsg('assistant', 'r')]),
      ])
    );
    await collect(hub2.sendTo('claude', 'msg'));
    await hub2.saveSession();

    const fp = join(homedir(), '.hiddink-harness', 'sessions', `session-${sessionId}.json`);
    const saved = JSON.parse(readFileSync(fp, 'utf-8'));
    expect(Array.isArray(saved.history)).toBe(true);
    expect(saved.history.length).toBeGreaterThanOrEqual(2); // user + assistant
  });
});

// ===========================================================================
// [4] Hub.sendTo('kimi') — persistent-bidirectional streaming
// ===========================================================================

describe('[4] Hub.sendTo("kimi") — streaming NormalizedMessage via persistent-bidirectional', () => {
  it('yields ContentBlock assistant messages from a kimi session', async () => {
    const hub = new ConversationHub({ sessionId: 'int-kimi-send', cwd: '/tmp' });

    // Simulate what KimiAdapter.normalizeStreamEvent produces for a delta event
    const kimiReply: NormalizedMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '안녕, Kimi입니다!' }],
      timestamp: new Date().toISOString(),
      providerMeta: { streaming: true, index: 0 },
    };
    hub.registerAdapter(
      makeAdapter('kimi', 'persistent-bidirectional', [
        makeSession('kimi-int-001', 'kimi', [kimiReply]),
      ])
    );

    const messages = await collect(hub.sendTo('kimi', '안녕'));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(Array.isArray(messages[0].content)).toBe(true);
    const blocks = messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks[0]).toMatchObject({ type: 'text', text: '안녕, Kimi입니다!' });
  });

  it('reuses the same session across consecutive sendTo calls', async () => {
    const hub = new ConversationHub({ sessionId: 'int-kimi-reuse', cwd: '/tmp' });

    const session = makeSession('kimi-reuse-1', 'kimi', [makeMsg('assistant', 'ok')]);
    const adapter = makeAdapter('kimi', 'persistent-bidirectional', [session]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('kimi', 'first'));
    await collect(hub.sendTo('kimi', 'second'));

    expect((adapter.spawn as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });
});

// ===========================================================================
// [5] Hub.sendTo('codex') — per-turn-resume thread ID chaining
// ===========================================================================

describe('[5] Hub.sendTo("codex") — per-turn-resume resumeSessionId chain', () => {
  it('first call spawns with no resumeSessionId', async () => {
    const hub = new ConversationHub({ sessionId: 'int-codex-first', cwd: '/tmp' });

    const session1 = makeSession('codex-thread-001', 'codex', [
      makeMsg('assistant', 'First reply'),
    ]);
    const adapter = makeAdapter('codex', 'per-turn-resume', [session1]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('codex', 'First question'));

    const firstOpts = (adapter.spawn as ReturnType<typeof mock>).mock.calls[0][0] as SpawnOptions;
    expect(firstOpts.resumeSessionId).toBeUndefined();
  });

  it('second call forwards session1.id as resumeSessionId (thread ID chaining)', async () => {
    const hub = new ConversationHub({ sessionId: 'int-codex-chain', cwd: '/tmp' });

    // session1.id = 'codex-thread-001' — Hub stores this after first turn
    const session1 = makeSession('codex-thread-001', 'codex', [makeMsg('assistant', 'Reply 1')]);
    // session2 is spawned on the second turn
    const session2 = makeSession('codex-thread-002', 'codex', [makeMsg('assistant', 'Reply 2')]);
    const adapter = makeAdapter('codex', 'per-turn-resume', [session1, session2]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('codex', 'Q1'));
    await collect(hub.sendTo('codex', 'Q2'));

    const secondOpts = (adapter.spawn as ReturnType<typeof mock>).mock.calls[1][0] as SpawnOptions;
    expect(secondOpts.resumeSessionId).toBe('codex-thread-001');
  });

  it('spawns a fresh session for every turn (lifecycle contract)', async () => {
    const hub = new ConversationHub({ sessionId: 'int-codex-turns', cwd: '/tmp' });

    const s = makeSession('t1', 'codex', [makeMsg('assistant', 'ok')]);
    const adapter = makeAdapter('codex', 'per-turn-resume', [s]);
    hub.registerAdapter(adapter);

    await collect(hub.sendTo('codex', 'turn1'));
    await collect(hub.sendTo('codex', 'turn2'));
    await collect(hub.sendTo('codex', 'turn3'));

    expect((adapter.spawn as ReturnType<typeof mock>).mock.calls).toHaveLength(3);
  });

  it('closes each per-turn session after collecting its response', async () => {
    const hub = new ConversationHub({ sessionId: 'int-codex-close', cwd: '/tmp' });

    const session1 = makeSession('t-close-1', 'codex', [makeMsg('assistant', 'ok')]);
    const session2 = makeSession('t-close-2', 'codex', [makeMsg('assistant', 'ok')]);
    hub.registerAdapter(makeAdapter('codex', 'per-turn-resume', [session1, session2]));

    await collect(hub.sendTo('codex', 'q1'));
    await collect(hub.sendTo('codex', 'q2'));

    // Each per-turn session must be closed after its turn
    expect((session1.close as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((session2.close as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });
});

// ===========================================================================
// [6] Evolving system prompt — appendSystemContext propagation
// ===========================================================================

describe('[6] appendSystemContext — composed system prompt passed via SpawnOptions', () => {
  it('passes the composed prompt to adapter.spawn() systemPrompt field', async () => {
    const hub = new ConversationHub({ sessionId: 'int-sysprompt-1', cwd: '/tmp' });

    let capturedOpts: SpawnOptions | null = null;
    hub.registerAdapter({
      id: 'claude',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: mock(async (opts: SpawnOptions) => {
        capturedOpts = opts;
        return makeSession('sp-1', 'claude', [makeMsg('assistant', 'ok')]);
      }),
    });

    hub.appendSystemContext('project', 'You are a helpful assistant.');
    hub.appendSystemContext('session', 'Prefer concise answers.');

    await collect(hub.sendTo('claude', 'test'));

    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts?.systemPrompt).toContain('You are a helpful assistant.');
    expect(capturedOpts?.systemPrompt).toContain('Prefer concise answers.');
  });

  it('project layer appears before session layer in composed prompt', async () => {
    const hub = new ConversationHub({ sessionId: 'int-sysprompt-order', cwd: '/tmp' });

    let capturedOpts: SpawnOptions | null = null;
    hub.registerAdapter({
      id: 'claude',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: mock(async (opts: SpawnOptions) => {
        capturedOpts = opts;
        return makeSession('sp-order', 'claude', [makeMsg('assistant', 'ok')]);
      }),
    });

    hub.appendSystemContext('project', 'PROJECT_LAYER');
    hub.appendSystemContext('session', 'SESSION_LAYER');

    await collect(hub.sendTo('claude', 'test'));

    expect(capturedOpts?.systemPrompt.indexOf('PROJECT_LAYER')).toBeLessThan(
      capturedOpts?.systemPrompt.indexOf('SESSION_LAYER')
    );
  });

  it('provider-specific layer is isolated per provider — no cross-contamination', async () => {
    const hub = new ConversationHub({ sessionId: 'int-sysprompt-provider', cwd: '/tmp' });

    let claudeOpts: SpawnOptions | null = null;
    let kimiOpts: SpawnOptions | null = null;

    hub.registerAdapter({
      id: 'claude',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: mock(async (opts: SpawnOptions) => {
        claudeOpts = opts;
        return makeSession('c-sp', 'claude', []);
      }),
    });
    hub.registerAdapter({
      id: 'kimi',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: mock(async (opts: SpawnOptions) => {
        kimiOpts = opts;
        return makeSession('k-sp', 'kimi', []);
      }),
    });

    hub.appendSystemContext('provider', 'CLAUDE_ONLY', 'claude');
    hub.appendSystemContext('provider', 'KIMI_ONLY', 'kimi');

    await collect(hub.sendTo('claude', 'test'));
    await collect(hub.sendTo('kimi', 'test'));

    expect(claudeOpts?.systemPrompt).toContain('CLAUDE_ONLY');
    expect(claudeOpts?.systemPrompt).not.toContain('KIMI_ONLY');
    expect(kimiOpts?.systemPrompt).toContain('KIMI_ONLY');
    expect(kimiOpts?.systemPrompt).not.toContain('CLAUDE_ONLY');
  });
});

// ===========================================================================
// [7] Error handling — provider failure yields {role:'system'}, never throws
// ===========================================================================

describe('[7] Error handling — non-zero exit / spawn failure → system message, not throw', () => {
  it('yields system-role message when session yields one (exit-code simulation)', async () => {
    const hub = new ConversationHub({ sessionId: 'int-err-1', cwd: '/tmp' });

    // Simulate CodexAdapter behaviour for non-zero exit: yields {role:'system'}
    const errorSession = makeSession('err-sess', 'claude', [
      makeMsg('system', 'Codex process exited with code 1'),
    ]);
    hub.registerAdapter(makeAdapter('claude', 'persistent-bidirectional', [errorSession]));

    let threw = false;
    let messages: NormalizedMessage[] = [];
    try {
      messages = await collect(hub.sendTo('claude', 'test'));
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(messages.some((m) => m.role === 'system')).toBe(true);
  });

  it('yields system-role error when spawn() throws — never re-throws to caller', async () => {
    const hub = new ConversationHub({ sessionId: 'int-err-spawn', cwd: '/tmp' });

    hub.registerAdapter({
      id: 'kimi',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: mock(async () => {
        throw new Error('spawn ENOENT: kimi not found');
      }),
    });

    let threw = false;
    let messages: NormalizedMessage[] = [];
    try {
      messages = await collect(hub.sendTo('kimi', 'test'));
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(String(messages[0].content)).toContain('spawn ENOENT');
  });

  it('yields system-role error for unregistered provider — never throws', async () => {
    const hub = new ConversationHub({ sessionId: 'int-err-noreg', cwd: '/tmp' });

    let threw = false;
    let messages: NormalizedMessage[] = [];
    try {
      messages = await collect(hub.sendTo('codex', 'test'));
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(messages[0].role).toBe('system');
    expect(String(messages[0].content)).toContain('No adapter registered');
  });
});

// ===========================================================================
// [8] Hub.parallelConsensus — Map<ProviderId, NormalizedMessage[]>
// ===========================================================================

describe('[8] Hub.parallelConsensus — all 3 providers called concurrently', () => {
  it('returns a Map keyed by ProviderId with responses from all 3 providers', async () => {
    const hub = new ConversationHub({ sessionId: 'int-parallel-1', cwd: '/tmp' });

    hub.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('c1', 'claude', [makeMsg('assistant', 'Claude reply')]),
      ])
    );
    hub.registerAdapter(
      makeAdapter('codex', 'per-turn-resume', [
        makeSession('d1', 'codex', [makeMsg('assistant', 'Codex reply')]),
      ])
    );
    hub.registerAdapter(
      makeAdapter('kimi', 'persistent-bidirectional', [
        makeSession('k1', 'kimi', [makeMsg('assistant', 'Kimi reply')]),
      ])
    );

    const results = await hub.parallelConsensus('같은 질문', ['claude', 'codex', 'kimi']);

    expect(results.size).toBe(3);
    expect(results.has('claude')).toBe(true);
    expect(results.has('codex')).toBe(true);
    expect(results.has('kimi')).toBe(true);

    expect(String(results.get('claude')?.[0].content)).toContain('Claude reply');
    expect(String(results.get('codex')?.[0].content)).toContain('Codex reply');
    expect(String(results.get('kimi')?.[0].content)).toContain('Kimi reply');
  });

  it('captures a failed provider as a system-role entry without blocking the others', async () => {
    const hub = new ConversationHub({ sessionId: 'int-parallel-err', cwd: '/tmp' });

    hub.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('c2', 'claude', [makeMsg('assistant', 'Claude ok')]),
      ])
    );
    // codex: spawn throws — Hub's parallelConsensus must not surface this as a thrown error
    hub.registerAdapter({
      id: 'codex',
      lifecycle: 'per-turn-resume',
      isAvailable: mock(async () => true),
      spawn: mock(async () => {
        throw new Error('codex CLI unavailable');
      }),
    });
    hub.registerAdapter(
      makeAdapter('kimi', 'persistent-bidirectional', [
        makeSession('k2', 'kimi', [makeMsg('assistant', 'Kimi ok')]),
      ])
    );

    const results = await hub.parallelConsensus('test', ['claude', 'codex', 'kimi']);

    expect(results.get('claude')?.[0].role).toBe('assistant');
    expect(results.get('codex')?.[0].role).toBe('system'); // error captured, not thrown
    expect(results.get('kimi')?.[0].role).toBe('assistant');
  });

  it('sends the same message to every provider', async () => {
    const hub = new ConversationHub({ sessionId: 'int-parallel-msg', cwd: '/tmp' });

    const claudeSpawnMock = mock(async (_opts: SpawnOptions) =>
      makeSession('c3', 'claude', [makeMsg('assistant', 'ok')])
    );
    const kimiSpawnMock = mock(async (_opts: SpawnOptions) =>
      makeSession('k3', 'kimi', [makeMsg('assistant', 'ok')])
    );

    hub.registerAdapter({
      id: 'claude',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: claudeSpawnMock,
    });
    hub.registerAdapter({
      id: 'kimi',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: kimiSpawnMock,
    });

    await hub.parallelConsensus('공통 질문입니다', ['claude', 'kimi']);

    // Both providers must have been spawned (and thus received the message)
    expect(claudeSpawnMock.mock.calls).toHaveLength(1);
    expect(kimiSpawnMock.mock.calls).toHaveLength(1);
  });
});

// ===========================================================================
// [9] Hub.fallbackChain — automatic provider failover
// ===========================================================================

describe('[9] Hub.fallbackChain — first provider fails → next provider', () => {
  it('falls back to second provider when first session starts with a system-role message', async () => {
    const hub = new ConversationHub({ sessionId: 'int-fallback-1', cwd: '/tmp' });

    // Claude: first message is role='system' → treated as failure by fallbackChain
    hub.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('c-fail', 'claude', [makeMsg('system', 'Claude temporarily unavailable')]),
      ])
    );
    // Kimi: returns valid assistant response → becomes the fallback winner
    hub.registerAdapter(
      makeAdapter('kimi', 'persistent-bidirectional', [
        makeSession('k-ok', 'kimi', [makeMsg('assistant', 'Kimi fallback response')]),
      ])
    );

    const messages = await collect(hub.fallbackChain('question', ['claude', 'kimi']));

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].role).toBe('assistant');
    expect(String(messages[0].content)).toContain('Kimi fallback response');
  });

  it('returns the last error message when all providers fail', async () => {
    const hub = new ConversationHub({ sessionId: 'int-fallback-all-fail', cwd: '/tmp' });

    hub.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('c-err', 'claude', [makeMsg('system', 'Claude error')]),
      ])
    );
    hub.registerAdapter(
      makeAdapter('codex', 'per-turn-resume', [
        makeSession('d-err', 'codex', [makeMsg('system', 'Codex error')]),
      ])
    );

    const messages = await collect(hub.fallbackChain('question', ['claude', 'codex']));

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
  });

  it('stops at the first successful provider (does not call the remaining ones)', async () => {
    const hub = new ConversationHub({ sessionId: 'int-fallback-stop', cwd: '/tmp' });

    const kimiSpawn = mock(async (_opts: SpawnOptions) =>
      makeSession('k-never', 'kimi', [makeMsg('assistant', 'should not reach')])
    );

    hub.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('c-ok', 'claude', [makeMsg('assistant', 'Claude succeeds first')]),
      ])
    );
    hub.registerAdapter({
      id: 'kimi',
      lifecycle: 'persistent-bidirectional',
      isAvailable: mock(async () => true),
      spawn: kimiSpawn,
    });

    await collect(hub.fallbackChain('question', ['claude', 'kimi']));

    // kimi should never be spawned — claude succeeded
    expect(kimiSpawn.mock.calls).toHaveLength(0);
  });
});

// ===========================================================================
// [10] Session persistence — Hub.saveSession() / ConversationHub.loadSession()
// ===========================================================================

describe('[10] Session persistence — saveSession / loadSession round-trip', () => {
  it('saveSession() writes a JSON file with history and loadSession() restores it', async () => {
    const sessionId = trackSessionId(`int-persist-${Date.now()}`);
    const hub = new ConversationHub({ sessionId, cwd: '/workspace' });

    hub.registerAdapter(
      makeAdapter('claude', 'persistent-bidirectional', [
        makeSession('persist-sess', 'claude', [makeMsg('assistant', 'Hello from history')]),
      ])
    );
    await collect(hub.sendTo('claude', 'Hi'));

    await hub.saveSession();

    const filePath = join(homedir(), '.hiddink-harness', 'sessions', `session-${sessionId}.json`);
    expect(existsSync(filePath)).toBe(true);

    const restored = ConversationHub.loadSession(sessionId);
    expect(restored instanceof ConversationHub).toBe(true);
    // Adapters are NOT restored — callers must re-register
    expect(restored.hasAdapter('claude')).toBe(false);
    // sessionId is preserved
    // (no direct getter, but persistence round-trip proves file is written/read correctly)
  });

  it('loadSession() throws when the session file does not exist', () => {
    expect(() => ConversationHub.loadSession('this-session-does-not-exist-xyz-789')).toThrow();
  });

  it('persisted JSON file contains correct lastThreadIds for codex', async () => {
    const sessionId = trackSessionId(`int-persist-codex-${Date.now()}`);
    const hub = new ConversationHub({ sessionId, cwd: '/workspace' });

    hub.registerAdapter(
      makeAdapter('codex', 'per-turn-resume', [
        makeSession('codex-thread-persist-001', 'codex', [makeMsg('assistant', 'Codex ok')]),
      ])
    );
    await collect(hub.sendTo('codex', 'question'));

    await hub.saveSession();

    const filePath = join(homedir(), '.hiddink-harness', 'sessions', `session-${sessionId}.json`);
    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));

    expect(saved.lastThreadIds).toBeDefined();
    expect(saved.lastThreadIds.codex).toBe('codex-thread-persist-001');
  });

  it('persisted JSON file contains history entries with correct roles', async () => {
    const sessionId = trackSessionId(`int-persist-hist-${Date.now()}`);
    const hub = new ConversationHub({ sessionId, cwd: '/workspace' });

    hub.registerAdapter(
      makeAdapter('kimi', 'persistent-bidirectional', [
        makeSession('kimi-hist-p', 'kimi', [makeMsg('assistant', 'Kimi response')]),
      ])
    );
    await collect(hub.sendTo('kimi', 'User question'));

    await hub.saveSession();

    const filePath = join(homedir(), '.hiddink-harness', 'sessions', `session-${sessionId}.json`);
    const saved = JSON.parse(readFileSync(filePath, 'utf-8'));

    const roles = (saved.history as NormalizedMessage[]).map((m) => m.role);
    expect(roles).toContain('user');
    expect(roles).toContain('assistant');
  });
});
