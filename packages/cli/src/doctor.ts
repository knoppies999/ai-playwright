// `aipw doctor [--provider x] [--probe]` (docs/09 §4): checks the config, the selected provider's package and
// credentials, and the secret variables, without calling the model. --probe makes one decide() and one structured()
// call with the contract fixture and reports what the endpoint supports (it spends a request).
import {
  contractDecisionRequest,
  contractStructuredRequest,
  DEFAULT_PROVIDERS,
  loadProvider,
  resolveConfig,
  type AipwConfig,
  type AipwConfigInput,
} from '@aipw/core';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Check {
  status: 'ok' | 'warn' | 'fail';
  label: string;
  detail: string;
}

const ok = (label: string, detail: string): Check => ({ status: 'ok', label, detail });
const warn = (label: string, detail: string): Check => ({ status: 'warn', label, detail });
const fail = (label: string, detail: string): Check => ({ status: 'fail', label, detail });

/**
 * Can the package be imported? ESM resolution: the aipw packages export only an "import" condition, so a CommonJS
 * require.resolve would wrongly say they are missing. Tries the project first, then the CLI's own location.
 */
export function canResolve(pkg: string, from = process.cwd()): boolean {
  for (const parent of [pathToFileURL(join(from, 'noop.js')).href, import.meta.url]) {
    try {
      import.meta.resolve(pkg, parent);
      return true;
    } catch {
      // try the next location
    }
  }
  return false;
}

/** The checks that need no network. */
export function doctorChecks(
  config: AipwConfig,
  env: NodeJS.ProcessEnv,
  options: { provider?: string; resolvable?: (pkg: string) => boolean } = {},
): Check[] {
  const resolvable = options.resolvable ?? ((p: string) => canResolve(p));
  const key = options.provider ?? env.AIPW_PROVIDER ?? config.provider;
  const entry = { ...DEFAULT_PROVIDERS[key], ...config.providers[key] } as {
    package?: string;
    preset?: string;
    model?: string;
    resource?: string;
    auth?: string;
  };
  const checks: Check[] = [];
  if (!entry.package) return [fail('provider', `"${key}" is not a known provider; add it under "providers"`)];
  checks.push(
    resolvable(entry.package)
      ? ok('provider', `${key} → ${entry.package}${entry.model ? ` (${env.AIPW_MODEL ?? entry.model})` : ''}`)
      : fail('provider', `${entry.package} is not installed`),
  );
  const need = (name: string, why: string) => checks.push(env[name] ? ok(name, 'set') : fail(name, `not set: ${why}`));
  switch (entry.package === '@aipw/provider-openai' ? (entry.preset ?? 'openai') : key) {
    case 'claude-code':
      checks.push(
        env.ANTHROPIC_API_KEY
          ? warn('ANTHROPIC_API_KEY', 'set: the Agent SDK bills this key instead of your Claude subscription. Unset it')
          : ok(
              'subscription',
              'claude-code uses the signed-in Claude Code (run `claude auth login` once if calls fail)',
            ),
      );
      break;
    case 'anthropic':
      need('ANTHROPIC_API_KEY', 'the anthropic provider needs an API key (or use claude-code)');
      break;
    case 'foundry': {
      if (!entry.resource) need('AZURE_FOUNDRY_RESOURCE', 'the Foundry resource name');
      if (!entry.model && !env.AIPW_MODEL) need('AIPW_FOUNDRY_DEPLOYMENT', 'the model deployment name');
      const keyless = entry.auth === 'entra' || (!env.AZURE_FOUNDRY_API_KEY && entry.auth !== 'apiKey');
      checks.push(
        !keyless
          ? ok('auth', 'API key (AZURE_FOUNDRY_API_KEY)')
          : resolvable('@azure/identity')
            ? ok('auth', 'keyless (DefaultAzureCredential: az login locally, AzureCLI@2 in pipelines)')
            : fail('auth', 'keyless needs @azure/identity (npm i -D @azure/identity), or set AZURE_FOUNDRY_API_KEY'),
      );
      break;
    }
    case 'openai':
      need('OPENAI_API_KEY', 'OpenAI API key');
      break;
    case 'github-models':
      need('GITHUB_TOKEN', 'a PAT with the models scope');
      break;
    case 'copilot':
      checks.push(
        resolvable('@github/copilot-sdk')
          ? ok('copilot', '@github/copilot-sdk installed; uses the signed-in Copilot CLI user (or GITHUB_TOKEN)')
          : fail('copilot', '@github/copilot-sdk is not installed (npm i -D @github/copilot-sdk)'),
      );
      break;
  }
  for (const [name, variable] of Object.entries(config.secrets.map))
    checks.push(
      env[variable] ? ok(`secret ${name}`, `${variable} set`) : warn(`secret ${name}`, `${variable} not set`),
    );
  checks.push(
    existsSync(resolve(config.hints.dir))
      ? ok('hints', `${config.hints.dir}/ found (run aipw hints lint)`)
      : ok('hints', `no ${config.hints.dir}/ folder (optional)`),
  );
  const b = config.budget;
  checks.push(
    b.perStepUsd || b.perRunUsd || b.perRunRequests
      ? ok('budget', JSON.stringify(b))
      : warn('budget', 'no budget limits set (config.budget)'),
  );
  return checks;
}

