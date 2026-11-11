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
    expect(Object.values(store.file.tests[TEST]!)[0]!.note).toBe(
      'check 1 (toBeVisible): a visible checkbox says nothing about its state',
    );
  });

  it('is all or nothing: one clause that cannot compile leaves the step AI-judged', async () => {
    const store = new MemoryPlanStore();
    await makeAi(
      await openTodos(),
      judge((p) => [check('toBeChecked', refOf(p, 'checkbox "Toggle Todo"', 0)), check('toHaveText', 'e999', ['x'])]),
      store,
    ).assert('"Buy milk" is done and something else');
    expect(compiledOf(store)).toBeNull();
    expect(Object.values(store.file.tests[TEST]!)[0]!.note).toBe(
      'check 2 (toHaveText ["x"]): ref "e999" is not in the snapshot',
    );
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

  it('counts same-name buttons inside a plain wrapper, not every button', async () => {
    const store = new MemoryPlanStore();
    const page = await open(
      '<main id="content"><button>Add Element</button><div id="elements"><button>Delete</button><button>Delete</button><button>Delete</button></div></main>',
    );
    await makeAi(
      page,
      judge((p) => [check('toHaveCount', refOf(p, 'button "Delete"'), ['3'])]),
      store,
    ).assert('Exactly three Delete buttons are left');
    expect(compiledOf(store)![0]!.target!.locators[0]!.display).toBe(
      "locator('[id=\"elements\"]').getByRole('button', { name: 'Delete', exact: true })",
    );
  });

  it('compiles a text check with no ref to the element that shows the text', async () => {
    const store = new MemoryPlanStore();
    const page = await open('<div id="flash" class="flash error">Your password is invalid! <a href="#">×</a></div>');
    await makeAi(
      page,
      judge(() => [check('toContainText', null, ['Your password is invalid!'])]),
      store,
    ).assert('An error says the password is invalid');
    const [compiled] = compiledOf(store)!;
    expect(compiled).toMatchObject({ expect: 'toContainText', args: ['Your password is invalid!'] });
    expect(compiled!.target!.locators[0]!.display).toBe('locator(\'[id="flash"]\')');
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

describe('assert timeout', () => {
  it('gives the page its timeout even when a judgement takes longer than that', async () => {
    const page = await open('<main><h1>Loading…</h1></main>');
    // The heading appears 300 ms in, while the first (slow) judgement is still running.
    void page.evaluate(() => setTimeout(() => (document.querySelector('h1')!.textContent = 'Excavator'), 300));
    const slow = (verdict: object) => () => new Promise((r) => setTimeout(() => r(verdict), 600));
    const provider = new FakeProvider(
      [],
      [
        slow({ pass: false, reason: 'still loading', evidence: [], checks: [] }),
        slow({ pass: true, reason: 'shown', evidence: ['Excavator'], checks: [] }),
      ],
    );
    await expect(
      makeAi(page, provider, new MemoryPlanStore()).assert('The Excavator page is shown', { timeout: 400 }),
    ).resolves.toMatchObject({ pass: true });
    expect(provider.structuredRequests).toHaveLength(2);
  });
});

describe('relational text checks', () => {
  const USERS = `<table><thead><tr><th>Name</th><th>Status</th></tr></thead><tbody>
    <tr><td>Thandi Mokoena</td><td>Active</td></tr>
    <tr><td>Sipho Dlamini</td><td>Disabled</td></tr>
  </tbody></table>`;

  it('anchors a text check in its row, so swapped values fail on replay', async () => {
    const store = new MemoryPlanStore();
    const page = await open(USERS);
    const condition = 'Thandi Mokoena is Active';
    await makeAi(
      page,
      judge((p) => [check('toHaveText', refOf(p, 'cell "Active"'), ['Active'])]),
      store,
    ).assert(condition);
    expect(compiledOf(store)![0]!.target!.locators[0]!.display).toBe(
      "locator('tr').filter({ hasText: 'Thandi Mokoena' }).getByRole('cell', { name: 'Active', exact: true })",
    );

    await page.evaluate(() => {
      const cells = document.querySelectorAll('tbody td:nth-child(2)');
      cells[0]!.textContent = 'Disabled';
      cells[1]!.textContent = 'Active';
    });
    const rejudge = new FakeProvider([], [{ pass: false, reason: 'Disabled', evidence: [], checks: [] }]);
    await expect(makeAi(page, rejudge, store).assert(condition, { timeout: 200 })).rejects.toThrow(
      /AI assertion failed/,
    );
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
          found: true,
          expand: null,
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

  it('locates sources without their values, so changed values replay with no AI', async () => {
    const table = (a: string, b: string) =>
      `<table><tbody id="rows"><tr><td>Thandi Mokoena</td><td>${a}</td></tr><tr><td>Sipho Dlamini</td><td>${b}</td></tr></tbody></table>`;
    const users = z.array(z.object({ name: z.string(), status: z.string() }));
    const store = new MemoryPlanStore();
    const recorder = new FakeProvider(
      [],
      [
        (req: { prompt: string }) => ({
          value: [
            { name: 'Thandi Mokoena', status: 'Active' },
            { name: 'Sipho Dlamini', status: 'Disabled' },
          ],
          found: true,
          expand: null,
          note: null,
          sources: [
            { path: '0.name', ref: refOf(req.prompt, 'cell "Thandi Mokoena"') },
            { path: '0.status', ref: refOf(req.prompt, 'cell "Active"') },
            { path: '1.name', ref: refOf(req.prompt, 'cell "Sipho Dlamini"') },
            { path: '1.status', ref: refOf(req.prompt, 'cell "Disabled"') },
          ],
        }),
      ],
    );
    await makeAi(await open(table('Active', 'Disabled')), recorder, store).extract('the users', users);
    const sources = Object.values(store.file.tests[TEST]!)[0]!.sources!;
    for (const s of sources) expect(s.target.locators[0]!.display).not.toMatch(/Active|Disabled/);

    const replayer = new FakeProvider();
    await expect(
      makeAi(await open(table('Locked', 'Active')), replayer, store).extract('the users', users),
    ).resolves.toEqual([
      { name: 'Thandi Mokoena', status: 'Locked' },
      { name: 'Sipho Dlamini', status: 'Active' },
    ]);
    expect(replayer.structuredRequests).toHaveLength(0);
  });

  it('expands a collapsed list or truncated subtree when the model says the value is inside it', async () => {
    // Many sections of nested content: over budget, pruning cuts subtrees ("… N nodes truncated (call expand …)").
    const section = (i: number, extra = '') =>
      `<section aria-label="Part ${i}"><h2>Part ${i}</h2><ul>${Array.from({ length: 6 }, (_, j) => `<li><a href="#p${i}-${j}">Detail ${i}.${j} about the mountain range</a></li>`).join('')}${extra}</ul></section>`;
    const parts = Array.from({ length: 40 }, (_, i) => section(i, i === 30 ? '<li>Elevation: 1,085 m</li>' : ''));
    const page = await open(`<main>${parts.join('')}</main>`);
    // A model that follows the expand hints: "Part 30" is first hidden in a collapsed list ("… 28 more region items
    // (call expand with ref=…)"), then its own items are truncated.
    const model = (req: { prompt: string }) => {
      const answer = { expand: null as string | null, value: 1085, note: null, sources: [] };
      if (req.prompt.includes('1,085 m')) return { ...answer, found: true };
      const lines = req.prompt.split('\n');
      const part30 = lines.findIndex((l) => l.includes('"Part 30"'));
      const where =
        part30 >= 0 ? lines.slice(part30).join('\n') : (lines.find((l) => l.includes('more region items')) ?? '');
      return { ...answer, found: false, expand: /call expand with ref=(e\d+)/.exec(where)?.[1] ?? null };
    };
    const provider = new FakeProvider([], [model, model, model]);
    const ai = new Ai({
      page,
      provider,
      config: resolveConfig({ snapshot: { maxTokens: 500 }, settle: { maxMs: 300, networkQuietMs: 0 } }),
    });
    await expect(ai.extract('the elevation in metres', z.number())).resolves.toBe(1085);
    expect(provider.structuredRequests.length).toBeGreaterThan(1);
  });

  it('fails clearly when the value is not on the page, instead of returning a placeholder', async () => {
    const provider = new FakeProvider(
      [],
      [{ found: false, expand: null, value: 0, note: 'No elevation row in the snapshot', sources: [] }],
    );
    await expect(
      makeAi(await openTodos(), provider, new MemoryPlanStore()).extract('the elevation', z.number()),
    ).rejects.toThrow(/AI extract failed: the elevation\nNot on the page: No elevation row in the snapshot/);
  });

  it('does not rewrite an AI-only extract plan on every run', async () => {
    const store = new MemoryPlanStore();
    const page = await openTodos();
    const answer = { value: 2, found: true, expand: null, note: null, sources: [] };
    await makeAi(page, new FakeProvider([], [answer]), store).extract('items left', z.number());
    const before = JSON.stringify(store.file);
    const events: string[] = [];
    const ai = makeAi(page, new FakeProvider([], [answer]), store);
    ai.events.on((e) => e.type === 'cache' && events.push(e.outcome));
    await expect(ai.extract('items left', z.number())).resolves.toBe(2);
    expect(JSON.stringify(store.file)).toBe(before);
    expect(Object.values(store.file.tests[TEST]!)[0]!.note).toBe('the model gave no sources');
    expect(events).not.toContain('broken');
  });
});

describe('expected text that quotes a total ("1 of 1,396")', () => {
  const RESULTS = (total: string) => `<main><nav aria-label="Pagination">
    <a href="#1">Previous page<span> : 1 of ${total}</span></a>
    <a href="#3">Next page<span> : 3 of ${total}</span></a></nav></main>`;
  const proposeTotal = () => judge((p) => [check('toContainText', refOf(p, 'link "Previous page'), ['1 of 1,395'])]);

  it('keeps "1 of" and drops the total, so the check replays when the site gains a page', async () => {
    const store = new MemoryPlanStore();
    await makeAi(await open(RESULTS('1,395')), proposeTotal(), store).assert('The results are page 2');
    expect(compiledOf(store)).toEqual([
      expect.objectContaining({
        expect: 'toContainText',
        args: ['1 of'],
        target: expect.objectContaining({
          locators: [
            expect.objectContaining({ display: "getByRole('link', { name: 'Previous page' })" }),
            expect.anything(), // the exact name, as a fallback
          ],
        }),
      }),
    ]);
    // A new total: replays from the plan, no model (a FakeProvider with no answers throws if asked).
    const verdict = await makeAi(await open(RESULTS('1,402')), new FakeProvider(), store).assert(
      'The results are page 2',
    );
    expect(verdict.pass).toBe(true);
  });

  it('keeps the total when the assertion itself names it', async () => {
    const store = new MemoryPlanStore();
    await makeAi(await open(RESULTS('1,395')), proposeTotal(), store).assert('This is page 2 of 1,395');
    expect(compiledOf(store)).toEqual([expect.objectContaining({ args: ['1 of 1,395'] })]);
  });
});

describe('extract sources that are only part of the value', () => {
  it('reads the whole counter when the model pointed at the number inside it', async () => {
    const store = new MemoryPlanStore();
    const page = await openTodos();
    // "2 items left", read from the <strong>2</strong>: that source alone reads back "2".
    const recorder = new FakeProvider(
      [],
      [
        (req: { prompt: string }) => ({
          value: '2 items left',
          found: true,
          expand: null,
          note: null,
          sources: [{ path: '', ref: refOf(req.prompt, 'strong') }],
        }),
      ],
    );
    await expect(makeAi(page, recorder, store).extract('the item counter', z.string())).resolves.toBe('2 items left');
    const plan = Object.values(store.file.tests[TEST]!)[0]!;
    expect(plan.sources?.[0]?.target.locators[0]?.display).toBe("getByTestId('todo-count')");

    // The page changes: the replay reads the new text, without the model.
    await page.getByTestId('todo-count').evaluate((el) => (el.innerHTML = '<strong>1</strong> item left'));
    const replayer = new FakeProvider();
    await expect(makeAi(page, replayer, store).extract('the item counter', z.string())).resolves.toBe('1 item left');
    expect(replayer.structuredRequests).toHaveLength(0);
  });
});

describe('a <select>', () => {
  const SELECT = `<main><label for="size">Size</label>
    <select id="size"><option value="">Choose</option><option value="s">Small</option><option value="l" selected>Large</option></select></main>`;

  it('compiles "shows Large" to the value of that option: its text is every option, whichever is selected', async () => {
    const store = new MemoryPlanStore();
    const page = await open(SELECT);
    await makeAi(
      page,
      judge((p) => [check('toContainText', refOf(p, 'combobox'), ['Large'])]),
      store,
    ).assert('Large is selected');
    expect(compiledOf(store)).toEqual([expect.objectContaining({ expect: 'toHaveValue', args: ['l'] })]);

    // Another option is selected: the replayed check fails and the model is asked again (here: it says no).
    await page.selectOption('#size', 's');
    const rejudge = new FakeProvider([], [{ pass: false, reason: 'Small is selected', evidence: [], checks: [] }]);
    await expect(makeAi(page, rejudge, store).assert('Large is selected')).rejects.toThrow('Small is selected');
  });

  it('is read as the label of the selected option, and replays when the selection changes', async () => {
    const store = new MemoryPlanStore();
    const page = await open(SELECT);
    const recorder = new FakeProvider(
      [],
      [
        (req: { prompt: string }) => ({
          value: 'Large',
          found: true,
          expand: null,
          note: null,
          sources: [{ path: '', ref: refOf(req.prompt, 'combobox') }],
        }),
      ],
    );
    await expect(makeAi(page, recorder, store).extract('the selected size', z.string())).resolves.toBe('Large');
    await page.selectOption('#size', 's');
    const replayer = new FakeProvider();
    await expect(makeAi(page, replayer, store).extract('the selected size', z.string())).resolves.toBe('Small');
    expect(replayer.structuredRequests).toHaveLength(0);
  });
});
