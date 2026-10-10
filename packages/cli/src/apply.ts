// Applying nudge remedies (docs/07 §6.5): hints go to hints/<host-port>.md, instruction / split / code
// remedies patch the spec. Nothing is written without the human choosing it; spec patches need an
// unchanged file.
import { writeHint, type PauseState } from '@aipw/core';
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

/** "1,3" / "a" (all) / "n" or "" (none) → option indexes. */
export function parseChoices(input: string, count: number): number[] | undefined {
  const t = input.trim().toLowerCase();
  if (t === '' || t === 'n') return [];
  if (t === 'a') return [...Array(count).keys()];
  const picks = t.split(/[\s,]+/).map(Number);
  return picks.every((n) => Number.isInteger(n) && n >= 1 && n <= count)
    ? [...new Set(picks.map((n) => n - 1))]
    : undefined;
}

export function formatRemedies(r: Remedies): string {
  const lines = [`Remedy — ${r.category}`, r.diagnosis, ''];
  r.options.forEach((o, i) => {
    lines.push(`  ${i + 1}  ${o.label}`);
    if (o.hint) lines.push(`       + ${o.hint.text}`);
    if (o.text) lines.push(`       + ${JSON.stringify(o.text)}`);
    for (const s of o.instructions ?? []) lines.push(`       + ${JSON.stringify(s)}`);
    for (const l of o.lines ?? []) lines.push(`       + ${l}`);
  });
  return lines.join('\n');
}

/** Applies the chosen options. Only one spec patch per step: the first chosen one wins. Returns a report. */
export function applyRemedies(r: Remedies, choices: number[], ctx: ApplyContext): string[] {
  const report: string[] = [];
  let patched = false;
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
    patched = result.ok;
  }
  return report;
}
