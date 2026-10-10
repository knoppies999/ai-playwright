import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { NudgeController } from '../src/nudge/controller.js';
import { RewindSignal, type NudgeCommand, type PauseState } from '../src/nudge/protocol.js';
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
async function nudged(
  answers: ((s: PauseState) => NudgeCommand)[],
  options: { breakLevel?: 'step' | 'action' | 'fail' | 'none'; resumeAt?: number } = {},
) {
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
    expect(offer.remedies!.options[2]!.lines).toEqual(['await page.locator(\'[data-test="save"]\').click();']);
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
