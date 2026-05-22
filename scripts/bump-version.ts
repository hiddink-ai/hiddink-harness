#!/usr/bin/env bun
/**
 * Atomic version bump for package.json AND templates/manifest.json.
 * Prevents drift caught by .github/workflows/ci.yml version-sync job and
 * .github/scripts/verify-version-sync.sh (release pre-publish gate).
 *
 * Usage:
 *   bun scripts/bump-version.ts 0.0.4
 *   bun scripts/bump-version.ts patch
 *   bun scripts/bump-version.ts minor
 *   bun scripts/bump-version.ts major
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type BumpKind = 'major' | 'minor' | 'patch';

export function isSemver(s: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(s);
}

export function bump(current: string, kind: BumpKind): string {
  const [maj, min, pat] = current.split('.').map((n) => Number.parseInt(n, 10));
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export interface BumpResult {
  previous: string;
  next: string;
  pkgPath: string;
  manifestPath: string;
}

export function bumpVersion(root: string, arg: string): BumpResult {
  const pkgPath = resolve(root, 'package.json');
  const manifestPath = resolve(root, 'templates', 'manifest.json');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
  const currentPkg = String(pkg.version);

  let next: string;
  if (arg === 'major' || arg === 'minor' || arg === 'patch') {
    next = bump(currentPkg, arg);
  } else if (isSemver(arg)) {
    next = arg;
  } else {
    throw new Error(`invalid version argument: ${arg}`);
  }

  pkg.version = next;
  manifest.version = next;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { previous: currentPkg, next, pkgPath, manifestPath };
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: bun scripts/bump-version.ts <version|patch|minor|major>');
    process.exit(2);
  }
  const root = process.env.BUMP_VERSION_ROOT ?? resolve(import.meta.dir, '..');
  try {
    const r = bumpVersion(root, arg);
    console.log(`✓ version bumped: ${r.previous} → ${r.next}`);
    console.log('  - package.json');
    console.log('  - templates/manifest.json');
    console.log('');
    console.log(
      `Next: git add package.json templates/manifest.json && git commit -m "chore(release): bump version to ${r.next}"`
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
}