/** aipw.config.{ts,mjs,js}, walking up from `from`. */
export async function loadConfigFile(from = process.cwd()): Promise<{ file?: string; config: AipwConfigInput }> {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    for (const name of ['aipw.config.ts', 'aipw.config.mjs', 'aipw.config.js']) {
      const file = join(dir, name);
      if (existsSync(file)) {
        const mod = (await import(pathToFileURL(file).href)) as { default?: AipwConfigInput };
        return { file, config: mod.default ?? {} };
      }
    }
    if (dirname(dir) === dir) return { config: {} };
  }
}

/** One live decide() and structured() with the contract fixture. */
async function probe(config: AipwConfig, env: NodeJS.ProcessEnv): Promise<Check[]> {
  const checks: Check[] = [];
  const provider = await loadProvider(config, env);
  const decisionReq = contractDecisionRequest();
  const started = Date.now();
  try {
    const res = await provider.decide(decisionReq);
    const offered = decisionReq.tools.map((t) => t.name);
    checks.push(
      res.call && offered.includes(res.call.tool)
        ? ok(
            'tool calling',
            `${res.call.tool}(${JSON.stringify(res.call.args).slice(0, 80)}) in ${Date.now() - started} ms`,
          )
        : warn(
            'tool calling',
            `no valid tool call (stop: ${res.stop}${res.text ? `, said: ${res.text.slice(0, 80)}` : ''})`,
          ),
    );
  } catch (error) {
    checks.push(fail('tool calling', error instanceof Error ? error.message : String(error)));
  }
  try {
    const req = contractStructuredRequest();
    const res = await provider.structured(req);
    checks.push(
      req.schema.safeParse(res.value).success
        ? ok('structured output', JSON.stringify(res.value))
        : warn('structured output', `did not match the schema: ${String(res.text).slice(0, 120)}`),
    );
  } catch (error) {
    checks.push(fail('structured output', error instanceof Error ? error.message : String(error)));
  }
  await provider.dispose?.();
  return checks;
}

export async function runDoctor(argv: string[]): Promise<number> {
  const providerIndex = argv.indexOf('--provider');
  const provider = providerIndex >= 0 ? argv[providerIndex + 1] : undefined;
  // Same variables the tests see: playwright.config.ts loads .env too.
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env is optional
  }
  const { file, config: input } = await loadConfigFile();
  const env = { ...process.env, ...(provider && { AIPW_PROVIDER: provider }) };
  let config: AipwConfig;
  try {
    config = resolveConfig(input);
  } catch (error) {
    console.log(`✗ config      ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const checks = [
    ok('config', file ?? 'no aipw.config.ts (defaults)'),
    ...doctorChecks(config, env, { ...(provider && { provider }) }),
  ];
  if (argv.includes('--probe') && !checks.some((c) => c.status === 'fail')) checks.push(...(await probe(config, env)));
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  for (const c of checks) console.log(`${icon[c.status]} ${c.label.padEnd(24)} ${c.detail}`);
  if (!argv.includes('--probe')) console.log('\nAdd --probe for one live tool-calling and structured-output check.');
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
