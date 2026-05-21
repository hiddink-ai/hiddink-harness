import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { debug, warn } from '../utils/logger.js';

/**
 * Hiddink 전역 홈 디렉토리 경로를 리턴합니다.
 */
export function getGlobalStateDir(): string {
  return join(homedir(), '.hiddink-harness');
}

/**
 * CWD 경로를 기반으로 고유하고 안전한 Project ID를 생성합니다.
 * 예: "/Users/sangyi/workspace/my-app" => "my_app-8f9a2b3c4d5e"
 */
export function getProjectId(cwd: string = process.cwd()): string {
  const normalizedPath = cwd.trim().replace(/\/$/, '');
  const hash = createHash('sha256').update(normalizedPath).digest('hex').slice(0, 12);

  const folderName = basename(normalizedPath) || 'root';
  // OS 파일 시스템에서 안전하게 쓸 수 있도록 특수 문자 치환
  const safeFolderName = folderName.replace(/[^a-zA-Z0-9-_]/g, '_');

  return `${safeFolderName}-${hash}`;
}

/**
 * 지정된 Project ID에 매핑되는 격리 데이터 디렉토리 경로를 리턴합니다.
 */
export function getProjectStateDir(projectId: string): string {
  return join(getGlobalStateDir(), 'projects', projectId);
}

/**
 * ~/.hiddink-harness의 전역 레이아웃 및 특정 프로젝트 격리 레이아웃을 확실히 생성합니다.
 */
export function ensureGlobalLayout(projectId: string): void {
  const globalDir = getGlobalStateDir();
  const subDirs = [
    globalDir,
    join(globalDir, 'sessions'),
    join(globalDir, 'state'),
    join(globalDir, 'memory'),
    join(globalDir, 'projects'),
    join(globalDir, 'projects', projectId),
    join(globalDir, 'projects', projectId, '.claude'),
    join(globalDir, 'projects', projectId, '.agy'),
    join(globalDir, 'projects', projectId, '.omx'),
    join(globalDir, 'projects', projectId, '.kimi'),
  ];

  for (const dir of subDirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      debug('global_state.dir_created', { path: dir });
    }
  }

  // 통합 세션 인덱스 파일 보장
  const sessionIndex = join(globalDir, 'sessions', 'index.json');
  if (!existsSync(sessionIndex)) {
    writeFileSync(sessionIndex, JSON.stringify([], null, 2), 'utf-8');
  }
}

/**
 * CWD 디렉토리에 전역 격리 공간을 향하는 임시 심볼릭 링크를 마운트(생성)합니다.
 */
export function mountSymlinks(projectId: string, cwd: string = process.cwd()): void {
  const projectDir = getProjectStateDir(projectId);
  const targets = [
    { name: '.claude', target: join(projectDir, '.claude') },
    { name: '.agy', target: join(projectDir, '.agy') },
    { name: '.omx', target: join(projectDir, '.omx') },
    { name: '.kimi', target: join(projectDir, '.kimi') },
  ];

  for (const { name, target } of targets) {
    const linkPath = join(cwd, name);

    // 1. 이미 실물 디렉토리가 존재하는 경우 백업하거나 경고
    if (existsSync(linkPath)) {
      // 심볼릭 링크가 아닌 실물 디렉토리일 경우 우선 스킵하거나 경고합니다.
      const isSymlink = isLink(linkPath);
      if (!isSymlink) {
        warn('global_state.local_directory_exists', {
          path: linkPath,
          message: '로컬 폴더가 이미 존재하여 임시 심볼릭 링크 마운트를 스킵합니다.',
        });
        continue;
      }

      // 이미 같은 타겟을 바라보는 심볼릭 링크인 경우 패스, 다를 경우 교체
      try {
        const currentTarget = readLink(linkPath);
        if (currentTarget === target) {
          continue;
        }
        // 다른 곳을 바라보는 링크라면 철거 후 재구축
        unlinkSync(linkPath);
      } catch {
        unlinkSync(linkPath);
      }
    }

    // 2. 심볼릭 링크 생성
    try {
      symlinkSync(target, linkPath, 'dir');
      debug('global_state.symlink_mounted', { link: linkPath, target });
    } catch (err) {
      warn('global_state.symlink_failed', { link: linkPath, target, error: String(err) });
    }
  }

  // 활성 마운트 세션 등록
  registerActiveProcess(projectId, cwd);
}

/**
 * CWD 디렉토리에 마운트했던 임시 심볼릭 링크들을 깔끔하게 철거(삭제)합니다.
 */
export function cleanupSymlinks(projectId: string, cwd: string = process.cwd()): void {
  const names = ['.claude', '.agy', '.omx', '.kimi'];

  for (const name of names) {
    const linkPath = join(cwd, name);
    if (existsSync(linkPath) && isLink(linkPath)) {
      try {
        unlinkSync(linkPath);
        debug('global_state.symlink_cleaned', { link: linkPath });
      } catch (err) {
        warn('global_state.cleanup_failed', { link: linkPath, error: String(err) });
      }
    }
  }

  // 활성 마운트 세션 해제
  deregisterActiveProcess(projectId);
}

/**
 * 안전한 프로세스 수명 주기 클린업 훅을 가동시킵니다.
 */
let isCleanupRegistered = false;
export function registerCleanupHandlers(projectId: string, cwd: string = process.cwd()): void {
  if (isCleanupRegistered) return;
  isCleanupRegistered = true;

  const runCleanup = () => {
    try {
      cleanupSymlinks(projectId, cwd);
    } catch {
      // exit 상태에서는 표준 출력 로깅이 무시될 수 있음
    }
  };

  // 1. 정상 종료 및 예외 상황 훅
  process.on('exit', runCleanup);

  // 2. 프로세스 종료 시그널 캐치
  process.on('SIGINT', () => {
    runCleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    runCleanup();
    process.exit(0);
  });

  // 3. 처리되지 않은 에러 발생 시에도 클린업 수행
  process.on('uncaughtException', (err) => {
    runCleanup();
    console.error('Uncaught Exception occurred, cleaned up symlinks:', err);
    process.exit(1);
  });
}

/**
 * 심볼릭 링크 판단 헬퍼
 */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 링크 읽기 헬퍼
 */
function readLink(path: string): string {
  return readlinkSync(path);
}

/**
 * ~/.hiddink-harness/state/active-process.json 에 현재 작동 중인 CWD 상태를 캐싱합니다.
 */
function registerActiveProcess(projectId: string, cwd: string): void {
  const stateFile = join(getGlobalStateDir(), 'state', 'active-process.json');
  const record = {
    projectId,
    cwd,
    pid: process.pid,
    activeAt: new Date().toISOString(),
  };
  try {
    writeFileSync(stateFile, JSON.stringify(record, null, 2), 'utf-8');
  } catch {
    // 무시
  }
}

/**
 * active-process.json 캐시를 제거합니다.
 */
function deregisterActiveProcess(projectId: string): void {
  const stateFile = join(getGlobalStateDir(), 'state', 'active-process.json');
  if (existsSync(stateFile)) {
    try {
      const current = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (current.projectId === projectId && current.pid === process.pid) {
        unlinkSync(stateFile);
      }
    } catch {
      // 무시
    }
  }
}
