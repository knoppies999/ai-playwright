# 03 — Test authoring API

The public surface is a Playwright Test fixture named `ai` (plus `gen` for data generators).
Everything else in a test is normal Playwright.

## 1. Setup

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import { withAipw } from '@aipw/test';

export default defineConfig(withAipw({
  testDir: './tests',
  use: { baseURL: 'http://localhost:5173', trace: 'on-first-retry' },
  webServer: { command: 'npm run dev -w demo-app', port: 5173, reuseExistingServer: true },
}));
```

```ts
// aipw.config.ts — see docs/09 for every option
import { defineAipwConfig } from '@aipw/core';

export default defineAipwConfig({
  provider: process.env.AIPW_PROVIDER ?? 'claude-code',
  cache: { mode: process.env.AIPW_CACHE ?? 'auto' },
});
```

```ts
// tests/users.spec.ts
import { test, expect } from '@aipw/test';
```

`@aipw/test` re-exports Playwright's `test`, extended with these fixtures:

| Fixture | Scope | Type |
|---|---|---|
| `ai` | test | `Ai`, bound to the test's `page` |
| `gen` | test | `Generators`, seeded per test for reproducibility |
| `aiConfig` | worker | resolved config (override per file with `test.use({ aiConfig: {...} })`) |

## 2. `ai.act(instruction, options?)`

Performs whatever UI actions satisfy the instruction.

```ts
await ai.act('Open Settings > Users');
await ai.act('Hover the gear icon in the top-right header, then click "Users" in the flyout');
const r = await ai.act('Fill in the new user form', {
  data: { firstName: 'Thandi', lastName: 'Mokoena', email: gen.email() },
  secrets: ['initialPassword'],                   // value from env/secret provider, never sent to the model
  hints: ['Province is a searchable combobox; type then pick the option'],
  scope: page.getByRole('dialog', { name: 'New user' }),
  maxActions: 15,
});
r.values;      // { idNumber: '9004125800087', ... } includes generated values
r.actions;     // ActionRecord[]
r.source;      // 'cache' | 'ai' | 'healed' | 'nudged'
```

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `data` | `Record<string, unknown>` | `{}` | Values the model must use verbatim. The model sees them |
| `secrets` | `string[]` | `[]` | Names of secrets. The model sees `{{secret.name}}`, the executor substitutes the value |
| `hints` | `string[]` | `[]` | Extra guidance for this step only |
| `scope` | `Locator` | page | Restrict observation and actions to a region |
| `maxActions` | `number` | config (`12`) | Hard cap on decisions for this step |
| `timeout` | `number` (ms) | config (`60_000`) | Wall-clock cap for the step |
| `vision` | `'auto' \| 'always' \| 'never'` | `'auto'` | Attach screenshots to decisions |
| `cache` | `'auto' \| 'off' \| 'refresh'` | config | Per-step cache override |
| `key` | `string` | derived | Stable cache key override (survives instruction edits) |
| `allowNavigation` | `boolean` | `false` | May the model call `navigate(url)` (always limited to allowed origins) |
| `tools` | `string[]` | all registered | Which code tools this step may use |

### Writing good instructions

- **One goal per `act`.** Prefer 3 short `act`s over one paragraph. Each becomes a separate cache entry and report step.
- Use **visible labels in quotes** when you know them: `Click "Add user"`.
- Be **detailed exactly where the UI is tricky**: hover menus, icon-only buttons, ambiguous duplicates
  ("the Save button in the dialog footer, not the page header").
- **Put values in `data`, not in prose.** `data: { email }` beats `"fill email with x@y.z"`, and
  it keeps the cache key stable.
- Say **what done looks like** for multi-action steps: "...until the Users table is visible".

## 3. `ai.assert(condition, options?)` and `ai.check(...)`

```ts
await ai.assert('A success message says the user was created');
await ai.assert('The users table contains Thandi Mokoena with status Active', { timeout: 10_000 });

