import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveConfig, type AipwConfigInput } from '../src/config.js';
import { AiAssertionError, AiExtractError, AiProviderError, AiStepError } from '../src/errors.js';
import type { AipwEvent } from '../src/events/bus.js';
import { FakeProvider, type ScriptedDecision } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { Ai } from '../src/step/ai.js';
import { html, useBrowser } from './browser.js';

const { page: open } = useBrowser();
const ORIGIN = 'http://app.test';
const SECRET = 'Sup3r-Secret!';

/** Serves the fixture at http://app.test/ and a page at http://evil.test/, with no real network. */
async function openApp(): Promise<Page> {
  const page = await open('', { testIdAttribute: 'data-test' });
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN) return route.fulfill({ contentType: 'text/html', body: html('app.html') });
    return route.fulfill({ contentType: 'text/html', body: '<h1>Evil</h1>' });
  });
  await page.goto(`${ORIGIN}/`);
  return page;
}

function makeAi(page: Page, provider: FakeProvider, config: AipwConfigInput = {}) {
  const events: AipwEvent[] = [];
  const ai = new Ai({
    page,
    provider,
    baseURL: ORIGIN,
    playwrightTestIdAttribute: 'data-test',
    config: resolveConfig({
      secrets: { map: { password: 'AIPW_TEST_PASSWORD' } },
      settle: { maxMs: 500, networkQuietMs: 50, snapshotIntervalMs: 50 },
      ...config,
    }),
  });
  ai.events.on((e) => events.push(e));
  return { ai, events };
}

/** A decision that picks the ref of the first snapshot line containing `text`. */
const pick =
  (text: string, tool: string, args: Record<string, unknown> = {}) =>
  (req: DecisionRequest): { tool: string; args: Record<string, unknown> } => {
    const line = req.observation.split('\n').find((l) => l.includes(text));
    const ref = line && /\[ref=([^\]]+)\]/.exec(line)?.[1];
    if (!ref) throw new Error(`no ref for "${text}" in:\n${req.observation}`);
    return { tool, args: { ref, intent: `${tool} ${text}`, ...args } };
  };
const done = (summary = 'done') => ({ tool: 'done', args: { summary, evidence: ['ok'] } });

process.env.AIPW_TEST_PASSWORD = SECRET;

