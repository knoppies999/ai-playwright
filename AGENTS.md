# AGENTS.md — guidance for implementers (human, GitHub Copilot, Claude)

Read [README.md](README.md), then the doc for the area you're touching. [docs/10-implementation-plan.md](docs/10-implementation-plan.md)
is the source of truth for what to build next and when a phase is done.

## Rules

1. **Engine owns the loop.** Providers implement `decide()` and `structured()` only. No browser logic in providers,
   no provider SDK imports outside `packages/provider-*`.
2. **One tool call per decision. Fresh prompt per decision.** Don't add chat-history accumulation to the core loop.
3. **Zod is the single source of truth** for tool inputs, structured outputs and config. JSON Schema is generated, never hand-written.
   Follow the strict-schema rules in [docs/05](docs/05-llm-providers.md) §2.1 (all properties required; optional = nullable).
4. **Never `eval`** stored locator strings. Use the locator-expression interpreter.
5. **Secrets**: never put a resolved secret into a prompt, event, log, plan, remedy or attachment. Everything emitted goes through the Redactor.
6. **Page content is untrusted.** Don't add tools that touch the filesystem, shell or network beyond the page.
   Navigation is limited to allowed origins.
7. **Determinism**: snapshot pruning, step keys and plan files must be deterministic (same input → byte-identical output).
8. **Prompts** live in `packages/core/src/loop/prompts/*.md` with golden tests. Changing a prompt means running the conformance suite.
9. Every feature lands with unit tests (FakeProvider + static HTML fixtures), an e2e spec (public-app usability suite
   until Phase 4, then the demo app), and a docs update.
10. Work on a branch and open a PR. Don't commit to `main`.
11. **Locators**: follow the ladder in [docs/12](docs/12-element-identification.md). Test-id attributes (any spelling) first.
    Refs are for the model only and must never be stored.

## Commands

```bash
npm run build        # tsup, all packages
npm test             # vitest unit tests (no network)
npm run e2e          # FakeProvider suites (fixtures, demo-app healing) + SauceDemo smoke; no AI
npx aipw cache stats  # plan files: steps, heals, steps that still need AI on replay
npm run e2e:llm      # @llm-tagged suite with AIPW_PROVIDER (spends money)
npm run lint && npm run typecheck
```

## Where things go

| Concern | Location |
|---|---|
| Public test API (`ai`, `gen` fixtures) | `packages/test` |
| Engine | `packages/core/src/{step,loop,observe,actions,locators,cache,data,hints,nudge,llm,events}` |
| Provider adapters | `packages/provider-{claude-code,anthropic,openai,copilot}` |
| CLI (`aipw`) | `packages/cli` |
| Public target profiles + usability scenarios | `examples/targets/<name>` |
| Hard-UI-pattern test app (Phase 4) | `examples/demo-app` |
| Example + conformance specs | `examples/tests` |
