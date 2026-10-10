import { stableStringify, type PlanFile } from '@aipw/core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findPlanFiles, planStats, prunePlans, showPlans } from '../src/cache.js';

const file: PlanFile = {
  version: 1,
  tests: {
    'users > create': {
      k1: {
        kind: 'act',
        instruction: 'Save',
        recordedWith: { provider: 'fake', model: 'fake', at: '2026-10-09T00:00:00Z' },
        actions: [
          {
            tool: 'click',
            args: {},
            target: {
              role: 'button',
              name: 'Save',
              locators: [{ rung: 'L1', expr: [{ m: 'getByTestId', id: 'save' }], display: "getByTestId('save')" }],
            },
          },
        ],
        stats: { heals: 2, lastHealAt: '2026-10-10T00:00:00Z' },
      },
      k2: {
        kind: 'assert',
        instruction: 'Saved',
        recordedWith: { provider: 'fake', model: 'fake', at: '2026-10-09T00:00:00Z' },
        compiled: null,
        stats: { heals: 0 },
      },
    },
    'users > gone': {},
  },
};

describe('aipw cache', () => {
  it('finds plan files and summarises them', () => {
    const root = mkdtempSync(join(tmpdir(), 'aipw-cli-'));
    mkdirSync(join(root, 'tests', '__aipw__'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x', '__aipw__'), { recursive: true });
    writeFileSync(join(root, 'tests', '__aipw__', 'users.spec.ts.plans.json'), stableStringify(file));
    writeFileSync(join(root, 'node_modules', 'x', '__aipw__', 'y.plans.json'), stableStringify(file));
    const files = findPlanFiles(root);
    expect(files).toHaveLength(1);
    expect(planStats(files[0]!, root)).toMatchObject({
      tests: 2,
      steps: { act: 1, assert: 1 },
      heals: 2,
      aiOnlyAsserts: 1,
    });
  });

  it('shows plans readably', () => {
    expect(showPlans(file, 'create')).toBe(
      [
        'users > create',
        '  act: Save',
        `    click button "Save" → getByTestId('save')`,
        '    healed 2× (last 2026-10-10T00:00:00Z)',
        '  assert: Saved',
        '    check: none (judged by AI on every run)',
      ].join('\n'),
    );
  });

  it('prunes tests that no longer exist', () => {
    const { file: pruned, removed } = prunePlans(file, new Set(['users > create']));
    expect(removed).toEqual(['users > gone']);
    expect(Object.keys(pruned.tests)).toEqual(['users > create']);
  });
});
