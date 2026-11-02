// Compiling assertions into deterministic checks (docs/06 §5, risk R6): one check per clause, state checks,
// text in elements without a locator, counts, and refusing checks that can't tell true from false.
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryPlanStore } from '../src/cache/store.js';
import { resolveConfig } from '../src/config.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import { Ai, type ProposedCheck } from '../src/step/ai.js';
import { useBrowser } from './browser.js';

const { page: open } = useBrowser();
const TEST = 'todos > checks';

const TODOS = `<main>
  <ul data-testid="todo-list">
    <li data-testid="todo-item"><input type="checkbox" aria-label="Toggle Todo" checked><span data-testid="todo-title">Buy milk</span></li>
    <li data-testid="todo-item"><input type="checkbox" aria-label="Toggle Todo"><span data-testid="todo-title">Walk the dog</span></li>
    <li data-testid="todo-item"><input type="checkbox" aria-label="Toggle Todo"><span data-testid="todo-title">Call mum</span></li>
  </ul>
  <span data-testid="todo-count"><strong>2</strong> items left</span>
  <button disabled>Clear completed</button>
</main>`;

const openTodos = (): Promise<Page> => open(TODOS);

function makeAi(page: Page, provider: FakeProvider, store: MemoryPlanStore) {
  return new Ai({
    page,
    provider,
    playwrightTestIdAttribute: 'data-testid',
    config: resolveConfig({ settle: { maxMs: 300, networkQuietMs: 0, snapshotIntervalMs: 20 } }),
    cache: { store, testTitle: TEST },
  });
}

/** The ref of the n-th snapshot line containing `text`. */
const refOf = (prompt: string, text: string, nth = 0) => {
  const line = prompt.split('\n').filter((l) => l.includes(text))[nth] ?? '';
  const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
  if (!ref) throw new Error(`no ref for "${text}"`);
  return ref;
};

/** A judge that passes and proposes the checks built from the prompt. */
const judge = (checks: (prompt: string) => ProposedCheck[]) =>
  new FakeProvider(
    [],
    [(req: { prompt: string }) => ({ pass: true, reason: 'ok', evidence: [], checks: checks(req.prompt) })],
  );

const check = (
  expect: ProposedCheck['expect'],
  ref: string | null,
  args: string[] = [],
  not = false,
): ProposedCheck => ({
  expect,
  ref,
  args,
  not,
});

const compiledOf = (store: MemoryPlanStore) => Object.values(store.file.tests[TEST]!)[0]!.compiled;

