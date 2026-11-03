// LocatorSynth (docs/12 §3): for the element behind a ref, produce up to 3 durable locators, test ids
// first. Every candidate is verified on the live page: it must match exactly one element, and that
// element must be the target. Refs are never stored (AGENTS.md rule 11).
import type { Frame, Locator, Page } from 'playwright-core';
import { buildLocator, type LocatorExpr } from './expr.js';
import { DEFAULT_REJECT_ID_PATTERNS, isGeneratedId, isStableText } from './generated.js';
import { isConfiguredTestIdAttribute, isRejectedTestIdValue, looksLikeTestIdAttribute } from './test-ids.js';
import { stableNamePrefix } from './volatile.js';

export type Rung = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7';

export interface LocatorCandidate {
  rung: Rung;
  expr: LocatorExpr;
  /** `locator.toString()`, for reports and code remedies. */
  display: string;
}

export interface SynthOptions {
  /** Configured test-id attributes (any spelling) plus the ones detected for this origin. */
  testIdAttributes: readonly string[];
  /** Playwright's `testIdAttribute` (may be a comma-separated list): matching ids become getByTestId(). */
  playwrightTestIdAttribute: string;
  rejectTestIdValues: readonly RegExp[];
  rejectIdPatterns?: readonly RegExp[];
  /** Role and accessible name of the target, from the snapshot line. */
  role?: string;
  name?: string;
  max?: number;
  /**
   * Text a check will assert on this element. A locator that finds the element by that same text proves
   * nothing ("the cell named Active has text Active"), so locators anchored in their row or card by other
   * text are tried first, and never anchored by this text.
   */
  assertedText?: string;
  /**
   * The value an extract reads from this element. Locators that contain it are skipped (a price cell found by
   * its price breaks when the price changes); position in a list or table is used instead.
   */
  readsValue?: string;
}

interface Attr {
  attr: string;
  value: string;
}

interface ElementFacts {
  tag: string;
  type: string | null;
  id: string | null;
  nameAttr: string | null;
  placeholder: string | null;
  label: string | null;
  text: string;
  testIds: Attr[];
  /** Repeated-item ancestors (closest first) with text lines unique to this item. */
  items: { selector: string; anchors: string[] }[];
  /** The element itself when it is a repeated item (a todo row, a product card), with its unique text lines. */
  self: { selector: string; anchors: string[] } | null;
  /** Ancestors (closest first) that could scope a structural L7 locator: their test ids and id. */
  scopes: { testIds: Attr[]; id: string | null; tagIndex: number }[];
}

