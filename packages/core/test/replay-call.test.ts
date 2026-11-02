import { describe, expect, it } from 'vitest';
import { actTools, validateCall } from '../src/actions/schemas.js';
import { toReplayCall } from '../src/cache/replay.js';

describe('toReplayCall', () => {
  const offered = actTools({ allowNavigation: true });

  it.each([
    ['wait_for', { text: "It's gone!", state: null, ms: null }],
    ['press', { key: 'Enter' }],
    ['scroll', { direction: 'down', amount: null }],
  ])('turns a stored %s without a target back into a valid call', (tool, args) => {
    const { tool: name, args: replayArgs } = toReplayCall({ tool, args });
    expect(replayArgs.ref).toBeNull();
    const validated = validateCall({ tool: name, args: replayArgs }, offered);
    expect(validated.ok ? 'ok' : validated.error).toBe('ok');
  });
});
