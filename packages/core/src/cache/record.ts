import { TOOL_SCHEMAS } from '../actions/schemas.js';
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
function toPlaceholder(value: string, data: Record<string, unknown>, generated: Map<string, string>): string {
  if (value === '' || value.includes('{{')) return value;
  // A value the model got from generate_value: replay must generate a fresh one, not reuse this run's.
  const fromGenerator = generated.get(value);
  if (fromGenerator) return fromGenerator;
  const match = Object.entries(data)
    .filter(([, v]) => (typeof v === 'string' || typeof v === 'number') && String(v) === value)
    .map(([k]) => k)
    .sort()[0];
  return match ? `{{data.${match}}}` : value;
}

const VALUE_FIELDS = new Set(['value', 'text', 'promptText']);

export function planArgs(
  args: Record<string, unknown>,
  data: Record<string, unknown>,
  generated: Map<string, string> = new Map(),
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'ref' || k === 'intent') continue;
    if (VALUE_FIELDS.has(k) && typeof v === 'string') out[k] = toPlaceholder(v, data, generated);
    else if (k === 'values' && Array.isArray(v))
      out[k] = v.map((x) => (typeof x === 'string' ? toPlaceholder(x, data, generated) : x));
    else if (k === 'fields' && Array.isArray(v)) {
      out[k] = v.map((f: { value: string }) => ({ value: toPlaceholder(f.value, data, generated) }));
    } else out[k] = v;
  }
  return out;
}

/** Code tools: every string in the arguments is user data, so all of them are turned back into placeholders. */
function codeToolArgs(
  args: unknown,
  data: Record<string, unknown>,
  generated: Map<string, string>,
): Record<string, unknown> {
  const walk = (v: unknown): unknown =>
    typeof v === 'string'
      ? toPlaceholder(v, data, generated)
      : Array.isArray(v)
        ? v.map(walk)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
          : v;
  return walk(args) as Record<string, unknown>;
}

/** Tools that don't change the page are not replayed. */
const NOT_REPLAYED = new Set(['expand']);

/** Values produced by generate_value in this step → the placeholder that reproduces them on replay. */
function generatedPlaceholders(records: ActionRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) {
    if (r.tool !== 'generate_value' || r.result !== 'ok' || !r.output) continue;
    const as = r.args.as as string | null;
    map.set(
      r.output,
      as ? `{{values.${as}}}` : `{{gen.${r.args.kind as string}(${(r.args.params as string | null) ?? ''})}}`,
    );
  }
  return map;
}

export function planActions(records: ActionRecord[], data: Record<string, unknown>): PlanAction[] {
  const generated = generatedPlaceholders(records);
  return records
    .filter((r) => r.result === 'ok' && !NOT_REPLAYED.has(r.tool))
    .filter((r) => !(r.tool === 'wait_for' && r.args.ref)) // a ref-based wait has no durable target
    .map((r) => ({
      tool: r.tool,
      args: r.tool in TOOL_SCHEMAS ? planArgs(r.args, data, generated) : codeToolArgs(r.args, data, generated),
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
