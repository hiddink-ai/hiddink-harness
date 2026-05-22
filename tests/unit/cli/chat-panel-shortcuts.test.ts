import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PROVIDER_MODELS,
  displayPrefix,
  isDisplayableMessage,
  modelDirectionFromEnhancedShortcut,
  modelDirectionFromShortcut,
  modelSlotFromEnhancedShortcut,
  modelSlotFromShortcut,
  nextProviderModel,
  parseModelCommand,
  providerFromCommandToken,
  providerFromEnhancedShortcut,
  providerFromShortcut,
  stripShortcutSequences,
  syncSelectedModelSlot,
} from '../../../src/cli/ui/ChatPanel.js';

describe('ChatPanel provider shortcuts', () => {
  test('maps Cmd/Meta+Shift+number model-slot shortcuts', () => {
    expect(modelSlotFromShortcut('1', { meta: true, shift: true })).toBe('claude');
    expect(modelSlotFromShortcut('2', { meta: true, shift: true })).toBe('codex');
    expect(modelSlotFromShortcut('3', { meta: true, shift: true })).toBe('kimi');
    expect(modelSlotFromShortcut('4', { meta: true, shift: true })).toBe('agy');
  });

  test('maps command-like number shortcuts even when terminals drop the shift flag', () => {
    expect(modelSlotFromShortcut('1', { meta: true })).toBe('claude');
    expect(modelSlotFromShortcut('2', { ctrl: true })).toBe('codex');
    expect(modelSlotFromShortcut('3', { alt: true })).toBe('kimi');
    expect(modelSlotFromShortcut('4', { option: true })).toBe('agy');
  });

  test('maps shifted number symbols when terminals send the shifted character', () => {
    expect(providerFromShortcut('!', { meta: true })).toBe('claude');
    expect(providerFromShortcut('@', { meta: true })).toBe('codex');
    expect(providerFromShortcut('#', { meta: true })).toBe('kimi');
    expect(providerFromShortcut('$', { meta: true })).toBe('agy');
  });

  test('maps enhanced keyboard Cmd/Super+Shift+number sequences', () => {
    expect(modelSlotFromEnhancedShortcut('\u001b[49;10u')).toBe('claude');
    expect(modelSlotFromEnhancedShortcut('[50;10u')).toBe('codex');
    expect(modelSlotFromEnhancedShortcut('\u001b[51;10u')).toBe('kimi');
    expect(modelSlotFromEnhancedShortcut('\u001b[52;10u')).toBe('agy');
  });

  test('maps Ctrl/Hyper/Meta encoded Shift+number variants used by terminals', () => {
    expect(modelSlotFromEnhancedShortcut('\u001b[49;6u')).toBe('claude');
    expect(modelSlotFromEnhancedShortcut('\u001b[50;18u')).toBe('codex');
    expect(modelSlotFromEnhancedShortcut('\u001b[51;34u')).toBe('kimi');
    expect(modelSlotFromEnhancedShortcut('\u001b[52;42u')).toBe('agy');
  });

  test('maps enhanced keyboard Cmd/Super shifted symbols', () => {
    expect(providerFromEnhancedShortcut('\u001b[33;9u')).toBe('claude');
    expect(providerFromEnhancedShortcut('\u001b[64;9u')).toBe('codex');
    expect(providerFromEnhancedShortcut('\u001b[35;9u')).toBe('kimi');
    expect(providerFromEnhancedShortcut('\u001b[36;9u')).toBe('agy');
  });

  test('maps bare ESC-prefixed Meta shifted symbols', () => {
    expect(providerFromEnhancedShortcut('\u001b!')).toBe('claude');
    expect(providerFromEnhancedShortcut('\u001b@')).toBe('codex');
    expect(providerFromEnhancedShortcut('\u001b#')).toBe('kimi');
    expect(providerFromEnhancedShortcut('\u001b$')).toBe('agy');
  });

  test('maps bare ESC-prefixed Meta number slots', () => {
    expect(modelSlotFromEnhancedShortcut('\u001b1')).toBe('claude');
    expect(modelSlotFromEnhancedShortcut('\u001b2')).toBe('codex');
    expect(modelSlotFromEnhancedShortcut('\u001b3')).toBe('kimi');
    expect(modelSlotFromEnhancedShortcut('\u001b4')).toBe('agy');
  });

  test('strips enhanced shortcut sequences if TextInput receives them', () => {
    expect(stripShortcutSequences('hello[49;10u world')).toBe('hello world');
    expect(stripShortcutSequences('hello[27;10;49~ world')).toBe('hello world');
    expect(stripShortcutSequences(`hello\u001b1 world`)).toBe('hello world');
    expect(stripShortcutSequences(`hello\u001b@ world`)).toBe('hello world');
  });

  test('does not steal normal number input while typing', () => {
    expect(providerFromShortcut('1', { meta: false, shift: false })).toBeNull();
    expect(providerFromShortcut('2', { meta: false, shift: true })).toBeNull();
    expect(providerFromShortcut('x', { meta: true, shift: true })).toBeNull();
  });
});

