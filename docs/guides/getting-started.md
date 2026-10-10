# Getting started in 10 minutes

aipw adds an `ai` fixture to Playwright Test. You write steps in English (`ai.act`, `ai.assert`, `ai.extract`), the
model works them out the first time, and later runs replay the recorded locators without the model.

> The packages are not on npm yet. Use them from this repository (an npm workspace), or point your project at the
> built `packages/*/dist` folders.

## 1. Install (2 minutes)

```bash
git clone https://github.com/knoppies999/ai-playwright.git
cd ai-playwright
npm ci
npx playwright install chromium
npm run build
```

## 2. Pick a model (2 minutes)

The default provider is **`claude-code`**: it runs on your Claude subscription through the Claude Agent SDK, with no
API key.

```bash
claude auth login      # once, in a terminal; the desktop app's sign-in does not carry over
```

Leave `ANTHROPIC_API_KEY` unset: if it is set, the SDK bills the key instead of your plan. Choose the model with
`AIPW_MODEL` (for example `claude-sonnet-5-5`). Other providers (Foundry, OpenAI, Anthropic API, Copilot CLI) are in
[05](../05-llm-providers.md).

## 3. Configure (1 minute)

`aipw.config.ts` at the repository root:

```ts
import { defineAipwConfig } from '@aipw/core';

export default defineAipwConfig({
  provider: 'claude-code',
  secrets: { map: { password: 'TEST_PASSWORD' } }, // secret name → environment variable
});
```

`playwright.config.ts`: wrap the config and add the run summary reporter.

```ts
import { defineConfig } from '@playwright/test';
import { withAipw } from '@aipw/test';

export default defineConfig(
  withAipw({
    testDir: 'tests',
    reporter: [['list'], ['html', { open: 'never' }], ['@aipw/test/reporter']],
    use: { baseURL: 'http://localhost:5173', testIdAttribute: 'data-testid' },
  }),
);
```

## 4. Write a test (3 minutes)

```ts
// tests/users.spec.ts
import { expect, test } from '@aipw/test';

test('admin can create a user', async ({ page, ai, gen }) => {
  await page.goto('/login');
  await ai.act('Log in as the admin', { data: { username: 'admin' }, secrets: ['password'] });
  await ai.act('Open Settings > Users and click "Add user"');
  await ai.act('Fill in the new user form and save', {
    data: { firstName: 'Thandi', lastName: 'Mokoena', email: gen.email() },
  });
  await ai.assert('The new user Thandi Mokoena is in the user list');
  await expect(page).toHaveURL(/\/users$/); // plain Playwright works alongside
});
```

Plain Playwright and `ai.*` mix freely. Do setup that isn't under test (API logins, seeding) in code.

## 5. Run it (2 minutes)

```bash
TEST_PASSWORD=... npx playwright test tests/users.spec.ts
```

The first run calls the model for each step and writes `tests/__aipw__/users.spec.ts.plans.json`. **Commit that
file.** The next run replays it with no model calls. When the UI changes, a broken plan heals itself (by fingerprint
first, then by the model) and the run summary tells you what changed.

After the run:

- the console shows the aipw summary (steps from cache, AI, healed, LLM calls, tokens, estimated cost);
- `.aipw/summary.md` has the same as Markdown;
- in the HTML report each AI step is a step with its decisions attached, and each action a nested step.

## Next

- A step went the wrong way? Step through it with `npx aipw nudge tests/users.spec.ts:7` ([07](../07-nudge-mode.md)).
- [Writing good instructions](writing-instructions.md)
- [Troubleshooting](troubleshooting.md)
- CI: a replay-only PR gate and a nightly run, in `azure-pipelines/` ([09](../09-configuration-reporting-ci.md) §3).
