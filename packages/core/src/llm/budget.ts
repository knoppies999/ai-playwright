// Budget guards (docs/09 §1 budget) and cost estimates. The provider is wrapped once per `ai`: every decide() and
// structured() call is counted against the step and the run, and a call that goes over a limit fails the step with
// AiBudgetExceeded. "Run" means this Playwright worker process: workers don't share a counter.
import { AiBudgetExceeded } from '../errors.js';
import { addUsage, emptyUsage, type LlmProvider, type Usage } from './provider.js';

/** USD per 1M tokens, keyed "provider:model". */
export type PricingTable = Record<string, { input: number; output: number; cacheRead?: number }>;

export interface BudgetLimits {
  perStepUsd?: number;
  perRunUsd?: number;
  perRunRequests?: number;
}

/** The provider's own estimate if it gave one, else the pricing table, else undefined (unknown). */
export function costOf(usage: Usage, pricing: PricingTable, key: string): number | undefined {
  if (usage.costUsd !== undefined) return usage.costUsd;
  const p = pricing[key];
  if (!p) return undefined;
  const cacheRead = (usage.cacheReadTokens ?? 0) * (p.cacheRead ?? p.input);
  return (usage.inputTokens * p.input + usage.outputTokens * p.output + cacheRead) / 1_000_000;
}

/** Usage of this worker process across every `ai`. */
const run = { usage: emptyUsage(), costUsd: 0 };

/** For tests: start a new "run". */
export function resetRunBudget(): void {
  run.usage = emptyUsage();
  run.costUsd = 0;
}

export class BudgetGuard {
  private stepCost = 0;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly pricing: PricingTable,
    private readonly key: string,
  ) {}

  get active(): boolean {
    return (
      this.limits.perStepUsd !== undefined ||
      this.limits.perRunUsd !== undefined ||
      this.limits.perRunRequests !== undefined
    );
  }

  /** A new AI step starts (sub-steps of ai.run each count as one). */
  startStep(): void {
    this.stepCost = 0;
  }

  /** Before a call: refuse if the run is already over. */
  beforeCall(): void {
    const { perRunUsd, perRunRequests } = this.limits;
    if (perRunRequests !== undefined && run.usage.requests >= perRunRequests)
      throw new AiBudgetExceeded('run', `${run.usage.requests} LLM requests (limit ${perRunRequests})`);
    if (perRunUsd !== undefined && run.costUsd >= perRunUsd)
      throw new AiBudgetExceeded('run', `~$${run.costUsd.toFixed(2)} (limit $${perRunUsd})`);
  }

  /** After a call: count it, and stop if it went over. */
  afterCall(usage: Usage): void {
    const cost = costOf(usage, this.pricing, this.key) ?? 0;
    this.stepCost += cost;
    run.costUsd += cost;
    run.usage = addUsage(run.usage, usage);
    const { perStepUsd } = this.limits;
    if (perStepUsd !== undefined && this.stepCost > perStepUsd)
      throw new AiBudgetExceeded('step', `~$${this.stepCost.toFixed(2)} (limit $${perStepUsd})`);
    this.beforeCall();
  }
}

const GUARDED = Symbol('aipw.budget');

/** The provider with every call counted against `guard`. Returns the provider itself when no limit is set. */
export function withBudget(provider: LlmProvider, guard: BudgetGuard): LlmProvider {
  if (!guard.active || (provider as { [GUARDED]?: boolean })[GUARDED]) return provider;
  return {
    id: provider.id,
    model: provider.model,
    capabilities: provider.capabilities,
    [GUARDED]: true,
    async decide(req, signal) {
      guard.beforeCall();
      const res = await provider.decide(req, signal);
      guard.afterCall(res.usage);
      return res;
    },
    async structured(req, signal) {
      guard.beforeCall();
      const res = await provider.structured(req, signal);
      guard.afterCall(res.usage);
      return res;
    },
    ...(provider.dispose && { dispose: () => provider.dispose!() }),
  } as LlmProvider;
}
