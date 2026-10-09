// Shared Chromium for unit tests that need a real page. Pages load static HTML with setContent:
// no network (AGENTS.md: `npm test` makes no network calls).
import { chromium, selectors, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll } from 'vitest';
import { fixture } from './golden.js';

let browser: Browser | undefined;

export function useBrowser(): { page: (html: string, options?: { testIdAttribute?: string }) => Promise<Page> } {
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });
  return {
    page: async (html, options = {}) => {
      selectors.setTestIdAttribute(options.testIdAttribute ?? 'data-testid');
      const page = await browser!.newPage();
      await page.setContent(html);
      return page;
    },
  };
}

export const html = (name: string) => fixture('html', name);