/** Runs in the page. Must stay self-contained (it is serialised). */
function gatherFacts(el: Element, args: { marker: string; token: string; testIdNames: string[] }): ElementFacts {
  el.setAttribute(args.marker, args.token);
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pattern = /^(data)?(test|qa|cy|pw|e2e|automation)(id)?$/;
  const wanted = new Set(args.testIdNames.map(norm));
  const testIdsOf = (e: Element): Attr[] =>
    e
      .getAttributeNames()
      .filter((a) => wanted.has(norm(a)) || pattern.test(norm(a)))
      .map((a) => ({ attr: a, value: e.getAttribute(a) ?? '' }));
  const cssAttr = (a: string, v: string) => `[${a}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  const lines = (e: Element) =>
    ((e as HTMLElement).innerText ?? e.textContent ?? '')
      .split(/[\n\t]+/) // table rows separate cells with tabs
      .map((l) => l.trim())
      .filter((l) => l.length >= 2 && l.length <= 60);

  const items: ElementFacts['items'] = [];
  let self: ElementFacts['self'] = null;
  let anc: Element | null = el;
  for (let depth = 0; anc && depth < 9 && items.length < 3; depth++, anc = anc.parentElement) {
    const tag = anc.tagName.toLowerCase();
    const role = anc.getAttribute('role');
    const tid = testIdsOf(anc)[0];
    const selector = tid
      ? cssAttr(tid.attr, tid.value)
      : role === 'row' || role === 'listitem' || role === 'article'
        ? `[role="${role}"]`
        : tag === 'tr' || tag === 'li' || tag === 'article'
          ? tag
          : null;
    if (!selector) continue;
    const siblings = Array.from(anc.ownerDocument.querySelectorAll(selector)).filter((s) => s !== anc);
    if (!siblings.length) continue; // not a repeated item
    const others = new Set(siblings.flatMap(lines));
    const anchors = lines(anc).filter((l) => !others.has(l));
    if (!anchors.length) continue;
    if (anc === el) self = { selector, anchors: anchors.slice(0, 3) };
    else items.push({ selector, anchors: anchors.slice(0, 3) });
  }

  const scopes: ElementFacts['scopes'] = [];
  for (let a = el.parentElement, depth = 0; a && depth < 6 && scopes.length < 3; a = a.parentElement, depth++) {
    const tagIndex = Array.from(a.querySelectorAll(el.tagName.toLowerCase())).indexOf(el);
    const scope = { testIds: testIdsOf(a), id: a.getAttribute('id'), tagIndex };
    if (scope.testIds.length || scope.id) scopes.push(scope);
  }

  const input = el as HTMLInputElement;
  const labelledBy = el.getAttribute('aria-labelledby');
  const label =
    el.getAttribute('aria-label') ??
    (labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
          .join(' ')
          .trim()
      : null) ??
    (input.labels?.[0]?.textContent?.trim() || null);
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    id: el.getAttribute('id'),
    nameAttr: el.getAttribute('name'),
    placeholder: el.getAttribute('placeholder'),
    label,
    text: ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 100),
    testIds: testIdsOf(el),
    items,
    self,
    scopes,
  };
}

const MARKER = 'data-aipw-target';
const FORM_TAGS = new Set(['input', 'textarea', 'select']);
const NO_ROLE_LOCATOR = new Set(['generic', 'group', 'text', 'none', 'presentation', '/url', 'hidden', 'paragraph']);

const css = (attr: string, value: string) => `[${attr}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;

/** CSS for each iframe between the page and the target's frame, or undefined if one can't be identified. */
async function framePath(page: Page, frame: Frame): Promise<LocatorExpr | undefined> {
  const chain: Frame[] = [];
  for (let f: Frame | null = frame; f && f !== page.mainFrame(); f = f.parentFrame()) chain.unshift(f);
  const expr: LocatorExpr = [];
  for (const f of chain) {
    const el = await f.frameElement();
    const selector = await el.evaluate((e: Element) => {
      const q = (a: string, v: string) => `iframe[${a}="${v.replace(/"/g, '\\"')}"]`;
      for (const a of ['data-testid', 'data-test-id', 'data-test', 'id', 'name', 'title']) {
        const v = e.getAttribute(a);
        if (v) return q(a, v);
      }
      return null;
    });
    if (!selector) return undefined;
    const parent = f.parentFrame() ?? page.mainFrame();
    if ((await parent.locator(selector).count()) !== 1) return undefined;
    expr.push({ m: 'locator', selector }, { m: 'contentFrame' });
  }
  return expr;
}

/**
 * Synthesises verified locators for `target` (normally `page.locator('aria-ref=eN')`).
 * Must run while the element still exists, i.e. before an action that may remove it.
 */
export async function synthesizeLocators(page: Page, target: Locator, opts: SynthOptions): Promise<LocatorCandidate[]> {
  const max = opts.max ?? 3;
  const token = Math.random().toString(36).slice(2);
  const handle = await target.elementHandle({ timeout: 2000 });
  if (!handle) return [];
  try {
    const frame = await handle.ownerFrame();
    const prefix = frame && frame !== page.mainFrame() ? await framePath(page, frame) : [];
    if (!prefix) return [];
    const facts = await handle.evaluate(gatherFacts, {
      marker: MARKER,
      token,
      testIdNames: [...opts.testIdAttributes],
    });

    const isTarget = async (expr: LocatorExpr): Promise<boolean> => {
      try {
        const loc = buildLocator(page, [...prefix, ...expr]);
        if ((await loc.count()) !== 1) return false;
        // The element exists (count is 1), so this only waits under load; a short timeout here once dropped the
        // L1 test id on a busy machine and let L2 win.
        return (await loc.getAttribute(MARKER, { timeout: 5000 })) === token;
      } catch {
        return false;
      }
    };
    const fold = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    // Short values ("1", "OK") occur inside unrelated locators; only real text makes a locator circular.
    const asserted = opts.assertedText && fold(opts.assertedText).length >= 3 ? fold(opts.assertedText) : '';
    /** True when the expression finds the element by the text the check will assert. */
    const circular = (expr: LocatorExpr) => asserted !== '' && fold(JSON.stringify(expr)).includes(asserted);
    // An extract source must not be found by the value it is read for: when the value changes, so would the locator.
    const read = opts.readsValue !== undefined && fold(opts.readsValue) !== '' ? fold(opts.readsValue) : '';
    const findsByValue = (expr: LocatorExpr) => read !== '' && fold(JSON.stringify(expr)).includes(read);
    const anchored = (expr: LocatorExpr): LocatorExpr[] =>
      facts.items.flatMap((item) =>
        item.anchors
          .filter((a) => asserted === '' || !fold(a).includes(asserted))
          .filter((a) => read === '' || !fold(a).includes(read))
          .map((a) => [{ m: 'locator', selector: item.selector }, { m: 'filter', hasText: a }, ...expr] as LocatorExpr),
      );

    // Ladder rungs in order; each base expression is tried as-is, then anchored inside a repeated item (L5).
    const bases: { rung: Rung; expr: LocatorExpr }[] = [];
    // Playwright 1.64 accepts a comma-separated testIdAttribute list.
    const pwTestIdAttrs = opts.playwrightTestIdAttribute.split(',').map((a) => a.trim().toLowerCase());
    for (const t of facts.testIds) {
      if (isRejectedTestIdValue(t.value, opts.rejectTestIdValues)) continue;
      if (!isConfiguredTestIdAttribute(t.attr, opts.testIdAttributes) && !looksLikeTestIdAttribute(t.attr)) continue;
      bases.push({
        rung: 'L1',
        expr: pwTestIdAttrs.includes(t.attr.toLowerCase())
          ? [{ m: 'getByTestId', id: t.value }]
          : [{ m: 'locator', selector: css(t.attr, t.value) }],
      });
    }
    // A name with a price in it changes with the data: use its stable start instead (not exact).
    const stableName = opts.name ? stableNamePrefix(opts.name) : undefined;
    if (opts.role && !NO_ROLE_LOCATOR.has(opts.role) && stableName) {
      bases.push({ rung: 'L2', expr: [{ m: 'getByRole', role: opts.role, name: stableName }] });
    } else if (opts.role && !NO_ROLE_LOCATOR.has(opts.role) && opts.name && opts.name.length <= 80) {
      bases.push({ rung: 'L2', expr: [{ m: 'getByRole', role: opts.role, name: opts.name, exact: true }] });
    }
    // The target is itself a repeated item (hovering a todo row): the item selector, filtered by its own text.
    for (const anchor of facts.self?.anchors.slice(0, 2) ?? []) {
      bases.push({
        rung: 'L5',
        expr: [
          { m: 'locator', selector: facts.self!.selector },
          { m: 'filter', hasText: anchor },
        ],
      });
    }
    if (FORM_TAGS.has(facts.tag)) {
      if (facts.label) bases.push({ rung: 'L3', expr: [{ m: 'getByLabel', text: facts.label, exact: true }] });
      if (facts.placeholder)
        bases.push({ rung: 'L3', expr: [{ m: 'getByPlaceholder', text: facts.placeholder, exact: true }] });
      if (facts.nameAttr)
        bases.push({ rung: 'L3', expr: [{ m: 'locator', selector: `${facts.tag}${css('name', facts.nameAttr)}` }] });
    }
    if (facts.id && !isGeneratedId(facts.id, opts.rejectIdPatterns ?? DEFAULT_REJECT_ID_PATTERNS)) {
      bases.push({ rung: 'L4', expr: [{ m: 'locator', selector: css('id', facts.id) }] });
    }
    if (!FORM_TAGS.has(facts.tag) && isStableText(facts.text)) {
      bases.push({ rung: 'L6', expr: [{ m: 'getByText', text: facts.text, exact: true }] });
    }

    const found: LocatorCandidate[] = [];
    const seen = new Set<string>();
    for (const base of bases) {
      if (found.length >= max) break;
      const inItem = anchored(base.expr).map((expr) => ({ rung: 'L5' as Rung, expr }));
      const tries: { rung: Rung; expr: LocatorExpr }[] = circular(base.expr) ? [...inItem, base] : [base, ...inItem];
      for (const t of tries.filter((x) => !findsByValue(x.expr))) {
        const key = JSON.stringify(t.expr);
        if (seen.has(key)) continue;
        seen.add(key);
        if (await isTarget(t.expr)) {
          const full = [...prefix, ...t.expr];
          found.push({ rung: t.rung, expr: full, display: buildLocator(page, full).toString() });
          break; // one verified variant per base is enough
        }
      }
    }
    // L7, last resort (docs/12 §3): the n-th element of its role (or tag) inside the nearest stable ancestor.
    // Positional, so fragile, but it replays; without it the step goes to the AI on every run.
    // First, a test id shared by a list of items: the n-th one (getByTestId('todo-title').nth(1)).
    for (const t of found.length ? [] : facts.testIds) {
      if (isRejectedTestIdValue(t.value, opts.rejectTestIdValues)) continue;
      const base: LocatorExpr = pwTestIdAttrs.includes(t.attr.toLowerCase())
        ? [{ m: 'getByTestId', id: t.value }]
        : [{ m: 'locator', selector: css(t.attr, t.value) }];
      const index = await handle.evaluate(
        (el, selector) => Array.from(el.ownerDocument.querySelectorAll(selector)).indexOf(el),
        css(t.attr, t.value),
      );
      const expr: LocatorExpr = [...base, { m: 'nth', index }];
      if (index >= 0 && (await isTarget(expr))) {
        const full = [...prefix, ...expr];
        found.push({ rung: 'L7', expr: full, display: buildLocator(page, full).toString() });
        break;
      }
    }
    if (!found.length) {
      const scopes = facts.scopes.flatMap((sc) =>
        [
          ...sc.testIds
            .filter((t) => !isRejectedTestIdValue(t.value, opts.rejectTestIdValues))
            .map((t) => css(t.attr, t.value)),
          ...(sc.id && !isGeneratedId(sc.id, opts.rejectIdPatterns ?? DEFAULT_REJECT_ID_PATTERNS)
            ? [css('id', sc.id)]
            : []),
        ].map((selector) => ({ selector, tagIndex: sc.tagIndex })),
      );
      const byRole = opts.role && !NO_ROLE_LOCATOR.has(opts.role);
      for (const scope of scopes) {
        let hit: LocatorExpr | undefined;
        // Readable first: the n-th of its role. Probed, so only for short lists.
        if (byRole) {
          const all: LocatorExpr = [
            { m: 'locator', selector: scope.selector },
            { m: 'getByRole', role: opts.role! },
          ];
          const n = await buildLocator(page, [...prefix, ...all])
            .count()
            .catch(() => 0);
          for (let i = 0; i < Math.min(n, 12) && !hit; i++) {
            const expr: LocatorExpr = [...all, { m: 'nth', index: i }];
            if (await isTarget(expr)) hit = expr;
          }
        }
        // Otherwise the n-th of its tag, with the index computed in the page (a cell deep in a table).
        if (!hit && scope.tagIndex >= 0) {
          const expr: LocatorExpr = [
            { m: 'locator', selector: scope.selector },
            { m: 'locator', selector: facts.tag },
            { m: 'nth', index: scope.tagIndex },
          ];
          if (await isTarget(expr)) hit = expr;
        }
        if (hit) {
          const full = [...prefix, ...hit];
          found.push({ rung: 'L7', expr: full, display: buildLocator(page, full).toString() });
          break;
        }
      }
    }
    return found;
  } finally {
    await handle.evaluate((el, marker) => el.removeAttribute(marker), MARKER).catch(() => undefined);
    await handle.dispose();
  }
}
