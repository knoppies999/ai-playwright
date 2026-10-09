# aipw — AI-driven Playwright testing

> Working name. Rename freely; the npm scope `@aipw/*` and the CLI name `aipw` are placeholders.

A TypeScript framework on top of **Playwright Test**. You write end-to-end tests that mix
plain English steps with ordinary Playwright code:

```ts
import { test, expect } from '@aipw/test';
import { z } from 'zod';

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
| Provider-agnostic | Claude Code subscription (dev here, no API key), Anthropic API, OpenAI models on Microsoft Foundry (pipelines), GitHub Copilot SDK (local, another machine) | [05](docs/05-llm-providers.md) |
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

Implementers (human, Copilot or Claude) start with [AGENTS.md](AGENTS.md).

## Status

**Phases 0–1 are done (two spikes still need other machines). Phase 2, the AI engine, works end to end** on the Claude Code subscription: 12 of 13 SauceDemo scenarios passed on the first live run ([report](examples/targets/saucedemo/usability-report.md)).

- Phase 0 results and the design changes they caused are in [docs/11](docs/11-risks-and-open-questions.md) §3.
  Two spikes still need another machine: 0.3 (Copilot machine) and
  0.4 (Foundry). See [spikes/README.md](spikes/README.md).
- Phase 1 gave us the npm workspaces monorepo, the SauceDemo target profile and scenarios, a plain-Playwright smoke
  spec, and CI (Azure Pipelines + GitHub Actions).

```bash
npm install
npx playwright install chromium
cp .env.example .env     # SauceDemo's public demo password
npm run build && npm test && npm run e2e   # no AI calls
claude auth login        # once, for the claude-code provider
npm run e2e:llm          # SauceDemo usability suite: real AI calls on your Claude plan
```
