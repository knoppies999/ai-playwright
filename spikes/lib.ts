// Shared helpers for the Phase 0 spikes. Throwaway code: correctness over polish.
import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPIKES_DIR = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = join(SPIKES_DIR, 'out');

try {
  process.loadEnvFile(join(SPIKES_DIR, '..', '.env'));
} catch {
  // .env is optional
}

export const SAUCEDEMO = 'https://www.saucedemo.com';

export function out(name: string, content: string | object): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return path;
}

export async function launch(headless = true): Promise<Browser> {
  return chromium.launch({ headless });
}

export function sauceDemoPassword(): string {
  const value = process.env.SAUCEDEMO_PASSWORD;
  if (!value) throw new Error('Set SAUCEDEMO_PASSWORD (see .env.example).');
  return value;
}

const tid = (page: Page, id: string) => page.locator(`[data-test="${id}"]`);

// SauceDemo is a React SPA: the URL changes before the next view renders, so every step waits
// for an element of the view it expects.
export async function sauceDemoLogin(page: Page, user = 'standard_user'): Promise<void> {
  await page.goto(SAUCEDEMO);
  await tid(page, 'username').fill(user);
  await tid(page, 'password').fill(sauceDemoPassword());
  await tid(page, 'login-button').click();
  await tid(page, 'inventory-list').waitFor();
}

async function toCheckoutInfo(p: Page): Promise<void> {
  await sauceDemoLogin(p);
  await tid(p, 'add-to-cart-sauce-labs-backpack').click();
  await tid(p, 'shopping-cart-link').click();
  await tid(p, 'checkout').click();
  await tid(p, 'firstName').waitFor();
}

/** Every SauceDemo page in a normal purchase journey, as [name, how to get there] pairs. */
export const SAUCEDEMO_PAGES: [string, (page: Page) => Promise<void>][] = [
  [
    'login',
    async (p) => {
      await p.goto(SAUCEDEMO);
      await tid(p, 'login-button').waitFor();
    },
  ],
  ['inventory', async (p) => sauceDemoLogin(p)],
  [
    'item-detail',
    async (p) => {
      await sauceDemoLogin(p);
      await tid(p, 'item-4-title-link').click();
      await tid(p, 'back-to-products').waitFor();
    },
  ],
  [
    'menu-open',
    async (p) => {
      await sauceDemoLogin(p);
      await p.getByRole('button', { name: 'Open Menu' }).click();
      await tid(p, 'logout-sidebar-link').waitFor();
    },
  ],
  [
    'cart',
    async (p) => {
      await sauceDemoLogin(p);
      await tid(p, 'add-to-cart-sauce-labs-backpack').click();
      await tid(p, 'add-to-cart-sauce-labs-bike-light').click();
      await tid(p, 'shopping-cart-link').click();
      await tid(p, 'cart-list').waitFor();
    },
  ],
  ['checkout-info', toCheckoutInfo],
  [
    'checkout-overview',
    async (p) => {
      await toCheckoutInfo(p);
      await tid(p, 'firstName').fill('Thandi');
      await tid(p, 'lastName').fill('Mokoena');
      await tid(p, 'postalCode').fill('2196');
      await tid(p, 'continue').click();
      await tid(p, 'finish').waitFor();
    },
  ],
  [
    'checkout-complete',
    async (p) => {
      await toCheckoutInfo(p);
      await tid(p, 'firstName').fill('Thandi');
      await tid(p, 'lastName').fill('Mokoena');
      await tid(p, 'postalCode').fill('2196');
      await tid(p, 'continue').click();
      await tid(p, 'finish').click();
      await tid(p, 'complete-header').waitFor();
    },
  ],
];

/** Refs in an AI-mode snapshot, in document order, de-duplicated. */
export function refsIn(snapshot: string): string[] {
  return [...new Set([...snapshot.matchAll(/\[ref=([^\]]+)\]/g)].map((m) => m[1]!))];
}

export const approxTokens = (text: string): number => Math.ceil(text.length / 4);
