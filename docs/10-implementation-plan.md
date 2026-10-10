# 10 — Implementation plan

Phases are ordered so that something useful runs end-to-end as early as possible (Phase 2), and
every later phase adds to a working system. Each phase lists tasks, deliverables and **exit criteria**
that must pass before moving on. Sizes: **S** ≈ ≤ 1 day, **M** ≈ 2–4 days, **L** ≈ 1–2 weeks (one developer
working with an AI assistant). Treat the sizes as relative, not commitments.

```mermaid
gantt
  dateFormat X
  axisFormat %s
  section Foundation
  P0 Spikes (public app)    :p0, 0, 3
  P1 Skeleton + target      :p1, after p0, 3
  section Engine
  P2 Core loop + Claude Code:p2, after p1, 10
  P3 Foundry, Copilot, API  :p3, after p2, 6
  P4 Cache + heal + demo app:p4, after p2, 10
  section Features
  P5 Data, secrets, tools   :p5, after p4, 5
  P6 Nudge mode             :p6, after p4, 12
  P7 Reporting + CI         :p7, after p5, 5
  section Optional
  P8 Extras                 :p8, after p7, 8
```

P3 and P4 can run in parallel once P2 is done. So can P5 and P6.

---

## Phase 0 — Spikes (S–M)

Throwaway scripts in `spikes/` that confirm the assumptions marked **⚠ verify in Phase 0** across the docs.
Record each answer in `docs/11-risks-and-open-questions.md` and adjust the design if needed.

| # | Question | How |
|---|---|---|
| 0.1 | Does `locator.ariaSnapshot({ mode: 'ai' })` give refs, and does `page.locator('aria-ref=eN')` resolve them reliably, including inside iframes? | Script against the chosen public app + 2 other sites + a page with an iframe |
| 0.1b | Injected walker prototype ([12](12-element-identification.md) §2 R2): `addInitScript` + `data-aipw-ref` tagging + resolution, on the same pages. Compare its snapshot with Playwright's | ~150-line script |
| 0.1c | Test-id auto-detection on the public app: which attribute spellings exist, how many, how unique? | Run the detector, print counts |
| 0.2 | Snapshot size on the **public target app** (largest pages)? | Measure chars/tokens before and after a naive prune |
| 0.3 | Copilot SDK: does `availableTools` disable built-ins? Does the capture-and-end-turn pattern work? Image attachments? Session creation latency? Deny-permission handler shape? | Script with 3 fake tools, on the Copilot machine |
| 0.4 | **Foundry** (the pipeline deployment): v1 route + Entra ID auth via `az login`, strict tools, `tool_choice: 'required'`, `parallel_tool_calls: false`, image input, `json_schema` response format, content-filter behaviour on page text | 30-line script |
| 0.5 | Anthropic API: strict tools + `disable_parallel_tool_use` + `fallbacks: 'default'` on your account | 20-line script |
| 0.5b | Claude Agent SDK on the Claude Code subscription (D12): built-ins really off with `tools: []`, one captured call, latency per `query()` (maxTurns 1 vs natural end), usage reporting, `outputFormat` structured output | Script, needs `claude auth login` |
| 0.6 | `locator.toString()` readable and stable? `locator.highlight()` visible in headed mode and absent from ARIA snapshots? | Script |
| 0.7 | Trace content for `fill` vs `evaluate`-set values (secret leakage) | Record a trace, inspect it |

**Exit:** every question has a written answer. The design is adjusted (e.g., DOM-walker fallback for refs, session-per-step for Copilot).

**Status (2026-10-09):** 0.1, 0.1b, 0.1c, 0.2, 0.5b, 0.6 and 0.7 done on this machine; results and design changes are in
[11](11-risks-and-open-questions.md) §3. Waiting on: **0.3** (Copilot machine),
**0.4** (Foundry access). 0.5 is deferred until there is an API key. Phase 1 went ahead in parallel because none of
the open spikes affect it.

---

## Phase 1 — Skeleton and public target (S–M)

