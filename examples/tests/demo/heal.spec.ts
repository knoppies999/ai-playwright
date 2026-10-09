// Phase 4 healing scenarios on the demo app (docs/10 Phase 4 exit): record on variant A, replay with no AI,
// switch to variant B, heal (fingerprint for renamed test ids, AI for a moved menu), replay B with no AI.
// FakeProvider plays the model, so this runs in CI with no AI and no network beyond localhost.
import { FakeProvider, test as base, expect, type Ai, type DecisionRequest, type Page } from '@aipw/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const provider = new FakeProvider();
const test = base.extend<object, { aipwProvider: FakeProvider }>({
  aipwProvider: [async ({}, use) => use(provider), { scope: 'worker' }],
});
// A fresh plan folder per run, so every run starts by recording.
test.use({
  aiConfig: {
    cache: { mode: 'auto', dir: mkdtempSync(join(tmpdir(), 'aipw-demo-plans-')) },
    heal: { policy: 'accept' },
  },
});

const pick =
  (text: string, tool: string, args: Record<string, unknown> = {}) =>
  (req: DecisionRequest) => {
    const ref = /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')?.[1];
    if (!ref) throw new Error(`no ref for "${text}" in:\n${req.observation}`);
    return { tool, args: { ref, intent: `${tool} ${text}`, ...args } };
  };
const click = { button: null, modifiers: null, clickCount: null };
const done = { tool: 'done', args: { summary: 'done', evidence: [] } };
/** The second "Save" button (Notifications), found by order in the snapshot. */
const secondSave = (req: DecisionRequest) => {
  const refs = [...req.observation.matchAll(/button "Save" \[ref=([^\]]+)\]/g)].map((m) => m[1]);
  return { tool: 'click', args: { ref: refs[1], intent: 'save notifications', ...click } };
};

async function phase(ai: Ai, page: Page, variant: 'a' | 'b') {
  await page.goto(`/app?variant=${variant}`);
  const step = ai.on(page); // a fresh step counter, sharing the plan cache
  const before = provider.decisionRequests.length;
  const users = await step.act('Open Settings > Users');
  await expect(page).toHaveURL(/\/users$/);
  await page.goto('/app');
  const save = await step.act('Save the notification settings');
  await expect(page.getByRole('status')).toHaveText('Notifications saved');
  return { aiCalls: provider.decisionRequests.length - before, sources: [users.source, save.source] };
}

test('record on A, replay, heal on B, replay B', async ({ ai, context }) => {
  // 1. Record on variant A (the model hovers the Settings flyout, then picks the second Save).
  provider.script(pick('button "Settings"', 'hover'), pick('link "Users"', 'click', click), done, secondSave, done);
  const recordA = await phase(ai, await context.newPage(), 'a');
  expect(recordA).toEqual({ aiCalls: 5, sources: ['ai', 'ai'] });

  // 2. Replay A: no AI at all.
  expect(await phase(ai, await context.newPage(), 'a')).toEqual({ aiCalls: 0, sources: ['cache', 'cache'] });

  // 3. Variant B. The Save buttons' test ids were renamed (fingerprint heal, no AI); the menu moved to
  //    "Admin" and "Users" became "People" (AI heal: the model is scripted to find the new path).
  provider.script(pick('button "Admin"', 'hover'), pick('link "People"', 'click', click), done);
  const healB = await phase(ai, await context.newPage(), 'b');
  expect(healB).toEqual({ aiCalls: 3, sources: ['healed', 'healed'] });

  // 4. Replay B: both healed plans replay with no AI.
  expect(await phase(ai, await context.newPage(), 'b')).toEqual({ aiCalls: 0, sources: ['cache', 'cache'] });
});
