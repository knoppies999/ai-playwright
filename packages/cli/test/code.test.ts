import type { PlanFile, PlanTarget, StepPlan } from '@aipw/core';
import { describe, expect, it } from 'vitest';
import { codeValue, plansToCode, stepCode } from '../src/code.js';

const target = (display: string): PlanTarget => ({ role: 'button', locators: [{ rung: 'L1', expr: [], display }] });
const recordedWith = { provider: 'fake', model: 'fake', at: '2026-11-03T00:00:00Z' };
const plan = (p: Partial<StepPlan> & Pick<StepPlan, 'kind' | 'instruction'>): StepPlan => ({
  recordedWith,
  stats: { heals: 0 },
  ...p,
});

describe('aipw cache code', () => {
  it('turns placeholders into identifiers and keeps literals literal', () => {
    expect(codeValue('{{data.email}}')).toBe('data.email');
    expect(codeValue('{{secret.password}}')).toBe("secret('password')");
    expect(codeValue("O'Brien")).toBe("'O\\'Brien'");
    expect(codeValue('Hi {{data.name}}')).toBe("'Hi {{data.name}}' /* TODO: placeholder */");
  });

  it('writes the Playwright for an act, an assert, and steps it cannot express', () => {
    expect(
      stepCode(
        plan({
          kind: 'act',
          instruction: 'Add a todo',
          actions: [
            { tool: 'type', args: { text: 'Buy milk', submit: true }, target: target("getByRole('textbox')") },
            { tool: 'wait_for', args: { text: 'Saved', ms: null, state: null } },
            { tool: 'click', args: { clickCount: 1 }, target: { role: 'button', locators: [] } },
          ],
        }),
      ),
    ).toEqual([
      "// ai.act('Add a todo')",
      "await page.getByRole('textbox').pressSequentially('Buy milk');",
      "await page.getByRole('textbox').press('Enter');",
      "await page.getByText('Saved').first().waitFor();",
      '// click button: no stored locator (heals by AI on replay)',
    ]);
    expect(
      stepCode(
        plan({
          kind: 'assert',
          instruction: 'Saved and on /users',
          compiled: [
            { expect: 'toHaveCount', args: ['3'], target: target("getByTestId('row')") },
            { expect: 'toHaveURL', args: ['/users?tab=1'] },
            { expect: 'toBeChecked', args: [], not: true, target: target("getByRole('checkbox')") },
          ],
        }),
      ),
    ).toEqual([
      "// ai.assert('Saved and on /users')",
      "await expect(page.getByTestId('row')).toHaveCount(3);",
      'await expect(page).toHaveURL(/\\/users\\?tab=1/);',
      "await expect(page.getByRole('checkbox')).not.toBeChecked();",
    ]);
    expect(stepCode(plan({ kind: 'assert', instruction: 'Looks right', compiled: null, note: 'vague' }))).toEqual([
      "// ai.assert('Looks right'): judged by the AI on every run, no code equivalent (vague)",
    ]);
  });

  it('orders steps as the spec does', () => {
    const file: PlanFile = {
      version: 1,
      tests: {
        't > one': {
          b: plan({ kind: 'assert', instruction: 'Saved', compiled: null }),
          a: plan({ kind: 'act', instruction: 'Save', actions: [] }),
        },
      },
    };
    const code = plansToCode(file, "await ai.act('Save');\nawait ai.assert('Saved');");
    expect(code.indexOf("ai.act('Save')")).toBeLessThan(code.indexOf("ai.assert('Saved')"));
  });
});
