/**
 * ChatPanel — [T] Talk 탭 대화 인터페이스.
 *
 * 사용자가 ConversationHub를 통해 claude/codex/kimi 중 하나에 메시지를 보내고
 * 스트리밍 응답을 실시간으로 확인할 수 있는 TUI 대화창.
 *
 * 키 바인딩:
 *   /model 1|2|3|4    — 대상 모델 슬롯 선택 (claude/codex/kimi/agy)
 *   /model next|prev  — 현재 슬롯의 모델 이전/다음 전환
 *   Enter    — 메시지 전송
 *   ESC      — 입력 취소 (입력 중일 때)
 */

import { Box, Text, useInput, useStdin } from 'ink';
import TextInput from 'ink-text-input';
import type { FC, ReactNode } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationHub } from '../../core/hub.js';
import type { NormalizedMessage, ProviderId } from '../../core/providers/types.js';
import { devLog } from '../../utils/dev-log.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SlashCommand = 'exit' | 'help';

const SLASH_COMMANDS: SlashCommand[] = ['exit', 'help'];

interface ChatPanelProps {
  hub: ConversationHub;
  cwd: string;
  onCommand?: (cmd: SlashCommand) => void;
}

interface DisplayMessage extends NormalizedMessage {
  /** Internal display ID to avoid key collisions during streaming. */
  _displayId: string;
  /** Provider that produced this visible assistant message. */
  _provider?: ProviderId;
  /** Model label to show next to the provider. */
  _model?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_KEYS: Record<string, ProviderId> = {
  '1': 'claude',
  '2': 'codex',
  '3': 'kimi',
  '4': 'agy',
};

const SHIFTED_PROVIDER_KEYS: Record<string, keyof typeof PROVIDER_KEYS> = {
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
};

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: '[1] Claude',
  codex: '[2] Codex',
  kimi: '[3] Kimi',
  agy: '[4] agy',
};

const PROVIDER_COMMAND_ALIASES: Record<string, ProviderId> = {
  '1': 'claude',
  claude: 'claude',
  anthropic: 'claude',
  '2': 'codex',
  codex: 'codex',
  gpt: 'codex',
  openai: 'codex',
  '3': 'kimi',
  kimi: 'kimi',
  moonshot: 'kimi',
  '4': 'agy',
  agy: 'agy',
  antigravity: 'agy',
  gemini: 'agy',
};

const MODEL_NEXT_COMMANDS = new Set(['next', 'n', '+', 'right', '다음']);
const MODEL_PREV_COMMANDS = new Set(['prev', 'previous', 'p', '-', 'left', '이전']);
const MODEL_COMMANDS = new Set(['model', 'models', 'm']);
const BROADCAST_COMMANDS = new Set(['all', 'everyone', 'broadcast', '모두']);
const ESC = String.fromCharCode(27);
const ESC_ENHANCED_SHORTCUT_RE = new RegExp(`${ESC}\\[[0-9;]+[u~]`, 'g');
const ESC_SHIFTED_SHORTCUT_RE = new RegExp(`${ESC}[1-4!@#$\\[\\]{}]`, 'g');

const ROLE_COLORS: Record<string, string> = {
  user: 'cyan',
  assistant: 'green',
  system: 'gray',
  tool: 'magenta',
};

const ROLE_PREFIX: Record<string, string> = {
  user: 'You',
  system: 'SYS',
  tool: 'TOOL',
};

export const DEFAULT_PROVIDER_MODELS: Record<ProviderId, string> = {
  claude: 'sonnet-4.7',
  codex: 'gpt-5.5',
  kimi: 'kimi-k2.5',
  agy: 'gemini-3.5-flash-high',
};

export const PROVIDER_MODEL_OPTIONS: Record<ProviderId, string[]> = {
  claude: ['sonnet-4.7', 'opus-4.7'],
  codex: ['gpt-5.5', 'gpt-5.3-codex-spark'],
  kimi: ['kimi-k2.5'],
  agy: ['gemini-3.5-flash-high'],
};

/** 화면에 표시할 최대 메시지 수 (터미널 높이 보호) */
const MAX_VISIBLE_MESSAGES = 10;

