# aipw — AI-driven Playwright testing

> Working name. Rename freely; the npm scope `@aipw/*` and the CLI name `aipw` are placeholders.

A TypeScript framework on top of **Playwright Test**. You write end-to-end tests that mix
plain English steps with ordinary Playwright code:

```ts
import { test, expect, z } from 'aipw';

test('admin can create a user', async ({ page, ai, gen }) => {
  await loginAs(page, 'admin');                       // plain Playwright code
  await ai.act('Open Settings > Users');               // English
  await ai.act('Click "Add user" and fill in the form', {
    data: { firstName: 'Thandi', idNumber: gen.saId({ born: '1990-04-12' }) },
  });
  await ai.act('Save the user');
  await ai.assert('A confirmation that the user was created is visible');
  const count = await ai.extract('number of rows in the users table', z.number());
  expect(count).toBeGreaterThan(0);                   // plain assertion again
});
```

## What it does

| Capability | Summary | Doc |
|---|---|---|
| English steps | `ai.act`, `ai.assert`, `ai.extract`, `ai.locate`, `ai.run` | [03](docs/03-test-authoring-api.md) |
| Hybrid scripting | Code calls AI, and English steps can call your code (registered tools such as `login`) | [03](docs/03-test-authoring-api.md) |
| Page understanding | Playwright AI-mode accessibility snapshots with element refs, plus a screenshot fallback | [04](docs/04-agent-loop-and-perception.md) |
| Element identification | Test-id attributes first (any spelling: `data-testid`, `data-test-id`, `data-test`…), then role/label/anchored locators, fingerprint healing, AI healing | [12](docs/12-element-identification.md) |
| Provider-agnostic | Claude Code subscription (dev here, no API key), Anthropic API, OpenAI models on Microsoft Foundry (pipelines), GitHub Copilot CLI (local, another machine) | [05](docs/05-llm-providers.md) |
| Deterministic replay | Successful AI steps are cached as locators and replayed without an LLM. Self-heals when the UI changes | [06](docs/06-caching-and-replay.md) |
| **Nudge mode** | Step through a run, rewind, correct the AI, and get back a verified better step (instruction, hint or code) | [07](docs/07-nudge-mode.md) |
| Valid test data | Generators (SA ID, Luhn, IBAN, email…), `{{data}}` and `{{secret}}` placeholders, redaction | [08](docs/08-test-data-and-secrets.md) |
| CI-ready | Playwright reporter attachments, cost tracking, Azure Pipelines YAML | [09](docs/09-configuration-reporting-ci.md) |

## Documentation

1. [Requirements and decisions](docs/01-requirements.md)
2. [Architecture](docs/02-architecture.md)
3. [Test authoring API](docs/03-test-authoring-api.md)
4. [Agent loop and page perception](docs/04-agent-loop-and-perception.md)
5. [LLM providers](docs/05-llm-providers.md)
6. [Caching, replay and self-healing](docs/06-caching-and-replay.md)
7. [Nudge mode](docs/07-nudge-mode.md)
8. [Test data and secrets](docs/08-test-data-and-secrets.md)
9. [Configuration, reporting and CI](docs/09-configuration-reporting-ci.md)
10. [Implementation plan](docs/10-implementation-plan.md)
11. [Risks and open questions](docs/11-risks-and-open-questions.md)
12. [Element identification](docs/12-element-identification.md): refs vs locators, test ids, how injection works

Guides: [Getting started in 10 minutes](docs/guides/getting-started.md) ·
[Writing good instructions](docs/guides/writing-instructions.md) · [Troubleshooting](docs/guides/troubleshooting.md)

Implementers (human, Copilot or Claude) start with [AGENTS.md](AGENTS.md).

## Use it in your project

```bash
npm init aipw@latest     # installs aipw, a provider and Playwright, then writes the config and an example spec
```

Specs then `import { test, expect, z } from 'aipw'`. Not on npm yet: until the first release, the
[getting started guide](docs/guides/getting-started.md) shows the tarball install. Releases are published by CI
([releasing](docs/guides/releasing.md)).

## Try it

```bash
npm ci
npx playwright install chromium
npm run demo:replay      # ~1 minute. No AI, no sign-in, no internet: the showcase replays its committed plan
claude auth login        # once, for the default claude-code provider (runs on your Claude plan)
npm run demo             # the whole story, narrated
```

`npm run demo` runs four admin tests on the local demo app (a hover-only menu, two identical "Save" buttons, a
server-validated form filled with generated SA ID / IBAN / phone values and a secret password, and a whole flow written
as an `ai.run` script) four times. A live run on Sonnet 5.5 (the table is also saved to `.aipw/demo.md`):

| Phase | What happens | From cache | LLM calls | Time |
|---|---|---|---|---|
| Record | The model works out every English step; aipw stores durable locators | 0/15 | 30 | ~3 min |
| Replay | Same UI: plain Playwright, no model | 15/15 | 0 | ~8 s |
| Redesign | Test ids renamed (healed by fingerprint, free), menu moved and renamed (healed by the model) | 12/15, 3 healed | 6 | ~55 s |
| Replay the redesign | The healed plan, no model | 15/15 | 0 | ~8 s |

Add `--headed` to watch: `npm run demo -- --headed`. The spec is [examples/tests/showcase/admin.spec.ts](examples/tests/showcase/admin.spec.ts).

### Try steps before writing a test

