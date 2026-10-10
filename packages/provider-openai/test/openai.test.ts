import { AiProviderError, contractDecisionRequest, contractStructuredRequest } from '@aipw/core';
import { describe, expect, it } from 'vitest';
import { createProvider, decisionBody, parseDecision, parseStructured, PRESETS, structuredBody } from '../src/index.js';

/** A fetch that records requests and answers with `reply`. */
function fakeFetch(reply: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = async (url: string, req: RequestInit) => {
    calls.push({ url, headers: req.headers as Record<string, string>, body: JSON.parse(String(req.body)) });
    return new Response(JSON.stringify(reply), { status: init.status ?? 200, headers: init.headers });
  };
  return { fetch, calls };
}

const toolReply = (name: string, args: string, extra = {}) => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: { content: null, tool_calls: [{ type: 'function', function: { name, arguments: args } }] },
    },
  ],
  usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 1000 } },
  ...extra,
});

describe('provider-openai wire format (contract)', () => {
  it('decision body for Foundry matches the snapshot', async () => {
    const body = decisionBody(contractDecisionRequest({ image: true }), 'e2e-agent', PRESETS.foundry.compat);
    await expect(JSON.stringify(body, null, 2)).toMatchFileSnapshot('./golden/decision-foundry.json');
  });

  it('structured body: json_schema on Foundry, json_object with the schema in the prompt on Ollama', async () => {
    const foundry = structuredBody(contractStructuredRequest(), 'e2e-agent', PRESETS.foundry.compat);
    await expect(JSON.stringify(foundry, null, 2)).toMatchFileSnapshot('./golden/structured-foundry.json');
    const ollama = structuredBody(contractStructuredRequest(), 'qwen3:14b', PRESETS.ollama.compat);
    expect(ollama.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(ollama.messages)).toContain('Reply with one JSON object that matches this JSON Schema');
    expect(ollama).toHaveProperty('max_tokens');
  });

  it('local presets send no strict flag, no required tool choice and no images', () => {
    const body = decisionBody(contractDecisionRequest({ image: true }), 'qwen3:14b', PRESETS.ollama.compat);
    expect(body.tool_choice).toBe('auto');
    expect(body).not.toHaveProperty('parallel_tool_calls');
    expect(JSON.stringify(body)).not.toContain('"strict"');
    expect(JSON.stringify(body)).not.toContain('image_url');
  });
});

describe('provider-openai responses', () => {
  it('parses a tool call and splits cached input tokens out', () => {
    expect(
      parseDecision(
        toolReply('click', '{"ref":"e7","button":null,"modifiers":null,"clickCount":null,"intent":"save"}'),
      ),
    ).toEqual({
      call: { tool: 'click', args: { ref: 'e7', button: null, modifiers: null, clickCount: null, intent: 'save' } },
      stop: 'tool',
      usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 1000, requests: 1 },
    });
  });

  it('hands back invalid JSON arguments raw (the loop repairs), and reports refusals', () => {
    expect(parseDecision(toolReply('click', '{"ref": e7')).call).toEqual({ tool: 'click', args: '{"ref": e7' });
    const refusal = { choices: [{ finish_reason: 'stop', message: { refusal: 'I can’t help with that.' } }] };
    expect(parseDecision(refusal)).toMatchObject({ stop: 'refusal', text: 'I can’t help with that.' });
  });

  it('maps a content-filter finish to a content_filter error', () => {
    const filtered = { choices: [{ finish_reason: 'content_filter', message: { content: null } }] };
    expect(() => parseDecision(filtered, 'foundry')).toThrow(AiProviderError);
    expect(() => parseDecision(filtered, 'foundry')).toThrow(/content filter/);
  });

  it('parses structured JSON, also inside a code fence', () => {
    const reply = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { content } }] });
    expect(parseStructured(reply('{"pass":true,"reason":"shown"}')).value).toEqual({ pass: true, reason: 'shown' });
    expect(parseStructured(reply('```json\n{"pass":false,"reason":"x"}\n```')).value).toEqual({
      pass: false,
      reason: 'x',
    });
    expect(parseStructured(reply('not json')).value).toBeUndefined();
  });
});

