#!/usr/bin/env node
// Publishes every package whose version isn't on npm yet, dependencies first. Run by .github/workflows/release.yml
// after the build and tests; safe to re-run (published versions are skipped). Locally: node scripts/publish.mjs --dry-run
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const provenance = process.argv.includes('--provenance');
const npm = (args, opts = {}) =>
  execFileSync('npm', args, { cwd: root, encoding: 'utf8', shell: process.platform === 'win32', ...opts });

const packages = readdirSync(join(root, 'packages'))
  .map((d) => ({
    dir: join(root, 'packages', d),
    pkg: JSON.parse(readFileSync(join(root, 'packages', d, 'package.json'), 'utf8')),
  }))
  .filter(({ pkg }) => !pkg.private);
const names = new Set(packages.map((p) => p.pkg.name));

// Dependencies first: a package is published after every aipw package it depends on.
const ordered = [];
const visit = (p) => {
  if (ordered.includes(p)) return;
  for (const dep of Object.keys(p.pkg.dependencies ?? {}))
    if (names.has(dep)) visit(packages.find((q) => q.pkg.name === dep));
  ordered.push(p);
};
packages.forEach(visit);

// A merge to main without a release version is normal: nothing to publish.
if (ordered.every(({ pkg }) => pkg.version === '0.0.0')) {
  console.log('Dev version 0.0.0: nothing to publish.');
  process.exit(0);
}
const problems = [];
for (const { pkg, dir } of ordered) {
  if (pkg.version === '0.0.0') problems.push(`${pkg.name}: still 0.0.0; run scripts/release-version.mjs`);
  if (!pkg.license) problems.push(`${pkg.name}: no "license" field`);
  if (!existsSync(join(dir, 'dist'))) problems.push(`${pkg.name}: not built (npm run build)`);
}
if (problems.length) {
  console.error(`Not publishing:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

let published = 0;
for (const { pkg } of ordered) {
  const id = `${pkg.name}@${pkg.version}`;
  let exists;
  try {
    exists = npm(['view', id, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim() === pkg.version;
  } catch {
    exists = false; // 404: never published
  }
  if (exists) {
    console.log(`skip     ${id} (already on npm)`);
    continue;
  }
  const tag = pkg.version.includes('-') ? 'next' : 'latest';
  const args = ['publish', '-w', pkg.name, '--access', 'public', '--tag', tag];
  if (provenance) args.push('--provenance');
  if (dryRun) args.push('--dry-run');
  console.log(`publish  ${id} (${tag})${dryRun ? ' [dry run]' : ''}`);
  npm(args, { stdio: 'inherit' });
  published++;
}
console.log(`\n${published} package(s) ${dryRun ? 'would be ' : ''}published.`);
