// Playwright Test integration (docs/03 §1): `test` with the `ai`, `gen` and `aiConfig` fixtures.
import {
  Ai,
  createGenerators,
  FilePlanStore,
  loadProvider,
  NudgeController,
  planFilePath,
  resolveConfig,
  type AipwConfigInput,
  type AipwEvent,
  type Callsite,
  type Generators,
  type LlmProvider,
} from '@aipw/core';
import { test as base, type PlaywrightTestConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { costOf, stepsFromEvents, SUMMARY_ATTACHMENT, type TestSummary } from './summary.js';

export { expect } from '@playwright/test';
export type { Locator, Page } from '@playwright/test';
export * from '@aipw/core';

/**
 * Seed for this run's generated data (docs/08 §3): AIPW_SEED reproduces a run's values (nudge rewinds
 * set it); otherwise every run gets fresh values, which keeps server-side uniqueness checks happy.
 */
const RUN_SEED = process.env.AIPW_SEED ?? randomUUID().slice(0, 8);

const CONFIG_NAMES = ['aipw.config.ts', 'aipw.config.mts', 'aipw.config.js', 'aipw.config.mjs'];

/** Finds aipw.config.* from the working directory upwards. Playwright's loader compiles .ts files. */
export async function loadAipwConfig(from = process.cwd()): Promise<AipwConfigInput> {
  for (let dir = from; ; dir = dirname(dir)) {
    for (const name of CONFIG_NAMES) {
      const path = join(dir, name);
      if (existsSync(path)) {
        const mod = (await import(pathToFileURL(path).href)) as { default?: AipwConfigInput };
        return mod.default ?? {};
      }
    }
    if (dirname(dir) === dir) return {};
  }
}

/** file:///C:/Dev%20stuff/a.ts → C:\Dev stuff\a.ts; file:///home/a.ts → /home/a.ts. */
const fileUrlToPath = (url: string) => {
  try {
    return fileURLToPath(url);
  } catch {
    return url;
  }
};

const normDir = (p: string) => `${p.replace(/\\/g, '/').replace(/\/$/, '')}/`.toLowerCase();

/** Package roots of @aipw/test and @aipw/core, as real paths (workspaces link them from node_modules). */
function ownPackageDirs(): string[] {
  const dirs = [join(dirname(fileURLToPath(import.meta.url)), '..')];
  try {
    dirs.push(join(dirname(fileURLToPath(import.meta.resolve('@aipw/core'))), '..'));
  } catch {
    // not resolvable from here; node_modules frames are skipped anyway
  }
  return dirs.map((d) => {
    try {
      return normDir(realpathSync(d));
    } catch {
      return normDir(d);
    }
  });
}
const OWN_DIRS = ownPackageDirs();

/** The first stack frame outside aipw itself: the spec line that called ai.*. */
function captureCallsite(): Callsite | undefined {
  return callsiteFromStack(new Error().stack ?? '');
}

/**
 * Parses a stack trace for captureCallsite (exported for tests). Node internals are skipped by frame: in
 * "node:internal/process/task_queues:65:5" the "e:" would otherwise pass for a Windows drive letter.
 * aipw's own frames are recognised by package directory, so a user's own packages/core isn't skipped.
 */
export function callsiteFromStack(stack: string, cwd = process.cwd(), ownDirs = OWN_DIRS): Callsite | undefined {
  const frames = stack.split('\n').slice(1);
  for (const frame of frames) {
    if (/\bnode:/.test(frame)) continue;
    // "at fn (path:line:col)" or "at [async] path:line:col"; POSIX paths have no colon to anchor on.
    const m = /\(([^()]*):(\d+):(\d+)\)\s*$/.exec(frame) ?? /^\s*at (?:async )?(\S.*?):(\d+):(\d+)\s*$/.exec(frame);
    if (!m) continue;
    // ESM frames are file:// URLs: a path with spaces arrives as "Dev%20stuff".
    const file = m[1]!.startsWith('file:') ? fileUrlToPath(m[1]!) : m[1]!;
    const lower = file.replace(/\\/g, '/').toLowerCase();
    if (lower.includes('/node_modules/') || ownDirs.some((d) => lower.startsWith(d))) continue;
    return { file: relative(cwd, file).replace(/\\/g, '/'), line: Number(m[2]), column: Number(m[3]) };
  }
  return undefined;
}

const usesSecret = (args: Record<string, unknown>) => /\{\{\s*secret\./.test(JSON.stringify(args));

type TraceOption = string | { mode: string; snapshots?: boolean | { dom?: boolean } };

/** True if this trace setting records DOM snapshots (the default whenever tracing is on). */
export function traceRecordsDom(trace: TraceOption): boolean {
  if (typeof trace === 'string') return trace !== 'off';
  if (trace.mode === 'off') return false;
  const s = trace.snapshots;
  return s === undefined || s === true || (typeof s === 'object' && s.dom !== false);
}

interface TestFixtures {
  ai: Ai;
  gen: Generators;
}

interface WorkerFixtures {
  /** aipw config. Defaults to aipw.config.ts; override with test.use({ aiConfig }). */
  aiConfig: AipwConfigInput;
  /** One provider per worker (provider sessions and clients are reused across tests). */
  aipwProvider: LlmProvider;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  aiConfig: [async ({}, use) => use(await loadAipwConfig()), { scope: 'worker', option: true }],

  aipwProvider: [
    async ({ aiConfig }, use) => {
      const provider = await loadProvider(resolveConfig(aiConfig));
      await use(provider);
      await provider.dispose?.();
    },
    { scope: 'worker' },
  ],

  ai: async ({ page, aiConfig, aipwProvider, baseURL, testIdAttribute, trace, gen }, use, testInfo) => {
    const events: AipwEvent[] = [];
    let warnedAboutTrace = false;
    const config = resolveConfig(aiConfig);
    const specFile = relative(process.cwd(), testInfo.file);
    // Under `aipw nudge` (AIPW_NUDGE_PORT set), connect to the driver so the human can step through (docs/07).
    const nudge = await NudgeController.fromEnv({ file: specFile, title: testInfo.titlePath.slice(1).join(' > ') });
    const ai = new Ai({
      page,
      provider: aipwProvider,
      config,
      gen,
      nudge,
      // docs/06 §2: committed plans next to the spec; healed plans under heal.policy report go to .aipw/healed/.
      cache: {
        store: new FilePlanStore(planFilePath(testInfo.file, config.cache.dir)),
        testTitle: testInfo.titlePath.slice(1).join(' > '),
        healedStore: new FilePlanStore(join(process.cwd(), '.aipw', 'healed', `${specFile}.plans.json`)),
      },
      baseURL,
      playwrightTestIdAttribute: testIdAttribute,
      // Each AI step is a test.step with its files attached to it, and each action a nested step (docs/09 §2.1).
      wrapStep: (title, fn) =>
        base.step(title, (step) => fn((name, body, contentType) => step.attach(name, { body, contentType })), {
          box: true,
        }),
      wrapAction: (title, fn) => base.step(title, fn),
      captureCallsite,
      idPrefix: testInfo.testId,
    });
    ai.events.on((e) => {
      events.push(e);
      // Spike 0.7: trace DOM snapshots record input values, password fields included, whatever fill method
      // was used. A secret typed by an AI step while they are on ends up in trace.zip (docs/08 §4 rule 3).
      if (!warnedAboutTrace && e.type === 'action' && usesSecret(e.record.args) && traceRecordsDom(trace)) {
        warnedAboutTrace = true;
        const message =
          'aipw: an AI step entered a secret while trace DOM snapshots are on, so the value can end up in the trace. ' +
          "Use code-based login, or test.use({ trace: { mode: 'retain-on-failure', snapshots: false } }) for this test.";
        testInfo.annotations.push({ type: 'warning', description: message });
        console.warn(message);
      }
    });

    try {
      await use(ai);
    } finally {
      nudge?.close();
    }

    // Per-test step summary for the run summary reporter (docs/09 §2.2).
    const steps = stepsFromEvents(events);
    if (steps.length) {
      const key = `${aipwProvider.id}:${aipwProvider.model}`;
      for (const step of steps) {
        const cost = step.usage.requests ? costOf(step.usage, config.pricing, key) : undefined;
        if (cost !== undefined) step.usage.costUsd = cost;
      }
      const summary: TestSummary = {
        test: testInfo.titlePath.slice(1).join(' > '),
        provider: aipwProvider.id,
        model: aipwProvider.model,
        cacheMode: process.env.AIPW_CACHE ?? config.cache.mode,
        steps,
      };
      await testInfo.attach(SUMMARY_ATTACHMENT, { body: JSON.stringify(summary), contentType: 'application/json' });
    }
    if (ai.usage.requests > 0) {
      const cost = ai.usage.costUsd !== undefined ? `, ~$${ai.usage.costUsd.toFixed(3)} API-equivalent` : '';
      testInfo.annotations.push({
        type: 'aipw',
        description: `${ai.usage.requests} AI requests (${aipwProvider.id}/${aipwProvider.model}), ${ai.usage.inputTokens + (ai.usage.cacheReadTokens ?? 0)} input / ${ai.usage.outputTokens} output tokens${cost}`,
      });
    }
  },

  gen: async ({}, use, testInfo) => use(createGenerators({ seed: `${testInfo.testId}:${RUN_SEED}`, runId: RUN_SEED })),
});

/** Playwright config helper (docs/03 §1). AI steps are slow, so the default test timeout is 3 minutes. */
export function withAipw<T extends PlaywrightTestConfig>(config: T): T {
  return { ...config, timeout: config.timeout ?? 180_000 };
}
