// `aipw cache stats|show|prune|refresh` (docs/06 §8).
import { readPlanFile, stableStringify, type PlanFile, type PlanTarget, type StepPlan } from '@aipw/core';
import { spawnSync } from 'node:child_process';
import { inSpecOrder, plansToCode } from './code.js';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  /** Targets with no stored locator: the step heals (fingerprint or AI) on every replay. */
  noLocator: number;
  /** Targets found only by position (L7): replay works, but a reordered page breaks it. */
  positional: number;
}

/** Every element target a plan stores: action targets, form fields, checks, extract sources, locate. */
function targetsOf(step: StepPlan): PlanTarget[] {
  return [
    ...(step.actions ?? []).flatMap((a) => [...(a.target ? [a.target] : []), ...(a.targets ?? [])]),
    ...(step.compiled ?? []).flatMap((c) => (c.target ? [c.target] : [])),
    ...(step.sources ?? []).map((s) => s.target),
    ...(step.target ? [step.target] : []),
  ];
}

export function planStats(path: string, root: string): PlanStats {
  const file = readPlanFile(path);
  const steps: Record<string, number> = {};
  let heals = 0;
  let aiOnlyAsserts = 0;
  let aiOnlyExtracts = 0;
  let noLocator = 0;
  let positional = 0;
  for (const test of Object.values(file.tests)) {
    for (const step of Object.values(test)) {
      steps[step.kind] = (steps[step.kind] ?? 0) + 1;
      heals += step.stats.heals;
      if (step.kind === 'assert' && !step.compiled?.length) aiOnlyAsserts++;
      if (step.kind === 'extract' && !step.sources?.length) aiOnlyExtracts++;
      for (const t of targetsOf(step)) {
        if (!t.locators.length) noLocator++;
        else if (t.locators[0]!.rung === 'L7') positional++;
      }
    }
  }
  return {
    file: relative(root, path),
    tests: Object.keys(file.tests).length,
    steps,
    heals,
    aiOnlyAsserts,
    aiOnlyExtracts,
    noLocator,
    positional,
  };
}

function describeStep(step: StepPlan): string[] {
  const lines = [`${step.kind}: ${step.instruction}`];
  const describeTarget = (t: PlanTarget | undefined) =>
    t ? ` ${t.role ?? 'element'}${t.name ? ` "${t.name}"` : ''} → ${t.locators[0]?.display ?? 'no locator'}` : '';
  for (const a of step.actions ?? []) {
    // What was typed or pressed: data and secrets are stored as placeholders, so this is safe to print.
    const typed = [a.args.value, a.args.text, a.args.key].find((v) => typeof v === 'string');
    lines.push(`  ${a.tool}${typed !== undefined ? ` ${JSON.stringify(typed)}` : ''}${describeTarget(a.target)}`);
    if (a.tool === 'fill_form' && Array.isArray(a.args.fields)) {
      (a.args.fields as { value?: unknown }[]).forEach((f, i) =>
        lines.push(`    ${JSON.stringify(f.value)}${describeTarget(a.targets?.[i])}`),
      );
    }
  }
  for (const c of step.compiled ?? [])
    lines.push(
      `  check: ${c.not ? 'not.' : ''}${c.expect}(${c.target?.locators[0]?.display ?? 'page'}) ${JSON.stringify(c.args)}`,
    );
  if (step.kind === 'assert' && !step.compiled?.length)
    lines.push(`  check: none (judged by AI on every run)${step.note ? `: ${step.note}` : ''}`);
  if (step.kind === 'extract' && !step.sources?.length)
    lines.push(`  sources: none (read by AI on every run)${step.note ? `: ${step.note}` : ''}`);
  for (const s of step.sources ?? [])
    lines.push(`  source ${s.path || '(value)'}: ${s.target.locators[0]?.display ?? 'no locator'}`);
  if (step.target) lines.push(`  → ${step.target.locators[0]?.display ?? 'no locator'}`);
  if (step.stats.heals) lines.push(`  healed ${step.stats.heals}× (last ${step.stats.lastHealAt})`);
  return lines;
}

export function showPlans(file: PlanFile, grep?: string, specSource?: string): string {
  const out: string[] = [];
  for (const [title, steps] of Object.entries(file.tests).sort(([a], [b]) => a.localeCompare(b))) {
    if (grep && !title.includes(grep)) continue;
    out.push(title);
    for (const step of inSpecOrder(Object.values(steps), specSource))
      out.push(...describeStep(step).map((l) => `  ${l}`));
  }
  return out.join('\n');
}

