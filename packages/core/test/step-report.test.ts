import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { Ai, type StepAttach } from '../src/step/ai.js';
import { html, useBrowser } from './browser.js';

const { page: open } = useBrowser();
const config = resolveConfig({ settle: { maxMs: 300, networkQuietMs: 50, snapshotIntervalMs: 50 } });
const refOf = (text: string, req: DecisionRequest) =>
  /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')![1]!;
const done = { tool: 'done', args: { summary: 'ok', evidence: [] } };

/** Records what the test.step wrappers would see. */
function reporting() {
  const steps: { title: string; files: Record<string, string | Buffer> }[] = [];
  const actions: string[] = [];
  return {
    steps,
    actions,
    wrapStep: async <T>(title: string, fn: (attach?: StepAttach) => Promise<T>) => {
      const step = { title, files: {} as Record<string, string | Buffer> };
      steps.push(step);
      return fn(async (name, body) => {
        step.files[name] = body;
      });
    },
    wrapAction: async <T>(title: string, fn: () => Promise<T>) => {
      actions.push(title);
      return fn();
    },
  };
}

describe('AI steps in the report', () => {
  it('nests a step per action and attaches the decisions to the AI step', async () => {
    const r = reporting();
    const provider = new FakeProvider([
      (req) => ({
        tool: 'fill',
        args: { ref: refOf('textbox "Username"', req), value: 'standard_user', intent: 'user' },
      }),
      (req) => ({
        tool: 'click',
        args: { ref: refOf('button "Save"', req), button: null, modifiers: null, clickCount: null, intent: 'save' },
      }),
      done,
    ]);
    await new Ai({ page: await open(html('app.html')), provider, config, ...r }).act('Fill the user and save');
    expect(r.steps.map((s) => s.title)).toEqual(['ai.act: Fill the user and save']);
    expect(r.actions).toEqual(['fill textbox "Username"', 'click button "Save"']);
    const decisions = JSON.parse(String(r.steps[0]!.files['aipw-decisions.json']));
    expect(decisions.map((e: { type: string }) => e.type)).toContain('decision');
    expect(Object.keys(r.steps[0]!.files)).toEqual(['aipw-decisions.json']);
  });

  it('on failure also attaches the last snapshot and a screenshot', async () => {
    const r = reporting();
    const provider = new FakeProvider([{ tool: 'fail', args: { kind: 'not_found', reason: 'no export button' } }]);
    await new Ai({ page: await open(html('app.html')), provider, config, ...r })
      .act('Export the report')
      .catch(() => undefined);
    const files = r.steps[0]!.files;
    expect(Object.keys(files).sort()).toEqual(['aipw-decisions.json', 'aipw-screenshot.jpg', 'aipw-snapshot.yaml']);
    expect(String(files['aipw-snapshot.yaml'])).toContain('button "Save"');
    expect((files['aipw-screenshot.jpg'] as Buffer).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });
});
