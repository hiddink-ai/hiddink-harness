import {
  generateAndWriteLockfileForDir,
  getLockfilePath,
  runtimeLockfileStorage,
} from '../src/core/lockfile.js';

const cwd = process.cwd();
const storage = { storage: runtimeLockfileStorage(cwd) };
const result = await generateAndWriteLockfileForDir(cwd, storage);

if (result.warning) {
  console.error(`sync-source-lockfile: ${result.warning}`);
  process.exit(1);
}

console.log(
  `sync-source-lockfile: wrote ${getLockfilePath(cwd, storage)} (${result.fileCount} files)`
);
