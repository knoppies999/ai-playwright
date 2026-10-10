import { beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { AiBudgetExceeded } from '../src/errors.js';
import { BudgetGuard, costOf, resetRunBudget, withBudget } from '../src/llm/budget.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import { Ai } from '../src/step/ai.js';
import { html, useBrowser } from './browser.js';

const { page: open } = useBrowser();
const done = { tool: 'done', args: { summary: 'ok', evidence: [] } };
const req = { system: '', tools: [], context: '', observation: '' };
// FakeProvider reports 100 input / 10 output tokens per call: at $1000 per 1M input tokens, $0.10 a call.
const pricing = { 'fake:fake': { input: 1000, output: 0 } };

beforeEach(() => resetRunBudget());

describe('budget guards', () => {
  it('prices usage from the provider estimate first, then the pricing table', () => {
    expect(costOf({ inputTokens: 1, outputTokens: 1, requests: 1, costUsd: 0.5 }, pricing, 'fake:fake')).toBe(0.5);
    expect(costOf({ inputTokens: 100, outputTokens: 10, requests: 1 }, pricing, 'fake:fake')).toBeCloseTo(0.1);
    expect(costOf({ inputTokens: 100, outputTokens: 10, requests: 1 }, pricing, 'x:y')).toBeUndefined();
  });

  it('leaves the provider alone when no limit is set', () => {
    const provider = new FakeProvider();
    expect(withBudget(provider, new BudgetGuard({}, pricing, 'fake:fake'))).toBe(provider);
  });

  it('stops a step that goes over perStepUsd, and resets per step', async () => {
    const guard = new BudgetGuard({ perStepUsd: 0.25 }, pricing, 'fake:fake');
    const provider = withBudget(new FakeProvider([done, done, done, done]), guard);
    await provider.decide(req);
    await provider.decide(req);
    await expect(provider.decide(req)).rejects.toThrow(/budget exceeded for this step: ~\$0\.30 \(limit \$0\.25\)/);
    guard.startStep();
    await expect(provider.decide(req)).resolves.toBeDefined();
  });

  it('stops the run at perRunRequests, across every ai in the worker', async () => {
    const limits = { perRunRequests: 2 };
    const a = withBudget(new FakeProvider([done]), new BudgetGuard(limits, pricing, 'fake:fake'));
    const b = withBudget(new FakeProvider([done, done]), new BudgetGuard(limits, pricing, 'fake:fake'));
    await a.decide(req);
    await expect(b.decide(req)).rejects.toBeInstanceOf(AiBudgetExceeded);
    await expect(b.decide(req)).rejects.toThrow(/run \(this worker\): 2 LLM requests \(limit 2\)/);
  });

  it('fails an ai.act step that runs over its budget', async () => {
    const page = await open(html('app.html'));
    const config = resolveConfig({
      settle: { maxMs: 300, networkQuietMs: 50, snapshotIntervalMs: 50 },
      budget: { perStepUsd: 0.15 },
      pricing,
    });
    const scroll = { tool: 'scroll', args: { ref: null, direction: 'down', amount: null, intent: 'look' } };
    const error = await new Ai({ page, provider: new FakeProvider([scroll, scroll, done]), config })
      .act('Find the footer')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiBudgetExceeded);
    expect((error as AiBudgetExceeded).scope).toBe('step');
  });
});
