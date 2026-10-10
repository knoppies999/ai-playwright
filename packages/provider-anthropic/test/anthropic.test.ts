import { AiProviderError, contractDecisionRequest, contractStructuredRequest } from '@aipw/core';
import { describe, expect, it } from 'vitest';
import { createProvider, decisionBody, parseDecision, parseStructured, structuredBody } from '../src/index.js';

function fakeFetch(reply: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = async (url: string, req: RequestInit) => {
    calls.push({ url, headers: req.headers as Record<string, string>, body: JSON.parse(String(req.body)) });
    return new Response(JSON.stringify(reply), { status: init.status ?? 200, headers: init.headers });
  };
  return { fetch, calls };
}

const toolUse = {
  content: [
    { type: 'text', text: 'Saving the profile.' },
    {
      type: 'tool_use',
      id: 'tu_1',
      name: 'click',
      input: { ref: 'e7', button: null, modifiers: null, clickCount: null, intent: 'save' },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
};
const env = { ANTHROPIC_API_KEY: 'sk-ant-test' };

describe('provider-anthropic wire format (contract)', () => {
  it('decision body matches the snapshot', async () => {
    const body = decisionBody(contractDecisionRequest({ image: true }), 'claude-opus-5-5');
    await expect(JSON.stringify(body, null, 2)).toMatchFileSnapshot('./golden/decision.json');
  });

  it('structured body matches the snapshot', async () => {
    const body = structuredBody(contractStructuredRequest(), 'claude-opus-5-5', { effort: 'low' });
    await expect(JSON.stringify(body, null, 2)).toMatchFileSnapshot('./golden/structured.json');
  });

  it('adds effort and the opt-in fallback only when asked', () => {
    const plain = decisionBody(contractDecisionRequest(), 'm');
    expect(plain).not.toHaveProperty('fallbacks');
    expect(plain).not.toHaveProperty('output_config');
    expect(decisionBody(contractDecisionRequest(), 'm', { effort: 'low', fallbacks: true })).toMatchObject({
      fallbacks: 'default',
      output_config: { effort: 'low' },
    });
  });
});

describe('provider-anthropic responses and transport', () => {
  it('parses a tool use with its text and cache usage', () => {
    expect(parseDecision(toolUse)).toEqual({
      call: { tool: 'click', args: { ref: 'e7', button: null, modifiers: null, clickCount: null, intent: 'save' } },
      text: 'Saving the profile.',
      stop: 'tool',
      usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 2000, requests: 1 },
    });
  });

  it('checks for a refusal before reading content', () => {
    const refused = { ...toolUse, stop_reason: 'refusal', stop_details: { explanation: 'Declined.' } };
    expect(parseDecision(refused)).toMatchObject({ stop: 'refusal', text: 'Declined.' });
    expect(parseDecision({ content: [{ type: 'text', text: 'hmm' }], stop_reason: 'max_tokens' })).toMatchObject({
      stop: 'length',
    });
  });

  it('parses structured output text as JSON', () => {
    expect(
      parseStructured({ content: [{ type: 'text', text: '{"pass":true,"reason":"ok"}' }], stop_reason: 'end_turn' })
        .value,
    ).toEqual({
      pass: true,
      reason: 'ok',
    });
  });

  it('sends the key and version headers; the beta header only with fallbacks', async () => {
    const { fetch, calls } = fakeFetch(toolUse);
    await createProvider({ fetch, env }).decide(contractDecisionRequest());
    expect(calls[0]).toMatchObject({
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' },
    });
    expect(calls[0]!.headers).not.toHaveProperty('anthropic-beta');
    expect((calls[0]!.body as { model: string }).model).toBe('claude-opus-5-5');
    const beta = fakeFetch(toolUse);
    await createProvider({ fetch: beta.fetch, env, fallbacks: true }).decide(contractDecisionRequest());
    expect(beta.calls[0]!.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
  });

  it('needs a key, and maps 429/529 to rate limits', async () => {
    expect(() => createProvider({ env: {} })).toThrow(/set ANTHROPIC_API_KEY.*claude-code/);
    const overloaded = fakeFetch(
      { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
      { status: 529 },
    );
    const error = await createProvider({ fetch: overloaded.fetch, env })
      .decide(contractDecisionRequest())
      .catch((e: AiProviderError) => e);
    expect(error).toMatchObject({ kind: 'rate_limit' });
  });
});
