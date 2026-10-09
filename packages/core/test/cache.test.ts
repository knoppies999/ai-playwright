import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MemoryPlanStore } from '../src/cache/store.js';
import { resolveConfig, type AipwConfigInput } from '../src/config.js';
import { AiCacheReplayOnlyMiss, AiHealedError, AiStepError } from '../src/errors.js';
import type { AipwEvent } from '../src/events/bus.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { Ai } from '../src/step/ai.js';
import { html, useBrowser } from './browser.js';

const { page: open } = useBrowser();
const ORIGIN = 'http://app.test';
const TEST = 'login > logs in';

/** Serves app.html, optionally changed (to simulate a UI change). */
async function openApp(change: (s: string) => string = (s) => s): Promise<Page> {
  const page = await open('', { testIdAttribute: 'data-test' });
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: change(html('app.html')) }));
  await page.goto(`${ORIGIN}/`);
  return page;
}

function makeAi(
  page: Page,
  provider: FakeProvider,
  store: MemoryPlanStore,
  config: AipwConfigInput = {},
  healedStore?: MemoryPlanStore,
) {
  const events: AipwEvent[] = [];
  const ai = new Ai({
    page,
    provider,
    baseURL: ORIGIN,
    playwrightTestIdAttribute: 'data-test',
    config: resolveConfig({
      secrets: { map: { password: 'AIPW_TEST_PASSWORD' } },
      settle: { maxMs: 600, networkQuietMs: 50, snapshotIntervalMs: 50 },
      ...config,
    }),
    cache: { store, testTitle: TEST, healedStore },
  });
  ai.events.on((e) => events.push(e));
  return { ai, events };
}

const pick =
  (text: string, tool: string, args: Record<string, unknown> = {}) =>
  (req: DecisionRequest) => {
    const ref = /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')?.[1];
    if (!ref) throw new Error(`no ref for "${text}"`);
    return { tool, args: { ref, intent: `${tool} ${text}`, ...args } };
  };
const click = { button: null, modifiers: null, clickCount: null };
const done = { tool: 'done', args: { summary: 'ok', evidence: [] } };
const loginScript = () => [
  pick('textbox "Username"', 'fill', { value: 'standard_user' }),
  pick('textbox "Password"', 'fill', { value: '{{secret.password}}' }),
  pick('button "Login"', 'click', click),
  done,
];
const login = (ai: Ai, user = 'standard_user') => ai.act('Log in', { data: { user }, secrets: ['password'] });

process.env.AIPW_TEST_PASSWORD = 'Sup3r-Secret!';

