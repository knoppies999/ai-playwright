// Spike 0.1: does ariaSnapshot({ mode: 'ai' }) give refs, and does page.locator('aria-ref=eN') resolve
// them reliably, including inside iframes? Also: are snapshots deterministic, do old refs survive a
// new snapshot, and can actions be performed through a ref?
import type { Page } from '@playwright/test';
import { launch, out, refsIn, SAUCEDEMO_PAGES, sauceDemoLogin } from './lib.js';

interface PageResult {
  page: string;
  refs: number;
  resolvedExactlyOne: number;
  failures: { ref: string; count: number | string; line?: string }[];
  iframeRefs: number;
  deterministic: boolean;
  refsStableAcrossSnapshots: boolean;
}

const IFRAME_FIXTURE = `
<h1>Frames</h1>
<button>Outside</button>
<iframe title="inner frame" srcdoc="<button>Inside frame</button><input aria-label='Inner field'>"></iframe>
<iframe title="nested" srcdoc="<p>Level 1</p><iframe title='level two' srcdoc='<a href=#x>Deep link</a>'></iframe>"></iframe>
`;

const OTHER_PAGES: [string, (page: Page) => Promise<void>][] = [
  [
    'the-internet:iframe',
    async (p) => void (await p.goto('https://the-internet.herokuapp.com/iframe', { waitUntil: 'domcontentloaded' })),
  ],
  [
    'the-internet:nested-frames',
    async (p) =>
      void (await p.goto('https://the-internet.herokuapp.com/nested_frames', { waitUntil: 'domcontentloaded' })),
  ],
  ['playwright.dev:docs', async (p) => void (await p.goto('https://playwright.dev/docs/aria-snapshots'))],
  ['fixture:iframes', async (p) => p.setContent(IFRAME_FIXTURE)],
];

const lineFor = (snapshot: string, ref: string) =>
  snapshot
    .split('\n')
    .find((l) => l.includes(`[ref=${ref}]`))
    ?.trim();

async function checkPage(page: Page, name: string): Promise<PageResult> {
  const first = await page.ariaSnapshot({ mode: 'ai' });
  const second = await page.ariaSnapshot({ mode: 'ai' });
  out(`0.1-${name.replace(/[^a-z0-9-]/gi, '_')}.yaml`, first);
  const refs = refsIn(first);
  const failures: PageResult['failures'] = [];
  let ok = 0;
  for (const ref of refs) {
    try {
      const count = await page.locator(`aria-ref=${ref}`).count();
      if (count === 1) ok++;
      else failures.push({ ref, count, line: lineFor(first, ref) });
    } catch (error) {
      failures.push({ ref, count: String(error).slice(0, 120) });
    }
  }
  return {
    page: name,
    refs: refs.length,
    resolvedExactlyOne: ok,
    failures: failures.slice(0, 10),
    iframeRefs: refs.filter((r) => /^f\d+/.test(r)).length,
    deterministic: first === second,
    refsStableAcrossSnapshots: JSON.stringify(refsIn(second)) === JSON.stringify(refs),
  };
}

async function actThroughRefs(page: Page): Promise<Record<string, unknown>> {
  // Click "Add to cart" for the backpack through its ref, then check the cart badge.
  await sauceDemoLogin(page);
  const snap = await page.ariaSnapshot({ mode: 'ai' });
  const line = snap.split('\n').find((l) => l.includes('button "Add to cart"'));
  const ref = line && refsIn(line)[0];
  if (!ref) return { error: 'no Add to cart ref', snap: snap.slice(0, 500) };
  await page.locator(`aria-ref=${ref}`).click();
  const badge = await page.locator('[data-test="shopping-cart-badge"]').textContent();

  // Old ref after a new snapshot: does it still resolve (to the same element)?
  await page.ariaSnapshot({ mode: 'ai' });
  let oldRefAfterResnapshot: string;
  try {
    oldRefAfterResnapshot = `count=${await page.locator(`aria-ref=${ref}`).count()} text=${await page.locator(`aria-ref=${ref}`).textContent()}`;
  } catch (error) {
    oldRefAfterResnapshot = `error: ${String(error).slice(0, 160)}`;
  }

  // Ref after navigation: should be gone.
  await page.locator('[data-test="shopping-cart-link"]').click();
  let refAfterNavigation: string;
  try {
    refAfterNavigation = `count=${await page.locator(`aria-ref=${ref}`).count()}`;
  } catch (error) {
    refAfterNavigation = `error: ${String(error).slice(0, 160)}`;
  }

  // Action inside an iframe through a ref.
  await page.setContent(IFRAME_FIXTURE);
  const frameSnap = await page.ariaSnapshot({ mode: 'ai' });
  const innerLine = frameSnap.split('\n').find((l) => l.includes('textbox "Inner field"'));
  const innerRef = innerLine && refsIn(innerLine)[0];
  let iframeFill = 'no ref';
  if (innerRef) {
    await page.locator(`aria-ref=${innerRef}`).fill('hello');
    iframeFill = `ref=${innerRef} value=${await page.frameLocator('iframe[title="inner frame"]').getByLabel('Inner field').inputValue()}`;
  }

  // Scoped snapshot (locator.ariaSnapshot) refs resolve from the page?
  const scoped = await page.locator('body').ariaSnapshot({ mode: 'ai' });
  const scopedRefs = refsIn(scoped);

  return {
    clickedRef: ref,
    cartBadgeAfterClick: badge,
    oldRefAfterResnapshot,
    refAfterNavigation,
    iframeFill,
    scopedRefSample: scopedRefs.slice(0, 5),
    boxesSample: (await page.ariaSnapshot({ mode: 'ai', boxes: true })).split('\n').slice(0, 4),
  };
}

const browser = await launch();
const results: PageResult[] = [];
for (const [name, go] of [...SAUCEDEMO_PAGES, ...OTHER_PAGES]) {
  const page = await browser.newPage();
  try {
    await go(page);
    results.push(await checkPage(page, name));
  } catch (error) {
    results.push({
      page: name,
      refs: -1,
      resolvedExactlyOne: 0,
      failures: [{ ref: '-', count: String(error).slice(0, 200) }],
      iframeRefs: 0,
      deterministic: false,
      refsStableAcrossSnapshots: false,
    });
  }
  await page.close();
}
const actions = await actThroughRefs(await browser.newPage());
await browser.close();

console.table(
  results.map(({ failures, ...r }) => ({ ...r, failures: failures.length ? JSON.stringify(failures[0]) : '' })),
);
console.log(JSON.stringify(actions, null, 2));
out('0.1-results.json', { results, actions });
