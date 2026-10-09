import { describe, expect, it } from 'vitest';
import { toolSpecs, actTools } from '../src/actions/schemas.js';
import { buildContext, buildObservation, SYSTEM_PROMPTS } from '../src/loop/prompt.js';
import type { Observation } from '../src/observe/observer.js';
import { parseSnapshot, pruneSnapshot } from '../src/observe/snapshot.js';
import type { ActionRecord, StepContext } from '../src/types.js';
import { expectGolden, fixture } from './golden.js';

const tree = parseSnapshot(fixture('snapshots', 'saucedemo-checkout-info.yaml'));
const pruned = pruneSnapshot(tree);
const obs: Observation = {
  url: 'https://www.saucedemo.com/checkout-step-one.html',
  title: 'Swag Labs',
  tabs: [
    { index: 0, url: 'https://www.saucedemo.com/checkout-step-one.html', title: 'Swag Labs', active: true },
    { index: 1, url: 'https://saucelabs.com/', title: 'Sauce Labs', active: false },
  ],
  dialogs: [],
  notices: ['Error: First Name is required'],
  snapshot: pruned.text,
  snapshotHash: 'x',
  refs: new Set(pruned.refs),
  truncated: false,
  tree,
};

const step: StepContext = {
  id: 't:1',
  kind: 'act',
  instruction: 'Fill in the checkout form and continue',
  options: { data: { firstName: 'Thandi', lastName: 'Mokoena', postalCode: '2196' } },
};

const record = (over: Partial<ActionRecord>): ActionRecord => ({
  tool: 'click',
  args: {},
  result: 'ok',
  before: { url: obs.url, snapshotHash: 'a' },
  after: { url: obs.url },
  durationMs: 10,
  ...over,
});

describe('prompt builder', () => {
  it('builds the act context (golden)', () => {
    const history = [
      record({
        tool: 'click',
        args: { ref: 'e30', button: null, modifiers: null, clickCount: null, intent: 'try to continue' },
        intent: 'try to continue',
        target: { ref: 'e30', role: 'button', name: 'Continue', candidates: [] },
      }),
      record({
        tool: 'fill',
        args: { ref: 'e22', value: '{{data.firstName}}', intent: 'first name' },
        intent: 'first name',
        target: { ref: 'e22', role: 'textbox', name: 'First Name', candidates: [] },
        result: 'Error: locator.fill: Timeout 5000ms exceeded.',
      }),
    ];
    const context = buildContext({
      step,
      hints: ['Postal codes are 4 digits'],
      secretPlaceholders: ['{{secret.password}}'],
      history,
    });
    expectGolden('prompt-act-context.txt', context);
  });

  it('builds the observation (golden)', () => {
    expectGolden('prompt-act-observation.txt', buildObservation(obs, { lastResult: 'ok' }));
  });

  it('keeps the system prompts and tool list stable', () => {
    expectGolden('prompt-system-act.txt', SYSTEM_PROMPTS.act);
    expectGolden(
      'tools-act.json',
      JSON.stringify(
        toolSpecs(actTools({ allowNavigation: false })).map(({ schema: _s, ...t }) => t),
        null,
        2,
      ),
    );
  });

  it('starts with no history', () => {
    expect(buildContext({ step, hints: [], secretPlaceholders: [], history: [] })).toContain('HISTORY: no actions yet');
  });
});
