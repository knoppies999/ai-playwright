import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRemedies, formatRemedies, parseChoices } from '../src/apply.js';
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

describe('nudge remedies in the driver', () => {
  it('parses choices', () => {
    expect(parseChoices('1,3', 3)).toEqual([0, 2]);
    expect(parseChoices('a', 3)).toEqual([0, 1, 2]);
    expect(parseChoices('', 3)).toEqual([]);
    expect(parseChoices('4', 3)).toBeUndefined();
  });

  it('shows the diagnosis and every option', () => {
    const text = formatRemedies(remedies);
    expect(text).toContain('Remedy — hidden-in-menu');
    expect(text).toContain('  2  Revised instruction');
    expect(text).toContain("       + await page.getByRole('button', { name: 'Settings' }).hover();");
  });

  it('writes the hint and patches the spec once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipw-apply-'));
    const spec = join(dir, 'a.spec.ts');
    const source = "test('t', async ({ ai }) => {\n  await ai.act('Open Settings > Users');\n});\n";
    writeFileSync(spec, source);
    const report = applyRemedies(remedies, [0, 1, 2], {
      specPath: spec,
      specHash: contentHash(source),
      instruction: 'Open Settings > Users',
      line: 2,
      hintsDir: join(dir, 'hints'),
    });
    expect(report[0]).toMatch(/Hint added to .*localhost-5173\.md/);
    expect(report[1]).toContain('Patched');
    expect(report[2]).toContain('already patched');
    expect(readFileSync(spec, 'utf8')).toContain('await ai.act(\'Hover "Settings", then click "Users"\');');
    expect(readFileSync(join(dir, 'hints', 'localhost-5173.md'), 'utf8')).toContain(
      '- Users is in the Settings flyout; hover it.',
    );
  });
});
