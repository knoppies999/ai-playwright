// `aipw nudge <spec[:line]>` (docs/07): runs one test with the human in the loop. Starts the nudge server
// and a persistent browser, runs Playwright Test against them, relaunches on rewind, writes a summary.
import {
  NudgeServer,
  type BreakLevel,
  type NudgeCommand,
  type NudgeUi,
  type PauseState,
  type VerifyJob,
} from '@aipw/core';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { applyRemedies, formatRemedies, isVerifiable, parseChoices, stepShift, verifyRemedies } from './apply.js';
import { contentHash } from './patch.js';

export interface NudgeArgs {
  spec: string;
  breakLevel: BreakLevel;
  at?: number;
  fresh: boolean;
  /** Verify remedy candidates before offering them (docs/07 §6.4); --verify none turns it off. */
  verify: boolean;
}

const LEVELS: BreakLevel[] = ['step', 'action', 'fail', 'none'];

export function parseNudgeArgs(argv: string[]): NudgeArgs | { error: string } {
  const args: NudgeArgs = { spec: '', breakLevel: 'step', fresh: false, verify: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--break') {
      const level = argv[++i] as BreakLevel;
      if (!LEVELS.includes(level)) return { error: `--break must be one of ${LEVELS.join(', ')}` };
      args.breakLevel = level;
    } else if (a === '--at') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) return { error: '--at takes an AI step number (1, 2, …)' };
      args.at = n;
    } else if (a === '--verify') {
      const v = argv[++i];
      if (v !== 'all' && v !== 'none') return { error: '--verify must be all or none' };
      args.verify = v === 'all';
    } else if (a === '--fresh') args.fresh = true;
    else if (!a.startsWith('--') && !args.spec) args.spec = a;
    else return { error: `Unknown argument ${a}` };
  }
  return args.spec
    ? args
    : {
        error: 'Usage: aipw nudge <spec[:line]> [--break step|action|fail|none] [--at N] [--fresh] [--verify all|none]',
      };
}

export const NUDGE_HELP = `[Enter] run   [s]kip   [h]int <text>   [e]dit <instruction>   [a]nswer <text>
[c]ontinue   [b]reak <step|action|fail|none>   [v]iew snapshot   [r]ewind <step>   [q]uit   ?=help`;

/** Turns a typed line into a command. Returns a string for local actions (help, view) or errors. */
export function parseCommandLine(line: string, state: PauseState): NudgeCommand | { local: string } {
  const [key = '', ...rest] = line.trim().split(/\s+/);
  const text = rest.join(' ');
  switch (key.toLowerCase()) {
    case '':
      return state.reason === 'ask' ? { local: 'Type a for an answer, e.g.  a OPS-07' } : { cmd: 'run' };
    case 's':
    case 'skip':
      return { cmd: 'skip' };
    case 'h':
    case 'hint':
      return text ? { cmd: 'hint', text } : { local: 'Give the hint after h, e.g.  h it is under the gear icon' };
    case 'e':
    case 'edit':
      return text ? { cmd: 'edit', instruction: text } : { local: `Current instruction: ${state.step.instruction}` };
    case 'a':
    case 'answer':
      return { cmd: 'answer', text };
    case 'c':
    case 'continue':
      return { cmd: 'continue' };
    case 'b':
    case 'break':
      return LEVELS.includes(text as BreakLevel)
        ? { cmd: 'break', level: text as BreakLevel }
        : { local: `Levels: ${LEVELS.join(', ')}` };
    case 'r':
    case 'rewind': {
      const n = Number(text || state.step.index);
      return Number.isInteger(n) && n >= 1
        ? { cmd: 'rewind', toStep: n }
        : { local: 'Rewind to which AI step? e.g.  r 2' };
    }
    case 'v':
    case 'view':
      return { local: state.snapshot ?? '(no snapshot at this pause)' };
    case 'q':
    case 'quit':
      return { cmd: 'quit' };
    case '?':
    case 'help':
      return { local: NUDGE_HELP };
    default:
      return { local: `Unknown command "${key}". ${NUDGE_HELP}` };
  }
}

