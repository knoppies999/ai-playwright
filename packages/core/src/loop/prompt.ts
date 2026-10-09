// Ambient `*.md` module types, needed when other packages typecheck core from source.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../md.d.ts" />
// Prompt builder (docs/04 §4). The prompt is rebuilt every turn, ordered from most stable to most
// volatile for prompt caching: system → tools → hints → task → history → observation.
import type { Observation } from '../observe/observer.js';
import type { ActionRecord, StepContext } from '../types.js';
import SYSTEM_ACT from './prompts/system-act.md';
import SYSTEM_ASSERT from './prompts/system-assert.md';
import SYSTEM_EXTRACT from './prompts/system-extract.md';
import SYSTEM_LOCATE from './prompts/system-locate.md';

export const SYSTEM_PROMPTS = {
  act: SYSTEM_ACT.trim(),
  assert: SYSTEM_ASSERT.trim(),
  extract: SYSTEM_EXTRACT.trim(),
  locate: SYSTEM_LOCATE.trim(),
} as const;

export interface HistoryEntry {
  record: ActionRecord;
}

function describeTarget(r: ActionRecord): string {
  const t = r.target;
  if (!t) return '';
  return ` ${t.role ?? 'element'}${t.name ? ` "${t.name}"` : ''} [${t.ref}]`;
}

/** One line per action already taken in this step, e.g. `#2 hover button "Settings" [e7] → ok`. */
export function historyLine(index: number, r: ActionRecord): string {
  const args = Object.entries(r.args)
    .filter(([k, v]) => !['ref', 'intent'].includes(k) && v !== null)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  const intent = r.intent ? ` (${r.intent})` : '';
  const result = r.result === 'ok' ? 'ok' : `FAILED: ${r.result}`;
  return `#${index + 1} ${r.tool}${describeTarget(r)}${args ? ` ${args}` : ''}${intent} → ${result}`;
}

export interface ContextInput {
  step: StepContext;
  hints: string[];
  secretPlaceholders: string[];
  history: ActionRecord[];
}

export function buildContext({ step, hints, secretPlaceholders, history }: ContextInput): string {
  const parts: string[] = [];
  if (hints.length) parts.push(`HINTS\n${hints.map((h) => `- ${h}`).join('\n')}`);
  const data = step.options.data ?? {};
  parts.push(
    [
      'TASK',
      `kind: ${step.kind}`,
      `instruction: ${step.instruction}`,
      Object.keys(data).length
        ? `DATA (use these values exactly; you may also write {{data.<key>}}):\n${JSON.stringify(data, null, 2)}`
        : 'DATA: none',
      secretPlaceholders.length
        ? `SECRETS (pass these placeholders verbatim; you never see the values): ${secretPlaceholders.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  parts.push(
    history.length
      ? `HISTORY (actions already taken in this step)\n${history.map((r, i) => historyLine(i, r)).join('\n')}`
      : 'HISTORY: no actions yet in this step',
  );
  return parts.join('\n\n');
}

export function buildObservation(obs: Observation, extras: { lastResult?: string; expanded?: string } = {}): string {
  const lines = ['PAGE', `url: ${obs.url}`, `title: ${obs.title}`];
  if (obs.tabs.length > 1) {
    lines.push('tabs:', ...obs.tabs.map((t) => `  [${t.index}]${t.active ? ' (active)' : ''} ${t.title} — ${t.url}`));
  }
  for (const d of obs.dialogs) lines.push(`native dialog open: ${d.type} "${d.message}" (call handle_dialog)`);
  if (obs.notices.length) lines.push(`notices since the last action: ${obs.notices.map((n) => `"${n}"`).join(', ')}`);
  if (extras.lastResult) lines.push(`last action result: ${extras.lastResult}`);
  lines.push('', 'SNAPSHOT', obs.snapshot);
  if (extras.expanded) lines.push('', 'EXPANDED (requested with expand)', extras.expanded);
  return lines.join('\n');
}
