import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupSymlinks,
  ensureGlobalLayout,
  getGlobalStateDir,
  getProjectId,
  getProjectStateDir,
  mountSymlinks,
} from '../../src/core/global-state.js';

describe('Global State Architecture Tests', () => {
  const testCwd = join('/tmp', 'hiddink-harness-tui-test');

  beforeAll(() => {
    if (!existsSync(testCwd)) {
      const { mkdirSync } = require('node:fs');
      mkdirSync(testCwd, { recursive: true });
    }
  });

  afterAll(() => {
    if (existsSync(testCwd)) {
      rmSync(testCwd, { recursive: true, force: true });
    }
  });

  test('getProjectId should generate robust unique ID from path', () => {
    const id1 = getProjectId('/Users/sangyi/workspace/my-app');
    const id2 = getProjectId('/Users/sangyi/workspace/my-app/');
    const id3 = getProjectId('/Users/sangyi/workspace/other-app');

    expect(id1).toBe(id2); // Slash normalization check
    expect(id1).toContain('my-app');
    expect(id3).toContain('other-app');
    expect(id1).not.toBe(id3);
  });

  test('ensureGlobalLayout creates projects, sessions, memory subdirectories', () => {
    const projId = 'layout-test-id';
    ensureGlobalLayout(projId);

    const base = getGlobalStateDir();
    expect(existsSync(base)).toBe(true);
    expect(existsSync(join(base, 'sessions'))).toBe(true);
    expect(existsSync(join(base, 'memory'))).toBe(true);
    expect(existsSync(join(base, 'projects', projId, '.claude'))).toBe(true);
  });

  test('mountSymlinks and cleanupSymlinks mounts and destroys symlinks under CWD', () => {
    const mockProjId = 'symlink-test-id';
    ensureGlobalLayout(mockProjId);

    // Mount symlinks under testCwd
    mountSymlinks(mockProjId, testCwd);

    const claudeLink = join(testCwd, '.claude');
    const agyLink = join(testCwd, '.agy');

    expect(existsSync(claudeLink)).toBe(true);
    expect(lstatSync(claudeLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claudeLink)).toBe(join(getProjectStateDir(mockProjId), '.claude'));

    expect(existsSync(agyLink)).toBe(true);
    expect(lstatSync(agyLink).isSymbolicLink()).toBe(true);

    // Cleanup symlinks
    cleanupSymlinks(mockProjId, testCwd);

    expect(existsSync(claudeLink)).toBe(false);
    expect(existsSync(agyLink)).toBe(false);
  });
});
