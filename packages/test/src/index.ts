// Playwright Test integration (docs/03 §1): `test` with the `ai`, `gen` and `aiConfig` fixtures.
import {
  Ai,
  loadProvider,
  resolveConfig,
  type AipwConfigInput,
  type AipwEvent,
  type Callsite,
  type LlmProvider,
} from '@aipw/core';
import { test as base, type PlaywrightTestConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export { expect } from '@playwright/test';
export type { Locator, Page } from '@playwright/test';
export * from '@aipw/core';

/** Test-data generators. Phase 5 adds SA ID, Luhn, IBAN, phone and the rest (docs/08 §3). */
export interface Generators {
  /** A unique address per call: aipw+<run>-<n>@example.com. */
  email(domain?: string): string;
  uuid(): string;
}

function createGenerators(): Generators {
  const run = randomUUID().slice(0, 8);
  let n = 0;
  return {
    email: (domain = 'example.com') => `aipw+${run}-${++n}@${domain}`,
    uuid: () => randomUUID(),
  };
}

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

/** The first stack frame outside aipw itself: the spec line that called ai.*. */
function captureCallsite(): Callsite | undefined {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  for (const frame of frames) {
    const m = /\(?((?:[A-Za-z]:)?[^():]+):(\d+):(\d+)\)?\s*$/.exec(frame.trim());
    if (!m) continue;
    const file = m[1]!.replace(/^file:\/\/\/?/, '');
    if (/[\\/](packages[\\/](core|test)[\\/]|node_modules[\\/])|^node:/.test(file)) continue;
    return { file: relative(process.cwd(), file).replace(/\\/g, '/'), line: Number(m[2]), column: Number(m[3]) };
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

  ai: async ({ page, aiConfig, aipwProvider, baseURL, testIdAttribute, trace }, use, testInfo) => {
    const events: AipwEvent[] = [];
    let warnedAboutTrace = false;
    const ai = new Ai({
      page,
      provider: aipwProvider,
      config: resolveConfig(aiConfig),
      baseURL,
      playwrightTestIdAttribute: testIdAttribute,
      wrapStep: (title, fn) => base.step(title, fn, { box: true }),
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

    await use(ai);

    // Report attachments (docs/09 §2.1). Events are already redacted.
    const decisions = events.filter((e) => e.type !== 'observation');
    if (decisions.length) {
      await testInfo.attach('aipw-decisions.json', {
        body: JSON.stringify(decisions, null, 2),
        contentType: 'application/json',
      });
    }
    const failed = testInfo.status !== testInfo.expectedStatus;
    const lastSnapshot = events.findLast((e) => e.type === 'observation');
    if (failed && lastSnapshot?.type === 'observation') {
      await testInfo.attach('aipw-snapshot.yaml', { body: lastSnapshot.snapshot, contentType: 'text/yaml' });
    }
    if (ai.usage.requests > 0) {
      const cost = ai.usage.costUsd !== undefined ? `, ~$${ai.usage.costUsd.toFixed(3)} API-equivalent` : '';
      testInfo.annotations.push({
        type: 'aipw',
        description: `${ai.usage.requests} AI requests (${aipwProvider.id}/${aipwProvider.model}), ${ai.usage.inputTokens + (ai.usage.cacheReadTokens ?? 0)} input / ${ai.usage.outputTokens} output tokens${cost}`,
      });
    }
  },

  gen: async ({}, use) => use(createGenerators()),
});

/** Playwright config helper (docs/03 §1). AI steps are slow, so the default test timeout is 3 minutes. */
export function withAipw<T extends PlaywrightTestConfig>(config: T): T {
  return { ...config, timeout: config.timeout ?? 180_000 };
}
