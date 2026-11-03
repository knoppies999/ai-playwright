// Real site: GOV.UK, read-only (no forms submitted). One worker, light load.
import { expect, test } from '@aipw/test';
import { z } from 'zod';

test('bank holidays in Scotland', async ({ page, ai }) => {
  await page.goto('https://www.gov.uk/bank-holidays');
  await ai.act('Show the bank holidays for Scotland');
  await ai.assert('The Scotland tab is selected and its upcoming bank holidays are listed');
  const next = await ai.extract(
    'the next bank holiday in Scotland: its name and date as shown',
    z.object({ name: z.string(), date: z.string() }),
  );
  expect(next.name.length).toBeGreaterThan(3);
  expect(next.date).toMatch(/\d/);
});

test('search GOV.UK and open a guide', async ({ page, ai }) => {
  await page.goto('https://www.gov.uk/');
  await ai.act('Search GOV.UK for "renew passport" and open the result about renewing or replacing an adult passport');
  await expect(page).toHaveURL(/gov\.uk\/renew-adult-passport/);
  await ai.assert('The page is the guide to renewing or replacing an adult passport');
});
