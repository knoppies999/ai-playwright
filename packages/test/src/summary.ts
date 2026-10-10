// Run summary (docs/09 §2.2). The `ai` fixture turns each test's (redacted) events into a TestSummary attachment;
// the reporter, in the main process, adds them up and prints / writes the run summary. Pure functions, no I/O.
import { addUsage, costOf, emptyUsage, type AipwEvent, type PricingTable, type Usage } from '@aipw/core';

export const SUMMARY_ATTACHMENT = 'aipw-steps.json';

export interface StepSummary {
  id: string;
  kind: string;
  instruction: string;
  /** "file:line" */
  callsite?: string;
  /** Where the step's actions came from: a cached plan, the model, or a heal of a broken plan. */
  source: 'cache' | 'ai' | 'healed';
  status: 'passed' | 'failed';
  ms: number;
  decisions: number;
  /** Decisions that needed a repair turn (no or invalid tool call): schema adherence, for conformance. */
  repairs: number;
  /** Latency of each decide() call, ms. */
  decisionMs: number[];
  usage: Usage;
  heal?: { source: 'fingerprint' | 'ai'; before: string; after: string };
  error?: string;
}

export interface TestSummary {
  test: string;
  provider: string;
  model: string;
  cacheMode: string;
  steps: StepSummary[];
}

/** One test's AI steps from its events. `ai.run` wrappers are left out: their sub-steps are counted. */
export function stepsFromEvents(events: AipwEvent[]): StepSummary[] {
  const steps = new Map<string, StepSummary>();
  const cached = new Set<string>();
  for (const e of events) {
    if (e.type === 'step:start' && e.kind !== 'run') {
      steps.set(e.stepId, {
        id: e.stepId,
        kind: e.kind,
        instruction: e.instruction,
        ...(e.callsite && { callsite: `${e.callsite.file}:${e.callsite.line}` }),
        source: 'ai',
        status: 'passed',
        ms: 0,
        decisions: 0,
        repairs: 0,
        decisionMs: [],
        usage: emptyUsage(),
      });
      continue;
    }
    const step = 'stepId' in e ? steps.get(e.stepId) : undefined;
    if (!step) continue;
    if (e.type === 'decision') {
      step.decisions++;
      step.decisionMs.push(e.ms);
      if (e.repaired) step.repairs++;
    } else if (e.type === 'cache' && e.outcome === 'hit') cached.add(e.stepId);
    else if (e.type === 'heal') step.heal = { source: e.source, before: e.before, after: e.after };
    else if (e.type === 'step:end') {
      step.status = e.status;
      step.ms = e.ms;
      step.usage = e.usage;
      // LLM calls of any kind: decisions, verdicts, locate and extract calls, AI heals.
      step.decisions = Math.max(step.decisions, e.usage.requests);
      if (e.error) step.error = e.error;
    }
  }
  for (const step of steps.values()) step.source = step.heal ? 'healed' : cached.has(step.id) ? 'cache' : 'ai';
  return [...steps.values()];
}

export { costOf };

export interface RunSummary {
  providers: string[];
  cacheModes: string[];
  tests: number;
  steps: { total: number; cache: number; ai: number; healed: number; failed: number };
  usage: Usage;
  /** Undefined when no step had a known price. */
  costUsd?: number;
  slowest: (StepSummary & { test: string })[];
  healed: (StepSummary & { test: string })[];
  failed: (StepSummary & { test: string })[];
}

export function summarizeRun(tests: TestSummary[], pricing: PricingTable = {}): RunSummary {
  const all = tests.flatMap((t) => t.steps.map((s) => ({ ...s, test: t.test, key: `${t.provider}:${t.model}` })));
  let usage = emptyUsage();
  let cost: number | undefined;
  for (const s of all) {
    usage = addUsage(usage, s.usage);
    const c = s.usage.requests ? costOf(s.usage, pricing, s.key) : 0;
    if (c !== undefined && s.usage.requests) cost = (cost ?? 0) + c;
  }
  const strip = ({ key: _k, ...s }: (typeof all)[number]) => s;
  return {
    providers: [...new Set(tests.map((t) => `${t.provider} (${t.model})`))],
    cacheModes: [...new Set(tests.map((t) => t.cacheMode))],
    tests: tests.length,
    steps: {
      total: all.length,
      cache: all.filter((s) => s.source === 'cache').length,
      ai: all.filter((s) => s.source === 'ai').length,
      healed: all.filter((s) => s.source === 'healed').length,
      failed: all.filter((s) => s.status === 'failed').length,
    },
    usage,
    ...(cost !== undefined && { costUsd: cost }),
    slowest: [...all]
      .filter((s) => s.source !== 'cache')
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5)
      .map(strip),
    healed: all.filter((s) => s.source === 'healed').map(strip),
    failed: all.filter((s) => s.status === 'failed').map(strip),
  };
}

