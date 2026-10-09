// The action vocabulary (docs/04 §2), defined once in Zod. JSON Schema is generated from these.
// Strict-schema rules (docs/05 §2.1): every property required, optional = nullable, no top-level oneOf.
import { z } from 'zod';
import type { JsonSchema, ToolSpec } from '../llm/provider.js';

const ref = z.string().describe('Element ref from the current snapshot, e.g. "e12" or "f1e3"');
const intent = z.string().describe('What this action is trying to do, in at most 15 words');

export const TOOL_SCHEMAS = {
  click: z.strictObject({
    ref,
    button: z.enum(['left', 'right', 'middle']).nullable().describe('Default left'),
    modifiers: z
      .array(z.enum(['Alt', 'Control', 'Meta', 'Shift']))
      .nullable()
      .describe('Keys held during the click'),
    clickCount: z.number().int().min(1).max(3).nullable().describe('2 for a double click'),
    intent,
  }),
  hover: z.strictObject({ ref, intent }),
  fill: z.strictObject({
    ref,
    value: z.string().describe('Text to put in the field. May contain {{data.x}} or {{secret.x}} placeholders'),
    intent,
  }),
  type: z.strictObject({
    ref,
    text: z.string().describe('Typed key by key, for widgets that need key events (comboboxes)'),
    submit: z.boolean().nullable().describe('Press Enter afterwards'),
    intent,
  }),
  fill_form: z.strictObject({
    fields: z
      .array(z.strictObject({ ref, value: z.string() }))
      .min(1)
      .describe('Several simple fields at once'),
    intent,
  }),
  select_option: z.strictObject({
    ref,
    values: z.array(z.string()).min(1).describe('Option labels or values of a native <select>'),
    intent,
  }),
  set_checked: z.strictObject({ ref, checked: z.boolean(), intent }),
  press: z.strictObject({
    key: z.string().describe('A key or chord, e.g. "Enter", "Escape", "Control+A"'),
    ref: ref.nullable().describe('Element to focus first, or null for the focused element'),
    intent,
  }),
  scroll: z.strictObject({
    ref: ref.nullable().describe('Scrollable element, or null for the page'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().min(0.1).max(10).nullable().describe('Screens to scroll, default 1'),
    intent,
  }),
  wait_for: z.strictObject({
    text: z.string().nullable().describe('Wait until this text is visible'),
    ref: ref.nullable(),
    state: z.enum(['visible', 'hidden']).nullable().describe('For ref: wait for this state, default visible'),
    ms: z.number().int().min(0).max(10_000).nullable().describe('Fixed wait, only if nothing else fits'),
    intent,
  }),
  expand: z.strictObject({ ref: ref.describe('Ref of a truncated subtree to show in full') }),
  handle_dialog: z.strictObject({
    accept: z.boolean(),
    promptText: z.string().nullable(),
    intent,
  }),
  switch_tab: z.strictObject({ index: z.number().int().min(0), intent }),
  go_back: z.strictObject({ intent }),
  navigate: z.strictObject({ url: z.string().describe('Absolute URL on an allowed origin'), intent }),
  generate_value: z.strictObject({
    kind: z
      .string()
      .describe(
        'email, phone, saId, luhn, testCard, iban, vatNumber, date, uuid, slug, words, firstName, lastName, or a custom generator',
      ),
    params: z
      .string()
      .nullable()
      .describe(
        'JSON object of options, e.g. {"born":"1990-04-12","gender":"F"} for saId, {"country":"ZA"} for phone or iban',
      ),
    as: z.string().nullable().describe('Name to keep the value under, usable later as {{values.<name>}}'),
    intent,
  }),
  done: z.strictObject({
    summary: z.string().describe('What was done'),
    evidence: z.array(z.string()).describe('Text quoted from the page that shows the step succeeded'),
  }),
  fail: z.strictObject({
    kind: z.enum(['not_found', 'ambiguous', 'blocked', 'unexpected_state']),
    reason: z.string(),
  }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export type ToolArgs<K extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[K]>;
export type ToolCall = { [K in ToolName]: { tool: K; args: ToolArgs<K> } }[ToolName];

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  click: 'Click an element.',
  hover: 'Move the mouse over an element, e.g. to open a hover menu. The pointer stays there.',
  fill: 'Replace the contents of a text field.',
  type: 'Type into a field key by key (for comboboxes and widgets that react to key presses).',
  fill_form: 'Fill several simple text fields in one action.',
  select_option: 'Choose options in a native <select> element. Custom dropdowns need click instead.',
  set_checked: 'Check or uncheck a checkbox, radio button or switch.',
  press: 'Press a key or key chord.',
  scroll: 'Scroll the page or an element, for lazy loading and long lists.',
  wait_for: 'Wait for text or an element to appear or disappear, when the page is still loading.',
  expand: 'Show the full snapshot of a truncated subtree. Does not touch the page.',
  handle_dialog: 'Accept or dismiss the native browser dialog (alert, confirm, prompt) that is open.',
  switch_tab: 'Make another open tab active.',
  go_back: 'Go back in browser history.',
  navigate: 'Open a URL. Only allowed origins.',
  generate_value:
    'Get a valid test value (SA ID number, IBAN, card number, email, phone…) from a generator instead of inventing one. The value appears in the history.',
  done: 'Finish the step: it is complete. Quote page text that shows success.',
  fail: 'Stop: the step cannot be completed. Use the most specific kind.',
};

/** Tools that end a step. They don't take `intent` and are never executed on the page. */
export const TERMINAL_TOOLS = new Set<ToolName>(['done', 'fail']);

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  // Zod adds "$schema": draft 2020-12, which some providers reject (spike 0.5b). Tool schemas don't need it.
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as JsonSchema;
  return rest;
}

export function toolSpecs(names: readonly ToolName[]): ToolSpec[] {
  return names.map((name) => ({
    name,
    description: TOOL_DESCRIPTIONS[name],
    schema: TOOL_SCHEMAS[name],
    jsonSchema: toJsonSchema(TOOL_SCHEMAS[name]),
  }));
}

/** The tools offered for `ai.act`. `navigate` only when the step allows navigation. */
export function actTools(options: { allowNavigation: boolean }): ToolName[] {
  const all = Object.keys(TOOL_SCHEMAS) as ToolName[];
  return all.filter((t) => t !== 'navigate' || options.allowNavigation);
}

/** A user-registered function the model may call (docs/03 §7). */
export interface CodeTool {
  name: string;
  description: string;
  input: z.ZodObject;
  run: (args: Record<string, unknown>) => unknown;
}

/** A validated call to a code tool. Built-in calls never carry `code`. */
export interface CodeToolCall {
  tool: string;
  args: Record<string, unknown>;
  code: true;
}

export type AnyToolCall = ToolCall | CodeToolCall;
export const isCodeCall = (call: AnyToolCall): call is CodeToolCall => 'code' in call;

export function codeToolSpecs(tools: Iterable<CodeTool>): ToolSpec[] {
  return [...tools].map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.input,
    jsonSchema: toJsonSchema(t.input),
  }));
}

