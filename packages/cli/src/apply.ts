// Verifying and applying nudge remedies (docs/07 §6.4–6.5). Verification: each text candidate is tried by a fresh
// run of the test that fast-forwards to the step and does it with AI only, no human help (one more round with
// feedback if it fails). Applying: hints go to hints/<host-port>.md, instruction / split / code remedies patch
// the spec. Nothing is written without the human choosing it; spec patches need an unchanged file.
import { writeHint, type PauseState, type RemedyOption, type Verification, type VerifyJob } from '@aipw/core';
import { patchFile, type Patch } from './patch.js';

type Remedies = NonNullable<PauseState['remedies']>;

export interface ApplyContext {
  /** Spec file on disk and its hash when the session started. */
  specPath: string;
  specHash: string;
  /** The step: its original instruction and the line it was called from. */
  instruction: string;
  line: number;
  hintsDir: string;
}

/** Text candidates are verified; code is correct by construction (docs/07 §6.3). */
export const isVerifiable = (o: RemedyOption) => o.kind !== 'code';

/**
 * Verifies each text candidate with `run` (one test run per call), at most two rounds each: a failure is fed back
 * into one more synthesis (docs/07 §6.4). A candidate that passes in round 2 replaces the original.
 */
export async function verifyRemedies(
  state: PauseState,
  run: (job: VerifyJob) => Promise<Verification | undefined>,
  log: (line: string) => void = () => undefined,
): Promise<Remedies> {
  const remedies = state.remedies!;
  if (!remedies.basis) return remedies;
  const options: RemedyOption[] = [];
  for (const option of remedies.options) {
    if (!isVerifiable(option)) {
      options.push(option);
      continue;
    }
    let feedback: string | undefined;
    let result: RemedyOption | undefined;
    for (let round = 1; round <= 2 && !result; round++) {
      log(`Verifying "${option.label}"${round === 2 ? ' (round 2, with feedback)' : ''}…`);
      const v = await run({
        step: state.step.index,
        instruction: state.step.instruction,
        option,
        basis: remedies.basis,
        ...(feedback && { feedback }),
      });
      if (v?.ok) result = { ...v.option, verified: true, verifyNote: v.reason };
      else if (round === 1) feedback = v?.reason ?? 'The run ended before reaching the step.';
      else result = { ...option, verified: false, verifyNote: v?.reason ?? 'The run ended before reaching the step.' };
    }
    log(`  ${result!.verified ? '✅ verified' : '❌ not verified'}`);
    options.push(result!);
  }
  return { ...remedies, options };
}

/** "1,3" / "a" (all, except candidates that failed verification) / "n" or "" (none) → option indexes. */
export function parseChoices(input: string, options: RemedyOption[]): number[] | undefined {
  const t = input.trim().toLowerCase();
  if (t === '' || t === 'n') return [];
  if (t === 'a') return options.flatMap((o, i) => (o.verified === false ? [] : [i]));
  const picks = t.split(/[\s,]+/).map(Number);
  return picks.every((n) => Number.isInteger(n) && n >= 1 && n <= options.length)
    ? [...new Set(picks.map((n) => n - 1))]
    : undefined;
}

const mark = (o: RemedyOption) => (o.verified === true ? '✅' : o.verified === false ? '❌' : '● ');

export function formatRemedies(r: Remedies): string {
  const lines = [`Remedy — ${r.category}`, r.diagnosis, ''];
  r.options.forEach((o, i) => {
    lines.push(`  ${i + 1} ${mark(o)} ${o.label}`);
    if (o.hint) lines.push(`       + ${o.hint.text}`);
    if (o.text) lines.push(`       + ${JSON.stringify(o.text)}`);
    for (const s of o.instructions ?? []) lines.push(`       + ${JSON.stringify(s)}`);
    for (const l of o.lines ?? []) lines.push(`       + ${l}`);
    if (o.verified === false && o.verifyNote) lines.push(`       ✗ ${o.verifyNote.split('\n')[0]}`);
  });
  return lines.join('\n');
}

/** How many AI steps a spec patch adds (split) or removes (code) at this step, for resuming after it. */
export function stepShift(patch: Patch | undefined): number {
  if (!patch) return 0;
  return patch.kind === 'split' ? patch.instructions.length - 1 : patch.kind === 'code' ? -1 : 0;
}

/** Applies the chosen options. Only one spec patch per step: the first chosen one wins. */
export function applyRemedies(
  r: Remedies,
  choices: number[],
  ctx: ApplyContext,
): { report: string[]; patched?: Patch } {
  const report: string[] = [];
  let patched: Patch | undefined;
  for (const i of choices) {
    const o = r.options[i]!;
    if (o.kind === 'hint' && o.hint) {
      const file = writeHint(ctx.hintsDir, r.pageUrl, {
        scope: o.hint.scope === 'path' ? 'path' : 'site',
        pathPattern: o.hint.pathPattern,
        text: o.hint.text,
      });
      report.push(`Hint added to ${file}`);
      continue;
    }
    if (patched) {
      report.push(`Skipped "${o.label}": the spec was already patched for this step`);
      continue;
    }
    const patch: Patch | undefined =
      o.kind === 'instruction' && o.text
        ? { kind: 'instruction', text: o.text }
        : o.kind === 'split' && o.instructions
          ? { kind: 'split', instructions: o.instructions }
          : o.kind === 'code' && o.lines
            ? { kind: 'code', lines: o.lines }
            : undefined;
    if (!patch) continue;
    const result = patchFile(ctx.specPath, ctx.specHash, { instruction: ctx.instruction, line: ctx.line }, patch);
    report.push(result.ok ? `Patched ${ctx.specPath}:\n${result.diff}` : `Not applied: ${result.error}`);
    if (result.ok) patched = patch;
  }
  return { report, ...(patched && { patched }) };
}