export function formatPause(state: PauseState): string {
  const lines = [
    `── nudge ── ${state.test.file} › ${state.test.title} ${'─'.repeat(8)}`,
    `Step ${state.step.index}  ai.${state.step.kind}(${JSON.stringify(state.step.instruction)})   plan: ${state.step.cached ? 'cached' : 'none (AI)'}`,
  ];
  if (state.reason === 'breakpoint') lines.push(`Breakpoint: ${state.note}`);
  if (state.decision) {
    const d = state.decision;
    const target = d.target
      ? `${d.target.role ?? 'element'}${d.target.name ? ` "${d.target.name}"` : ''} [${d.target.ref}]`
      : '';
    lines.push(`Decision ${d.turn + 1}  ${d.tool}  ${target}`);
    if (d.intent) lines.push(`  intent : ${d.intent}`);
    if (d.why) lines.push(`  why    : ${d.why.slice(0, 200)}`);
  }
  if (state.failure) lines.push(`AI gave up (${state.failure.kind}): ${state.failure.reason}`);
  if (state.question) lines.push(`AI asks: ${state.question}`);
  if (state.page)
    lines.push(`  page   : ${state.page.url}  ·  ${state.page.tabs} tab(s)  ·  ${state.page.dialogs} dialog(s)`);
  if (state.history.length) lines.push('  so far :', ...state.history.map((h) => `    ${h}`));
  lines.push('─'.repeat(60), NUDGE_HELP);
  return lines.join('\n');
}

/** The session summary written to .aipw/nudge/<timestamp>/summary.md (docs/07 §6.6). */
export function summarizeSession(
  spec: string,
  pauses: { state: PauseState; command: NudgeCommand }[],
  rewinds: number[],
  applied: string[] = [],
): string {
  const corrections = pauses.filter((p) => ['hint', 'edit', 'answer', 'skip'].includes(p.command.cmd));
  const lines = [
    `# Nudge session: ${spec}`,
    '',
    `- Pauses: ${pauses.length}`,
    `- Corrections: ${corrections.length}`,
    `- Rewinds: ${rewinds.length ? rewinds.map((r) => `to step ${r}`).join(', ') : 'none'}`,
    '',
    '## Corrections',
    '',
  ];
  if (!corrections.length) lines.push('None.');
  for (const { state, command } of corrections) {
    const what =
      command.cmd === 'hint'
        ? `hint: "${command.text}"`
        : command.cmd === 'edit'
          ? `instruction changed to "${command.instruction}"`
          : command.cmd === 'answer'
            ? `answered "${command.text}" to "${state.question}"`
            : 'skipped';
    lines.push(
      `- Step ${state.step.index} \`ai.${state.step.kind}(${JSON.stringify(state.step.instruction)})\` at ${state.reason}: ${what}`,
    );
  }
  if (applied.length) lines.push('', '## Applied remedies', '', ...applied.map((a) => `- ${a.replace(/\n/g, '\n  ')}`));
  return `${lines.join('\n')}\n`;
}

/** "examples/a.spec.ts:12" → the file; a Windows drive colon is kept. */
export const specFile = (spec: string) => spec.replace(/:\d+$/, '');

/** The line of a callsite "file:line", or 0. */
export const callsiteLine = (callsite: string | undefined) => Number(/:(\d+)$/.exec(callsite ?? '')?.[1] ?? 0);

export interface RemedyTarget {
  specPath: string;
  /** Hash of the spec when the session started: patches are refused if it changed (docs/07 §6.5). */
  specHash: string;
  hintsDir: string;
}

/** Interactive terminal UI. */
export class TerminalUi implements NudgeUi {
  private readonly rl = createInterface({ input: process.stdin, output: process.stdout });
  /** What the human applied, for the session summary. */
  readonly applied: string[] = [];
  /** A remedies pause waiting for verification runs; the driver runs them between relaunches. */
  pendingVerify?: PauseState;

  constructor(
    private readonly target?: RemedyTarget,
    private readonly verify = true,
  ) {}

  onHello(test: { file: string; title: string }): void {
    if (!this.pendingVerify) console.log(`\naipw nudge: ${test.file} › ${test.title}`);
  }

  async onPause(state: PauseState): Promise<NudgeCommand> {
    if (state.reason === 'remedies' && state.remedies) {
      if (this.verify && state.remedies.basis && state.remedies.options.some(isVerifiable)) {
        // End this run; the driver verifies each candidate, shows them, then resumes after this step.
        this.pendingVerify = state;
        console.log(
          `\nStep ${state.step.index} was corrected. Verifying the suggested fixes (the test restarts for each)…`,
        );
        return { cmd: 'rewind', toStep: state.step.index };
      }
      await this.presentRemedies(state, state.remedies);
      return { cmd: 'run' };
    }
    console.log(`\n${formatPause(state)}`);
    for (;;) {
      const parsed = parseCommandLine(await this.rl.question('nudge> '), state);
      if ('local' in parsed) console.log(parsed.local);
      else return parsed;
    }
  }

