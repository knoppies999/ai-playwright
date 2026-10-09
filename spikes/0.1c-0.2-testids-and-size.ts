// Spike 0.1c: which test-id attribute spellings does the public app use, how many, how unique?
// Spike 0.2: how big are AI snapshots of its pages, before and after a naive prune?
import { detectTestIdAttributes, looksLikeTestIdAttribute } from '../packages/core/src/index.js';
import { approxTokens, launch, out, SAUCEDEMO_PAGES } from './lib.js';

/** Naive version of docs/04 §1.2 steps 3–4: drop unnamed generics, collapse long sibling runs. */
function naivePrune(snapshot: string, collapseOver = 15): string {
  const lines = snapshot.split('\n').filter((l) => !/^\s*- generic \[ref=[^\]]+\]:?$/.test(l));
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const indent = /^\s*/.exec(lines[i]!)![0].length;
    const kind = /^\s*- (\w+)/.exec(lines[i]!)?.[1];
    // A run of siblings at the same indent with the same role (children included).
    let j = i;
    const starts: number[] = [];
    while (j < lines.length) {
      const ind = /^\s*/.exec(lines[j]!)![0].length;
      if (ind < indent) break;
      if (ind === indent) {
        if (/^\s*- (\w+)/.exec(lines[j]!)?.[1] !== kind) break;
        starts.push(j);
      }
      j++;
    }
    if (kind && starts.length > collapseOver) {
      const keep = [...starts.slice(0, 10), ...starts.slice(-2)];
      for (const s of keep) {
        const end = starts[starts.indexOf(s) + 1] ?? j;
        result.push(...lines.slice(s, end));
        if (s === starts[9]) result.push(`${' '.repeat(indent)}- … ${starts.length - 12} more ${kind}s`);
      }
      i = j;
    } else {
      result.push(lines[i]!);
      i++;
    }
  }
  return result.join('\n');
}

const browser = await launch();
const attributeTotals: Record<string, number> = {};
const perPage = [];
const duplicates: Record<string, string[]> = {};

for (const [name, go] of SAUCEDEMO_PAGES) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await go(page);
  await page.waitForTimeout(500);

  const { counts, values } = await page.evaluate(() => {
    const counts: Record<string, number> = {};
    const values: Record<string, string[]> = {};
    for (const el of Array.from(document.querySelectorAll('*'))) {
      for (const attr of el.getAttributeNames()) {
        counts[attr] = (counts[attr] ?? 0) + 1;
        if (attr.startsWith('data-') || attr.includes('test') || attr.includes('qa')) {
          (values[attr] ??= []).push(el.getAttribute(attr) ?? '');
        }
      }
    }
    return { counts, values };
  });
  for (const [attr, n] of Object.entries(counts)) attributeTotals[attr] = (attributeTotals[attr] ?? 0) + n;

  const testIdAttrs = Object.keys(counts).filter(looksLikeTestIdAttribute);
  for (const attr of testIdAttrs) {
    const seen = new Map<string, number>();
    for (const v of values[attr] ?? []) seen.set(v, (seen.get(v) ?? 0) + 1);
    const dups = [...seen].filter(([, n]) => n > 1).map(([v, n]) => `${v}×${n}`);
    if (dups.length) duplicates[`${name} ${attr}`] = dups;
  }

  const raw = await page.ariaSnapshot({ mode: 'ai' });
  const pruned = naivePrune(raw);
  out(`0.2-${name}-pruned.yaml`, pruned);
  perPage.push({
    page: name,
    elements: await page.evaluate(() => document.querySelectorAll('*').length),
    testIdElements: testIdAttrs.reduce((n, a) => n + (counts[a] ?? 0), 0),
    testIdAttrs: testIdAttrs.join(','),
    rawChars: raw.length,
    rawTokens: approxTokens(raw),
    prunedTokens: approxTokens(pruned),
  });
  await context.close();
}

// A big page for scale: the largest page we can reach without logging in anywhere.
const big = await browser.newPage();
await big.goto('https://playwright.dev/docs/api/class-page');
const bigRaw = await big.ariaSnapshot({ mode: 'ai' });
const bigPruned = naivePrune(bigRaw);
await browser.close();

const detected = detectTestIdAttributes(attributeTotals);
console.log('Detected test-id attributes (all SauceDemo pages):', detected);
console.log(
  'Other data-* attributes:',
  Object.entries(attributeTotals).filter(([a]) => a.startsWith('data-') && !looksLikeTestIdAttribute(a)),
);
console.log('Duplicate test-id values per page:', duplicates);
console.table(perPage);
console.log('playwright.dev/docs/api/class-page', {
  rawTokens: approxTokens(bigRaw),
  prunedTokens: approxTokens(bigPruned),
});
out('0.1c-0.2-results.json', {
  detected,
  duplicates,
  perPage,
  big: { rawTokens: approxTokens(bigRaw), prunedTokens: approxTokens(bigPruned) },
});
