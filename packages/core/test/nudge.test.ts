import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { NudgeController, type NudgeOptions } from '../src/nudge/controller.js';
import { RewindSignal, VerifyDone, type NudgeCommand, type PauseState } from '../src/nudge/protocol.js';
import { NudgeServer, ScriptedUi } from '../src/nudge/server.js';
import { Ai } from '../src/step/ai.js';
import { html, useBrowser } from './browser.js';

const { page: open } = useBrowser();
const servers: NudgeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function openApp(): Promise<Page> {
  const page = await open('');
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: html('app.html') }));
  await page.goto('http://app.test/');
  return page;
}

/** A real TCP server + controller pair, with the human's answers scripted. */
async function nudged(answers: ((s: PauseState) => NudgeCommand)[], options: NudgeOptions = {}) {
  const ui = new ScriptedUi(answers);
  const server = new NudgeServer(ui);
  servers.push(server);
  const port = await server.listen();
  const controller = await NudgeController.connect(port, { file: 'demo.spec.ts', title: 'nudge test' }, options);
  return { ui, server, controller };
}

const config = resolveConfig({ settle: { maxMs: 300, networkQuietMs: 50, snapshotIntervalMs: 50 } });
const refOf = (text: string, req: DecisionRequest) =>
  /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')![1]!;
const clickSave = (req: DecisionRequest) => ({
  tool: 'click',
  args: { ref: refOf('button "Save"', req), button: null, modifiers: null, clickCount: null, intent: 'save' },
});
const done = { tool: 'done', args: { summary: 'ok', evidence: [] } };
const click = (name: string) => (req: DecisionRequest) => ({
  tool: 'click',
  args: { ref: refOf(name, req), button: null, modifiers: null, clickCount: null, intent: `click ${name}` },
});
const SAVE = `locator('[data-test="save"]')`;
const basis = {
  startUrl: 'http://app.test/',
  finalUrl: 'http://app.test/',
  finalTargets: [SAVE],
  input: { instruction: 'Export the report', failed: [], corrected: [], humanInput: ['hint: x'], targetFacts: [] },
};

