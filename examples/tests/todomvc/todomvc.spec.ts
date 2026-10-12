// TodoMVC (demo.playwright.dev/todomvc): fast, static, no ads. Real AI calls (tagged @llm).
//   npx playwright test --project todomvc --headed
// Setup that isn't under test (seeding todos) is done in code; the AI does the part being tested.
// Code assertions back up the AI's where they are cheap (risk R6).
import { expect, test, type Page } from '@aipw/test';
import { z } from 'zod';

/** Adds todos directly, without the AI. */
async function seed(page: Page, ...titles: string[]) {
  const input = page.getByPlaceholder('What needs to be done?');
  for (const title of titles) {
    await input.fill(title);
    await input.press('Enter');
  }
}

const titles = (page: Page) => page.getByTestId('todo-title').allInnerTexts();
const counter = (page: Page) => page.getByTestId('todo-count');

test.describe('TodoMVC: short tasks', { tag: '@llm' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
    await expect(page.getByPlaceholder('What needs to be done?')).toBeVisible();
  });

  test('add a todo', async ({ page, ai }) => {
    await ai.act('Add a todo "Buy milk"');
    await ai.assert('"Buy milk" is in the list and 1 item is left');
    expect(await titles(page)).toEqual(['Buy milk']);
  });

  test('add several todos in one step', async ({ page, ai }) => {
    await ai.act('Add the first, second and third todos from the data, in that order', {
      data: { first: 'Book flights', second: 'Pack bags', third: 'Water the plants' },
    });
    expect(await titles(page)).toEqual(['Book flights', 'Pack bags', 'Water the plants']);
    await expect(counter(page)).toHaveText('3 items left');
  });

  test('complete a todo', async ({ page, ai }) => {
    await seed(page, 'Buy milk', 'Walk the dog');
    await ai.act('Mark "Walk the dog" as done');
    await ai.assert('"Walk the dog" is shown as completed and "Buy milk" is not');
    await expect(page.getByTestId('todo-item').filter({ hasText: 'Walk the dog' })).toHaveClass(/completed/);
    await expect(counter(page)).toHaveText('1 item left');
  });

  test('edit a todo (double-click)', async ({ page, ai }) => {
    await seed(page, 'Buy milk');
    await ai.act('Change "Buy milk" to "Buy oat milk"');
    expect(await titles(page)).toEqual(['Buy oat milk']);
  });

  test('delete a todo (the × only shows on hover)', async ({ page, ai }) => {
    await seed(page, 'Buy milk', 'Walk the dog', 'Call mum');
    await ai.act('Delete "Walk the dog"');
    expect(await titles(page)).toEqual(['Buy milk', 'Call mum']);
  });

  test('filter active and completed', async ({ page, ai }) => {
    await seed(page, 'Buy milk', 'Walk the dog', 'Call mum');
    await page.getByTestId('todo-item').filter({ hasText: 'Call mum' }).getByRole('checkbox').check();
    await ai.act('Show only the completed todos');
    expect(await titles(page)).toEqual(['Call mum']);
    await ai.act('Now show only the active ones');
    expect(await titles(page)).toEqual(['Buy milk', 'Walk the dog']);
  });

  test('an empty todo is not added', async ({ page, ai }) => {
    await ai.act('Try to add a todo with no text: press Enter in the empty input');
    await expect(page.getByTestId('todo-item')).toHaveCount(0);
  });
});

test.describe('TodoMVC: journeys', { tag: '@llm' }, () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
  });

  test('plan a week, finish some, tidy up, and it survives a reload', async ({ page, ai }) => {
    await ai.act('Add five todos for the week: groceries, gym, dentist, call the bank, fix the bike');
    await expect(page.getByTestId('todo-item')).toHaveCount(5);
    await ai.act('Mark "gym" and "dentist" as done');
    await ai.assert('3 items are left');
    await ai.act('Clear the completed todos');
    expect(await titles(page)).toEqual(['groceries', 'call the bank', 'fix the bike']);
    await page.reload();
    await ai.assert('After the reload the same three todos are still there');
    expect(await titles(page)).toEqual(['groceries', 'call the bank', 'fix the bike']);
  });

  test('complete everything at once, then undo it', async ({ page, ai }) => {
    await seed(page, 'Buy milk', 'Walk the dog', 'Call mum');
    await ai.act('Mark all todos as complete with one click');
    await expect(counter(page)).toHaveText('0 items left');
    await ai.act('Undo that: mark them all as not complete again');
    await expect(counter(page)).toHaveText('3 items left');
  });

  test('cancel an edit with Escape', async ({ page, ai }) => {
    await seed(page, 'Buy milk');
    await ai.act('Start editing "Buy milk", type "Buy cheese" instead, then press Escape to cancel');
    await ai.assert('The todo still says "Buy milk"');
    expect(await titles(page)).toEqual(['Buy milk']);
  });

  test('read the list back', async ({ page, ai }) => {
    await seed(page, 'Buy milk', 'Walk the dog', 'Call mum');
    await page.getByTestId('todo-item').filter({ hasText: 'Buy milk' }).getByRole('checkbox').check();
    const list = await ai.extract(
      'every todo with whether it is completed, in order, and the number of items left',
      z.object({
        todos: z.array(z.object({ title: z.string(), completed: z.boolean() })),
        itemsLeft: z.number(),
      }),
    );
    expect(list).toEqual({
      todos: [
        { title: 'Buy milk', completed: true },
        { title: 'Walk the dog', completed: false },
        { title: 'Call mum', completed: false },
      ],
      itemsLeft: 2,
    });
  });
});
