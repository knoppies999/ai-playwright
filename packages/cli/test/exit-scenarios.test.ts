// Phase 6 exit scenarios (docs/10), scripted: the real engine, nudge protocol, verification and apply code on the
// demo app's pages, with a FakeProvider for the model and a ScriptedUi for the human.
import {
  Ai,
  FakeProvider,
  MemoryPlanStore,
  NudgeController,
  NudgeQuit,
  NudgeServer,
  RewindSignal,
  ScriptedUi,
  createGenerators,
  resolveConfig,
  type DecisionRequest,
  type NudgeCommand,
  type PauseState,
  type ScriptedDecision,
  type VerifyJob,
} from '@aipw/core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyRemedies, verifyRemedies } from '../src/apply.js';
import { contentHash } from '../src/patch.js';

let browser: Browser | undefined;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});
const open = () => browser!.newPage();
const PUBLIC = join(import.meta.dirname, '..', '..', '..', 'examples', 'demo-app', 'public');
const ROUTES: Record<string, string> = {
  '/app': 'app.html',
  '/users': 'users.html',
  '/shared.js': 'shared.js',
};
const GOLDEN = join(import.meta.dirname, 'golden');
const TEST = { file: 'demo.spec.ts', title: 'exit scenario' };

/** The demo app's pages, served from disk under http://demo.test (no server, no network). */
async function demo(path: string): Promise<Page> {
  const page = await open();
  await page.route('http://demo.test/**', (route) => {
    const file = ROUTES[new URL(route.request().url()).pathname];
    return file
      ? route.fulfill({
          contentType: file.endsWith('.js') ? 'text/javascript' : 'text/html',
          body: readFileSync(join(PUBLIC, file), 'utf8'),
        })
      : route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`http://demo.test${path}`);
  return page;
}

const servers: NudgeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function nudged(
  answers: ((s: PauseState) => NudgeCommand)[],
  options: Parameters<typeof NudgeController.connect>[2],
) {
  const ui = new ScriptedUi(answers);
  const server = new NudgeServer(ui);
  servers.push(server);
  const controller = await NudgeController.connect(await server.listen(), TEST, options);
  return { ui, server, controller };
}

const config = (extra: object = {}) =>
  resolveConfig({ settle: { maxMs: 300, networkQuietMs: 50, snapshotIntervalMs: 50 }, ...extra });

/** The ref on the first snapshot line containing `text`, after the line containing `after` if given. */
function refOf(req: DecisionRequest, text: string, after?: string): string {
  const lines = req.observation.split('\n');
  const start = after ? lines.findIndex((l) => l.includes(after)) : 0;
  const line = lines.slice(Math.max(start, 0)).find((l) => l.includes(text));
  return /\[ref=([^\]]+)\]/.exec(line ?? '')![1]!;
}
const intent = 'scripted';
const hover = (text: string) => (req: DecisionRequest) => ({ tool: 'hover', args: { ref: refOf(req, text), intent } });
const click = (text: string, after?: string) => (req: DecisionRequest) => ({
  tool: 'click',
  args: { ref: refOf(req, text, after), button: null, modifiers: null, clickCount: null, intent },
});
const done = { tool: 'done', args: { summary: 'ok', evidence: [] } };
const expectInContext = (text: string, then: ScriptedDecision) => async (req: DecisionRequest) => {
  expect(req.context).toContain(text);
  return typeof then === 'function' ? then(req) : then;
};

/** One verification run, like the driver's relaunch: fast-forward to the step, try the candidate, report. */
async function verifyOnce(job: VerifyJob, path: string, decisions: ScriptedDecision[]) {
  const { server, controller } = await nudged([], { breakLevel: 'none', verify: job });
  await new Ai({ page: await demo(path), provider: new FakeProvider(decisions), config: config(), nudge: controller })
    .act(job.instruction)
    .catch(() => undefined);
  await expect.poll(() => server.verifications.length).toBe(1);
  return server.verifications[0];
}