describe('nudge mode', () => {
  it('pauses before a step, and a hint reaches the model', async () => {
    const { ui, controller } = await nudged([() => ({ cmd: 'hint', text: 'Save is in the main area' })]);
    const provider = new FakeProvider([done]);
    await new Ai({ page: await openApp(), provider, config, nudge: controller }).act('Save the settings');
    expect(ui.seen[0]).toMatchObject({
      reason: 'step',
      step: { index: 1, kind: 'act', instruction: 'Save the settings', cached: false },
    });
    expect(provider.decisionRequests[0]!.context).toContain('Save is in the main area');
  });

  it('at action level shows each decision; skip records it as rejected', async () => {
    const { ui, controller } = await nudged([() => ({ cmd: 'skip' })], { breakLevel: 'action' });
    const provider = new FakeProvider([
      clickSave,
      (req) => {
        expect(req.context).toContain('→ FAILED: skipped by the person running the test');
        return done;
      },
    ]);
    await new Ai({ page: await openApp(), provider, config, nudge: controller }).act('Save');
    expect(ui.seen[0]).toMatchObject({
      reason: 'decision',
      decision: { tool: 'click', intent: 'save', target: { role: 'button', name: 'Save' } },
    });
    expect(ui.seen[0]!.snapshot).toContain('button "Save"');
  });

  it('turns a fail into a pause; a hint retries the step', async () => {
    const { ui, controller } = await nudged([
      () => ({ cmd: 'run' }),
      () => ({ cmd: 'hint', text: 'It is the button labelled Save' }),
    ]);
    const provider = new FakeProvider([
      { tool: 'fail', args: { kind: 'not_found', reason: 'no export button' } },
      clickSave,
      done,
    ]);
    const result = await new Ai({ page: await openApp(), provider, config, nudge: controller }).act(
      'Export the report',
    );
    expect(ui.seen[1]).toMatchObject({ reason: 'fail', failure: { kind: 'not_found', reason: 'no export button' } });
    expect(result.actions.map((a) => a.tool)).toEqual(['click']);
  });

  it('after a corrected step, offers remedies with a hint, a revised instruction and code', async () => {
    const { ui, controller } = await nudged([
      () => ({ cmd: 'run' }),
      () => ({ cmd: 'hint', text: 'It is the button labelled Save' }),
      () => ({ cmd: 'run' }),
    ]);
    const provider = new FakeProvider(
      [{ tool: 'fail', args: { kind: 'not_found', reason: 'no export button' } }, clickSave, done],
      [
        {
          diagnosis: 'The export is done with the Save button.',
          category: 'naming-mismatch',
          revisedInstruction: 'Click "Save"',
          splitInto: null,
          hint: { scope: 'site', pathPattern: null, text: 'Exporting a report is done with Save.' },
        },
      ],
    );
    await new Ai({ page: await openApp(), provider, config, nudge: controller }).act('Export the report');
    expect(provider.structuredRequests[0]!.prompt).toContain('- hint: It is the button labelled Save');
    const offer = ui.seen[2]!;
    expect(offer).toMatchObject({
      reason: 'remedies',
      step: { index: 1, instruction: 'Export the report' },
      remedies: { category: 'naming-mismatch', pageUrl: 'http://app.test/' },
    });
    expect(offer.remedies!.options.map((o) => o.kind)).toEqual(['hint', 'instruction', 'code']);
    expect(offer.remedies!.options[2]!.lines).toEqual([`await page.${SAVE}.click();`]);
    expect(offer.remedies!.basis).toMatchObject({
      finalTargets: expect.arrayContaining([SAVE]),
      startUrl: 'http://app.test/',
    });
  });

  it('a verification run tries the candidate with no human help, reports, and ends the test', async () => {
    const { server, controller } = await nudged([], {
      breakLevel: 'none',
      verify: {
        step: 1,
        instruction: 'Export the report',
        option: { kind: 'instruction', label: 'Revised instruction', text: 'Click "Save"' },
        basis,
      },
    });
    const provider = new FakeProvider([
      (req) => {
        expect(req.context).toContain('Click "Save"');
        expect(req.tools.map((t) => t.name)).not.toContain('ask_human');
        return clickSave(req);
      },
      done,
    ]);
    const error = await new Ai({ page: await openApp(), provider, config, nudge: controller })
      .act('Export the report')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VerifyDone);
    await expect.poll(() => server.verifications.length).toBe(1);
    expect(server.verifications[0]).toMatchObject({ ok: true, reason: 'reached the same final target' });
  });

  it('round 2 re-synthesizes with the failure as feedback; a run that misses the target fails', async () => {
    const { server, controller } = await nudged([], {
      breakLevel: 'none',
      verify: {
        step: 1,
        instruction: 'Export the report',
        option: { kind: 'hint', label: 'Site hint (site)', hint: { scope: 'site', pathPattern: null, text: 'old' } },
        basis,
        feedback: 'The AI clicked Cancel.',
      },
    });
    const provider = new FakeProvider(
      [
        (req) => {
          expect(req.context).toContain('Save exports the report.');
          return done;
        },
      ],
      [
        {
          diagnosis: 'd',
          category: 'naming-mismatch',
          revisedInstruction: 'Click "Save"',
          splitInto: null,
          hint: { scope: 'site', pathPattern: null, text: 'Save exports the report.' },
        },
      ],
    );
    await new Ai({ page: await openApp(), provider, config, nudge: controller })
      .act('Export the report')
      .catch(() => undefined);
    expect(provider.structuredRequests[0]!.prompt).toContain('YOUR PREVIOUS SUGGESTION FAILED\nThe AI clicked Cancel.');
    await expect.poll(() => server.verifications.length).toBe(1);
    expect(server.verifications[0]).toMatchObject({
      ok: false,
      option: { hint: { text: 'Save exports the report.' } },
      reason: expect.stringContaining('without touching the corrected target'),
    });
  });

  it('pick: the human clicks the right element in the browser and it is used instead', async () => {
    const page = await openApp();
    const { ui, controller } = await nudged(
      [
        () => {
          // The human clicks Save once the picker is waiting; the click is swallowed by the picker.
          void (async () => {
            await page.waitForFunction(() => (window as { __aipwPicking?: boolean }).__aipwPicking === true);
            await page.locator('[data-test="save"]').click();
          })();
          return { cmd: 'pick' };
        },
      ],
      { breakLevel: 'action' },
    );
    const provider = new FakeProvider([click('button "Delete"'), done]);
    const result = await new Ai({ page, provider, config, nudge: controller }).act('Export the report');
    expect(ui.seen[0]!.decision).toMatchObject({ tool: 'click', target: { name: 'Delete' } });
    expect(result.actions.map((a) => [a.tool, a.target?.name, a.result])).toEqual([['click', 'Save', 'ok']]);
    expect(result.actions[0]!.target!.candidates[0]!.display).toBe(SAVE);
    // Nothing was deleted: the AI's click never ran, and the picker swallowed the human's click.
    expect(await page.locator('#deleted').isHidden()).toBe(true);
  });

  it('manual: what the human does in the browser is recorded with verified locators, passwords masked', async () => {
    const page = await openApp();
    const { ui, controller } = await nudged(
      [
        () => ({ cmd: 'manual' }),
        (async () => {
          await page.locator('[data-test="username"]').click();
          await page.locator('[data-test="username"]').pressSequentially('thandi');
          await page.locator('[data-test="password"]').fill('nope-not-it');
          await page.locator('[data-test="login-button"]').click();
          return { cmd: 'run' };
        }) as unknown as () => NudgeCommand,
      ],
      { breakLevel: 'action' },
    );
    const provider = new FakeProvider([
      click('button "Delete"'),
      (req) => {
        expect(req.context).toContain('#1 fill textbox "Username" [manual] value="thandi" (done by hand');
        return done;
      },
    ]);
    const result = await new Ai({ page, provider, config, nudge: controller }).act('Log in');
    expect(ui.seen[1]).toMatchObject({ reason: 'breakpoint', note: expect.stringContaining('yourself') });
    expect(result.actions.map((a) => [a.tool, a.target?.name, (a.args as { value?: string }).value])).toEqual([
      ['fill', 'Username', 'thandi'],
      ['fill', 'Password', '{{secret.?}}'],
      ['click', 'Login', undefined],
    ]);
    expect(result.actions[2]!.target!.candidates[0]!.display).toBe(`locator('[data-test="login-button"]')`);
    expect(JSON.stringify(result.actions)).not.toContain('nope-not-it');
    expect(await page.locator('[data-aipw-rec]').count()).toBe(0);
  });

  it('undo: reverses the last action, marks it rejected and lets the human fix the page', async () => {
    const { ui, controller } = await nudged([() => ({ cmd: 'run' }), () => ({ cmd: 'undo' }), () => ({ cmd: 'run' })], {
      breakLevel: 'action',
    });
    const provider = new FakeProvider([
      click('button "Open Menu"'),
      click('button "Save"'),
      (req) => {
        expect(req.context).toContain('undone by the person running the test');
        return done;
      },
    ]);
    const result = await new Ai({ page: await openApp(), provider, config, nudge: controller }).act('Save');
    expect(ui.seen[2]).toMatchObject({ reason: 'breakpoint', note: expect.stringContaining('Undid click') });
    expect(result.actions[0]!.result).toMatch(/^undone/);
    expect(result.actions).toHaveLength(1);
  });

  it('options: the AI offers alternatives and the chosen one runs', async () => {
    const { ui, controller } = await nudged([() => ({ cmd: 'options' }), () => ({ cmd: 'choose', index: 0 })], {
      breakLevel: 'action',
    });
    const provider = new FakeProvider(
      [click('button "Delete"'), done],
      [
        (req: { prompt: string }) => ({
          options: [
            { ref: /button "Save" \[ref=([^\]]+)\]/.exec(req.prompt)![1], tool: 'click', value: null, why: 'saves' },
            { ref: 'e999', tool: 'click', value: null, why: 'not on the page' },
          ],
        }),
      ],
    );
    const result = await new Ai({ page: await openApp(), provider, config, nudge: controller }).act('Save');
    expect(provider.structuredRequests[0]!.prompt).toContain('REJECTED: click');
    expect(ui.seen[1]).toMatchObject({
      reason: 'options',
      alternatives: [{ tool: 'click', name: 'Save', why: 'saves' }],
    });
    expect(result.actions.map((a) => a.target?.name)).toEqual(['Save']);
  });

  it('highlights the AI target while a decision is shown, and removes it after', async () => {
    const page = await openApp();
    const shown: boolean[] = [];
    const { controller } = await nudged(
      [
        (async () => {
          shown.push(
            await page.evaluate(
              () =>
                !!document.querySelector('x-pw-glass') &&
                getComputedStyle(document.querySelector('x-pw-glass')!).display !== 'none',
            ),
          );
          return { cmd: 'run' };
        }) as unknown as () => NudgeCommand,
      ],
      { breakLevel: 'action' },
    );
    await new Ai({ page, provider: new FakeProvider([clickSave, done]), config, nudge: controller }).act('Save');
    expect(shown).toEqual([true]);
    expect(
      await page.evaluate(
        () =>
          !!document.querySelector('x-pw-glass') &&
          getComputedStyle(document.querySelector('x-pw-glass')!).display !== 'none',
      ),
    ).toBe(false);
  });

  it('offers ask_human and passes the answer back', async () => {
    const { ui, controller } = await nudged([
      () => ({ cmd: 'run' }),
      (s) => ({ cmd: 'answer', text: s.question === 'Which Save?' ? 'the first one' : '?' }),
    ]);
    const provider = new FakeProvider([
      (req) => {
        expect(req.tools.map((t) => t.name)).toContain('ask_human');
        return { tool: 'ask_human', args: { question: 'Which Save?' } };
      },
      (req) => {
        expect(req.context).toContain('#1 ask_human question="Which Save?" → ok: the first one');
        return done;
      },
    ]);
    await new Ai({ page: await openApp(), provider, config, nudge: controller }).act('Save');
    expect(ui.seen[1]).toMatchObject({ reason: 'ask', question: 'Which Save?' });
  });

  it('does not offer ask_human outside nudge mode', async () => {
    const provider = new FakeProvider([done]);
    await new Ai({ page: await openApp(), provider, config }).act('Save');
    expect(provider.decisionRequests[0]!.tools.map((t) => t.name)).not.toContain('ask_human');
  });

  it('rewind ends the run with a RewindSignal the driver sees', async () => {
    const { server, controller } = await nudged([() => ({ cmd: 'rewind', toStep: 1 })]);
    const error = await new Ai({ page: await openApp(), provider: new FakeProvider(), config, nudge: controller })
      .act('Save')
      .catch((e) => e);
    expect(error).toBeInstanceOf(RewindSignal);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.pendingRewind).toBe(1);
  });

  it('fast-forwards past steps before the rewind target, then pauses', async () => {
    const { ui, controller } = await nudged([() => ({ cmd: 'continue', level: 'none' })], { resumeAt: 2 });
    const ai = new Ai({ page: await openApp(), provider: new FakeProvider([done, done]), config, nudge: controller });
    await ai.act('Step one');
    await ai.act('Step two');
    expect(ui.seen.map((s) => s.step.index)).toEqual([2]);
  });

  it('ai.nudge() is a breakpoint in nudge mode and a no-op otherwise', async () => {
    const { ui, controller } = await nudged([() => ({ cmd: 'run' })], { breakLevel: 'none' });
    await new Ai({ page: await openApp(), provider: new FakeProvider(), config, nudge: controller }).nudge(
      'check the form',
    );
    expect(ui.seen[0]).toMatchObject({ reason: 'breakpoint', note: 'check the form' });
    await new Ai({ page: await openApp(), provider: new FakeProvider(), config }).nudge('ignored');
  });
});
