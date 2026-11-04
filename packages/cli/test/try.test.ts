import { describe, expect, it } from 'vitest';
import { parseTryArgs, specFor } from '../src/try.js';

describe('aipw try', () => {
  it('parses a URL, steps and options', () => {
    expect(
      parseTryArgs(['https://x.test', 'Add a todo', '--headed', 'Verify that 1 item is left', '--save', 'a.spec.ts']),
    ).toEqual({
      url: 'https://x.test',
      steps: ['Add a todo', 'Verify that 1 item is left'],
      headed: true,
      save: 'a.spec.ts',
    });
    expect(parseTryArgs(['not-a-url', 'step'])).toMatchObject({ error: expect.stringContaining('Usage') });
    expect(parseTryArgs(['https://x.test'])).toMatchObject({ url: 'https://x.test', steps: [] });
  });

  it('writes a spec with the steps as ai calls, and what was read as expectations', () => {
    const spec = specFor(
      'https://demo.playwright.dev/todomvc/',
      ["Add a todo named O'Brien", 'Verify that 1 item is left', 'Read the item counter as counter'],
      { counter: '1 item left' },
    );
    expect(spec).toContain("import { expect, test } from '@aipw/test';");
    expect(spec).toContain("import { z } from 'zod';");
    expect(spec).toContain("  await ai.act('Add a todo named O\\'Brien');");
    expect(spec).toContain("  await ai.assert('1 item is left');");
    expect(spec).toContain("  const counter = await ai.extract('the item counter', z.string());");
    expect(spec).toContain("  expect(counter).toBe('1 item left'); // seen during aipw try");
  });
});
