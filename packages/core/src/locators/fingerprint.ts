// Fingerprints and fingerprint healing (docs/12 §6, ladder rung L8): when every stored locator fails,
// score the page's elements against what the target looked like, and accept a clear winner without AI.
import type { Locator, Page } from 'playwright-core';
import type { Fingerprint } from '../cache/plan.js';

/**
 * Feature weights. The doc orders them test id > name > ancestors > text > attributes > position; a renamed
 * test id with everything else unchanged must still reach the 0.80 threshold, so no weight exceeds 0.20.
 */
export const FINGERPRINT_WEIGHTS = {
  testId: 0.2,
  name: 0.2,
  text: 0.15,
  ancestors: 0.15,
  labels: 0.1,
  attrs: 0.1,
  position: 0.1,
} as const;
export const ACCEPT_SCORE = 0.8;
export const ACCEPT_MARGIN = 0.15;

/** Runs in the page: what an element looks like, for later matching. Self-contained (serialised). */
function describeElement(el: Element, args: { role: string | null; name: string | null }) {
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pattern = /^(data)?(test|qa|cy|pw|e2e|automation)(id)?$/;
  const testIds: Record<string, string> = {};
  for (const a of el.getAttributeNames()) if (pattern.test(norm(a))) testIds[a] = el.getAttribute(a) ?? '';
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const input = el as HTMLInputElement;
  const label = el.getAttribute('aria-label') ?? input.labels?.[0]?.textContent?.trim() ?? null;
  const LANDMARK: Record<string, string> = {
    NAV: 'navigation',
    MAIN: 'main',
    HEADER: 'banner',
    FOOTER: 'contentinfo',
    FORM: 'form',
    DIALOG: 'dialog',
    TABLE: 'table',
    TR: 'row',
    SECTION: 'region',
    ARTICLE: 'article',
    ASIDE: 'complementary',
    LI: 'listitem',
    UL: 'list',
  };
  const ancestors: { role: string | null; name: string | null }[] = [];
  for (let a = el.parentElement; a && ancestors.length < 3; a = a.parentElement) {
    const role = a.getAttribute('role') ?? LANDMARK[a.tagName] ?? null;
    if (role) ancestors.push({ role, name: a.getAttribute('aria-label') });
  }
  const siblings = el.parentElement
    ? Array.from(el.parentElement.children).filter((s) => s.tagName === el.tagName)
    : [el];
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || 1;
  const vh = window.innerHeight || 1;
  return {
    tag: el.tagName.toLowerCase(),
    role: args.role,
    name: args.name,
    testIds,
    attrs: { type: el.getAttribute('type'), name: el.getAttribute('name'), id: el.getAttribute('id') },
    text,
    label,
    placeholder: el.getAttribute('placeholder'),
    ancestors,
    siblingIndex: siblings.indexOf(el),
    box: r.width || r.height ? { x: r.x / vw, y: r.y / vh, w: r.width / vw, h: r.height / vh } : null,
  };
}

export async function fingerprintOf(target: Locator, role?: string, name?: string): Promise<Fingerprint | undefined> {
  try {
    return await target.evaluate(describeElement, { role: role ?? null, name: name ?? null });
  } catch {
    return undefined;
  }
}

const textSim = (a: string | null, b: string | null): number | undefined => {
  if (!a && !b) return undefined;
  if (!a || !b) return 0;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  return x.includes(y) || y.includes(x) ? 0.5 : 0;
};

