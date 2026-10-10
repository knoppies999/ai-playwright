// OpenAI-compatible adapter (docs/05 §4): Chat Completions against Microsoft Foundry (pipelines), OpenAI, Azure OpenAI,
// GitHub Models, Ollama or LM Studio. Plain fetch, no SDK: the request body is built by pure functions, so the
// contract tests can snapshot exactly what goes on the wire. Foundry can be keyless: @azure/identity is an optional
// peer, loaded only for preset 'foundry' without an API key.
import {
  AiProviderError,
  emptyUsage,
  postJson,
  type DecisionRequest,
  type DecisionResponse,
  type FetchLike,
  type ImageInput,
  type LlmProvider,
  type StructuredRequest,
  type StructuredResponse,
  type Usage,
} from '@aipw/core';

/** What a given endpoint and model actually support (docs/05 §4.1). `aipw doctor` probes them. */
export interface CompatFlags {
  /** `strict: true` on function definitions. */
  strictTools: boolean;
  /** `tool_choice: 'required'`; otherwise 'auto' plus the system prompt's "call exactly one tool". */
  toolChoiceRequired: boolean;
  /** Send `parallel_tool_calls: false`. */
  parallelToolCallsParam: boolean;
  vision: boolean;
  /** `response_format: json_schema`; otherwise json_object with the schema in the prompt. */
  jsonSchemaResponseFormat: boolean;
  /** Name of the output-length field: newer OpenAI models want max_completion_tokens. */
  maxTokensParam: 'max_completion_tokens' | 'max_tokens';
}

export type PresetName = 'foundry' | 'openai' | 'azure-openai' | 'github-models' | 'ollama' | 'lmstudio';

interface Preset {
  baseURL?: (o: OpenAiOptions) => string;
  apiKeyEnv?: string;
  compat: CompatFlags;
}

const MODERN: CompatFlags = {
  strictTools: true,
  toolChoiceRequired: true,
  parallelToolCallsParam: true,
  vision: true,
  jsonSchemaResponseFormat: true,
  maxTokensParam: 'max_completion_tokens',
};
// Local servers: conservative. Tool calling and vision depend on the model loaded.
const LOCAL: CompatFlags = {
  strictTools: false,
  toolChoiceRequired: false,
  parallelToolCallsParam: false,
  vision: false,
  jsonSchemaResponseFormat: false,
  maxTokensParam: 'max_tokens',
};

export const PRESETS: Record<PresetName, Preset> = {
  // Foundry's OpenAI v1 route: model = the deployment name, no api-version (docs/05 §4.2).
  foundry: {
    baseURL: (o) => {
      const resource = o.resource ?? o.env?.AZURE_FOUNDRY_RESOURCE;
      if (!resource)
        throw new AiProviderError('auth', 'foundry: set AZURE_FOUNDRY_RESOURCE (or `resource` in the provider config)');
      return `https://${resource}.openai.azure.com/openai/v1`;
    },
    apiKeyEnv: 'AZURE_FOUNDRY_API_KEY',
    compat: MODERN,
  },
  openai: { baseURL: () => 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', compat: MODERN },
  // Legacy versioned Azure OpenAI routes: give baseURL as .../openai/deployments/<name>; prefer 'foundry'.
  'azure-openai': { apiKeyEnv: 'AZURE_OPENAI_API_KEY', compat: { ...MODERN, toolChoiceRequired: false } },
  'github-models': {
    baseURL: () => 'https://models.github.ai/inference',
    apiKeyEnv: 'GITHUB_TOKEN',
    compat: { ...MODERN, strictTools: false, maxTokensParam: 'max_tokens' },
  },
  ollama: { baseURL: () => 'http://localhost:11434/v1', compat: LOCAL },
  lmstudio: { baseURL: () => 'http://localhost:1234/v1', compat: LOCAL },
};

export interface OpenAiOptions {
  preset?: PresetName;
  /** Model id, or the Foundry / Azure deployment name. */
  model?: string;
  baseURL?: string;
  /** Env var holding the API key (overrides the preset's). */
  apiKeyEnv?: string;
  /** foundry: the resource name (default AZURE_FOUNDRY_RESOURCE). */
  resource?: string;
  /** foundry: 'entra' (keyless) or 'apiKey'. Default: apiKey when AZURE_FOUNDRY_API_KEY is set. */
  auth?: 'entra' | 'apiKey';
  /** azure-openai: the api-version query parameter. */
  apiVersion?: string;
  compat?: Partial<CompatFlags>;
  maxOutputTokens?: number;
  /** For tests and proxies. */
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** A bearer token source (default for foundry + entra: DefaultAzureCredential). */
  getToken?: () => Promise<string>;
}

// ---- Wire format (pure) ---------------------------------------------------------------------------------------

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

const imageParts = (images: ImageInput[] | undefined, compat: CompatFlags): Part[] =>
  compat.vision
    ? (images ?? []).map((i) => ({
        type: 'image_url',
        image_url: { url: `data:${i.mediaType};base64,${i.data.toString('base64')}` },
      }))
    : [];

/** The Chat Completions body for one decision (docs/05 §4). */
export function decisionBody(req: DecisionRequest, model: string, compat: CompatFlags, maxOutputTokens = 4096) {
  return {
    model,
    messages: [
      { role: 'system', content: req.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: req.context },
          ...imageParts(req.images, compat),
          { type: 'text', text: req.observation },
        ] satisfies Part[],
      },
    ],
    tools: req.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.jsonSchema,
        ...(compat.strictTools && { strict: true }),
      },
    })),
    tool_choice: compat.toolChoiceRequired ? 'required' : 'auto',
    ...(compat.parallelToolCallsParam && { parallel_tool_calls: false }),
    [compat.maxTokensParam]: maxOutputTokens,
  };
}

