import type { AipwEvent } from '@aipw/core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AipwReporter from '../src/reporter.js';
import {
  costOf,
  formatSummaryMarkdown,
  formatSummaryText,
  stepsFromEvents,
  summarizeRun,
  SUMMARY_ATTACHMENT,
  type TestSummary,
} from '../src/summary.js';

const usage = (requests: number, extra = {}) => ({
  inputTokens: 1000 * requests,
  outputTokens: 50 * requests,
  requests,
  ...extra,
});
const callsite = { file: 'users.spec.ts', line: 14, column: 3 };

const events: AipwEvent[] = [
  { type: 'step:start', stepId: 's1', kind: 'act', instruction: 'Log in', callsite },
  { type: 'cache', stepId: 's1', key: 'k1', outcome: 'hit' },
  { type: 'step:end', stepId: 's1', kind: 'act', instruction: 'Log in', status: 'passed', ms: 400, usage: usage(0) },
  {
    type: 'step:start',
    stepId: 's2',
    kind: 'act',
    instruction: 'Open Settings > Users',
    callsite: { ...callsite, line: 15 },
  },
  { type: 'cache', stepId: 's2', key: 'k2', outcome: 'broken', reason: 'gone' },
  {
    type: 'heal',
    stepId: 's2',
    key: 'k2',
    source: 'ai',
    policy: 'report',
    before: 'button "Settings"',
    after: 'button "Preferences"',
    reason: 'gone',
  },
  { type: 'decision', stepId: 's2', turn: 0, tool: 'click', args: {}, repaired: false, usage: usage(1), ms: 4000 },
  { type: 'decision', stepId: 's2', turn: 1, tool: 'done', args: {}, repaired: false, usage: usage(1), ms: 3000 },
  {
    type: 'step:end',
    stepId: 's2',
    kind: 'act',
    instruction: 'Open Settings > Users',
    status: 'passed',
    ms: 7200,
    usage: usage(2),
  },
  { type: 'step:start', stepId: 'r', kind: 'run', instruction: '- Save\n- Check' },
  { type: 'step:start', stepId: 's3', kind: 'assert', instruction: 'Saved is shown' },
  { type: 'decision', stepId: 's3', turn: 0, tool: 'verdict', args: {}, repaired: false, usage: usage(1), ms: 2000 },
  {
    type: 'step:end',
    stepId: 's3',
    kind: 'assert',
    instruction: 'Saved is shown',
    status: 'failed',
    ms: 2100,
    usage: usage(1),
    error: 'not shown',
  },
  {
    type: 'step:end',
    stepId: 'r',
    kind: 'run',
    instruction: '- Save\n- Check',
    status: 'failed',
    ms: 2200,
    usage: usage(1),
  },
];

const test = (name: string, cost?: number): TestSummary => ({
  test: name,
  provider: 'foundry',
  model: 'gpt-5.4',
  cacheMode: 'auto',
  steps: stepsFromEvents(events).map((s) => ({
    ...s,
    usage: { ...s.usage, ...(cost !== undefined && s.usage.requests && { costUsd: cost }) },
  })),
});

describe('run summary', () => {
  it('turns a test’s events into steps: source, status, decisions, heal', () => {
    expect(stepsFromEvents(events).map((s) => [s.id, s.source, s.status, s.decisions, s.callsite])).toEqual([
      ['s1', 'cache', 'passed', 0, 'users.spec.ts:14'],
      ['s2', 'healed', 'passed', 2, 'users.spec.ts:15'],
      ['s3', 'ai', 'failed', 1, undefined],
    ]);
    expect(stepsFromEvents(events)[1]!.heal).toEqual({
      source: 'ai',
      before: 'button "Settings"',
      after: 'button "Preferences"',
    });
  });

  it('prices usage: provider estimate first, then the pricing table, else unknown', () => {
    const pricing = { 'foundry:gpt-5.4': { input: 2, output: 8, cacheRead: 0.5 } };
    expect(costOf(usage(1, { costUsd: 0.01 }), pricing, 'foundry:gpt-5.4')).toBe(0.01);
    expect(
      costOf(
        { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, requests: 3 },
        pricing,
        'foundry:gpt-5.4',
      ),
    ).toBeCloseTo(2 + 0.8 + 1);
    expect(costOf(usage(1), pricing, 'other:x')).toBeUndefined();
  });

  it('adds up a run and formats it for the console and Markdown', () => {
    const run = summarizeRun([test('a', 0.25), test('b', 0.25)]);
    expect(run.steps).toEqual({ total: 6, cache: 2, ai: 2, healed: 2, failed: 2 });
    expect(run.usage.requests).toBe(6);
    expect(run.costUsd).toBeCloseTo(1);
    expect(run.slowest[0]).toMatchObject({ instruction: 'Open Settings > Users', ms: 7200 });
    const text = formatSummaryText(run);
    expect(text).toContain('aipw summary — provider foundry (gpt-5.4), cache auto');
    expect(text).toContain('AI steps       6    from cache 2 (33.3%)   AI 2   healed 2   failed 2');
    expect(text).toContain('LLM calls      6    tokens in 6.0k / out 300    est. cost $1.00');
    expect(text).toContain('Healed      users.spec.ts:15 — button "Settings" → button "Preferences" (ai)');
    const md = formatSummaryMarkdown(run);
    expect(md).toContain('| 6 | 2 (33.3%) | 2 | 2 | 2 | 6 | 6.0k / 300 | $1.00 |');
    expect(md).toContain(
      '| users.spec.ts:15 | Open Settings > Users | button "Settings" | button "Preferences" | ai |',
    );
    expect(md).toContain('| b | `ai.assert` Saved is shown | not shown |');
    expect(summarizeRun([test('a')]).costUsd).toBeUndefined();
  });
});

describe('@aipw/test/reporter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads the attachments (last attempt wins), writes summary files and the Azure summary tab', () => {
    vi.stubEnv('TF_BUILD', 'True');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), 'aipw-report-'));
    const reporter = new AipwReporter({ outputDir: dir });
    const attempt = (t: TestSummary) =>
      ({
        attachments: [
          { name: SUMMARY_ATTACHMENT, contentType: 'application/json', body: Buffer.from(JSON.stringify(t)) },
        ],
      }) as never;
    reporter.onTestEnd({ id: '1' } as never, attempt(test('a')));
    reporter.onTestEnd({ id: '1' } as never, attempt(test('a (retry)')));
    reporter.onTestEnd({ id: '2' } as never, { attachments: [] } as never);
    reporter.onEnd({} as never);
    expect(reporter.summary!.tests).toBe(1);
    expect(readFileSync(join(dir, 'summary.md'), 'utf8')).toContain('# aipw run summary');
    expect(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).steps.total).toBe(3);
    expect(log.mock.calls.map((c) => String(c[0]))).toContain(`##vso[task.uploadsummary]${join(dir, 'summary.md')}`);
  });
});
