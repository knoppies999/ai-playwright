// Loads the configured provider by package name (docs/05 §7), so unused SDKs are never imported.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AipwConfig } from '../config.js';
import type { LlmProvider, ProviderFactory } from './provider.js';

/** Built-in entries; `providers` in the config overrides or adds to these. */
export const DEFAULT_PROVIDERS: Record<string, { package: string; model?: string; preset?: string }> = {
  'claude-code': { package: '@aipw/provider-claude-code', model: 'claude-sonnet-5-5' },
  anthropic: { package: '@aipw/provider-anthropic', model: 'claude-opus-5-5' },
  openai: { package: '@aipw/provider-openai', preset: 'openai' },
  foundry: { package: '@aipw/provider-openai', preset: 'foundry' },
  'github-models': { package: '@aipw/provider-openai', preset: 'github-models' },
  ollama: { package: '@aipw/provider-openai', preset: 'ollama' },
  copilot: { package: '@aipw/provider-copilot' },
};

type ProviderModule = { createProvider?: ProviderFactory };

const isPath = (spec: string) => spec.startsWith('.') || isAbsolute(spec);

/** The ESM entry of `name` installed in `dir/node_modules`, from its `exports` or `main`. */
function entryIn(dir: string, name: string): string | undefined {
  const root = join(dir, 'node_modules', name);
  const manifest = join(root, 'package.json');
  if (!existsSync(manifest)) return undefined;
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
    exports?: string | Record<string, unknown>;
    main?: string;
  };
  let target: unknown = pkg.exports;
  if (target && typeof target === 'object' && '.' in target) target = target['.'];
  if (target && typeof target === 'object') {
    const t = target as Record<string, unknown>;
    target = t.import ?? t.default ?? t.node;
    if (target && typeof target === 'object') target = (target as Record<string, unknown>).default;
  }
  const file = typeof target === 'string' ? target : (pkg.main ?? 'index.js');
  return join(root, file);
}

/**
 * Imports a provider module. Paths (`./providers/gemini.ts`) are relative to the project root (`from`). Package
 * names are imported normally first; when that fails (the package is installed in the project but not visible from
 * here, e.g. under pnpm's strict layout or a linked aipw), they are looked up in node_modules from `from` upwards.
 */
export async function importProviderModule(spec: string, from = process.cwd()): Promise<ProviderModule> {
  if (isPath(spec)) return (await import(pathToFileURL(resolve(from, spec)).href)) as ProviderModule;
  try {
    return (await import(spec)) as ProviderModule;
  } catch (error) {
    for (let dir = resolve(from); ; dir = dirname(dir)) {
      const file = entryIn(dir, spec);
      if (file && existsSync(file)) return (await import(pathToFileURL(file).href)) as ProviderModule;
      if (dirname(dir) === dir) throw error;
    }
  }
}

export async function loadProvider(
  config: AipwConfig,
  env: NodeJS.ProcessEnv = process.env,
  from = process.cwd(),
): Promise<LlmProvider> {
  const key = env.AIPW_PROVIDER ?? config.provider;
  const entry = { ...DEFAULT_PROVIDERS[key], ...config.providers[key] };
  if (!entry.package) {
    throw new Error(
      `Unknown aipw provider "${key}". Add it under "providers" in aipw.config.ts, e.g. ` +
        `providers: { '${key}': { package: './providers/${key}.ts' } }. Built in: ${Object.keys(DEFAULT_PROVIDERS).join(', ')}.`,
    );
  }
  let mod: ProviderModule;
  try {
    mod = await importProviderModule(entry.package, from);
  } catch (error) {
    const hint = isPath(entry.package)
      ? `Paths are relative to ${from}.`
      : `Is it installed? npm i -D ${entry.package}`;
    throw new Error(`Could not load provider ${entry.package} for "${key}". ${hint}`, { cause: error });
  }
  if (typeof mod.createProvider !== 'function') throw new Error(`${entry.package} does not export createProvider()`);
  return mod.createProvider({ ...entry, model: env.AIPW_MODEL ?? entry.model });
}
