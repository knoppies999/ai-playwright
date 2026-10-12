// Toolshop: finding things. Real AI calls (tagged @llm): npx playwright test --project toolshop --headed
// Each test starts on the home page. Code assertions back up the AI's where they are cheap (risk R6).
import { expect, test } from '@aipw/test';
import { z } from 'zod';

test.describe('Toolshop browsing', { tag: '@llm' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('product-name').first()).toBeVisible();
  });

  test('search for a product', async ({ page, ai }) => {
    await ai.act('Search for "pliers"');
    await ai.assert('Every product listed has "Pliers" in its name');
    const names = await page.getByTestId('product-name').allInnerTexts();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name.toLowerCase()).toContain('pliers');
  });

  test('a search with no results, then clear it', async ({ page, ai }) => {
    await ai.act('Search for "chainsaw sharpener deluxe 9000"');
    await ai.assert('The page says no products were found');
    await ai.act('Clear the search');
    await ai.assert('Products are listed again');
    await expect(page.getByTestId('product-name').first()).toBeVisible();
  });

  test('sort by price, cheapest first', async ({ ai }) => {
    await ai.act('Sort the products by price, from low to high');
    const prices = await ai.extract('the price of every product shown, in order, as numbers', z.array(z.number()));
    expect(prices.length).toBeGreaterThan(3);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  test('sort by name, Z to A', async ({ ai }) => {
    await ai.act('Sort the products by name from Z to A');
    const names = await ai.extract('the name of every product shown, in order', z.array(z.string()));
    expect(names).toEqual([...names].sort((a, b) => b.localeCompare(a)));
  });

  test('filter by category', async ({ page, ai }) => {
    await ai.act('Use the category filters to show only hammers');
    await ai.assert('Only hammers are listed');
    const names = await page.getByTestId('product-name').allInnerTexts();
    expect(names.some((n) => /hammer/i.test(n))).toBe(true);
  });

  test('top menu: Categories > Power Tools', async ({ ai }) => {
    await ai.act('Open Power Tools from the Categories menu at the top');
    await ai.assert('The page lists power tools, such as drills or sanders');
  });

  test('page through the results', async ({ page, ai }) => {
    const firstOnPage1 = await page.getByTestId('product-name').first().innerText();
    await ai.act('Go to page 2 of the product list');
    await ai.assert('Page 2 of the results is shown');
    await expect(page.getByTestId('product-name').first()).not.toHaveText(firstOnPage1);
  });

  test('read a product page', async ({ page, ai }) => {
    await ai.act('Open the "Combination Pliers" product');
    const product = await ai.extract(
      'the product name, its price, and its material and weight from the specifications',
      z.object({ name: z.string(), price: z.number(), material: z.string(), weight: z.string() }),
    );
    expect(product.name).toBe('Combination Pliers');
    expect(product.price).toBeGreaterThan(0);
    expect(product.material.toLowerCase()).toContain('steel');
    await expect(page.getByTestId('unit-price')).toContainText(String(product.price));
  });

  test('related products', async ({ ai }) => {
    await ai.act('Open "Combination Pliers", then open the first related product below it');
    await ai.assert('A different pliers product page is shown, not Combination Pliers');
  });

  test('switch the language', async ({ page, ai }) => {
    await ai.act('Switch the site language to German');
    await ai.assert('The navigation menu is in German');
    await ai.act('Switch the language back to English');
    await expect(page.getByTestId('nav-home')).toHaveText(/Home/);
  });

  test('rentals', async ({ ai }) => {
    await ai.act('Open the rentals page from the Categories menu and open the excavator');
    await ai.assert('The excavator rental page is shown');
  });
});
