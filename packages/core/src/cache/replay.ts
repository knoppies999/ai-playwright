// Replay (docs/06 §5): run a stored plan with plain Playwright, no model. Each target is found by trying
// its stored locators in order; the first that matches exactly one element wins.
import type { Locator, Page } from 'playwright-core';
import type { ActionExecutor } from '../actions/executor.js';
import { actTools, validateCall } from '../actions/schemas.js';
import type { EventBus } from '../events/bus.js';
import { buildLocator } from '../locators/expr.js';
import type { Observation } from '../observe/observer.js';
import type { ActionRecord } from '../types.js';
import { matchesUrlPattern, type PlanAction, type PlanTarget, type StepPlan } from './plan.js';

export class TargetNotFound extends Error {
  constructor(readonly target: PlanTarget) {
    super(`No stored locator matched ${target.role ?? 'element'}${target.name ? ` "${target.name}"` : ''}`);
  }
}

/** Tries each stored locator until one matches exactly one element, polling until `waitMs` passes. */
export async function resolveTarget(page: Page, target: PlanTarget, waitMs: number): Promise<Locator> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (const candidate of target.locators) {
      try {
        const loc = buildLocator(page, candidate.expr);
        if ((await loc.count()) === 1) return loc;
      } catch {
        // a malformed or stale expression: try the next one
      }
    }
    if (Date.now() >= deadline) throw new TargetNotFound(target);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A plan action becomes a normal tool call; refs are synthetic and map back to the plan's targets. */
export function toReplayCall(action: PlanAction): {
  tool: string;
  args: Record<string, unknown>;
  targets: Map<string, PlanTarget>;
} {
  const targets = new Map<string, PlanTarget>();
  const args: Record<string, unknown> = { ...action.args };
  if (action.target) {
    targets.set('@t', action.target);
    args.ref = '@t';
  } else if (['press', 'scroll'].includes(action.tool)) {
    args.ref = null;
  }
  if (action.tool === 'fill_form' && Array.isArray(args.fields)) {
    args.fields = (args.fields as { value: string }[]).map((f, i) => {
      const t = action.targets?.[i];
      if (t) targets.set(`@f${i}`, t);
      return { ref: `@f${i}`, value: f.value };
    });
  }
  if (action.tool !== 'expand') args.intent = action.intent ?? 'replay';
  return { tool: action.tool, args, targets };
}

export type ReplayResult =
  | { ok: true; records: ActionRecord[] }
  | { ok: false; records: ActionRecord[]; reason: string; failedAt: number; target?: PlanTarget };

export interface ReplayDeps {
  page: () => Page;
  executor: ActionExecutor;
  events: EventBus;
  stepId: string;
  /** How long a target may take to appear (rendering, animations). */
  waitMs: number;
}

const EMPTY_OBS = (url: string): Observation => ({
  url,
  title: '',
  tabs: [],
  dialogs: [],
  notices: [],
  snapshot: '',
  snapshotHash: 'replay',
  refs: new Set(),
  truncated: false,
  tree: [],
});

export async function replayAct(plan: StepPlan, deps: ReplayDeps): Promise<ReplayResult> {
  const records: ActionRecord[] = [];
  if (plan.pre && !matchesUrlPattern(deps.page().url(), plan.pre.urlPattern)) {
    return {
      ok: false,
      records,
      failedAt: 0,
      reason: `The page is not where the plan starts (${plan.pre.urlPattern}).`,
    };
  }
  const offered = actTools({ allowNavigation: true });
  for (const [i, action] of (plan.actions ?? []).entries()) {
    const { tool, args, targets } = toReplayCall(action);
    const validated = validateCall({ tool, args }, offered);
    if (!validated.ok)
      return { ok: false, records, failedAt: i, reason: `Stored action is invalid: ${validated.error}` };
    let missing: PlanTarget | undefined;
    const record = await deps.executor.execute(validated.call, EMPTY_OBS(deps.page().url()), async (ref) => {
      const target = targets.get(ref);
      if (!target) throw new Error(`Unknown replay ref ${ref}`);
      try {
        return await resolveTarget(deps.page(), target, deps.waitMs);
      } catch (error) {
        if (error instanceof TargetNotFound) missing = target;
        throw error;
      }
    });
    records.push(record);
    deps.events.emit({ type: 'action', stepId: deps.stepId, record });
    if (record.result !== 'ok') return { ok: false, records, failedAt: i, reason: record.result, target: missing };
  }
  if (plan.post) {
    const deadline = Date.now() + deps.waitMs;
    while (!matchesUrlPattern(deps.page().url(), plan.post.urlPattern)) {
      if (Date.now() >= deadline) {
        return {
          ok: false,
          records,
          failedAt: records.length,
          reason: `After replay the page is at ${deps.page().url()}, not ${plan.post.urlPattern}.`,
        };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return { ok: true, records };
}

/** One line per planned action, for the healing prompt. */
export function describePlan(plan: StepPlan): string {
  return (plan.actions ?? [])
    .map(
      (a) =>
        `${a.tool}${a.target ? ` ${a.target.role ?? 'element'}${a.target.name ? ` "${a.target.name}"` : ''}` : ''}`,
    )
    .join(' → ');
}
