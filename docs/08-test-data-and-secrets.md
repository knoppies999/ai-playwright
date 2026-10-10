# 08 — Test data and secrets

Forms with real validation need real valid values. LLMs are bad at inventing them: they produce
checksums that fail, IDs whose date of birth doesn't match, or the same "test@example.com" every
time. The rule is: **the model chooses *where* values go. Code produces the values.**

## 1. Three sources of values

| Source | Model sees | Example |
|---|---|---|
| `data` (caller-provided) | the value | `{ firstName: 'Thandi' }` |
| generators (`gen`, or the model calls `generate_value`) | the value, after generation | `gen.saId({ born: '1990-04-12', gender: 'F' })` |
| `secrets` | only the placeholder `{{secret.name}}` | `secrets: ['initialPassword']` |

## 2. Placeholders

Action args may contain placeholders. They are resolved by `DataResolver` **inside the executor**, right before the
Playwright call:

| Placeholder | Resolves to |
|---|---|
| `{{data.firstName}}` | `options.data.firstName` |
| `{{secret.initialPassword}}` | value from the secret provider |
| `{{gen.email()}}` / `{{gen.saId({"born":"1990-04-12"})}}` | a fresh generated value (cached per step run, so the same placeholder in one step gives the same value) |
| `{{values.idNumber}}` | a value generated or extracted earlier **in the same test** |

The model is told to pass placeholders verbatim for secrets, and may use `{{data.x}}` or the literal value.
Plans in the cache **always store placeholders** (literal values that equal a `data` value are converted back to the
placeholder before saving), so replays use the new run's data.

## 3. Generators (`@aipw/core/data/generators`)

Built on `@faker-js/faker` (seeded per test: `seed = hash(testId + runSeed)`; nudge rewinds reuse the seed).

| Generator | Valid by | Params |
|---|---|---|
| `email()` | unique per run (`+<runId>-<n>` tag) | `domain?` |
| `phone(country)` | E.164 and national format | `'ZA'`, `'US'`, … `format?` |
| `saId()` | YYMMDD + gender digits + citizenship + **Luhn** check digit | `born?`, `gender?`, `citizen?` |
| `luhn(length, prefix?)` | Luhn | card-like numbers |
| `testCard(brand)` | provider test card numbers (Stripe-style test PANs) | `visa`, `mastercard` … |
| `iban(country)` | ISO 13616 mod-97 | `'DE'`, `'GB'`, `'NL'` … |
| `vatNumber(country)` | country checksum where defined | |
| `date(opts)` | ISO / locale formats | `from`, `to`, `format` |
| `uuid()`, `slug()`, `words(n)` | | |
| `person()` | coherent name + email + phone + DOB | `country` |
| `address(country)` | | |

Each generator has a matching **validator** (`isValidSaId` …), unit-tested against published examples.
Custom generators can be registered: `gen.register('employeeNo', () => 'E' + faker.string.numeric(6))`.

### `generate_value` tool

When an instruction says "use a valid South African ID number for someone born in 1990" and `data` doesn't provide
one, the model calls `generate_value({ kind: 'saId', params: { born: '1990-01-01' } })`. The executor returns the value,
records it in `result.values` under a name the model gives (`as: 'idNumber'`), and stores `{{gen.saId(...)}}` in the plan.

### Choosing from the page

For valid values that come from the app (dropdown options, existing customers), the model picks from what it sees.
Extract them when the test needs them later: `ai.extract('the selected cost centre code', z.string())`.

## 4. Secrets

```ts
// aipw.config.ts
secrets: {
  provider: 'env',                       // 'env' | custom function (e.g. Azure Key Vault)
  map: { initialPassword: 'TEST_USER_INITIAL_PASSWORD', adminPassword: 'TEST_ADMIN_PASSWORD' },
}
```

Rules:
1. Secret values are **never** put into a prompt, an event, a log, a plan, a nudge remedy or a report attachment.
   `DataResolver` registers every resolved secret value with the **Redactor**, which scrubs exact matches (and their
   URL-encoded forms) from every string the framework emits.
2. Prefer **code** for authentication: log in via API or a `globalSetup` that saves `storageState`, and reuse it. The `login_as`
   code tool pattern ([03](03-test-authoring-api.md) §7) keeps credentials entirely out of AI steps.
3. **Playwright traces and videos are outside the redactor's control.** Spike 0.7 (Playwright 1.64) found the
   secret in `trace.trace` in three places:

   | How the value was set | Action params / log | DOM snapshots |
   |---|---|---|
   | `fill` | leaked | leaked |
   | `pressSequentially` | leaked | leaked |
   | `evaluate` (set `el.value`, dispatch `input`/`change`) | clean | **leaked**: snapshots record input values, even `type=password` |
   | `evaluate` + tracing with `snapshots: false` | clean | none taken: **no leak** |

   So `fillMode: 'evaluate'` alone is **not** enough. Mitigations, in order of preference:
   a. don't fill secrets via AI steps (rule 2);
   b. `secrets.fillMode: 'evaluate'` **and** traces without DOM snapshots for that test
      (`use: { trace: { mode: 'retain-on-failure', snapshots: false } }`, screenshots are fine), with a
      `pressSequentially('')` nudge for frameworks that need key events. When a step resolves a secret and the active
      trace config has snapshots on, `@aipw/test` warns once per test;
   c. disable traces for that test.

   The Phase 5 secret-leak check greps unzipped traces too, not only `.aipw/`, reports and plans.

   **As built (Phase 5):** the leak check found that aipw's *own* observation calls leaked: every `ariaSnapshot` result is
   recorded in the trace before aipw can mask it, and AI-mode snapshots include input values. The Observer now masks
   credential inputs (`type=password`, `autocomplete` password/one-time-code) **in the page** for the duration of each
   snapshot: the real value is swapped for `••••` and restored straight after, without events. Playwright's snapshot code
   runs in an isolated world that sees only the DOM, so an instance-level getter would not work. Two more rules from the
   check: never write a secret in a spec (traces include source files), and the recommended setup is
   `fillMode: 'evaluate'` plus `trace: { mode: ..., snapshots: false }`, which `@aipw/test` now warns about.
4. Secrets only resolve for fields that look like credential fields (`type=password`, or `autocomplete` containing
   `password`/`one-time-code`), unless `secrets.allowAnyField: true`. This stops a prompt-injected page from
   getting a secret typed into a visible text field.

## 5. TOTP / MFA

`gen.totp('TEST_ADMIN_TOTP_SECRET')` (env var name) produces the current code. It is treated as a secret (placeholder
`{{secret.totp:TEST_ADMIN_TOTP_SECRET}}`). Only for test accounts with known TOTP seeds.

## 6. Returning values to the test

```ts
const r = await ai.act('Create a new customer with a valid SA ID', { data: { name: 'Lerato' } });
r.values.idNumber;                       // the generated ID
await ai.assert('The customer list shows the ID number {{values.idNumber}}');
```

`values` accumulate per test and are available as `{{values.x}}` in later steps and as `ai.values` in code.
