// Custom providers (docs/05 §7.1): a local file, or a package installed in the project, named in aipw.config.ts.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { loadProvider } from '../src/llm/loader.js';

const MODULE = (id: string) => `export function createProvider(options) {
  return { id: '${id}', model: options.model, capabilities: {}, decide: async () => ({}), structured: async () => ({}) };
}\n`;

function project() {
  const root = mkdtempSync(join(tmpdir(), 'aipw-loader-'));
  mkdirSync(join(root, 'providers'));
  writeFileSync(join(root, 'providers', 'mine.mjs'), MODULE('mine'));
  const pkg = join(root, 'node_modules', 'acme-aipw-provider');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: 'acme-aipw-provider', type: 'module', exports: { '.': { import: './dist/index.js' } } }),
  );
  writeFileSync(join(pkg, 'dist', 'index.js'), MODULE('acme'));
  mkdirSync(join(root, 'e2e'));
  return root;
}

describe('loadProvider', () => {
  it('loads a local file relative to the project root, with its options', async () => {
    const root = project();
    const config = resolveConfig({
      provider: 'mine',
      providers: { mine: { package: './providers/mine.mjs', model: 'm1' } },
    });
    const provider = await loadProvider(config, {}, root);
    expect(provider).toMatchObject({ id: 'mine', model: 'm1' });
  });

  it('finds a package installed in the project, from a subfolder', async () => {
    const root = project();
    const config = resolveConfig({ provider: 'acme', providers: { acme: { package: 'acme-aipw-provider' } } });
    const provider = await loadProvider(config, { AIPW_MODEL: 'x' }, join(root, 'e2e'));
    expect(provider).toMatchObject({ id: 'acme', model: 'x' });
  });

  it('says how to install a missing package and how to add an unknown provider', async () => {
    const root = project();
    const missing = resolveConfig({ provider: 'gone', providers: { gone: { package: 'not-installed-aipw-xyz' } } });
    await expect(loadProvider(missing, {}, root)).rejects.toThrow('npm i -D not-installed-aipw-xyz');
    await expect(loadProvider(resolveConfig({ provider: 'gemini' }), {}, root)).rejects.toThrow(
      "providers: { 'gemini': { package: './providers/gemini.ts' } }",
    );
  });
});
