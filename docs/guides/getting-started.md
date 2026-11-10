# Getting started in 10 minutes

aipw adds an `ai` fixture to Playwright Test. You write steps in English (`ai.act`, `ai.assert`, `ai.extract`), the
model works them out the first time, and later runs replay the recorded locators without the model.

> Not on npm yet: the first release is pending. Until then, use the tarball install at the end of this section.

## 1. Install (2 minutes)

In your project folder:

```bash
npm init aipw@latest       # or: pnpm create aipw · yarn create aipw
```

It asks which model provider to use, then installs `aipw`, that provider's package and `@playwright/test` with your
package manager, downloads Chromium and runs `npx aipw init`. That writes `aipw.config.ts` (`.mts` in a CommonJS
project), an example spec, `playwright.config.ts` if you have none, a `.gitignore` line (a whole `.gitignore` if
you have none), and
`.github/instructions/aipw-tests.instructions.md` so Copilot writes good aipw tests. It never overwrites a file; for
an existing Playwright config it prints the two lines to change. Add `-- --dry-run` to see the commands first.

By hand, the same thing is:

```bash
npm i -D aipw @aipw/provider-claude-code @playwright/test
npx playwright install chromium
npx aipw init
```

Steps 3–5 below show what `aipw init` sets up.

**Before the first release:** build tarballs from a clone of this repository (`npm ci && npm run pack` writes
`dist-packages/*.tgz`) and install them together in your project:
`npm i -D <clone>/dist-packages/{aipw,aipw-core,aipw-test,aipw-cli,aipw-provider-claude-code}-0.1.0.tgz @playwright/test`.

## 2. Pick a model (2 minutes)

The default provider is **`claude-code`**: it runs on your Claude subscription through the Claude Agent SDK, with no
API key.

```bash
claude auth login      # once, in a terminal; the desktop app's sign-in does not carry over
npx aipw doctor        # says whether Claude Code is signed in (the login expires now and then), without a model call
```

Leave `ANTHROPIC_API_KEY` unset: if it is set, the SDK bills the key instead of your plan. Choose the model with
`AIPW_MODEL` (for example `claude-sonnet-5-5`).

### Switching providers

Each provider is its own package, so you only download the SDK you use. To switch:

1. Install its package (table below).
2. Set `provider` in `aipw.config.ts`, or set `AIPW_PROVIDER` for one run (`AIPW_MODEL` picks the model).
3. Check it: `npx aipw doctor --provider <name> --probe` makes one tiny live call.

| `provider` | Package | Needs |
|---|---|---|
| `claude-code` | `@aipw/provider-claude-code` | `claude auth login` once |
| `foundry` | `@aipw/provider-openai` | `AZURE_FOUNDRY_RESOURCE`, `AIPW_FOUNDRY_DEPLOYMENT`; keyless via `az login`, or `AZURE_FOUNDRY_API_KEY` |
| `openai` | `@aipw/provider-openai` | `OPENAI_API_KEY`, `AIPW_OPENAI_MODEL` |
| `anthropic` | `@aipw/provider-anthropic` | `ANTHROPIC_API_KEY` |
| `copilot` | `@aipw/provider-copilot` | Copilot CLI signed in on this machine |
| `ollama`, `github-models` | `@aipw/provider-openai` | A local Ollama; `GITHUB_TOKEN` |

For example, a pipeline on Foundry while you develop on your Claude plan:

```bash
npm i -D @aipw/provider-openai
AIPW_PROVIDER=foundry npx aipw doctor --probe
AIPW_PROVIDER=foundry npx playwright test
```

Any other OpenAI-compatible endpoint (OpenRouter, Groq, a company gateway) is a config entry, and a provider of your
own is a small module: [05 §7.1](../05-llm-providers.md).

## 3. Configure (1 minute)

`aipw.config.ts` at the repository root:

```ts
import { defineAipwConfig } from 'aipw';

export default defineAipwConfig({
  provider: 'claude-code',
  secrets: { map: { password: 'TEST_PASSWORD' } }, // secret name → environment variable
});
```

`playwright.config.ts`: wrap the config and add the run summary reporter.

```ts
import { defineConfig } from '@playwright/test';
import { withAipw } from 'aipw';

export default defineConfig(
  withAipw({
    testDir: 'tests',
    reporter: [['list'], ['html', { open: 'never' }], ['aipw/reporter']],
    use: { baseURL: 'http://localhost:5173', testIdAttribute: 'data-testid' },
  }),
);
```

## 4. Write a test (3 minutes)

Not sure how to phrase a step? Try it on the real page first, and save what works as a spec:

```bash
npx aipw try https://your.app/login "Log in as the admin" "Verify that the dashboard is shown" --headed --save tests/login.spec.ts
```

Or write one by hand:

```ts
// tests/users.spec.ts
import { expect, test } from 'aipw';

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
