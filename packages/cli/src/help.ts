// Help text for `aipw --help` and `aipw <command> --help`. One place, so the overview and the per-command pages agree.
import { VERSION } from './index.js';

interface CommandHelp {
  /** One line for the overview. */
  about: string;
  usage: string[];
  /** Flag or subcommand → what it does. */
  options?: [string, string][];
  examples?: string[];
}

export const COMMANDS = {
  try: {
    about: 'Run English steps on a page without writing a test',
    usage: ['aipw try <url> ["<step>" …] [--headed] [--save <spec>]'],
    options: [
      ['"<step>"', '"Verify …" asserts, "Read … as name" extracts, anything else is an action'],
      ['(no steps)', 'interactive: type a step, see what happened, "save <file>" when done'],
      ['--headed', 'show the browser'],
      ['--save <spec>', 'write the steps as a spec (never overwrites a file)'],
    ],
    examples: ['aipw try https://demo.playwright.dev/todomvc/ "Add a todo: buy milk" "Verify that 1 item is left"'],
  },
  init: {
    about: 'Set up aipw in this project (config, example spec, Playwright config)',
    usage: ['aipw init [--provider <name>] [--dir tests] [--force]'],
    options: [
      ['--provider <name>', 'claude-code (default), foundry, openai, anthropic or copilot'],
      ['--dir <folder>', 'where specs live (default: tests)'],
      ['--force', 'overwrite files that exist (without it they are left alone)'],
    ],
  },
  nudge: {
    about: 'Step through a test, correct the AI, and get back a verified better step',
    usage: [
      'aipw nudge <spec[:line]> [--break step|action|fail|none] [--at N] [--fresh] [--verify all|none] [--headless]',
    ],
    options: [
      ['--break <level>', 'pause before every step (default), every action, only on failure, or never'],
      ['--at N', 'run to AI step N, then pause'],
      ['--fresh', 'ignore cached plans: the model works out every step again'],
      ['--verify all|none', 'check each suggested fix by re-running the step (default: all)'],
      ['--headless', 'no browser window (hints and edits work; pick and manual need the window)'],
    ],
    examples: ['aipw nudge tests/users.spec.ts:12'],
  },
  cache: {
    about: 'Inspect and maintain recorded plans',
    usage: [
      'aipw cache stats',
      'aipw cache show <spec> [--grep <title part>]',
      'aipw cache code <spec> [--grep <title part>]',
      'aipw cache prune [--dry-run]',
      'aipw cache refresh <spec> [playwright options]',
      'aipw cache accept [dir] [--dry-run]',
    ],
    options: [
      ['stats', 'per plan file: steps, heals, and steps that still need the model on replay'],
      ['show', "a spec's plans: each step, its actions and the locators they replay"],
      ['code', 'the same plans as plain Playwright code'],
      ['prune', 'remove plans of tests that no longer exist'],
      ['refresh', 'record the spec again with the model (AIPW_CACHE=refresh)'],
      ['accept', 'merge healed plans from .aipw/healed/ (or [dir]) into the committed plans'],
    ],
  },
  doctor: {
    about: 'Check the config, the provider and its credentials',
    usage: ['aipw doctor [--provider <name>] [--probe]'],
    options: [
      ['--provider <name>', 'check this provider instead of the configured one'],
      ['--probe', 'make one live tool-calling and one structured-output call (spends a request)'],
    ],
  },
  conformance: {
    about: 'Measure a provider/model on the usability suite',
    usage: ['aipw conformance --provider <name> [--project saucedemo-llm] [--out docs/conformance]'],
    options: [
      ['--provider <name>', 'the provider to measure (every step runs with the model: this spends requests)'],
      ['--project <name>', 'the Playwright project to run (default: saucedemo-llm)'],
      ['--out <dir>', 'where conformance-<provider>-<model>.json goes (default: docs/conformance)'],
    ],
  },
  hints: {
    about: 'Check site hint files',
    usage: ['aipw hints lint [dir]'],
    options: [['lint [dir]', 'duplicates, repeated sections, hints outside a section, size (default dir: hints)']],
  },
  summary: {
    about: 'Print the last run summary; fail a build that used the model too much',
    usage: ['aipw summary [--max-llm-calls N] [--max-cost USD] [--file .aipw/summary.json]'],
    options: [
      ['--max-llm-calls N', 'exit 1 when the run made more model calls (a replay-only PR gate uses 0)'],
      ['--max-cost USD', 'exit 1 when the estimated cost is higher'],
      ['--file <path>', 'the summary to read (default: .aipw/summary.json, written by the aipw reporter)'],
    ],
  },
} satisfies Record<string, CommandHelp>;

export type CommandName = keyof typeof COMMANDS;

export const isCommand = (name: string): name is CommandName => Object.hasOwn(COMMANDS, name);

/** True when the arguments ask for help. Stops at `--`, and never looks inside a quoted step. */
export function wantsHelp(args: string[]): boolean {
  for (const a of args) {
    if (a === '--') return false;
    if (a === '--help' || a === '-h') return true;
  }
  return false;
}

const table = (rows: [string, string][]) => {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${k.padEnd(width)}  ${v}`).join('\n');
};

export function commandHelp(name: CommandName): string {
  const c: CommandHelp = COMMANDS[name];
  return [
    c.about,
    '',
    `Usage: ${c.usage.join('\n       ')}`,
    ...(c.options ? ['', table(c.options)] : []),
    ...(c.examples ? ['', `Example${c.examples.length > 1 ? 's' : ''}:`, ...c.examples.map((e) => `  ${e}`)] : []),
  ].join('\n');
}

export const HELP = `aipw ${VERSION}

Usage: aipw <command> [options]

${table((Object.keys(COMMANDS) as CommandName[]).map((n) => [n, COMMANDS[n].about]))}

  aipw <command> --help   options and examples for one command
  aipw --version          print the version

New here? aipw init, then aipw doctor --probe, then npx playwright test.`;
