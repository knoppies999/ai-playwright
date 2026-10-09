// Contract tests with the Agent SDK mocked: no Claude Code process, no network, no plan usage.
import { toolSpecs, type DecisionRequest } from '@aipw/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

type FakeTool = { name: string; handler: (args: unknown) => Promise<unknown> };
type Behaviour = (options: Record<string, unknown>) => AsyncGenerator<unknown>;

const sdk = vi.hoisted(() => ({
  calls: [] as { prompt: string; options: Record<string, unknown> }[],
  behaviour: undefined as unknown,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (name: string, _description: string, _shape: unknown, handler: FakeTool['handler']) => ({ name, handler }),
  createSdkMcpServer: (config: { tools: FakeTool[] }) => ({ type: 'sdk', tools: config.tools }),
  query: ({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
    sdk.calls.push({ prompt, options });
    return (sdk.behaviour as Behaviour)(options);
  },
}));

const { createProvider } = await import('../src/index.js');

const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  result: '',
  total_cost_usd: 0.012,
  modelUsage: {
    'claude-sonnet-5-5': {
      inputTokens: 2,
      outputTokens: 90,
      cacheReadInputTokens: 3000,
      cacheCreationInputTokens: 1800,
    },
  },
  ...extra,
});

const toolsOf = (options: Record<string, unknown>) =>
  (options.mcpServers as { aipw: { tools: FakeTool[] } }).aipw.tools;

const req: DecisionRequest = {
  system: 'SYSTEM',
  tools: toolSpecs(['click', 'done']),
  context: 'TASK',
  observation: 'PAGE',
};

beforeEach(() => {
  sdk.calls.length = 0;
});

describe('claude-code decide', () => {
  it('captures the tool call and tolerates the max-turns error that follows', async () => {
    sdk.behaviour = async function* (options: Record<string, unknown>) {
      const click = toolsOf(options).find((t) => t.name === 'click')!;
      await click.handler({ ref: 'e33', button: null, modifiers: null, clickCount: null, intent: 'add backpack' });
      yield result({ subtype: 'error_max_turns' });
      throw new Error('Claude Code returned an error result: Reached maximum number of turns (1)');
    };
    const res = await createProvider().decide(req);
    expect(res).toMatchObject({ stop: 'tool', call: { tool: 'click', args: { ref: 'e33' } } });
    expect(res.usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 90,
      cacheReadTokens: 3000,
      costUsd: 0.012,
      requests: 1,
    });
  });

  it('runs locked down: no built-ins, no connectors, no settings, only our tools', async () => {
    sdk.behaviour = async function* () {
      yield result();
    };
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    await createProvider().decide(req);
    delete process.env.ANTHROPIC_API_KEY;
    const { prompt, options } = sdk.calls[0]!;
    expect(prompt).toBe('TASK\n\nPAGE');
    expect(options).toMatchObject({
      model: 'claude-sonnet-5-5',
      systemPrompt: 'SYSTEM',
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      permissionMode: 'dontAsk',
      maxTurns: 1,
      allowedTools: ['mcp__aipw__click', 'mcp__aipw__done'],
    });
    expect((options.env as Record<string, string>).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps only the first call when the model calls several tools', async () => {
    sdk.behaviour = async function* (options: Record<string, unknown>) {
      const [click, done] = toolsOf(options);
      await click!.handler({ ref: 'e1' });
      await done!.handler({ summary: 's', evidence: [] });
      yield result();
    };
    expect((await createProvider().decide(req)).call?.tool).toBe('click');
  });

  it('passes on a tool call that Claude Code rejected before our handler ran', async () => {
    sdk.behaviour = async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'mcp__aipw__done', input: { summary: 'Logged out', evidence: 'Login form' } },
          ],
        },
      };
      yield result({ subtype: 'error_max_turns' });
      throw new Error('Reached maximum number of turns (1)');
    };
    expect(await createProvider().decide(req)).toMatchObject({
      stop: 'tool',
      call: { tool: 'done', args: { summary: 'Logged out', evidence: 'Login form' } },
    });
  });

  it('returns text when no tool was called', async () => {
    sdk.behaviour = async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'I am not sure' }] } };
      yield result();
    };
    expect(await createProvider().decide(req)).toMatchObject({ stop: 'text', text: 'I am not sure' });
  });

  it('maps a signed-out Claude Code to an auth error that says how to fix it', async () => {
    sdk.behaviour = async function* () {
      yield* [];
      throw new Error('Claude Code returned an error result: Failed to authenticate: OAuth session expired');
    };
    await expect(createProvider().decide(req)).rejects.toMatchObject({
      kind: 'auth',
      message: expect.stringContaining('claude auth login'),
    });
  });

  it('maps plan limits to rate_limit', async () => {
    sdk.behaviour = async function* () {
      yield* [];
      throw new Error('Claude AI usage limit reached');
    };
    await expect(createProvider().decide(req)).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

describe('claude-code structured', () => {
  it('uses outputFormat and returns structured_output', async () => {
    sdk.behaviour = async function* () {
      yield result({ structured_output: { pass: true, reason: 'ok', evidence: ['x'] } });
    };
    const res = await createProvider({ model: 'claude-opus-5-5' }).structured({
      system: 'S',
      prompt: 'P',
      schemaName: 'verdict',
      jsonSchema: { type: 'object' },
      schema: z.object({ pass: z.boolean() }),
    });
    expect(res.value).toEqual({ pass: true, reason: 'ok', evidence: ['x'] });
    expect(sdk.calls[0]!.options).toMatchObject({
      model: 'claude-opus-5-5',
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      tools: [],
    });
  });
});
