// Real site: react.dev, a single-page app whose search is a keyboard-driven modal. Read-only, one worker.
import { expect, test } from '@aipw/test';
import { z } from 'zod';

test('search modal on a single-page app', async ({ page, ai }) => {
  await page.goto('https://react.dev/');
  await ai.act('Open the site search');
  await ai.act('Search for "useEffect" and open the API reference page for it');
  await expect(page).toHaveURL(/\/reference\/react\/useEffect/);
  await ai.assert('The page heading is "useEffect"');
  // Extract what the page shows (the whole paragraph) and check the part you care about in code.
  const intro = await ai.extract('the text of the first paragraph under the heading', z.string());
  expect(intro).toMatch(/React Hook that lets you synchronize/);
});
