// Phase 5 exit (docs/10): a validation-heavy form with server-side checks passes uncached and cached,
// with generated values (SA ID, ZA phone, IBAN) and a secret initial password. The secret is entered by
// script and traces keep no DOM snapshots, so scripts/leak-check.mjs finds it nowhere (spike 0.7).
import { FakeProvider, test as base, expect, type DecisionRequest } from '@aipw/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Never put a secret in source: traces include the test's source files. CI passes DEMO_INITIAL_PASSWORD and
// runs the leak check for it; locally a random one is used.
process.env.DEMO_INITIAL_PASSWORD ??= `Pw-${randomUUID()}`;

const provider = new FakeProvider();
const test = base.extend<object, { aipwProvider: FakeProvider }>({
  aipwProvider: [async ({}, use) => use(provider), { scope: 'worker' }],
});
test.use({
  trace: { mode: 'on', snapshots: false },
  aiConfig: {
    cache: { mode: 'auto', dir: mkdtempSync(join(tmpdir(), 'aipw-demo-users-')) },
    secrets: { map: { initialPassword: 'DEMO_INITIAL_PASSWORD' }, fillMode: 'evaluate' },
  },
});

const refOf = (text: string, req: DecisionRequest) => {
  const ref = /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')?.[1];
  if (!ref) throw new Error(`no ref for "${text}"`);
  return ref;
};
/** The value generate_value returned in history line #n. */
const generated = (n: number, req: DecisionRequest) =>
  new RegExp(`#${n} generate_value[^\\n]*→ ok: (\\S+)`).exec(req.context)![1]!;

test('new user form: valid generated data passes server validation, then replays', async ({ ai, gen, context }) => {
  provider.script(
    {
      tool: 'generate_value',
      args: { kind: 'saId', params: '{"born":"1991-07-23"}', as: 'idNumber', intent: 'valid ID' },
    },
    { tool: 'generate_value', args: { kind: 'phone', params: '{"country":"ZA"}', as: 'phone', intent: 'valid phone' } },
    { tool: 'generate_value', args: { kind: 'iban', params: '{"country":"DE"}', as: 'iban', intent: 'valid IBAN' } },
    (req) => ({
      tool: 'fill_form',
      intent: 'fill the form',
      args: {
        intent: 'fill the form',
        fields: [
          { ref: refOf('textbox "First name"', req), value: '{{data.firstName}}' },
          { ref: refOf('textbox "Last name"', req), value: '{{data.lastName}}' },
          { ref: refOf('textbox "Email"', req), value: '{{data.email}}' },
          { ref: refOf('textbox "SA ID number"', req), value: generated(1, req) },
          { ref: refOf('textbox "Phone"', req), value: generated(2, req) },
          { ref: refOf('textbox "IBAN"', req), value: generated(3, req) },
          { ref: refOf('textbox "Initial password"', req), value: '{{secret.initialPassword}}' },
        ],
      },
    }),
    (req) => ({
      tool: 'click',
      args: { ref: refOf('button "Save user"', req), button: null, modifiers: null, clickCount: null, intent: 'save' },
    }),
    { tool: 'done', args: { summary: 'User created', evidence: ['User created'] } },
  );

  const run = async () => {
    const page = await context.newPage();
    await page.goto('/users/new');
    const step = ai.on(page);
    const before = provider.decisionRequests.length;
    const result = await step.act('Create a user with valid details', {
      data: { firstName: 'Lerato', lastName: 'Naidoo', email: gen.email() },
      secrets: ['initialPassword'],
    });
    await expect(page.getByRole('status')).toHaveText('User created: Lerato Naidoo');
    await expect(page.getByRole('alert')).toBeEmpty();
    return { source: result.source, aiCalls: provider.decisionRequests.length - before, values: { ...step.values } };
  };

  const first = await run();
  expect(first).toMatchObject({ source: 'ai', aiCalls: 6 });
  // Cached run: no AI, freshly generated values that the server accepts again.
  const second = await run();
  expect(second).toMatchObject({ source: 'cache', aiCalls: 0 });
  expect(second.values.idNumber).not.toBe(first.values.idNumber);
});