interface ProviderShortcutKey {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
}

type ModelDirection = -1 | 1;

export interface ParsedModelCommand {
  provider: ProviderId;
  /** null means the command only asks to show the current model for provider. */
  model: string | null;
}

interface ModelSlotHub {
  getProviderModel(provider: ProviderId): string | undefined;
  setProviderModel(provider: ProviderId, model: string | undefined): Promise<void>;
}

function keyForCodepoint(codepoint: number): keyof typeof PROVIDER_KEYS | null {
  const char = String.fromCodePoint(codepoint);
  const shifted = SHIFTED_PROVIDER_KEYS[char];
  if (shifted) return shifted;
  return char in PROVIDER_KEYS ? (char as keyof typeof PROVIDER_KEYS) : null;
}

function hasCommandLikeModifier(encodedModifier: number): boolean {
  const mask = encodedModifier - 1;
  const alt = 2;
  const ctrl = 4;
  const superKey = 8;
  const hyper = 16;
  const meta = 32;
  return (mask & (alt | ctrl | superKey | hyper | meta)) !== 0;
}

function hasShiftModifier(encodedModifier: number): boolean {
  const mask = encodedModifier - 1;
  return (mask & 1) !== 0;
}

function hasCommandLikeKey(key: ProviderShortcutKey): boolean {
  return Boolean(key.meta || key.ctrl || key.alt || key.option);
}

function providerFromEncodedShortcut(
  codepoint: number,
  encodedModifier: number
): ProviderId | null {
  const providerKey = keyForCodepoint(codepoint);
  if (!providerKey) return null;

  const char = String.fromCodePoint(codepoint);
  const shiftedCharacter = char in SHIFTED_PROVIDER_KEYS;
  const digitSlot = char in PROVIDER_KEYS;
  if (!hasCommandLikeModifier(encodedModifier)) return null;
  if (!hasShiftModifier(encodedModifier) && !shiftedCharacter && !digitSlot) return null;

  return PROVIDER_KEYS[providerKey] ?? null;
}

function modelDirectionForChar(char: string): ModelDirection | null {
  if (char === '[' || char === '{') return -1;
  if (char === ']' || char === '}') return 1;
  return null;
}

function modelDirectionFromEncodedShortcut(
  codepoint: number,
  encodedModifier: number
): ModelDirection | null {
  if (!hasCommandLikeModifier(encodedModifier)) return null;

  const char = String.fromCodePoint(codepoint);
  const direction = modelDirectionForChar(char);
  if (direction === null) return null;

  const shiftedCharacter = char === '{' || char === '}';
  if (!hasShiftModifier(encodedModifier) && !shiftedCharacter) return null;

  return direction;
}

