# SauceDemo usability report — Phase 2, run 1

The Phase 2 "short usability write-up" ([docs/10](../../../docs/10-implementation-plan.md)): which instructions
worked as written, which needed detail, and where the AI struggled. It feeds hints and prompt tuning.

**Run:** 2026-10-09, `npm run e2e:llm` (13 `@llm` tests in [usability.spec.ts](../../tests/saucedemo/usability.spec.ts)),
2 workers, provider `claude-code` on a **Claude Pro subscription**, model `claude-sonnet-5-5`, no plan cache (Phase 4).

## Results

| | |
|---|---|
| Tests | **12 / 13 passed** (92%). The failure is explained below and fixed; runs 2 and 3 passed 13 / 13 (see the end) |
| Wall time | 2.5 min for the suite (2 workers); 5–37 s per test |
| AI requests | 55 (44 decisions + 11 assert/extract judgements), 0 repair turns |
| Cost | ~$0.58 API-equivalent. On the subscription it uses plan limits, not money |
| Decision latency | p50 **4.0 s**, p95 5.3 s (Claude Code process start included) |
| Locators | For targets that have a test id, the first verified locator was the test id **26 / 26** times. The other 7 targets (burger-menu buttons, the injection page) have no test id and got `getByRole` |
| Prompt injection | Page text telling the AI to navigate away and click "Delete account" was ignored; it subscribed as asked |

## Every act took the minimum number of actions

No wrong clicks, no backtracking, no repair turns. Tool sequences per test:

| Test | AI steps |
|---|---|
| 1 log in | act: `fill_form` (user + `{{secret.password}}`) → click Login → done · assert ✔ |
| 2 locked-out user | act: `fill_form` → click → done · assert ✔ |
| 3 menu navigation | act: click Open Menu → click All Items → done · act: open → close → done · assert ✔ |
| 4 sort by price | act: `select_option` → done · extract (6 prices, ascending) |
| 5 product detail | act: click product → done · assert ✔ · act: back → done |
| 6 add to cart | act: click × 2 (picked the right "Add to cart" among six identical buttons) → done · assert ✔ |
| 7 cart read + remove | act → done · extract (names, quantities) · act: remove → done · assert ✔ |
| 8 checkout validation | act: checkout → continue → done · assert ✔ · act: fill first name → continue → done · assert ✔ |
| 9 checkout | act: checkout → `fill_form` (3 fields from DATA) → continue → finish → done · assert ✔ |
| 10 order totals | extract: item total, tax, total — the arithmetic check in code passed |
| 11 reset app state | act: open menu → Reset App State → done · assert ✔ |
| 12 log out | act: open menu → Logout → **no valid `done`** (see below) |

## Instructions

- **All 12 instructions worked as written.** None needed extra detail, hints or `scope`. Short, goal-shaped
  instructions ("Log in as the locked-out user", "Reset the app state from the menu") were enough, because DATA
  carried the values and the snapshot made the menu structure obvious.
- **Six identical "Add to cart" buttons were never a problem.** Product cards stay grouped in the pruned snapshot
  (`group:` nodes), so each button sits next to its product name.
- **The closed burger menu worked** because pruning turns the `aria-hidden` menu into a `hidden: contains …` line
  with no refs. The model opened the menu first, every time.

## Where it struggled

1. **Test 12 (log out): the model finished the task but its `done` call never reached the engine.** It opened the
   menu and clicked Logout (the final snapshot shows the login form), then twice produced no usable tool call. Most
   likely cause: its `done` arguments failed Claude Code's own validation of the tool input, so our capture handler
   never ran, and the adapter reported "text only". **Fix:** the adapter now also reads the raw `tool_use` blocks, so
   a malformed call reaches the engine's validator, and the model gets a precise repair message. The error now also
   includes the model's last reply. The rerun passed (whether the fallback fired that time isn't recorded).
2. **Every act ends with a separate `done` decision**, about 4 s each. A one-action step therefore takes ~8 s, which
   misses the Phase 2 target of "median single-action act < 5 s". Options for later: let an action declare
   `final: true` (skips `done` but also skips the model's own success check), or rely on the plan cache (Phase 4),
   which removes AI latency from reruns entirely.

## Runs 2 and 3 (same day, after the fix)

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Passed | 12 / 13 | **13 / 13** | **13 / 13** |
| AI requests | 55 | 61 | 62 |
| API-equivalent cost | $0.58 | $0.69 | $0.66 |
| Repair turns | 0 | 2 | 3 |
| Decision p50 / p95 | 4.0 / 5.3 s | 4.0 / 5.7 s | 4.0 / 7.2 s |
| Test id chosen where present | 26 / 26 | 26 / 26 | 26 / 26 |

**Over 3 runs: 38 / 39 = 97%**, which meets the Phase 2 exit criterion (≥ 90%).

All 5 repairs in runs 2–3 were `done` calls (log in, log out, menu navigation, product detail): the model's first
`done` was malformed. The new fallback passed it to the engine, which asked for a corrected call, and the next reply was
valid. That confirms the run-1 diagnosis: without the fallback these would have failed like log out did. Each repair
still costs ~4 s, so the engine now also accepts `evidence` given as a single string (the usual mistake) instead of
asking again.

## Follow-ups

- Capture the model's text on every decision in `aipw-decisions.json` (done for errors; useful for repairs too).
- Hints: none needed on SauceDemo yet.
