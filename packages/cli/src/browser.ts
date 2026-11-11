// The browser for `aipw try` and `aipw nudge`. It must be the project's Playwright: the one `npx playwright install`
// downloaded browsers for, and the one the tests connect with. npm can give the CLI a newer playwright-core of its
// own (a project pinned to @playwright/test 1.64 got 1.65 next to it), whose browser build isn't installed.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserType } from 'playwright-core';

interface PlaywrightModule {
  chromium?: BrowserType;
  default?: { chromium?: BrowserType };
}

const chromiumOf = (mod: PlaywrightModule) => mod.chromium ?? mod.default?.chromium;

/** Chromium from the project's @playwright/test (or playwright), else from the CLI's own playwright-core. */
export async function loadChromium(
  from = process.cwd(),
  load: (specifier: string) => Promise<PlaywrightModule> = (s) => import(s) as Promise<PlaywrightModule>,
): Promise<BrowserType> {
  const require = createRequire(join(from, 'noop.js'));
  for (const pkg of ['@playwright/test', 'playwright', 'playwright-core']) {
    try {
      const chromium = chromiumOf(await load(pathToFileURL(require.resolve(pkg)).href));
      if (chromium) return chromium;
    } catch {
      // not installed in the project: try the next one
    }
  }
  const own = chromiumOf(await load('playwright-core'));
  if (!own) throw new Error('Playwright is not installed. Run: npm i -D @playwright/test');
  return own;
}

/** A launch failure as one readable line: a missing browser is a setup step, not a stack trace. */
export function launchProblem(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Executable doesn't exist|playwright install/i.test(message))
    return "The Chromium browser for this project's Playwright is not installed. Run: npx playwright install chromium";
  return `Could not start the browser: ${message.split('\n')[0]}`;
}
