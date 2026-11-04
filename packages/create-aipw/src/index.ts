// `npm init aipw` (also `pnpm create aipw`, `yarn create aipw`): adds aipw to the project in the current folder.
// Installs aipw, @playwright/test and the provider package you pick, the Chromium browser, then runs `aipw init`
// (config, example spec, Playwright config, Copilot instructions). No dependencies of its own.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';

/** This package's version. aipw packages are released together, so it is also the aipw version to install. */
export const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export const PROVIDERS = {
  'claude-code': { package: '@aipw/provider-claude-code', about: 'your Claude subscription, no API key (local dev)' },
  foundry: { package: '@aipw/provider-openai', about: 'OpenAI models on Microsoft Foundry (pipelines)' },
  openai: { package: '@aipw/provider-openai', about: 'the OpenAI API (OPENAI_API_KEY)' },
  anthropic: { package: '@aipw/provider-anthropic', about: 'the Anthropic API (ANTHROPIC_API_KEY)' },
  copilot: { package: '@aipw/provider-copilot', about: 'GitHub Copilot CLI on this machine' },
} as const;
export type ProviderName = keyof typeof PROVIDERS;

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** From the tool that launched us (`npm init`, `pnpm create`…), else the lockfile, else npm. */
export function detectPackageManager(
  root: string,
  userAgent = process.env.npm_config_user_agent ?? '',
): PackageManager {
  const fromAgent = /^(npm|pnpm|yarn|bun)\//.exec(userAgent)?.[1] as PackageManager | undefined;
  if (fromAgent) return fromAgent;
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

export interface Options {
  provider: ProviderName;
  dir: string;
  /** aipw version to install; defaults to this package's own version (or latest for a 0.0.0 dev build). */
  version?: string;
  skipBrowsers?: boolean;
}

/** The commands `npm init aipw` runs, in order. Pure, so it can be shown with --dry-run and tested. */
export function plan(root: string, pm: PackageManager, options: Options): string[][] {
  const version = options.version ?? (VERSION === '0.0.0' ? 'latest' : VERSION);
  const at = (name: string) => `${name}@${version}`;
  const packages = [at('aipw'), at(PROVIDERS[options.provider].package), '@playwright/test'];
  const add = {
    npm: ['npm', 'install', '-D'],
    pnpm: ['pnpm', 'add', '-D'],
    yarn: ['yarn', 'add', '-D'],
    bun: ['bun', 'add', '-d'],
  }[pm];
  const exec = { npm: ['npx'], pnpm: ['pnpm', 'exec'], yarn: ['yarn'], bun: ['bunx'] }[pm];
  return [
    ...(existsSync(join(root, 'package.json')) ? [] : [[pm, 'init', ...(pm === 'npm' ? ['-y'] : [])]]),
    [...add, ...packages],
    ...(options.skipBrowsers ? [] : [[...exec, 'playwright', 'install', 'chromium']]),
    [...exec, 'aipw', 'init', '--provider', options.provider, '--dir', options.dir],
  ];
}

export function parseArgs(args: string[]): Partial<Options> & { dryRun: boolean; yes: boolean; help: boolean } {
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const provider = value('--provider');
  const dir = value('--dir');
  const version = value('--version');
  return {
    ...(provider && { provider: provider as ProviderName }),
    ...(dir && { dir }),
    ...(version && { version }),
    skipBrowsers: args.includes('--skip-browsers'),
    dryRun: args.includes('--dry-run'),
    yes: args.includes('--yes') || args.includes('-y'),
    help: args.includes('--help') || args.includes('-h'),
  };
}

const HELP = `npm init aipw [-- options]      (pnpm create aipw, yarn create aipw)

Adds aipw to the project in this folder: installs aipw, @playwright/test and a provider, the Chromium browser,
and writes aipw.config.ts, an example spec and the Playwright config (existing files are left alone).

Options:
  --provider ${Object.keys(PROVIDERS).join('|')}   (asked if not given)
  --dir tests          where specs live
  --skip-browsers      don't download Chromium
  --dry-run            print the commands instead of running them
  -y, --yes            no questions: claude-code unless --provider says otherwise`;

async function askProvider(): Promise<ProviderName> {
  const names = Object.keys(PROVIDERS) as ProviderName[];
  console.log('Which model provider?');
  names.forEach((n, i) => console.log(`  ${i + 1}. ${n.padEnd(12)} ${PROVIDERS[n].about}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Number or name [1]: ')).trim();
    const byNumber = names[Number(answer) - 1];
    if (!answer) return 'claude-code';
    if (byNumber) return byNumber;
    if (answer in PROVIDERS) return answer as ProviderName;
    console.log(`Unknown provider "${answer}"; using claude-code.`);
    return 'claude-code';
  } finally {
    rl.close();
  }
}

export async function main(args: string[], root = process.cwd()): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  if (parsed.provider && !(parsed.provider in PROVIDERS)) {
    console.error(`Unknown provider "${parsed.provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.`);
    return 1;
  }
  const interactive = !parsed.yes && !parsed.dryRun && process.stdin.isTTY;
  const provider = parsed.provider ?? (interactive ? await askProvider() : 'claude-code');
  const pm = detectPackageManager(root);
  const commands = plan(root, pm, { ...parsed, provider, dir: parsed.dir ?? 'tests' });
  console.log(`\nSetting up aipw in ${basename(root)} with ${pm} (provider: ${provider})\n`);
  for (const command of commands) {
    console.log(`> ${command.join(' ')}`);
    if (parsed.dryRun) continue;
    const res = spawnSync(command[0]!, command.slice(1), {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (res.status !== 0) {
      console.error(`\n"${command.join(' ')}" failed. Fix the problem above and run npm init aipw again.`);
      return res.status ?? 1;
    }
  }
  return 0;
}
