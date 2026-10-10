// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient *.md types for packages that typecheck core from source
/// <reference path="../md.d.ts" />
// Remedies (docs/07 §6): after a human corrects a step, offer a better step to keep — a revised instruction,
// a site hint, or Playwright code. Text remedies come from one structured() call; the code remedy is built
// deterministically from the corrected actions' verified locators, so it is correct by construction.
import { z } from 'zod';
import type { LlmProvider, Usage } from '../llm/provider.js';
import { historyLine } from '../loop/prompt.js';
import { structuredWithRepair } from '../step/structured.js';
import type { ActionRecord } from '../types.js';
import SYSTEM_REMEDY from '../loop/prompts/system-remedy.md';

export const RemedySchema = z.strictObject({
  diagnosis: z.string(),
  category: z.enum([
    'hidden-in-menu',
    'naming-mismatch',
    'ambiguous-target',
    'timing',
    'virtualized-or-offscreen',
    'needs-data',
    'wrong-page',
    'app-bug',
    'other',
  ]),
  revisedInstruction: z.string(),
  splitInto: z.array(z.string()).nullable(),
  hint: z
    .strictObject({
      scope: z.enum(['site', 'path', 'step']),
      pathPattern: z.string().nullable(),
      text: z.string(),
    })
    .nullable(),
});
export type Remedy = z.infer<typeof RemedySchema>;

export interface RemedyInput {
  instruction: string;
  /** What the agent did before the human stepped in. */
  failed: ActionRecord[];
  /** The corrected actions (after hint / pick / manual / edit / answer). */
  corrected: ActionRecord[];
  /** What the human said (hints, answers, edits), in order. */
  humanInput: string[];
  /** Engine-computed facts about the correct target (in snapshot? in a closed menu? name vs. wording…). */
  targetFacts: string[];
}

export function remedyPrompt(input: RemedyInput): string {
  const lines = (records: ActionRecord[]) =>
    records.length ? records.map((r, i) => historyLine(i, r)).join('\n') : '(none)';
  return [
    `ORIGINAL INSTRUCTION: ${input.instruction}`,
    `WHAT THE AGENT DID\n${lines(input.failed)}`,
    `CORRECT ACTIONS\n${lines(input.corrected)}`,
    `WHAT THE PERSON SAID\n${input.humanInput.length ? input.humanInput.map((h) => `- ${h}`).join('\n') : '(nothing)'}`,
    `FACTS ABOUT THE CORRECT TARGET\n${input.targetFacts.length ? input.targetFacts.map((f) => `- ${f}`).join('\n') : '(none)'}`,
  ].join('\n\n');
}

export async function synthesizeRemedy(
  provider: LlmProvider,
  input: RemedyInput,
): Promise<{ remedy: Remedy; usage: Usage }> {
  const { value, usage } = await structuredWithRepair(provider, {
    system: SYSTEM_REMEDY.trim(),
    prompt: remedyPrompt(input),
    schemaName: 'remedy',
    schema: RemedySchema,
  });
  return { remedy: value, usage };
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A value for generated code: literals stay literal; placeholders become a marked TODO the author fills in. */
function codeValue(v: string): string {
  return /\{\{.+\}\}/.test(v) ? `${quote(v)} /* TODO: replace placeholder */` : quote(v);
}

/**
 * Playwright code that repeats the corrected actions with their best verified locators (docs/07 §6.3).
 * Actions without a durable locator become comments rather than guesses.
 */
export function codeRemedy(records: ActionRecord[], pageVar = 'page'): string[] {
  const out: string[] = [];
  for (const r of records.filter((x) => x.result === 'ok')) {
    const args = r.args as Record<string, unknown>;
    const targets = r.tool === 'fill_form' ? (r.targets ?? []) : r.target ? [r.target] : [];
    const at = (i: number) => targets[i]?.candidates[0]?.display;
    const missing = (i: number) =>
      `// ${r.tool} ${targets[i]?.role ?? 'element'}${targets[i]?.name ? ` "${targets[i]!.name}"` : ''}: no durable locator, do this step by hand`;
    const call = (loc: string | undefined, i: number, method: string) =>
      out.push(loc ? `await ${pageVar}.${loc}.${method};` : missing(i));
    switch (r.tool) {
      case 'click':
        call(at(0), 0, args.clickCount === 2 ? 'dblclick()' : 'click()');
        break;
      case 'hover':
        call(at(0), 0, 'hover()');
        break;
      case 'fill':
        call(at(0), 0, `fill(${codeValue(String(args.value))})`);
        break;
      case 'type':
        call(at(0), 0, `pressSequentially(${codeValue(String(args.text))})`);
        if (args.submit) call(at(0), 0, "press('Enter')");
        break;
      case 'fill_form':
        (args.fields as { value: string }[]).forEach((f, i) => call(at(i), i, `fill(${codeValue(f.value)})`));
        break;
      case 'select_option':
        call(at(0), 0, `selectOption([${(args.values as string[]).map(codeValue).join(', ')}])`);
        break;
      case 'set_checked':
        call(at(0), 0, `setChecked(${String(args.checked)})`);
        break;
      case 'press':
        if (r.target) call(at(0), 0, `press(${quote(String(args.key))})`);
        else out.push(`await ${pageVar}.keyboard.press(${quote(String(args.key))});`);
        break;
      case 'go_back':
        out.push(`await ${pageVar}.goBack();`);
        break;
      default:
        out.push(`// ${r.tool}: not expressible as code; keep it as an AI step`);
    }
  }
  return out;
}
