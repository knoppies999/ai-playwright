// Anthropic API adapter (docs/05 §3), for an API key (ANTHROPIC_API_KEY). Messages API over plain fetch, no SDK:
// the request body is built by pure functions so the contract tests can snapshot it. Not run against the live API
// yet (spike 0.5 needs a key): the server-side fallback beta is opt-in until then.
import {
  emptyUsage,
  postJson,
  AiProviderError,
  type DecisionRequest,
  type DecisionResponse,
  type FetchLike,
  type ImageInput,
  type LlmProvider,
  type StructuredRequest,
  type StructuredResponse,
  type Usage,
} from '@aipw/core';

export const ANTHROPIC_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface AnthropicOptions {
  model?: string;
  /** output_config.effort; the model default when unset. */
  effort?: 'low' | 'medium' | 'high';
  /** Retry declined requests on a fallback model (beta). Off until verified with a key. */
  fallbacks?: boolean;
  maxOutputTokens?: number;
  baseURL?: string;
  apiKeyEnv?: string;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

type Block =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

const images = (list: ImageInput[] | undefined): Block[] =>
  (list ?? []).map((i) => ({
    type: 'image',
    source: { type: 'base64', media_type: i.mediaType, data: i.data.toString('base64') },
  }));

interface BodyOptions {
  effort?: AnthropicOptions['effort'];
  fallbacks?: boolean;
  maxOutputTokens?: number;
}

/**
 * One decision: the system block is cached (it and the tools render first and are stable per run), tool choice is
 * auto with no parallel calls (forced tool choice returns 400 on current models; the system prompt says "exactly one").
 */
export function decisionBody(req: DecisionRequest, model: string, o: BodyOptions = {}) {
  return {
    model,
    max_tokens: o.maxOutputTokens ?? 16000,
    ...(o.fallbacks && { fallbacks: 'default' }),
    ...(o.effort && { output_config: { effort: o.effort } }),
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    tools: req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.jsonSchema,
      strict: true,
    })),
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: req.context },
          ...images(req.images),
          { type: 'text', text: req.observation },
        ] satisfies Block[],
      },
    ],
  };
}

/** structured(): structured outputs with the JSON Schema as the output format. */
export function structuredBody<T>(req: StructuredRequest<T>, model: string, o: BodyOptions = {}) {
  return {
    model,
    max_tokens: o.maxOutputTokens ?? 16000,
    ...(o.fallbacks && { fallbacks: 'default' }),
    output_config: {
      ...(o.effort && { effort: o.effort }),
      format: { type: 'json_schema', schema: req.jsonSchema },
    },
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: req.prompt }, ...images(req.images)] satisfies Block[] },
    ],
  };
}

interface MessageResponse {
  content?: ({ type: 'text'; text: string } | { type: 'tool_use'; name: string; input: unknown } | { type: string })[];
  stop_reason?: string;
  stop_details?: { explanation?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function toUsage(res: MessageResponse): Usage {
  const u = res.usage ?? {};
  return {
    ...emptyUsage(),
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    ...(u.cache_read_input_tokens && { cacheReadTokens: u.cache_read_input_tokens }),
    ...(u.cache_creation_input_tokens && { cacheWriteTokens: u.cache_creation_input_tokens }),
    requests: 1,
  };
}

const textOf = (res: MessageResponse) =>
  (res.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

export function parseDecision(res: MessageResponse): DecisionResponse {
  const usage = toUsage(res);
  const text = textOf(res) || undefined;
  // Refusals first: the content of a refused response isn't the answer.
  if (res.stop_reason === 'refusal') return { stop: 'refusal', text: res.stop_details?.explanation ?? text, usage };
  const tool = (res.content ?? []).find(
    (b): b is { type: 'tool_use'; name: string; input: unknown } => b.type === 'tool_use',
  );
  if (tool) return { call: { tool: tool.name, args: tool.input }, ...(text && { text }), stop: 'tool', usage };
  return { ...(text && { text }), stop: res.stop_reason === 'max_tokens' ? 'length' : 'text', usage };
}

export function parseStructured(res: MessageResponse): StructuredResponse {
  const usage = toUsage(res);
  const text = textOf(res);
  if (res.stop_reason === 'refusal')
    return { value: undefined, text: res.stop_details?.explanation ?? text, stop: 'refusal', usage };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  return { value, text, stop: res.stop_reason === 'max_tokens' ? 'length' : 'text', usage };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly model: string;
  readonly capabilities = { nativeTools: true, strictSchemas: true, vision: true, promptCaching: true };
  private readonly url: string;
  private readonly key: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: AnthropicOptions = {}) {
    const env = options.env ?? process.env;
    this.model = options.model ?? 'claude-opus-5-5';
    const keyEnv = options.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
    const key = env[keyEnv];
    if (!key)
      throw new AiProviderError(
        'auth',
        `anthropic: set ${keyEnv}. To use your Claude subscription instead, use the claude-code provider.`,
      );
    this.key = key;
    this.url = `${(options.baseURL ?? 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/messages`;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.key,
      'anthropic-version': ANTHROPIC_VERSION,
      ...(this.options.fallbacks && { 'anthropic-beta': FALLBACK_BETA }),
    };
  }

  async decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const body = decisionBody(req, this.model, this.options);
    const res = await postJson(this.fetchImpl, this.url, this.headers(), body, { provider: this.id, signal });
    return parseDecision(res as MessageResponse);
  }

  async structured<T>(req: StructuredRequest<T>, signal?: AbortSignal): Promise<StructuredResponse<T>> {
    const body = structuredBody(req, this.model, this.options);
    const res = await postJson(this.fetchImpl, this.url, this.headers(), body, { provider: this.id, signal });
    return parseStructured(res as MessageResponse) as StructuredResponse<T>;
  }
}

/** The provider factory the loader calls (docs/05 §7). */
export function createProvider(options: Record<string, unknown>): LlmProvider {
  return new AnthropicProvider(options as AnthropicOptions);
}
