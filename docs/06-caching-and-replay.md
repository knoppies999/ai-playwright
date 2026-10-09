# 06 — Caching, replay and self-healing

Without a cache, every run is slow, costs money and can behave differently. With one, the first
run "compiles" each English step into a concrete plan, and later runs replay that plan with plain
Playwright. The LLM is only consulted when a plan breaks.

## 1. Cache modes

| Mode | Behaviour | Typical use |
|---|---|---|
| `auto` (default) | Replay if a plan exists. On replay failure → AI → heal → save | Local dev, nightly CI |
| `replay-only` | Replay only (fingerprint heals allowed, no AI heals). A miss or failure fails the step. **Zero LLM calls** | PR-gating CI once plans are committed |
| `ai-only` | Ignore the cache, always ask the model. Don't write | Conformance runs, debugging |
| `refresh` | Always ask the model, overwrite plans | After big UI changes |

Set globally (`AIPW_CACHE` / config) or per step (`ai.act(..., { cache: 'off' })`).

## 2. Storage layout

```
tests/
  users.spec.ts
  __aipw__/
    users.spec.ts.plans.json      ← committed, reviewed in PRs
hints/
  localhost-5173.md               ← site knowledge (see 07 §6)
.aipw/                            ← git-ignored: run logs, nudge sessions, heal reports
```

One JSON file per spec file, keyed by test title path, then step key. Stable formatting (sorted keys,
2-space indent) keeps PR diffs readable.

## 3. Step key

```
stepKey = sha1( kind + normalise(instruction) + sorted(dataKeys) + sorted(secretNames) + scopeDescriptor + ordinal )
```

- `normalise`: trim, collapse whitespace, lowercase. Minor edits to the instruction still change the key; use
  `options.key` to pin it.
- **Data keys, not data values**: `{ email: gen.email() }` produces a new value every run but hits the same plan.
- `ordinal`: the nth call with the same instruction in the same test (two `ai.act('Save')` calls get different keys).
- `scopeDescriptor`: `locator.toString()` of the scope locator. Spike 0.6 confirmed it is readable and stable across
  pages and runs, e.g. `getByRole('dialog', { name: 'New user' }).getByRole('button', { name: 'Save' })`. Caveat:
  `getByTestId('x')` doesn't include the attribute name, so the active test-id attribute is added to the key separately.

## 4. Plan format

```jsonc
{
  "version": 1,
  "tests": {
    "users > admin can create a user": {
      "a1f3…": {
        "kind": "act",
        "instruction": "Open Settings > Users",
        "recordedWith": { "provider": "anthropic", "model": "claude-opus-5-5", "at": "2026-10-09T10:12:00Z" },
        "pre":  { "urlPattern": "/dashboard", "mustSee": [{ "role": "button", "name": "Settings" }] },
        "actions": [
          {
            "tool": "hover",
            "target": {
              "role": "button", "name": "Settings",
              "locators": [
                "getByTestId('nav-settings')",
                "getByRole('button', { name: 'Settings', exact: true })",
                "locator('header').getByRole('button').nth(2)"
              ]
            },
            "intent": "open the settings flyout"
          },
          {
            "tool": "click",
            "target": { "role": "menuitem", "name": "Users",
                        "locators": ["getByRole('menuitem', { name: 'Users', exact: true })"] }
          }
        ],
        "post": { "urlPattern": "/settings/users", "mustSee": [{ "role": "heading", "name": "Users" }] },
        "stats": { "replays": 41, "heals": 1, "lastHealAt": "2026-10-01T08:00:00Z" }
      }
    }
  }
}
```

> **As built (Phase 4):** locators are stored as structured locator expressions (`[{ "m": "getByTestId", "id": "save" }]`)
> plus a readable `display` string, instead of strings that need parsing. Replays don't write `stats` (committed plans would
> change on every run); only heals do. Plan files are excluded from Prettier because the stable writer owns their format.

- `args` keep **placeholders** (`{{data.email}}`, `{{secret.pw}}`, `{{gen.saId({...})}}`), never resolved values.
- `locators` are **Playwright locator expressions** stored as strings and parsed by a small, safe interpreter that
  allows only `getBy*`, `locator`, `filter`, `nth`, `first`, `last` and string/regex/option-object args. **Never `eval`.**