Tasks
- [x] npm workspaces monorepo: `packages/{core,test,cli,provider-claude-code,provider-anthropic,provider-openai,provider-copilot}`, `examples/{targets,tests}`
- [x] TypeScript strict (6.0: typescript-eslint doesn't support 7.x yet), ESM, `tsup` builds, `eslint` + `prettier`, `vitest` for unit tests
- [x] Root scripts: `build`, `test` (vitest), `e2e` (playwright), `lint`, `typecheck`
- [x] Azure Pipelines CI for the framework repo itself: lint + typecheck + unit tests (no LLM, no public-app calls). The same checks also run as a GitHub Actions workflow, because the repo lives on GitHub
- [x] Target profile `examples/targets/saucedemo/`: base URL, public demo credentials (as env-backed secrets, even though they're public), detected test-id attributes
- [x] **Usability scenario list** for the public app (8–12 scenarios, written in English as you would write them): login, menu navigation, search/filter, a multi-field form with validation, a table read (`extract`), a success-message `assert`, a detail page, logout
- [x] Plain-Playwright smoke spec for 2–3 of the scenarios (proves the app is reachable and stable enough)

**Exit:** `npm run build && npm test` green locally and in CI. The smoke spec passes against the public app.

**Status (2026-10-09):** done locally. Build, lint, typecheck and 36 unit tests are green, and the smoke spec passed
15/15 (`--repeat-each 5`). CI runs on the PR. Core already has the Zod config schema and the test-id helpers from
[12](12-element-identification.md) §4, because spike 0.1c used them.

---

## Phase 2 — Core engine with the Claude Code provider (L)

Phase 0 changes to carry in: mask credential-field values in snapshots, re-snapshot until stable, check a ref's
`count()` before acting, and warn when secrets meet trace DOM snapshots ([11](11-risks-and-open-questions.md) §3).

Tasks
- [x] `llm/`: `LlmProvider` interface, neutral types, `FakeProvider` with scripted decisions
- [x] `actions/`: Zod schemas for all tools in [04](04-agent-loop-and-perception.md) §2 (strict-compatible, per [05](05-llm-providers.md) §2.1); `zod → JSON Schema`. Deferred: `click_xy`, `drag`, `upload` (vision/files), `generate_value` (Phase 5), `ask_human` (Phase 6)
- [x] `observe/`: Observer (AI snapshot, pruning steps 1–5, page-state extras, notices MutationObserver, dialog capture). Not built: the `SnapshotSource` interface, because spike 0.1 passed and Playwright's refs are used directly
- [ ] `observe/injected/`: the walker bundle loaded via `addInitScript` — **deferred** (fallback only; prototype in `spikes/0.1b`). Test-id detection runs inside LocatorSynth instead (configured spellings + the name pattern); per-origin persistence in `__aipw__/sites/` is not built
- [x] `actions/executor`: ref resolution, stale-ref check, every built-in tool, settle logic; plus dead-ref `count()` check, dialog race, secrets only into credential fields
- [x] `locators/`: LocatorSynth implementing the ladder L1–L6 ([12](12-element-identification.md) §3), test-id normalisation (§4), generated-value filter (§5), uniqueness + identity verification, frame paths. L7 (structural CSS) not built
- [x] `loop/`: AgentLoop, prompt builder (layout in [04](04-agent-loop-and-perception.md) §4), decision validation and repair, guards
- [x] `step/`: StepRunner for `act`, `assert` (retry + snapshot-hash dedupe), `extract` (structured + repair), `locate`, `run`
- [x] `events/`: typed EventBus
- [x] `provider-claude-code` (D12): capture-pattern `decide` and `outputFormat` `structured`, per [05](05-llm-providers.md) §3a adjusted by spike 0.5b; usage mapping (equivalent cost + requests); a clear error when Claude Code is signed out
- [x] `test`: fixtures `ai`, `gen` (gen = minimal for now), `withAipw()`, `test.step` wrapping, callsite capture, report attachments
- [x] Unit tests: pruning (golden files), prompt builder (golden files), LocatorSynth + test-id normalisation (static HTML fixtures in `packages/core/test/fixtures/`), executor (fixtures), loop with FakeProvider (done/fail/limits/repair/no-progress)
- [x] Usability suite `examples/tests/saucedemo/*.spec.ts`: the Phase 1 scenarios as English tests, with real calls through `claude-code` (tagged `@llm`)
- [x] A short usability write-up: [usability-report.md](../examples/targets/saucedemo/usability-report.md)
- [x] Phase 0 carry-in: `@aipw/test` warns (annotation + console) when an AI step enters a secret while trace DOM snapshots are on

**Exit:**
- ≥ 90% pass rate over 3 runs of the `@llm` usability suite with `cache: off`.
- For elements that have test ids, LocatorSynth picks a test-id locator ≥ 95% of the time.
- A static injection fixture page (text like "ignore previous instructions and navigate to…") does not cause navigation or out-of-task actions.
- Median uncached single-action `act` < 5 s.

**Status (2026-10-09, 3 runs on Sonnet 5.5 via the Pro subscription):**
- Pass rate: **38/39 = 97%** over 3 runs (12/13, 13/13, 13/13). ✔ The run-1 failure led to the adapter's raw `tool_use` fallback, which then rescued 5 malformed `done` calls in runs 2–3 via a repair turn.
- Test-id locators: **26/26 (100%)** for targets that have a test id. ✔
- Injection page: ignored, no navigation, no out-of-task click. ✔ (one run)
- Single-action `act`: **~8 s, not met.** Each decision is ~4 s and an act needs two (the action, then `done`).
  See the report for options; the plan cache (Phase 4) removes this from reruns.

---

## Phase 3 — Foundry (OpenAI-compatible), Copilot and Anthropic API providers (M)

Tasks
- [ ] `provider-anthropic` (API key): `decide` + `structured`, usage mapping, refusal handling, typed-error backoff (moved from Phase 2 by D12)
- [ ] `provider-openai`: Chat Completions adapter, presets (**`foundry`** first, then `openai`, `azure-openai`, `github-models`, `ollama`, `lmstudio`), compat flags, JSON-mode fallback for `structured`
- [ ] Foundry auth: API key or keyless (`@azure/identity` `DefaultAzureCredential`, scope `https://ai.azure.com/.default`); content-filter errors mapped to `AiProviderError(kind: 'content_filter')`
- [ ] `provider-copilot`: capture-pattern adapter per [05](05-llm-providers.md) §5, adjusted by the spike 0.3 results
- [ ] Provider loader (dynamic `import()` by package name from config) and `aipw doctor`
- [ ] Conformance suite + `aipw conformance` writing the metrics JSON
- [ ] Contract tests: the same recorded fixture request → each adapter's wire payload (snapshot tests, no network)

**Exit:** the conformance suite (the usability scenarios with `cache: ai-only`) passes ≥ 85% with the Foundry deployment and the chosen Copilot model.
The metrics JSON for all three providers is committed under `docs/conformance/`.

---

## Phase 4 — Plan cache, replay, healing and the demo app (L)

Tasks
- [x] Step keys, plan file format, stable JSON writer, locator-expression interpreter (no `eval`)
- [x] Replay engine with pre/post checks and events (`source: 'cache'`)
- [x] Compiled checks for `assert`, and the AI re-judge path
- [x] Extract replay: fully deterministic from per-leaf source elements (no text-only AI call needed), see [06](06-caching-and-replay.md) §5
- [x] Fingerprints stored with every target. Fingerprint healing L8 ([12](12-element-identification.md) §6), allowed in `replay-only`
- [x] AI healing with context, history of 3 plan versions, `heal.policy` behaviours
- [x] `aipw cache stats|prune|refresh|show` (prune works per test title; steps inside a live test are not pruned)
- [x] **Demo app** (`examples/demo-app`, plain HTML + a dependency-free Node server; login, hover-menu shell and users pages so far; later phases add theirs) with the pages in [02](02-architecture.md) §6 and `?variant=b` UI changes (renamed test ids, reworded buttons, moved menus), because healing needs UI changes we control
- [x] Heal tests (`examples/tests/demo/heal.spec.ts`, FakeProvider, in CI): record on variant A → replay A with 0 LLM calls → switch to variant B → fingerprint heals for small changes, AI heals for big ones → replay B with 0 LLM calls

**Exit:**
- Second run of the public-app usability suite: **0 LLM calls**, and wall time within 1.5× of an equivalent plain-Playwright suite.
- Variant-B heal scenarios pass. A renamed test id heals via fingerprint (no LLM), and the report shows heals with their source.
- `replay-only` with a missing plan fails with a clear message.

**Status (2026-10-09):**
- Second SauceDemo run (live recording on Sonnet 5.5, then `auto`): **13/13 in 15.5 s with 1 AI request**, vs 2.7 min and ~60
  requests uncached. **Not quite 0:** test 11 asserts an *absence* ("no item count"), and a check can't be compiled from a
  snapshot ref for an element that isn't there, so it stays AI-judged. `replay-only`: 12/13 in 10.3 s with 0 calls; test 11
  fails there by design. Options: assert absences in code (`toHaveCount(0)`), or a future "absent" check built from the
  locator recorded when the element last existed.
- Wall time: 15.5 s for 13 tests (2 workers) — no plain-Playwright equivalent of the usability suite exists to compare 1.5× against.
- Variant-B heal scenarios pass; the renamed test ids heal by fingerprint with no AI; heal events carry their source. ✔
- `replay-only` with a missing plan throws `AiCacheReplayOnlyMiss` with how to fix it. ✔
- The live recording surfaced weak compiled checks ("cart link visible" for "no item count"); the prompt now demands checks
  that fail when the assertion is false, and `aipw cache show` makes every check reviewable in PRs.

---

## Phase 5 — Test data, secrets and code tools (M)

Tasks
- [x] DataResolver: placeholders (incl. `{{gen.kind({...})}}`), `values` accumulation, plan placeholder back-conversion (data values and generated values)
- [x] Generators + validators (SA ID, Luhn, test cards, IBAN, VAT where defined, phone, email, person, address, date, TOTP), with unit tests against published examples (RFC 6238 vectors, ISO 13616 IBANs, card test PANs). No faker: a seeded PRNG and short word lists
- [x] `generate_value` tool
- [x] Secrets provider (env + custom function), Redactor applied to all events/logs/attachments, credential-field restriction, `fillMode`
- [x] `ai.tools.register` (code tools) with Zod validation, recorded in plans
- [x] Demo: `/users/new` with server-side validation passes using generated values. A grep for secret values across `.aipw/`, the reports and the plans finds nothing

**Exit:** the validation-heavy demo form passes with uncached and cached runs. The secret-leak check is automated in CI.

**Status (2026-10-09):** both met. `examples/tests/demo/users-new.spec.ts` passes uncached (6 decisions) and cached (0, with
fresh generated values the server accepts). `scripts/leak-check.mjs` runs in CI over results, reports, plans and the files
inside trace zips. Writing it found a real leak: the Observer's own snapshot results were recorded in traces with password
values. Credential inputs are now masked in the page during every snapshot ([08](08-test-data-and-secrets.md) §4).

---

## Phase 6 — Nudge mode (L)

Split into two parts so value lands early.

**6a — Core nudge (terminal)**
- [x] `aipw nudge` driver: launches the browser server, nudge server (TCP JSON lines, not WebSocket), runs Playwright with the nudge env, relaunch loop
- [x] NudgeController hooks in StepRunner and AgentLoop. `PauseState`/`NudgeCommand` protocol (typed, versioned)
- [x] Terminal UI: pause display, commands run/skip/hint/edit/continue/break/view/quit, target highlight
- [x] `ask_human` tool and fail → pause
- [x] Soft undo and hard rewind (RewindSignal, same gen seed, `ai.nudgeHooks.onRewind`). No session overlay: plans are stored as each step finishes, so a rewind replays them
- [x] `ai.nudge()` code breakpoint. **Not built:** `nudge.onFailure` (dropping a plain headed run into nudge needs a driver it doesn't have); the `x` command (discard a cached plan) — use `--fresh`

**6b — Corrections and remedies**
- [x] Element picker (`p`) and options (`o`, top-3 alternatives)
- [x] Manual action recorder (`m`) → ActionRecords (incl. hover-menu dwell detection)
- [x] Target-fact computation: hover menu, instruction wording vs name, what the agent chose instead. Not computed: in-snapshot-at-the-time and offscreen (the loop doesn't keep old snapshots)
- [x] Remedy synthesis (`structured` + RemedySchema) and deterministic code remedy via LocatorSynth
- [x] Verification runner (rewind → AI-only → pass criteria), max 2 synthesis rounds
- [x] Apply: hints writer, spec patcher with the TypeScript compiler API instead of ts-morph (instruction replace, split, code replace). Diffs + confirmation. Refuse if the file changed. The corrected plan is already stored when the step finishes, so there is no separate plan writer
- [x] Session `summary.md`

**Exit (scripted demo scenarios):**
1. Hidden hover menu: the AI fails → the human `pick`s → a **site hint** is verified with the original instruction → applied → a fresh `ai-only` run passes without nudge.
2. Ambiguous "Save": the AI asks the human → the revised instruction is verified → the spec is patched correctly (diff matches the golden file).
3. Rewind from step 5 to step 2 re-runs login code, replays steps 1–2 from cache, and pauses at step 2 with identical generated data.

**Status (2026-10-10):** all three met as scripted tests (`packages/cli/test/exit-scenarios.test.ts`): the demo app's pages,
the real engine, nudge protocol, verification and apply code, with a FakeProvider for the model and a ScriptedUi for the
human. Scenario 2 found a real gap (an `ask_human` answer did not count as a correction, so no remedies were offered).
Not yet tried by a person in a live interactive session with a real model. As-built differences are listed in
[07](07-nudge-mode.md) §10.

---

## Phase 7 — Reporting and CI hardening (M)

Tasks
- [x] Attachments per AI step, nested action steps, heal attachments
- [x] `@aipw/test/reporter`: console summary, `.aipw/summary.{md,json}`, Azure `##vso[task.uploadsummary]`
- [x] Pricing table + budget guards (per step / per run / requests). "Per run" is per worker process
- [x] Example Azure pipelines (PR gate `replay-only`, nightly `auto`), as in [09](09-configuration-reporting-ci.md) §3, plus `aipw summary --max-llm-calls 0` to enforce the PR gate's zero model calls, and `aipw hints lint`
- [x] Retry/backoff for 429s under `workers > 1` (full jitter; Retry-After honoured; a plan usage limit fails at once)
- [x] Docs: [Getting started](guides/getting-started.md), [troubleshooting](guides/troubleshooting.md), [writing good instructions](guides/writing-instructions.md)

**Exit:** the nightly pipeline runs green on the demo suite with the Foundry deployment, authenticated keylessly through the service connection. The PR gate runs with 0 LLM calls. The summary tab shows in Azure DevOps.

**Status (2026-10-10): tasks done, exit blocked.** All three criteria need an Azure DevOps project, and the nightly one
also a Foundry deployment and `provider-openai` (Phase 3), none of which this machine has. What was checked here:
the reporter on the FakeProvider e2e projects (console summary, `.aipw/summary.md`/`.json`, and the
`##vso[task.uploadsummary]` line under `TF_BUILD=True` in a unit test); `aipw summary --max-llm-calls 0` failing
a run that called the (fake) model; the secret leak check over the new step screenshots and attachments.

---

## Phase 8 — Optional extensions (pick as needed)

| Extension | Notes |
|---|---|
| `*.ai.md` English-only spec files | A Playwright Test loader/transform that turns Markdown bullet steps into `ai.run` calls. Front-matter for data and tags |
| MCP server (`@aipw/mcp`) | Expose `act/assert/extract/locate/observe` + "generate spec from this session" as MCP tools for Copilot Chat agent mode / Copilot CLI |
| VS Code nudge panel | A webview client for the nudge WebSocket server |
| VS Code Copilot as a provider | A small aipw VS Code extension that bridges the test runner to `vscode.lm` (Copilot models in VS Code), [05](05-llm-providers.md) §5.1. Local only, needs VS Code open. Not planned (D13) |
| Set-of-marks vision | Ref labels drawn on screenshots for better vision grounding |
| Hint packs | Shipped hints for common component libraries (MUI, Ant Design, Kendo, Fluent UI date pickers and comboboxes) |
| C#/.NET client | Call the engine over the MCP server or a thin HTTP API from NUnit tests |

---

## Working agreements

- Every feature lands with: unit tests (FakeProvider), a demo-app e2e spec, and a docs update.
- No provider SDK imports outside `packages/provider-*`.
- Prompts live in `packages/core/src/loop/prompts/*.md` (versioned, golden-tested). A prompt change runs the conformance suite before merge.
- Branch + PR for all work, no direct commits to `main`.
