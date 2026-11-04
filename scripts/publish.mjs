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

// Manifest mistakes npm only reports (or silently "fixes") at publish time. Checked on every run, so CI's
// `publish.mjs --dry-run` catches them long before a release.
const manifestProblems = [];
for (const { pkg } of ordered) {
  if (!pkg.license) manifestProblems.push(`${pkg.name}: no "license" field`);
  // npm 11 drops bin entries written as "./dist/bin.js" on publish: the command would be missing.
  for (const [name, path] of Object.entries(pkg.bin ?? {}))
    if (path.startsWith('./'))
      manifestProblems.push(`${pkg.name}: bin "${name}" must be "${path.slice(2)}", not "${path}"`);
}
if (manifestProblems.length) {
  console.error(`Package manifests need fixing:\n  ${manifestProblems.join('\n  ')}`);
  process.exit(1);
}

// A merge to main without a release version is normal: nothing to publish.
if (ordered.every(({ pkg }) => pkg.version === '0.0.0')) {
  console.log('Dev version 0.0.0: nothing to publish.');
  process.exit(0);
}
const problems = [];
for (const { pkg, dir } of ordered) {
  if (pkg.version === '0.0.0') problems.push(`${pkg.name}: still 0.0.0; run scripts/release-version.mjs`);
  if (!existsSync(join(dir, 'dist'))) problems.push(`${pkg.name}: not built (npm run build)`);
}
if (problems.length) {
  console.error(`Not publishing:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

// Who the token publishes as: a 404 on PUT @scope/name usually means this user can't create packages in that org.
let user = '(unknown)';
if (!dryRun) {
  try {
    user = npm(['whoami'], { stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    console.log(`npm user: ${user}`);
  } catch {
    console.log('npm whoami failed: with trusted publishing that is expected; with NPM_TOKEN the token is not valid.');
  }
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
  try {
    npm(args, { stdio: 'inherit' });
  } catch {
    const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0] : undefined;
    console.error(
      `\nnpm refused ${id}.` +
        (scope
          ? ` A 404 or 403 here means npm user "${user}" can't publish to ${scope}: make them an owner or admin of ` +
            `the npm org "${scope.slice(1)}", and give the token "Read and write" on all packages or on the ${scope} scope.`
          : '') +
        (published ? ` ${published} package(s) were published before this one; re-running skips them.` : ''),
    );
    process.exit(1);
  }
  published++;
}
console.log(`\n${published} package(s) ${dryRun ? 'would be ' : ''}published.`);