- `pre`/`post` are cheap sanity checks. `urlPattern` is the URL path with ids replaced by `*`.

## 5. Replay

```
for each action in plan:
  check pre-conditions (first action only)
  resolve target: try each locator candidate in order → first with count() === 1 and visible
  if none resolves → HEAL
  substitute placeholders, execute the same tool via ActionExecutor, settle
verify post-conditions → if not met → HEAL
```

Replay emits the same events as AI execution (with `source: 'cache'`), so reports and nudge mode treat both the same way.

### Assertions in the cache

`ai.assert` stores a **compiled check** proposed by the model at first success and validated before storing:

```jsonc
{ "kind": "assert", "compiled": [
  { "expect": "toContainText", "locator": "getByRole('status')", "args": ["User created"] }
] }
```

Replay runs the compiled check with Playwright's `expect` and the assert timeout.
- Compiled check passes → step passes, no LLM.
- Compiled check fails → **re-judge with AI**. AI says *fail* → the test fails (a real regression). AI says *pass* → heal: recompile and flag in the report.
- Conditions the model can't compile ("the chart trends upward") are stored as `"compiled": null` and always use the AI.

### Extract in the cache

> **As built:** the model reports, for every leaf of the value, its JSON path and the element it read it from
> (`"0.name" → e43`). At record time the engine rebuilds the value from those elements itself and stores the sources only
> if the rebuild matches what the model returned. Replay reads and converts the text (numbers, strings, booleans, enums, and
> arrays/objects of them) with **no model call at all**, which keeps `replay-only` at zero calls.
> Compiled text checks (`toContainText`, `toHaveText`) also require the element to be visible, because `ai.assert` is about
> what the page shows.

The cache stores the **source locators** (where the data was read from). Replay reads `innerText` from them and:
- for primitive schemas (`z.number()`, `z.string()`, enums) → deterministic coercion, no LLM.
- for object/array schemas → one cheap `structured()` call on the extracted text only (no snapshot). `cache: 'off'` forces the full path.

## 6. Healing

When replay fails, the step is re-run with the AI loop, with extra context:

```
HEALING: a previously recorded plan for this step no longer works.
Recorded plan: hover button "Settings" → click menuitem "Users"
Failure: no element matched for action #1 (button "Settings").
Complete the step on the current page. The UI may have changed.
```

On success:
- The plan is replaced (old plan kept in `history[]`, last 3 versions).
- `stats.heals++`. A `heal` event goes to the report: **old vs new locators**, screenshot.
- `heal.policy` decides what CI does with it:

| `heal.policy` | Effect |
|---|---|
| `accept` (local default) | Write the updated plan file. The test passes |
| `report` (CI default) | Test passes. The healed plan is written to `.aipw/healed/` and published as a pipeline artifact plus a summary table |
| `fail` | The test fails with "healed, please review", so plan updates go through a PR |

In `replay-only` mode there is no AI healing (fingerprint healing still applies, §7). If that fails, the step fails
with a pointer to run `aipw cache refresh <spec>` locally.

## 7. Locator synthesis (stable locators from a ref)

LocatorSynth turns the element behind a ref into durable, verified locators, using the **locator ladder** in
[12](12-element-identification.md) §3: test-id attributes (any spelling) → role + name (scoped) → form semantics →
stable id → anchored/relative → exact text → structural CSS. It also stores a **fingerprint** for no-AI healing.
The same output feeds nudge-mode **code remedies** and `ai.locate`.

### Heal order

When all stored locators fail during replay:
1. **Fingerprint match** (no AI, deterministic, allowed in `replay-only`). See [12](12-element-identification.md) §6.
2. **AI heal**, as described in §6 above (not in `replay-only`).

## 8. Cache maintenance CLI

```bash
npx aipw cache stats                  # per spec: steps, replays, heals, stale entries
npx aipw cache prune                  # drop plans whose step no longer exists in the spec
npx aipw cache refresh tests/users.spec.ts --grep "create a user"
npx aipw cache show tests/users.spec.ts:14
```

`prune` finds live steps by running the specs in `--list` mode with a collector that records step keys without executing.
