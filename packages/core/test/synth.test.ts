import type { Locator, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { buildLocator } from '../src/locators/expr.js';
import { isGeneratedId, isStableText } from '../src/locators/generated.js';
import { synthesizeLocators, type SynthOptions } from '../src/locators/synth.js';
import { DEFAULT_REJECT_TEST_ID_VALUES, DEFAULT_TEST_ID_ATTRIBUTES } from '../src/locators/test-ids.js';
import { html, useBrowser } from './browser.js';

const { page: open } = useBrowser();

const OPTS: SynthOptions = {
  testIdAttributes: DEFAULT_TEST_ID_ATTRIBUTES,
  playwrightTestIdAttribute: 'data-test',
  rejectTestIdValues: DEFAULT_REJECT_TEST_ID_VALUES,
};

async function synth(page: Page, target: Locator, extra: Partial<SynthOptions> = {}) {
  const found = await synthesizeLocators(page, target, { ...OPTS, ...extra });
  return found.map((c) => `${c.rung} ${c.display}`);
}

describe('synthesizeLocators', () => {
  it('prefers a unique test id, then role + name', async () => {
    const page = await open(html('shop.html'), { testIdAttribute: 'data-test' });
    const target = page.locator('[data-test="add-to-cart-backpack"]');
    expect(await synth(page, target, { role: 'button', name: 'Add to cart' })).toEqual([
      "L1 getByTestId('add-to-cart-backpack')",
      "L5 locator('[data-test=\"inventory-item\"]').filter({ hasText: 'Backpack' }).getByRole('button', { name: 'Add to cart', exact: true })",
      "L5 locator('[data-test=\"inventory-item\"]').filter({ hasText: 'Backpack' }).getByText('Add to cart', { exact: true })",
    ]);
  });

  it('emits a CSS attribute locator when the test-id attribute is not Playwright’s', async () => {
    const page = await open(html('shop.html'), { testIdAttribute: 'data-testid' });
    const target = page.locator('[data-test="shopping-cart-link"]');
    const found = await synth(page, target, { playwrightTestIdAttribute: 'data-testid', role: 'link', name: 'Cart' });
    expect(found[0]).toBe('L1 locator(\'[data-test="shopping-cart-link"]\')');
  });

  it('anchors repeated test ids to their item (L5)', async () => {
    const page = await open(html('shop.html'), { testIdAttribute: 'data-test' });
    const target = page.locator('[data-test="inventory-item-price"]').nth(1);
    const found = await synth(page, target);
    expect(found[0]).toBe(
      "L5 locator('[data-test=\"inventory-item\"]').filter({ hasText: 'Bike Light' }).getByTestId('inventory-item-price')",
    );
  });

  it('anchors repeated buttons in table rows by row text', async () => {
    const page = await open(html('shop.html'));
    const target = page.getByRole('button', { name: 'Edit' }).nth(1);
    const found = await synth(page, target, { role: 'button', name: 'Edit' });
    expect(found[0]).toBe(
      "L5 locator('tr').filter({ hasText: 'sipho@example.com' }).getByRole('button', { name: 'Edit', exact: true })",
    );
  });

  it('uses form semantics and skips generated ids', async () => {
    const page = await open(html('shop.html'));
    expect(await synth(page, page.locator('#first'), { role: 'textbox', name: 'First Name' })).toEqual([
      "L2 getByRole('textbox', { name: 'First Name', exact: true })",
      "L3 getByLabel('First Name', { exact: true })",
      'L3 locator(\'input[name="firstName"]\')',
    ]);
    const zip = await synth(page, page.getByPlaceholder('Zip/Postal Code'));
    expect(zip).toContain("L3 getByPlaceholder('Zip/Postal Code', { exact: true })");
    expect(zip.join()).not.toContain('input-48213');
    const menu = await synth(page, page.getByRole('button', { name: 'Open Menu' }), {
      role: 'button',
      name: 'Open Menu',
    });
    expect(menu.join()).not.toContain(':r1f:');
  });

  it('skips generated-looking test ids', async () => {
    const page = await open(html('shop.html'), { testIdAttribute: 'data-testid' });
    const found = await synth(page, page.getByText('generated id'), { playwrightTestIdAttribute: 'data-testid' });
    expect(found.join()).not.toContain('a81f9c2d0b');
  });

  it('builds frame-scoped locators for elements inside an iframe', async () => {
    const page = await open(
      `<iframe title="inner frame" srcdoc="<button data-test='inside'>Inside frame</button>"></iframe>`,
      { testIdAttribute: 'data-test' },
    );
    await page.frameLocator('iframe').getByRole('button').waitFor();
    const target = page.frameLocator('iframe[title="inner frame"]').getByRole('button');
    const found = await synth(page, target, { role: 'button', name: 'Inside frame' });
    expect(found[0]).toBe("L1 locator('iframe[title=\"inner frame\"]').contentFrame().getByTestId('inside')");
  });

  it('removes its marker attribute afterwards', async () => {
    const page = await open(html('shop.html'));
    await synth(page, page.getByText('Forgot password?'));
    expect(await page.locator('[data-aipw-target]').count()).toBe(0);
  });
});

describe('buildLocator', () => {
  it('rejects malformed expressions', async () => {
    const page = await open('<p>x</p>');
    expect(() => buildLocator(page, [{ m: 'filter', hasText: 'x' }])).toThrow(/filter must follow a locator/);
    expect(() => buildLocator(page, [{ m: 'evaluate', code: 'alert(1)' } as never])).toThrow();
  });
});

describe('generated-value filter', () => {
  it.each([
    ':r1f:',
    'radix-:r3:',
    'ember123',
    'mat-input-7',
    'ext-gen1042',
    '3f2b9c1e-1234-4abc',
    'a81f9c2d0b',
    'row-200394',
    'Button_primary__x7Hq2',
    'sc-bdVaJa',
  ])('rejects %s', (id) => expect(isGeneratedId(id)).toBe(true));
  it.each(['user-email', 'checkout-continue', 'first'])('keeps %s', (id) => expect(isGeneratedId(id)).toBe(false));
  it('treats short static text as stable', () => {
    expect(isStableText('Forgot password?')).toBe(true);
    expect(isStableText('$29.99')).toBe(false);
  });
});