describe('ChatPanel model shortcuts', () => {
  test('maps Cmd/Meta+Shift+bracket model shortcuts', () => {
    expect(modelDirectionFromShortcut('[', { meta: true, shift: true })).toBe(-1);
    expect(modelDirectionFromShortcut(']', { meta: true, shift: true })).toBe(1);
  });

  test('maps shifted bracket symbols when terminals send the shifted character', () => {
    expect(modelDirectionFromShortcut('{', { meta: true })).toBe(-1);
    expect(modelDirectionFromShortcut('}', { meta: true })).toBe(1);
  });

  test('maps enhanced keyboard model shortcut sequences', () => {
    expect(modelDirectionFromEnhancedShortcut('\u001b[91;10u')).toBe(-1);
    expect(modelDirectionFromEnhancedShortcut('\u001b[93;10u')).toBe(1);
    expect(modelDirectionFromEnhancedShortcut('\u001b[123;9u')).toBe(-1);
    expect(modelDirectionFromEnhancedShortcut('\u001b[125;9u')).toBe(1);
  });

  test('cycles provider model options', () => {
    expect(nextProviderModel('codex', 'gpt-5.5', 1)).toBe('gpt-5.3-codex-spark');
    expect(nextProviderModel('codex', 'gpt-5.3-codex-spark', 1)).toBe('gpt-5.5');
    expect(nextProviderModel('claude', 'sonnet-4.7', -1)).toBe('opus-4.7');
  });

  test('parses explicit provider model commands', () => {
    expect(providerFromCommandToken('2')).toBe('codex');
    expect(providerFromCommandToken('codex')).toBe('codex');
    expect(providerFromCommandToken('[4]')).toBe('agy');

    expect(parseModelCommand('codex gpt-5.5', 'claude')).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
    });
    expect(parseModelCommand('2 gpt-5.3-codex-spark', 'claude')).toEqual({
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
    });
    expect(parseModelCommand('codex:gpt-5.5', 'claude')).toEqual({
      provider: 'codex',
      model: 'gpt-5.5',
    });
  });

  test('parses next/prev model commands against the selected provider', () => {
    expect(parseModelCommand('2 next', 'claude')).toEqual({
      provider: 'codex',
      model: 'gpt-5.3-codex-spark',
    });
    expect(parseModelCommand('prev', 'claude')).toEqual({
      provider: 'claude',
      model: 'opus-4.7',
    });
    expect(parseModelCommand('agy', 'codex')).toEqual({ provider: 'agy', model: null });
  });

  test('syncs selected Cmd+Shift model slot into the Hub model override', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const hub = {
      getProviderModel: () => undefined,
      setProviderModel: async (provider: string, model: string | undefined) => {
        calls.push([provider, model]);
      },
    };

    const changed = await syncSelectedModelSlot(hub, 'codex', DEFAULT_PROVIDER_MODELS);

    expect(changed).toBe(true);
    expect(calls).toEqual([['codex', 'gpt-5.5']]);
  });

  test('does not reset a model slot when the Hub already uses that model', async () => {
    const calls: Array<[string, string | undefined]> = [];
    const hub = {
      getProviderModel: () => 'gpt-5.5',
      setProviderModel: async (provider: string, model: string | undefined) => {
        calls.push([provider, model]);
      },
    };

    const changed = await syncSelectedModelSlot(hub, 'codex', DEFAULT_PROVIDER_MODELS);

    expect(changed).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('ChatPanel message prefixes', () => {
  test('renders assistant labels as provider:model instead of AI', () => {
    expect(displayPrefix({ role: 'assistant', _provider: 'codex', _model: 'gpt-5.5' })).toBe(
      '[codex:gpt-5.5]'
    );
  });

  test('falls back to explicit provider model labels instead of default', () => {
    expect(DEFAULT_PROVIDER_MODELS.codex).toBe('gpt-5.5');
    expect(displayPrefix({ role: 'assistant', _provider: 'codex' })).toBe('[codex:gpt-5.5]');
  });
});

describe('ChatPanel visible message filtering', () => {
  test('hides empty system lifecycle messages', () => {
    expect(isDisplayableMessage({ role: 'system', content: '' })).toBe(false);
    expect(isDisplayableMessage({ role: 'system', content: '   ' })).toBe(false);
  });

  test('keeps system messages with actionable content', () => {
    expect(isDisplayableMessage({ role: 'system', content: '[오류] Codex process exited' })).toBe(
      true
    );
  });

  // --- content-block array cases ---

  test('hides system message with content-block array containing only an empty text block', () => {
    expect(isDisplayableMessage({ role: 'system', content: [{ type: 'text', text: '' }] })).toBe(
      false
    );
  });

  test('hides system message with content-block array containing only a whitespace text block', () => {
    expect(isDisplayableMessage({ role: 'system', content: [{ type: 'text', text: '   ' }] })).toBe(
      false
    );
  });

  test('keeps system message with content-block array containing real error text', () => {
    expect(
      isDisplayableMessage({ role: 'system', content: [{ type: 'text', text: 'real error' }] })
    ).toBe(true);
  });

  test('keeps assistant message with empty content array (assistant is always displayable)', () => {
    // isDisplayableMessage only suppresses role==='system' with blank content;
    // assistant messages are always shown regardless of content shape.
    expect(isDisplayableMessage({ role: 'assistant', content: [] })).toBe(true);
  });

  test('keeps system message with a tool_use content block (non-text actionable block counts)', () => {
    // contentToText maps tool_use → '[tool:bash]' which is non-empty after trim
    expect(
      isDisplayableMessage({
        role: 'system',
        content: [{ type: 'tool_use', toolName: 'bash' }],
      })
    ).toBe(true);
  });
});

describe('ChatPanel stripShortcutSequences — robustness against mixed/repeated sequences', () => {
  const ESC = String.fromCharCode(27);

  test('strips two consecutive enhanced CSI sequences in one input', () => {
    // '[49;10u' and '[50;10u' are adjacent — both must be removed, leaving 'abc'
    expect(stripShortcutSequences(`a${ESC}[49;10ub${ESC}[50;10uc`)).toBe('abc');
  });

  test('strips mixed Meta-number and Meta-symbol sequences in one input', () => {
    // ESC+'1' (Meta-number, stripped by ESC_SHIFTED_SHORTCUT_RE) and ESC+'!' (Meta-symbol, same RE)
    expect(stripShortcutSequences(`pre${ESC}1mid${ESC}!post`)).toBe('premidpost');
  });

  test('strips CSI 27-variant sequence (literal bracket without ESC prefix)', () => {
    // '[27;10;49~' matches the literal \[\d+;\d+;\d+~ replacement pass
    expect(stripShortcutSequences('[27;10;49~clean')).toBe('clean');
  });

  test('leaves plain text unchanged when no escape sequences are present', () => {
    expect(stripShortcutSequences('safe-text')).toBe('safe-text');
  });
});
