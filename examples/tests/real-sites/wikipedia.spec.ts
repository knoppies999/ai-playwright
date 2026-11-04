// Real site: English Wikipedia, read-only (no sign-in, no edits). One worker, light load.
//   npm run e2e:real-sites            replays the committed plans (no AI unless the site changed)
//   AIPW_CACHE=refresh npm run e2e:real-sites    re-records with AI
import { expect, test } from '@aipw/test';
import { z } from 'zod';

// Language links go to other Wikipedia subdomains (af.wikipedia.org): allow them all.
test.use({ aiConfig: { navigation: { allowedOrigins: ['https://*.wikipedia.org'] } } });

test.beforeEach(async ({ page }) => {
  await page.goto('https://en.wikipedia.org/wiki/Main_Page');
});

test('search for an article and read its infobox', async ({ page, ai }) => {
  await ai.act('Search Wikipedia for "Table Mountain" and open the article about the mountain in Cape Town');
  await expect(page).toHaveURL(/\/wiki\/Table_Mountain$/);
  await ai.assert('The article heading is "Table Mountain"');
  const elevation = await ai.extract('the elevation of the highest point in metres, from the infobox', z.number());
  expect(elevation).toBeGreaterThan(1000);
  expect(elevation).toBeLessThan(1100);
});

test('jump to a section from the contents', async ({ page, ai }) => {
  await page.goto('https://en.wikipedia.org/wiki/Table_Mountain');
  await ai.act('Use the table of contents to go to the "Geology" section');
  await expect(page).toHaveURL(/#Geology$/);
  await ai.assert('The Geology section heading is visible');
});

test('read the same article in Afrikaans', async ({ page, ai }) => {
  await page.goto('https://en.wikipedia.org/wiki/Table_Mountain');
  await ai.act('Switch this article to Afrikaans using the languages menu');
  await expect(page).toHaveURL(/af\.wikipedia\.org/);
  await ai.assert('The page is the Afrikaans Wikipedia article about Table Mountain (Tafelberg)');
});
