/**
 * ChatPanel — [T] Talk 탭 대화 인터페이스.
 *
 * 사용자가 ConversationHub를 통해 claude/codex/kimi 중 하나에 메시지를 보내고
 * 스트리밍 응답을 실시간으로 확인할 수 있는 TUI 대화창.
 *
 * 키 바인딩:
 *   1/2/3/4  — provider 전환 (claude/codex/kimi/agy)
 *   Enter    — 메시지 전송
 *   ESC      — 입력 취소 (입력 중일 때)
 *   Tab      — 입력 모드 전환 (focus input)
 */

import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationHub } from '../../core/hub.js';
import type { NormalizedMessage, ProviderId } from '../../core/providers/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatPanelProps {
  hub: ConversationHub;
  cwd: string;
}

interface DisplayMessage extends NormalizedMessage {
  /** Internal display ID to avoid key collisions during streaming. */
  _displayId: string;
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

const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: '[1] Claude',
  codex: '[2] Codex',
  kimi: '[3] Kimi',
  agy: '[4] agy',
};

const ROLE_COLORS: Record<string, string> = {
  user: 'cyan',
  assistant: 'green',
  system: 'gray',
  tool: 'magenta',
};

const ROLE_PREFIX: Record<string, string> = {
  user: 'You',
  assistant: 'AI',
  system: 'SYS',
  tool: 'TOOL',
};