/** Removes tests that no longer exist. `liveTitles`: spec file (relative) → "describe > title" set. */
export function prunePlans(file: PlanFile, live: Set<string>): { file: PlanFile; removed: string[] } {
  // cache.byProject titles are "project › describe > title": the test is live if its title without the project is.
  const isLive = (t: string) => live.has(t) || (t.includes(' › ') && live.has(t.slice(t.indexOf(' › ') + 3)));
  const removed = Object.keys(file.tests).filter((t) => !isLive(t));
  const tests = Object.fromEntries(Object.entries(file.tests).filter(([t]) => isLive(t)));
  return { file: { ...file, tests }, removed };
}

/**
 * `aipw cache accept`: merges healed plans written aside (heal.policy report, the CI default: .aipw/healed/<spec>
 * .plans.json, e.g. downloaded from a pipeline artifact) into the committed plan files next to each spec. Merged
 * files are removed, so running it twice changes nothing.
 */
export function acceptHealed(root: string, options: { from?: string; dir?: string; dryRun?: boolean } = {}): string[] {
  const from = options.from ?? join(root, '.aipw', 'healed');
  const report: string[] = [];
  if (!existsSync(from)) return report;
  const healedFiles: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.plans.json')) healedFiles.push(path);
    }
  };
  walk(from);
  for (const path of healedFiles.sort()) {
    const spec = relative(from, path).replace(/\.plans\.json$/, '');
    const target = join(root, dirname(spec), options.dir ?? '__aipw__', `${basename(spec)}.plans.json`);
    const healed = readPlanFile(path);
    const committed = readPlanFile(target);
    let steps = 0;
    for (const [title, byKey] of Object.entries(healed.tests)) {
      committed.tests[title] = { ...committed.tests[title], ...byKey };
      steps += Object.keys(byKey).length;
    }
    report.push(
      `${spec.replace(/\\/g, '/')}: ${options.dryRun ? 'would accept' : 'accepted'} ${steps} healed step${steps === 1 ? '' : 's'}`,
    );
    if (options.dryRun) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stableStringify(committed));
    rmSync(path);
  }
  return report;
}

/** Quotes an argument for a shell command line when it has spaces or quotes. */
const shellQuote = (a: string) => (/^[\w./:=@-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);

/** Test titles per spec file, from `playwright test --list --reporter=json`. */
function listTests(root: string): Map<string, Set<string>> {
  const res = spawnSync('npx playwright test --list --reporter=json', {
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
          `${r.file}: ${r.tests} tests, ${steps}; ${r.heals} heals; AI on replay: ${r.aiOnlyAsserts} asserts, ${r.aiOnlyExtracts} extracts` +
            (r.noLocator ? `; ${r.noLocator} targets without a locator` : '') +
            (r.positional ? `; ${r.positional} positional (L7)` : ''),
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
      const source = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
      console.log(showPlans(readPlanFile(path), grep, source) || 'No plans.');
      return 0;
    }
    case 'code': {
      if (!target) {
        console.error('Usage: aipw cache code <spec file> [--grep <title part>]');
        return 1;
      }
      const grep = rest[0] === '--grep' ? rest[1] : undefined;
      const path = join(dirname(target), '__aipw__', `${basename(target)}.plans.json`);
      const source = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
      console.log(plansToCode(readPlanFile(path), source, grep) || 'No plans.');
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
      // One quoted command line (DEP0190: no argument array with shell: true).
      const command = ['npx', 'playwright', 'test', target, ...rest].map(shellQuote).join(' ');
      const res = spawnSync(command, {
        cwd: root,
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, AIPW_CACHE: 'refresh' },
      });
      return res.status ?? 1;
    }
    case 'accept': {
      const from = target && !target.startsWith('--') ? join(root, target) : undefined;
      const report = acceptHealed(root, { ...(from && { from }), dryRun: args.includes('--dry-run') });
      console.log(report.length ? report.join('\n') : 'No healed plans to accept (.aipw/healed/ is empty).');
      return 0;
    }
    default:
      console.error(
        'Usage: aipw cache stats | show <spec> | code <spec> | prune [--dry-run] | refresh <spec> [--grep x] | accept [dir] [--dry-run]',
      );
      return 1;
  }
}
