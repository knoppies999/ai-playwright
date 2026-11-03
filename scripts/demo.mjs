#!/usr/bin/env node
// The aipw showcase, narrated: record → replay → redesign + heal → replay, on the local demo app.
//
//   npm run demo             all four phases (real AI calls in phases 1 and 3, on your AIPW_PROVIDER)
//   npm run demo:replay      the committed plan only: no AI, no sign-in, no internet
//   npm run demo -- --headed watch the browser
//
// Phases 1–4 use a scratch copy of the plan folder, so the committed plan file is never changed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const replayOnly = args.includes('--replay');
const passThrough = args.filter((a) => a !== '--replay');
const committedPlans = join(root, 'examples', 'tests', 'showcase', '__aipw__');

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

function runPhase({ title, explain, env }) {
  console.log(`\n${bold(title)}\n${dim(explain)}\n`);
  const started = Date.now();
  const res = spawnSync('npx', ['playwright', 'test', '--project', 'showcase', '--workers=1', ...passThrough], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  const summaryPath = join(root, '.aipw', 'summary.json');
  const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : undefined;
  return { title, ok: res.status === 0, seconds: (Date.now() - started) / 1000, summary };
}

function table(results) {
  const rows = results.map((r) => {
    const s = r.summary?.steps ?? {};
    return [
      r.title.replace(/^\d\.\s*/, ''),
      r.ok ? 'passed' : 'FAILED',
      `${s.cache ?? 0}/${s.total ?? 0}`,
      String(s.healed ?? 0),
      String(r.summary?.usage?.requests ?? 0),
      `${r.seconds.toFixed(0)} s`,
    ];
  });
  const head = ['Phase', 'Result', 'From cache', 'Healed', 'LLM calls', 'Time'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(`\n${bold(line(head))}`);
  for (const r of rows) console.log(line(r));
  // Kept as Markdown too, so the results survive a scrolled-away terminal.
  const md = [head, head.map(() => '---'), ...rows].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
  mkdirSync(join(root, '.aipw'), { recursive: true });
  writeFileSync(join(root, '.aipw', 'demo.md'), `# aipw demo, ${new Date().toISOString()}\n\n${md}\n`);
}

if (replayOnly) {
  if (!existsSync(committedPlans)) {
    console.error('No committed plan yet: run `npm run demo` once (needs AI) to record one.');
    process.exit(1);
  }
  const result = runPhase({
    title: 'Replay the committed plan',
    explain:
      'Every step comes from examples/tests/showcase/__aipw__. replay-only mode: any step that would need AI fails.',
    env: { AIPW_CACHE: 'replay-only', DEMO_VARIANT: 'a' },
  });
  table([result]);
  process.exit(result.ok ? 0 : 1);
}

const plans = mkdtempSync(join(tmpdir(), 'aipw-showcase-'));
const env = { AIPW_DEMO_PLANS: plans, AIPW_CACHE: 'auto' };
const phases = [
  {
    title: '1. Record',
    explain: 'No plan yet: the model works out every English step and aipw records durable locators.',
    env: { ...env, DEMO_VARIANT: 'a' },
  },
  {
    title: '2. Replay',
    explain: 'Same tests, same UI: every step replays from the plan with plain Playwright. No model calls.',
    env: { ...env, DEMO_VARIANT: 'a' },
  },
  {
    title: '3. Redesign: the UI changes',
    explain:
      'Variant B renames test ids, moves the Settings menu to "Admin" and renames "Users" to "People".\n' +
      'Renamed test ids heal by fingerprint (free); the moved menu needs the model once.',
    env: { ...env, DEMO_VARIANT: 'b' },
  },
  {
    title: '4. Replay the redesign',
    explain: 'The healed plan replays on the new UI with no model calls.',
    env: { ...env, DEMO_VARIANT: 'b' },
  },
];

const results = [];
try {
  for (const phase of phases) {
    const result = runPhase(phase);
    results.push(result);
    if (!result.ok) break;
  }
} finally {
  table(results);
  if (results.every((r) => r.ok)) {
    console.log(
      `\n${dim('Healed steps are listed in each phase summary above. Inspect the plan with:')}\n` +
        `  npx aipw cache show examples/tests/showcase/admin.spec.ts\n`,
    );
  }
  // Keep the committed plan as it is; the scratch copy is thrown away.
  rmSync(plans, { recursive: true, force: true });
}
process.exit(results.length === phases.length && results.every((r) => r.ok) ? 0 : 1);
