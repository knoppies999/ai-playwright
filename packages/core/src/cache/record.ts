// Turning a successful AI step into a plan (docs/06 §4): no refs (rule 11), no resolved values —
// literals that equal a data value become {{data.x}} again, so replays use the new run's data.
import type { ActionRecord, TargetDescriptor } from '../types.js';
import { urlPattern, type PlanAction, type PlanTarget, type StepPlan } from './plan.js';

export function toPlanTarget(t: TargetDescriptor): PlanTarget {
  return {
    ...(t.role !== undefined && { role: t.role }),
    ...(t.name !== undefined && { name: t.name }),
    locators: t.candidates.map((c) => ({ rung: c.rung, expr: c.expr, display: c.display })),
    ...(t.fingerprint && { fingerprint: t.fingerprint }),
  };
}

/** Replaces a whole-string data value with its placeholder. Longest values win, keys sorted for determinism. */
function toPlaceholder(value: string, data: Record<string, unknown>): string {
  if (value === '' || value.includes('{{')) return value;
  const match = Object.entries(data)
    .filter(([, v]) => (typeof v === 'string' || typeof v === 'number') && String(v) === value)
    .map(([k]) => k)
    .sort()[0];
  return match ? `{{data.${match}}}` : value;
}

const VALUE_FIELDS = new Set(['value', 'text', 'promptText']);

export function planArgs(args: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'ref' || k === 'intent') continue;
    if (VALUE_FIELDS.has(k) && typeof v === 'string') out[k] = toPlaceholder(v, data);
    else if (k === 'values' && Array.isArray(v))
      out[k] = v.map((x) => (typeof x === 'string' ? toPlaceholder(x, data) : x));
    else if (k === 'fields' && Array.isArray(v)) {
      out[k] = v.map((f: { value: string }) => ({ value: toPlaceholder(f.value, data) }));
    } else out[k] = v;
  }
  return out;
}

/** Tools that don't change the page are not replayed. */
const NOT_REPLAYED = new Set(['expand']);

export function planActions(records: ActionRecord[], data: Record<string, unknown>): PlanAction[] {
  return records
    .filter((r) => r.result === 'ok' && !NOT_REPLAYED.has(r.tool))
    .filter((r) => !(r.tool === 'wait_for' && r.args.ref)) // a ref-based wait has no durable target
    .map((r) => ({
      tool: r.tool,
      args: planArgs(r.args, data),
      ...(r.intent && { intent: r.intent }),
      ...(r.target && { target: toPlanTarget(r.target) }),
      ...(r.targets && { targets: r.targets.map(toPlanTarget) }),
    }));
}

export interface RecordContext {
  provider: string;
  model: string;
  now: Date;
  startUrl: string;
  endUrl: string;
}

export function planFromAct(
  instruction: string,
  records: ActionRecord[],
  data: Record<string, unknown>,
  ctx: RecordContext,
): StepPlan {
  return {
    kind: 'act',
    instruction,
    recordedWith: { provider: ctx.provider, model: ctx.model, at: ctx.now.toISOString() },
    pre: { urlPattern: urlPattern(ctx.startUrl) },
    post: { urlPattern: urlPattern(ctx.endUrl) },
    actions: planActions(records, data),
    stats: { heals: 0 },
  };
}
