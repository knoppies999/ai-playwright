// Retries for rate limits and network errors (docs/09 §3: "the adapters back off on 429"). Exponential backoff with
// full jitter, so parallel workers that hit a limit together don't retry together. A provider's Retry-After wins;
// one longer than maxMs (a plan limit that resets in hours) fails the call at once instead of waiting.
import { AiProviderError } from '../errors.js';
import type { LlmProvider } from './provider.js';

export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; waitMs: number; error: AiProviderError }) => void;
}

const RETRYABLE = new Set(['rate_limit', 'network']);

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** The wait before retry number `attempt` (0-based): full jitter over min(maxMs, base × 2^attempt). */
export function backoffMs(attempt: number, options: Pick<RetryOptions, 'baseMs' | 'maxMs'>, random = Math.random) {
  return Math.round(random() * Math.min(options.maxMs, options.baseMs * 2 ** attempt));
}

const RETRYING = Symbol('aipw.retry');

/** The provider with retryable failures retried. Returns it unchanged when retries is 0 or it is already wrapped. */
export function withRetry(provider: LlmProvider, options: RetryOptions): LlmProvider {
  if (options.retries <= 0 || (provider as { [RETRYING]?: boolean })[RETRYING]) return provider;
  const sleep = options.sleep ?? defaultSleep;
  const call = async <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (!(error instanceof AiProviderError) || !RETRYABLE.has(error.kind) || attempt >= options.retries)
          throw error;
        if (error.retryAfterMs !== undefined && error.retryAfterMs > options.maxMs) throw error;
        const waitMs = error.retryAfterMs ?? backoffMs(attempt, options, options.random);
        options.onRetry?.({ attempt: attempt + 1, waitMs, error });
        await sleep(waitMs, signal);
      }
    }
  };
  return {
    id: provider.id,
    model: provider.model,
    capabilities: provider.capabilities,
    [RETRYING]: true,
    decide: (req, signal) => call(() => provider.decide(req, signal), signal),
    structured: (req, signal) => call(() => provider.structured(req, signal), signal),
    ...(provider.dispose && { dispose: () => provider.dispose!() }),
  } as LlmProvider;
}