`npx aipw try <url> "<step>" …` runs English steps on a page and shows what the AI did, the locators it found, the
Playwright code and the cost. `--save` turns them into a spec that records once and then replays without the model.
With no steps, `npx aipw try <url>` is interactive: type a step, see what happened, type the next, `save <file>` when done:

```text
$ npx aipw try https://www.gov.uk/bank-holidays "Show the bank holidays for Northern Ireland" \
    "Verify that the Northern Ireland tab is selected" "Read the name of the next bank holiday as nextHoliday" \
    --save e2e/ni-holidays.spec.ts
1. act: Show the bank holidays for Northern Ireland
   click tab "Northern Ireland" → getByRole('tab', { name: 'Northern Ireland', exact: true })
   (16.8 s, 3 model calls)
2. assert: the Northern Ireland tab is selected
   ✓ The Northern Ireland tab is marked active and selected, and its tabpanel is the one shown.
3. extract: the name of the next bank holiday
nextHoliday = "Christmas Day"
Wrote e2e/ni-holidays.spec.ts. Run it once to record its plan: npx playwright test e2e/ni-holidays.spec.ts
```

### See what was recorded

Plans are committed JSON, readable with `aipw cache show`:

```text
$ npx aipw cache show examples/tests/showcase/admin.spec.ts --grep "reads the table"
  act: Open the users page from the settings menu
    click button "Settings" → getByRole('button', { name: 'Settings', exact: true })
    click link "Users" → getByRole('link', { name: 'Users', exact: true })
  assert: Thandi Mokoena is Active and Sipho Dlamini is Disabled
    check: toHaveText(locator('tr').filter({ hasText: 'Thandi Mokoena' }).getByRole('cell', { name: 'Active', exact: true })) ["Active"]
    check: toHaveText(locator('tr').filter({ hasText: 'Sipho Dlamini' }).getByRole('cell', { name: 'Disabled', exact: true })) ["Disabled"]
```

Assertions compile to one deterministic check per clause and replay without the model. When one can't, the plan
says why (`check: none (judged by AI on every run): …`), and `npx aipw cache stats` counts those steps per spec.

`npx aipw cache code <spec>` prints the same plans as plain Playwright, to review what replays or to turn a flow
that has settled into ordinary code:

```ts
// ai.act('Open the users page from the settings menu')
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page.getByRole('link', { name: 'Users', exact: true }).click();
// ai.assert('A message says the notifications were saved')
await expect(page.locator('[id="status"]')).toContainText('Notifications saved');
```

### More example suites

| Suite | Run | Shows |
|---|---|---|
| Showcase (local demo app) | `npm run demo` | Record, replay, heal; generated data; secrets |
| TodoMVC | `npm run e2e:todomvc` | Hover-only delete, double-click edit, checkbox state, reload |
| SauceDemo | `npm run e2e:llm` | Login, cart, checkout, sorting, a 13-scenario usability suite |
| The Internet | `npm run e2e:the-internet` | Dynamic loading, JS prompts, unlabeled checkboxes, sortable tables |
| Real sites: Wikipedia, GOV.UK | `npm run e2e:real-sites` | Real public sites, read-only: search with autocomplete, a lazily loaded language menu across subdomains, infobox and table reads |
| Toolshop | `npm run e2e:toolshop` | A bigger live shop: search, filters, registration, guest checkout |

Prefix any of them with `AIPW_CACHE=replay-only` to prove a suite runs with zero AI calls. The showcase, TodoMVC,
SauceDemo, The Internet and the real-sites suite do. Toolshop is a shared public site whose stock and accounts change under you, so expect
occasional heals there.

## Providers

| Provider | Use it for | Package | Set up |
|---|---|---|---|
| `claude-code` (default) | Local development on your Claude subscription, no API key | `@aipw/provider-claude-code` | `claude auth login` |
| `foundry` / `openai` | Pipelines (Azure Pipelines, OpenAI models on Microsoft Foundry, keyless via Entra) | `@aipw/provider-openai` | [09](docs/09-configuration-reporting-ci.md) §3 |
| `anthropic` | Claude with an API key | `@aipw/provider-anthropic` | `ANTHROPIC_API_KEY` |
| `copilot` | GitHub Copilot CLI on a machine that has it | `@aipw/provider-copilot` | [05](docs/05-llm-providers.md) §5 |

To switch: install its package, set `provider` in `aipw.config.ts` (or `AIPW_PROVIDER` for one run, `AIPW_MODEL` for the model), then check it with `npx aipw doctor --provider <name> --probe`. More, including any OpenAI-compatible endpoint or a provider of your own: [getting started §2](docs/guides/getting-started.md#switching-providers) and [05 §7.1](docs/05-llm-providers.md).

## Status

All phases in [docs/10](docs/10-implementation-plan.md) are implemented. What has and hasn't been proven:

- **Proven live on this machine (claude-code, Sonnet 5.5):** the showcase, TodoMVC, SauceDemo and The Internet suites
  record, replay with zero AI in replay-only mode, and heal.
- **Contract-tested, not yet run live:** the Foundry/OpenAI, Anthropic API and Copilot CLI providers, and the Azure
  Pipelines PR-gate and nightly pipelines. These need credentials or machines this one doesn't have
  ([spikes/README.md](spikes/README.md)).
- **Nudge mode** (`npx aipw nudge`) has been run live with keystrokes piped in (a hint, then applying the verified fix),
  but not yet driven by a person at a keyboard.

Development: `npm run check` (lint, typecheck, unit tests) and `npm run e2e` (FakeProvider suites, no AI).

## License

[MIT](LICENSE)