describe('plan cache', () => {
  it('records on the first run and replays with zero AI calls', async () => {
    const store = new MemoryPlanStore();
    const first = await login(makeAi(await openApp(), new FakeProvider(loginScript()), store).ai);
    expect(first.source).toBe('ai');

    const plan = Object.values(store.file.tests[TEST]!)[0]!;
    expect(plan.actions!.map((a) => a.tool)).toEqual(['fill', 'fill', 'click']);
    expect(plan.actions![0]!.args.value).toBe('{{data.user}}');
    expect(JSON.stringify(plan)).not.toContain('Sup3r-Secret!');
    expect(JSON.stringify(plan)).not.toMatch(/"ref"/);

    const page = await openApp();
    const provider = new FakeProvider(); // no scripted decisions: any AI call would throw
    const { ai, events } = makeAi(page, provider, store);
    const second = await login(ai);
    expect(second.source).toBe('cache');
    expect(second.usage.requests).toBe(0);
    expect(provider.decisionRequests).toHaveLength(0);
    await expect(page.locator('#welcome').isVisible()).resolves.toBe(true);
    expect(events.find((e) => e.type === 'cache')).toMatchObject({ outcome: 'hit' });
  });

  it('replays with the new run’s data values', async () => {
    const store = new MemoryPlanStore();
    await login(makeAi(await openApp(), new FakeProvider(loginScript()), store).ai);
    // Keep the form after login so the filled value can be read back.
    const page = await openApp((s) => s.replace("if (ok) document.querySelector('form').remove();", ''));
    await login(makeAi(page, new FakeProvider(), store).ai, 'locked_out_user');
    await expect(page.locator('[name=user]').inputValue()).resolves.toBe('locked_out_user');
  });

  it('replay-only fails clearly when there is no plan', async () => {
    const { ai } = makeAi(await openApp(), new FakeProvider(), new MemoryPlanStore(), {
      cache: { mode: 'replay-only' },
    });
    await expect(login(ai)).rejects.toBeInstanceOf(AiCacheReplayOnlyMiss);
  });

  it('ai-only never stores', async () => {
    const store = new MemoryPlanStore();
    await login(makeAi(await openApp(), new FakeProvider(loginScript()), store, { cache: { mode: 'ai-only' } }).ai);
    expect(store.file.tests).toEqual({});
  });

  describe('when the UI changes', () => {
    // Variant B: the login button's test id and label changed, so every stored locator for it fails.
    const variantB = (s: string) => s.replace('data-test="login-button">Login<', 'data-test="sign-in">Sign in<');
    const healScript = () => [pick('button "Sign in"', 'click', click), done];

    it('heals through the AI and replaces the plan (accept)', async () => {
      const store = new MemoryPlanStore();
      await login(makeAi(await openApp(), new FakeProvider(loginScript()), store).ai);

      const page = await openApp(variantB);
      const provider = new FakeProvider(healScript());
      const { ai, events } = makeAi(page, provider, store, { heal: { policy: 'accept' } });
      const result = await login(ai);
      expect(result.source).toBe('healed');
      expect(provider.decisionRequests[0]!.context).toContain('HEALING: a previously recorded plan');
      await expect(page.locator('#welcome').isVisible()).resolves.toBe(true);
      expect(events.find((e) => e.type === 'heal')).toMatchObject({ source: 'ai', policy: 'accept' });

      const healed = Object.values(store.file.tests[TEST]!)[0]!;
      expect(healed.stats.heals).toBe(1);
      expect(healed.history).toHaveLength(1);
      // The healed plan replays on variant B with no AI.
      const replayed = await login(makeAi(await openApp(variantB), new FakeProvider(), store).ai);
      expect(replayed.source).toBe('cache');
    });

    it('report policy leaves the committed plan alone and writes the healed one aside', async () => {
      const store = new MemoryPlanStore();
      const healedStore = new MemoryPlanStore();
      await login(makeAi(await openApp(), new FakeProvider(loginScript()), store).ai);
      const before = JSON.stringify(store.file);
      await login(
        makeAi(
          await openApp(variantB),
          new FakeProvider(healScript()),
          store,
          { heal: { policy: 'report' } },
          healedStore,
        ).ai,
      );
      expect(JSON.stringify(store.file)).toBe(before);
      expect(Object.keys(healedStore.file.tests)).toEqual([TEST]);
    });

    it('fail policy fails the test after healing', async () => {
      const store = new MemoryPlanStore();
      await login(makeAi(await openApp(), new FakeProvider(loginScript()), store).ai);
      const error = await login(
        makeAi(await openApp(variantB), new FakeProvider(healScript()), store, { heal: { policy: 'fail' } }).ai,
      ).catch((e) => e);
      expect(error).toBeInstanceOf(AiHealedError);
      expect(error.message).toContain('Was: fill textbox "Username" → fill textbox "Password" → click button "Login"');
    });

    it('replay-only does not heal with AI', async () => {
      const store = new MemoryPlanStore();
      await login(makeAi(await openApp(), new FakeProvider(loginScript()), store).ai);
      const error = await login(
        makeAi(await openApp(variantB), new FakeProvider(), store, { cache: { mode: 'replay-only' } }).ai,
      ).catch((e) => e);
      expect(error).toBeInstanceOf(AiStepError);
      expect(error.message).toMatch(/Replay failed at action 3: No stored locator matched button "Login"/);
    });
  });
});
