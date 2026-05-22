import { execFile } from 'node:child_process';
import { Box, Text, useStdout } from 'ink';
import type { FC, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { ConversationHub } from '../../core/hub.js';
import { ChatPanel, DEFAULT_PROVIDER_MODELS } from './ChatPanel.js';

interface DashboardProps {
  cwd: string;
}

interface TerminalSize {
  columns: number;
  rows: number;
}

const GIT_GRAPH_MIN_COLUMNS = 100;
const GIT_REFRESH_MS = 10_000;

interface GitGraphRow {
  id: string;
  graph: string;
  text: string;
}

interface GitPanelData {
  status: string;
  rows: GitGraphRow[];
}

export function inkSafeRows(rows: number): number {
  // Ink falls back to ansiEscapes.clearTerminal when rendered output height is
  // >= stdout.rows. Any height-aware side panels should stay below that line.
  return Math.max(1, rows - 1);
}

export function shouldShowGitGraph(size: TerminalSize): boolean {
  return size.columns >= GIT_GRAPH_MIN_COLUMNS;
}

export function gitGraphWidth(columns: number): number {
  return Math.min(48, Math.max(32, Math.floor(columns * 0.35)));
}

function execGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: 200_000, timeout: 1500 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

export function graphGlyphs(graphText: string): string {
  return graphText
    .replace(/\*/g, '●')
    .replace(/\|/g, '│')
    .replace(/\//g, '╱')
    .replace(/\\/g, '╲')
    .replace(/_/g, '─')
    .replace(/-/g, '─');
}

export function parseGitGraphLine(line: string): GitGraphRow {
  const commitMatch = /^([*|\\/ _.-]*)([a-f0-9]{7,}\b.*)$/.exec(line);
  if (commitMatch) {
    const graph = graphGlyphs(commitMatch[1].trimEnd());
    return {
      id: `${graph}-${commitMatch[2]}`,
      graph,
      text: commitMatch[2],
    };
  }

  const graphOnly = graphGlyphs(line.trimEnd());
  return {
    id: graphOnly,
    graph: graphOnly,
    text: '',
  };
}

export async function readGitPanelData(cwd: string, maxRows: number): Promise<GitPanelData | null> {
  try {
    const inside = await execGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.trim() !== 'true') return null;

    const logLimit = Math.max(1, maxRows);
    const [branchStdout, statusStdout, logStdout] = await Promise.all([
      execGit(cwd, ['branch', '--show-current']),
      execGit(cwd, ['status', '--short']),
      execGit(cwd, [
        '--no-pager',
        'log',
        '--graph',
        '--decorate',
        '--oneline',
        '--all',
        '--date-order',
        '-n',
        String(logLimit),
      ]),
    ]);

    const branch = branchStdout.trim() || 'detached';
    const changeCount = statusStdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length;
    const status = ` ${branch}${changeCount > 0 ? ` · ${changeCount} changes` : ' · clean'}`;
    const rows = logStdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map(parseGitGraphLine);

    return { status, rows: rows.slice(0, maxRows) };
  } catch {
    return null;
  }
}

export async function readGitPanelLines(cwd: string, maxLines: number): Promise<string[] | null> {
  const panel = await readGitPanelData(cwd, Math.max(1, maxLines - 1));
  if (!panel) return null;
  return [panel.status, ...panel.rows.map((row) => `${row.graph} ${row.text}`.trimEnd())].slice(
    0,
    maxLines
  );
}

// ---------------------------------------------------------------------------
// FullScreenContainer — alternate screen buffer + terminal dimensions
// ---------------------------------------------------------------------------

const FullScreenContainer: FC<{ children: (size: TerminalSize) => ReactNode }> = ({ children }) => {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => ({
    columns: stdout.columns ?? 80,
    rows: inkSafeRows(stdout.rows ?? 24),
  }));

  useEffect(() => {
    const handleResize = () => {
      setSize({
        columns: stdout.columns ?? 80,
        rows: inkSafeRows(stdout.rows ?? 24),
      });
    };
    stdout.on('resize', handleResize);

    let fullscreenExited = false;
    const exitFullscreen = () => {
      if (fullscreenExited) return;
      fullscreenExited = true;
      try {
        stdout.write('\x1b[?1049l');
      } catch {
        // stdout already closed — ignore
      }
    };

    process.once('exit', exitFullscreen);
    process.once('SIGINT', () => {
      exitFullscreen();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      exitFullscreen();
      process.exit(0);
    });

    return () => {
      stdout.off('resize', handleResize);
      exitFullscreen();
    };
  }, [stdout]);

  return (
    <Box width={size.columns} height={size.rows} flexDirection="column">
      {children(size)}
    </Box>
  );
};

