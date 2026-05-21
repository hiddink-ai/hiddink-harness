import { createHash } from 'node:crypto';
import {
  cpSync,
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
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * sessions/, memory/는 projects/{id}/ 하위에 위치하며 전역 레벨에는 생성하지 않습니다.
 * state/는 active-process tracking 용도로 전역 레벨에 유지합니다.
 */
export function ensureGlobalLayout(projectId: string): void {
  const globalDir = getGlobalStateDir();
  const subDirs = [
    globalDir,
    join(globalDir, 'state'),
    join(globalDir, 'projects'),
    join(globalDir, 'projects', projectId),
    join(globalDir, 'projects', projectId, 'sessions'),
    join(globalDir, 'projects', projectId, 'memory'),
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

  // 세션 인덱스 파일은 projects/{id}/sessions/ 하위에 위치
  const sessionIndex = join(globalDir, 'projects', projectId, 'sessions', 'index.json');
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

/**
 * 패키지 번들에 포함된 templates/ 디렉터리의 절대 경로를 반환합니다.
 * import.meta.url 기반으로 해석되어 src 기준과 dist 기준 모두에서 동작합니다.
 */
export function getPackageTemplatesDir(): string {
  // src/core/global-state.ts → dist/core/global-state.js 기준
  // templates는 패키지 루트에 위치: dist/core → ../../templates
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'templates');
}

export interface SeedResult {
  seeded: boolean;
  reason: string;
}

/**
 * 패키지 templates/ 트리를 프로젝트 SSOT에 시드합니다.
 * SSOT가 비어 있거나 패키지 버전이 다를 경우에만 복사합니다.
 * 멱등성 보장 — CLI 진입 시마다 안전하게 호출 가능합니다.
 */
export function seedTemplatesIfNeeded(projectId: string): SeedResult {
  const projectDir = getProjectStateDir(projectId);
  const stampPath = join(projectDir, '.seed-version');
  const templatesDir = getPackageTemplatesDir();

  if (!existsSync(templatesDir)) {
    return { seeded: false, reason: 'package templates dir missing' };
  }

  // 패키지 버전 읽기 (best-effort)
  let packageVersion = '0.0.0';
  try {
    const pkgPath = join(templatesDir, '..', 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      packageVersion = pkg.version ?? '0.0.0';
    }
  } catch {
    // 무시
  }

  const currentStamp = existsSync(stampPath) ? readFileSync(stampPath, 'utf-8').trim() : '';
  if (currentStamp === packageVersion) {
    return { seeded: false, reason: 'up to date' };
  }

  // 공통 컴포넌트 목록
  const commonComponents = ['agents', 'skills', 'rules', 'hooks', 'contexts', 'ontology'] as const;
  // Claude 전용 컴포넌트 목록
  const claudeOnlyComponents = ['output-styles', 'profiles', 'schemas', 'config'] as const;

  const providers: Array<{ root: string; includeClaudeSpecific: boolean }> = [
    { root: '.claude', includeClaudeSpecific: true },
    { root: '.agy', includeClaudeSpecific: false },
    { root: '.omx', includeClaudeSpecific: false },
    { root: '.kimi', includeClaudeSpecific: false },
  ];

  for (const provider of providers) {
    const providerDir = join(projectDir, provider.root);

    for (const comp of commonComponents) {
      const src = join(templatesDir, comp);
      const dest = join(providerDir, comp);
      if (existsSync(src)) {
        cpSync(src, dest, { recursive: true });
      }
    }

    if (provider.includeClaudeSpecific) {
      for (const comp of claudeOnlyComponents) {
        const src = join(templatesDir, 'claude-specific', comp);
        const dest = join(providerDir, comp);
        if (existsSync(src)) {
          cpSync(src, dest, { recursive: true });
        }
      }
    }
  }

  // guides는 프로젝트 루트에 (provider-neutral)
  const guidesSrc = join(templatesDir, 'guides');
  if (existsSync(guidesSrc)) {
    cpSync(guidesSrc, join(projectDir, 'guides'), { recursive: true });
  }

  writeFileSync(stampPath, packageVersion, 'utf-8');
  return { seeded: true, reason: `seeded version ${packageVersion}` };
}
