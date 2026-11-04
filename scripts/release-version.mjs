#!/usr/bin/env node
// Sets one version on every published package and on the dependencies between them (aipw packages are released
// together). Run in a release PR; merging it to main publishes to npm (.github/workflows/release.yml).
//   node scripts/release-version.mjs 0.2.0
//   node scripts/release-version.mjs patch|minor|major
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dirs = readdirSync(join(root, 'packages')).map((d) => join(root, 'packages', d));
const read = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const manifests = dirs.map((dir) => ({ dir, pkg: read(dir) }));
const names = new Set(manifests.map((m) => m.pkg.name));

const arg = process.argv[2];
const current = manifests.find((m) => m.pkg.name === 'aipw').pkg.version;
const bump = (v, part) => {
  const [major, minor, patch] = v.split('.').map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};
const version = ['patch', 'minor', 'major'].includes(arg) ? bump(current, arg) : arg;
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('Usage: node scripts/release-version.mjs <x.y.z | patch | minor | major>');
  process.exit(1);
}

for (const { dir, pkg } of manifests) {
  pkg.version = version;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) if (names.has(dep)) pkg[field][dep] = version;
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}
execSync('npm install --package-lock-only --ignore-scripts', { cwd: root, stdio: 'inherit' });
console.log(`\n${current} → ${version} on ${manifests.length} packages. Commit, open a PR; merging it publishes.`);
