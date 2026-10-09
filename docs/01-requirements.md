# 01 — Requirements and decisions

## 1. Goal

Write end-to-end web tests in simple English. Detailed English is allowed where precision
matters: nested menus, or validation that needs real valid values. Deterministic code steps such
as logging in can sit between the English steps. The suite must run the same way on a dev
machine, on a colleague's machine that only has GitHub Copilot, and in a CI pipeline.

## 2. Decisions already made

| # | Decision | Why |
|---|---|---|
| D1 | **TypeScript** on **Playwright Test** | Best AI-tooling ecosystem (Zod, provider SDKs, Copilot SDK, MCP SDK). Playwright Test supplies fixtures, steps, traces and reporters for free |
| D2 | Primary use case is **E2E testing** | Assertions, reports, CI and deterministic replay matter more than open-ended task automation |
| D3 | The LLM contract is modelled on **OpenAI-compatible chat + function calling** | It is the lowest common denominator. Any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, GitHub Models, Ollama, LM Studio, vLLM) works with no new code |
| D4 | **Three provider adapters in v1**: OpenAI-compatible (CI pipelines, using **OpenAI models deployed in Microsoft Foundry**), **GitHub Copilot CLI** via the Copilot SDK (local runs on another machine), Anthropic (development and testing on this machine) | User requirement |
| D10 | **Test-id attributes are the first choice for locating elements**, in any spelling (`data-testid`, `data-test-id`, `datatestid`, `data-test`…). Then role/label/anchored locators, fingerprint healing and AI healing | User requirement. See [12](12-element-identification.md) |
| D11 | **First target is a public web app** to check usability. A purpose-built demo app for hard edge cases and healing tests comes later. The app is **SauceDemo** (`www.saucedemo.com`) | User decision |
| D13 | **"Copilot" means GitHub Copilot CLI.** The `copilot` adapter drives the Copilot CLI engine through `@github/copilot-sdk` (same runtime, sign-in and premium requests). Copilot **in VS Code** is not a provider for now; the options are recorded in [05](05-llm-providers.md) §5.1 | User clarification |
| D12 | **A fourth adapter, `claude-code`, runs on a signed-in Claude Code subscription** through the Claude Agent SDK (no API key). It is the **default dev provider on this machine** and the first adapter built in Phase 2. The Anthropic API adapter stays for key-based use | User requirement: use the Claude plan's limits. Personal use only; pipelines keep using Foundry. See [05](05-llm-providers.md) §3a |
| D5 | **The engine owns the agent loop.** Providers only answer "what is the next action?" | Same behaviour, limits, logging, caching and nudge support on every provider |
| D6 | **One action per model turn**, a fresh prompt each turn (no growing chat history) | Simpler to cache, debug, rewind and swap providers. Cost stays flat per step |
| D7 | **Accessibility snapshot first, screenshot second** | Cheaper, faster and more precise than pure vision. Vision covers canvas, icons and visual-only cues |
| D8 | **Cache AI decisions as locators** and replay them without an LLM | Speed, cost and determinism in CI. This is what makes AI E2E tests practical |
| D9 | **Nudge mode** for interactive step-through, rewind and correction, producing a verified remedy | User requirement. See [07](07-nudge-mode.md) |

## 3. Functional requirements

