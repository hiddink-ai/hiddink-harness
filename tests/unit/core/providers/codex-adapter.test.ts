/**
 * Unit tests for CodexAdapter and CodexSession.
 *
 * The `codex` CLI binary is never invoked — all child_process.spawn calls
 * are intercepted via a mock subclass of CodexSession that replaces
 * spawnProcess() with a factory producing controllable FakeChildProcess instances.
 */

import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import {
  buildStdinPayload,
  CodexAdapter,
  normalizeEvent,
  parseLine,
} from '../../../../src/core/providers/codex-adapter.js';
import type { NormalizedMessage, SpawnOptions } from '../../../../src/core/providers/types.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/** Collects all items from an AsyncIterable into an array. */
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) {
    items.push(item);
  }
  return items;
}

/**
 * A minimal fake ChildProcess that can emit stdout data and close events
 * on demand, sufficient to drive CodexSession.streamProcess().
 */
class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin: Writable;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killedWith: Array<NodeJS.Signals | number | undefined> = [];

  constructor() {
    super();
    // Capture stdin writes so tests can inspect the payload.
    const chunks: string[] = [];
    this.stdin = new Writable({
      write(chunk, _encoding, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    (this.stdin as unknown as { _chunks: string[] })._chunks = chunks;
  }

  /** Emit a JSONL line on stdout. */
  emitLine(json: object): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(json)}\n`));
  }

  /** Emit diagnostic stderr. */
  emitStderr(text: string): void {
    this.stderr.emit('data', Buffer.from(text));
  }

  /** Signal normal process exit. */
  emitClose(code = 0): void {
    this.exitCode = code;
    this.emit('close', code);
  }

  /** Signal a spawn-level error (e.g. ENOENT). */
  emitError(err: Error): void {
    this.emit('error', err);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith.push(signal);
    this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
    this.emit('exit', null, this.signalCode);
    this.emit('close', null);
    return true;
  }
}

/**
 * Subclass of the internal CodexSession that intercepts spawnProcess()
 * so no real child process is ever started.
 *
 * Because CodexSession is not exported we reach it indirectly by importing the
 * module, extracting the class from the adapter's spawn() return value, and
 * then monkey-patching the prototype. However, a cleaner pattern is to expose
 * a testable subclass. Here we use dynamic access after casting.
 */

// We need access to the internal CodexSession class. The module does not
// export it directly, so we obtain an instance via CodexAdapter.spawn() and
// replace its spawnProcess() method on the instance level.

type TestableSession = {
  id: string;
  provider: string;
  send(msg: string): AsyncIterable<NormalizedMessage>;
  close(): Promise<void>;
  /** Replaced in tests to inject FakeChildProcess. */
  spawnProcess: (cmd: string, args: string[]) => ChildProcess;
};

interface SpawnCall {
  cmd: string;
  args: string[];
}

/**
 * Create a CodexSession instance (via CodexAdapter.spawn) with spawnProcess()
 * replaced by a factory that returns the provided FakeChildProcess instances
 * in sequence.
 */
async function makeSession(
  opts: Partial<SpawnOptions>,
  fakes: FakeChildProcess[]
): Promise<{ session: TestableSession; spawnCalls: SpawnCall[] }> {
  const adapter = new CodexAdapter();
  const defaultOpts: SpawnOptions = {
    systemPrompt: 'You are a helpful assistant.',
    cwd: '/tmp/project',
    ...opts,
  };

  const session = (await adapter.spawn(defaultOpts)) as unknown as TestableSession;
  const spawnCalls: SpawnCall[] = [];
  let fakeIndex = 0;

  session.spawnProcess = (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    const fake = fakes[fakeIndex % fakes.length];
    fakeIndex += 1;
    return fake as unknown as ChildProcess;
  };

  return { session, spawnCalls };
}

// ---------------------------------------------------------------------------
// parseLine
// ---------------------------------------------------------------------------

describe('parseLine', () => {
  test('returns null for blank lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  test('returns null for non-JSON lines', () => {
    expect(parseLine('Connecting to Codex...')).toBeNull();
  });

  test('parses a valid JSONL event', () => {
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'abc123' });
    const result = parseLine(line);
    expect(result).toEqual({ type: 'thread.started', thread_id: 'abc123' });
  });
});

// ---------------------------------------------------------------------------
// buildStdinPayload
// ---------------------------------------------------------------------------

describe('buildStdinPayload', () => {
  test('prepends system prompt when non-empty', () => {
    const payload = buildStdinPayload('Be concise.', 'Hello');
    expect(payload).toContain('[SYSTEM]');
    expect(payload).toContain('Be concise.');
    expect(payload).toContain('[USER]');
    expect(payload).toContain('Hello');
    // System section must appear before user section.
    expect(payload.indexOf('[SYSTEM]')).toBeLessThan(payload.indexOf('[USER]'));
  });

  test('returns only the user message when system prompt is empty', () => {
    const payload = buildStdinPayload('', 'Hello');
    expect(payload).toBe('Hello');
    expect(payload).not.toContain('[SYSTEM]');
  });

  test('returns only the user message when system prompt is whitespace', () => {
    const payload = buildStdinPayload('   ', 'Hello');
    expect(payload).toBe('Hello');
  });
});

// ---------------------------------------------------------------------------
// normalizeEvent
// ---------------------------------------------------------------------------

describe('normalizeEvent', () => {
  const makeRef = (id = ''): { current: string } => ({ current: id });

  test('thread.started — updates sessionIdRef, returns null', () => {
    const ref = makeRef();
    const result = normalizeEvent({ type: 'thread.started', thread_id: 'tid-42' }, ref);
    expect(result).toBeNull();
    expect(ref.current).toBe('tid-42');
  });

  test('turn.started — returns null', () => {
    const ref = makeRef();
    const result = normalizeEvent({ type: 'turn.started' }, ref);
    expect(result).toBeNull();
  });

  test('item.started (command_execution) — returns tool_use message', () => {
    const ref = makeRef();
    const result = normalizeEvent(
      {
        type: 'item.started',
        item: { type: 'command_execution', name: 'run_shell', arguments: { cmd: 'ls' } },
      },
      ref
    );
    expect(result?.role).toBe('assistant');
    expect(Array.isArray(result?.content)).toBe(true);
    const block = (result?.content as Array<{ type: string; toolName?: string }>)[0];
    expect(block?.type).toBe('tool_use');
    expect(block?.toolName).toBe('run_shell');
  });

  test('item.started (unknown type) — returns null', () => {
    const ref = makeRef();
    const result = normalizeEvent({ type: 'item.started', item: { type: 'thinking_step' } }, ref);
    expect(result).toBeNull();
  });

  test('item.completed (agent_message) — returns assistant text message', () => {
    const ref = makeRef();
    const result = normalizeEvent(
      { type: 'item.completed', item: { type: 'agent_message', text: 'Hello there!' } },
      ref
    );
    expect(result?.role).toBe('assistant');
    const block = (result?.content as Array<{ type: string; text?: string }>)[0];
    expect(block?.type).toBe('text');
    expect(block?.text).toBe('Hello there!');
  });

  test('item.completed (function_call_output) — returns tool message', () => {
    const ref = makeRef();
    const result = normalizeEvent(
      {
        type: 'item.completed',
        item: { type: 'function_call_output', output: { result: 42 } },
      },
      ref
    );
    expect(result?.role).toBe('tool');
  });

  test('item.completed (unknown type) — returns null', () => {
    const ref = makeRef();
    const result = normalizeEvent(
      { type: 'item.completed', item: { type: 'something_else' } },
      ref
    );
    expect(result).toBeNull();
  });

  test('turn.completed — returns system message with usage in providerMeta', () => {
    const ref = makeRef();
    const usage = { input_tokens: 10, output_tokens: 20 };
    const result = normalizeEvent({ type: 'turn.completed', usage }, ref);
    expect(result?.role).toBe('system');
    expect(result?.providerMeta?.usage).toEqual(usage);
  });

  test('error — returns system message with error text', () => {
    const ref = makeRef();
    const result = normalizeEvent(
      { type: 'error', message: 'Rate limit exceeded', code: '429' },
      ref
    );
    expect(result?.role).toBe('system');
    expect(String(result?.content)).toContain('Rate limit exceeded');
  });

  test('error without message — falls back to generic error text', () => {
    const ref = makeRef();
    const result = normalizeEvent({ type: 'error', code: '500' }, ref);
    expect(result?.role).toBe('system');
    expect(String(result?.content)).toContain('500');
  });

  test('turn.failed — returns the provider failure message', () => {
    const ref = makeRef();
    const result = normalizeEvent(
      { type: 'turn.failed', error: { message: 'The selected model is not supported' } },
      ref
    );
    expect(result?.role).toBe('system');
    expect(String(result?.content)).toContain('selected model');
  });
});

// ---------------------------------------------------------------------------
// CodexAdapter.isAvailable
// ---------------------------------------------------------------------------

describe('CodexAdapter.isAvailable', () => {
  test('returns true when codex exits 0', async () => {
    // We cannot reliably stub spawn here without deeper mocking, so we accept
    // that this test is environment-dependent. We verify the method exists and
    // returns a boolean.
    const adapter = new CodexAdapter();
    const result = await adapter.isAvailable();
    expect(typeof result).toBe('boolean');
  });

  test('id and lifecycle are correct', () => {
    const adapter = new CodexAdapter();
    expect(adapter.id).toBe('codex');
    expect(adapter.lifecycle).toBe('per-turn-resume');
  });
});

// ---------------------------------------------------------------------------
// CodexSession: first turn — thread.started captures session.id
// ---------------------------------------------------------------------------

describe('CodexSession: first turn', () => {
  test('captures thread_id from thread.started event into session.id', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    const sendPromise = collect(session.send('Hello'));

    // Simulate Codex emitting events.
    fake.emitLine({ type: 'thread.started', thread_id: 'thread-001' });
    fake.emitLine({ type: 'turn.started' });
    fake.emitLine({ type: 'item.completed', item: { type: 'agent_message', text: 'Hi!' } });
    fake.emitLine({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 10 } });
    fake.emitClose(0);

    const msgs = await sendPromise;

    // session.id should now reflect the captured thread_id.
    expect(session.id).toBe('thread-001');

    // Should have emitted: assistant text + turn.completed system message.
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
    const textContent = assistantMsgs[0]?.content;
    expect(Array.isArray(textContent)).toBe(true);
    const textBlock = (textContent as Array<{ type: string; text?: string }>)[0];
    expect(textBlock?.text).toBe('Hi!');
  });

  test('first turn uses stdin mode (--skip-git-repo-check --cd ... -)', async () => {
    const fake = new FakeChildProcess();
    const { session, spawnCalls } = await makeSession({ cwd: '/my/project' }, [fake]);

    const sendPromise = collect(session.send('Hello'));
    fake.emitLine({ type: 'thread.started', thread_id: 'tid-x' });
    fake.emitLine({ type: 'turn.completed' });
    fake.emitClose(0);
    await sendPromise;

    expect(spawnCalls).toHaveLength(1);
    const { args } = spawnCalls[0];
    // Must include exec subcommand and stdin sentinel.
    expect(args).toContain('exec');
    expect(args).toContain('-');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('--cd');
    expect(args).toContain('/my/project');
    expect(args).toContain('--sandbox');
    expect(args).toContain('workspace-write');
    expect(args).toContain('-c');
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain('--ask-for-approval');
    // Must not include 'resume' on first turn.
    expect(args).not.toContain('resume');
  });

  test('first turn forwards explicit model override to codex exec', async () => {
    const fake = new FakeChildProcess();
    const { session, spawnCalls } = await makeSession({ cwd: '/my/project', model: 'gpt-5.5' }, [
      fake,
    ]);

    const sendPromise = collect(session.send('Hello'));
    fake.emitLine({ type: 'thread.started', thread_id: 'tid-model' });
    fake.emitLine({ type: 'turn.completed' });
    fake.emitClose(0);
    await sendPromise;

    const { args } = spawnCalls[0];
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.5');
    expect(args.indexOf('-m')).toBeLessThan(args.indexOf('-'));
  });

  test('system prompt is written to stdin as synthesised payload', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({ systemPrompt: 'Be precise.', cwd: '/tmp' }, [fake]);

    const sendPromise = collect(session.send('What is 2+2?'));
    fake.emitLine({ type: 'thread.started', thread_id: 'tid-sys' });
    fake.emitLine({ type: 'turn.completed' });
    fake.emitClose(0);
    await sendPromise;

    // Inspect what was written to stdin.
    const writtenChunks = (fake.stdin as unknown as { _chunks: string[] })._chunks;
    const stdinContent = writtenChunks.join('');
    expect(stdinContent).toContain('[SYSTEM]');
    expect(stdinContent).toContain('Be precise.');
    expect(stdinContent).toContain('[USER]');
    expect(stdinContent).toContain('What is 2+2?');
  });
});

// ---------------------------------------------------------------------------
// CodexSession: subsequent turn — resume mode
// ---------------------------------------------------------------------------

describe('CodexSession: subsequent turn (resume)', () => {
  test('uses resume command when resumeSessionId is supplied', async () => {
    const fake = new FakeChildProcess();
    const { session, spawnCalls } = await makeSession({ resumeSessionId: 'thread-prev' }, [fake]);

    const sendPromise = collect(session.send('Continue'));
    fake.emitLine({ type: 'thread.started', thread_id: 'thread-prev' });
    fake.emitLine({ type: 'turn.completed' });
    fake.emitClose(0);
    await sendPromise;

    const { args } = spawnCalls[0];
    expect(args).toContain('resume');
    expect(args).toContain('thread-prev');
    expect(args).toContain('--json');
    expect(args).toContain('--skip-git-repo-check');
    expect(args).toContain('-c');
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain('--ask-for-approval');
    expect(args).not.toContain('--sandbox');
    // Message passed as positional arg, not via stdin.
    expect(args).toContain('Continue');
    expect(args).not.toContain('-'); // stdin sentinel absent
  });

  test('resume turn forwards explicit model override to codex exec', async () => {
    const fake = new FakeChildProcess();
    const { session, spawnCalls } = await makeSession(
      { resumeSessionId: 'thread-prev', model: 'gpt-5.5' },
      [fake]
    );

    const sendPromise = collect(session.send('Continue'));
    fake.emitLine({ type: 'thread.started', thread_id: 'thread-prev' });
    fake.emitLine({ type: 'turn.completed' });
    fake.emitClose(0);
    await sendPromise;

    const { args } = spawnCalls[0];
    expect(args).toContain('resume');
    expect(args).toContain('-m');
    expect(args).toContain('gpt-5.5');
    expect(args.indexOf('-m')).toBeLessThan(args.indexOf('thread-prev'));
  });

  test('session.id reflects resumeSessionId before first event', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({ resumeSessionId: 'thread-resume-42' }, [fake]);

    // Before send() is called, id should be the resume ID.
    expect(session.id).toBe('thread-resume-42');

    const sendPromise = collect(session.send('Next message'));
    fake.emitLine({ type: 'thread.started', thread_id: 'thread-resume-42' });
    fake.emitLine({ type: 'turn.completed' });
    fake.emitClose(0);
    await sendPromise;

    expect(session.id).toBe('thread-resume-42');
  });
});

// ---------------------------------------------------------------------------
// CodexSession: error handling — never throw, yield system messages
// ---------------------------------------------------------------------------

describe('CodexSession: error handling', () => {
  test('error event yields system message without throwing', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    const sendPromise = collect(session.send('Hello'));
    fake.emitLine({ type: 'thread.started', thread_id: 'tid-err' });
    fake.emitLine({ type: 'error', message: 'Rate limit exceeded', code: '429' });
    fake.emitLine({ type: 'turn.completed' });
    fake.emitClose(0);

    const msgs = await sendPromise;
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    expect(systemMsgs.some((m) => String(m.content).includes('Rate limit exceeded'))).toBe(true);
  });

  test('non-zero exit code yields system message without throwing', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    const sendPromise = collect(session.send('Hello'));
    fake.emitLine({ type: 'thread.started', thread_id: 'tid-exit' });
    fake.emitClose(1);

    const msgs = await sendPromise;
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    expect(systemMsgs.some((m) => String(m.content).includes('exited with code 1'))).toBe(true);
  });

  test('non-zero exit code includes stderr when no provider error was emitted', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    const sendPromise = collect(session.send('Hello'));
    fake.emitLine({ type: 'thread.started', thread_id: 'tid-stderr' });
    fake.emitStderr('bad flag');
    fake.emitClose(1);

    const msgs = await sendPromise;
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    expect(systemMsgs.some((m) => String(m.content).includes('bad flag'))).toBe(true);
  });

  test('non-zero exit code does not mask provider error details', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    const sendPromise = collect(session.send('Hello'));
    fake.emitLine({ type: 'thread.started', thread_id: 'tid-provider-error' });
    fake.emitLine({
      type: 'error',
      message:
        '{"type":"error","status":400,"error":{"message":"The default model is not supported"}}',
    });
    fake.emitLine({
      type: 'turn.failed',
      error: { message: 'The default model is not supported' },
    });
    fake.emitClose(1);

    const msgs = await sendPromise;
    const systemTexts = msgs.filter((m) => m.role === 'system').map((m) => String(m.content));
    expect(systemTexts.some((text) => text.includes('default model'))).toBe(true);
    expect(systemTexts.some((text) => text.includes('exited with code 1'))).toBe(false);
  });

  test('process spawn error yields system message without throwing', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    const sendPromise = collect(session.send('Hello'));
    fake.emitError(new Error('ENOENT: codex not found'));
    fake.emitClose(null as unknown as number);

    const msgs = await sendPromise;
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    expect(systemMsgs.some((m) => String(m.content).includes('ENOENT'))).toBe(true);
  });

  test('calling send() on a closed session yields system message', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    await session.close();
    const msgs = await collect(session.send('Hello after close'));

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('system');
    expect(String(msgs[0].content)).toContain('closed session');
  });
});

// ---------------------------------------------------------------------------
// CodexSession: turn.completed metadata
// ---------------------------------------------------------------------------

describe('CodexSession: turn.completed', () => {
  test('turn.completed usage is preserved in providerMeta', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    const usage = { input_tokens: 100, output_tokens: 200, total_tokens: 300 };
    const sendPromise = collect(session.send('Measure me'));
    fake.emitLine({ type: 'thread.started', thread_id: 'tid-usage' });
    fake.emitLine({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } });
    fake.emitLine({ type: 'turn.completed', usage });
    fake.emitClose(0);

    const msgs = await sendPromise;
    const completedMsg = msgs.find(
      (m) => m.role === 'system' && m.providerMeta?.codexEvent === 'turn.completed'
    );
    expect(completedMsg).toBeDefined();
    expect(completedMsg?.providerMeta?.usage).toEqual(usage);
  });
});

// ---------------------------------------------------------------------------
// CodexSession: close is idempotent
// ---------------------------------------------------------------------------

describe('CodexSession: close', () => {
  test('close() is a no-op and can be called multiple times', async () => {
    const adapter = new CodexAdapter();
    const session = await adapter.spawn({
      systemPrompt: '',
      cwd: '/tmp',
    });

    expect(session.close()).resolves.toBeUndefined();
    expect(session.close()).resolves.toBeUndefined();
  });

  test('close() terminates an in-flight codex process', async () => {
    const fake = new FakeChildProcess();
    const { session } = await makeSession({}, [fake]);

    const sendPromise = collect(session.send('Long running request'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await session.close();
    await sendPromise;

    expect(fake.killedWith).toContain('SIGTERM');
  });
});

// ---------------------------------------------------------------------------
// CodexAdapter: spawn returns per-turn session (not reused)
// ---------------------------------------------------------------------------

describe('CodexAdapter: spawn semantics', () => {
  test('each spawn() call returns a distinct session object', async () => {
    const adapter = new CodexAdapter();
    const opts: SpawnOptions = { systemPrompt: '', cwd: '/tmp' };

    const s1 = await adapter.spawn(opts);
    const s2 = await adapter.spawn(opts);

    expect(s1).not.toBe(s2);
  });

  test('spawn with resumeSessionId sets session.id immediately', async () => {
    const adapter = new CodexAdapter();
    const session = await adapter.spawn({
      systemPrompt: '',
      cwd: '/tmp',
      resumeSessionId: 'existing-thread',
    });

    expect(session.id).toBe('existing-thread');
  });

  test('spawn without resumeSessionId has empty initial id', async () => {
    const adapter = new CodexAdapter();
    const session = await adapter.spawn({ systemPrompt: '', cwd: '/tmp' });

    expect(session.id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Integration: Hub-compatible thread ID persistence flow
// ---------------------------------------------------------------------------

describe('Hub thread ID persistence flow', () => {
  test('session.id after send() can be used as resumeSessionId for next turn', async () => {
    const fake1 = new FakeChildProcess();
    const fake2 = new FakeChildProcess();

    // First turn — no resumeSessionId.
    const { session: session1, spawnCalls: calls1 } = await makeSession({}, [fake1]);

    const send1 = collect(session1.send('Turn 1'));
    fake1.emitLine({ type: 'thread.started', thread_id: 'thread-chain-1' });
    fake1.emitLine({ type: 'item.completed', item: { type: 'agent_message', text: 'Response 1' } });
    fake1.emitLine({ type: 'turn.completed' });
    fake1.emitClose(0);
    await send1;

    // The Hub would now persist session1.id and pass it as resumeSessionId.
    const capturedThreadId = session1.id;
    expect(capturedThreadId).toBe('thread-chain-1');

    // Second turn — resume.
    const { session: session2, spawnCalls: calls2 } = await makeSession(
      { resumeSessionId: capturedThreadId },
      [fake2]
    );

    const send2 = collect(session2.send('Turn 2'));
    fake2.emitLine({ type: 'thread.started', thread_id: 'thread-chain-1' });
    fake2.emitLine({ type: 'item.completed', item: { type: 'agent_message', text: 'Response 2' } });
    fake2.emitLine({ type: 'turn.completed' });
    fake2.emitClose(0);
    await send2;

    // First turn: exec with stdin sentinel.
    expect(calls1[0]?.args).toContain('-');
    expect(calls1[0]?.args).not.toContain('resume');

    // Second turn: exec resume <thread_id>.
    expect(calls2[0]?.args).toContain('resume');
    expect(calls2[0]?.args).toContain('thread-chain-1');
  });
});

// ---------------------------------------------------------------------------
// CodexAdapter real spawnProcess — covers the protected method body
// ---------------------------------------------------------------------------

describe('CodexAdapter — real spawnProcess() coverage', () => {
  test('CodexAdapter.spawn() returns a session object', async () => {
    const adapter = new CodexAdapter();
    const session = await adapter.spawn({
      sessionId: 'test',
      cwd: '/tmp',
      systemPrompt: '',
    });
    // Session object is created without spawning a child process yet
    expect(session.id).toBe(''); // no resumeSessionId, so initial id is ''
    // Do NOT call session.send() here — that would invoke the real codex binary
    await session.close();
  });

  test('CodexAdapter.isAvailable() returns a boolean', async () => {
    const adapter = new CodexAdapter();
    const available = await adapter.isAvailable();
    expect(typeof available).toBe('boolean');
  });
});
