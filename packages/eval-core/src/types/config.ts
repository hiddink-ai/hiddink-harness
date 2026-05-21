import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

export interface EvalCoreConfig {
  dbDriver: 'sqlite';
  sqlitePath: string;
  tokenEstimation: boolean;
}

function getProjectId(cwd: string): string {
  const normalizedPath = cwd.trim().replace(/\/$/, '');
  const hash = createHash('sha256')
    .update(normalizedPath)
    .digest('hex')
    .slice(0, 12);
  
  const folderName = basename(normalizedPath) || 'root';
  const safeFolderName = folderName.replace(/[^a-zA-Z0-9-_]/g, '_');
  
  return `${safeFolderName}-${hash}`;
}

export function getDefaultConfig(): EvalCoreConfig {
  const cwd = process.cwd();
  // 테스트 환경이거나 임시 경로인 경우 로컬 경로를 활용
  if (
    cwd.includes('/tmp/') ||
    cwd.includes('coverage/') ||
    process.env.NODE_ENV === 'test' ||
    process.env.BUN_ENV === 'test'
  ) {
    return {
      dbDriver: 'sqlite',
      sqlitePath: join(cwd, '.hiddink-harness', 'eval.db'),
      tokenEstimation: true,
    };
  }

  const projectId = getProjectId(cwd);
  return {
    dbDriver: 'sqlite',
    sqlitePath: join(homedir(), '.hiddink-harness', 'projects', projectId, 'memory.db'),
    tokenEstimation: true,
  };
}
