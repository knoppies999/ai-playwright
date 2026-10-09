# 11 — Risks and open questions

## 1. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `aria-ref` selector or AI-mode snapshot behaviour changes between Playwright versions (`aria-ref=` is undocumented: confirmed in spike 0.1) | Medium | High | `SnapshotSource` interface + DOM-walker fallback (prototype passed spike 0.1b). Playwright pinned to 1.64.0. Upgrade only with the conformance suite green |
| R2 | Copilot SDK can't be fully constrained to our tools, or the capture pattern is unreliable | Medium | Medium | Phase 0 spike. Fallback: OpenAI adapter with the `github-models` preset on that machine |
| R3 | Copilot premium-request consumption on uncached runs | High | Medium | Cache-first workflow. `budget.perRunRequests`. Show requests used in the summary |
| R4 | Snapshots of the real app are too large → cost and latency | Medium | Medium | Pruning, `scope`, modal focus, `expand` tool. Spike 0.2: SauceDemo is small (≤ 1.6k tokens/page), but a large docs page was ~197k, so the budget step is mandatory |
| R5 | Non-determinism: the same instruction behaves differently across models/providers | High | Medium | The cache makes CI deterministic. Conformance metrics per model. Clear instructions + hints |
| R6 | False passes from `ai.assert` (the model is too lenient) | Medium | High | The verdict needs quoted evidence. Compiled checks for replay. Prefer code assertions where possible. Spot-check suite with deliberately failing conditions |
| R7 | Healing masks real regressions (e.g., a button renamed by mistake) | Medium | Medium | `heal.policy: report` in CI. Heals are visible in the summary. `fail` policy for strict suites |
| R8 | Secrets leak into traces/videos, **and into AI snapshots** (both confirmed in Phase 0) | High | High | Observer masks credential-field values in snapshots. Code-based auth. `fillMode: evaluate` **plus** trace `snapshots: false` (spike 0.7). Automated leak grep over plans, reports and unzipped traces (Phase 5) |
| R9 | Prompt injection from page content | Low–Medium | High | No shell/fs tools, allowed origins, credential-field restriction for secrets, "page is data" rule, injection demo page in CI |
| R10 | Server-side state makes rewind/verification non-repeatable | High | Medium | Unique generated data, `onRewind` hooks, test-reset endpoints, a clear UI message |
| R11 | Spec patching corrupts source formatting | Low | Medium | AST-based (ts-morph), diff preview, refuse if the file changed, golden tests |
| R12 | Scope creep (it's a big design) | High | Medium | Strict phase exits. Phase 8 is explicitly optional |
| R13 | The public target app changes, resets its data, rate-limits or goes down | Medium | Medium | Use it for usability only, not as a CI gate. Keep runs light (no load). Respect its terms of use. Deterministic CI moves to the demo app in Phase 4 |
| R14 | Foundry content filters block prompts containing page text | Low–Medium | Medium | Map to `content_filter` errors. Check in spike 0.4. Adjust the deployment's filter configuration if allowed |
| R15 | Injected walker (R2) conflicts with app scripts (CSP, MutationObserver-driven frameworks) | Low | Medium | `addInitScript` isn't subject to page CSP. `refs.mode: 'handle'` avoids DOM mutation. Prefer R1 if spike 0.1 passes |
| R16 | The `claude-code` provider (subscription login) stops working or isn't allowed for this use: the login expires, plan limits run out mid-run, or terms change | Medium | Medium | Personal, local use only; CI never uses it. `aipw doctor` checks `claude auth status`. The cache keeps reruns at 0 requests. Fallback: the `anthropic` API adapter with a key |

## 2. Open questions (answer before or during the phase noted)

| # | Question | Needed by |
|---|---|---|
| Q1 | ~~Which application first?~~ **A public web app, for usability** (decision D11): **SauceDemo** (`www.saucedemo.com`) | ~~Phase 0~~ answered |
| Q2 | ~~OpenAI or Azure OpenAI?~~ **OpenAI model on Microsoft Foundry.** Still open: which model/deployment, key vs keyless (service connection), data-residency constraints | Phase 0 (spike 0.4) |
| Q3 | Which Copilot plan and models are available on the other machine? Is it allowed to use Copilot for automated test runs under your org policy? | Phase 0 (spike 0.3) |
| Q4 | ~~Test ids?~~ **Test-id attributes come first, in any spelling** (decision D10). Spike 0.1c: SauceDemo uses `data-test` only | ~~Phase 0~~ answered |
| Q5 | Do test environments have a reset/seed API? It determines how good rewind and verification can be | Phase 6 |
| Q6 | ~~Repo home?~~ **A private GitHub repo**, branch + PR per change. CI YAML exists for both Azure Pipelines and GitHub Actions. Still open: package feed for publishing (`@aipw/*` packages are `private: true` until then) | Phase 7 |
| Q7 | Browsers in scope: Chromium only, or also Firefox/WebKit? (AI-mode snapshots should work on all three; verify) | Phase 2 |
| Q8 | Is a C# consumer needed in the next 6 months? It decides whether the MCP/HTTP surface (Phase 8) moves earlier | Phase 7 |

## 3. Spike results log

Phase 0 ran on 2026-10-09 with Playwright 1.64.0 on Windows 11, Chromium. Scripts are in [`spikes/`](../spikes/README.md).
Spikes that need other machines or credentials have scripts that typecheck against the real SDKs, but haven't been run yet.

| Spike | Result | Design change |
|---|---|---|
| 0.1 aria-ref | **Pass.** `ariaSnapshot({ mode: 'ai' })` gives `[ref=eN]` refs. `aria-ref=` resolved 100% of refs to exactly one element on 8 SauceDemo pages, playwright.dev (856 refs), the-internet nested frames and an iframe fixture. Iframe refs are frame-prefixed (`f1e3`); clicking and filling through refs works, inside iframes too. Refs stick to elements across snapshots, and a ref whose element is gone matches 0. Two findings: snapshots **include input values, password fields too**, and they keep changing for ~0.5 s after load while images arrive. `aria-ref=` is still not in Playwright's public types | Observer masks password/credential values; re-snapshots until two in a row match; executor checks `count()` before acting on a ref; Playwright pinned; walker kept as fallback ([04](04-agent-loop-and-perception.md) §1.1) |
| 0.1b injected walker | **Pass.** A ~100-line `addInitScript` walker tagged `data-aipw-ref`. Every ref resolved, in iframes and open shadow roots. It found the same number of interactive elements as Playwright on all 8 SauceDemo pages, in ~3 ms per snapshot, with text 10–50% smaller. It shows test ids (`[testid=…]`). Gaps: naive accessible names (landmarks took their whole text content) | R2 stays a fallback behind `SnapshotSource`. If built, bundle `dom-accessibility-api` for names. Gotcha: `tsx`/esbuild injects `__name()` into serialised functions, so the walker must be a prebuilt bundle, not a serialised TS function |
| 0.1c test ids | SauceDemo uses **`data-test` only**: 304 elements across 8 pages, no other spelling. Auto-detection (`detectTestIdAttributes`, ≥ 5 elements) picks exactly that. List items reuse ids (`inventory-item` ×6, `inventory-item-name` ×6), while buttons are unique (`add-to-cart-sauce-labs-backpack`) | None. Confirms the L1 + L5 anchor combination for lists ([12](12-element-identification.md) §4) |
| 0.2 snapshot size | SauceDemo: 140–1,560 tokens per page raw (chars/4). The naive prune (drop unnamed generics, collapse runs over 15) saves 10–20%. playwright.dev API page: **~197k tokens raw, ~192k after the naive prune** | No change for SauceDemo. For big pages the budget/depth step (5) is mandatory, and `scope` matters ([04](04-agent-loop-and-perception.md) §1.2) |
| 0.3 Copilot SDK | **Not run yet** (needs the Copilot machine). Type-level findings from `@github/copilot-sdk` 1.0.19: `defineTool({ isTerminal: true })` ends the turn after our tool runs, `ToolSet` restricts tools by source, `blob` attachments carry images, deny = `{ kind: 'reject' }`, usage comes as `assistant.usage` events, and `responseSchema` gives structured output | Adapter sketch updated in [05](05-llm-providers.md) §5. Run `spikes/0.3-copilot-sdk.ts` there |
| 0.4 Foundry | **Not run yet** (needs the Foundry resource and `az login`). Script checks keyless auth, strict tools, `tool_choice: 'required'`, `parallel_tool_calls`, image input, `json_schema` and a content-filter probe | — |
| 0.5 Anthropic API | **Skipped for now** (no `ANTHROPIC_API_KEY` on this machine; decision D12 makes `claude-code` the dev provider). `@anthropic-ai/sdk` 0.133 types confirm `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01`, `strict` tools and `output_config.format` | — |
| 0.5b Claude Agent SDK | **Blocked: the `claude` CLI on this machine was not signed in** (`claude auth status` → `loggedIn: false`; the SDK reported "OAuth session expired"). The desktop app's sign-in doesn't carry over. Run `claude auth login`, then `npx tsx spikes/0.5b-claude-agent-sdk.ts`. Types confirm `tools: []` (no built-ins), `settingSources: []`, `persistSession: false`, `permissionMode: 'dontAsk'` and `outputFormat` json_schema | New adapter design in [05](05-llm-providers.md) §3a |
| 0.6 toString / highlight | **Pass.** `locator.toString()` is readable and identical across runs for role, scoped role, test id, CSS, label, anchored `filter({ hasText })`, `nth`, frame and regex locators. `highlight()` draws an overlay (`x-pw-glass` plus a label with the locator) that is visible in screenshots and doesn't change the ARIA snapshot | `scopeDescriptor = locator.toString()`, plus the active test-id attribute, because `getByTestId('x')` hides it ([06](06-caching-and-replay.md) §3) |
| 0.7 trace secrets | **Leak confirmed.** `fill` and `pressSequentially` leak through action params and logs. `evaluate` keeps the value out of those, **but DOM snapshots still record input values, even `type=password`**. Only tracing with `snapshots: false` (or no trace) kept the secret out | `fillMode: 'evaluate'` must be paired with `trace.snapshots: false` for secret-bearing tests; leak grep covers traces ([08](08-test-data-and-secrets.md) §4) |