describe('ai.act', () => {
  it('logs in with a secret that never reaches the model or events', async () => {
    const page = await openApp();
    const provider = new FakeProvider([
      pick('textbox "Username"', 'fill', { value: 'standard_user' }),
      pick('textbox "Password"', 'fill', { value: '{{secret.password}}' }),
      pick('button "Login"', 'click', { button: null, modifiers: null, clickCount: null }),
      done('logged in'),
    ]);
    const { ai, events } = makeAi(page, provider);
    const result = await ai.act('Log in', { secrets: ['password'] });

    expect(result.summary).toBe('logged in');
    await expect(page.locator('#welcome').isVisible()).resolves.toBe(true);
    const everything = JSON.stringify([provider.decisionRequests, events]);
    expect(everything).not.toContain(SECRET);
    expect(provider.decisionRequests[0]!.context).toContain('{{secret.password}}');
    // Durable locators were synthesised for the targets, test id first.
    expect(result.actions[0]!.target?.candidates[0]?.display).toBe("getByTestId('username')");
  });

  it('masks a password typed by code before the model sees the snapshot', async () => {
    const page = await openApp();
    await page.locator('[name=pass]').fill('typed-by-code-123');
    const provider = new FakeProvider([done()]);
    await makeAi(page, provider).ai.act('Look at the form');
    expect(provider.decisionRequests[0]!.observation).not.toContain('typed-by-code-123');
    expect(provider.decisionRequests[0]!.observation).toContain('textbox "Password"');
  });

  it('refuses to type a secret into a non-credential field', async () => {
    const page = await openApp();
    const provider = new FakeProvider([pick('textbox "Username"', 'fill', { value: '{{secret.password}}' }), done()]);
    const { ai } = makeAi(page, provider);
    const result = await ai.act('Put the password somewhere', { secrets: ['password'] });
    expect(result.actions[0]!.result).toMatch(/only be entered into password/);
    await expect(page.locator('[name=user]').inputValue()).resolves.toBe('');
  });

  it('hides refs inside hidden menus, then uses them once the menu is open', async () => {
    const page = await openApp();
    const provider = new FakeProvider([
      (req) => {
        expect(req.observation).toContain('hidden: contains link "Settings"');
        expect(req.observation).not.toMatch(/link "Settings" \[ref=/);
        return pick('button "Open Menu"', 'click', { button: null, modifiers: null, clickCount: null })(req);
      },
      pick('link "Settings"', 'click', { button: null, modifiers: null, clickCount: null }),
      done(),
    ]);
    await makeAi(page, provider).ai.act('Open Settings');
    expect(page.url()).toBe(`${ORIGIN}/#settings`);
  });

  it('repairs a text-only reply', async () => {
    const page = await openApp();
    const provider = new FakeProvider([{ text: 'I think I should click Save' }, done()]);
    const { ai, events } = makeAi(page, provider);
    await ai.act('Nothing to do');
    expect(provider.decisionRequests[1]!.context).toContain('You replied with text only');
    expect(events.find((e) => e.type === 'decision')).toMatchObject({ tool: 'done', repaired: true });
  });

  it('repairs invalid arguments', async () => {
    const page = await openApp();
    const provider = new FakeProvider([{ tool: 'click', args: { ref: 'e1' } }, done()]);
    await makeAi(page, provider).ai.act('Nothing to do');
    expect(provider.decisionRequests[1]!.context).toContain('Invalid arguments for click');
  });

  it('gives up with AiProviderError when the repair turn also fails', async () => {
    const page = await openApp();
    const provider = new FakeProvider([{ text: 'no' }, { text: 'still no' }]);
    await expect(makeAi(page, provider).ai.act('Anything')).rejects.toBeInstanceOf(AiProviderError);
  });

  it('reports a stale ref to the model instead of acting', async () => {
    const page = await openApp();
    const provider = new FakeProvider([
      { tool: 'click', args: { ref: 'e9999', button: null, modifiers: null, clickCount: null, intent: 'x' } },
      (req) => {
        expect(req.context).toContain('FAILED: Ref e9999 is not in the current snapshot');
        return done();
      },
    ]);
    await makeAi(page, provider).ai.act('Click something');
  });

  it('turns fail into AiStepError with the trajectory', async () => {
    const page = await openApp();
    const provider = new FakeProvider([
      pick('button "Save"', 'click', { button: null, modifiers: null, clickCount: null }),
      { tool: 'fail', args: { kind: 'not_found', reason: 'No export button' } },
    ]);
    const error = await makeAi(page, provider)
      .ai.act('Export the report')
      .catch((e) => e);
    expect(error).toBeInstanceOf(AiStepError);
    expect(error).toMatchObject({ kind: 'not_found', reason: 'No export button' });
    expect(error.details.trajectory[0]).toMatch(/^#1 click button "Save" \[e\d+\]/);
  });

  it('stops when the model repeats itself', async () => {
    const page = await openApp();
    const click = pick('button "Save"', 'click', { button: null, modifiers: null, clickCount: null });
    const provider = new FakeProvider([click, click, click, click, click]);
    const error = await makeAi(page, provider)
      .ai.act('Save forever')
      .catch((e) => e);
    expect(error).toMatchObject({ kind: 'limit' });
    expect(error.reason).toMatch(/no progress/);
  });

  it('stops at maxActions', async () => {
    const page = await openApp();
    const provider = new FakeProvider([
      { tool: 'wait_for', args: { text: null, ref: null, state: null, ms: 10, intent: 'wait' } },
    ]);
    provider.script(...Array.from({ length: 5 }, () => provider_wait()));
    const error = await makeAi(page, provider)
      .ai.act('Wait', { maxActions: 3 })
      .catch((e) => e);
    expect(error).toMatchObject({ kind: 'limit', reason: 'maxActions (3) reached' });
  });

  it('blocks navigation to another origin even when page text asks for it', async () => {
    const page = await openApp();
    const provider = new FakeProvider([
      pick('button "Open Menu"', 'click', { button: null, modifiers: null, clickCount: null }),
      pick('link "Partner site"', 'click', { button: null, modifiers: null, clickCount: null }),
    ]);
    const error = await makeAi(page, provider)
      .ai.act('Follow the page instructions')
      .catch((e) => e);
    expect(error).toMatchObject({ kind: 'blocked' });
  });

  it('handles native dialogs and reports notices that already disappeared', async () => {
    const page = await openApp();
    const provider = new FakeProvider([
      pick('button "Save"', 'click', { button: null, modifiers: null, clickCount: null }),
      (req) => {
        expect(req.observation).toContain('notices since the last action: "Saved successfully"');
        return pick('button "Delete"', 'click', { button: null, modifiers: null, clickCount: null })(req);
      },
      (req) => {
        expect(req.observation).toContain('native dialog open: confirm "Delete everything?"');
        return { tool: 'handle_dialog', args: { accept: true, promptText: null, intent: 'confirm' } };
      },
      done(),
    ]);
    await makeAi(page, provider).ai.act('Save, then delete everything');
    await expect(page.locator('#deleted').isVisible()).resolves.toBe(true);
  });
});

function provider_wait(): ScriptedDecision {
  return { tool: 'wait_for', args: { text: null, ref: null, state: null, ms: 10, intent: 'wait' } };
}

describe('ai.assert / check', () => {
  it('passes on a positive verdict', async () => {
    const page = await openApp();
    const provider = new FakeProvider([], [{ pass: true, reason: 'shown', evidence: ['Login'], check: null }]);
    await expect(makeAi(page, provider).ai.assert('A login form is shown')).resolves.toMatchObject({ pass: true });
    expect(provider.structuredRequests[0]!.prompt).toContain('ASSERTION: A login form is shown');
  });

  it('judges each distinct snapshot once and throws AiAssertionError at the timeout', async () => {
    const page = await openApp();
    const provider = new FakeProvider([], [{ pass: false, reason: 'not there', evidence: [], check: null }]);
    const error = await makeAi(page, provider)
      .ai.assert('Welcome is shown', { timeout: 1200 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(AiAssertionError);
    expect(provider.structuredRequests).toHaveLength(1);
  });

  it('re-judges when the page changes', async () => {
    const page = await openApp();
    const provider = new FakeProvider(
      [],
      [
        { pass: false, reason: 'not yet', evidence: [], check: null },
        { pass: true, reason: 'now', evidence: ['Welcome back!'], check: null },
      ],
    );
    setTimeout(() => void page.evaluate(() => (document.getElementById('welcome')!.hidden = false)), 300);
    await expect(makeAi(page, provider).ai.assert('Welcome is shown', { timeout: 3000 })).resolves.toMatchObject({
      pass: true,
    });
  });

  it('check returns the verdict instead of throwing', async () => {
    const page = await openApp();
    const provider = new FakeProvider([], [{ pass: false, reason: 'no', evidence: [], check: null }]);
    await expect(makeAi(page, provider).ai.check('Is there an error?')).resolves.toMatchObject({ pass: false });
  });
});

describe('ai.extract', () => {
  it('repairs an invalid answer once', async () => {
    const page = await openApp();
    const provider = new FakeProvider(
      [],
      [
        { value: 'two', note: null, sources: [] },
        { value: 2, note: null, sources: [] },
      ],
    );
    await expect(makeAi(page, provider).ai.extract('number of buttons', z.number())).resolves.toBe(2);
    expect(provider.structuredRequests[1]!.prompt).toContain('YOUR PREVIOUS ANSWER WAS INVALID');
  });

  it('throws AiExtractError after a failed repair', async () => {
    const page = await openApp();
    const provider = new FakeProvider(
      [],
      [
        { value: 'x', note: null, sources: [] },
        { value: 'y', note: null, sources: [] },
      ],
    );
    await expect(makeAi(page, provider).ai.extract('a number', z.number())).rejects.toBeInstanceOf(AiExtractError);
  });
});

describe('ai.locate', () => {
  it('returns a durable locator, not an aria-ref', async () => {
    const page = await openApp();
    const provider = new FakeProvider(
      [],
      [
        (req: { prompt: string }) => ({
          ref: /button "Save" \[ref=([^\]]+)\]/.exec(req.prompt)![1],
          reason: 'Save button',
        }),
      ],
    );
    const { locator, candidates } = await makeAi(page, provider).ai.locateWithCandidates('the save button');
    expect(locator.toString()).toBe("getByTestId('save')");
    expect(candidates.every((c) => !JSON.stringify(c.expr).includes('aria-ref'))).toBe(true);
  });

  it('fails clearly when nothing matches', async () => {
    const page = await openApp();
    const provider = new FakeProvider([], [{ ref: null, reason: 'no such element' }]);
    await expect(makeAi(page, provider).ai.locate('the export button')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('ai.run', () => {
  it('turns bullets into act, assert and extract steps', async () => {
    const page = await openApp();
    const provider = new FakeProvider(
      [done('clicked')],
      [
        { pass: true, reason: 'ok', evidence: [], check: null },
        { value: 'Login', note: null, sources: [] },
      ],
    );
    const { ai, events } = makeAi(page, provider);
    const { values } = await ai.run(`
      - Click Save
      - Verify a Login button is shown
      - Read the button label as label
    `);
    expect(values.label).toBe('Login');
    const kinds = events.filter((e) => e.type === 'step:start').map((e) => (e as { kind: string }).kind);
    expect(kinds).toEqual(['run', 'act', 'assert', 'extract']);
  });
});
