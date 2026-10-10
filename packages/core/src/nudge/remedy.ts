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
import type { RemedyBasis, RemedyOption } from './protocol.js';
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
  /** Round 2 of verification: what went wrong with the previous suggestion (docs/07 §6.4). */
  feedback?: string;
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
    ...(input.feedback
      ? [`YOUR PREVIOUS SUGGESTION FAILED\n${input.feedback}\nSuggest something that avoids this.`]
      : []),
  ].join('\n\n');
}

/** The options offered to the human: hint (unless step-only), revised instruction, split, code. */
export function remedyOptions(remedy: Remedy, code: string[]): RemedyOption[] {
  const options: RemedyOption[] = [];
  if (remedy.hint && remedy.hint.scope !== 'step')
    options.push({ kind: 'hint', label: `Site hint (${remedy.hint.scope})`, hint: remedy.hint });
  options.push({ kind: 'instruction', label: 'Revised instruction', text: remedy.revisedInstruction });
  if (remedy.splitInto?.length)
    options.push({ kind: 'split', label: 'Split into steps', instructions: remedy.splitInto });
  if (code.length) options.push({ kind: 'code', label: 'Code (from the corrected actions)', lines: code });
  return options;
}

const label = (r: ActionRecord) => `${r.target?.role ?? 'element'}${r.target?.name ? ` "${r.target.name}"` : ''}`;

/**
 * Engine-computed facts about the correct target (docs/07 §6.2), so the diagnosis is concrete instead of guessed:
 * was it reached through a hover menu, does the instruction use its name, what did the agent pick instead.
 */
export function targetFacts(instruction: string, failed: ActionRecord[], corrected: ActionRecord[]): string[] {
  const facts: string[] = [];
  const targeted = corrected.filter((r) => r.target);
  const final = targeted[targeted.length - 1];
  if (!final) return facts;
  const hovers = targeted.slice(0, -1).filter((r) => r.tool === 'hover');
  if (hovers.length)
    facts.push(
      `${label(final)} was reached by hovering ${hovers.map(label).join(', then ')} first: it is in a menu that opens on hover.`,
    );
  const name = final.target!.name;
  if (name) {
    const words = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const said = new Set(words(instruction));
    const missing = words(name).filter((w) => !said.has(w));
    facts.push(
      missing.length
        ? `The element is ${label(final)}; the instruction does not use the words ${missing.map((w) => `"${w}"`).join(', ')}.`
        : `The instruction names the element correctly (${label(final)}).`,
    );
  }
  const wrong = [...new Set(failed.filter((r) => r.target && r.target.name !== name).map(label))];
  if (wrong.length) facts.push(`The agent chose ${wrong.join(', ')} instead.`);
  return facts;
}

/** The locator displays of the last action that had a target. */
export function finalTargets(records: ActionRecord[]): string[] {
  const last = [...records].reverse().find((r) => r.result === 'ok' && (r.target || r.targets?.length));
  if (!last) return [];
  return (last.target ? [last.target] : (last.targets ?? [])).flatMap((t) => t.candidates.map((c) => c.display));
}

const pageOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};

/**
 * Verification pass criteria (docs/07 §6.4): the candidate run touched the same final target as the corrected
 * run, or, when the corrected run navigated, ended on the same page.
 */
export function matchesBasis(
  records: ActionRecord[],
  finalUrl: string,
  basis: RemedyBasis,
): { ok: boolean; reason: string } {
  const targets = finalTargets(records);
  if (targets.some((t) => basis.finalTargets.includes(t))) return { ok: true, reason: 'reached the same final target' };
  if (pageOf(basis.finalUrl) !== pageOf(basis.startUrl) && pageOf(finalUrl) === pageOf(basis.finalUrl))
    return { ok: true, reason: `reached the same page (${pageOf(finalUrl)})` };
  const did = records.length ? records.map((r, i) => historyLine(i, r)).join('\n') : '(no actions)';
  return {
    ok: false,
    reason: `The AI ended on ${pageOf(finalUrl)} without touching the corrected target (${basis.finalTargets[0] ?? 'none'}). It did:\n${did}`,
  };
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
