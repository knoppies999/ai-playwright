import { describe, expect, it } from 'vitest';
import { PlanFileSchema } from '../src/cache/plan.js';
import { planArgs, planFromAct } from '../src/cache/record.js';
import type { ActionRecord } from '../src/types.js';

const rec = (over: Partial<ActionRecord>): ActionRecord => ({
  tool: 'click',
  args: {},
  result: 'ok',
  before: { url: 'https://app.test/users/12', snapshotHash: 'a' },
  after: { url: 'https://app.test/users/12' },
  durationMs: 5,
  ...over,
});

const target = {
  ref: 'e5',
  role: 'button',
  name: 'Save',
  candidates: [
    { rung: 'L1' as const, expr: [{ m: 'getByTestId' as const, id: 'save' }], display: "getByTestId('save')" },
  ],
};

describe('planArgs', () => {
  it('drops refs and intents, and turns data values back into placeholders', () => {
    const data = { firstName: 'Thandi', zip: 2196, other: 'Thandi' };
    expect(
      planArgs(
        {
          ref: 'e1',
          value: 'Thandi',
          intent: 'x',
          fields: [
            { ref: 'e2', value: '2196' },
            { ref: 'e3', value: '{{secret.password}}' },
          ],
          values: ['Thandi', 'Blue'],
        },
        data,
      ),
    ).toEqual({
      value: '{{data.firstName}}', // 'firstName' sorts before 'other'
      fields: [{ value: '{{data.zip}}' }, { value: '{{secret.password}}' }],
      values: ['{{data.firstName}}', 'Blue'],
    });
  });
});

describe('planFromAct', () => {
  it('keeps successful page actions only, with durable targets and URL patterns', () => {
    const plan = planFromAct(
      'Save the user',
      [
        rec({ tool: 'click', args: { ref: 'e9', button: null, intent: 'try' }, result: 'Error: timeout' }),
        rec({ tool: 'expand', args: { ref: 'e3' } }),
        rec({ tool: 'click', args: { ref: 'e5', button: null, intent: 'save' }, intent: 'save', target }),
      ],
      {},
      {
        provider: 'claude-code',
        model: 'claude-sonnet-5-5',
        now: new Date('2026-10-09T18:00:00Z'),
        startUrl: 'https://app.test/users/12',
        endUrl: 'https://app.test/users',
      },
    );
    expect(plan).toEqual({
      kind: 'act',
      instruction: 'Save the user',
      recordedWith: { provider: 'claude-code', model: 'claude-sonnet-5-5', at: '2026-10-09T18:00:00.000Z' },
      pre: { urlPattern: 'https://app.test/users/*' },
      post: { urlPattern: 'https://app.test/users' },
      actions: [
        {
          tool: 'click',
          args: { button: null },
          intent: 'save',
          target: { role: 'button', name: 'Save', locators: target.candidates },
        },
      ],
      stats: { heals: 0 },
    });
    expect(JSON.stringify(plan)).not.toContain('e5');
    expect(PlanFileSchema.safeParse({ version: 1, tests: { t: { k: plan } } }).success).toBe(true);
  });
});
