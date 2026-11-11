import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserType } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { launchProblem, loadChromium } from '../src/browser.js';

const fake = (name: string) => ({ name: () => name }) as unknown as BrowserType;

/** A project folder with stub packages in node_modules. */
function project(packages: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'aipw-browser-'));
  for (const pkg of packages) {
    const dir = join(root, 'node_modules', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, main: 'index.js' }));
    writeFileSync(join(dir, 'index.js'), '');
  }
  return root;
}

describe("the CLI's browser", () => {
  it("comes from the project's @playwright/test, not the CLI's own playwright-core", async () => {
    const root = project(['@playwright/test']);
    const loaded: string[] = [];
    const chromium = await loadChromium(root, async (specifier) => {
      loaded.push(specifier);
      // CommonJS packages arrive as a default export.
      return specifier.includes('node_modules')
        ? { default: { chromium: fake('project') } }
        : { chromium: fake('own') };
    });
    expect(chromium.name()).toBe('project');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatch(/^file:.*node_modules\/@playwright\/test\/index\.js$/);
  });

  it('falls back to its own playwright-core when the project has no Playwright', async () => {
    const chromium = await loadChromium(project([]), async (specifier) =>
      specifier === 'playwright-core' ? { chromium: fake('own') } : {},
    );
    expect(chromium.name()).toBe('own');
  });

  it('turns a missing browser into the command that installs it', () => {
    const missing = new Error("browserType.launch: Executable doesn't exist at C:/ms-playwright/chromium\n╔═══╗");
    expect(launchProblem(missing)).toContain('npx playwright install chromium');
    expect(launchProblem(new Error('spawn EPERM\n    at x'))).toBe('Could not start the browser: spawn EPERM');
  });
});
