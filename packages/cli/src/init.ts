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
  return `import { defineAipwConfig } from 'aipw';

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

/** GitHub Copilot path-specific instructions: how to write aipw tests well, for whoever (or whatever) writes them. */
export function assistantInstructions(dir: string): string {
  return `---
applyTo: '${dir}/**/*.spec.ts'
---

# Writing aipw tests

These are Playwright tests with English steps from \`aipw\`:\`ai.act\`, \`ai.assert\`, \`ai.extract\`, \`ai.locate\`,
\`ai.run\`. The first run asks the model and records a plan in \`__aipw__/\`; later runs replay it without the model.

- Import \`test\`, \`expect\` and \`z\` (for extract schemas) from \`aipw\`, never from \`@playwright/test\`.
- One goal per \`ai.act\`, naming what is on screen in quotes: \`ai.act('Click "Save" in the Notifications section')\`.
- Values go in \`data\`, passwords in \`secrets\` (names from \`aipw.config.ts\`), never in the instruction text:
  \`ai.act('Log in as the admin', { data: { username: 'admin' }, secrets: ['password'] })\`.
- Negative paths start with "Try to": \`ai.act('Try to sign in with this password', { data })\`.
- Assertions are specific and visible: \`ai.assert('The status says "Profile saved"')\`, not "it worked".
- Extract exactly what the page shows and derive the rest in code (so it replays without the model):
  \`const label = await ai.extract('the text of the download button', z.string())\`, then a regex in code.
- Setup that isn't under test (API logins, seeding) is plain Playwright code. Add a cheap code assertion next to
  an AI assertion where you can.
- Never edit \`__aipw__/*.plans.json\` by hand. To try a step on a page first: \`npx aipw try <url> "<step>"\`. To see
  what a spec replays: \`npx aipw cache show <spec>\`. A failing step prints \`npx aipw nudge <spec>:<line>\` to step through it.
`;
}

export function exampleSpec(): string {
  return `// An aipw example on Playwright's public TodoMVC demo. Run: npx playwright test ${'{dir}'}/aipw-example.spec.ts
// The first run asks the model; it records a plan in __aipw__/ next to this file. Commit that plan: later runs
// replay it with no model calls, and heal it if the page changes.
import { expect, test, z } from 'aipw';

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
import { withAipw } from 'aipw';

export default defineConfig(
  withAipw({
    testDir: '${dir}',
    reporter: [['list'], ['html', { open: 'never' }], ['aipw/reporter']],
    use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  }),
);
`;
}

const PLAYWRIGHT_CHANGES = `  1. Wrap the config:   export default defineConfig(withAipw({ … }))   with   import { withAipw } from 'aipw';
  2. Add the reporter:  reporter: [['list'], ['aipw/reporter']]`;

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
  // For GitHub Copilot in VS Code (and any assistant that reads it): how to write these tests well.
  write(join('.github', 'instructions', 'aipw-tests.instructions.md'), assistantInstructions(dir.replace(/\\/g, '/')));

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
  const slash = (p: string) => p.replace(/\\/g, '/');
  for (const f of res.written) console.log(`  wrote    ${slash(f)}`);
  for (const f of res.skipped) console.log(`  exists   ${slash(f)} (left alone; --force overwrites)`);
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
