import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', '..', '..', 'scripts', 'bump-version.ts');

function runIn(cwd: string, ...args: string[]) {
  return spawnSync('bun', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, BUN_QUIET: '1', BUMP_VERSION_ROOT: cwd },
  });
}

function seed(cwd: string, pkgVersion: string, manifestVersion: string) {
  writeFileSync(
    join(cwd, 'package.json'),
    `${JSON.stringify({ name: 't', version: pkgVersion }, null, 2)}\n`
  );
  mkdirSync(join(cwd, 'templates'), { recursive: true });
  writeFileSync(
    join(cwd, 'templates', 'manifest.json'),
    `${JSON.stringify({ version: manifestVersion }, null, 2)}\n`
  );
}

function readBoth(cwd: string) {
  return {
    pkg: JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')).version,
    manifest: JSON.parse(readFileSync(join(cwd, 'templates', 'manifest.json'), 'utf-8')).version,
  };
}

describe('scripts/bump-version.ts — atomic version sync', () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'bump-version-'));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('writes both package.json and templates/manifest.json to the exact semver argument', () => {
    seed(work, '0.0.2', '0.0.2');
    const r = runIn(work, '1.2.3');
    expect(r.status).toBe(0);
    const v = readBoth(work);
    expect(v.pkg).toBe('1.2.3');
    expect(v.manifest).toBe('1.2.3');
  });

  it('bumps patch when "patch" is passed', () => {
    seed(work, '0.0.2', '0.0.2');
    const r = runIn(work, 'patch');
    expect(r.status).toBe(0);
    expect(readBoth(work)).toEqual({ pkg: '0.0.3', manifest: '0.0.3' });
  });

  it('bumps minor when "minor" is passed (resets patch)', () => {
    seed(work, '0.1.5', '0.1.5');
    const r = runIn(work, 'minor');
    expect(r.status).toBe(0);
    expect(readBoth(work)).toEqual({ pkg: '0.2.0', manifest: '0.2.0' });
  });

  it('bumps major when "major" is passed (resets minor and patch)', () => {
    seed(work, '1.2.3', '1.2.3');
    const r = runIn(work, 'major');
    expect(r.status).toBe(0);
    expect(readBoth(work)).toEqual({ pkg: '2.0.0', manifest: '2.0.0' });
  });

  it('exits non-zero when no argument is supplied', () => {
    seed(work, '0.0.2', '0.0.2');
    const r = runIn(work);
    expect(r.status).not.toBe(0);
  });

  it('exits non-zero when argument is neither semver nor keyword', () => {
    seed(work, '0.0.2', '0.0.2');
    const r = runIn(work, 'not-a-version');
    expect(r.status).not.toBe(0);
  });

  it('overwrites both files even when starting state has drift (recovery path)', () => {
    seed(work, '0.0.3', '0.0.2');
    const r = runIn(work, '0.0.4');
    expect(r.status).toBe(0);
    expect(readBoth(work)).toEqual({ pkg: '0.0.4', manifest: '0.0.4' });
  });

  it('prints next-step guidance with the new version', () => {
    seed(work, '0.0.2', '0.0.2');
    const r = runIn(work, '0.0.3');
    expect(r.stdout).toContain('bump version to 0.0.3');
  });
});
