// Manual mode recorder (docs/07 §4 m, §6.2): while the human acts in the headed browser, capture-phase listeners
// report what they do. Elements are described (role, name, verified locators) as soon as they are touched
// (pointerdown, focus, hover dwell), before a click can navigate away. Events are merged into ordinary
// ActionRecords, so the corrected trajectory feeds plans, remedies and code like AI actions.
import type { Locator, Page } from 'playwright-core';
import type { ActionRecord, TargetDescriptor } from '../types.js';

const BINDING = '__aipwRecord';
const MARK = 'data-aipw-rec';
const BY_HAND = 'done by hand by the person running the test';

export interface RawManualEvent {
  kind: 'touch' | 'click' | 'fill' | 'hover' | 'select' | 'check' | 'press';
  /** The element's recorder id (its data-aipw-rec value); 0 for keys with nothing focused. */
  id: number;
  url: string;
  value?: string;
  values?: string[];
  checked?: boolean;
  key?: string;
  password?: boolean;
}

/**
 * Merges raw events into actions: typing into one field is one fill (the last value), a click into a field that is
 * then typed into, selected or checked is dropped, and touches only serve to describe elements.
 */
export function mergeManualEvents(events: RawManualEvent[]): RawManualEvent[] {
  const out: RawManualEvent[] = [];
  for (const e of events) {
    if (e.kind === 'touch') continue;
    const prev = out[out.length - 1];
    if (prev && prev.id === e.id && e.id !== 0) {
      if (e.kind === 'fill' && prev.kind === 'fill') {
        out[out.length - 1] = e;
        continue;
      }
      if (prev.kind === 'click' && (e.kind === 'fill' || e.kind === 'select' || e.kind === 'check')) {
        out[out.length - 1] = e;
        continue;
      }
      if (prev.kind === 'hover' && e.kind === 'hover') continue;
      // A click on a checkbox fires click then change: keep the change.
      if (prev.kind === 'check' && e.kind === 'click') continue;
    }
    out.push(e);
  }
  return out;
}

/** An ActionRecord with the arguments the tool schemas expect, so the action replays from a plan. */
export function manualRecord(e: RawManualEvent, target: TargetDescriptor | undefined): ActionRecord | undefined {
  const ref = 'manual';
  const intent = BY_HAND;
  const base = {
    intent,
    result: 'ok',
    before: { url: e.url, snapshotHash: '' },
    after: { url: e.url },
    durationMs: 0,
  };
  const on = (tool: string, args: Record<string, unknown>): ActionRecord => ({
    tool,
    args,
    ...(target && { target }),
    ...base,
  });
  switch (e.kind) {
    case 'click':
      return on('click', { ref, button: null, modifiers: null, clickCount: null, intent });
    case 'hover':
      return on('hover', { ref, intent });
    case 'fill':
      // A password typed by hand never reaches a record, a plan or a remedy (docs/07 §9).
      return on('fill', { ref, value: e.password ? '{{secret.?}}' : (e.value ?? ''), intent });
    case 'select':
      return on('select_option', { ref, values: e.values ?? [], intent });
    case 'check':
      return on('set_checked', { ref, checked: !!e.checked, intent });
    case 'press':
      return { tool: 'press', args: { key: e.key ?? '', ref: null, intent }, ...base };
    default:
      return undefined;
  }
}

