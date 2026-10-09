# 11 — Risks and open questions

## 1. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `aria-ref` selector or AI-mode snapshot behaviour changes between Playwright versions (partly internal API) | Medium | High | `SnapshotSource` interface + DOM-walker fallback. Pin the Playwright version. Upgrade only with the conformance suite green |
| R2 | Copilot SDK can't be fully constrained to our tools, or the capture pattern is unreliable | Medium | Medium | Phase 0 spike. Fallback: OpenAI adapter with the `github-models` preset on that machine |
| R3 | Copilot premium-request consumption on uncached runs | High | Medium | Cache-first workflow. `budget.perRunRequests`. Show requests used in the summary |
| R4 | Snapshots of the real app are too large → cost and latency | Medium | Medium | Pruning, `scope`, modal focus, `expand` tool. Measure in spike 0.2 |
| R5 | Non-determinism: the same instruction behaves differently across models/providers | High | Medium | The cache makes CI deterministic. Conformance metrics per model. Clear instructions + hints |
| R6 | False passes from `ai.assert` (the model is too lenient) | Medium | High | The verdict needs quoted evidence. Compiled checks for replay. Prefer code assertions where possible. Spot-check suite with deliberately failing conditions |
| R7 | Healing masks real regressions (e.g., a button renamed by mistake) | Medium | Medium | `heal.policy: report` in CI. Heals are visible in the summary. `fail` policy for strict suites |
| R8 | Secrets leak into traces/videos | Medium | High | Code-based auth, `fillMode: evaluate`, the automated leak grep (Phase 5), traces off for sensitive tests |
| R9 | Prompt injection from page content | Low–Medium | High | No shell/fs tools, allowed origins, credential-field restriction for secrets, "page is data" rule, injection demo page in CI |
| R10 | Server-side state makes rewind/verification non-repeatable | High | Medium | Unique generated data, `onRewind` hooks, test-reset endpoints, a clear UI message |
| R11 | Spec patching corrupts source formatting | Low | Medium | AST-based (ts-morph), diff preview, refuse if the file changed, golden tests |
| R12 | Scope creep (it's a big design) | High | Medium | Strict phase exits. Phase 8 is explicitly optional |
| R13 | The public target app changes, resets its data, rate-limits or goes down | Medium | Medium | Use it for usability only, not as a CI gate. Keep runs light (no load). Respect its terms of use. Deterministic CI moves to the demo app in Phase 4 |
| R14 | Foundry content filters block prompts containing page text | Low–Medium | Medium | Map to `content_filter` errors. Check in spike 0.4. Adjust the deployment's filter configuration if allowed |
| R15 | Injected walker (R2) conflicts with app scripts (CSP, MutationObserver-driven frameworks) | Low | Medium | `addInitScript` isn't subject to page CSP. `refs.mode: 'handle'` avoids DOM mutation. Prefer R1 if spike 0.1 passes |

## 2. Open questions (answer before or during the phase noted)

| # | Question | Needed by |
|---|---|---|
| Q1 | ~~Which application first?~~ **A public web app, for usability** (decision D11). Still open: *which* one | Phase 0 |
| Q2 | ~~OpenAI or Azure OpenAI?~~ **OpenAI model on Microsoft Foundry.** Still open: which model/deployment, key vs keyless (service connection), data-residency constraints | Phase 0 (spike 0.4) |
| Q3 | Which Copilot plan and models are available on the other machine? Is it allowed to use Copilot for automated test runs under your org policy? | Phase 0 (spike 0.3) |
| Q4 | ~~Test ids?~~ **Test-id attributes come first, in any spelling** (decision D10). Spike 0.1c reports what the public app uses | Phase 0 |
| Q5 | Do test environments have a reset/seed API? It determines how good rewind and verification can be | Phase 6 |
| Q6 | Repo home: Azure Repos (alongside the app) or a separate repo/package feed (Azure Artifacts npm feed)? | Phase 1 |
| Q7 | Browsers in scope: Chromium only, or also Firefox/WebKit? (AI-mode snapshots should work on all three; verify) | Phase 2 |
| Q8 | Is a C# consumer needed in the next 6 months? It decides whether the MCP/HTTP surface (Phase 8) moves earlier | Phase 7 |

## 3. Spike results log

Fill this in during Phase 0.

| Spike | Result | Design change |
|---|---|---|
| 0.1 aria-ref | | |
| 0.2 snapshot size | | |
| 0.3 Copilot SDK | | |
| 0.4 OpenAI | | |
| 0.5 Anthropic | | |
| 0.6 toString / highlight | | |
| 0.7 trace secrets | | |
