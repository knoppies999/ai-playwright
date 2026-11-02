import { describe, expect, it } from 'vitest';
import { isNudgeStop } from '../src/nudge-reporter.js';

describe('nudge reporter', () => {
  it('treats rewinds, verification ends and quits as session stops, not failures', () => {
    expect(isNudgeStop({ errors: [{ message: 'RewindSignal: aipw nudge: rewinding to AI step 1' }] })).toBe(true);
    expect(isNudgeStop({ errors: [{ message: 'aipw nudge: verification run finished' }] })).toBe(true);
    expect(isNudgeStop({ errors: [{ message: 'Error: expect(locator).toHaveText() failed' }] })).toBe(false);
    expect(isNudgeStop({ errors: [] })).toBe(false);
  });
});