/** Weighted similarity in [0, 1]; features neither side has are left out and the rest renormalised. */
export function scoreFingerprint(stored: Fingerprint, candidate: Fingerprint): number {
  const parts: [keyof typeof FINGERPRINT_WEIGHTS, number | undefined][] = [];
  // Same value → 1. Same attribute with a new value (a renamed test id) → 0.5: renames keep the attribute.
  const storedIds = Object.entries(stored.testIds);
  const candIds = Object.entries(candidate.testIds);
  parts.push([
    'testId',
    storedIds.length || candIds.length
      ? storedIds.some(([, v]) => candIds.some(([, w]) => w === v))
        ? 1
        : storedIds.some(([a]) => candIds.some(([b]) => b === a))
          ? 0.5
          : 0
      : undefined,
  ]);
  // The name comes from the snapshot when recording; for page candidates use aria-label/label/text.
  parts.push(['name', textSim(stored.name, candidate.name ?? candidate.label ?? candidate.text)]);
  parts.push(['text', textSim(stored.text, candidate.text)]);
  const anc = (f: Fingerprint) => f.ancestors.map((a) => `${a.role}:${a.name ?? ''}`).join('/');
  parts.push([
    'ancestors',
    stored.ancestors.length || candidate.ancestors.length ? (anc(stored) === anc(candidate) ? 1 : 0) : undefined,
  ]);
  const labels = [textSim(stored.label, candidate.label), textSim(stored.placeholder, candidate.placeholder)].filter(
    (x): x is number => x !== undefined,
  );
  parts.push(['labels', labels.length ? labels.reduce((s, x) => s + x, 0) / labels.length : undefined]);
  const attrKeys = Object.keys(stored.attrs).filter((k) => stored.attrs[k] !== null || candidate.attrs[k] !== null);
  parts.push([
    'attrs',
    attrKeys.length
      ? attrKeys.filter((k) => stored.attrs[k] === candidate.attrs[k]).length / attrKeys.length
      : undefined,
  ]);
  let position: number | undefined;
  if (stored.box && candidate.box) {
    const d = Math.hypot(stored.box.x - candidate.box.x, stored.box.y - candidate.box.y);
    position = Math.max(0, 1 - d * 4) * 0.7 + (stored.siblingIndex === candidate.siblingIndex ? 0.3 : 0);
  }
  parts.push(['position', position]);

  let total = 0;
  let weight = 0;
  for (const [feature, value] of parts) {
    if (value === undefined) continue;
    total += FINGERPRINT_WEIGHTS[feature] * value;
    weight += FINGERPRINT_WEIGHTS[feature];
  }
  return weight ? total / weight : 0;
}

export interface FingerprintMatch {
  locator: Locator;
  score: number;
  runnerUp: number;
}

const HEAL_MARKER = 'data-aipw-heal';

/**
 * Scores every element with the stored tag and returns the best one if it is confident: score ≥ 0.80 and
 * at least 0.15 ahead of the runner-up. The match is marked with a temporary attribute; callers must
 * synthesise durable locators for it and then call `clearHealMarker`.
 */
export async function findByFingerprint(page: Page, stored: Fingerprint): Promise<FingerprintMatch | undefined> {
  const elements = page.locator(stored.tag);
  const count = await elements.count();
  const scored: { index: number; score: number }[] = [];
  for (let i = 0; i < Math.min(count, 300); i++) {
    const candidate = await fingerprintOf(elements.nth(i), undefined, undefined);
    if (candidate) scored.push({ index: i, score: scoreFingerprint(stored, candidate) });
  }
  scored.sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score < ACCEPT_SCORE || best.score - (second?.score ?? 0) < ACCEPT_MARGIN) return undefined;
  const token = Math.random().toString(36).slice(2);
  await elements
    .nth(best.index)
    .evaluate((el, a) => el.setAttribute(a.marker, a.token), { marker: HEAL_MARKER, token });
  return { locator: page.locator(`[${HEAL_MARKER}="${token}"]`), score: best.score, runnerUp: second?.score ?? 0 };
}

export async function clearHealMarker(page: Page): Promise<void> {
  await page
    .evaluate(
      (marker) => document.querySelectorAll(`[${marker}]`).forEach((e) => e.removeAttribute(marker)),
      HEAL_MARKER,
    )
    .catch(() => undefined);
}
