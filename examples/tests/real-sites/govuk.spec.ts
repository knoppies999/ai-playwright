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

test('a multi-step calculator', async ({ page, ai }) => {
  // Radios and a number field over several pages. Answers are anonymous and nothing is saved.
  await page.goto('https://www.gov.uk/calculate-your-holiday-entitlement');
  await ai.act('Start the calculator');
  await ai.act(
    'Answer the questions: the job has irregular hours or is not part-year? No, it is a regular job; ' +
      'the entitlement is based on days worked per week; work out holiday for a full leave year; ' +
      'the person works 5 days a week. Continue after each answer until the result is shown',
  );
  await ai.assert('The result says the statutory holiday entitlement is 28 days');
  await expect(page.getByText(/28 days/).first()).toBeVisible();
});

test('page through search results', async ({ page, ai }) => {
  await page.goto('https://www.gov.uk/search/all?keywords=driving+licence');
  await ai.act('Go to the next page of search results');
  await expect(page).toHaveURL(/[?&]page=2/);
  await ai.assert('The results are page 2 of the search for driving licence');
});
