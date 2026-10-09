// The `ai` fixture end to end with FakeProvider on a local page: proves the Playwright Test wiring
// (provider loading override, test.step nesting, attachments, secrets) without any AI calls.
import { FakeProvider, test as base, expect, type DecisionRequest } from '@aipw/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ORIGIN = 'http://aipw-fixture.test';
const html = readFileSync(join(import.meta.dirname, 'app.html'), 'utf8');

const pick =
  (text: string, tool: string, args: Record<string, unknown> = {}) =>
  (req: DecisionRequest) => {
    const ref = /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')?.[1];
    if (!ref) throw new Error(`no ref for ${text}`);
    return { tool, args: { ref, intent: `${tool} ${text}`, ...args } };
  };
const click = { button: null, modifiers: null, clickCount: null };

const provider = new FakeProvider();

const test = base.extend<object, { aipwProvider: FakeProvider }>({
  aipwProvider: [async ({}, use) => use(provider), { scope: 'worker' }],
});

// ai-only: this spec scripts the FakeProvider per test, so it must never replay a stored plan.
test.use({ aiConfig: { secrets: { map: { password: 'AIPW_FIXTURE_PASSWORD' } }, cache: { mode: 'ai-only' } } });

test.beforeEach(async ({ page }) => {
  process.env.AIPW_FIXTURE_PASSWORD = 'Sup3r-Secret!';
  await page.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(`${ORIGIN}/`);
});

test('logs in through the ai fixture and attaches redacted decisions', async ({ page, ai }, testInfo) => {
  provider.script(
    pick('textbox "Username"', 'fill', { value: 'standard_user' }),
    pick('textbox "Password"', 'fill', { value: '{{secret.password}}' }),
    pick('button "Login"', 'click', click),
    { tool: 'done', args: { summary: 'Logged in', evidence: ['Welcome back!'] } },
  );
  provider.answer({ pass: true, reason: 'The welcome text is shown', evidence: ['Welcome back!'] });

  await ai.act('Log in as the standard user', { secrets: ['password'] });
  await ai.assert('A welcome message is shown');
  await expect(page.getByText('Welcome back!')).toBeVisible();

  // The fixture attaches decisions after the test; check the live events instead.
  expect(JSON.stringify(provider.decisionRequests)).not.toContain('Sup3r-Secret!');
  // The project traces with DOM snapshots (retain-on-failure), so entering a secret must raise the spike 0.7 warning.
  expect(testInfo.annotations.map((a) => a.type)).toContain('warning');
});

test('locate returns a durable test-id locator', async ({ ai }) => {
  provider.answer((req: { prompt: string }) => ({
    ref: /button "Save" \[ref=([^\]]+)\]/.exec(req.prompt)![1],
    reason: 'the Save button',
  }));
  const save = await ai.locate('the Save button');
  expect(save.toString()).toBe("getByTestId('save')");
  await save.click();
});
