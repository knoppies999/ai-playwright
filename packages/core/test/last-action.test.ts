// docs/04 §3.3: an action marked `last` ends the step without a separate `done` turn, but only when it worked and
// the page visibly changed. A last action that changed nothing gets one more look from the model.
import { describe, expect, it } from 'vitest';
import { planArgs } from '../src/cache/record.js';
import { resolveConfig } from '../src/config.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { Ai } from '../src/step/ai.js';
import { useBrowser } from './browser.js';

const { page: open } = useBrowser();

const ref = (text: string, req: DecisionRequest) =>
  /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')?.[1];
const click = (name: string, last: boolean | null) => (req: DecisionRequest) => ({
  tool: 'click',
  args: { ref: ref(`button "${name}"`, req), button: null, modifiers: null, clickCount: null, intent: name, last },
});
const config = resolveConfig({ settle: { maxMs: 300, networkQuietMs: 50, snapshotIntervalMs: 50 } });

describe('last actions', () => {
  it('end the step after a click that changed the page, with one model call', async () => {
    const page = await open(
      `<button onclick="document.body.insertAdjacentHTML('beforeend','<p>Saved</p>')">Save</button>`,
    );
    const provider = new FakeProvider([click('Save', true)]);
    const result = await new Ai({ page, provider, config }).act('Save');
    expect(provider.decisionRequests).toHaveLength(1);
    expect(result).toMatchObject({ summary: 'Save', source: 'ai' });
    expect(await page.getByText('Saved').isVisible()).toBe(true);
  });

  it('get one more decision when the page did not change', async () => {
    const page = await open(`<button>Inert</button>`);
    const provider = new FakeProvider([
      click('Inert', true),
      { tool: 'done', args: { summary: 'nothing to see', evidence: [] } },
    ]);
    const result = await new Ai({ page, provider, config }).act('Press the inert button');
    expect(provider.decisionRequests).toHaveLength(2);
    expect(result.summary).toBe('nothing to see');
  });

  it('do not end the step when not marked', async () => {
    const page = await open(`<button onclick="this.textContent='Done'">Go</button>`);
    const provider = new FakeProvider([click('Go', null), { tool: 'done', args: { summary: 'went', evidence: [] } }]);
    await new Ai({ page, provider, config }).act('Go');
    expect(provider.decisionRequests).toHaveLength(2);
  });

  it('are not stored in plans: replay does not care', () => {
    expect(planArgs({ ref: 'e1', intent: 'x', last: true, button: null }, {})).toEqual({ button: null });
  });
});
