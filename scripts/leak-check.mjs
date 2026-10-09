// Secret-leak check (docs/10 Phase 5 exit, risk R8): fails if any secret value appears in test results,
// reports, .aipw/ logs or plan files — including inside zip files such as Playwright traces.
//   node scripts/leak-check.mjs DEMO_INITIAL_PASSWORD [OTHER_ENV ...]
// Each argument names an environment variable holding a secret. No dependencies.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const names = process.argv.slice(2);
if (!names.length) {
  console.error('Usage: node scripts/leak-check.mjs <SECRET_ENV_VAR>...');
  process.exit(2);
}
const secrets = names.map((n) => {
  const v = process.env[n];
  if (!v) {
    console.error(`${n} is not set; nothing to check for it.`);
    process.exit(2);
  }
  return { name: n, needles: [v, encodeURIComponent(v), Buffer.from(v).toString('base64')] };
});

const root = process.cwd();
const roots = ['test-results', 'playwright-report', 'blob-report', '.aipw']
  .map((d) => join(root, d))
  .filter(existsSync);

/** Plan folders anywhere outside node_modules. */
function findPlanDirs(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.name === '__aipw__') out.push(p);
    else out.push(...findPlanDirs(p));
  }
  return out;
}
roots.push(...findPlanDirs(root));

/** Minimal zip reader: entries from the central directory, stored or deflated. */
function* zipEntries(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) return;
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    yield { name, data: method === 8 ? inflateRawSync(raw) : raw };
    p += 46 + nameLen + extraLen + commentLen;
  }
}

const leaks = [];
let scanned = 0;
function scan(label, data) {
  scanned++;
  for (const s of secrets) if (s.needles.some((n) => data.includes(n))) leaks.push(`${s.name} in ${label}`);
}
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (statSync(p).size < 512 * 1024 * 1024) {
      const data = readFileSync(p);
      if (p.endsWith('.zip'))
        for (const entry of zipEntries(data)) scan(`${relative(root, p)}!${entry.name}`, entry.data);
      else scan(relative(root, p), data);
    }
  }
}
for (const r of roots) walk(r);

if (leaks.length) {
  console.error(`Secret leak check FAILED (${leaks.length}):\n  ${leaks.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `Secret leak check passed: ${secrets.map((s) => s.name).join(', ')} not found in ${scanned} files (${roots.map((r) => relative(root, r)).join(', ') || 'nothing to scan'}).`,
);
