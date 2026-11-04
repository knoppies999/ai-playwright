// npm init aipw: the commands it runs for each package manager and provider (docs/guides/getting-started.md §1).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectPackageManager, parseArgs, plan, VERSION } from '../src/index.js';

// By default it installs the aipw version it was released with; a 0.0.0 dev build installs latest.
const v = VERSION === '0.0.0' ? 'latest' : VERSION;

const folder = (withPackageJson: boolean) => {
  const root = mkdtempSync(join(tmpdir(), 'create-aipw-'));
  if (withPackageJson) writeFileSync(join(root, 'package.json'), '{"name":"app"}');
  return root;
};

describe('create-aipw', () => {
  it('installs aipw, the provider and Playwright, the browser, then runs aipw init', () => {
    const commands = plan(folder(true), 'npm', { provider: 'foundry', dir: 'e2e', version: '0.3.0' });
    expect(commands.map((c) => c.join(' '))).toEqual([
      'npm install -D aipw@0.3.0 @aipw/provider-openai@0.3.0 @playwright/test',
      'npx playwright install chromium',
      'npx aipw init --provider foundry --dir e2e',
    ]);
  });

  it('creates package.json first in an empty folder, and speaks pnpm', () => {
    const commands = plan(folder(false), 'pnpm', { provider: 'claude-code', dir: 'tests', skipBrowsers: true });
    expect(commands.map((c) => c.join(' '))).toEqual([
      'pnpm init',
      `pnpm add -D aipw@${v} @aipw/provider-claude-code@${v} @playwright/test`,
      'pnpm exec aipw init --provider claude-code --dir tests',
    ]);
  });

  it('detects the package manager from the launcher, then the lockfile', () => {
    const root = folder(true);
    expect(detectPackageManager(root, 'pnpm/9.1.0 npm/? node/v22')).toBe('pnpm');
    expect(detectPackageManager(root, '')).toBe('npm');
    writeFileSync(join(root, 'yarn.lock'), '');
    expect(detectPackageManager(root, '')).toBe('yarn');
  });

  it('parses flags', () => {
    expect(parseArgs(['--provider', 'copilot', '--dry-run', '-y'])).toMatchObject({
      provider: 'copilot',
      dryRun: true,
      yes: true,
    });
  });
});