/** 화면에 표시할 최대 메시지 수 (터미널 높이 보호) */
const MAX_VISIBLE_MESSAGES = 8;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ChatPanel: React.FC<ChatPanelProps> = ({ hub, cwd: _cwd }) => {
  const [provider, setProvider] = useState<ProviderId>('claude');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [availableProviders, setAvailableProviders] = useState<ProviderId[]>([]);
  const [inputFocused, setInputFocused] = useState(true);
  const [statusLine, setStatusLine] = useState('준비. 메시지를 입력하고 Enter로 전송.');

  // streaming 중 abort를 위한 ref
  const abortRef = useRef<boolean>(false);
  // streaming 중에도 messages 최신값을 읽기 위한 ref
  const messagesRef = useRef<DisplayMessage[]>([]);

  // messages state와 ref 동기화
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ---------------------------------------------------------------------------
  // 마운트: 사용 가능한 provider 목록 조회
  // ---------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only effect — provider/setProvider/setStatusLine are stable refs, re-running on their changes would reset availability mid-session
  useEffect(() => {
    hub.listAvailable().then((list) => {
      setAvailableProviders(list);
      // 기본 provider가 사용 불가능하면 첫 번째 사용 가능한 것으로 교체
      if (list.length > 0 && !list.includes(provider)) {
        setProvider(list[0]);
      }
      if (list.length === 0) {
        setStatusLine('사용 가능한 provider 없음. binary를 설치하세요.');
      }
    });
  }, [hub]);

  // ---------------------------------------------------------------------------
  // 메시지 전송
  // ---------------------------------------------------------------------------
  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return;

      const trimmed = text.trim();
      setInput('');
      setStreaming(true);
      abortRef.current = false;
      setStatusLine(`⏵ streaming... (${provider})`);

      // 사용자 메시지 즉시 append
      const userMsg: DisplayMessage = {
        _displayId: `user-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        let assistantDisplayId: string | null = null;

        for await (const chunk of hub.sendTo(provider, trimmed)) {
          if (abortRef.current) break;

          const contentStr = typeof chunk.content === 'string' ? chunk.content : '';

          if (chunk.role === 'assistant') {
            if (assistantDisplayId === null) {
              // 첫 청크: 새 메시지 엔트리 생성
              assistantDisplayId = `assistant-${Date.now()}`;
              const newMsg: DisplayMessage = {
                _displayId: assistantDisplayId,
                role: 'assistant',
                content: contentStr,
                timestamp: chunk.timestamp,
                providerMeta: chunk.providerMeta,
              };
              setMessages((prev) => [...prev, newMsg]);
            } else {
              // 이후 청크: 마지막 assistant 메시지에 내용 append
              const id = assistantDisplayId;
              setMessages((prev) =>
                prev.map((m) =>
                  m._displayId === id ? { ...m, content: (m.content as string) + contentStr } : m
                )
              );
            }
          } else {
            // system / tool 메시지 — 별도 엔트리
            const sysMsg: DisplayMessage = {
              _displayId: `sys-${Date.now()}-${Math.random()}`,
              ...chunk,
            };
            setMessages((prev) => [...prev, sysMsg]);
          }
        }

        // 세션 자동 저장
        try {
          await hub.saveSession();
        } catch {
          // 저장 실패는 무시 (비차단)
        }

        setStatusLine('전송 완료. 메시지를 입력하고 Enter로 전송.');
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
      }
    },
    [hub, provider, streaming]
  );

  // ---------------------------------------------------------------------------
  // 키 입력 처리 (TextInput이 포커스를 가질 때는 useInput이 provider 전환만 처리)
  // ---------------------------------------------------------------------------
  useInput(
    (inputChar, key) => {
      // 입력 모드일 땐 숫자키만 provider 전환 (TextInput이 Enter 처리)
      if (inputFocused) {
        if (PROVIDER_KEYS[inputChar]) {
          const newProvider = PROVIDER_KEYS[inputChar];
          if (newProvider !== 'agy') {
            setProvider(newProvider);
            setStatusLine(`Provider 전환 → ${newProvider}`);
          }
        }
        if (key.escape) {
          // 입력 취소
          setInput('');
          setInputFocused(false);
        }
        return;
      }

      // 비입력 모드
      if (PROVIDER_KEYS[inputChar]) {
        const newProvider = PROVIDER_KEYS[inputChar];
        if (newProvider !== 'agy') {
          setProvider(newProvider);
          setStatusLine(`Provider 전환 → ${newProvider}`);
        }
      }
      if (key.tab || inputChar === 'i') {
        setInputFocused(true);
      }
    },
    { isActive: true }
  );

  // ---------------------------------------------------------------------------
  // 렌더 헬퍼
  // ---------------------------------------------------------------------------
  const visibleMessages = messages.slice(-MAX_VISIBLE_MESSAGES);

  const renderProviderBar = () => (
    <Box flexDirection="row" marginBottom={1}>
      {(Object.keys(PROVIDER_LABELS) as ProviderId[]).map((pid) => {
        const isAgy = pid === 'agy';
        const isActive = pid === provider;
        const isAvail = availableProviders.includes(pid);

        let color: string;
        if (isAgy) color = 'gray';
        else if (isActive) color = 'cyan';
        else if (isAvail) color = 'white';
        else color = 'gray';

        return (
          <Box key={pid} marginRight={1}>
            <Text
              color={color}
              bold={isActive}
              inverse={isActive}
              dimColor={isAgy || (!isAvail && !isAgy)}
            >
              {' '}
              {PROVIDER_LABELS[pid]}
              {isAgy ? '(disabled)' : !isAvail ? '(unavail)' : ''}{' '}
            </Text>
          </Box>
        );
      })}
    </Box>
  );

  const renderMessages = () => (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingLeft={1}
      paddingRight={1}
      height={12}
    >
      {visibleMessages.length === 0 ? (
        <Text color="gray" dimColor>
          대화를 시작해보세요. 메시지를 입력하고 Enter를 누르세요.
        </Text>
      ) : (
        visibleMessages.map((msg) => {
          const color = ROLE_COLORS[msg.role] ?? 'white';
          const prefix = ROLE_PREFIX[msg.role] ?? msg.role.toUpperCase();
          const contentStr =
            typeof msg.content === 'string'
              ? msg.content
              : msg.content.map((b) => b.text ?? '').join('');
          // 긴 메시지는 첫 3줄만 표시
          const lines = contentStr.split('\n').slice(0, 3);
          const display = lines.join(' ↵ ') + (contentStr.split('\n').length > 3 ? ' …' : '');

          return (
            <Box key={msg._displayId} flexDirection="row" marginBottom={0}>
              <Text color={color} bold>
                {prefix}:{' '}
              </Text>
              <Text color={color} wrap="truncate">
                {display}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );

  const renderInput = () => (
    <Box
      flexDirection="row"
      borderStyle="single"
      borderColor={inputFocused ? 'cyan' : 'gray'}
      paddingLeft={1}
      marginTop={1}
    >
      <Text color="cyan" bold>
        {'>'}
      </Text>
      <Text> </Text>
      {streaming ? (
        <Text color="gray" dimColor>
          전송 중... (ESC로 취소)
        </Text>
      ) : (
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(val) => {
            if (val.trim()) {
              sendMessage(val);
            }
          }}
          focus={inputFocused && !streaming}
          placeholder="메시지를 입력하세요..."
        />
      )}
    </Box>
  );

  const renderStreamingIndicator = () => {
    if (!streaming) return null;
    return (
      <Box marginTop={0}>
        <Text color="yellow">⏵ streaming... </Text>
        <Text color="gray">({provider}에 응답 요청 중)</Text>
      </Box>
    );
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <Box flexDirection="column">
      {/* Provider 선택 바 */}
      {renderProviderBar()}

      {/* 메시지 히스토리 */}
      {renderMessages()}

      {/* 입력창 */}
      {renderInput()}

      {/* 스트리밍 인디케이터 */}
      {renderStreamingIndicator()}

      {/* 상태 줄 */}
      <Box marginTop={1} justifyContent="space-between">
        <Text color="gray" dimColor>
          {statusLine}
        </Text>
        <Text color="gray" dimColor>
          [1-3]provider전환 [Tab/i]입력포커스 [ESC]취소
        </Text>
      </Box>
    </Box>
  );
};
