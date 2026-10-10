# 09 — Configuration, reporting and CI

## 1. Configuration

`aipw.config.ts` at the repo root (found by walking up from the Playwright config). Resolution order:
**defaults → `aipw.config.ts` → environment variables → `test.use({ aiConfig })` → per-call options.**

```ts
import { defineAipwConfig } from '@aipw/core';

export default defineAipwConfig({
  provider: process.env.AIPW_PROVIDER ?? 'claude-code',
  providers: { /* see docs/05 §7 */ },

  steps: {
    maxActions: 12,            // decisions per ai.act
    timeoutMs: 60_000,
    assertTimeoutMs: 5_000,
    vision: 'auto',            // 'auto' | 'always' | 'never'
    allowClickXY: false,
  },
  snapshot: { maxTokens: 6_000, collapseSiblingsOver: 15 },
  settle:   { maxMs: 3_000, networkQuietMs: 300, domQuietMs: 200 },

  cache: {
    mode: process.env.AIPW_CACHE ?? 'auto',     // 'auto' | 'replay-only' | 'ai-only' | 'refresh'
    dir: '__aipw__',
  },
  heal: { policy: process.env.CI ? 'report' : 'accept' },   // 'accept' | 'report' | 'fail'

  navigation: { allowedOrigins: ['http://localhost:5173'] },  // baseURL origin is always allowed
  testIds: {                    // docs/12 §4: any spelling, normalised; auto-detected per origin
    attributes: ['data-testid', 'data-test-id', 'datatestid', 'data-test', 'data-qa', 'data-cy', 'data-pw', 'data-automation-id'],
    autoDetect: true,
  },
  refs: { source: 'auto', mode: 'attribute' },  // 'auto' | 'playwright' | 'injected' ; 'attribute' | 'handle' (docs/12 §2)
  files: { avatar: 'fixtures/avatar.png' },                   // the only files `upload` may use

  hints: { dir: 'hints' },
  secrets: { provider: 'env', map: { adminPassword: 'TEST_ADMIN_PASSWORD' } },

  budget: {                       // hard stops: the step fails with AiBudgetExceeded
    perStepUsd: 0.50,
    perRunUsd: 20,                // "run" = one Playwright worker process (workers don't share a counter)
    perRunRequests: 2_000,        // for providers without token pricing (Copilot)
  },
  retry: { retries: 4, baseMs: 1_000, maxMs: 30_000 },   // 429 / network: backoff with full jitter
  pricing: {                      // USD per 1M tokens, for cost estimates in reports
    'anthropic:claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  },

  nudge: { onFailure: false, verify: 'all' },
  log: { level: process.env.AIPW_LOG ?? 'info', dir: '.aipw/logs' },
});
```

### Environment variables

