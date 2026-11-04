// Real sites: MDN, python.org and a long Wikipedia table. Read-only, one worker, light load.
import { expect, test } from '@aipw/test';
import { z } from 'zod';

test('MDN: search the docs and read a method page', async ({ page, ai }) => {
  await page.goto('https://developer.mozilla.org/en-US/');
  await ai.act('Search the docs for "Array.prototype.map" and open the reference page for that method');
  await expect(page).toHaveURL(/Global_Objects\/Array\/map/);
  await ai.assert('The page heading is "Array.prototype.map()"');
  const returns = await ai.extract(
    'what the method returns, from the "Return value" section, as one sentence',
    z.string(),
  );
  expect(returns.toLowerCase()).toContain('new array');
});

test('python.org: a hover-only menu', async ({ page, ai }) => {
  await page.goto('https://www.python.org/');
  await ai.act('Hover over Downloads in the main navigation so its menu opens');
  // Extract exactly what the page shows; derive anything else in code, so the read replays without AI.
  const items = await ai.extract('the first three links in the open Downloads menu', z.array(z.string()).length(3));
  expect(items[0]).toMatch(/All releases/i);
  await expect(page).toHaveURL('https://www.python.org/');
});

test('Wikipedia: read the top of a long table', async ({ page, ai }) => {
  await page.goto('https://en.wikipedia.org/wiki/List_of_tallest_buildings');
  const top = await ai.extract(
    'the names of the three tallest buildings in the first ranked table, in rank order',
    z.array(z.string()).length(3),
  );
  expect(top[0]).toMatch(/Burj Khalifa/);
});