  /** Shows the remedies, applies the chosen ones and returns how many AI steps the spec patch added or removed. */
  async presentRemedies(state: PauseState, remedies: NonNullable<PauseState['remedies']>): Promise<number> {
    console.log(`\n── step ${state.step.index} was corrected ──\n${formatRemedies(remedies)}`);
    const n = remedies.options.length;
    let choices: number[] | undefined;
    while (
      !(choices = parseChoices(
        await this.rl.question(`Apply [1-${n}, e.g. 1,3; a = all verified; n = none]> `),
        remedies.options,
      ))
    )
      console.log('Type option numbers separated by commas, a for all, or n for none.');
    if (!choices.length || !this.target) return 0;
    const { report, patched } = applyRemedies(remedies, choices, {
      ...this.target,
      instruction: state.step.instruction,
      line: callsiteLine(state.step.callsite),
    });
    for (const r of report) console.log(r);
    this.applied.push(...report.map((r) => `Step ${state.step.index}: ${r}`));
    // Our own patch: later steps may be patched too, against the new content.
    if (patched) this.target.specHash = contentHash(readFileSync(this.target.specPath, 'utf8'));
    return stepShift(patched);
  }

  onProgress(text: string): void {
    console.log(text);
  }

  onRewind(toStep: number): void {
    if (!this.pendingVerify) console.log(`\nRewinding: the test restarts and fast-forwards to AI step ${toStep}…`);
  }

  close(): void {
    this.rl.close();
  }
}

function runPlaywright(spec: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['playwright', 'test', spec, '--workers=1', '--retries=0', '--timeout=0', '--reporter=list'],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        shell: true,
        env,
      },
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

export async function runNudge(argv: string[]): Promise<number> {
  const args = parseNudgeArgs(argv);
  if ('error' in args) {
    console.error(args.error);
    return 1;
  }
  if (process.env.CI) {
    console.error('aipw nudge is interactive and refuses to run when CI is set (docs/07 §9).');
    return 1;
  }
  const specPath = resolve(specFile(args.spec));
  let specHash: string;
  try {
    specHash = contentHash(readFileSync(specPath, 'utf8'));
  } catch {
    console.error(`Can't read ${specPath}`);
    return 1;
  }
  const ui = new TerminalUi({ specPath, specHash, hintsDir: resolve('hints') }, args.verify);
  const server = new NudgeServer(ui);
  const port = await server.listen();
  // One headed browser for the whole session; every relaunch gets a fresh context in it (docs/07 §5.3).
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launchServer({ headless: false });
  const seed = randomUUID().slice(0, 8); // same generated data across rewinds
  const rewinds: number[] = [];
  let resumeAt = args.at ?? 1;
  let code: number;
  const dir = join(process.cwd(), '.aipw', 'nudge', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const env = (resumeAt: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...process.env,
    AIPW_NUDGE_PORT: String(port),
    AIPW_NUDGE_BREAK: args.breakLevel,
    AIPW_NUDGE_RESUME_AT: String(resumeAt),
    AIPW_SEED: seed,
    PW_TEST_CONNECT_WS_ENDPOINT: browser.wsEndpoint(),
    ...(args.fresh && { AIPW_CACHE: 'ai-only' }),
    ...extra,
  });
  let jobs = 0;
  // One verification run: fast-forward to the step, try the candidate with AI only, report (docs/07 §6.4).
  const runVerification = async (job: VerifyJob) => {
    const file = join(dir, `verify-${++jobs}.json`);
    writeFileSync(file, JSON.stringify(job));
    server.verifications.length = 0;
    await runPlaywright(args.spec, env(job.step, { AIPW_NUDGE_BREAK: 'none', AIPW_NUDGE_VERIFY: file }));
    return server.verifications.shift();
  };
  try {
    for (;;) {
      server.pendingRewind = undefined;
      code = await runPlaywright(args.spec, env(resumeAt));
      const pending = ui.pendingVerify;
      if (pending) {
        const verified = await verifyRemedies(pending, runVerification, (line) => console.log(line));
        ui.pendingVerify = undefined;
        const shift = await ui.presentRemedies(pending, verified);
        // Carry on after the corrected step; its plan was stored, so it replays.
        resumeAt = pending.step.index + 1 + shift;
        console.log(`\nResuming at AI step ${resumeAt}…`);
        continue;
      }
      if (server.pendingRewind === undefined) break;
      rewinds.push(server.pendingRewind);
      resumeAt = server.pendingRewind;
    }
  } finally {
    writeFileSync(join(dir, 'summary.md'), summarizeSession(args.spec, server.pauses, rewinds, ui.applied));
    console.log(`\nSession summary: ${join(dir, 'summary.md')}`);
    ui.close();
    await server.close();
    await browser.close();
  }
  return code;
}
