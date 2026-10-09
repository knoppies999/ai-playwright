// Replay (docs/06 §5): run a stored plan with plain Playwright, no model. Each target is found by trying
// its stored locators in order; the first that matches exactly one element wins.
import type { Locator, Page } from 'playwright-core';
import type { ActionExecutor } from '../actions/executor.js';
import { actTools, validateCall } from '../actions/schemas.js';
import type { EventBus } from '../events/bus.js';
import { buildLocator } from '../locators/expr.js';
import { clearHealMarker, findByFingerprint, fingerprintOf } from '../locators/fingerprint.js';
import { synthesizeLocators, type SynthOptions } from '../locators/synth.js';
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

/** A target replaced by fingerprint healing: action index, and field index for fill_form. */
export interface HealedTarget {
  action: number;
  field?: number;
  before: PlanTarget;
  after: PlanTarget;
  score: number;
}

export type ReplayResult =
  | { ok: true; records: ActionRecord[]; healed: HealedTarget[] }
  | { ok: false; records: ActionRecord[]; reason: string; failedAt: number; target?: PlanTarget };

export interface ReplayDeps {
  page: () => Page;
  executor: ActionExecutor;
  events: EventBus;
  stepId: string;
  /** How long a target may take to appear (rendering, animations). */
  waitMs: number;
  /** Enables fingerprint healing (L8) when every stored locator fails. */
  fingerprintHeal?: { synth: Omit<SynthOptions, 'role' | 'name'> };
}

/** L8: find the element by fingerprint and give it fresh, verified locators. */
async function healByFingerprint(page: Page, target: PlanTarget, synth: Omit<SynthOptions, 'role' | 'name'>) {
  if (!target.fingerprint) return undefined;
  const match = await findByFingerprint(page, target.fingerprint);
  if (!match) return undefined;
  try {
    const after = await fingerprintOf(match.locator, target.role, undefined);
    const name = after?.label ?? after?.text ?? undefined;
    const candidates = await synthesizeLocators(page, match.locator, { ...synth, role: target.role, name });
    if (!candidates.length) return undefined;
    const healed: PlanTarget = {
      ...(target.role !== undefined && { role: target.role }),
      ...(name && { name }),
      locators: candidates.map((c) => ({ rung: c.rung, expr: c.expr, display: c.display })),
      ...(after && { fingerprint: { ...after, role: target.role ?? null, name: name ?? null } }),
    };
    return { target: healed, score: match.score };
  } finally {
    await clearHealMarker(page);
  }
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
  const healed: HealedTarget[] = [];
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
        if (!(error instanceof TargetNotFound)) throw error;
        const heal = deps.fingerprintHeal && (await healByFingerprint(deps.page(), target, deps.fingerprintHeal.synth));
        if (!heal) {
          missing = target;
          throw error;
        }
        healed.push({
          action: i,
          ...(ref.startsWith('@f') && { field: Number(ref.slice(2)) }),
          before: target,
          after: heal.target,
          score: heal.score,
        });
        return buildLocator(deps.page(), heal.target.locators[0]!.expr);
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
  return { ok: true, records, healed };
}

/** The plan with fingerprint-healed targets swapped in. */
export function applyHeals(plan: StepPlan, heals: HealedTarget[]): StepPlan {
  const actions = (plan.actions ?? []).map((a, i) => {
    const mine = heals.filter((h) => h.action === i);
    if (!mine.length) return a;
    const next: PlanAction = { ...a };
    for (const h of mine) {
      if (h.field === undefined) next.target = h.after;
      else next.targets = (next.targets ?? []).map((t, j) => (j === h.field ? h.after : t));
    }
    return next;
  });
  return { ...plan, actions };
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
