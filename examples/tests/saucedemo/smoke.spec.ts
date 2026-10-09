// Plain-Playwright smoke spec for the SauceDemo target (Phase 1). It proves the public app is
// reachable and stable enough to be the usability target. No AI involved.
import { expect, test, type Page } from '@playwright/test';
import { saucedemo, targetSecret } from '../../targets/saucedemo/target.js';

async function logIn(page: Page, user: string) {
  await page.goto('/');
  await page.getByTestId('username').fill(user);
  await page.getByTestId('password').fill(targetSecret('password'));
  await page.getByTestId('login-button').click();
}

test('standard user can log in and sees the products', async ({ page }) => {
  await logIn(page, saucedemo.users.standard);
  await expect(page.getByTestId('title')).toHaveText('Products');
  await expect(page.getByTestId('inventory-item')).toHaveCount(6);
});

test('locked-out user gets an error', async ({ page }) => {
  await logIn(page, saucedemo.users.lockedOut);
  await expect(page.getByTestId('error')).toContainText('this user has been locked out');
});

test('add two items and check out', async ({ page }) => {
  await logIn(page, saucedemo.users.standard);
  await page.getByTestId('add-to-cart-sauce-labs-backpack').click();
  await page.getByTestId('add-to-cart-sauce-labs-bike-light').click();
  await expect(page.getByTestId('shopping-cart-badge')).toHaveText('2');

  await page.getByTestId('shopping-cart-link').click();
  await page.getByTestId('checkout').click();
  await page.getByTestId('firstName').fill('Thandi');
  await page.getByTestId('lastName').fill('Mokoena');
  await page.getByTestId('postalCode').fill('2196');
  await page.getByTestId('continue').click();
  await expect(page.getByTestId('inventory-item')).toHaveCount(2);
  await page.getByTestId('finish').click();
  await expect(page.getByTestId('complete-header')).toHaveText('Thank you for your order!');
});
