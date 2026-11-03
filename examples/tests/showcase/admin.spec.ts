// The aipw showcase (npm run demo): one realistic admin journey on the local demo app, written in English.
// Real AI calls the first time; after that the committed plan replays with no AI. DEMO_VARIANT=b serves a
// redesigned UI (menu moved and renamed, test ids changed) so you can watch the plan heal itself.
//
//   npm run demo                 record → replay → redesign + heal → replay, with a summary per phase
//   npm run demo:replay          replay the committed plan only: no AI, no login, no internet
//   npx playwright test --project showcase --headed     watch it
import { expect, test } from '@aipw/test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const variant = process.env.DEMO_VARIANT === 'b' ? 'b' : 'a';
// The demo app's admin password. Public, but handled like a real secret: it never reaches the model,
// a prompt, a plan file or a report.
process.env.DEMO_ADMIN_PASSWORD ??= 'demo-password';
// The new user's initial password: a fresh secret per run.
process.env.DEMO_NEW_USER_PASSWORD ??= `Pw-${randomUUID().slice(0, 12)}`;

test.use({
  // Keep typed secrets out of the trace (docs/08 §4): no DOM snapshots.
  trace: { mode: 'retain-on-failure', snapshots: false },
  aiConfig: {
    // `npm run demo` points this at a scratch copy so the committed plan stays as it is.
    cache: { dir: process.env.AIPW_DEMO_PLANS ?? '__aipw__' },
    heal: { policy: 'accept' },
    secrets: {
      map: { password: 'DEMO_ADMIN_PASSWORD', initialPassword: 'DEMO_NEW_USER_PASSWORD' },
      fillMode: 'evaluate',
    },
  },
});

test.describe('showcase', { tag: '@llm' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/login?variant=${variant}`);
  });

  test('an admin finds the users and reads the table', async ({ page, ai }) => {
    await ai.act('Log in as admin', { data: { username: 'admin' }, secrets: ['password'] });
    await expect(page).toHaveURL(/\/app$/);

    // A hover-only flyout menu. In the redesign it moves to "Admin" and "Users" becomes "People".
    await ai.act('Open the users page from the settings menu');
    await expect(page).toHaveURL(/\/users$/);

    await ai.assert('Thandi Mokoena is Active and Sipho Dlamini is Disabled');
    const users = await ai.extract(
      'every user in the table with their status',
      z.array(z.object({ name: z.string(), status: z.enum(['Active', 'Disabled']) })),
    );
    expect(users).toEqual([
      { name: 'Thandi Mokoena', status: 'Active' },
      { name: 'Sipho Dlamini', status: 'Disabled' },
    ]);
  });

  test('a whole flow as an English script', async ({ ai }) => {
    // One bullet per step. "Verify …" lines are assertions; "Read … as name" stores a value. Each line is its own
    // cached step, so the script replays with no AI like any other test.
    const { values } = await ai.run(
      `
      - Log in as admin
      - Open the users page from the settings menu
      - Verify that Sipho Dlamini is listed as Disabled
      - Read the email address of Thandi Mokoena as thandiEmail
      `,
      { data: { username: 'admin' }, secrets: ['password'] },
    );
    expect(values.thandiEmail).toBe('thandi@example.com');

    // ai.locate hands back an ordinary Playwright locator, durable on replay.
    const addUser = await ai.locate('the button that adds a new user');
    await expect(addUser).toBeEnabled();
  });

  test('two identical Save buttons: the right one is pressed', async ({ page, ai }) => {
    await ai.act('Log in as admin', { data: { username: 'admin' }, secrets: ['password'] });
    // Both sections have a plain "Save" button; only the section tells them apart.
    await ai.act('Save the notification settings');
    await ai.assert('A message says the notifications were saved');
    await expect(page.getByRole('status')).toHaveText('Notifications saved');
  });

  test('a new user passes server-side validation with generated data', async ({ page, ai, gen }) => {
    await ai.act('Log in as admin', { data: { username: 'admin' }, secrets: ['password'] });
    await page.goto('/users/new');
    // The server checks the SA ID number (Luhn + birth date), the IBAN (mod 97) and the phone format.
    // gen makes valid values; the plan stores placeholders, so every replay gets fresh ones.
    await ai.act('Fill in the new user form with this data and save it', {
      data: {
        firstName: 'Lerato',
        lastName: 'Khumalo',
        email: gen.email(),
        idNumber: gen.saId({ born: '1994-03-18' }),
        phone: gen.phone('ZA'),
        iban: gen.iban('DE'),
      },
      secrets: ['initialPassword'],
    });
    await ai.assert('The user Lerato Khumalo was created');
    await expect(page.getByRole('status')).toHaveText('User created: Lerato Khumalo');
  });
});
