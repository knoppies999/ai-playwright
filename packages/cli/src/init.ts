// `aipw init [--provider x] [--dir tests] [--force]`: sets up aipw in an existing project. Writes what's missing
// (aipw.config.ts, an example spec, playwright.config.ts if there is none) and never edits a file that exists
// unless --force; for an existing Playwright config it prints the two changes to make instead.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const PROVIDERS = ['claude-code', 'foundry', 'openai', 'anthropic', 'copilot'] as const;
type Provider = (typeof PROVIDERS)[number];

const PROVIDER_NOTES: Record<Provider, string> = {
  'claude-code': 'Runs on your Claude subscription (no API key). Sign in once with `claude auth login`.',
  foundry:
    'OpenAI models on Microsoft Foundry, for pipelines. Set AZURE_FOUNDRY_RESOURCE and AIPW_FOUNDRY_DEPLOYMENT; keyless via az login (or AZURE_FOUNDRY_API_KEY).',
  openai: 'The OpenAI API. Set OPENAI_API_KEY.',
  anthropic: 'The Anthropic API. Set ANTHROPIC_API_KEY.',
  copilot: 'GitHub Copilot CLI on this machine. Sign in with `copilot` once.',
};

const PLAYWRIGHT_CONFIGS = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.js',
  'playwright.config.mjs',
];

export function configFile(provider: Provider): string {
  return `import { defineAipwConfig } from '@aipw/core';

export default defineAipwConfig({
  // ${PROVIDER_NOTES[provider]}
  // Override per run with AIPW_PROVIDER (claude-code, foundry, openai, anthropic, copilot) and AIPW_MODEL.
  provider: '${provider}',
  secrets: {
    // Secret name → environment variable. Steps refer to secrets by name; the model never sees the value.
    map: {},
  },
});
`;
}

export function exampleSpec(): string {
  return `// An aipw example on Playwright's public TodoMVC demo. Run: npx playwright test ${'{dir}'}/aipw-example.spec.ts
// The first run asks the model; it records a plan in __aipw__/ next to this file. Commit that plan: later runs
// replay it with no model calls, and heal it if the page changes.
import { expect, test } from '@aipw/test';
import { z } from 'zod';

test.beforeEach(async ({ page }) => {
  await page.goto('https://demo.playwright.dev/todomvc/');
});

test('add, complete and count todos', async ({ page, ai }) => {
  await ai.act('Add three todos: buy milk, walk the dog, call mum');
  await ai.act('Mark "walk the dog" as done');
  await ai.assert('"walk the dog" is completed and 2 items are left');

  const todos = await ai.extract(
    'every todo and whether it is completed',
    z.array(z.object({ title: z.string(), completed: z.boolean() })),
  );
  expect(todos).toContainEqual({ title: 'walk the dog', completed: true });

  // Plain Playwright works alongside.
  await expect(page.getByTestId('todo-item')).toHaveCount(3);
});
`;
}

export function playwrightConfig(dir: string): string {
  return `import { defineConfig, devices } from '@playwright/test';
import { withAipw } from '@aipw/test';

export default defineConfig(
  withAipw({
    testDir: '${dir}',
    reporter: [['list'], ['html', { open: 'never' }], ['@aipw/test/reporter']],
    use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  }),
);
`;
}

const PLAYWRIGHT_CHANGES = `  1. Wrap the config:   export default defineConfig(withAipw({ … }))   with   import { withAipw } from '@aipw/test';
  2. Add the reporter:  reporter: [['list'], ['@aipw/test/reporter']]`;

const GITIGNORE_LINES = ['.aipw/'];

export interface InitResult {
  written: string[];
  skipped: string[];
  messages: string[];
}

export function init(
  root: string,
  options: { provider?: string; dir?: string; force?: boolean } = {},
): InitResult | { error: string } {
  const provider = (options.provider ?? 'claude-code') as Provider;
  if (!PROVIDERS.includes(provider))
    return { error: `Unknown provider "${provider}". Use one of: ${PROVIDERS.join(', ')}.` };
  const dir = options.dir ?? 'tests';
  const result: InitResult = { written: [], skipped: [], messages: [] };
  const write = (path: string, content: string) => {
    const full = join(root, path);
    if (existsSync(full) && !options.force) {
      result.skipped.push(path);
      return;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    result.written.push(path);
  };

  write('aipw.config.ts', configFile(provider));
  write(join(dir, 'aipw-example.spec.ts'), exampleSpec().replace('{dir}', dir.replace(/\\/g, '/')));

  const existing = PLAYWRIGHT_CONFIGS.find((c) => existsSync(join(root, c)));
  if (!existing) write('playwright.config.ts', playwrightConfig(dir.replace(/\\/g, '/')));
  else if (!/withAipw/.test(readFileSync(join(root, existing), 'utf8'))) {
    result.messages.push(`${existing} exists, so it was left alone. Make two changes to it:\n${PLAYWRIGHT_CHANGES}`);
  }

  const gitignore = join(root, '.gitignore');
  const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const missing = GITIGNORE_LINES.filter((l) => !current.split(/\r?\n/).includes(l));
  if (missing.length) {
    appendFileSync(
      gitignore,
      `${current && !current.endsWith('\n') ? '\n' : ''}# aipw run summaries and healed plans\n${missing.join('\n')}\n`,
    );
    result.written.push(relative(root, gitignore) || '.gitignore');
  }
  return result;
}

export function runInit(args: string[], root = process.cwd()): number {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const provider = value('--provider');
  const dir = value('--dir');
  const res = init(root, { ...(provider && { provider }), ...(dir && { dir }), force: args.includes('--force') });
  if ('error' in res) {
    console.error(res.error);
    return 1;
  }
  for (const f of res.written) console.log(`  wrote    ${f}`);
  for (const f of res.skipped) console.log(`  exists   ${f} (left alone; --force overwrites)`);
  for (const m of res.messages) console.log(`\n${m}`);
  const p = (provider ?? 'claude-code') as Provider;
  const spec = `${(dir ?? 'tests').replace(/\\/g, '/')}/aipw-example.spec.ts`;
  console.log(`
Next:
  ${p === 'claude-code' ? 'claude auth login                      # once' : `# ${PROVIDER_NOTES[p]}`}
  npx playwright install chromium
  npx aipw doctor --probe                # checks the provider with one tiny call
  npx playwright test ${spec}   # first run asks the model and records a plan
  npx playwright test ${spec}   # second run replays it: no model calls
  git add ${dirname(spec)}/__aipw__              # commit plans with your tests`);
  return 0;
}