| Variable | Purpose |
|---|---|
| `AIPW_PROVIDER` | Provider key from `providers` |
| `AIPW_MODEL` | Overrides the selected provider's model |
| `AIPW_CLAUDE_MODEL` | Model for the `claude-code` provider (unset = the plan's default) |
| `AIPW_CACHE` | Cache mode |
| `AIPW_LOG` | `debug` prints every prompt and response (redacted) |
| `AIPW_NUDGE_PORT`, `AIPW_NUDGE_RESUME_AT` | Set by `aipw nudge`. Don't set these by hand |
| `ANTHROPIC_API_KEY` | Anthropic API adapter. **Leave unset for `claude-code`**: if it is set, the Agent SDK bills the key instead of your subscription |
| `AZURE_FOUNDRY_RESOURCE`, `AIPW_FOUNDRY_DEPLOYMENT` | Foundry preset (pipelines): resource name and model deployment name |
| `AZURE_FOUNDRY_API_KEY` | Foundry with an API key. Leave unset for keyless Entra ID auth (`DefaultAzureCredential`) |
| `OPENAI_API_KEY`, `AIPW_OPENAI_MODEL` | OpenAI directly |
| `GITHUB_TOKEN` | GitHub Models preset, or Copilot SDK without an interactive login |
| `AIPW_COPILOT_MODEL` | Copilot adapter model id |

### Hints files

```markdown
<!-- hints/localhost-5173.md -->
# Site: localhost:5173

## Everywhere
- Settings pages (Users, Roles, Audit log) are in the flyout under the gear icon in the header. Hover to open it.
- Toast messages disappear after 3 seconds; they are reported under NOTICES.

## /users/new
- "Province" is a searchable combobox: type part of the name, then click the option.
```

The file name is the origin with `:` → `-`. `##` headings are path globs (`Everywhere` = all paths). Only sections matching
the current URL are injected, capped at 1 500 tokens.

## 2. Reporting

### 2.1 In the Playwright HTML report

Each AI step is a `test.step` titled `ai.act: Open Settings > Users`, with a nested step per action the AI performs
(`hover button "Settings"`; cached replays don't add nested steps). Attachments on the AI step:

| Attachment | Content |
|---|---|
| `aipw-decisions.json` | Per decision: tool, args (redacted), intent, reasoning, usage, latency |
| `aipw-snapshot.yaml` | The pruned snapshot from the last decision (and the failing one on error) |
| `aipw-screenshot.jpg` | On failure or heal (password inputs masked) |
| `aipw-heal.json` | Old vs new plan (heals only) |

Trace viewer still works as normal. AI steps appear as groups around the Playwright actions they caused.

### 2.2 Run summary (`@aipw/test/reporter`)

Add the reporter alongside the others: `reporter: [['html'], ['junit', {...}], ['@aipw/test/reporter']]`.

```
aipw summary — provider foundry (deployment e2e-agent), cache auto
  AI steps     212    from cache 188 (88.7%)   AI 21   healed 3   failed 0
  LLM calls     64    tokens in 402k / out 9.1k    est. cost $1.84
  Slowest step  users.spec.ts:22 "Fill in the new user form"  14.2 s (6 decisions)
  Healed        users.spec.ts:14 step 3 — button "Settings" → button "Preferences"
```

It also writes `.aipw/summary.md` and `.aipw/summary.json`. On Azure Pipelines (`TF_BUILD=True`) it adds the
Markdown as a build summary tab via `##vso[task.uploadsummary]`.

### 2.3 Logs

JSON lines in `.aipw/logs/<run>.jsonl`: every event with timestamps. `AIPW_LOG=debug` adds full prompts and responses.
Everything passes through the Redactor first.

## 3. CI on Azure Pipelines

Two pipelines are recommended:

| Pipeline | Cache mode | LLM | Purpose |
|---|---|---|---|
| **PR gate** | `replay-only` | none | Fast, free, deterministic. Fails if a plan is missing or broken → developer refreshes locally |
| **Nightly / main** | `auto` + `heal.policy: report` | OpenAI model on Microsoft Foundry | Catches UI drift. Publishes healed plans as an artifact to review and commit |

The nightly pipeline authenticates to Foundry **keylessly**. The test step runs inside `AzureCLI@2` with an Azure
Resource Manager service connection (workload identity federation). `DefaultAzureCredential` then picks up the
signed-in Azure CLI, so no model key is stored anywhere. The service connection's identity needs an inference role
(e.g. *Cognitive Services OpenAI User* / *Azure AI User*) on the Foundry resource.

```yaml
# azure-pipelines/e2e-nightly.yml
trigger: none
schedules:
  - cron: '0 2 * * *'
    displayName: Nightly AI E2E
    branches: { include: [ main ] }
    always: true

pool: { vmImage: ubuntu-latest }

variables:
  - group: aipw-e2e            # AZURE_FOUNDRY_RESOURCE, AIPW_FOUNDRY_DEPLOYMENT, secret TEST_* passwords
  - name: AIPW_PROVIDER
    value: foundry
  - name: AIPW_CACHE
    value: auto

steps:
  - task: UseNode@1
    inputs: { version: '22.x' }

  - script: npm ci
    displayName: Install

  - script: npx playwright install --with-deps chromium
    displayName: Install browsers

  - task: AzureCLI@2
    displayName: Run E2E
    inputs:
      azureSubscription: 'sc-aipw-foundry'          # ARM service connection (workload identity federation)
      scriptType: bash
      scriptLocation: inlineScript
      inlineScript: npx playwright test
    env:
      CI: 'true'
      AZURE_FOUNDRY_RESOURCE: $(AZURE_FOUNDRY_RESOURCE)
      AIPW_FOUNDRY_DEPLOYMENT: $(AIPW_FOUNDRY_DEPLOYMENT)
      TEST_ADMIN_PASSWORD: $(TEST_ADMIN_PASSWORD)     # secret variables must be mapped explicitly
      PLAYWRIGHT_JUNIT_OUTPUT_NAME: test-results/junit.xml

  - task: PublishTestResults@2
    condition: succeededOrFailed()
    inputs:
      testResultsFormat: JUnit
      testResultsFiles: test-results/junit.xml
      testRunTitle: AI E2E

  - task: PublishPipelineArtifact@1
    condition: succeededOrFailed()
    inputs: { targetPath: playwright-report, artifact: playwright-report }

  - task: PublishPipelineArtifact@1
    condition: succeededOrFailed()
    inputs: { targetPath: .aipw, artifact: aipw-run }     # summary, logs, healed plans
```

With an API key instead: keep a plain `script:` step and map `AZURE_FOUNDRY_API_KEY: $(AZURE_FOUNDRY_API_KEY)` from a
secret variable (or a Key Vault-linked variable group).

The PR-gate pipeline is the same file with a plain `script:` step (no Azure login, no Foundry variables), with
`AIPW_CACHE: replay-only`, and without a schedule. Attach it through the branch policy's build validation.

Playwright config for CI: `workers` ≥ 2 is fine, because every AI step is independent and providers are called concurrently.
Watch provider rate limits; the adapters back off on 429.

## 4. CLI (`@aipw/cli`)

| Command | Purpose |
|---|---|
| `aipw nudge <spec[:line]> [--break] [--at] [--fresh] [--verify]` | Nudge mode ([07](07-nudge-mode.md)) |
| `aipw doctor [--provider x] [--probe]` | Check the config, the provider's package and credentials, secret variables, hints and budgets. `--probe` adds one live tool-calling and structured-output call. (Not built: `--url` site checks) |
| `aipw cache stats\|prune\|refresh\|show` | Cache maintenance ([06](06-caching-and-replay.md) §8) |
| `aipw hints lint [dir]` | Check hints files for duplicates, repeated sections, hints outside a section, and size |
| `aipw summary [--max-llm-calls N] [--max-cost USD]` | Print the last run summary; fail when the run used the model more than allowed (the PR gate uses `--max-llm-calls 0`) |
| `aipw conformance --provider x [--project p] [--out dir]` | Run the usability suite with `ai-only` and write `conformance-<provider>-<model>.json` |
