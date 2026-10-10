import type { PauseState, VerifyJob } from '@aipw/core';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRemedies, formatRemedies, parseChoices, stepShift, verifyRemedies } from '../src/apply.js';
import { contentHash } from '../src/patch.js';

const remedies = {
  diagnosis: 'Users is only in the Settings flyout.',
  category: 'hidden-in-menu',
  pageUrl: 'http://localhost:5173/app',
  options: [
    {
      kind: 'hint' as const,
      label: 'Site hint (site)',
      hint: { scope: 'site' as const, pathPattern: null, text: 'Users is in the Settings flyout; hover it.' },
    },
    { kind: 'instruction' as const, label: 'Revised instruction', text: 'Hover "Settings", then click "Users"' },
    { kind: 'code' as const, label: 'Code', lines: ["await page.getByRole('button', { name: 'Settings' }).hover();"] },
  ],
};

const state: PauseState = {
  v: 1,
  reason: 'remedies',
  breakLevel: 'step',
  test: { file: 'a.spec.ts', title: 't' },
  step: { index: 3, id: 'ai:3', kind: 'act', instruction: 'Open Settings > Users', cached: false },
  history: [],
  remedies: {
    ...remedies,
    basis: {
      startUrl: 'http://localhost:5173/app',
      finalUrl: 'http://localhost:5173/users',
      finalTargets: [],
      input: {},
    },
  },
};

describe('nudge remedies in the driver', () => {
  it('parses choices; a = all except candidates that failed verification', () => {
    expect(parseChoices('1,3', remedies.options)).toEqual([0, 2]);
    expect(parseChoices('a', remedies.options)).toEqual([0, 1, 2]);
    expect(parseChoices('a', [remedies.options[0]!, { ...remedies.options[1]!, verified: false }])).toEqual([0]);
    expect(parseChoices('', remedies.options)).toEqual([]);
    expect(parseChoices('4', remedies.options)).toBeUndefined();
  });

  it('shows the diagnosis, every option and its verification', () => {
    const text = formatRemedies({
      ...remedies,
      options: [
        { ...remedies.options[0]!, verified: true },
        { ...remedies.options[1]!, verified: false, verifyNote: 'The AI clicked "User groups".\nmore' },
        remedies.options[2]!,
      ],
    });
    expect(text).toContain('Remedy — hidden-in-menu');
    expect(text).toContain('  1 ✅ Site hint (site)');
    expect(text).toContain('  2 ❌ Revised instruction');
    expect(text).toContain('       ✗ The AI clicked "User groups".');
    expect(text).toContain("  3 ●  Code\n       + await page.getByRole('button', { name: 'Settings' }).hover();");
  });

  it('verifies text candidates, with one feedback round, and leaves code alone', async () => {
    const jobs: VerifyJob[] = [];
    const verified = await verifyRemedies(state, async (job) => {
      jobs.push(job);
      if (job.option.kind === 'hint') return { ok: true, reason: 'reached the same page', option: job.option };
      if (!job.feedback) return { ok: false, reason: 'clicked User groups', option: job.option };
      return { ok: true, reason: 'reached the same final target', option: { ...job.option, text: 'Hover the gear' } };
    });
    expect(jobs.map((j) => [j.option.kind, j.step, j.feedback])).toEqual([
      ['hint', 3, undefined],
      ['instruction', 3, undefined],
      ['instruction', 3, 'clicked User groups'],
    ]);
    expect(verified.options.map((o) => [o.kind, o.verified])).toEqual([
      ['hint', true],
      ['instruction', true],
      ['code', undefined],
    ]);
    expect(verified.options[1]!.text).toBe('Hover the gear');
  });

  it('marks a candidate unverified after two failed rounds or a run that never reported', async () => {
    const verified = await verifyRemedies(state, async (job) =>
      job.option.kind === 'hint'
        ? undefined
        : { ok: false, reason: `no (${job.feedback ?? 'round 1'})`, option: job.option },
    );
    expect(verified.options[0]).toMatchObject({
      verified: false,
      verifyNote: 'The run ended before reaching the step.',
    });
    expect(verified.options[1]).toMatchObject({ verified: false, verifyNote: 'no (no (round 1))' });
  });

  it('writes the hint and patches the spec once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipw-apply-'));
    const spec = join(dir, 'a.spec.ts');
    const source = "test('t', async ({ ai }) => {\n  await ai.act('Open Settings > Users');\n});\n";
    writeFileSync(spec, source);
    const { report, patched } = applyRemedies(remedies, [0, 1, 2], {
      specPath: spec,
      specHash: contentHash(source),
      instruction: 'Open Settings > Users',
      line: 2,
      hintsDir: join(dir, 'hints'),
    });
    expect(report[0]).toMatch(/Hint added to .*localhost-5173\.md/);
    expect(report[1]).toContain('Patched');
    expect(report[2]).toContain('already patched');
    expect(patched).toEqual({ kind: 'instruction', text: 'Hover "Settings", then click "Users"' });
    expect(readFileSync(spec, 'utf8')).toContain('await ai.act(\'Hover "Settings", then click "Users"\');');
    expect(readFileSync(join(dir, 'hints', 'localhost-5173.md'), 'utf8')).toContain(
      '- Users is in the Settings flyout; hover it.',
    );
  });

  it('knows how a patch moves the AI step numbers after it', () => {
    expect(stepShift(undefined)).toBe(0);
    expect(stepShift({ kind: 'instruction', text: 'x' })).toBe(0);
    expect(stepShift({ kind: 'split', instructions: ['a', 'b', 'c'] })).toBe(2);
    expect(stepShift({ kind: 'code', lines: ['x'] })).toBe(-1);
  });
});
