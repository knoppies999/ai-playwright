import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../src/llm/fake-provider.js';
import { codeRemedy, remedyPrompt, synthesizeRemedy, targetFacts } from '../src/nudge/remedy.js';
import type { ActionRecord } from '../src/types.js';

const rec = (
  tool: string,
  args: Record<string, unknown>,
  display?: string,
  extra: Partial<ActionRecord> = {},
): ActionRecord => ({
  tool,
  args,
  result: 'ok',
  before: { url: 'http://app.test/', snapshotHash: 'a' },
  after: { url: 'http://app.test/' },
  durationMs: 1,
  ...(display && {
    target: { ref: 'e1', role: 'button', name: 'Settings', candidates: [{ rung: 'L2' as const, expr: [], display }] },
  }),
  ...extra,
});

describe('code remedy', () => {
  it('turns the corrected actions into Playwright code with their verified locators', () => {
    expect(
      codeRemedy([
        rec('hover', { ref: 'e1' }, "getByRole('button', { name: 'Settings' })"),
        rec('click', { ref: 'e2' }, "getByRole('menuitem', { name: 'Users', exact: true })"),
        rec('fill', { ref: 'e3', value: "O'Brien" }, "getByLabel('Last name')"),
        rec('fill', { ref: 'e4', value: '{{secret.password}}' }, "getByLabel('Password')"),
        rec('press', { key: 'Escape', ref: null }),
        rec('click', { ref: 'e9' }, undefined, { target: { ref: 'e9', role: 'img', name: 'chart', candidates: [] } }),
        rec('click', { ref: 'e5' }, "getByText('x')", { result: 'Error: timeout' }),
      ]),
    ).toEqual([
      "await page.getByRole('button', { name: 'Settings' }).hover();",
      "await page.getByRole('menuitem', { name: 'Users', exact: true }).click();",
      "await page.getByLabel('Last name').fill('O\\'Brien');",
      "await page.getByLabel('Password').fill('{{secret.password}}' /* TODO: replace placeholder */);",
      "await page.keyboard.press('Escape');",
      '// click img "chart": no durable locator, do this step by hand',
    ]);
  });
});

describe('target facts', () => {
  const on = (tool: string, role: string, name: string, result = 'ok') =>
    rec(tool, { ref: 'e1' }, undefined, { result, target: { ref: 'e1', role, name, candidates: [] } });

  it('notes hover menus, the wording gap and what the agent chose instead', () => {
    expect(
      targetFacts(
        'Open Settings > Users',
        [on('click', 'link', 'User groups', 'undone by the person running the test')],
        [on('hover', 'button', 'Settings'), on('click', 'menuitem', 'Users')],
      ),
    ).toEqual([
      'menuitem "Users" was reached by hovering button "Settings" first: it is in a menu that opens on hover.',
      'The instruction names the element correctly (menuitem "Users").',
      'The agent chose link "User groups" instead.',
    ]);
    expect(targetFacts('Open the people list', [], [on('click', 'link', 'Users')])).toEqual([
      'The element is link "Users"; the instruction does not use the words "users".',
    ]);
    expect(targetFacts('x', [], [])).toEqual([]);
  });
});

describe('remedy synthesis', () => {
  it('sends both trajectories and the human input, and validates the answer', async () => {
    const provider = new FakeProvider(
      [],
      [
        {
          diagnosis: 'Users is only in the Settings flyout, which opens on hover.',
          category: 'hidden-in-menu',
          revisedInstruction: 'Hover "Settings" in the header, then click "Users"',
          splitInto: null,
          hint: {
            scope: 'site',
            pathPattern: null,
            text: 'Users and Roles are in the Settings flyout in the header; hover it to open it.',
          },
        },
      ],
    );
    const input = {
      instruction: 'Open Settings > Users',
      failed: [
        rec('click', { ref: 'e8', intent: 'open user groups' }, undefined, {
          target: { ref: 'e8', role: 'link', name: 'User groups', candidates: [] },
        }),
      ],
      corrected: [rec('hover', { ref: 'e1' }, "getByRole('button', { name: 'Settings' })")],
      humanInput: ['it is under the gear icon'],
      targetFacts: ['"Users" was not in the snapshot: it is inside a closed menu'],
    };
    const { remedy } = await synthesizeRemedy(provider, input);
    expect(remedy.category).toBe('hidden-in-menu');
    const prompt = provider.structuredRequests[0]!.prompt;
    expect(prompt).toBe(remedyPrompt(input));
    expect(prompt).toContain('#1 click link "User groups" [e8]');
    expect(prompt).toContain('- it is under the gear icon');
  });
});
