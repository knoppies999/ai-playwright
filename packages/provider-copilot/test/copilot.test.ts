import { contractDecisionRequest, contractStructuredRequest } from '@aipw/core';
import { describe, expect, it } from 'vitest';
import {
  createProvider,
  SUBMIT_TOOL,
  type CopilotSdk,
  type SessionOptions,
  type ToolDefinition,
} from '../src/index.js';

type Defined = { name: string } & ToolDefinition;

/**
 * A fake Copilot runtime: `script` plays the model, calling tool handlers the way the runtime would, and returns the
 * final assistant message.
 */
function fakeSdk(script: (tools: Defined[], prompt: { prompt: string; attachments?: unknown[] }) => Promise<string>) {
  const sessions: { options: SessionOptions; prompts: unknown[] }[] = [];
  const clients: unknown[] = [];
  const sdk: CopilotSdk = {
    defineTool: (name, definition) => ({ name, ...definition }),
    createClient: async (options) => {
      clients.push(options);
      return {
        createSession: async (options) => {
          const record = { options, prompts: [] as unknown[] };
          sessions.push(record);
          const usage: ((e: { data?: object }) => void)[] = [];
          return {
            on: (_event, listener) => usage.push(listener),
            sendAndWait: async (message) => {
              record.prompts.push(message);
              const content = await script(options.tools as Defined[], message);
              for (const l of usage) l({ data: { inputTokens: 900, outputTokens: 20, premiumRequests: 1 } });
              return { data: { content } };
            },
          };
        },
      };
    },
  };
  return { sdk, sessions, clients };
}

const callTool = async (tools: Defined[], name: string, args: unknown) =>
  tools.find((t) => t.name === name)!.handler(args);

describe('provider-copilot (contract, fake runtime)', () => {
  it('session options: only our tools, each terminal, permissions rejected, system replaced (snapshot)', async () => {
    const { sdk, sessions } = fakeSdk(async (tools) => {
      await callTool(tools, 'done', { summary: 'ok', evidence: [] });
      return '';
    });
    await createProvider({ sdk, model: 'gpt-5.4', env: {} }).decide(contractDecisionRequest());
    const { options } = sessions[0]!;
    const serialisable = {
      ...options,
      tools: (options.tools as Defined[]).map(({ handler: _h, ...t }) => t),
      onPermissionRequest: await options.onPermissionRequest(),
    };
    await expect(JSON.stringify(serialisable, null, 2)).toMatchFileSnapshot('./golden/session-options.json');
    expect(options.availableTools).toEqual(['click', 'fill', 'done', 'fail']);
  });

  it('captures exactly one tool call and refuses a second', async () => {
    const replies: string[] = [];
    const { sdk, sessions } = fakeSdk(async (tools) => {
      replies.push(
        await callTool(tools, 'click', { ref: 'e7', button: null, modifiers: null, clickCount: null, intent: 'save' }),
      );
      replies.push(await callTool(tools, 'done', { summary: 'x', evidence: [] }));
      return 'Clicked Save.';
    });
    const res = await createProvider({ sdk, env: {} }).decide(contractDecisionRequest({ image: true }));
    expect(res).toEqual({
      call: { tool: 'click', args: { ref: 'e7', button: null, modifiers: null, clickCount: null, intent: 'save' } },
      text: 'Clicked Save.',
      stop: 'tool',
      usage: { inputTokens: 900, outputTokens: 20, requests: 1 },
    });
    expect(replies[0]).toMatch(/^Recorded/);
    expect(replies[1]).toMatch(/^Rejected: only one action/);
    const prompt = sessions[0]!.prompts[0] as { prompt: string; attachments: { type: string; mimeType: string }[] };
    expect(prompt.prompt).toContain('instruction: Save the profile');
    expect(prompt.prompt).toContain('button "Save" [ref=e7]');
    expect(prompt.attachments).toEqual([expect.objectContaining({ type: 'blob', mimeType: 'image/png' })]);
  });

  it('a reply without a tool call is text (the loop repairs it)', async () => {
    const { sdk } = fakeSdk(async () => 'I think I should click Save.');
    expect(await createProvider({ sdk, env: {} }).decide(contractDecisionRequest())).toMatchObject({
      stop: 'text',
      text: 'I think I should click Save.',
    });
  });

  it('structured() captures a submit_result call with the schema as its parameters', async () => {
    const { sdk, sessions } = fakeSdk(async (tools) => {
      await callTool(tools, SUBMIT_TOOL, { pass: true, reason: 'shown' });
      return '';
    });
    const res = await createProvider({ sdk, env: {} }).structured(contractStructuredRequest());
    expect(res).toMatchObject({ value: { pass: true, reason: 'shown' }, stop: 'tool' });
    const tool = (sessions[0]!.options.tools as Defined[])[0]!;
    expect(tool).toMatchObject({
      name: 'submit_result',
      isTerminal: true,
      parameters: contractStructuredRequest().jsonSchema,
    });
    expect(sessions[0]!.options.availableTools).toEqual(['submit_result']);
  });

  it('uses a GitHub token from the configured env var instead of the signed-in user', async () => {
    const { sdk, clients } = fakeSdk(async () => '');
    await createProvider({ sdk, gitHubTokenEnv: 'GITHUB_TOKEN', env: { GITHUB_TOKEN: 'ghp_x' } }).decide(
      contractDecisionRequest(),
    );
    expect(clients).toEqual([{ gitHubToken: 'ghp_x' }]);
  });
});
