// `aipw cache stats|show|prune|refresh` (docs/06 §8).
import { readPlanFile, stableStringify, type PlanFile, type StepPlan } from '@aipw/core';
import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

/** Every *.plans.json under a __aipw__ folder, skipping node_modules and dot folders. */
export function findPlanFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.plans.json') && basename(dir) === '__aipw__') found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

export interface PlanStats {
  file: string;
  tests: number;
  steps: Record<string, number>;
  heals: number;
  /** Assertions that always need the AI (no compiled check). */
  aiOnlyAsserts: number;
  /** Extracts without replayable sources (need the AI on replay). */
  aiOnlyExtracts: number;
}

export function planStats(path: string, root: string): PlanStats {
  const file = readPlanFile(path);
  const steps: Record<string, number> = {};
  let heals = 0;
  let aiOnlyAsserts = 0;
  let aiOnlyExtracts = 0;
  for (const test of Object.values(file.tests)) {
    for (const step of Object.values(test)) {
      steps[step.kind] = (steps[step.kind] ?? 0) + 1;
      heals += step.stats.heals;
      if (step.kind === 'assert' && !step.compiled?.length) aiOnlyAsserts++;
      if (step.kind === 'extract' && !step.sources?.length) aiOnlyExtracts++;
    }
  }
  return {
    file: relative(root, path),
    tests: Object.keys(file.tests).length,
    steps,
    heals,
    aiOnlyAsserts,
    aiOnlyExtracts,
  };
}

function describeStep(step: StepPlan): string[] {
  const lines = [`${step.kind}: ${step.instruction}`];
  for (const a of step.actions ?? []) {
    const target = a.target
      ? ` ${a.target.role ?? 'element'}${a.target.name ? ` "${a.target.name}"` : ''} → ${a.target.locators[0]?.display ?? 'no locator'}`
      : '';
    lines.push(`  ${a.tool}${target}`);
  }
  for (const c of step.compiled ?? [])
    lines.push(
      `  check: ${c.not ? 'not.' : ''}${c.expect}(${c.target?.locators[0]?.display ?? 'page'}) ${JSON.stringify(c.args)}`,
    );
  if (step.kind === 'assert' && !step.compiled?.length) lines.push('  check: none (judged by AI on every run)');
  for (const s of step.sources ?? [])
    lines.push(`  source ${s.path || '(value)'}: ${s.target.locators[0]?.display ?? 'no locator'}`);
  if (step.target) lines.push(`  → ${step.target.locators[0]?.display ?? 'no locator'}`);
  if (step.stats.heals) lines.push(`  healed ${step.stats.heals}× (last ${step.stats.lastHealAt})`);
  return lines;
}

export function showPlans(file: PlanFile, grep?: string): string {
  const out: string[] = [];
  for (const [title, steps] of Object.entries(file.tests).sort(([a], [b]) => a.localeCompare(b))) {
    if (grep && !title.includes(grep)) continue;
    out.push(title);
    for (const step of Object.values(steps)) out.push(...describeStep(step).map((l) => `  ${l}`));
  }
  return out.join('\n');
}

/** Removes tests that no longer exist. `liveTitles`: spec file (relative) → "describe > title" set. */
export function prunePlans(file: PlanFile, live: Set<string>): { file: PlanFile; removed: string[] } {
  const removed = Object.keys(file.tests).filter((t) => !live.has(t));
  const tests = Object.fromEntries(Object.entries(file.tests).filter(([t]) => live.has(t)));
  return { file: { ...file, tests }, removed };
}

/** Test titles per spec file, from `playwright test --list --reporter=json`. */
function listTests(root: string): Map<string, Set<string>> {
  const res = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) throw new Error(`playwright --list failed:\n${res.stderr}`);
  const report = JSON.parse(res.stdout) as { suites: Suite[] };
  const byFile = new Map<string, Set<string>>();
  type Suite = { title: string; file: string; specs?: { title: string; file: string }[]; suites?: Suite[] };
  const walk = (s: Suite, path: string[]) => {
    for (const spec of s.specs ?? []) {
      const key = basename(spec.file);
      if (!byFile.has(key)) byFile.set(key, new Set());
      byFile.get(key)!.add([...path, spec.title].join(' > '));
    }
    for (const child of s.suites ?? []) walk(child, [...path, child.title]);
  };
  // Top-level suites are files; their titles are not part of the test title path.
  for (const fileSuite of report.suites) walk(fileSuite, []);
  return byFile;
}

export function runCacheCommand(args: string[], root = process.cwd()): number {
  const [sub, target, ...rest] = args;
  switch (sub) {
    case 'stats': {
      const rows = findPlanFiles(root).map((p) => planStats(p, root));
      if (!rows.length) console.log('No plan files found.');
      for (const r of rows) {
        const steps = Object.entries(r.steps)
          .map(([k, n]) => `${n} ${k}`)
          .join(', ');
        console.log(
          `${r.file}: ${r.tests} tests, ${steps}; ${r.heals} heals; AI on replay: ${r.aiOnlyAsserts} asserts, ${r.aiOnlyExtracts} extracts`,
        );
      }
      return 0;
    }
    case 'show': {
      if (!target) {
        console.error('Usage: aipw cache show <spec file> [--grep <title part>]');
        return 1;
      }
      const grep = rest[0] === '--grep' ? rest[1] : undefined;
      const path = join(dirname(target), '__aipw__', `${basename(target)}.plans.json`);
      console.log(showPlans(readPlanFile(path), grep) || 'No plans.');
      return 0;
    }
    case 'prune': {
      const dryRun = args.includes('--dry-run');
      const live = listTests(root);
      for (const path of findPlanFiles(root)) {
        const spec = basename(path).replace(/\.plans\.json$/, '');
        const { file, removed } = prunePlans(readPlanFile(path), live.get(spec) ?? new Set());
        if (!removed.length) continue;
        console.log(
          `${relative(root, path)}: ${dryRun ? 'would remove' : 'removed'} ${removed.length}: ${removed.join('; ')}`,
        );
        if (!dryRun) writeFileSync(path, stableStringify(file));
      }
      return 0;
    }
    case 'refresh': {
      if (!target) {
        console.error('Usage: aipw cache refresh <spec file> [--grep <title part>]');
        return 1;
      }
      const res = spawnSync('npx', ['playwright', 'test', target, ...rest], {
        cwd: root,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, AIPW_CACHE: 'refresh' },
      });
      return res.status ?? 1;
    }
    default:
      console.error('Usage: aipw cache stats | show <spec> | prune [--dry-run] | refresh <spec> [--grep x]');
      return 1;
  }
}
