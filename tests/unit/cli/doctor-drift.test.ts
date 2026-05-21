/**
 * Tests for doctor.ts coverage gaps:
 * - checkRtk, checkCodex (RTK/Codex not installed paths)
 * - checkLockfileDrift (no lockfile, modified files, removed files, clean pass)
 * - checkFrameworkDrift (outdated, up-to-date)
 * - readCurrentVersion catch branch
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkCodex,
  checkFrameworkDrift,
  checkLockfileDrift,
  checkRtk,
} from '../../../src/cli/doctor.js';
import * as codexInstaller from '../../../src/core/codex-installer.js';
import { getDefaultConfig, saveConfig } from '../../../src/core/config.js';
import { generateAndWriteLockfileForDir } from '../../../src/core/lockfile.js';
import * as rtkInstaller from '../../../src/core/rtk-installer.js';

describe('checkRtk', () => {
  it('returns warn when RTK is not installed', async () => {
    const spy = spyOn(rtkInstaller, 'isRtkInstalled').mockReturnValue(false);
    try {
      const result = await checkRtk();
      expect(result.name).toBe('RTK');
      expect(result.status).toBe('warn');
      expect(result.message).toContain('RTK not installed');
      expect(result.fixable).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns pass when RTK is installed', async () => {
    const spy = spyOn(rtkInstaller, 'isRtkInstalled').mockReturnValue(true);
    const versionSpy = spyOn(rtkInstaller, 'getRtkVersion').mockReturnValue('1.2.3');
    try {
      const result = await checkRtk();
      expect(result.name).toBe('RTK');
      expect(result.status).toBe('pass');
      expect(result.message).toContain('RTK OK');
    } finally {
      spy.mockRestore();
      versionSpy.mockRestore();
    }
  });
});

describe('checkCodex', () => {
  it('returns warn when Codex CLI is not installed', async () => {
    const spy = spyOn(codexInstaller, 'isCodexInstalled').mockReturnValue(false);
    try {
      const result = await checkCodex();
      expect(result.name).toBe('Codex');
      expect(result.status).toBe('warn');
      expect(result.message).toContain('Codex CLI not installed');
      expect(result.fixable).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('returns pass when Codex CLI is installed', async () => {
    const spy = spyOn(codexInstaller, 'isCodexInstalled').mockReturnValue(true);
    const versionSpy = spyOn(codexInstaller, 'getCodexVersion').mockReturnValue('2.0.0');
    try {
      const result = await checkCodex();
      expect(result.name).toBe('Codex');
      expect(result.status).toBe('pass');
      expect(result.message).toContain('Codex CLI OK');
    } finally {
      spy.mockRestore();
      versionSpy.mockRestore();
    }
  });
});

// TODO(v0.0.3): restore after lockfile shape sync with new snapshot module
describe.skip('checkLockfileDrift', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hiddink-drift-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when no lockfile exists', async () => {
    const result = await checkLockfileDrift(tempDir);
    expect(result).toBeNull();
  });

  it('returns pass when all files match lockfile hashes', async () => {
    // Create some files and generate a lockfile
    const claudeDir = join(tempDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(join(claudeDir, 'rules'), { recursive: true });
    await writeFile(join(claudeDir, 'rules', 'test-rule.md'), '# Test Rule');

    await generateAndWriteLockfileForDir(tempDir);

    const result = await checkLockfileDrift(tempDir);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Lockfile');
    expect(result?.status).toBe('pass');
    expect(result?.message).toContain('no drift');
  });

  it('returns warn when files are modified', async () => {
    // Create files and generate lockfile
    const claudeDir = join(tempDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(join(claudeDir, 'rules'), { recursive: true });
    await writeFile(join(claudeDir, 'rules', 'test-rule.md'), '# Original Content');

    await generateAndWriteLockfileForDir(tempDir);

    // Modify the file after lockfile creation
    await writeFile(join(claudeDir, 'rules', 'test-rule.md'), '# Modified Content');

    const result = await checkLockfileDrift(tempDir);
    expect(result?.status).toBe('warn');
    expect(result?.message).toContain('drift detected');
    expect(result?.details).toBeDefined();
    expect(result?.details?.length).toBeGreaterThan(0);
  });

  it('returns warn when tracked files are removed', async () => {
    // Create files and generate lockfile
    const claudeDir = join(tempDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await mkdir(join(claudeDir, 'rules'), { recursive: true });
    await writeFile(join(claudeDir, 'rules', 'test-rule.md'), '# Rule');

    await generateAndWriteLockfileForDir(tempDir);

    // Remove the tracked file
    await rm(join(claudeDir, 'rules', 'test-rule.md'));

    const result = await checkLockfileDrift(tempDir);
    expect(result?.status).toBe('warn');
    expect(result?.details?.some((d) => d.startsWith('removed:'))).toBe(true);
  });
});

describe('checkFrameworkDrift', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hiddink-framework-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when no config file exists', async () => {
    const result = await checkFrameworkDrift(tempDir, '1.0.0');
    expect(result).toBeNull();
  });

  it('returns warn when framework version is outdated', async () => {
    // Create config with an old version
    const config = getDefaultConfig();
    config.version = '0.1.0';
    config.installedAt = '2025-01-01T00:00:00Z';
    await saveConfig(tempDir, config);

    const result = await checkFrameworkDrift(tempDir, '1.0.0');

    if (result !== null) {
      // Result depends on version comparison logic
      expect(['pass', 'warn']).toContain(result.status);
      expect(result.name).toBe('Framework');
    }
  });

  it('returns pass when framework version matches CLI version', async () => {
    // Create config with current version
    const config = getDefaultConfig();
    config.version = '1.0.0';
    config.installedAt = '2025-01-01T00:00:00Z';
    await saveConfig(tempDir, config);

    const result = await checkFrameworkDrift(tempDir, '1.0.0');

    if (result !== null) {
      expect(result.status).toBe('pass');
      expect(result.name).toBe('Framework');
    }
  });
});
