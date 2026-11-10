import { stableStringify, type PlanFile } from '@aipw/core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findPlanFiles,
  formatStats,
  planStats,
  prunePlans,
  runCacheCommand,
  showPlans,
  totalStats,
} from '../src/cache.js';

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

  it('lists steps in the order they appear in the spec', () => {
    const source = "await ai.assert('Saved');\nawait ai.act('Save');";
    const lines = showPlans(file, 'create', source).split('\n');
    expect(lines.findIndex((l) => l.includes('assert: Saved'))).toBeLessThan(
      lines.findIndex((l) => l.includes('act: Save')),
    );
  });

  it('prunes tests that no longer exist', () => {
    const { file: pruned, removed } = prunePlans(file, new Set(['users > create']));
    expect(removed).toEqual(['users > gone']);
    expect(Object.keys(pruned.tests)).toEqual(['users > create']);
  });

  it('keeps per-project plans (cache.byProject) of live tests', () => {
    const perProject = { ...file, tests: { 'mobile › users > create': file.tests['users > create']! } };
    expect(prunePlans(perProject, new Set(['users > create'])).removed).toEqual([]);
  });
});

describe('aipw cache, as typed', () => {
  afterEach(() => vi.restoreAllMocks());

  const project = () => {
    const root = mkdtempSync(join(tmpdir(), 'aipw-cli-'));
    mkdirSync(join(root, 'tests', '__aipw__'), { recursive: true });
    writeFileSync(join(root, 'tests', '__aipw__', 'users.spec.ts.plans.json'), stableStringify(file));
    writeFileSync(join(root, 'tests', 'users.spec.ts'), "ai.act('Save'); ai.assert('Saved');");
    writeFileSync(join(root, 'tests', 'new.spec.ts'), '');
    return root;
  };
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => void out.push(m));
    vi.spyOn(console, 'error').mockImplementation((m: string) => void err.push(m));
    return { out, err };
  };

  it('stats: one line per plan file with singular and plural nouns, and a total', () => {
    const root = project();
    const stats = planStats(findPlanFiles(root)[0]!, root);
    expect(formatStats(stats)).toBe(
      'tests/__aipw__/users.spec.ts.plans.json: 2 tests, 1 act, 1 assert; 2 heals; AI on replay: 1 assert, 0 extracts',
    );
    expect(formatStats(totalStats([stats, stats]))).toBe(
      'Total (2 plan files): 4 tests, 2 act, 2 assert; 4 heals; AI on replay: 2 asserts, 0 extracts',
    );
  });

  it('show and code resolve the spec from the project root and take --grep', () => {
    const root = project();
    const { out } = capture();
    expect(runCacheCommand(['show', 'tests/users.spec.ts', '--grep', 'create'], root)).toBe(0);
    expect(out[0]).toContain('users > create');
    expect(out[0]).not.toContain('users > gone');
    expect(runCacheCommand(['code', '--grep', 'create', 'tests/users.spec.ts'], root)).toBe(1); // the spec comes first
    expect(runCacheCommand(['code', 'tests/users.spec.ts'], root)).toBe(0);
    expect(out[1]).toContain("await page.getByTestId('save').click();");
  });

  it('says why there is nothing to show: no such spec, not recorded yet, or no title matches', () => {
    const root = project();
    const { err } = capture();
    expect(runCacheCommand(['show', 'tests/typo.spec.ts'], root)).toBe(1);
    expect(err.at(-1)).toContain('No such spec: tests/typo.spec.ts');
    expect(runCacheCommand(['show', 'tests/new.spec.ts'], root)).toBe(1);
    expect(err.at(-1)).toContain('No plans recorded for tests/new.spec.ts yet');
    expect(err.at(-1)).toContain('npx playwright test tests/new.spec.ts');
    expect(runCacheCommand(['show', 'tests/users.spec.ts', '--grep', 'delete'], root)).toBe(1);
    expect(err.at(-1)).toContain('No test title in tests/users.spec.ts contains "delete". Titles:\n  users > create');
    expect(runCacheCommand(['show', 'tests/users.spec.ts', '--grep'], root)).toBe(1);
    expect(err.at(-1)).toContain('Usage: aipw cache show');
  });
});
