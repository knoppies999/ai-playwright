import { describe, expect, it } from 'vitest';
import { traceRecordsDom } from '../src/index.js';

describe('traceRecordsDom', () => {
  it.each([
    ['off', false],
    ['on', true],
    ['retain-on-failure', true],
    [{ mode: 'off' }, false],
    [{ mode: 'on' }, true],
    [{ mode: 'on', snapshots: false }, false],
    [{ mode: 'on', snapshots: true }, true],
    [{ mode: 'retain-on-failure', snapshots: { dom: false } }, false],
    [{ mode: 'retain-on-failure', snapshots: { aria: true } }, true],
  ] as const)('%j → %s', (trace, expected) => {
    expect(traceRecordsDom(trace as Parameters<typeof traceRecordsDom>[0])).toBe(expected);
  });
});
