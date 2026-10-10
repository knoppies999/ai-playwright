// Plan file format (docs/06 §4), in Zod (AGENTS.md rule 3). One file per spec, committed and reviewed.
// Deviations from the doc sketch, decided in Phase 4:
// - locators are stored as structured LocatorExpr (interpreted, never eval'd) plus a readable `display`;
// - replays don't write stats (committed plans would change on every run); only heals do.
import { z } from 'zod';
import { LocatorExprSchema } from '../locators/expr.js';

export const PLAN_VERSION = 1;

export const PlanLocatorSchema = z.strictObject({
  rung: z.string(),
  expr: LocatorExprSchema,
  display: z.string(),
});

export const FingerprintSchema = z.strictObject({
  tag: z.string(),
  role: z.string().nullable(),
  name: z.string().nullable(),
  testIds: z.record(z.string(), z.string()),
  attrs: z.record(z.string(), z.string().nullable()),
  text: z.string(),
  label: z.string().nullable(),
  placeholder: z.string().nullable(),
  ancestors: z.array(z.strictObject({ role: z.string().nullable(), name: z.string().nullable() })),
  siblingIndex: z.number().int(),
  /** Relative to the viewport (0–1). */
  box: z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
});
export type Fingerprint = z.infer<typeof FingerprintSchema>;

export const PlanTargetSchema = z.strictObject({
  role: z.string().optional(),
  name: z.string().optional(),
  locators: z.array(PlanLocatorSchema),
  fingerprint: FingerprintSchema.optional(),
});
export type PlanTarget = z.infer<typeof PlanTargetSchema>;

export const PlanActionSchema = z.strictObject({
  tool: z.string(),
  /** Tool arguments without refs, with placeholders instead of data and secret values. */
  args: z.record(z.string(), z.unknown()),
  intent: z.string().optional(),
  target: PlanTargetSchema.optional(),
  /** fill_form: one target per field, in field order. */
  targets: z.array(PlanTargetSchema).optional(),
});
export type PlanAction = z.infer<typeof PlanActionSchema>;

export const CompiledCheckSchema = z.strictObject({
  /** Playwright web-first assertion, e.g. toBeVisible, toContainText, toHaveText, toHaveCount, toHaveURL. */
  expect: z.enum([
    'toBeVisible',
    'toBeHidden',
    'toContainText',
    'toHaveText',
    'toHaveCount',
    'toHaveURL',
    'toHaveValue',
  ]),
  target: PlanTargetSchema.optional(),
  args: z.array(z.union([z.string(), z.number()])),
  not: z.boolean().optional(),
});
export type CompiledCheck = z.infer<typeof CompiledCheckSchema>;

const UrlCheckSchema = z.strictObject({ urlPattern: z.string() });

const StepPlanBase = z.strictObject({
  kind: z.enum(['act', 'assert', 'extract', 'locate']),
  instruction: z.string(),
  recordedWith: z.strictObject({ provider: z.string(), model: z.string(), at: z.string() }),
  pre: UrlCheckSchema.optional(),
  post: UrlCheckSchema.optional(),
  /** act */
  actions: z.array(PlanActionSchema).optional(),
  /** assert: null means the condition couldn't be compiled and is always judged by AI. */
  compiled: z.array(CompiledCheckSchema).nullable().optional(),
  /** extract: for each leaf value, its JSON path ("" for a single value, "0.name", "total") and source element. */
  sources: z.array(z.strictObject({ path: z.string(), target: PlanTargetSchema })).optional(),
  /** locate */
  target: PlanTargetSchema.optional(),
  stats: z.strictObject({ heals: z.number().int(), lastHealAt: z.string().optional() }),
});

export const StepPlanSchema = StepPlanBase.extend({
  /** The last 3 replaced versions, newest first. */
  history: z.array(StepPlanBase).optional(),
});
export type StepPlan = z.infer<typeof StepPlanSchema>;

export const PlanFileSchema = z.strictObject({
  version: z.literal(PLAN_VERSION),
  /** Test title path ("describe > test") → step key → plan. */
  tests: z.record(z.string(), z.record(z.string(), StepPlanSchema)),
});
export type PlanFile = z.infer<typeof PlanFileSchema>;

export const emptyPlanFile = (): PlanFile => ({ version: PLAN_VERSION, tests: {} });

/** Sorted keys, 2-space indent, trailing newline: same content → byte-identical file (rule 7). */
export function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, sort(x)]),
      );
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** URL path with ids replaced by `*` (docs/06 §4), e.g. /users/1234/edit → /users/*\/edit. */
export function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27,}$|^[0-9a-f]{16,}$/i.test(seg) ? '*' : seg))
      .join('/');
    return `${u.origin}${path}`;
  } catch {
    return url;
  }
}

export function matchesUrlPattern(url: string, pattern: string): boolean {
  return urlPattern(url) === pattern;
}