/** The body for structured(): json_schema response format, or json_object with the schema in the prompt. */
export function structuredBody<T>(
  req: StructuredRequest<T>,
  model: string,
  compat: CompatFlags,
  maxOutputTokens = 4096,
) {
  const prompt = compat.jsonSchemaResponseFormat
    ? req.prompt
    : `${req.prompt}\n\nReply with one JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(req.jsonSchema)}`;
  return {
    model,
    messages: [
      { role: 'system', content: req.system },
      {
        role: 'user',
        content: [{ type: 'text', text: prompt }, ...imageParts(req.images, compat)] satisfies Part[],
      },
    ],
    response_format: compat.jsonSchemaResponseFormat
      ? { type: 'json_schema', json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: true } }
      : { type: 'json_object' },
    [compat.maxTokensParam]: maxOutputTokens,
  };
}

interface ChatCompletion {
  choices?: {
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: { type: string; function?: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/** prompt_tokens includes cached tokens; they are reported separately so they can be priced as cache reads. */
export function toUsage(res: ChatCompletion): Usage {
  const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    ...emptyUsage(),
    inputTokens: (res.usage?.prompt_tokens ?? 0) - cached,
    outputTokens: res.usage?.completion_tokens ?? 0,
    ...(cached && { cacheReadTokens: cached }),
    requests: 1,
  };
}

function checkFilter(res: ChatCompletion, provider: string) {
  if (res.choices?.[0]?.finish_reason === 'content_filter')
    throw new AiProviderError('content_filter', `${provider}: the response was blocked by a content filter`);
}

export function parseDecision(res: ChatCompletion, provider = 'openai'): DecisionResponse {
  checkFilter(res, provider);
  const choice = res.choices?.[0];
  const usage = toUsage(res);
  const text = choice?.message?.content ?? undefined;
  if (choice?.message?.refusal) return { stop: 'refusal', text: choice.message.refusal, usage };
  const call = choice?.message?.tool_calls?.find((c) => c.type === 'function' && c.function);
  if (call?.function) {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      // Invalid JSON arguments: hand back the raw string; the loop's validation fails and runs a repair turn.
      args = call.function.arguments;
    }
    return { call: { tool: call.function.name, args }, ...(text && { text }), stop: 'tool', usage };
  }
  return { ...(text && { text }), stop: choice?.finish_reason === 'length' ? 'length' : 'text', usage };
}

export function parseStructured(res: ChatCompletion, provider = 'openai'): StructuredResponse {
  checkFilter(res, provider);
  const choice = res.choices?.[0];
  const usage = toUsage(res);
  if (choice?.message?.refusal) return { value: undefined, text: choice.message.refusal, stop: 'refusal', usage };
  const content = choice?.message?.content ?? '';
  // json_object mode on some local models wraps the JSON in a code fence.
  const json = /```(?:json)?\s*([\s\S]*?)```/.exec(content)?.[1] ?? content;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    value = undefined;
  }
  return { value, text: content, stop: choice?.finish_reason === 'length' ? 'length' : 'text', usage };
}

// ---- Transport ------------------------------------------------------------------------------------------------

