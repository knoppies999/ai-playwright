// `aipw summary [--max-llm-calls N] [--max-cost USD] [--file path]`: reads the run summary that @aipw/test/reporter
// wrote and fails the build when the run used the model more than allowed. The PR gate uses --max-llm-calls 0
// (docs/09 §3): replay-only must never call the model.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface SummaryFile {
  tests: number;
  steps: { total: number; cache: number; ai: number; healed: number; failed: number };
  usage: { requests: number; inputTokens: number; outputTokens: number };
  costUsd?: number;
}

export interface SummaryArgs {
  file: string;
  maxLlmCalls?: number;
  maxCost?: number;
}

export function parseSummaryArgs(argv: string[]): SummaryArgs | { error: string } {
  const args: SummaryArgs = { file: '.aipw/summary.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => argv[++i];
    if (a === '--file') args.file = value() ?? '';
    else if (a === '--max-llm-calls') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0) return { error: '--max-llm-calls takes a whole number (0 for none)' };
      args.maxLlmCalls = n;
    } else if (a === '--max-cost') {
      const n = Number(value());
      if (!(n >= 0)) return { error: '--max-cost takes a USD amount' };
      args.maxCost = n;
    } else
      return { error: `Unknown argument ${a}. Usage: aipw summary [--max-llm-calls N] [--max-cost USD] [--file path]` };
  }
  return args;
}

/** Problems with the run against the limits; empty when it is within them. */
export function checkSummary(summary: SummaryFile, args: SummaryArgs): string[] {
  const problems: string[] = [];
  if (args.maxLlmCalls !== undefined && summary.usage.requests > args.maxLlmCalls)
    problems.push(
      `${summary.usage.requests} LLM calls (allowed ${args.maxLlmCalls}): ${summary.steps.ai} steps ran with the AI and ${summary.steps.healed} healed. ` +
        'Record or refresh their plans locally (AIPW_CACHE=auto) and commit the plan files.',
    );
  if (args.maxCost !== undefined && (summary.costUsd ?? 0) > args.maxCost)
    problems.push(`estimated cost $${(summary.costUsd ?? 0).toFixed(2)} (allowed $${args.maxCost.toFixed(2)})`);
  return problems;
}

export function runSummaryCommand(argv: string[]): number {
  const args = parseSummaryArgs(argv);
  if ('error' in args) {
    console.error(args.error);
    return 1;
  }
  const path = resolve(args.file);
  if (!existsSync(path)) {
    console.error(`No run summary at ${path}. Add ['@aipw/test/reporter'] to the Playwright reporters.`);
    return 2;
  }
  const summary = JSON.parse(readFileSync(path, 'utf8')) as SummaryFile;
  const s = summary.steps;
  console.log(
    `aipw: ${summary.tests} tests, ${s.total} AI steps (cache ${s.cache}, AI ${s.ai}, healed ${s.healed}, failed ${s.failed}), ${summary.usage.requests} LLM calls`,
  );
  const problems = checkSummary(summary, args);
  for (const p of problems) console.error(`aipw summary: ${p}`);
  return problems.length ? 1 : 0;
}
