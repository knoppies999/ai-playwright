// Spike 0.6: is locator.toString() readable and stable (for scopeDescriptor in step keys)? Is
// locator.highlight() visible, and absent from ARIA snapshots?
import { launch, out, OUT_DIR } from './lib.js';
import { join } from 'node:path';

const HTML = `
<main>
  <h1>Users</h1>
  <div role="dialog" aria-label="New user">
    <label>Email <input name="email"></label>
    <button data-test="save-user">Save</button>
  </div>
  <table><tr><td>thandi@example.com</td><td><button>Edit</button></td></tr></table>
</main>`;

const browser = await launch();
const strings: Record<string, string[]> = {};
for (let run = 0; run < 2; run++) {
  // Fresh browser context each run, to show the string doesn't depend on page state.
  const page = await browser.newPage();
  await page.setContent(HTML);
  const locators = {
    role: page.getByRole('button', { name: 'Save', exact: true }),
    scopedRole: page.getByRole('dialog', { name: 'New user' }).getByRole('button', { name: 'Save' }),
    testId: page.getByTestId('save-user'),
    cssAttr: page.locator('[data-test="save-user"]'),
    label: page.getByLabel('Email'),
    anchored: page.getByRole('row').filter({ hasText: 'thandi@example.com' }).getByRole('button', { name: 'Edit' }),
    nth: page.getByRole('button').nth(1),
    frame: page.frameLocator('iframe[title="x"]').getByText('Hi'),
    regexName: page.getByRole('button', { name: /sav/i }),
  };
  for (const [key, loc] of Object.entries(locators)) (strings[key] ??= []).push(loc.toString());

  if (run === 0) {
    const before = await page.ariaSnapshot({ mode: 'ai' });
    const handle = await locators.scopedRole.highlight();
    await page.screenshot({ path: join(OUT_DIR, '0.6-highlight.png') });
    const during = await page.ariaSnapshot({ mode: 'ai' });
    const highlightDom = await page.evaluate(() =>
      Array.from(document.querySelectorAll('*'))
        .filter((e) => e.tagName.startsWith('X-PW'))
        .map((e) => e.tagName),
    );
    await handle[Symbol.asyncDispose]?.();
    await page.hideHighlight();
    console.log('snapshot unchanged by highlight:', before === during);
    console.log('highlight elements in light DOM:', highlightDom);
  }
  await page.close();
}
await browser.close();

const table = Object.entries(strings).map(([key, [a, b]]) => ({ key, toString: a, stable: a === b }));
console.table(table);
out('0.6-results.json', table);
