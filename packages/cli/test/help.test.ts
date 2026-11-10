import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandHelp, COMMANDS, HELP, isCommand, wantsHelp, type CommandName } from '../src/help.js';

describe('aipw help', () => {
  it('lists every command in the overview', () => {
    for (const name of Object.keys(COMMANDS)) expect(HELP).toMatch(new RegExp(`^  ${name}\\s+\\S`, 'm'));
  });

  it('prints usage and options for one command', () => {
    const help = commandHelp('init');
    expect(help).toContain('Usage: aipw init [--provider <name>] [--dir tests] [--force]');
    expect(help).toMatch(/--force\s+overwrite files that exist/);
    // Several usages line up under the first.
    expect(commandHelp('cache')).toContain('Usage: aipw cache stats\n       aipw cache show <spec>');
    for (const name of Object.keys(COMMANDS) as CommandName[]) expect(commandHelp(name)).toContain(`aipw ${name}`);
  });

  it('knows a help request from a step or a passed-through option', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['tests/a.spec.ts', '-h'])).toBe(true);
    expect(wantsHelp(['https://x.test', 'Open the --help page'])).toBe(false);
    expect(wantsHelp(['a.spec.ts', '--', '--help'])).toBe(false);
    expect(isCommand('cache')).toBe(true);
    expect(isCommand('toString')).toBe(false);
  });

  // The built CLI, when there is one (npm run build): --help must never run the command.
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  it.skipIf(!existsSync(cli))('aipw init --help prints help and writes nothing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'aipw-help-'));
    const res = spawnSync(process.execPath, [cli, 'init', '--help'], { cwd, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage: aipw init');
    expect(readdirSync(cwd)).toEqual([]);
    const unknown = spawnSync(process.execPath, [cli, 'bogus'], { cwd, encoding: 'utf8' });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('Unknown command: bogus');
  });
});
