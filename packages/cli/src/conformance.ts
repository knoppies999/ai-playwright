// `aipw conformance --provider x` (docs/05 §8, docs/10 Phase 3): runs the usability scenarios with the model on every
// step (AIPW_CACHE=ai-only) and writes conformance-<provider>-<model>.json with the metrics used to compare models.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The fields of .aipw/steps.json this command reads (written by @aipw/test/reporter). */
interface TestSteps {
  test: string;
  provider: string;
  model: string;
  steps: {
    status: 'passed' | 'failed';
    decisions: number;
    repairs?: number;
    decisionMs?: number[];
    ms: number;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; requests: number; costUsd?: number };
  }[];
}

export interface ConformanceMetrics {
  provider: string;
  model: string;
  date: string;
  tests: number;
  steps: number;
  /** Passed steps / steps. The Phase 3 exit asks for ≥ 0.85. */
  stepSuccessRate: number;
  meanDecisionsPerStep: number;
  repairTurns: number;
  tokensPerStep: { input: number; output: number };
  requestsPerStep: number;
  costUsdPerStep?: number;
  decisionLatencyMs: { p50: number; p95: number };
  stepLatencyMs: { p50: number; p95: number };
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};
const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export function conformanceMetrics(tests: TestSteps[], date = new Date()): ConformanceMetrics {
  const steps = tests.flatMap((t) => t.steps);
  const n = steps.length || 1;
  const sum = (f: (s: (typeof steps)[number]) => number) => steps.reduce((a, s) => a + f(s), 0);
  const priced = steps.filter((s) => s.usage.costUsd !== undefined);
  return {
    provider: tests[0]?.provider ?? 'unknown',
    model: tests[0]?.model ?? 'unknown',
    date: date.toISOString().slice(0, 10),
    tests: tests.length,
    steps: steps.length,
    stepSuccessRate: round(sum((s) => (s.status === 'passed' ? 1 : 0)) / n, 3),
    meanDecisionsPerStep: round(sum((s) => s.decisions) / n),
    repairTurns: sum((s) => s.repairs ?? 0),
    tokensPerStep: {
      input: Math.round(sum((s) => s.usage.inputTokens + (s.usage.cacheReadTokens ?? 0)) / n),
      output: Math.round(sum((s) => s.usage.outputTokens) / n),
    },
    requestsPerStep: round(sum((s) => s.usage.requests) / n),
    ...(priced.length && {
      costUsdPerStep: round(priced.reduce((a, s) => a + s.usage.costUsd!, 0) / priced.length, 4),
    }),
    decisionLatencyMs: {
      p50: percentile(
        steps.flatMap((s) => s.decisionMs ?? []),
        50,
      ),
      p95: percentile(
        steps.flatMap((s) => s.decisionMs ?? []),
        95,
      ),
    },
    stepLatencyMs: {
      p50: percentile(
        steps.map((s) => s.ms),
        50,
      ),
      p95: percentile(
        steps.map((s) => s.ms),
        95,
      ),
    },
  };
}

export interface ConformanceArgs {
  provider: string;
  project: string;
  out: string;
}

export function parseConformanceArgs(argv: string[]): ConformanceArgs | { error: string } {
  const args: ConformanceArgs = { provider: '', project: 'saucedemo-llm', out: 'docs/conformance' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[++i];
    if (!v) return { error: `${a} needs a value` };
    if (a === '--provider') args.provider = v;
    else if (a === '--project') args.project = v;
    else if (a === '--out') args.out = v;
    else return { error: `Unknown argument ${a}` };
  }
  return args.provider
    ? args
    : { error: 'Usage: aipw conformance --provider <key> [--project saucedemo-llm] [--out docs/conformance]' };
}

export async function runConformance(argv: string[]): Promise<number> {
  const args = parseConformanceArgs(argv);
  if ('error' in args) {
    console.error(args.error);
    return 1;
  }
  console.log(
    `aipw conformance: ${args.project} with ${args.provider}, every step with the model (ai-only). This spends real requests.`,
  );
  const code = await new Promise<number>((done) =>
    spawn('npx', ['playwright', 'test', '--project', args.project, '--reporter=list,@aipw/test/reporter'], {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, AIPW_PROVIDER: args.provider, AIPW_CACHE: 'ai-only' },
    }).on('exit', (c) => done(c ?? 1)),
  );
  const stepsFile = resolve('.aipw', 'steps.json');
  if (!existsSync(stepsFile)) {
    console.error(`No ${stepsFile}: the run produced no AI steps.`);
    return code || 1;
  }
  const metrics = conformanceMetrics(JSON.parse(readFileSync(stepsFile, 'utf8')) as TestSteps[]);
  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, `conformance-${metrics.provider}-${metrics.model}.json`.replace(/[^\w.-]+/g, '_'));
  writeFileSync(file, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(
    `Step success ${(metrics.stepSuccessRate * 100).toFixed(1)}% over ${metrics.steps} steps, ` +
      `${metrics.meanDecisionsPerStep} decisions/step, p50 decision ${metrics.decisionLatencyMs.p50} ms → ${file}`,
  );
  return metrics.stepSuccessRate >= 0.85 ? 0 : 1;
}
