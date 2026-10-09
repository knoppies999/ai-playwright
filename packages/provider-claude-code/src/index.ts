// Claude Code subscription adapter (docs/05 §3a, decision D12). Runs the Claude Agent SDK on the
// signed-in Claude Code account, so AI steps count against that plan's usage, not an API key.
// The SDK is an agent runtime; we keep the engine in charge by "capturing" the tool call: our tools
// are in-process MCP tools whose handlers only record the call (spike 0.5b).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  AiProviderError,
  emptyUsage,
  type DecisionRequest,
  type DecisionResponse,
  type LlmProvider,
  type ProviderCapabilities,
  type StructuredRequest,
  type StructuredResponse,
  type Usage,
} from '@aipw/core';

export interface ClaudeCodeOptions {
  /** Model id or alias. Default: Sonnet 5.5 (faster and lighter on plan limits than Opus). */
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  /**
   * By default ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from the Claude Code process, so it
   * always uses the subscription sign-in. Set true to let a key take over.
   */
  useApiKey?: boolean;
  pathToClaudeCodeExecutable?: string;
}

const TOOL_PREFIX = 'mcp__aipw__';
const DEFAULT_MODEL = 'claude-sonnet-5-5';

export function createProvider(options: Record<string, unknown> = {}): LlmProvider {
  return new ClaudeCodeProvider(options as ClaudeCodeOptions);
}

interface RunResult {
  text: string;
  usage: Usage;
  /** tool_use blocks as the model sent them, before Claude Code validated the input. */
  toolUses: { name: string; input: unknown }[];
  structured?: unknown;
  error?: unknown;
}

export class ClaudeCodeProvider implements LlmProvider {
  readonly id = 'claude-code';
  readonly model: string;
  readonly capabilities: ProviderCapabilities = {
    nativeTools: true,
    // Claude Code validates MCP tool input with the Zod shape, but not as a strict provider-side schema.
    strictSchemas: false,
    // Images would need a streaming SDKUserMessage; not wired up yet.
    vision: false,
    promptCaching: true,
  };
  /** An empty working directory: nothing for Claude Code to pick up (no CLAUDE.md, no project settings). */
  private readonly cwd = mkdtempSync(join(tmpdir(), 'aipw-claude-'));

  constructor(private readonly options: ClaudeCodeOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
  }

  private env(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'aipw/0.0.0' };
    if (!this.options.useApiKey) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    return env;
  }

  private baseOptions(abortController: AbortController): Options {
    return {
      model: this.model,
      ...(this.options.effort && { effort: this.options.effort }),
      ...(this.options.pathToClaudeCodeExecutable && {
        pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
      }),
      tools: [], // no built-in tools: no shell, files or web
      strictMcpConfig: true, // no claude.ai account connectors (spike 0.5b)
      settingSources: [], // ignore ~/.claude settings, CLAUDE.md and hooks
      persistSession: false,
      permissionMode: 'dontAsk',
      cwd: this.cwd,
      env: this.env() as Options['env'],
      abortController,
    };
  }

  private async run(prompt: string, options: Options): Promise<RunResult> {
    const result: RunResult = { text: '', usage: { ...emptyUsage(), requests: 1 }, toolUses: [] };
    try {
      for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') result.text += block.text;
            if (block.type === 'tool_use') result.toolUses.push({ name: block.name, input: block.input });
          }
        }
        if (msg.type === 'result') {
          result.usage = toUsage(msg);
          if (msg.subtype === 'success') result.structured = msg.structured_output;
          if (msg.subtype === 'success' && !result.text) result.text = msg.result;
        }
      }
    } catch (error) {
      result.error = error;
    }
    return result;
  }

  async decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    let captured: { tool: string; args: unknown } | undefined;
    const server = createSdkMcpServer({
      name: 'aipw',
      version: '0.0.0',
      tools: req.tools.map((t) =>
        tool(t.name, t.description, t.schema.shape, async (args) => {
          captured ??= { tool: t.name, args };
          return { content: [{ type: 'text' as const, text: 'Recorded. The test engine performs it. Stop now.' }] };
        }),
      ),
    });
    const abort = linkAbort(signal);
    const res = await this.run(`${req.context}\n\n${req.observation}`, {
      ...this.baseOptions(abort),
      systemPrompt: req.system,
      mcpServers: { aipw: server },
      allowedTools: req.tools.map((t) => `${TOOL_PREFIX}${t.name}`),
      // End right after the tool call: ~5 s instead of ~9 s. The SDK then throws "maximum number of turns",
      // which is expected once a call was captured (spike 0.5b).
      maxTurns: 1,
    });
    if (captured) return { call: captured, text: res.text || undefined, stop: 'tool', usage: res.usage };
    // The handler only runs when the input passes Claude Code's own check against the tool's Zod shape.
    // A call that failed it is still the model's decision: hand it to the engine, whose validator gives
    // the model a precise repair message (first live run: a `done` call vanished this way twice).
    const attempted = res.toolUses.find((u) => u.name.startsWith(TOOL_PREFIX));
    if (attempted) {
      return {
        call: { tool: attempted.name.slice(TOOL_PREFIX.length), args: attempted.input },
        text: res.text || undefined,
        stop: 'tool',
        usage: res.usage,
      };
    }
    if (res.error && !isMaxTurns(res.error)) throw mapError(res.error);
    return { text: res.text, stop: 'text', usage: res.usage };
  }

  async structured<T>(req: StructuredRequest<T>, signal?: AbortSignal): Promise<StructuredResponse<T>> {
    const abort = linkAbort(signal);
    const res = await this.run(req.prompt, {
      ...this.baseOptions(abort),
      systemPrompt: req.system,
      outputFormat: { type: 'json_schema', schema: req.jsonSchema },
      maxTurns: 3,
    });
    if (res.error && res.structured === undefined) throw mapError(res.error);
    let value = res.structured;
    if (value === undefined) {
      try {
        value = JSON.parse(res.text);
      } catch {
        value = undefined;
      }
    }
    return { value, text: res.text, stop: value === undefined ? 'text' : 'tool', usage: res.usage };
  }
}

function linkAbort(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}

const isMaxTurns = (error: unknown) => /maximum number of turns/i.test(String(error));

function mapError(error: unknown): AiProviderError {
  const text = error instanceof Error ? error.message : String(error);
  if (/authenticat|oauth|log ?in|not signed in|401/i.test(text)) {
    return new AiProviderError(
      'auth',
      `Claude Code is not signed in (${text}). Run \`claude auth login\` once in a terminal. The desktop app's sign-in does not carry over.`,
      {},
      { cause: error },
    );
  }
  if (/rate.?limit|usage limit|limit reached|429|overloaded/i.test(text)) {
    return new AiProviderError('rate_limit', `Claude plan limit or rate limit: ${text}`, {}, { cause: error });
  }
  return new AiProviderError('other', `Claude Code failed: ${text}`, {}, { cause: error });
}

function toUsage(msg: Extract<SDKMessage, { type: 'result' }>): Usage {
  const usage = { ...emptyUsage(), requests: 1, costUsd: msg.total_cost_usd, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const m of Object.values(msg.modelUsage ?? {})) {
    usage.inputTokens += m.inputTokens;
    usage.outputTokens += m.outputTokens;
    usage.cacheReadTokens += m.cacheReadInputTokens;
    usage.cacheWriteTokens += m.cacheCreationInputTokens;
  }
  return usage;
}
