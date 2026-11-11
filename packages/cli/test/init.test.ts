import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { init, parseInitArgs } from '../src/init.js';

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

  it('a new .gitignore also ignores node_modules, reports and .env; an existing one only gains .aipw/', () => {
    const root = fresh();
    init(root);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(
      'node_modules/\ntest-results/\nplaywright-report/\n.env\n# aipw run summaries and healed plans\n.aipw/\n',
    );
    const existing = fresh();
    writeFileSync(join(existing, '.gitignore'), 'dist');
    init(existing);
    expect(readFileSync(join(existing, '.gitignore'), 'utf8')).toBe(
      'dist\n# aipw run summaries and healed plans\n.aipw/\n',
    );
    // ".aipw" and "/.aipw/" already ignore the folder.
    const spelled = fresh();
    writeFileSync(join(spelled, '.gitignore'), '/.aipw\n');
    init(spelled);
    expect(readFileSync(join(spelled, '.gitignore'), 'utf8')).toBe('/.aipw\n');
  });

  it('parses arguments strictly: a mistyped flag is an error, not the default provider', () => {
    expect(parseInitArgs(['--provider', 'openai', '--dir', 'e2e', '--force'])).toEqual({
      provider: 'openai',
      dir: 'e2e',
      force: true,
    });
    expect(parseInitArgs([])).toEqual({ force: false });
    expect(parseInitArgs(['--provder', 'openai'])).toEqual({
      error: expect.stringContaining('Unknown argument --provder'),
    });
    expect(parseInitArgs(['--provider'])).toEqual({ error: expect.stringContaining('--provider needs a value') });
    expect(parseInitArgs(['--dir', '--force'])).toEqual({ error: expect.stringContaining('--dir needs a value') });
  });

  it('rejects an unknown provider', () => {
    expect(init(fresh(), { provider: 'gpt' })).toEqual({ error: expect.stringContaining('Unknown provider "gpt"') });
  });
});