const GitGraphPanel: FC<{ cwd: string; width: number; maxLines: number }> = ({
  cwd,
  width,
  maxLines,
}) => {
  const [panel, setPanel] = useState<GitPanelData | null>(null);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const nextPanel = await readGitPanelData(cwd, maxLines);
      if (!cancelled) setPanel(nextPanel);
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, GIT_REFRESH_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [cwd, maxLines]);

  if (!panel) return null;

  const maxGraphWidth = Math.max(2, ...panel.rows.map((row) => Math.max(1, row.graph.length)));
  const seenRows = new Map<string, number>();

  return (
    <Box borderColor="gray" borderStyle="round" flexDirection="column" paddingX={1} width={width}>
      <Text color="yellow" bold>
        Git graph
      </Text>
      <Text color="cyan" wrap="truncate">
        {panel.status}
      </Text>
      {panel.rows.map((row) => {
        const count = (seenRows.get(row.id) ?? 0) + 1;
        seenRows.set(row.id, count);
        return (
          <Text key={`${row.id}-${count}`} wrap="truncate">
            <Text color="green" bold>
              {row.graph.padEnd(maxGraphWidth)}
            </Text>
            <Text color="gray"> {row.text}</Text>
          </Text>
        );
      })}
    </Box>
  );
};

export const HiddinkTuiDashboard: FC<DashboardProps> = ({ cwd }) => {
  const [hub] = useState(
    () =>
      new ConversationHub({
        sessionId: `tui-${Date.now()}`,
        cwd,
        initialModels: DEFAULT_PROVIDER_MODELS,
      })
  );

  useEffect(() => {
    import('../../core/providers/claude-adapter.js')
      .then((m) => hub.registerAdapter(new m.ClaudeAdapter()))
      .catch(() => {});
    import('../../core/providers/codex-adapter.js')
      .then((m) => hub.registerAdapter(new m.CodexAdapter()))
      .catch(() => {});
    import('../../core/providers/agy-adapter.js')
      .then((m) => hub.registerAdapter(new m.AgyAdapter()))
      .catch(() => {});
    (
      import('../../core/providers/kimi-adapter.js') as Promise<{
        KimiAdapter: new () => Parameters<typeof hub.registerAdapter>[0];
      }>
    )
      .then((m) => hub.registerAdapter(new m.KimiAdapter()))
      .catch(() => {});

    return () => {
      hub.close().catch(() => {});
    };
  }, [hub]);

  return (
    <FullScreenContainer>
      {(size) => {
        const showGraph = shouldShowGitGraph(size);
        const graphWidth = gitGraphWidth(size.columns);

        return (
          <Box flexDirection="row" padding={1} flexGrow={1}>
            <Box flexDirection="column" flexGrow={1} marginRight={showGraph ? 1 : 0}>
              <ChatPanel
                hub={hub}
                cwd={cwd}
                onCommand={(cmd) => cmd === 'exit' && process.exit(0)}
              />
            </Box>
            {showGraph && (
              <GitGraphPanel
                cwd={cwd}
                maxLines={Math.min(12, Math.max(4, size.rows - 4))}
                width={graphWidth}
              />
            )}
          </Box>
        );
      }}
    </FullScreenContainer>
  );
};