### FR-1 English steps
- FR-1.1 `ai.act(instruction)` performs one or more UI actions to satisfy an instruction.
- FR-1.2 Short instructions ("Save") and detailed ones ("Hover the gear icon top-right, then in the
  flyout choose Administration > Users") both work. Detail lowers the step count and ambiguity.
- FR-1.3 `ai.assert(condition)` passes or fails with evidence (quoted page text and a screenshot).
- FR-1.4 `ai.extract(what, zodSchema)` returns typed data validated by the schema.
- FR-1.5 `ai.locate(description)` returns a Playwright `Locator`, so code can take over.
- FR-1.6 `ai.run(multiLineScript)` runs a bullet list of English steps. Lines starting
  with *Verify / Check / Assert / Expect* become assertions.

### FR-2 Hybrid scripting
- FR-2.1 Any Playwright code can run before, between and after AI steps (same `page`).
- FR-2.2 Code can be registered as **tools** that English steps may invoke
  ("log in as admin" calls your `loginAs` function).
- FR-2.3 AI steps can be scoped to part of the page (`scope: page.locator('#dialog')`).

### FR-3 Valid data
- FR-3.1 The caller passes concrete values (`data`). The AI must use them verbatim.
- FR-3.2 Built-in generators produce valid values (national IDs, Luhn numbers, IBANs, emails,
  phones, dates). The AI may call them when an instruction asks for "a valid X".
- FR-3.3 Secrets are passed as placeholders, substituted only at execution time, and never
  sent to an LLM or written to logs.
- FR-3.4 Values generated during a step are returned to the test (`result.values`).

### FR-4 Providers
- FR-4.1 Provider and model are chosen by config/env with no code change.
- FR-4.2 Adapters: OpenAI-compatible (incl. Microsoft Foundry with keyless Entra ID auth), Claude Code subscription (Claude Agent SDK), Anthropic API, GitHub Copilot SDK.
- FR-4.3 New providers implement one small interface (`LlmProvider`).
- FR-4.4 A provider conformance suite runs the same scenarios against every adapter.

### FR-5 Determinism and caching
- FR-5.1 Successful AI steps are recorded as replayable action plans with stable locators.
- FR-5.2 Cache modes: `auto` (replay, fall back to AI), `replay-only` (no LLM at all), `ai-only`, `refresh`.
- FR-5.3 Self-healing: if a cached step fails, AI re-resolves it, updates the cache and the report flags it.
- FR-5.4 The cache is plain JSON committed next to the tests, reviewable in PRs.

### FR-6 Nudge mode (interactive)
- FR-6.1 Pause before every AI step and/or every low-level action. Show the planned action and
  highlight the target element in the headed browser.
- FR-6.2 Step / continue / skip / retry / quit.
- FR-6.3 **Rewind** to an earlier step: restart and replay deterministically up to that point.
- FR-6.4 **Remedy**: the human gives a hint, picks the right element, edits the instruction, or performs
  the action manually.
- FR-6.5 The framework **returns a better step** that would have succeeded: a revised instruction,
  a reusable site hint, and/or equivalent Playwright code. It **verifies** the step by re-running it
  before offering it.
- FR-6.6 Accepted remedies can be applied automatically: patch the spec file, update the cache, add to the hints file.

### FR-7 Reporting
- FR-7.1 Every AI call shows as a Playwright `test.step`, with nested steps per action.
- FR-7.2 Attachments: model decision and reasoning, snapshot, screenshot, token usage.
- FR-7.3 Run summary: LLM calls, tokens, estimated cost, cache hit rate, healed steps.

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | Cached step replay adds < 50 ms overhead per action over raw Playwright |
| NFR-2 | An uncached `act` with a single action typically completes in < 5 s (provider-dependent) |
| NFR-3 | Default token budget per uncached decision ≤ ~8k input tokens on a typical admin page (snapshot pruning) |
| NFR-4 | No provider SDK is a hard dependency of core. Each adapter is its own package |
| NFR-5 | Page content is treated as untrusted data. The agent has no shell or filesystem tools. Navigation is limited to allowed origins |
| NFR-6 | Works on Windows, macOS and Linux. CI on Azure Pipelines (Linux agents) |
| NFR-7 | Unit-testable core: the browser and LLM sit behind interfaces, and a scripted fake provider exists for tests |

## 5. Out of scope for v1

- Native mobile apps, desktop apps.
- Bypassing CAPTCHAs or bot detection. Use test environments with these disabled.
- MFA flows other than TOTP from a known test secret.
- A full English-only test file format (`*.ai.md`). Planned as an optional Phase 8.
- MCP server exposing the framework to Copilot Chat. Planned as an optional Phase 8.

## 6. Glossary

| Term | Meaning |
|---|---|
| **AI step** | One `ai.act/assert/extract/locate` call |
| **Action** | One low-level browser operation (click, fill, hover…). An AI step has 1..n actions |
| **Decision** | One model turn that returns exactly one action (or done/fail) |
| **Snapshot** | Playwright AI-mode ARIA snapshot (YAML) with `[ref=eN]` element references |
| **Plan** | The recorded actions of a successful AI step, with stable locators. This is what the cache stores |
| **Heal** | A cached plan failed, AI re-resolved it, and the cache was updated |
| **Remedy** | Nudge-mode output: an improved instruction, hint or code that makes a failing step succeed |
| **Hint** | Reusable site knowledge injected into prompts ("Users is under the gear menu") |
