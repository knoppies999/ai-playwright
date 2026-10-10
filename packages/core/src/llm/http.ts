// JSON over HTTP for the API-key adapters (Anthropic, OpenAI-compatible): one POST, HTTP failures mapped to
// AiProviderError kinds so retries (llm/retry.ts) and reports treat every provider the same way.
import { AiProviderError, type ProviderErrorKind } from '../errors.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Retry-After (seconds or an HTTP date) or retry-after-ms, in milliseconds. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const value = headers.get('retry-after');
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The error kind for an HTTP status (and the body's error code, for content filters). */
export function kindForStatus(status: number, code?: string): ProviderErrorKind {
  if (code && /content.?filter|content_policy|responsible_?ai/i.test(code)) return 'content_filter';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429 || status === 529) return 'rate_limit';
  if (status >= 500) return 'network';
  return 'other';
}

/** POSTs JSON and returns the parsed body, or throws an AiProviderError. Never logs the headers (they hold keys). */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  options: { provider: string; signal?: AbortSignal },
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      ...(options.signal && { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new AiProviderError('network', `${options.provider}: request failed: ${String(error)}`, {}, { cause: error });
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; type?: string; message?: string } } | undefined)?.error;
    const code = err?.code ?? err?.type;
    const kind = kindForStatus(res.status, code);
    const wait = retryAfterMs(res.headers);
    throw new AiProviderError(
      kind,
      `${options.provider}: HTTP ${res.status}${code ? ` ${code}` : ''}: ${err?.message ?? text.slice(0, 300)}`,
      {},
      wait !== undefined ? { retryAfterMs: wait } : undefined,
    );
  }
  if (json === undefined) throw new AiProviderError('other', `${options.provider}: the response was not JSON`);
  return json;
}
