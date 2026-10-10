// Loads the configured provider by package name (docs/05 §7), so unused SDKs are never imported.
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

export async function loadProvider(config: AipwConfig, env: NodeJS.ProcessEnv = process.env): Promise<LlmProvider> {
  const key = env.AIPW_PROVIDER ?? config.provider;
  const entry = { ...DEFAULT_PROVIDERS[key], ...config.providers[key] };
  if (!entry.package) {
    throw new Error(`Unknown aipw provider "${key}". Add it under "providers" in aipw.config.ts.`);
  }
  let mod: { createProvider?: ProviderFactory };
  try {
    mod = (await import(entry.package)) as { createProvider?: ProviderFactory };
  } catch (error) {
    throw new Error(`Could not load provider package ${entry.package} for "${key}". Is it installed?`, {
      cause: error,
    });
  }
  if (typeof mod.createProvider !== 'function') throw new Error(`${entry.package} does not export createProvider()`);
  return mod.createProvider({ ...entry, model: env.AIPW_MODEL ?? entry.model });
}
