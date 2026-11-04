// `aipw try <url> "<step>" ["<step>" …] [--headed] [--save <spec>]`: try English steps on a page without writing a
// test. Each step runs live (the same engine as ai.*), and you see what the AI did, the durable locators it found,
// the Playwright code it amounts to, and what it cost. --save writes the steps as a ready-to-run spec.
// Steps work like ai.run lines: "Verify …" asserts, "Read … as name" extracts, anything else is an action.
import {
  Ai,
  codeRemedy,
  loadProvider,
  resolveConfig,
  type ActionRecord,
  type AipwEvent,
  type LlmProvider,
} from '@aipw/core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfigFile } from './doctor.js';
import { LineReader } from './nudge.js';

export interface TryArgs {
  url: string;
  steps: string[];
  headed: boolean;
  save?: string;
}

export function parseTryArgs(argv: string[]): TryArgs | { error: string } {
  const out: TryArgs = { url: '', steps: [], headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--headed') out.headed = true;
    else if (a === '--save') out.save = argv[++i];
    else if (a.startsWith('--')) return { error: `Unknown option ${a}` };
    else if (!out.url) out.url = a;
    else out.steps.push(a);
  }
  if (!/^https?:\/\//.test(out.url)) {
    return {
      error: 'Usage: aipw try <url> ["<step>" …] [--headed] [--save tests/new.spec.ts]   (no steps: one at a time)',
    };
  }
  if (out.save === '') return { error: '--save needs a file path' };
  return out;
}

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const ASSERT = /^(verify|check|assert|expect|ensure)\b[:\s]*(that\s+)?/i;
const EXTRACT = /^(?:extract|read|get)\s+(.+?)\s+as\s+([A-Za-z_]\w*)\s*$/i;

/**
 * The spec --save writes: page.goto, then each step as the ai.* call ai.run would make. A value read during the try
 * becomes an expectation, so the saved test checks what was seen.
 */
export function specFor(url: string, steps: string[], values: Record<string, unknown> = {}): string {
  const lines = steps.flatMap((s) => {
    const extract = EXTRACT.exec(s);
    if (extract) {
      const [, what, name] = extract;
      const seen = values[name!];
      return [
        `  const ${name} = await ai.extract(${quote(what!)}, z.string());`,
        typeof seen === 'string'
          ? `  expect(${name}).toBe(${quote(seen)}); // seen during aipw try: loosen it if the value changes over time`
          : `  console.log(${name});`,
      ];
    }
    if (ASSERT.test(s)) return `  await ai.assert(${quote(s.replace(ASSERT, ''))});`;
    return `  await ai.act(${quote(s)});`;
  });
  const usesZ = lines.some((l) => l.includes('z.string()'));
  const usesExpect = lines.some((l) => l.includes('expect('));
  return [
    `import { ${usesExpect ? 'expect, ' : ''}test } from '@aipw/test';`,
    ...(usesZ ? ["import { z } from 'zod';"] : []),
    '',
    `// Written by aipw try. Run it once to record the plan; later runs replay it without the model.`,
    `test(${quote(steps[0]!.slice(0, 80))}, async ({ page, ai }) => {`,
    `  await page.goto(${quote(url)});`,
    ...lines,
    '});',
    '',
  ].join('\n');
}

interface StepLog {
  kind: string;
  instruction: string;
  actions: ActionRecord[];
  verdict?: { pass: boolean; reason: string };
  ms: number;
  calls: number;
}

