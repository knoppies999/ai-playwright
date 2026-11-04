import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { init } from '../src/init.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'aipw-init-'));

describe('aipw init', () => {
  it('sets up an empty ESM project', () => {
    const root = fresh();
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const res = init(root);
    expect(res).toMatchObject({
      written: [
        'aipw.config.ts',
        join('tests', 'aipw-example.spec.ts'),
        join('.github', 'instructions', 'aipw-tests.instructions.md'),
        'playwright.config.ts',
        '.gitignore',
      ],
      skipped: [],
    });
    expect(readFileSync(join(root, 'aipw.config.ts'), 'utf8')).toContain("provider: 'claude-code'");
    expect(readFileSync(join(root, 'playwright.config.ts'), 'utf8')).toContain('withAipw(');
    expect(readFileSync(join(root, 'tests', 'aipw-example.spec.ts'), 'utf8')).toContain(
      'npx playwright test tests/aipw-example.spec.ts',
    );
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.aipw/');
  });

  it('writes aipw.config.mts in a CommonJS project, so Node loads it as ESM', () => {
    const root = fresh();
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
    const res = init(root);
    if ('error' in res) throw new Error(res.error);
    expect(res.written[0]).toBe('aipw.config.mts');
    expect(readFileSync(join(root, 'aipw.config.mts'), 'utf8')).toContain("from 'aipw'");
  });

  it('leaves existing files alone and explains how to change a Playwright config', () => {
    const root = fresh();
    writeFileSync(join(root, 'playwright.config.ts'), 'export default {};\n');
    writeFileSync(join(root, 'aipw.config.ts'), '// mine\n');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.aipw/\n');
    const res = init(root, { provider: 'foundry', dir: 'e2e' });
    if ('error' in res) throw new Error(res.error);
    expect(res.skipped).toEqual(['aipw.config.ts']);
    expect(res.written).toEqual([
      join('e2e', 'aipw-example.spec.ts'),
      join('.github', 'instructions', 'aipw-tests.instructions.md'),
    ]);
    expect(readFileSync(join(root, '.github', 'instructions', 'aipw-tests.instructions.md'), 'utf8')).toContain(
      "applyTo: 'e2e/**/*.spec.ts'",
    );
    expect(res.messages[0]).toMatch(/playwright\.config\.ts exists[\s\S]*withAipw/);
    expect(readFileSync(join(root, 'aipw.config.ts'), 'utf8')).toBe('// mine\n');
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\n.aipw/\n');
  });

  it('rejects an unknown provider', () => {
    expect(init(fresh(), { provider: 'gpt' })).toEqual({ error: expect.stringContaining('Unknown provider "gpt"') });
  });
});
