import type { PauseState } from '@aipw/core';
import { describe, expect, it } from 'vitest';
import { formatPause, parseCommandLine, parseNudgeArgs, summarizeSession } from '../src/nudge.js';

const state: PauseState = {
  v: 1,
  reason: 'decision',
  breakLevel: 'action',
  test: { file: 'examples/tests/demo/heal.spec.ts', title: 'record on A' },
  step: { index: 2, id: 't:2', kind: 'act', instruction: 'Open Settings > Users', cached: false },
  decision: {
    turn: 0,
    tool: 'click',
    args: {},
    intent: 'open users',
    why: 'Users is the closest match',
    target: { ref: 'e52', role: 'menuitem', name: 'User groups' },
  },
  page: { url: 'http://localhost:5173/app', title: 'Demo', tabs: 1, dialogs: 0 },
  snapshot: '- button "Settings" [ref=e7]',
  history: ['#1 hover button "Settings" [e7] → ok'],
};

describe('aipw nudge arguments', () => {
  it('parses spec, break level, --at and --fresh', () => {
    expect(parseNudgeArgs(['tests/a.spec.ts:14', '--break', 'action', '--at', '3', '--fresh'])).toEqual({
      spec: 'tests/a.spec.ts:14',
      breakLevel: 'action',
      at: 3,
      fresh: true,
    });
    expect(parseNudgeArgs(['tests/a.spec.ts'])).toEqual({ spec: 'tests/a.spec.ts', breakLevel: 'step', fresh: false });
  });

  it('rejects bad input with a usable message', () => {
    expect(parseNudgeArgs([])).toMatchObject({ error: expect.stringContaining('Usage') });
    expect(parseNudgeArgs(['a.spec.ts', '--break', 'sometimes'])).toMatchObject({
      error: expect.stringContaining('--break'),
    });
    expect(parseNudgeArgs(['a.spec.ts', '--at', '0'])).toMatchObject({ error: expect.stringContaining('--at') });
  });
});

describe('nudge commands', () => {
  it.each([
    ['', { cmd: 'run' }],
    ['s', { cmd: 'skip' }],
    ['h it is under the gear icon', { cmd: 'hint', text: 'it is under the gear icon' }],
    ['e Hover Settings, then click Users', { cmd: 'edit', instruction: 'Hover Settings, then click Users' }],
    ['a OPS-07', { cmd: 'answer', text: 'OPS-07' }],
    ['c', { cmd: 'continue' }],
    ['b fail', { cmd: 'break', level: 'fail' }],
    ['r 1', { cmd: 'rewind', toStep: 1 }],
    ['r', { cmd: 'rewind', toStep: 2 }],
    ['q', { cmd: 'quit' }],
  ])('%j → %j', (line, expected) => {
    expect(parseCommandLine(line, state)).toEqual(expected);
  });

  it('keeps local actions local', () => {
    expect(parseCommandLine('v', state)).toEqual({ local: state.snapshot });
    expect(parseCommandLine('h', state)).toMatchObject({ local: expect.stringContaining('hint') });
    expect(parseCommandLine('e', state)).toEqual({ local: 'Current instruction: Open Settings > Users' });
    expect(parseCommandLine('b sometimes', state)).toMatchObject({ local: expect.stringContaining('Levels') });
    expect(parseCommandLine('', { ...state, reason: 'ask', question: 'Which?' })).toMatchObject({
      local: expect.stringContaining('answer'),
    });
  });
});

describe('nudge display and summary', () => {
  it('shows the decision, target, reasoning and history', () => {
    const text = formatPause(state);
    expect(text).toContain('Step 2  ai.act("Open Settings > Users")   plan: none (AI)');
    expect(text).toContain('Decision 1  click  menuitem "User groups" [e52]');
    expect(text).toContain('why    : Users is the closest match');
    expect(text).toContain('#1 hover button "Settings" [e7] → ok');
  });

  it('summarises corrections and rewinds', () => {
    const md = summarizeSession(
      'heal.spec.ts',
      [
        { state, command: { cmd: 'run' } },
        { state, command: { cmd: 'hint', text: 'Users is in the Settings flyout' } },
      ],
      [1],
    );
    expect(md).toContain('- Pauses: 2');
    expect(md).toContain('- Corrections: 1');
    expect(md).toContain('- Rewinds: to step 1');
    expect(md).toContain('hint: "Users is in the Settings flyout"');
  });
});