const pct = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : '0%');
const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
const where = (s: StepSummary & { test: string }) => s.callsite ?? s.test;
const tokensIn = (u: Usage) => u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);

/** The console summary. */
export function formatSummaryText(r: RunSummary): string {
  const s = r.steps;
  const lines = [
    `aipw summary — provider ${r.providers.join(', ') || 'none'}, cache ${r.cacheModes.join(', ') || 'n/a'}`,
    `  AI steps    ${String(s.total).padStart(4)}    from cache ${s.cache} (${pct(s.cache, s.total)})   AI ${s.ai}   healed ${s.healed}   failed ${s.failed}`,
    `  LLM calls   ${String(r.usage.requests).padStart(4)}    tokens in ${k(tokensIn(r.usage))} / out ${k(r.usage.outputTokens)}` +
      (r.costUsd !== undefined ? `    est. cost $${r.costUsd.toFixed(2)}` : ''),
  ];
  const slow = r.slowest[0];
  if (slow)
    lines.push(
      `  Slowest     ${where(slow)} "${slow.instruction}"  ${(slow.ms / 1000).toFixed(1)} s (${slow.decisions} LLM calls)`,
    );
  for (const h of r.healed)
    lines.push(`  Healed      ${where(h)} — ${h.heal!.before} → ${h.heal!.after} (${h.heal!.source})`);
  for (const f of r.failed) lines.push(`  Failed      ${where(f)} "${f.instruction}"`);
  return lines.join('\n');
}

const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The Markdown summary (.aipw/summary.md, and the Azure DevOps summary tab). */
export function formatSummaryMarkdown(r: RunSummary): string {
  const s = r.steps;
  const lines = [
    '# aipw run summary',
    '',
    `Provider: ${r.providers.join(', ') || 'none'} · cache mode: ${r.cacheModes.join(', ') || 'n/a'} · ${r.tests} tests`,
    '',
    '| AI steps | From cache | AI | Healed | Failed | LLM calls | Tokens in / out | Est. cost |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| ${s.total} | ${s.cache} (${pct(s.cache, s.total)}) | ${s.ai} | ${s.healed} | ${s.failed} | ${r.usage.requests} | ${k(tokensIn(r.usage))} / ${k(r.usage.outputTokens)} | ${r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}` : 'n/a'} |`,
  ];
  if (r.failed.length) {
    lines.push('', '## Failed steps', '', '| Where | Step | Error |', '|---|---|---|');
    for (const f of r.failed)
      lines.push(
        `| ${cell(where(f))} | \`ai.${f.kind}\` ${cell(f.instruction)} | ${cell((f.error ?? '').slice(0, 200))} |`,
      );
  }
  if (r.healed.length) {
    lines.push(
      '',
      '## Healed steps',
      '',
      'Review these: under `heal.policy: report` the new plans are in `.aipw/healed/`.',
      '',
      '| Where | Step | Before | After | How |',
      '|---|---|---|---|---|',
    );
    for (const h of r.healed)
      lines.push(
        `| ${cell(where(h))} | ${cell(h.instruction)} | ${cell(h.heal!.before)} | ${cell(h.heal!.after)} | ${h.heal!.source} |`,
      );
  }
  if (r.slowest.length) {
    lines.push('', '## Slowest uncached steps', '', '| Where | Step | Time | LLM calls |', '|---|---|---:|---:|');
    for (const x of r.slowest)
      lines.push(`| ${cell(where(x))} | ${cell(x.instruction)} | ${(x.ms / 1000).toFixed(1)} s | ${x.decisions} |`);
  }
  return `${lines.join('\n')}\n`;
}
