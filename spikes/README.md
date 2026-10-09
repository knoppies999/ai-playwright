# Phase 0 spikes

Throwaway scripts that check library behaviour the design relies on ([docs/10](../docs/10-implementation-plan.md)
Phase 0). Results and the design changes they caused are logged in
[docs/11](../docs/11-risks-and-open-questions.md) §3. Output goes to `spikes/out/` (git-ignored).

Not part of the build, lint or CI. Run from the repo root with `npx tsx spikes/<file>.ts`.

| Spike | File | Needs | Status |
|---|---|---|---|
| 0.1 aria-ref | `0.1-aria-ref.ts` | Root install, `.env` | Done |
| 0.1b injected walker | `0.1b-injected-walker.ts` | Root install, `.env` | Done |
| 0.1c + 0.2 test ids, snapshot size | `0.1c-0.2-testids-and-size.ts` | Root install, `.env` | Done |
| 0.3 Copilot SDK | `0.3-copilot-sdk.ts [modelId]` | `npm install` in `spikes/`, Copilot sign-in | **Run on the Copilot machine** |
| 0.4 Foundry | `0.4-foundry.ts` | `npm install` in `spikes/`, `az login`, `AZURE_FOUNDRY_RESOURCE`, `AIPW_FOUNDRY_DEPLOYMENT` | **Run with Foundry access** |
| 0.5 Anthropic API | `0.5-anthropic-api.ts [model]` | `npm install` in `spikes/`, `ANTHROPIC_API_KEY` | Deferred (no key) |
| 0.5b Claude Agent SDK | `0.5b-claude-agent-sdk.ts [model]` | `npm install` in `spikes/`, `claude auth login`, **no** `ANTHROPIC_API_KEY` | Done (4 small requests on your plan per run) |
| 0.6 toString / highlight | `0.6-tostring-highlight.ts` | Root install | Done |
| 0.7 trace secrets | `0.7-trace-secrets.ts` | Root install | Done |

`spikes/` has its own `package.json` with the provider SDKs, so the main workspace never installs them.
`npm run typecheck` inside `spikes/` checks every script against the real SDK types.