describe('provider-openai transport', () => {
  it('Foundry with an API key: v1 route, deployment as model, api-key header', async () => {
    const { fetch, calls } = fakeFetch(toolReply('done', '{"summary":"ok","evidence":[]}'));
    const provider = createProvider({
      preset: 'foundry',
      fetch,
      env: { AZURE_FOUNDRY_RESOURCE: 'my-res', AIPW_FOUNDRY_DEPLOYMENT: 'e2e-agent', AZURE_FOUNDRY_API_KEY: 'k-123' },
    });
    expect(provider.model).toBe('e2e-agent');
    await provider.decide(contractDecisionRequest());
    expect(calls[0]!.url).toBe('https://my-res.openai.azure.com/openai/v1/chat/completions');
    expect(calls[0]!.headers['api-key']).toBe('k-123');
    expect((calls[0]!.body as { model: string }).model).toBe('e2e-agent');
  });

  it('Foundry keyless: a bearer token from the token source (DefaultAzureCredential by default)', async () => {
    const { fetch, calls } = fakeFetch(toolReply('done', '{}'));
    const provider = createProvider({
      preset: 'foundry',
      fetch,
      getToken: async () => 'entra-token',
      env: { AZURE_FOUNDRY_RESOURCE: 'my-res', AIPW_FOUNDRY_DEPLOYMENT: 'e2e-agent' },
    });
    await provider.decide(contractDecisionRequest());
    expect(calls[0]!.headers.authorization).toBe('Bearer entra-token');
    expect(calls[0]!.headers).not.toHaveProperty('api-key');
  });

  it('OpenAI and GitHub Models use bearer keys; a missing key or resource is a clear auth error', async () => {
    const { fetch, calls } = fakeFetch(toolReply('done', '{}'));
    await createProvider({ preset: 'openai', model: 'gpt-5.4', fetch, env: { OPENAI_API_KEY: 'sk-1' } }).decide(
      contractDecisionRequest(),
    );
    expect(calls[0]).toMatchObject({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: 'Bearer sk-1' },
    });
    expect(() => createProvider({ preset: 'openai', model: 'gpt-5.4', env: {} })).toThrow(/set OPENAI_API_KEY/);
    expect(() => createProvider({ preset: 'foundry', model: 'x', env: {} })).toThrow(/AZURE_FOUNDRY_RESOURCE/);
    const ollama = fakeFetch(toolReply('done', '{}'));
    await createProvider({ preset: 'ollama', model: 'qwen3:14b', fetch: ollama.fetch, env: {} }).decide(
      contractDecisionRequest(),
    );
    expect(ollama.calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(ollama.calls[0]!.headers).not.toHaveProperty('authorization');
  });

  it('maps HTTP errors: 429 with Retry-After, 401, and an Azure content-filter 400', async () => {
    const env = { OPENAI_API_KEY: 'sk-1' };
    const error = async (status: number, body: unknown, headers?: Record<string, string>) =>
      createProvider({ preset: 'openai', model: 'm', env, fetch: fakeFetch(body, { status, headers }).fetch })
        .decide(contractDecisionRequest())
        .catch((e: AiProviderError) => e);
    expect(await error(429, { error: { message: 'slow down' } }, { 'retry-after': '3' })).toMatchObject({
      kind: 'rate_limit',
      retryAfterMs: 3000,
    });
    expect(await error(401, { error: { message: 'bad key' } })).toMatchObject({ kind: 'auth' });
    expect(await error(400, { error: { code: 'content_filter', message: 'blocked' } })).toMatchObject({
      kind: 'content_filter',
    });
  });
});