describe('assert compiles to deterministic checks', () => {
  it('compiles one check per clause, and replay fails as soon as one clause is false', async () => {
    const store = new MemoryPlanStore();
    const page = await openTodos();
    const condition = '"Buy milk" is completed and "Walk the dog" is not';
    await makeAi(
      page,
      judge((p) => [
        check('toBeChecked', refOf(p, 'checkbox "Toggle Todo"', 0)),
        check('toBeChecked', refOf(p, 'checkbox "Toggle Todo"', 1), [], true),
      ]),
      store,
    ).assert(condition);
    expect(compiledOf(store)).toHaveLength(2);
    expect(compiledOf(store)![0]!.target!.locators[0]!.display).toContain('Buy milk');

    const replayer = new FakeProvider();
    await expect(makeAi(page, replayer, store).assert(condition)).resolves.toMatchObject({ pass: true });
    expect(replayer.structuredRequests).toHaveLength(0);

    // Tick "Walk the dog": the second clause is now false, so the cached checks fail and the AI re-judges.
    await page.getByRole('checkbox').nth(1).check();
    const rejudge = new FakeProvider([], [{ pass: false, reason: 'both done', evidence: [], checks: [] }]);
    await expect(makeAi(page, rejudge, store).assert(condition, { timeout: 200 })).rejects.toThrow(
      /AI assertion failed/,
    );
    expect(rejudge.structuredRequests).toHaveLength(1);
  });

  it('refuses a visibility check on a control when the assertion is about its state', async () => {
    const store = new MemoryPlanStore();
    await makeAi(
      await openTodos(),
      judge((p) => [check('toBeVisible', refOf(p, 'checkbox "Toggle Todo"', 0))]),
      store,
    ).assert('"Buy milk" is shown as completed');
    expect(compiledOf(store)).toBeNull();
  });

  it('is all or nothing: one clause that cannot compile leaves the step AI-judged', async () => {
    const store = new MemoryPlanStore();
    await makeAi(
      await openTodos(),
      judge((p) => [check('toBeChecked', refOf(p, 'checkbox "Toggle Todo"', 0)), check('toHaveText', 'e999', ['x'])]),
      store,
    ).assert('"Buy milk" is done and something else');
    expect(compiledOf(store)).toBeNull();
  });

  it('checks text in an element without a locator on its nearest locatable ancestor', async () => {
    const store = new MemoryPlanStore();
    const page = await openTodos();
    await makeAi(
      page,
      judge((p) => [check('toHaveText', refOf(p, 'strong'), ['2'])]),
      store,
    ).assert('2 items are left');
    expect(compiledOf(store)).toEqual([
      expect.objectContaining({
        expect: 'toContainText',
        args: ['2'],
        target: expect.objectContaining({
          locators: [expect.objectContaining({ display: "getByTestId('todo-count')" })],
        }),
      }),
    ]);
  });

  it('compiles toHaveCount to a locator that matches every item', async () => {
    const store = new MemoryPlanStore();
    const page = await openTodos();
    await makeAi(
      page,
      judge((p) => [check('toHaveCount', refOf(p, 'listitem'), ['3'])]),
      store,
    ).assert('There are 3 todos');
    expect(compiledOf(store)![0]!.target!.locators[0]!.display).toBe("getByTestId('todo-item')");

    await page.evaluate(() => document.querySelector('li')!.remove());
    const rejudge = new FakeProvider([], [{ pass: false, reason: 'two', evidence: [], checks: [] }]);
    await expect(makeAi(page, rejudge, store).assert('There are 3 todos', { timeout: 200 })).rejects.toThrow();
  });

  it('compiles enabled and disabled checks', async () => {
    const store = new MemoryPlanStore();
    const page = await openTodos();
    await makeAi(
      page,
      judge((p) => [check('toBeDisabled', refOf(p, 'button "Clear completed"'))]),
      store,
    ).assert('Clear completed is disabled');
    expect(compiledOf(store)).toEqual([expect.objectContaining({ expect: 'toBeDisabled' })]);
    const replayer = new FakeProvider();
    await expect(makeAi(page, replayer, store).assert('Clear completed is disabled')).resolves.toMatchObject({
      pass: true,
    });
    expect(replayer.structuredRequests).toHaveLength(0);
  });
});

describe('extract replay', () => {
  const todos = z.array(z.object({ title: z.string(), completed: z.boolean() }));

  it('replays booleans read from checkboxes', async () => {
    const store = new MemoryPlanStore();
    const page = await openTodos();
    const recorder = new FakeProvider(
      [],
      [
        (req: { prompt: string }) => ({
          value: [
            { title: 'Buy milk', completed: true },
            { title: 'Walk the dog', completed: false },
          ],
          note: null,
          sources: [
            { path: '0.title', ref: refOf(req.prompt, 'listitem', 0) },
            { path: '0.completed', ref: refOf(req.prompt, 'checkbox', 0) },
            { path: '1.title', ref: refOf(req.prompt, 'listitem', 1) },
            { path: '1.completed', ref: refOf(req.prompt, 'checkbox', 1) },
          ],
        }),
      ],
    );
    await makeAi(page, recorder, store).extract('the first two todos', todos);
    await page.getByRole('checkbox').nth(1).check();
    const replayer = new FakeProvider();
    await expect(makeAi(page, replayer, store).extract('the first two todos', todos)).resolves.toEqual([
      { title: 'Buy milk', completed: true },
      { title: 'Walk the dog', completed: true },
    ]);
    expect(replayer.structuredRequests).toHaveLength(0);
  });

  it('does not rewrite an AI-only extract plan on every run', async () => {
    const store = new MemoryPlanStore();
    const page = await openTodos();
    const answer = { value: 2, note: null, sources: [] };
    await makeAi(page, new FakeProvider([], [answer]), store).extract('items left', z.number());
    const before = JSON.stringify(store.file);
    const events: string[] = [];
    const ai = makeAi(page, new FakeProvider([], [answer]), store);
    ai.events.on((e) => e.type === 'cache' && events.push(e.outcome));
    await expect(ai.extract('items left', z.number())).resolves.toBe(2);
    expect(JSON.stringify(store.file)).toBe(before);
    expect(events).not.toContain('broken');
  });
});
