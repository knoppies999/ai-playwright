import { describe, expect, it } from 'vitest';
import { lintHints } from '../src/hints.js';
import { checkSummary, parseSummaryArgs } from '../src/summary.js';

const run = (requests: number, costUsd?: number) => ({
  tests: 3,
  steps: { total: 10, cache: 8, ai: 1, healed: 1, failed: 0 },
  usage: { requests, inputTokens: 0, outputTokens: 0 },
  ...(costUsd !== undefined && { costUsd }),
});

describe('aipw summary', () => {
  it('parses limits', () => {
    expect(parseSummaryArgs(['--max-llm-calls', '0'])).toEqual({ file: '.aipw/summary.json', maxLlmCalls: 0 });
    expect(parseSummaryArgs(['--max-cost', '2.5', '--file', 'x.json'])).toEqual({ file: 'x.json', maxCost: 2.5 });
    expect(parseSummaryArgs(['--max-llm-calls', '-1'])).toMatchObject({ error: expect.stringContaining('whole') });
  });

  it('fails a PR gate run that called the model, and explains how to fix it', () => {
    expect(checkSummary(run(0), { file: '', maxLlmCalls: 0 })).toEqual([]);
    expect(checkSummary(run(2), { file: '', maxLlmCalls: 0 })).toEqual([
      '2 LLM calls (allowed 0): 1 steps ran with the AI and 1 healed. Record or refresh their plans locally (AIPW_CACHE=auto) and commit the plan files.',
    ]);
    expect(checkSummary(run(5, 3.2), { file: '', maxCost: 2 })).toEqual(['estimated cost $3.20 (allowed $2.00)']);
  });
});

describe('aipw hints lint', () => {
  it('flags duplicates, repeated sections, hints outside sections and size', () => {
    const text = [
      '# Site: localhost:5173',
      '- floating hint',
      '## Everywhere',
      '- Settings is a hover flyout in the header.',
      '- settings is a hover  flyout in the header.',
      '## /users/new',
      '- Settings is a hover flyout in the header.',
      '## Everywhere',
    ].join('\n');
    expect(lintHints('localhost-5173.md', text).map((p) => [p.line, p.message])).toEqual([
      [2, 'hint outside a "## Everywhere" or "## /path" section is never loaded'],
      [5, 'duplicate of line 4'],
      [8, 'section "## Everywhere" repeats line 3'],
    ]);
    const big = `## Everywhere\n${Array.from({ length: 70 }, (_, i) => `- hint ${i} ${'x'.repeat(90)}`).join('\n')}`;
    expect(lintHints('big.md', big).at(-1)!.message).toMatch(/characters of hints; a page loads at most 6000/);
  });
});