export type ValidatedCall = { ok: true; call: AnyToolCall } | { ok: false; error: string };

/** Validates a raw provider call against the offered tools. */
/**
 * Forgiving fixes for shapes models commonly get slightly wrong, applied before validation. Live runs 2–3
 * on SauceDemo needed a repair turn (~4 s) for 5 of 90 done calls; evidence as one string is the usual cause.
 */
function normaliseArgs(tool: string, args: unknown): unknown {
  if (tool === 'done' && args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    if (typeof a.evidence === 'string') return { ...a, evidence: [a.evidence] };
    if (a.evidence === undefined || a.evidence === null) return { ...a, evidence: [] };
  }
  return args;
}

export function validateCall(
  call: { tool: string; args: unknown },
  offered: readonly string[],
  codeTools?: ReadonlyMap<string, CodeTool>,
): ValidatedCall {
  const code = codeTools?.get(call.tool);
  if (code && offered.includes(call.tool)) {
    const parsed = code.input.safeParse(call.args);
    if (!parsed.success)
      return { ok: false, error: `Invalid arguments for ${call.tool}: ${z.prettifyError(parsed.error)}` };
    return { ok: true, call: { tool: call.tool, args: parsed.data as Record<string, unknown>, code: true } };
  }
  if (!offered.includes(call.tool) || !(call.tool in TOOL_SCHEMAS)) {
    return { ok: false, error: `Unknown tool "${call.tool}". Use one of: ${offered.join(', ')}.` };
  }
  const result = TOOL_SCHEMAS[call.tool as ToolName].safeParse(normaliseArgs(call.tool, call.args));
  if (!result.success)
    return { ok: false, error: `Invalid arguments for ${call.tool}: ${z.prettifyError(result.error)}` };
  return { ok: true, call: { tool: call.tool, args: result.data } as ToolCall };
}
