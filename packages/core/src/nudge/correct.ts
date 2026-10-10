// Human corrections at a decision pause (docs/07 §4): pick the right element in the browser, soft undo of the last
// action, and the AI's top alternatives. Each produces an ordinary tool call that the executor runs, so the
// corrected trajectory is recorded with verified locators like any AI action.
import type { Page } from 'playwright-core';
import { z } from 'zod';
import type { AnyToolCall } from '../actions/schemas.js';
import type { LlmProvider, Usage } from '../llm/provider.js';
import { historyLine, SYSTEM_PROMPTS } from '../loop/prompt.js';
import type { Observation } from '../observe/observer.js';
import { findByRef, type SnapNode } from '../observe/snapshot.js';
import { structuredWithRepair } from '../step/structured.js';
import type { ActionRecord } from '../types.js';
import { PickToolSchema, type PauseState, type PickTool } from './protocol.js';

const PICKED = 'data-aipw-picked';
const BY_PERSON = 'chosen by the person running the test';

/** A tool call for `tool` on `ref`, with the strict-schema nulls filled in. */
export function callFor(tool: PickTool, ref: string, value: string | null, intent = BY_PERSON): AnyToolCall {
  if (tool === 'fill') return { tool, args: { ref, value: value ?? '', intent } } as AnyToolCall;
  if (tool === 'hover') return { tool, args: { ref, intent } } as AnyToolCall;
  return { tool, args: { ref, button: null, modifiers: null, clickCount: null, intent } } as AnyToolCall;
}

/**
 * Waits for the human to click an element in the (headed) browser. The click is swallowed, so the app doesn't
 * react to it; hovering outlines the element under the pointer. Resolves when an element is marked.
 */
export async function waitForPick(page: Page): Promise<void> {
  await page.evaluate(
    (marker) =>
      new Promise<void>((resolve) => {
        document.querySelectorAll(`[${marker}]`).forEach((e) => e.removeAttribute(marker));
        let last: HTMLElement | undefined;
        let lastOutline = '';
        const restore = () => {
          if (last) last.style.outline = lastOutline;
        };
        const over = (e: Event) => {
          restore();
          last = e.target as HTMLElement;
          lastOutline = last.style.outline;
          last.style.outline = '2px solid #e5484d';
        };
        const block = (e: Event) => {
          e.preventDefault();
          e.stopImmediatePropagation();
        };
        const click = (e: Event) => {
          block(e);
          restore();
          for (const [type, fn] of handlers) document.removeEventListener(type, fn, true);
          (e.target as Element).setAttribute(marker, '');
          delete (window as { __aipwPicking?: boolean }).__aipwPicking;
          resolve();
        };
        const handlers: [string, (e: Event) => void][] = [
          ['mouseover', over],
          ['pointerdown', block],
          ['mousedown', block],
          ['pointerup', block],
          ['mouseup', block],
          ['click', click],
        ];
        for (const [type, fn] of handlers) document.addEventListener(type, fn, true);
        // Lets tests (and other UIs) see that the picker is waiting.
        (window as { __aipwPicking?: boolean }).__aipwPicking = true;
      }),
    PICKED,
  );
}

function refsOf(nodes: SnapNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.ref) out.push(n.ref);
    refsOf(n.children, out);
  }
  return out;
}

/**
 * The snapshot ref of the picked element: the element itself, or its closest ancestor that has a ref (a click on
 * the text inside a button picks the button). Adds it to the refs the executor accepts.
 */
export async function pickedRef(page: Page, obs: Observation): Promise<string | undefined> {
  const distances = await Promise.all(
    refsOf(obs.tree).map(async (ref) => {
      const d = await page
        .locator(`aria-ref=${ref}`)
        .evaluate((el, marker) => {
          const picked = document.querySelector(`[${marker}]`);
          if (!picked || !el.contains(picked)) return -1;
          let n = 0;
          for (let e: Element | null = picked; e && e !== el; e = e.parentElement) n++;
          return n;
        }, PICKED)
        .catch(() => -1);
      return { ref, d };
    }),
  );
  await page.evaluate((m) => document.querySelector(`[${m}]`)?.removeAttribute(m), PICKED).catch(() => undefined);
  const best = distances.filter((x) => x.d >= 0).sort((a, b) => a.d - b.d)[0];
  if (best) obs.refs.add(best.ref);
  return best?.ref;
}

/**
 * Soft undo (docs/07 §5.1): reverses the last page action where it can (back if the URL changed, otherwise
 * Escape for opened menus and dialogs) and marks it rejected, so the model sees it as wrong.
 */
export async function softUndo(page: Page, history: ActionRecord[], isPassive: (r: ActionRecord) => boolean) {
  const last = [...history].reverse().find((r) => r.result === 'ok' && !isPassive(r));
  if (!last) return undefined;
  if (last.after.url !== last.before.url) await page.goBack().catch(() => undefined);
  else await page.keyboard.press('Escape').catch(() => undefined);
  last.result = 'undone by the person running the test: that was wrong, do not repeat it';
  return last;
}

const AlternativesSchema = z.strictObject({
  options: z
    .array(
      z.strictObject({
        ref: z.string(),
        tool: PickToolSchema,
        value: z.string().nullable(),
        why: z.string(),
      }),
    )
    .max(3),
});

export type Alternatives = NonNullable<PauseState['alternatives']>;

/** The prompt for the o command: instruction, history, the rejected action, the page. */
export function alternativesPrompt(
  instruction: string,
  history: ActionRecord[],
  rejected: { tool: string; ref?: string; intent?: string },
  obs: Observation,
): string {
  return [
    `INSTRUCTION: ${instruction}`,
    `SO FAR\n${history.length ? history.map((r, i) => historyLine(i, r)).join('\n') : '(nothing)'}`,
    `REJECTED: ${rejected.tool}${rejected.ref ? ` [${rejected.ref}]` : ''}${rejected.intent ? ` (${rejected.intent})` : ''}`,
    `PAGE ${obs.url}\n${obs.snapshot}`,
  ].join('\n\n');
}

/** The AI's top alternative targets, keeping only refs that exist on the page and differ from the rejected one. */
export async function alternatives(
  provider: LlmProvider,
  instruction: string,
  history: ActionRecord[],
  rejected: { tool: string; ref?: string; intent?: string },
  obs: Observation,
): Promise<{ alternatives: Alternatives; usage: Usage }> {
  const { value, usage } = await structuredWithRepair(provider, {
    system: SYSTEM_PROMPTS.options,
    prompt: alternativesPrompt(instruction, history, rejected, obs),
    schemaName: 'alternatives',
    schema: AlternativesSchema,
  });
  const out: Alternatives = [];
  for (const o of value.options) {
    const found = findByRef(obs.tree, o.ref)?.node;
    if (!found || o.ref === rejected.ref) continue;
    out.push({ ...o, ...(found.role && { role: found.role }), ...(found.name && { name: found.name }) });
  }
  return { alternatives: out, usage };
}
