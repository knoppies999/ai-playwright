// The Internet (the-internet.herokuapp.com): one awkward UI pattern per page. Real AI calls (tagged @llm).
//   npx playwright test --project the-internet --workers=1 --headed
// Short tasks first, then longer journeys. Code assertions back up the AI's where they are cheap (risk R6).
import { expect, test, type Page } from '@aipw/test';
import { z } from 'zod';
import { theInternet } from '../../targets/the-internet/target.js';

test.use({ aiConfig: { secrets: { map: { password: theInternet.secrets.password } } } });

/** The free host can answer 503 for a few seconds after idle: retry the first load. */
async function open(page: Page, path: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await page.goto(path);
    if (res?.ok()) return;
    await page.waitForTimeout(3000);
  }
  throw new Error(`${path} kept failing; is the-internet.herokuapp.com up?`);
}

/** The login page prints its demo password. Read it at run time so it is never in source, and treat it as a secret. */
async function demoPassword(page: Page): Promise<void> {
  const text = await page.locator('#content h4').innerText();
  const password = /and (\S+) for the password/.exec(text)?.[1];
  if (!password) throw new Error('The login page no longer shows the demo password');
  process.env[theInternet.secrets.password] = password;
}

test.describe('The Internet: short tasks', { tag: '@llm' }, () => {
  test('checkboxes', async ({ page, ai }) => {
    await open(page, '/checkboxes');
    await ai.act('Tick checkbox 1 and untick checkbox 2');
    await expect(page.getByRole('checkbox').nth(0)).toBeChecked();
    await expect(page.getByRole('checkbox').nth(1)).not.toBeChecked();
  });

  test('dropdown', async ({ page, ai }) => {
    await open(page, '/dropdown');
    await ai.act('Choose "Option 2" in the dropdown');
    await expect(page.locator('#dropdown')).toHaveValue('2');
  });

  test('hover to reveal a hidden link', async ({ page, ai }) => {
    await open(page, '/hovers');
    await ai.act("Hover over the second user's picture and open that user's profile");
    await expect(page).toHaveURL(/\/users\/2$/);
  });

  test('wait for content that loads late', async ({ page, ai }) => {
    await open(page, '/dynamic_loading/2');
    await ai.act('Click Start and wait until the loading has finished');
    await ai.assert('The page says "Hello World!"');
    await expect(page.getByText('Hello World!')).toBeVisible();
  });

  test('number input and arrow keys', async ({ page, ai }) => {
    await open(page, '/inputs');
    await ai.act('Type 42 into the number field, then press the Up arrow key twice');
    await expect(page.getByRole('spinbutton')).toHaveValue('44');
  });

  test('JavaScript prompt', async ({ page, ai }) => {
    await open(page, '/javascript_alerts');
    await ai.act('Click the button for a JS prompt, answer it with "aipw was here" and accept');
    await ai.assert('The result says I entered "aipw was here"');
    await expect(page.locator('#result')).toHaveText('You entered: aipw was here');
  });

  test('read a table and find the largest amount due', async ({ page, ai }) => {
    await open(page, '/tables');
    const people = await ai.extract(
      'every row of the first table: first name, last name and the amount due as a number',
      z.array(z.object({ firstName: z.string(), lastName: z.string(), due: z.number() })),
    );
    expect(people).toHaveLength(4);
    const top = people.reduce((a, b) => (b.due > a.due ? b : a));
    expect(top).toEqual({ firstName: 'Jason', lastName: 'Doe', due: 100 });
    expect(await page.locator('#table1 tbody tr').count()).toBe(4);
  });
});

test.describe('The Internet: journeys', { tag: '@llm' }, () => {
  test('log in, see the secure area, log out', async ({ page, ai }) => {
    await open(page, '/login');
    await demoPassword(page);
    await ai.act('Log in as tomsmith', { data: { username: 'tomsmith' }, secrets: ['password'] });
    await ai.assert('A message says I logged into a secure area');
    await expect(page).toHaveURL(/\/secure$/);
    await ai.act('Log out');
    await ai.assert('A message says I logged out of the secure area');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a wrong password is refused, then the right one works', async ({ page, ai }) => {
    await open(page, '/login');
    await demoPassword(page);
    await ai.act('Try to log in as tomsmith with this password', {
      data: { username: 'tomsmith', password: 'not-the-password' },
    });
    await ai.assert('An error says the password is invalid');
    await ai.act('Now log in as tomsmith with the correct password', {
      data: { username: 'tomsmith' },
      secrets: ['password'],
    });
    await expect(page).toHaveURL(/\/secure$/);
  });

  test('controls that appear, disappear and unlock', async ({ page, ai }) => {
    test.setTimeout(5 * 60_000);
    await open(page, '/dynamic_controls');
    await ai.act('Remove the checkbox and wait until it has gone');
    await ai.assert('A message says "It\'s gone!"');
    await expect(page.locator('#checkbox')).toHaveCount(0);
    await ai.act('Add the checkbox back and tick it');
    await expect(page.locator('#checkbox input')).toBeChecked();
    await ai.act('Enable the text field, then type "unlocked" into it');
    await expect(page.locator('#input-example input')).toHaveValue('unlocked');
    await ai.act('Disable the text field again');
    await ai.assert('A message says "It\'s disabled!"');
    await expect(page.locator('#input-example input')).toBeDisabled();
  });

  test('add and remove elements', async ({ page, ai }) => {
    await open(page, '/add_remove_elements/');
    await ai.act('Click "Add Element" five times');
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(5);
    await ai.act('Delete two of the added elements');
    await ai.assert('Exactly three Delete buttons are left');
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(3);
  });

  test('sort a table, then read it', async ({ page, ai }) => {
    await open(page, '/tables');
    await ai.act('Sort the first table by the Due column, smallest first');
    const dues = await ai.extract(
      'the amount due in each row of the first table, in order, as numbers',
      z.array(z.number()),
    );
    expect(dues).toEqual([...dues].sort((a, b) => a - b));
    await ai.act('Now sort the first table by last name');
    const lastNames = await ai.extract('the last names in the first table, in order', z.array(z.string()));
    const sorted = [...lastNames].sort((a, b) => a.localeCompare(b));
    // Either direction counts: the AI chooses how many times to click the header.
    expect([sorted, [...sorted].reverse()]).toContainEqual(lastNames);
  });
});