describe('Phase 6 exit scenarios', () => {
  it('1. hidden hover menu: fail → pick → site hint verified with the original instruction → applied → fresh ai-only run passes', async () => {
    const page = await demo('/app');
    let remedies: PauseState | undefined;
    const { ui, controller } = await nudged(
      [
        () => {
          // The human opens the flyout and clicks "Users" in the picker.
          void (async () => {
            await page.waitForFunction(() => (window as { __aipwPicking?: boolean }).__aipwPicking === true);
            await page.getByRole('button', { name: 'Settings' }).hover();
            await page.getByRole('link', { name: 'Users' }).click();
          })();
          return { cmd: 'pick' };
        },
        (s) => {
          remedies = s;
          return { cmd: 'run' };
        },
      ],
      { breakLevel: 'fail' },
    );
    const hint = 'Users and Roles are in the Settings flyout in the header; hover "Settings" to open it.';
    const provider = new FakeProvider(
      [{ tool: 'fail', args: { kind: 'not_found', reason: 'There is no Users link on the page.' } }, done],
      [
        {
          diagnosis: 'Users is only rendered inside the Settings flyout, which opens on hover.',
          category: 'hidden-in-menu',
          revisedInstruction: 'Hover "Settings" in the header, then click "Users"',
          splitInto: null,
          hint: { scope: 'site', pathPattern: null, text: hint },
        },
      ],
    );
    await new Ai({ page, provider, config: config(), nudge: controller }).act('Open the Users page');
    expect(ui.seen[0]).toMatchObject({ reason: 'fail' });
    expect(page.url()).toBe('http://demo.test/users');
    expect(remedies?.reason).toBe('remedies');
    expect(provider.structuredRequests[0]!.prompt).toContain('- picked: click link "Users"');

    // Verification: each text candidate in its own run, AI only, no human help.
    const verified = await verifyRemedies(remedies!, (job) =>
      verifyOnce(job, '/app', [
        expectInContext(
          job.option.kind === 'hint' ? hint : 'Hover "Settings" in the header',
          hover('button "Settings"'),
        ),
        click('link "Users"'),
        done,
      ]),
    );
    expect(verified.options.map((o) => [o.kind, o.verified])).toEqual([
      ['hint', true],
      ['instruction', true],
      ['code', undefined],
    ]);

    // Apply the hint, then a fresh ai-only run with the original instruction passes without nudge.
    const hintsDir = mkdtempSync(join(tmpdir(), 'aipw-hints-'));
    const spec = join(hintsDir, 'unused.spec.ts');
    writeFileSync(spec, '');
    const { report } = applyRemedies(verified, [0], {
      specPath: spec,
      specHash: contentHash(''),
      instruction: 'Open the Users page',
      line: 1,
      hintsDir,
    });
    expect(report[0]).toMatch(/demo\.test\.md$/);
    const fresh = await demo('/app');
    await new Ai({
      page: fresh,
      provider: new FakeProvider([expectInContext(hint, hover('button "Settings"')), click('link "Users"'), done]),
      config: config({ hints: { dir: hintsDir }, cache: { mode: 'ai-only' } }),
    }).act('Open the Users page');
    expect(fresh.url()).toBe('http://demo.test/users');
  });

  it('2. ambiguous "Save": the AI asks → the revised instruction is verified → the spec is patched (golden diff)', async () => {
    const page = await demo('/app');
    let remedies: PauseState | undefined;
    const { ui, controller } = await nudged(
      [
        () => ({ cmd: 'answer', text: 'the one in Notifications' }),
        (s) => {
          remedies = s;
          return { cmd: 'run' };
        },
      ],
      { breakLevel: 'fail' },
    );
    const revised = 'Click "Save" in the Notifications section';
    const provider = new FakeProvider(
      [
        { tool: 'ask_human', args: { question: 'There are two Save buttons. Which one?' } },
        expectInContext('the one in Notifications', click('button "Save"', 'region "Notifications"')),
        done,
      ],
      [
        {
          diagnosis: 'The page has two Save buttons; the instruction does not say which.',
          category: 'ambiguous-target',
          revisedInstruction: revised,
          splitInto: null,
          hint: null,
        },
      ],
    );
    await new Ai({ page, provider, config: config(), nudge: controller }).act('Save');
    expect(ui.seen[0]).toMatchObject({ reason: 'ask', question: 'There are two Save buttons. Which one?' });
    expect(await page.getByRole('status').textContent()).toBe('Notifications saved');

    const verified = await verifyRemedies(remedies!, (job) =>
      verifyOnce(job, '/app', [expectInContext(revised, click('button "Save"', 'region "Notifications"')), done]),
    );
    expect(verified.options.map((o) => [o.kind, o.verified])).toEqual([
      ['instruction', true],
      ['code', undefined],
    ]);

    const dir = mkdtempSync(join(tmpdir(), 'aipw-spec-'));
    const spec = join(dir, 'settings.spec.ts');
    const source = readFileSync(join(GOLDEN, 'nudge-save.spec.ts.txt'), 'utf8');
    writeFileSync(spec, source);
    const { report, patched } = applyRemedies(verified, [0], {
      specPath: spec,
      specHash: contentHash(source),
      instruction: 'Save',
      line: 5,
      hintsDir: join(dir, 'hints'),
    });
    expect(patched).toEqual({ kind: 'instruction', text: revised });
    const diff = report[0]!.slice(report[0]!.indexOf('\n') + 1);
    const golden = join(GOLDEN, 'nudge-save.diff');
    if (!existsSync(golden)) {
      mkdirSync(GOLDEN, { recursive: true });
      writeFileSync(golden, `${diff}\n`);
      throw new Error('Golden nudge-save.diff was missing and has been written. Review it.');
    }
    expect(`${diff}\n`).toBe(readFileSync(golden, 'utf8'));
  });

  it('3. rewind from step 5 to step 2 re-runs code, replays step 1 from cache, pauses at step 2 with identical data', async () => {
    const store = new MemoryPlanStore();
    const loginRuns: number[] = [];
    const seen: { step: number; email: string }[] = [];
    /** The spec body: login code, then five AI steps; the email is generated before step 2. */
    const spec = async (ai: Ai, run: number) => {
      loginRuns.push(run); // e.g. an API login: plain code, re-runs on every launch
      await ai.act('Save the profile');
      const email = ai.gen.email();
      for (let step = 2; step <= 5; step++) {
        seen.push({ step, email });
        await ai.act(step % 2 ? 'Save the profile' : 'Save the notifications');
      }
    };
    const saveIn = (section: string) => [click('button "Save"', `region "${section}"`), done];
    const runOf = (answers: ((s: PauseState) => NudgeCommand)[], resumeAt: number) =>
      nudged(answers, { breakLevel: 'step', resumeAt });

    // Run 1: Enter at steps 1-4, rewind to step 2 at step 5.
    const first = await runOf(
      [
        ...[...Array(4)].map(() => (): NudgeCommand => ({ cmd: 'run' })),
        (): NudgeCommand => ({ cmd: 'rewind', toStep: 2 }),
      ],
      1,
    );
    const ai1 = new Ai({
      page: await demo('/app'),
      provider: new FakeProvider([
        ...saveIn('Profile'),
        ...saveIn('Notifications'),
        ...saveIn('Profile'),
        ...saveIn('Notifications'),
      ]),
      config: config(),
      nudge: first.controller,
      cache: { store, testTitle: TEST.title },
      gen: createGenerators({ seed: 't1:seed42', runId: 'seed42' }),
    });
    expect(await spec(ai1, 1).catch((e) => e)).toBeInstanceOf(RewindSignal);
    await expect.poll(() => first.server.pendingRewind).toBe(2);

    // Run 2 (the driver's relaunch): same seed, resume at step 2, no model calls left for the replayed step.
    const second = await runOf([() => ({ cmd: 'quit' })], 2);
    const ai2 = new Ai({
      page: await demo('/app'),
      provider: new FakeProvider([]),
      config: config(),
      nudge: second.controller,
      cache: { store, testTitle: TEST.title },
      gen: createGenerators({ seed: 't1:seed42', runId: 'seed42' }),
    });
    expect(await spec(ai2, 2).catch((e) => e)).toBeInstanceOf(NudgeQuit);
    expect(loginRuns).toEqual([1, 2]);
    expect(second.ui.seen.map((s) => [s.reason, s.step.index, s.step.cached])).toEqual([['step', 2, true]]);
    const atStep2 = seen.filter((s) => s.step === 2);
    expect(atStep2).toHaveLength(2);
    expect(atStep2[1]!.email).toBe(atStep2[0]!.email);
  });
});
