import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableStringify, type PlanFile, type StepPlan } from '@aipw/core';
import { describe, expect, it } from 'vitest';
import { acceptHealed } from '../src/cache.js';

const step = (instruction: string, display: string): StepPlan => ({
  kind: 'act',
  instruction,
  recordedWith: { provider: 'fake', model: 'fake', at: '2026-11-03T00:00:00Z' },
  actions: [
    {
      tool: 'click',
      args: {},
      target: { role: 'button', locators: [{ rung: 'L1', expr: [{ m: 'getByTestId', id: display }], display }] },
    },
  ],
  stats: { heals: 0 },
});
const file = (tests: PlanFile['tests']): PlanFile => ({ version: 1, tests });

describe('aipw cache accept', () => {
  it('merges healed steps into the committed plan next to the spec, then removes the healed file', () => {
    const root = mkdtempSync(join(tmpdir(), 'aipw-accept-'));
    const committed = join(root, 'tests', '__aipw__', 'users.spec.ts.plans.json');
    mkdirSync(join(root, 'tests', '__aipw__'), { recursive: true });
    writeFileSync(
      committed,
      stableStringify(file({ 'users > create': { a: step('Save', 'save'), b: step('Open users', 'nav-users') } })),
    );
    const healed = join(root, '.aipw', 'healed', 'tests', 'users.spec.ts.plans.json');
    mkdirSync(join(root, '.aipw', 'healed', 'tests'), { recursive: true });
    writeFileSync(healed, stableStringify(file({ 'users > create': { a: step('Save', 'save-user') } })));

    expect(acceptHealed(root, { dryRun: true })).toEqual(['tests/users.spec.ts: would accept 1 healed step']);
    expect(existsSync(healed)).toBe(true);

    expect(acceptHealed(root)).toEqual(['tests/users.spec.ts: accepted 1 healed step']);
    const merged = JSON.parse(readFileSync(committed, 'utf8')) as PlanFile;
    expect(merged.tests['users > create']!.a!.actions![0]!.target!.locators[0]!.display).toBe('save-user');
    expect(merged.tests['users > create']!.b!.instruction).toBe('Open users');
    expect(existsSync(healed)).toBe(false);
    expect(acceptHealed(root)).toEqual([]);
  });
});