export function providerFromEnhancedShortcut(input: string): ProviderId | null {
  const normalized = input.startsWith('\u001b') ? input.slice(1) : input;

  // Kitty/CSI-u style: ESC [ <codepoint> ; <modifier> u
  const csiUMatch = /^\[(\d+);(\d+)u$/.exec(normalized);
  if (csiUMatch) {
    return providerFromEncodedShortcut(Number(csiUMatch[1]), Number(csiUMatch[2]));
  }

  // xterm modifyOtherKeys style: ESC [ 27 ; <modifier> ; <codepoint> ~
  const modifyOtherKeysMatch = /^\[27;(\d+);(\d+)~$/.exec(normalized);
  if (modifyOtherKeysMatch) {
    return providerFromEncodedShortcut(
      Number(modifyOtherKeysMatch[2]),
      Number(modifyOtherKeysMatch[1])
    );
  }

  // Some terminals encode Meta/Cmd as a bare ESC prefix before the key. Treat
  // ESC+digit as a command-like slot shortcut too because several terminal
  // stacks drop the shift bit before Ink receives it.
  if (input.startsWith('\u001b') && normalized.length === 1) {
    const modifier = normalized in PROVIDER_KEYS ? 10 : 9;
    return providerFromEncodedShortcut(normalized.codePointAt(0) ?? 0, modifier);
  }

  return null;
}

export function modelDirectionFromEnhancedShortcut(input: string): ModelDirection | null {
  const normalized = input.startsWith('\u001b') ? input.slice(1) : input;

  const csiUMatch = /^\[(\d+);(\d+)u$/.exec(normalized);
  if (csiUMatch) {
    return modelDirectionFromEncodedShortcut(Number(csiUMatch[1]), Number(csiUMatch[2]));
  }

  const modifyOtherKeysMatch = /^\[27;(\d+);(\d+)~$/.exec(normalized);
  if (modifyOtherKeysMatch) {
    return modelDirectionFromEncodedShortcut(
      Number(modifyOtherKeysMatch[2]),
      Number(modifyOtherKeysMatch[1])
    );
  }

  if (input.startsWith('\u001b') && normalized.length === 1) {
    return modelDirectionFromEncodedShortcut(normalized.codePointAt(0) ?? 0, 9);
  }

  return null;
}

export function providerFromShortcut(
  inputChar: string,
  key: ProviderShortcutKey
): ProviderId | null {
  const enhancedProvider = providerFromEnhancedShortcut(inputChar);
  if (enhancedProvider) return enhancedProvider;

  if (!hasCommandLikeKey(key)) return null;

  const providerKey = SHIFTED_PROVIDER_KEYS[inputChar] ?? inputChar;
  const isShiftedDigit = inputChar in SHIFTED_PROVIDER_KEYS;
  const isDigitSlot = providerKey in PROVIDER_KEYS;
  if (!key.shift && !isShiftedDigit && !isDigitSlot) return null;

  return PROVIDER_KEYS[providerKey] ?? null;
}

export const modelSlotFromEnhancedShortcut = providerFromEnhancedShortcut;
export const modelSlotFromShortcut = providerFromShortcut;

export function modelDirectionFromShortcut(
  inputChar: string,
  key: ProviderShortcutKey
): ModelDirection | null {
  const enhancedDirection = modelDirectionFromEnhancedShortcut(inputChar);
  if (enhancedDirection !== null) return enhancedDirection;

  if (!hasCommandLikeKey(key)) return null;

  const direction = modelDirectionForChar(inputChar);
  if (direction === null) return null;

  const shiftedCharacter = inputChar === '{' || inputChar === '}';
  if (!key.shift && !shiftedCharacter) return null;

  return direction;
}

export function nextProviderModel(
  provider: ProviderId,
  currentModel: string,
  direction: ModelDirection
): string {
  const options = PROVIDER_MODEL_OPTIONS[provider];
  if (options.length === 0) return currentModel;

  const normalizedCurrent = currentModel.trim() || DEFAULT_PROVIDER_MODELS[provider];
  const currentIndex = options.indexOf(normalizedCurrent);
  if (currentIndex === -1) return options[0];

  const nextIndex = (currentIndex + direction + options.length) % options.length;
  return options[nextIndex];
}

function modelFromCommand(provider: ProviderId, currentModel: string, rawModel: string): string {
  const trimmed = rawModel.trim();
  const lowered = trimmed.toLowerCase();
  if (MODEL_NEXT_COMMANDS.has(lowered)) return nextProviderModel(provider, currentModel, 1);
  if (MODEL_PREV_COMMANDS.has(lowered)) return nextProviderModel(provider, currentModel, -1);
  return trimmed;
}

export function providerFromCommandToken(token: string): ProviderId | null {
  const normalized = token
    .trim()
    .toLowerCase()
    .replace(/^\[(\d)\]$/, '$1');
  return PROVIDER_COMMAND_ALIASES[normalized] ?? null;
}

function explicitProviderFromModelCommand(rawModel: string): ProviderId | null {
  const trimmed = rawModel.trim();
  const colonMatch = /^([^:\s]+):/.exec(trimmed);
  if (colonMatch) return providerFromCommandToken(colonMatch[1]);

  const [first = ''] = trimmed.split(/\s+/);
  return providerFromCommandToken(first);
}

export function parseModelCommand(
  rawModel: string,
  activeProvider: ProviderId,
  providerModels: Record<ProviderId, string> = DEFAULT_PROVIDER_MODELS
): ParsedModelCommand {
  const trimmed = rawModel.trim();
  if (!trimmed) return { provider: activeProvider, model: null };

  const colonMatch = /^([^:\s]+):(.+)$/.exec(trimmed);
  if (colonMatch) {
    const explicitProvider = providerFromCommandToken(colonMatch[1]);
    if (explicitProvider) {
      return {
        provider: explicitProvider,
        model: modelFromCommand(
          explicitProvider,
          providerModels[explicitProvider],
          colonMatch[2].trim()
        ),
      };
    }
  }

  const [first = '', ...rest] = trimmed.split(/\s+/);
  const explicitProvider = providerFromCommandToken(first);
  if (explicitProvider) {
    const modelText = rest.join(' ').trim();
    return {
      provider: explicitProvider,
      model: modelText
        ? modelFromCommand(explicitProvider, providerModels[explicitProvider], modelText)
        : null,
    };
  }

  return {
    provider: activeProvider,
    model: modelFromCommand(activeProvider, providerModels[activeProvider], trimmed),
  };
}

function formatModelStatus(
  activeProvider: ProviderId,
  providerModels: Record<ProviderId, string>
): string {
  return (Object.keys(DEFAULT_PROVIDER_MODELS) as ProviderId[])
    .map((pid) => `${pid === activeProvider ? '▶' : ' '} ${pid}:${providerModels[pid]}`)
    .join(' · ');
}

export async function syncSelectedModelSlot(
  hub: ModelSlotHub,
  selectedProvider: ProviderId,
  providerModels: Record<ProviderId, string>
): Promise<boolean> {
  const selectedModel = providerModels[selectedProvider];
  if (hub.getProviderModel(selectedProvider) === selectedModel) return false;
  await hub.setProviderModel(selectedProvider, selectedModel);
  return true;
}

export function stripShortcutSequences(text: string): string {
  return text
    .replace(ESC_ENHANCED_SHORTCUT_RE, '')
    .replace(ESC_SHIFTED_SHORTCUT_RE, '')
    .replace(/\[\d+;\d+u/g, '')
    .replace(/\[27;\d+;\d+~/g, '');
}

function contentToText(content: NormalizedMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (block.type === 'text' || block.type === 'thinking') return block.text ?? '';
      if (block.type === 'tool_use') return `[tool:${block.toolName ?? 'unknown'}]`;
      if (block.type === 'tool_result') return '[tool result]';
      return '';
    })
    .join('');
}

export function isDisplayableMessage(
  message: Pick<NormalizedMessage, 'role' | 'content'>
): boolean {
  return message.role !== 'system' || contentToText(message.content).trim().length > 0;
}

function modelLabel(
  provider: ProviderId,
  meta?: Record<string, unknown>,
  providerModels: Record<ProviderId, string> = DEFAULT_PROVIDER_MODELS
): string {
  const model = meta?.model ?? meta?.modelName ?? meta?.model_name;
  return typeof model === 'string' && model.trim().length > 0
    ? model.trim()
    : providerModels[provider];
}

export function displayPrefix(msg: Pick<DisplayMessage, 'role' | '_provider' | '_model'>): string {
  if (msg.role === 'assistant') {
    const provider = msg._provider ?? 'unknown';
    const model =
      msg._model ?? (msg._provider ? DEFAULT_PROVIDER_MODELS[msg._provider] : 'unknown');
    return `[${provider}:${model}]`;
  }
  return ROLE_PREFIX[msg.role] ?? msg.role.toUpperCase();
}

// ---------------------------------------------------------------------------
// MessageLine — memoized single-message renderer to prevent re-render of
// already-rendered messages while the user is typing or streaming.
// ---------------------------------------------------------------------------

const MessageLine = memo<{ msg: DisplayMessage }>(({ msg }) => {
  const color = ROLE_COLORS[msg.role] ?? 'white';
  const prefix = displayPrefix(msg);
  const contentStr = contentToText(msg.content);
  const lines = contentStr.length > 0 ? contentStr.split('\n') : [''];
  const seenLines = new Map<string, number>();

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={color} bold>
        {prefix}:
      </Text>
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line) => {
          const count = (seenLines.get(line) ?? 0) + 1;
          seenLines.set(line, count);
          return (
            <Text key={`${msg._displayId}-${count}-${line}`} color={color} wrap="wrap">
              {line.length > 0 ? line : ' '}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
});
MessageLine.displayName = 'MessageLine';

// ---------------------------------------------------------------------------
// ProviderBar — memoized so provider list doesn't re-render on every keystroke
// ---------------------------------------------------------------------------

const ProviderBar = memo<{
  provider: ProviderId;
  availableProviders: ProviderId[];
  providerModels: Record<ProviderId, string>;
}>(({ provider, availableProviders, providerModels }) => (
  <Box flexDirection="row" marginBottom={1}>
    {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((pid) => {
      const isActive = pid === provider;
      const isAvail = availableProviders.includes(pid);
      let color: string;
      if (isActive) color = 'cyan';
      else if (isAvail) color = 'white';
      else color = 'gray';
      return (
        <Box key={pid} marginRight={1}>
          <Text color={color} bold={isActive} inverse={isActive} dimColor={!isAvail}>
            {' '}
            {PROVIDER_LABELS[pid]}:{providerModels[pid]}
            {!isAvail ? '(unavail)' : ''}{' '}
          </Text>
        </Box>
      );
    })}
  </Box>
));
ProviderBar.displayName = 'ProviderBar';

// ---------------------------------------------------------------------------
// Footer — status + input guidance kept below the prompt
// ---------------------------------------------------------------------------

const Footer = memo<{
  inputLine: ReactNode;
  statusLine: string;
}>(({ inputLine, statusLine }) => (
  <Box borderColor="cyan" borderStyle="single" flexDirection="column" marginTop={1} paddingX={1}>
    {inputLine}
    <Text color="yellow" bold>
      {statusLine}
    </Text>
    <Text color="white">
      메시지 또는 슬래시 명령(/help, /exit, /all 메시지, /model 1|2|3|4, /model next|prev) · Enter
      전송 · ESC 입력 취소
    </Text>
    <Text color="cyan">
      모델 지정: /model codex · /model codex gpt-5.5 · /model 2 next · /model agy
    </Text>
  </Box>
));
Footer.displayName = 'Footer';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChatPanel: FC<ChatPanelProps> = ({ hub, cwd: _cwd, onCommand }) => {
  const { stdin } = useStdin();
  const [provider, setProvider] = useState<ProviderId>('codex');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [streamingTargets, setStreamingTargets] = useState<ProviderId[]>([]);
  const [availableProviders, setAvailableProviders] = useState<ProviderId[]>([]);
  const [providerModels, setProviderModels] =
    useState<Record<ProviderId, string>>(DEFAULT_PROVIDER_MODELS);
  const [inputFocused, setInputFocused] = useState(true);
  const [statusLine, setStatusLine] = useState('준비. 메시지를 입력하고 Enter로 전송.');

  // streaming 중 abort를 위한 ref
  const abortRef = useRef<boolean>(false);
  // streaming 중에도 messages 최신값을 읽기 위한 ref
  const messagesRef = useRef<DisplayMessage[]>([]);
  const providerModelsRef = useRef<Record<ProviderId, string>>(DEFAULT_PROVIDER_MODELS);
  const modelChangeRef = useRef<Promise<void>>(Promise.resolve());

  // messages state와 ref 동기화
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    providerModelsRef.current = providerModels;
  }, [providerModels]);

  // ---------------------------------------------------------------------------
  // 마운트: 사용 가능한 provider 목록 조회
  // ---------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect — provider/setProvider/setStatusLine are stable refs, re-running on their changes would reset availability mid-session
  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    const MAX_ATTEMPTS = 8; // 8 × 250ms = 2s 최대 대기
    const INTERVAL_MS = 250;

    const poll = async () => {
      while (!cancelled && attempt < MAX_ATTEMPTS) {
        attempt++;
        try {
          const list = await hub.listAvailable();
          if (list.length > 0) {
            if (!cancelled) {
              setAvailableProviders(list);
              if (!list.includes(provider)) {
                setProvider(list.includes('codex') ? 'codex' : list[0]);
              }
              setStatusLine(`준비. ${list.length}개 provider 사용 가능.`);
            }
            return;
          }
        } catch {
          // 무시하고 재시도
        }
        await new Promise<void>((r) => setTimeout(r, INTERVAL_MS));
      }
      if (!cancelled) {
        setStatusLine('사용 가능한 provider 없음. binary를 설치하세요.');
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [hub]);

  // ---------------------------------------------------------------------------
  // 메시지 전송
  // ---------------------------------------------------------------------------
  const sendMessage = useCallback(
    async (text: string, targetProviders: ProviderId[] = [provider]) => {
      if (!text.trim() || streaming) return;

      await modelChangeRef.current.catch(() => {});

      const trimmed = text.trim();
      const providers = Array.from(new Set(targetProviders)).filter((pid) =>
        availableProviders.includes(pid)
      );
      const effectiveProviders = providers.length > 0 ? providers : [provider];
      const modelSnapshot = providerModelsRef.current;

      setInput('');
      setStreaming(true);
      setStreamingTargets(effectiveProviders);
      abortRef.current = false;
      setStatusLine(`⏵ streaming... (${effectiveProviders.join(', ')}) · ESC 취소`);

      // 사용자 메시지 즉시 append
      const userMsg: DisplayMessage = {
        _displayId: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        await Promise.all(
          effectiveProviders.map(async (targetProvider) => {
            let assistantDisplayId: string | null = null;

            try {
              for await (const chunk of hub.sendTo(targetProvider, trimmed)) {
                if (abortRef.current) break;

                const contentStr = contentToText(chunk.content);

                if (chunk.role === 'assistant') {
                  if (assistantDisplayId === null) {
                    // 첫 청크: 새 메시지 엔트리 생성
                    assistantDisplayId = `assistant-${targetProvider}-${Date.now()}-${Math.random()}`;
                    const newMsg: DisplayMessage = {
                      _displayId: assistantDisplayId,
                      role: 'assistant',
                      content: contentStr,
                      timestamp: chunk.timestamp,
                      providerMeta: chunk.providerMeta,
                      _provider: targetProvider,
                      _model: modelLabel(targetProvider, chunk.providerMeta, modelSnapshot),
                    };
                    setMessages((prev) => [...prev, newMsg]);
                  } else {
                    // 이후 청크: 같은 provider/model 메시지에 내용 append
                    const id = assistantDisplayId;
                    setMessages((prev) =>
                      prev.map((m) =>
                        m._displayId === id
                          ? { ...m, content: (m.content as string) + contentStr }
                          : m
                      )
                    );
                  }
                } else {
                  if (!isDisplayableMessage(chunk)) continue;
                  // system / tool 메시지 — 별도 엔트리
                  const sysMsg: DisplayMessage = {
                    _displayId: `sys-${targetProvider}-${Date.now()}-${Math.random()}`,
                    ...chunk,
                  };
                  setMessages((prev) => [...prev, sysMsg]);
                }
              }
            } catch (err: unknown) {
              if (abortRef.current) return;
              const errText = err instanceof Error ? err.message : String(err);
              const errMsg: DisplayMessage = {
                _displayId: `err-${targetProvider}-${Date.now()}`,
                role: 'system',
                content: `[${targetProvider} 오류] ${errText}`,
                timestamp: new Date().toISOString(),
              };
              setMessages((prev) => [...prev, errMsg]);
            }
          })
        );

        // 세션 자동 저장
        try {
          await hub.saveSession();
        } catch {
          // 저장 실패는 무시 (비차단)
        }

        if (abortRef.current) {
          setStatusLine('취소됨. 메시지를 입력하고 Enter로 전송.');
        } else {
          setStatusLine(
            effectiveProviders.length > 1
              ? `멀티 모델 전송 완료 → ${effectiveProviders.join(', ')}`
              : '전송 완료. 메시지를 입력하고 Enter로 전송.'
          );
        }
      } catch (err: unknown) {
        const errText = err instanceof Error ? err.message : String(err);
        const errMsg: DisplayMessage = {
          _displayId: `err-${Date.now()}`,
          role: 'system',
          content: `[오류] ${errText}`,
          timestamp: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, errMsg]);
        setStatusLine('오류 발생. 다시 시도해보세요.');
      } finally {
        setStreaming(false);
        setStreamingTargets([]);
      }
    },
    [availableProviders, hub, provider, streaming]
  );

  const switchProvider = useCallback(
    (newProvider: ProviderId) => {
      const selectedModel = providerModelsRef.current[newProvider];
      devLog('ui.provider.select', { provider: newProvider, model: selectedModel });
      setProvider(newProvider);
      setStatusLine(`대상 모델 선택 → ${newProvider}:${selectedModel}`);

      const op = syncSelectedModelSlot(hub, newProvider, providerModelsRef.current).then(
        () => undefined
      );
      modelChangeRef.current = op;
      op.catch((err: unknown) => {
        const errText = err instanceof Error ? err.message : String(err);
        setStatusLine(`대상 모델 적용 실패 → ${newProvider}:${selectedModel} (${errText})`);
      });
    },
    [hub]
  );

  const changeModel = useCallback(
    async (rawModel: string) => {
      if (streaming) {
        setStatusLine(
          '응답 중에는 모델 변경을 보류하세요. 현재 응답 완료 후 다시 변경 가능합니다.'
        );
        return;
      }

      const currentModels = providerModelsRef.current;
      const parsed = parseModelCommand(rawModel, provider, currentModels);
      const explicitProvider = explicitProviderFromModelCommand(rawModel);
      if (!parsed.model) {
        if (explicitProvider) {
          devLog('ui.model.select_provider', {
            provider: parsed.provider,
            model: currentModels[parsed.provider],
          });
          setProvider(parsed.provider);
          const op = syncSelectedModelSlot(hub, parsed.provider, currentModels).then(
            () => undefined
          );
          modelChangeRef.current = op;
          op.catch((err: unknown) => {
            const errText = err instanceof Error ? err.message : String(err);
            setStatusLine(
              `대상 모델 적용 실패 → ${parsed.provider}:${currentModels[parsed.provider]} (${errText})`
            );
          });
          setStatusLine(
            `대상 모델 선택 → ${parsed.provider}:${currentModels[parsed.provider]} · ${formatModelStatus(parsed.provider, currentModels)}`
          );
          return;
        }
        setStatusLine(
          `모델 선택: /model 1|2|3|4 또는 /model <provider> <model|next|prev> · ${formatModelStatus(parsed.provider, currentModels)}`
        );
        return;
      }

      const nextModel = parsed.model;
      const targetProvider = parsed.provider;
      const nextModels = { ...currentModels, [targetProvider]: nextModel };
      providerModelsRef.current = nextModels;
      setProviderModels(nextModels);
      if (explicitProvider) setProvider(targetProvider);
      devLog('ui.model.change', { provider: targetProvider, model: nextModel });
      setStatusLine(`모델 변경 중 → ${targetProvider}:${nextModel}`);

      const op = hub.setProviderModel(targetProvider, nextModel);
      modelChangeRef.current = op;
      try {
        await op;
        const agyNote =
          targetProvider === 'agy'
            ? ' (agy CLI에는 모델 플래그가 없어 하네스 라벨/옵션에 적용)'
            : '';
        setStatusLine(`모델 변경 적용 → ${targetProvider}:${nextModel}${agyNote}`);
      } catch (err: unknown) {
        const errText = err instanceof Error ? err.message : String(err);
        providerModelsRef.current = currentModels;
        setProviderModels(currentModels);
        setStatusLine(`모델 변경 실패 → ${targetProvider}:${nextModel} (${errText})`);
      }
    },
    [hub, provider, streaming]
  );

  const switchModel = useCallback(
    (direction: ModelDirection) => {
      const currentModels = providerModelsRef.current;
      const nextModel = nextProviderModel(provider, currentModels[provider], direction);
      void changeModel(`${provider} ${nextModel}`);
    },
    [changeModel, provider]
  );

  useEffect(() => {
    const handleRawInput = (data: Buffer | string) => {
      const rawInput = String(data);
      const shortcutProvider = modelSlotFromEnhancedShortcut(rawInput);
      if (shortcutProvider) switchProvider(shortcutProvider);
      const modelDirection = modelDirectionFromEnhancedShortcut(rawInput);
      if (modelDirection !== null) switchModel(modelDirection);
    };

    stdin.on('data', handleRawInput);
    return () => {
      stdin.off('data', handleRawInput);
    };
  }, [stdin, switchModel, switchProvider]);

  // ---------------------------------------------------------------------------
  // 키 입력 처리
  // ---------------------------------------------------------------------------
  useInput(
    (inputChar, key) => {
      const shortcutProvider = modelSlotFromShortcut(inputChar, key);
      if (shortcutProvider) {
        switchProvider(shortcutProvider);
        return;
      }

      const modelDirection = modelDirectionFromShortcut(inputChar, key);
      if (modelDirection !== null) {
        switchModel(modelDirection);
        return;
      }

      if (key.escape) {
        if (streaming) {
          abortRef.current = true;
          const targets = streamingTargets.length > 0 ? streamingTargets : [provider];
          setStatusLine(`취소 중... (${targets.join(', ')})`);
          void hub
            .cancelProviders(targets)
            .then(() => {
              setStreaming(false);
              setStreamingTargets([]);
              setStatusLine('취소됨. 메시지를 입력하고 Enter로 전송.');
            })
            .catch((err: unknown) => {
              const errText = err instanceof Error ? err.message : String(err);
              setStatusLine(`취소 실패: ${errText}`);
            });
          return;
        }
        setInput('');
        setInputFocused(true);
      }
    },
    { isActive: true }
  );

  // ---------------------------------------------------------------------------
  // 렌더 헬퍼
  // ---------------------------------------------------------------------------
  const visibleMessages = messages.slice(-MAX_VISIBLE_MESSAGES);

  const renderMessages = () => {
    if (visibleMessages.length === 0) {
      return (
        <Box flexDirection="column" flexGrow={1}>
          <Text color="white">대화를 시작해보세요. 메시지를 입력하고 Enter를 누르세요.</Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" flexGrow={1}>
        {visibleMessages.map((msg) => (
          <MessageLine key={msg._displayId} msg={msg} />
        ))}
      </Box>
    );
  };

  const renderInput = () => (
    <Box flexDirection="row" paddingLeft={0}>
      <Text color="cyan" bold>
        {'>'}
      </Text>
      <Text> </Text>
      {streaming ? (
        <Text color="yellow">전송 중... (ESC로 취소)</Text>
      ) : (
        <TextInput
          value={input}
          onChange={(nextInput) => setInput(stripShortcutSequences(nextInput))}
          onSubmit={(val) => {
            const trimmed = val.trim();
            if (!trimmed) return;
            if (trimmed.startsWith('/')) {
              const [cmd = '', ...args] = trimmed.slice(1).split(/\s+/);
              const command = cmd.toLowerCase();
              setInput('');
              if (MODEL_COMMANDS.has(command)) {
                void changeModel(args.join(' '));
              } else if (BROADCAST_COMMANDS.has(command)) {
                const broadcastText = args.join(' ').trim();
                if (!broadcastText) {
                  setStatusLine('/all 뒤에 보낼 메시지를 입력하세요.');
                } else {
                  void sendMessage(broadcastText, availableProviders);
                }
              } else if ((SLASH_COMMANDS as string[]).includes(command)) {
                if (command === 'help') {
                  setStatusLine(
                    '명령어: /exit · /all <message> · /model <provider|1-4> <model|next|prev> · 예: /model codex gpt-5.5'
                  );
                } else {
                  onCommand?.(command as SlashCommand);
                }
              } else {
                setStatusLine(`알 수 없는 명령: ${trimmed}. /help로 도움말 확인`);
              }
              return;
            }
            sendMessage(trimmed);
          }}
          focus={inputFocused && !streaming}
          placeholder=""
        />
      )}
    </Box>
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Provider 선택 바 */}
      <ProviderBar
        provider={provider}
        availableProviders={availableProviders}
        providerModels={providerModels}
      />

      {/* 메시지 히스토리 */}
      {renderMessages()}

      {/* 하위 footer: 입력창 + 상태 + 안내 */}
      <Footer inputLine={renderInput()} statusLine={statusLine} />
    </Box>
  );
};