/** The in-page half: listeners that tag elements and report events through the binding. */
function installRecorder({ binding, mark }: { binding: string; mark: string }) {
  type W = Window & { [k: string]: unknown };
  const w = window as unknown as W;
  if (w.__aipwRecorderStop) return;
  let next = Number(w.__aipwRecNext ?? 0);
  const send = (e: Record<string, unknown>) =>
    (w[binding] as (e: unknown) => Promise<void>)({ ...e, url: location.href }).catch(() => undefined);
  const idOf = (el: Element | null): number => {
    if (!el) return 0;
    let id = Number(el.getAttribute(mark));
    if (!id) {
      id = ++next;
      w.__aipwRecNext = next;
      el.setAttribute(mark, String(id));
    }
    return id;
  };
  const actionable = (t: EventTarget | null) =>
    t instanceof Element
      ? (t.closest('a,button,input,select,textarea,summary,label,[role],[onclick],[tabindex]') ?? t)
      : null;
  const isField = (el: Element) =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);
  let dwell: ReturnType<typeof setTimeout> | undefined;
  const handlers: [string, (e: Event) => void][] = [
    ['pointerdown', (e) => send({ kind: 'touch', id: idOf(actionable(e.target)) })],
    ['focusin', (e) => send({ kind: 'touch', id: idOf(actionable(e.target)) })],
    ['click', (e) => send({ kind: 'click', id: idOf(actionable(e.target)) })],
    [
      'input',
      (e) => {
        const el = e.target as Element;
        if (!isField(el)) return;
        const value =
          el instanceof HTMLElement && el.isContentEditable ? el.textContent : (el as HTMLInputElement).value;
        // A password's value never leaves the page.
        const password = el instanceof HTMLInputElement && el.type === 'password';
        send({ kind: 'fill', id: idOf(el), password, ...(!password && { value }) });
      },
    ],
    [
      'change',
      (e) => {
        const el = e.target as Element;
        if (el instanceof HTMLSelectElement)
          send({ kind: 'select', id: idOf(el), values: [...el.selectedOptions].map((o) => o.label) });
        else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio'))
          send({ kind: 'check', id: idOf(el), checked: el.checked });
      },
    ],
    [
      'keydown',
      (e) => {
        const key = (e as KeyboardEvent).key;
        if (['Enter', 'Escape', 'Tab'].includes(key))
          send({
            kind: 'press',
            id: idOf(document.activeElement === document.body ? null : document.activeElement),
            key,
          });
      },
    ],
    [
      'mouseover',
      (e) => {
        clearTimeout(dwell);
        const menu = e.target instanceof Element ? e.target.closest('[aria-haspopup],[aria-expanded]') : null;
        if (!menu) return;
        // Hover menus: a pointer resting 300 ms on an element that opens something is recorded as a hover.
        dwell = setTimeout(() => {
          send({ kind: 'touch', id: idOf(menu) });
          send({ kind: 'hover', id: idOf(menu) });
        }, 300);
      },
    ],
    ['mouseout', () => clearTimeout(dwell)],
  ];
  for (const [type, fn] of handlers) document.addEventListener(type, fn, true);
  w.__aipwRecorderStop = () => {
    clearTimeout(dwell);
    for (const [type, fn] of handlers) document.removeEventListener(type, fn, true);
    document.querySelectorAll(`[${mark}]`).forEach((el) => el.removeAttribute(mark));
    delete w.__aipwRecorderStop;
  };
}

const bound = new WeakSet<Page>();
const sinks = new WeakMap<Page, (e: RawManualEvent) => void>();

/**
 * Starts recording on `page`. `describe` turns a locator into a target (the executor's describeElement).
 * stop() removes the listeners and markers and returns the merged records.
 */
export async function startRecording(
  page: Page,
  describe: (loc: Locator) => Promise<TargetDescriptor>,
): Promise<{ stop: () => Promise<ActionRecord[]> }> {
  const events: RawManualEvent[] = [];
  const targets = new Map<number, Promise<TargetDescriptor | undefined>>();
  const describeOnce = (id: number) => {
    if (id && !targets.has(id))
      targets.set(
        id,
        describe(page.locator(`[${MARK}="${id}"]`)).catch(() => undefined),
      );
  };
  sinks.set(page, (e) => {
    events.push(e);
    describeOnce(e.id);
  });
  if (!bound.has(page)) {
    bound.add(page);
    await page.exposeBinding(BINDING, (_source, e: RawManualEvent) => sinks.get(page)?.(e));
  }
  const install = () => page.evaluate(installRecorder, { binding: BINDING, mark: MARK }).catch(() => undefined);
  page.on('load', install);
  await install();
  return {
    stop: async () => {
      page.off('load', install);
      sinks.delete(page);
      const merged = mergeManualEvents(events);
      const records: ActionRecord[] = [];
      for (const e of merged) {
        const record = manualRecord(e, e.id ? await targets.get(e.id) : undefined);
        if (record) records.push(record);
      }
      await page
        .evaluate(() => (window as unknown as { __aipwRecorderStop?: () => void }).__aipwRecorderStop?.())
        .catch(() => undefined);
      // after.url: the page the next action started on, or where the human left it.
      records.forEach((r, i) => (r.after.url = records[i + 1]?.before.url ?? page.url()));
      return records;
    },
  };
}
