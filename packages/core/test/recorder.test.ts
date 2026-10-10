import { describe, expect, it } from 'vitest';
import { manualRecord, mergeManualEvents, type RawManualEvent } from '../src/nudge/recorder.js';

const url = 'http://app.test/';
const ev = (kind: RawManualEvent['kind'], id: number, extra: Partial<RawManualEvent> = {}): RawManualEvent => ({
  kind,
  id,
  url,
  ...extra,
});

describe('manual recorder', () => {
  it('merges typing into one fill, drops clicks into fields and touches', () => {
    expect(
      mergeManualEvents([
        ev('touch', 1),
        ev('click', 1),
        ev('fill', 1, { value: 'T' }),
        ev('fill', 1, { value: 'Th' }),
        ev('fill', 1, { value: 'Thandi' }),
        ev('hover', 2),
        ev('hover', 2),
        ev('click', 3),
        ev('check', 4, { checked: true }),
        ev('click', 4),
        ev('press', 0, { key: 'Escape' }),
      ]),
    ).toEqual([
      ev('fill', 1, { value: 'Thandi' }),
      ev('hover', 2),
      ev('click', 3),
      ev('check', 4, { checked: true }),
      ev('press', 0, { key: 'Escape' }),
    ]);
  });

  it('builds records with the tool schemas’ arguments and never keeps a password', () => {
    const target = { ref: 'manual', role: 'textbox', name: 'Password', candidates: [] };
    expect(manualRecord(ev('fill', 1, { password: true }), target)).toMatchObject({
      tool: 'fill',
      args: { ref: 'manual', value: '{{secret.?}}' },
      target,
      result: 'ok',
    });
    expect(manualRecord(ev('click', 2), undefined)!.args).toEqual({
      ref: 'manual',
      button: null,
      modifiers: null,
      clickCount: null,
      intent: 'done by hand by the person running the test',
    });
    expect(manualRecord(ev('select', 3, { values: ['Admin'] }), undefined)).toMatchObject({
      tool: 'select_option',
      args: { values: ['Admin'] },
    });
    expect(manualRecord(ev('press', 0, { key: 'Enter' }), undefined)).toMatchObject({
      tool: 'press',
      args: { key: 'Enter', ref: null },
    });
  });
});