const verdict = await ai.check('Is there an error banner?');   // never throws
if (verdict.pass) { /* ... */ }
```

- **Retries until `timeout`** (default 5 s), like Playwright web-first assertions. It re-observes
  between attempts, but with **at most one LLM judgement per distinct snapshot hash** to save cost.
- The verdict is structured: `{ pass, reason, evidence: string[] (quoted page text), refs: string[] }`.
- On first success the model also proposes a **compiled check**, e.g.
  `expect(page.getByRole('status')).toContainText('User created')`. It is stored in the cache, so
  replays run the compiled check with no LLM ([06](06-caching-and-replay.md) §5).
- Failure throws `AiAssertionError`, with the reason, evidence and a screenshot attached to the report.
- Use `soft: true` for `expect.soft` semantics.

## 4. `ai.extract(what, schema, options?)`

```ts
const total = await ai.extract('the order total in Rand', z.number());
const rows  = await ai.extract('every user row', z.array(z.object({
  name: z.string(), email: z.string().email(), status: z.enum(['Active', 'Disabled']),
})));
```

- Uses the provider's structured output (`structured()`), validated with Zod. One automatic
  repair retry with the validation error is fed back to the model.
- For long lists, scope it (`scope: page.getByRole('table')`). Virtualized lists only expose visible
  rows; use `options.scroll: true` to let it scroll and merge (deduplicated by schema key, `options.key`).

## 5. `ai.locate(description)` → `Locator`

Hands control back to code: AI finds the element, and Playwright code does the rest.

```ts
const kebab = await ai.locate('the actions menu button on the row for Thandi Mokoena');
await kebab.click();
await expect(kebab).toHaveAttribute('aria-expanded', 'true');
```

It returns the best **stable** locator from LocatorSynth (not an `aria-ref`, which is snapshot-scoped),
and it is cached like any other step.

## 6. `ai.run(script)` — English scripts

```ts
await ai.run(`
  - Open Settings > Users
  - Click "Add user"
  - Fill in the form using {{data}}
  - Save
  - Verify a success message is shown
  - Verify the users table contains {{data.firstName}}
`, { data: newUser });
```

- One bullet = one step. Lines starting with *Verify / Check / Assert / Expect / Ensure* become `ai.assert`.
  Lines starting with *Extract / Read / Get* followed by `as <name>` become `ai.extract` into `result.values[name]`.
- Each bullet is cached separately and reported as its own `test.step`.
- This is the bridge to an optional future `*.ai.md` file format (Phase 8).

## 7. Calling your code from English: code tools

Register functions the model may call as tools. This is the "programmatic steps in between,
triggered by English" direction.

```ts
// tests/fixtures.ts
import { test as base } from '@aipw/test';
import { z } from 'zod';

export const test = base.extend({
  ai: async ({ ai, page, request }, use) => {
    ai.tools.register({
      name: 'login_as',
      description: 'Log in as a named test user. Use this instead of filling the login form.',
      input: z.object({ role: z.enum(['admin', 'clerk', 'auditor']) }),
      run: async ({ role }) => { await loginAs(page, role); return `Logged in as ${role}`; },
    });
    ai.tools.register({
      name: 'seed_user',
      description: 'Create a user through the API (fast). Returns the created user as JSON.',
      input: z.object({ firstName: z.string(), lastName: z.string() }),
      run: async (u) => JSON.stringify(await (await request.post('/api/users', { data: u })).json()),
    });
    await use(ai);
  },
});
```

```ts
await ai.act('Log in as an auditor and open the audit log');   // the model calls login_as, then navigates the UI
```

Rules: tool input is Zod-validated. Tool output is returned to the model as text (keep it short). Code
tools are recorded in the cache like browser actions, so replay calls your function again with the same args.

## 8. Mixing code and AI: patterns

```ts
test('edit user', async ({ page, ai, gen, request }) => {
  // Fast deterministic setup in code
  const user = await createUserViaApi(request, { firstName: 'Sipho' });
  await page.context().addCookies(await adminSessionCookies());
  await page.goto(`/users/${user.id}`);

  // AI for the UI under test
  await ai.act('Open the Edit panel and change the phone number', { data: { phone: gen.phone('ZA') } });
  await ai.act('Save');

  // Deterministic verification in code where possible
  await expect(page.getByRole('status')).toContainText('Saved');
  // AI verification where the condition is fuzzy
  await ai.assert('The phone number shown on the profile matches the new value');
});
```

Guidelines:
1. **Set up state in code** (API calls, `storageState`, cookies). Use AI only for the UI being tested.
2. **Prefer code assertions** when the selector is obvious. Use `ai.assert` for fuzzy or visual conditions.
3. `ai.locate` is the escape hatch when you want AI to find an element and code to drive it.
4. Use `test.step` freely. AI steps nest inside your steps in the report.

## 9. Multiple pages and tabs

`ai` is bound to the fixture `page`. For other pages: `const ai2 = ai.on(otherPage)`.
When an action opens a new tab, the loop sees it in `Observation.tabs` and can call `switch_tab`.
`ai.page` always reflects the active page after a step.

## 10. Errors

| Error | When |
|---|---|
| `AiStepError` | Model called `fail`, or limits were hit. Includes `kind` (`not_found`, `ambiguous`, `blocked`, `unexpected_state`, `limit`), the last observation and the trajectory |
| `AiAssertionError` | `ai.assert` verdict false at timeout |
| `AiExtractError` | Output failed schema validation after the repair retry |
| `AiProviderError` | Provider/network/auth failure after retries (wraps the SDK error) |
| `AiCacheReplayOnlyMiss` | `cache.mode = 'replay-only'` and no plan exists |

All errors carry `stepId`, `callsite` and a `nudgeHint` string: the exact command to reproduce the
step in nudge mode, e.g. `npx aipw nudge tests/users.spec.ts:14 --at step-3`.
