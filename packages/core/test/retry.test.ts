import { describe, expect, it } from 'vitest';
import { AiProviderError } from '../src/errors.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import { backoffMs, withRetry } from '../src/llm/retry.js';

const req = { system: '', tools: [], context: '', observation: '' };
const done = { tool: 'done', args: { summary: 'ok', evidence: [] } };
const throwing = (error: Error) => () => {
  throw error;
};

function setup(decisions: ConstructorParameters<typeof FakeProvider>[0], retries = 3) {
  const waits: number[] = [];
  const provider = withRetry(new FakeProvider(decisions), {
    retries,
    baseMs: 1000,
    maxMs: 30_000,
    random: () => 0.5,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { provider, waits };
}

describe('rate-limit retries', () => {
  it('backs off exponentially with full jitter, capped', () => {
    const o = { baseMs: 1000, maxMs: 30_000 };
    expect([0, 1, 2, 3, 4, 5].map((a) => backoffMs(a, o, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(backoffMs(3, o, () => 0.25)).toBe(2000);
  });

  it('retries 429s and network errors, then succeeds', async () => {
    const { provider, waits } = setup([
      throwing(new AiProviderError('rate_limit', '429')),
      throwing(new AiProviderError('network', 'ECONNRESET')),
      done,
    ]);
    await expect(provider.decide(req)).resolves.toMatchObject({ call: { tool: 'done' } });
    expect(waits).toEqual([500, 1000]);
  });

  it('honours Retry-After, and fails at once when it is longer than maxMs (a plan limit)', async () => {
    const short = setup([throwing(new AiProviderError('rate_limit', 'slow down', {}, { retryAfterMs: 7000 })), done]);
    await short.provider.decide(req);
    expect(short.waits).toEqual([7000]);

    const plan = setup([
      throwing(new AiProviderError('rate_limit', 'usage limit', {}, { retryAfterMs: Number.POSITIVE_INFINITY })),
    ]);
    await expect(plan.provider.decide(req)).rejects.toThrow('usage limit');
    expect(plan.waits).toEqual([]);
  });

  it('gives up after the last retry and never retries other errors', async () => {
    const limited = setup(Array(3).fill(throwing(new AiProviderError('rate_limit', '429'))), 2);
    await expect(limited.provider.decide(req)).rejects.toThrow('429');
    expect(limited.waits).toHaveLength(2);

    const auth = setup([throwing(new AiProviderError('auth', 'signed out'))]);
    await expect(auth.provider.decide(req)).rejects.toThrow('signed out');
    expect(auth.waits).toEqual([]);
  });

  it('leaves the provider alone with retries: 0', () => {
    const provider = new FakeProvider();
    expect(withRetry(provider, { retries: 0, baseMs: 1, maxMs: 1 })).toBe(provider);
  });
});