/** Keyless Foundry: a token from DefaultAzureCredential, cached until shortly before it expires. */
function entraTokenSource(): () => Promise<string> {
  let cached: { token: string; expires: number } | undefined;
  let credential:
    { getToken(scope: string): Promise<{ token: string; expiresOnTimestamp: number } | null> } | undefined;
  return async () => {
    if (cached && cached.expires - Date.now() > 120_000) return cached.token;
    if (!credential) {
      let identity: { DefaultAzureCredential: new () => typeof credential };
      try {
        identity = (await import(/* optional peer */ '@azure/identity' as string)) as typeof identity;
      } catch (error) {
        throw new AiProviderError(
          'auth',
          'foundry: keyless auth needs the optional package @azure/identity (npm i -D @azure/identity), or set AZURE_FOUNDRY_API_KEY',
          {},
          { cause: error },
        );
      }
      credential = new identity.DefaultAzureCredential();
    }
    const token = await credential!.getToken('https://ai.azure.com/.default');
    if (!token) throw new AiProviderError('auth', 'foundry: DefaultAzureCredential returned no token (az login?)');
    cached = { token: token.token, expires: token.expiresOnTimestamp };
    return token.token;
  };
}

export class OpenAiProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities;
  readonly compat: CompatFlags;
  private readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly headers: () => Promise<Record<string, string>>;

  constructor(private readonly options: OpenAiOptions = {}) {
    const presetName = options.preset ?? 'openai';
    const preset = PRESETS[presetName];
    const env = options.env ?? process.env;
    this.id = presetName;
    this.compat = { ...preset.compat, ...options.compat };
    this.capabilities = {
      nativeTools: true,
      strictSchemas: this.compat.strictTools,
      vision: this.compat.vision,
      promptCaching: presetName === 'openai' || presetName === 'foundry' || presetName === 'azure-openai',
    };
    const model = options.model ?? (presetName === 'foundry' ? env.AIPW_FOUNDRY_DEPLOYMENT : env.AIPW_OPENAI_MODEL);
    if (!model) throw new AiProviderError('other', `${presetName}: no model (deployment name) configured`);
    this.model = model;
    const base = (options.baseURL ?? preset.baseURL?.({ ...options, env }))?.replace(/\/+$/, '');
    if (!base) throw new AiProviderError('other', `${presetName}: set baseURL in the provider config`);
    const query = presetName === 'azure-openai' ? `?api-version=${options.apiVersion ?? '2024-10-21'}` : '';
    this.url = `${base}/chat/completions${query}`;
    this.fetchImpl = options.fetch ?? fetch;

    const keyEnv = options.apiKeyEnv ?? preset.apiKeyEnv;
    const key = keyEnv ? env[keyEnv] : undefined;
    const entra = presetName === 'foundry' && (options.auth === 'entra' || (!key && options.auth !== 'apiKey'));
    if (entra || options.getToken) {
      const token = options.getToken ?? entraTokenSource();
      this.headers = async () => ({ authorization: `Bearer ${await token()}` });
    } else if (presetName === 'azure-openai' || (presetName === 'foundry' && key)) {
      if (!key) throw new AiProviderError('auth', `${presetName}: set ${keyEnv}`);
      this.headers = async () => ({ 'api-key': key });
    } else {
      if (keyEnv && !key && preset.apiKeyEnv && presetName !== 'ollama' && presetName !== 'lmstudio')
        throw new AiProviderError('auth', `${presetName}: set ${keyEnv}`);
      this.headers = async (): Promise<Record<string, string>> => (key ? { authorization: `Bearer ${key}` } : {});
    }
  }

  async decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const body = decisionBody(req, this.model, this.compat, this.options.maxOutputTokens);
    const res = await postJson(this.fetchImpl, this.url, await this.headers(), body, { provider: this.id, signal });
    return parseDecision(res as ChatCompletion, this.id);
  }

  async structured<T>(req: StructuredRequest<T>, signal?: AbortSignal): Promise<StructuredResponse<T>> {
    const body = structuredBody(req, this.model, this.compat, this.options.maxOutputTokens);
    const res = await postJson(this.fetchImpl, this.url, await this.headers(), body, { provider: this.id, signal });
    return parseStructured(res as ChatCompletion, this.id) as StructuredResponse<T>;
  }
}

/** The provider factory the loader calls (docs/05 §7). */
export function createProvider(options: Record<string, unknown>): LlmProvider {
  return new OpenAiProvider(options as OpenAiOptions);
}
