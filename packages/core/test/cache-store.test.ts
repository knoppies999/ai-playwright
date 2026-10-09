import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrdinalCounter, stepKey } from '../src/cache/keys.js';
import { matchesUrlPattern, stableStringify, urlPattern, type StepPlan } from '../src/cache/plan.js';
import { FilePlanStore, planFilePath, readPlanFile } from '../src/cache/store.js';

const plan = (instruction: string, at = '2026-10-09T10:00:00Z'): StepPlan => ({
  kind: 'act',
  instruction,
  recordedWith: { provider: 'fake', model: 'fake', at },
  actions: [{ tool: 'click', args: { button: null }, target: { locators: [] } }],
  stats: { heals: 0 },
});

describe('stepKey', () => {
  const base = { kind: 'act', instruction: 'Open  Settings', dataKeys: ['b', 'a'], secretNames: [], ordinal: 0 };

  it('ignores whitespace, case and data key order', () => {
    expect(stepKey(base)).toBe(stepKey({ ...base, instruction: ' open settings ', dataKeys: ['a', 'b'] }));
  });

  it('changes with the instruction, data keys, scope and ordinal', () => {
    const k = stepKey(base);
    expect(stepKey({ ...base, instruction: 'Open Users' })).not.toBe(k);
    expect(stepKey({ ...base, dataKeys: ['a'] })).not.toBe(k);
    expect(stepKey({ ...base, scopeDescriptor: "getByRole('dialog')" })).not.toBe(k);
    expect(stepKey({ ...base, ordinal: 1 })).not.toBe(k);
  });

  it('a pinned key survives instruction edits', () => {
    expect(stepKey({ ...base, pinned: 'open-settings' })).toBe(
      stepKey({ ...base, instruction: 'Go to the settings page', pinned: 'open-settings' }),
    );
  });

  it('counts ordinals per instruction', () => {
    const c = new OrdinalCounter();
    expect([c.next('act', 'Save'), c.next('act', ' save'), c.next('act', 'Cancel'), c.next('assert', 'Save')]).toEqual([
      0, 1, 0, 0,
    ]);
  });
});

describe('plan files', () => {
  it('writes sorted, stable JSON', () => {
    expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe(
      '{\n  "a": {\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
  });

  it('stores plans next to the spec and keeps 3 healed versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipw-plans-'));
    const path = planFilePath(join(dir, 'users.spec.ts'));
    expect(path).toBe(join(dir, '__aipw__', 'users.spec.ts.plans.json'));

    const store = new FilePlanStore(path);
    await store.put('users > create', 'k1', plan('v1'));
    for (const v of ['v2', 'v3', 'v4', 'v5'])
      await store.put('users > create', 'k1', plan(v, `2026-10-1${v[1]}T00:00:00Z`), { healed: true });

    const saved = readPlanFile(path).tests['users > create']!.k1!;
    expect(saved.instruction).toBe('v5');
    expect(saved.history!.map((h) => h.instruction)).toEqual(['v4', 'v3', 'v2']);
    expect(saved.stats).toEqual({ heals: 4, lastHealAt: '2026-10-15T00:00:00Z' });

    // Same content → byte-identical file.
    const before = readFileSync(path, 'utf8');
    await store.put('users > create', 'k1', { ...saved, history: undefined });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('merges concurrent writers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipw-plans-'));
    const path = planFilePath(join(dir, 'a.spec.ts'));
    const a = new FilePlanStore(path);
    const b = new FilePlanStore(path);
    await Promise.all([a.put('t1', 'k', plan('one')), b.put('t2', 'k', plan('two'))]);
    expect(Object.keys(readPlanFile(path).tests).sort()).toEqual(['t1', 't2']);
  });
});

describe('urlPattern', () => {
  it('replaces ids in the path', () => {
    expect(urlPattern('https://app.test/users/1234/edit?tab=2')).toBe('https://app.test/users/*/edit');
    expect(matchesUrlPattern('https://app.test/users/99/edit', 'https://app.test/users/*/edit')).toBe(true);
    expect(urlPattern('https://www.saucedemo.com/inventory.html')).toBe('https://www.saucedemo.com/inventory.html');
  });
});
