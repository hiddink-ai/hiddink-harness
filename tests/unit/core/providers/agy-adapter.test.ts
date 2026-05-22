import { describe, expect, test } from 'bun:test';
import {
  AgyAdapter,
  buildAgyArgs,
  buildAgyPrompt,
  DEFAULT_AGY_MODEL_LABEL,
} from '../../../../src/core/providers/agy-adapter.js';

class TestableAgyAdapter extends AgyAdapter {
  fail = false;

  protected override async execVersion(): Promise<void> {
    if (this.fail) throw new Error('agy not found');
  }
}

describe('AgyAdapter prompt and command helpers', () => {
  test('buildAgyPrompt returns only the user message when system prompt is empty', () => {
    expect(buildAgyPrompt('', 'Hello')).toBe('Hello');
    expect(buildAgyPrompt('   ', 'Hello')).toBe('Hello');
  });

  test('buildAgyPrompt prefixes system context before user message', () => {
    const prompt = buildAgyPrompt('Be concise.', 'Hello');
    expect(prompt).toContain('[SYSTEM]');
    expect(prompt).toContain('Be concise.');
    expect(prompt).toContain('[USER]');
    expect(prompt).toContain('Hello');
    expect(prompt.indexOf('[SYSTEM]')).toBeLessThan(prompt.indexOf('[USER]'));
  });

  test('buildAgyArgs uses agy print mode flags', () => {
    const args = buildAgyArgs('Hello');
    expect(args).toEqual([
      '--print',
      '--dangerously-skip-permissions',
      '--print-timeout',
      '5m0s',
      'Hello',
    ]);
  });
});

describe('AgyAdapter availability and metadata', () => {
  test('id and lifecycle are correct', () => {
    const adapter = new AgyAdapter();
    expect(adapter.id).toBe('agy');
    expect(adapter.lifecycle).toBe('per-turn-resume');
    expect(DEFAULT_AGY_MODEL_LABEL).toBe('gemini-3.5-flash-high');
  });

  test('isAvailable returns true when agy --version succeeds', async () => {
    const adapter = new TestableAgyAdapter();
    await expect(adapter.isAvailable()).resolves.toBe(true);
  });

  test('isAvailable returns false when agy --version fails', async () => {
    const adapter = new TestableAgyAdapter();
    adapter.fail = true;
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  test('spawn returns an agy session with empty initial id', async () => {
    const adapter = new AgyAdapter();
    const session = await adapter.spawn({ systemPrompt: '', cwd: '/tmp' });
    expect(session.provider).toBe('agy');
    expect(session.id).toBe('');
    await session.close();
  });
});
