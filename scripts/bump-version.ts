#!/usr/bin/env bun
/**
 * Atomic version bump for package.json AND templates/manifest.json.
 * Prevents drift caught by .github/workflows/ci.yml version-sync job and
 * .github/scripts/verify-version-sync.sh (release pre-publish gate).
 *
 * Usage:
 *   bun scripts/bump-version.ts 0.0.4
 *   bun scripts/bump-version.ts patch   # 0.0.3 -> 0.0.4
 *   bun scripts/bump-version.ts minor   # 0.0.3 -> 0.1.0
 *   bun scripts/bump-version.ts major   # 0.0.3 -> 1.0.0
 *
 * Also invoked automatically by the npm "version" lifecycle hook
 * (see package.json scripts.version) so `npm version <x>` keeps both files
 * in sync without any manual step.
 *
 * Implementation note: version fields are patched via regex to preserve each
 * file's original formatting (inline arrays, whitespace style, etc.).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.env.BUMP_VERSION_ROOT ?? resolve(import.meta.dir, '..');
const PKG = resolve(ROOT, 'package.json');
const MANIFEST = resolve(ROOT, 'templates', 'manifest.json');

function readVersion(path: string): string {
  const content = readFileSync(path, 'utf-8');
  const match = content.match(/"version"\s*:\s*"([^"]+)"/);
  if (!match) throw new Error(`No "version" field found in ${path}`);
  return match[1];
}

function patchVersion(path: string, next: string): void {
  const content = readFileSync(path, 'utf-8');
  if (!/"version"\s*:\s*"[^"]+"/.test(content)) {
    throw new Error(`Failed to patch version in ${path} — "version" field not found`);
  }
  const updated = content.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${next}"`);
  writeFileSync(path, updated);
}

function bump(current: string, kind: 'major' | 'minor' | 'patch'): string {
  const [maj, min, pat] = current.split('.').map((n) => Number.parseInt(n, 10));
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function isSemver(s: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(s);
}

const arg = process.argv[2];
if (!arg) {
  console.error('usage: bun scripts/bump-version.ts <version|patch|minor|major>');
  process.exit(2);
}

const currentPkg = readVersion(PKG);
const currentManifest = readVersion(MANIFEST);

if (currentPkg !== currentManifest) {
  console.warn(
    `warning: starting state already drifted (package.json=${currentPkg}, manifest=${currentManifest}). Both will be overwritten.`
  );
}

let next: string;
if (arg === 'major' || arg === 'minor' || arg === 'patch') {
  next = bump(currentPkg, arg);
} else if (isSemver(arg)) {
  next = arg;
} else {
  console.error(`invalid version argument: ${arg}`);
  process.exit(2);
}

patchVersion(PKG, next);
patchVersion(MANIFEST, next);

console.log(`✓ version bumped: ${currentPkg} → ${next}`);
console.log('  - package.json');
console.log('  - templates/manifest.json');
console.log('');
console.log(
  `Next: git add package.json templates/manifest.json && git commit -m "chore(release): bump version to ${next}"`
);
