import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { getGlobalStateDir, getProjectId, getProjectStateDir } from '../../core/global-state.js';

interface DashboardProps {
  cwd: string;
}

interface SessionMeta {
  sessionId: string;
  projectId: string;
  projectPath: string;
  createdAt: string;
  updatedAt: string;
  lastMessageSnippet?: string;
}

interface LogEntry {
  id: string;
  text: string;
}

export const HiddinkTuiDashboard: React.FC<DashboardProps> = ({ cwd }) => {
  const [projectId] = useState(() => getProjectId(cwd));
  const [activeTab, setActiveTab] = useState<'sessions' | 'rag' | 'settings'>('sessions');
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeProviders, setActiveProviders] = useState<string[]>([]);
  const [language, setLanguage] = useState<string>('en');
  const [systemLogs, setSystemLogs] = useState<LogEntry[]>([]);

  // 시스템 로그 추가 헬퍼 (useCallback으로 메모이제이션)
  const addLog = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random()}`,
      text: `[${time}] ${msg}`,
    };
    setSystemLogs((prev) => [...prev.slice(-4), entry]);
  }, []);

  // 세션 데이터 수집 및 정합 (useCallback으로 메모이제이션)
  const syncSessions = useCallback(() => {
    try {
      const globalDir = getGlobalStateDir();
      const sessionsDir = join(globalDir, 'sessions');
      if (!existsSync(sessionsDir)) return;

      const files = readdirSync(sessionsDir).filter(
        (f) => f.startsWith('session-') && f.endsWith('.json')
      );
      const list: SessionMeta[] = [];

      for (const file of files) {
        try {
          const content = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'));
          // 해당 프로젝트의 세션만 필터링
          if (content.projectId === projectId) {
            const msgs = content.messages || [];
            const lastMsg = msgs[msgs.length - 1];
            list.push({
              sessionId: content.sessionId,
              projectId: content.projectId,
              projectPath: content.projectPath,
              createdAt: content.createdAt,
              updatedAt: content.updatedAt,
              lastMessageSnippet: lastMsg
                ? `${lastMsg.role}: ${lastMsg.content.slice(0, 35)}...`
                : 'No messages',
            });
          }
        } catch {
          // 파싱 에러 스킵
        }
      }

      // 최근 수정된 순으로 정렬
      list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setSessions(list);
    } catch {
      // 스킵
    }
  }, [projectId]);

  // 1. 단축키 입력 리스너
  useInput((input, key) => {
    const char = input.toLowerCase();
    if (char === 's') {
      setActiveTab('sessions');
      addLog('탭 전환: [Sessions]');
    } else if (char === 'r') {
      setActiveTab('rag');
      addLog('탭 전환: [RAG Knowledge]');
    } else if (char === 'c') {
      setActiveTab('settings');
      addLog('탭 전환: [Configuration]');
    } else if (key.escape || char === 'q') {
      // 탈출(q 또는 ESC) 시 프로세스를 정상 종료하여 클린업 루틴 작동을 트리거합니다.
      process.exit(0);
    }
  });

  // 2. 초기 렌더링 및 실시간 동기화
  useEffect(() => {
    addLog(`CWD 감지: ${cwd}`);
    addLog(`Project ID 할당: ${projectId}`);

    // 로컬 설정 파일 로딩
    try {
      const projectDir = getProjectStateDir(projectId);
      const rcPath = join(projectDir, '.hiddinkrc.json');
      if (existsSync(rcPath)) {
        const rc = JSON.parse(readFileSync(rcPath, 'utf-8'));
        setActiveProviders(rc.activeProviders || ['claude', 'agy']);
        setLanguage(rc.language || 'en');
        addLog('가상 프로젝트 설정(.hiddinkrc.json) 로드 완료.');
      } else {
        setActiveProviders(['claude', 'agy']);
        addLog('디폴트 프로젝트 설정 적용.');
      }
    } catch {
      addLog('설정 파일 로딩 실패, 디폴트 유지.');
    }

    // 1초 주기로 세션 및 상태 변화 동기화 (Polling)
    const updateInterval = setInterval(() => {
      syncSessions();
    }, 1000);

    syncSessions();

    return () => clearInterval(updateInterval);
  }, [projectId, cwd, addLog, syncSessions]);

  return (
    <Box flexDirection="column" borderStyle="double" borderColor="cyan" padding={1} width={80}>
      {/* 1. 헤더 */}
      <Box justifyContent="space-between" marginBottom={1}>
        <Text bold color="green">
          ⚽ Hiddink Universal Agent Harness (TUI)
        </Text>
        <Text color="gray">PID: {process.pid}</Text>
      </Box>
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color="brightWhite" dimColor>
          CWD: {cwd}
        </Text>
        <Text color="cyan" bold>
          ID: {projectId}
        </Text>
      </Box>

      {/* 2. 네비게이션 탭 */}
      <Box marginBottom={1} justifyContent="flex-start">
        <Box marginRight={2}>
          <Text inverse={activeTab === 'sessions'} color="yellow" bold={activeTab === 'sessions'}>
            {' [S] Active Sessions '}
          </Text>
        </Box>
        <Box marginRight={2}>
          <Text inverse={activeTab === 'rag'} color="magenta" bold={activeTab === 'rag'}>
            {' [R] RAG Knowledge '}
          </Text>
        </Box>
        <Box>
          <Text inverse={activeTab === 'settings'} color="blue" bold={activeTab === 'settings'}>
            {' [C] Configurations '}
          </Text>
        </Box>
      </Box>

      {/* 3. 메인 디스플레이 박스 */}
      <Box
        height={11}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingLeft={1}
        paddingRight={1}
      >
        {activeTab === 'sessions' && (
          <Box flexDirection="column">
            <Text bold color="yellow" marginBottom={1}>
              📝 실시간 활성 대화 스레드 ({sessions.length}개)
            </Text>
            {sessions.length === 0 ? (
              <Text color="gray">
                활성화된 대화 세션이 없습니다. 에이전트를 구동해 대화를 시작해 보세요!
              </Text>
            ) : (
              sessions.slice(0, 4).map((s, idx) => (
                <Box
                  key={s.sessionId}
                  flexDirection="row"
                  justifyContent="space-between"
                  marginBottom={0}
                >
                  <Text color="cyan">
                    {idx + 1}. {s.sessionId.slice(-13)}
                  </Text>
                  <Text color="white" wrap="truncate">
                    {' '}
                    {s.lastMessageSnippet}{' '}
                  </Text>
                  <Text color="gray">({new Date(s.updatedAt).toLocaleTimeString()})</Text>
                </Box>
              ))
            )}
          </Box>
        )}

        {activeTab === 'rag' && (
          <Box flexDirection="column">
            <Text bold color="magenta" marginBottom={1}>
              🧠 로컬 RAG 지식 & 피드백 저장소
            </Text>
            <Text color="brightWhite">
              데이터베이스 경로: ~/.hiddink-harness/projects/{projectId}/memory.db
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text color="gray">• Ontology Concepts: 0 registered</Text>
              <Text color="gray">• Error auto-recovery logs: active</Text>
              <Text color="gray">• Evaluation feedbacks collected: 0 feedbacks</Text>
            </Box>
          </Box>
        )}

        {activeTab === 'settings' && (
          <Box flexDirection="column">
            <Text bold color="blue" marginBottom={1}>
              🔧 Hiddink 가상 프로젝트 설정 (.hiddinkrc.json)
            </Text>
            <Text>
              • 기본 언어:{' '}
              <Text color="yellow" bold>
                {language.toUpperCase()}
              </Text>
            </Text>
            <Text>
              • 활성 에이전트 서비스: <Text color="green">{activeProviders.join(', ')}</Text>
            </Text>
            <Text color="gray" marginTop={1}>
              * 가상 폴더는 ~/.hiddink-harness/projects/ 에 격리되어 있습니다.
            </Text>
          </Box>
        )}
      </Box>

      {/* 4. 시스템 로그 창 */}
      <Box marginTop={1} flexDirection="column">
        <Text bold color="gray">
          System Activities:
        </Text>
        {systemLogs.length === 0 ? (
          <Text color="gray">대기 중...</Text>
        ) : (
          systemLogs.map((log) => (
            <Text key={log.id} color="gray">
              {log.text}
            </Text>
          ))
        )}
      </Box>

      {/* 5. 하단 안내 바 */}
      <Box marginTop={1} justifyContent="space-between" borderStyle="single" borderColor="green">
        <Text color="gray">단축키: [S]세션 [R]지식 [C]설정</Text>
        <Text color="brightRed" bold>
          종료 및 흔적 지우기: [Q] 또는 [ESC]
        </Text>
      </Box>
    </Box>
  );
};
