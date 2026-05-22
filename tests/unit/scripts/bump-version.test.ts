import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bump, bumpVersion, isSemver, runCli } from '../../../scripts/bump-version.ts';

function seed(root: string, pkgVersion: string, manifestVersion: string) {
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 't', version: pkgVersion }, null, 2)}\n`
  );
  mkdirSync(join(root, 'templates'), { recursive: true });
  writeFileSync(
    join(root, 'templates', 'manifest.json'),
    `${JSON.stringify({ version: manifestVersion }, null, 2)}\n`
  );
}

function read(root: string) {
  return {
    pkg: JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version,
    manifest: JSON.parse(readFileSync(join(root, 'templates', 'manifest.json'), 'utf-8')).version,
  };
}

describe('scripts/bump-version — pure helpers', () => {
  it('isSemver accepts valid semver and rejects non-semver', () => {
    expect(isSemver('0.0.1')).toBe(true);
    expect(isSemver('10.20.30')).toBe(true);
    expect(isSemver('1.2.3-beta.1')).toBe(true);
    expect(isSemver('1.2')).toBe(false);
    expect(isSemver('v1.2.3')).toBe(false);
    expect(isSemver('patch')).toBe(false);
  });

  it('bump computes major/minor/patch correctly', () => {
    expect(bump('0.0.2', 'patch')).toBe('0.0.3');
    expect(bump('0.1.5', 'minor')).toBe('0.2.0');
    expect(bump('1.2.3', 'major')).toBe('2.0.0');
  });
});

describe('scripts/bump-version — bumpVersion writes both files atomically', () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'bump-version-'));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('writes exact semver argument to both files', () => {
    seed(work, '0.0.2', '0.0.2');
    const r = bumpVersion(work, '1.2.3');
    expect(r.next).toBe('1.2.3');
    expect(read(work)).toEqual({ pkg: '1.2.3', manifest: '1.2.3' });
  });

  it('bumps patch keyword', () => {
    seed(work, '0.0.2', '0.0.2');
    bumpVersion(work, 'patch');
    expect(read(work)).toEqual({ pkg: '0.0.3', manifest: '0.0.3' });
  });

  it('bumps minor keyword and resets patch', () => {
    seed(work, '0.1.5', '0.1.5');
    bumpVersion(work, 'minor');
    expect(read(work)).toEqual({ pkg: '0.2.0', manifest: '0.2.0' });
  });

  it('bumps major keyword and resets minor/patch', () => {
    seed(work, '1.2.3', '1.2.3');
    bumpVersion(work, 'major');
    expect(read(work)).toEqual({ pkg: '2.0.0', manifest: '2.0.0' });
  });

  it('throws on invalid argument', () => {
    seed(work, '0.0.2', '0.0.2');
    expect(() => bumpVersion(work, 'not-a-version')).toThrow(/invalid version/);
  });

  it('overwrites both files even when starting state has drift (recovery path)', () => {
    seed(work, '0.0.3', '0.0.2');
    bumpVersion(work, '0.0.4');
    expect(read(work)).toEqual({ pkg: '0.0.4', manifest: '0.0.4' });
  });

  it('returns previous and next versions', () => {
    seed(work, '0.0.2', '0.0.2');
    const r = bumpVersion(work, '0.0.3');
    expect(r.previous).toBe('0.0.2');
    expect(r.next).toBe('0.0.3');
  });
});

describe('scripts/bump-version — runCli (CLI bootstrap)', () => {
  let work: string;
  let logs: string[];
  let errs: string[];

  function makeIo(argv: string[], env: Record<string, string | undefined> = {}) {
    logs = [];
    errs = [];
    return {
      argv,
      env,
      defaultRoot: work,
      log: (m: string) => logs.push(m),
      error: (m: string) => errs.push(m),
    };
  }

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'bump-version-cli-'));
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it('returns 2 and prints usage when no argument is given', () => {
    const code = runCli(makeIo([]));
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('usage: bun scripts/bump-version.ts');
  });

  it('returns 2 and prints invalid-version error on bad argument', () => {
    seed(work, '0.0.2', '0.0.2');
    const code = runCli(makeIo(['not-a-version']));
    expect(code).toBe(2);
    expect(errs.join('\n')).toContain('invalid version');
  });

  it('returns 0 and prints success summary using defaultRoot', () => {
    seed(work, '0.0.2', '0.0.2');
    const code = runCli(makeIo(['0.1.0']));
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('version bumped: 0.0.2 → 0.1.0');
    expect(out).toContain('bump version to 0.1.0');
    expect(read(work)).toEqual({ pkg: '0.1.0', manifest: '0.1.0' });
  });

  it('honors BUMP_VERSION_ROOT env override over defaultRoot', () => {
    const other = mkdtempSync(join(tmpdir(), 'bump-version-cli-env-'));
    try {
      seed(other, '0.0.2', '0.0.2');
      // defaultRoot points at "work" but env should redirect to "other"
      const code = runCli(makeIo(['0.0.5'], { BUMP_VERSION_ROOT: other }));
      expect(code).toBe(0);
      expect(read(other)).toEqual({ pkg: '0.0.5', manifest: '0.0.5' });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