export async function runTry(argv: string[]): Promise<number> {
  const args = parseTryArgs(argv);
  if ('error' in args) {
    console.error(args.error);
    return 1;
  }
  if (args.save && existsSync(args.save)) {
    console.error(`${args.save} exists; pick another file (aipw try never overwrites).`);
    return 1;
  }
  const { config: input } = await loadConfigFile();
  const config = resolveConfig(input);
  let provider: LlmProvider;
  try {
    provider = await loadProvider(config);
  } catch (error) {
    console.error(`Could not load the provider: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ headless: !args.headed });
  const logs: StepLog[] = [];
  let failed = false;
  let values: Record<string, unknown> = {};
  try {
    const page = await browser.newPage();
    console.log(`Opening ${args.url} (${provider.id}/${provider.model})…\n`);
    await page.goto(args.url);
    const ai = new Ai({ page, provider, config, baseURL: args.url });
    const byId = new Map<string, StepLog>();
    ai.events.on((e: AipwEvent) => {
      if (e.type === 'step:start' && e.kind !== 'run') {
        const log: StepLog = { kind: e.kind, instruction: e.instruction, actions: [], ms: 0, calls: 0 };
        byId.set(e.stepId, log);
        logs.push(log);
        console.log(`${logs.length}. ${e.kind}: ${e.instruction}`);
      }
      const log = 'stepId' in e ? byId.get(e.stepId) : undefined;
      if (!log) return;
      if (e.type === 'action' && e.record.result === 'ok' && !['expand', 'wait_for'].includes(e.record.tool)) {
        log.actions.push(e.record);
        const t = e.record.target;
        const where = t
          ? ` ${t.role ?? 'element'}${t.name ? ` "${t.name}"` : ''} → ${t.candidates[0]?.display ?? 'no durable locator'}`
          : '';
        console.log(`   ${e.record.tool}${where}`);
      }
      if (e.type === 'verdict') {
        log.verdict = { pass: e.pass, reason: e.reason };
      }
      if (e.type === 'step:end') {
        log.ms = e.ms;
        log.calls = e.usage.requests;
        if (log.verdict) console.log(`   ${log.verdict.pass ? '✓' : '✗'} ${log.verdict.reason}`);
        console.log(`   (${(log.ms / 1000).toFixed(1)} s, ${log.calls} model call${log.calls === 1 ? '' : 's'})\n`);
      }
    });
    if (args.steps.length) {
      ({ values } = await ai.run(args.steps.map((s) => `- ${s}`).join('\n')));
      for (const [name, value] of Object.entries(values)) console.log(`${name} = ${JSON.stringify(value)}`);
    } else {
      // Interactive: one step at a time on the same page; steps that fail aren't kept.
      console.log('Type a step and press Enter. "save <file>" writes the steps that worked as a spec; "q" quits.\n');
      const reader = new LineReader();
      for (;;) {
        const line = (await reader.ask('step> '))?.trim();
        if (line === undefined || line === 'q' || line === 'quit') break;
        const save = /^save\s+(\S.*)$/.exec(line);
        if (save) saveSpec(save[1]!, args.url, args.steps, values);
        else if (line) {
          try {
            Object.assign(values, (await ai.run(`- ${line}`)).values);
            args.steps.push(line);
          } catch (error) {
            console.error(
              `${error instanceof Error ? error.message : String(error)}\n(not kept; try another phrasing)\n`,
            );
          }
        }
      }
      reader.close();
    }
  } catch (error) {
    failed = true;
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    await browser.close();
    await provider.dispose?.();
  }

  const code = logs.flatMap((l) => (l.kind === 'act' ? codeRemedy(l.actions) : []));
  if (code.length) console.log(`Playwright code for the actions:\n${code.map((l) => `  ${l}`).join('\n')}\n`);
  if (args.save && !failed && args.steps.length) saveSpec(args.save, args.url, args.steps, values);
  return failed ? 1 : 0;
}

function saveSpec(path: string, url: string, steps: string[], values: Record<string, unknown>): void {
  if (!steps.length) return console.log('Nothing to save yet.');
  if (existsSync(path)) return console.log(`${path} exists; pick another file (aipw try never overwrites).`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, specFor(url, steps, values));
  console.log(`Wrote ${path}. Run it once to record its plan: npx playwright test ${path}`);
}
