# Troubleshooting

## Setup and providers

| Symptom | Cause and fix |
|---|---|
| `Claude Code is not signed in` | Run `claude auth login` once in a terminal. The desktop app's sign-in does not carry over to the SDK |
| Calls are billed to an API key instead of your plan | `ANTHROPIC_API_KEY` is set. Unset it for the `claude-code` provider |
| `Claude plan usage limit reached` | Your plan's 5-hour or weekly window is used up. It fails straight away instead of retrying, because the window resets in hours. Replay from cache (`AIPW_CACHE=replay-only`) until it resets |
| `Claude rate limit` / 429 / overloaded | Transient. aipw retries with backoff and jitter (`retry` in config: 4 retries, up to 30 s each). Lower `workers` if it persists |
| `ERR_PACKAGE_PATH_NOT_EXPORTED` for `@aipw/test/reporter` | The packages aren't built. Run `npm run build` |
| `Invalid aipw config` | The message lists the bad keys. Config is validated with Zod; see [09](../09-configuration-reporting-ci.md) §1 |

## Steps that fail

| Symptom | Cause and fix |
|---|---|
| `AI step failed (not_found)` | The element isn't in the accessibility tree: a closed menu, a collapsed section, or a widget without a role or label. Say how to reach it, add a site hint, or run the step in nudge mode and `p`ick it ([writing instructions](writing-instructions.md)) |
| `AI step failed (limit): no progress …` | The model repeated an action or the page stopped changing. Usually the instruction is ambiguous, or an action silently does nothing (a disabled button, a field that rejects input) |
| `maxActions (12) reached` | The step is doing several things. Split it, or raise `maxActions` for that call |
| `AI assertion failed` | The attached `aipw-snapshot.yaml` and `aipw-screenshot.jpg` on the step show what the model saw |
| `aipw budget exceeded` | A `budget` limit was hit. "Run" limits count per Playwright worker. Raise the limit, or replay from cache |
| `aipw: an AI step entered a secret while trace DOM snapshots are on` | Trace DOM snapshots record input values. Log in with code, or use `trace: { mode: 'retain-on-failure', snapshots: false }` for that test |

## Cache and replay

| Symptom | Cause and fix |
|---|---|
| `No cached plan for "…" and the cache is replay-only` | The PR gate found a step with no plan. Run it locally with `AIPW_CACHE=auto` and commit `__aipw__/*.plans.json` |
| PR gate fails `aipw summary --max-llm-calls 0` | Some steps needed the model (no plan, an assertion that can't compile, or an AI heal). The message says how many; record or refresh those plans locally |
| A step re-runs with AI after you edited it | Expected: the plan key includes the instruction and the data keys. Edit, run once, commit the new plan. `npx aipw cache prune` removes plans nothing uses |
| Healed plans in CI aren't written | `heal.policy: report` (the CI default) writes them to `.aipw/healed/` and the summary lists them. Review and commit |
| `npx aipw cache stats` shows "AI on replay" | Those steps always call the model on replay (absence assertions, extracts without replayable sources) |

## Nudge mode

| Symptom | Cause and fix |
|---|---|
| `aipw nudge is interactive and refuses to run when CI is set` | Unset `CI` locally |
| `p` (pick): "That element is not in the accessibility snapshot" | You picked something with no role or name (a plain `div`). Pick its label or its container, or use `m` (manual) |
| Remedy says `… changed since the session started; apply this by hand` | The spec was edited during the session. The diff is printed; apply it yourself |
| A verification run shows ❌ | The AI couldn't do the step alone with that remedy. Prefer a ✅ one, or the code remedy, which is built from your actions and needs no AI |
| Server data from an earlier attempt is still there after a rewind | Rewind restarts the test; it can't roll back the server. Use generated data, or `ai.nudgeHooks.onRewind(…)` to reset |

## Secrets

`node scripts/leak-check.mjs MY_SECRET_ENV …` scans results, reports, plans and the files inside trace zips for the
values of those variables. CI runs it on every build. If it finds one, the report names the file. Typical causes are a
secret written in a spec (traces include source files), or a trace with DOM snapshots of a form an AI step filled.
