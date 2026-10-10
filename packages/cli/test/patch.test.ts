import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentHash, lineDiff, patchFile, patchSource } from '../src/patch.js';

const SPEC = `import { test } from '@aipw/test';

test('admin can create a user', async ({ page, ai }) => {
  await ai.act('Open Settings > Users');
  await ai.act("Click \\"Add user\\" and fill in the form", { data: { firstName: 'Thandi' } });
  if (true) {
    await ai.act('Open Settings > Users');
  }
});
`;

describe('patchSource', () => {
  it('replaces only the instruction literal, keeping the quote style', () => {
    const r = patchSource(
      SPEC,
      { instruction: 'Open Settings > Users', line: 4 },
      { kind: 'instruction', text: 'Hover "Settings" in the header, then click "Users"' },
    );
    expect(r.ok && lineDiff(SPEC, r.source)).toBe(
      '-   await ai.act(\'Open Settings > Users\');\n+   await ai.act(\'Hover "Settings" in the header, then click "Users"\');',
    );
  });

  it('picks the call closest to the recorded line when the instruction repeats', () => {
    const r = patchSource(
      SPEC,
      { instruction: 'Open Settings > Users', line: 7 },
      { kind: 'instruction', text: "It's the gear" },
    );
    expect(r.ok && r.source).toContain("    await ai.act('It\\'s the gear');");
    expect(r.ok && r.source).toContain("  await ai.act('Open Settings > Users');");
  });

  it('handles double-quoted instructions with escapes', () => {
    const r = patchSource(
      SPEC,
      { instruction: 'Click "Add user" and fill in the form', line: 5 },
      { kind: 'instruction', text: 'Click "New user"' },
    );
    expect(r.ok && r.source).toContain('await ai.act("Click \\"New user\\"", { data: { firstName: \'Thandi\' } });');
  });

  it('replaces the statement with code, keeping indentation', () => {
    const r = patchSource(
      SPEC,
      { instruction: 'Open Settings > Users', line: 7 },
      {
        kind: 'code',
        lines: [
          "await page.getByRole('button', { name: 'Settings' }).hover();",
          "await page.getByRole('menuitem', { name: 'Users' }).click();",
        ],
      },
    );
    expect(r.ok && r.source).toContain(
      "  if (true) {\n    await page.getByRole('button', { name: 'Settings' }).hover();\n    await page.getByRole('menuitem', { name: 'Users' }).click();\n  }",
    );
  });

  it('splits a step into several, reusing the call and its options', () => {
    const r = patchSource(
      SPEC,
      { instruction: 'Click "Add user" and fill in the form', line: 5 },
      { kind: 'split', instructions: ['Click "Add user"', 'Fill in the form'] },
    );
    expect(r.ok && r.source).toContain(
      '  await ai.act("Click \\"Add user\\"", { data: { firstName: \'Thandi\' } });\n  await ai.act("Fill in the form", { data: { firstName: \'Thandi\' } });',
    );
  });

  it('explains when it cannot find the call', () => {
    expect(patchSource(SPEC, { instruction: 'Nope', line: 4 }, { kind: 'instruction', text: 'x' })).toMatchObject({
      ok: false,
    });
  });
});

describe('patchFile', () => {
  it('refuses when the file changed since the session started', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'aipw-patch-')), 'a.spec.ts');
    writeFileSync(file, SPEC);
    const hash = contentHash(SPEC);
    writeFileSync(file, `${SPEC}// edited\n`);
    expect(
      patchFile(file, hash, { instruction: 'Open Settings > Users', line: 4 }, { kind: 'instruction', text: 'x' }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('changed') });
    writeFileSync(file, SPEC);
    expect(
      patchFile(file, hash, { instruction: 'Open Settings > Users', line: 4 }, { kind: 'instruction', text: 'x' }),
    ).toMatchObject({ ok: true });
    expect(readFileSync(file, 'utf8')).toContain("await ai.act('x');");
  });
});
