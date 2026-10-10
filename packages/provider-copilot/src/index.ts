// GitHub Copilot CLI adapter (docs/05 §5, decision D13): drives the Copilot CLI engine through @github/copilot-sdk
// and *captures* the one tool call per decision instead of letting Copilot execute anything, so aipw's engine keeps
// the loop. Written against the SDK's types (1.0.19, docs/05 §5 "Phase 0 type-level findings"); not yet run live:
// spike 0.3 on the Copilot machine confirms it. Every SDK touchpoint goes through the small CopilotSdk interface
// below, so a change found by the spike stays in one place.
import {
  AiProviderError,
  emptyUsage,
  type DecisionRequest,
  type DecisionResponse,
  type JsonSchema,
  type LlmProvider,
  type StructuredRequest,
  type StructuredResponse,
  type Usage,
} from '@aipw/core';

// ---- The SDK surface aipw uses -------------------------------------------------------------------------------

export interface ToolDefinition {
  description: string;
  parameters: JsonSchema;
  /** Ends the agent turn after the call: the capture pattern, with no abort needed. */
  isTerminal: boolean;
  skipPermission: boolean;
  handler: (args: unknown) => Promise<string>;
}

export interface SessionOptions {
  model: string;
  tools: unknown[];
  /** Only our tools: no shell, file edits or web fetch. */
  availableTools: string[];
  systemMessage: { mode: 'replace'; content: string };
  onPermissionRequest: () => Promise<{ kind: 'reject'; feedback: string }>;
}

export interface CopilotSession {
  sendAndWait(message: {
    prompt: string;
    attachments?: { type: 'blob'; data: string; mimeType: string }[];
  }): Promise<{ data?: { content?: string } } | undefined>;
  on(event: 'assistant.usage', listener: (e: { data?: UsageEvent }) => void): void;
  disconnect?(): Promise<void>;
}

interface UsageEvent {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  premiumRequests?: number;
}

export interface CopilotSdk {
  defineTool(name: string, definition: ToolDefinition): unknown;
  createClient(options: { gitHubToken?: string }): Promise<{
    createSession(options: SessionOptions): Promise<CopilotSession>;
    stop?(): Promise<void>;
  }>;
}

/** The real SDK, imported only when the copilot provider is used. */
async function loadSdk(): Promise<CopilotSdk> {
  let mod: {
    CopilotClient: new (o: { gitHubToken?: string }) => {
      start(): Promise<void>;
      createSession(o: SessionOptions): Promise<CopilotSession>;
      stop?(): Promise<void>;
    };
    defineTool: CopilotSdk['defineTool'];
  };
  try {
    mod = (await import(/* optional */ '@github/copilot-sdk' as string)) as typeof mod;
  } catch (error) {
    throw new AiProviderError(
      'auth',
      'copilot: install @github/copilot-sdk on this machine (npm i -D @github/copilot-sdk) and sign in to Copilot CLI',
      {},
      { cause: error },
    );
  }
  return {
    defineTool: mod.defineTool,
    createClient: async (options) => {
      const client = new mod.CopilotClient(options);
      await client.start();
      return client;
    },
  };
}

// ---- Capture --------------------------------------------------------------------------------------------------

const RECORDED = 'Recorded. The test engine will perform this action. End your turn now.';
const ONE_ONLY = 'Rejected: only one action per turn. End your turn now.';
export const SUBMIT_TOOL = 'submit_result';

/** Session options for one decision: our tools only, each one a terminal capture (pure apart from the handlers). */
export function sessionOptions(
  sdk: Pick<CopilotSdk, 'defineTool'>,
  model: string,
  system: string,
  tools: { name: string; description: string; jsonSchema: JsonSchema }[],
  capture: (tool: string, args: unknown) => boolean,
): SessionOptions {
  return {
    model,
    tools: tools.map((t) =>
      sdk.defineTool(t.name, {
        description: t.description,
        parameters: t.jsonSchema,
        isTerminal: true,
        skipPermission: true,
        handler: async (args) => (capture(t.name, args) ? RECORDED : ONE_ONLY),
      }),
    ),
    availableTools: tools.map((t) => t.name),
    systemMessage: { mode: 'replace', content: system },
    onPermissionRequest: async () => ({
      kind: 'reject',
      feedback: 'Nothing may run here: call exactly one of the offered tools.',
    }),
  };
}

export interface CopilotOptions {
  model?: string;
  /** Instead of the signed-in Copilot CLI user. */
  gitHubTokenEnv?: string;
  vision?: boolean;
  env?: NodeJS.ProcessEnv;
  /** For tests: a fake SDK. */
  sdk?: CopilotSdk;
}

export class CopilotProvider implements LlmProvider {
  readonly id = 'copilot';
  readonly model: string;
  readonly capabilities;
  private client?: Awaited<ReturnType<CopilotSdk['createClient']>>;
  private sdk?: CopilotSdk;

  constructor(private readonly options: CopilotOptions = {}) {
    const env = options.env ?? process.env;
    this.model = options.model ?? env.AIPW_COPILOT_MODEL ?? 'gpt-5.4';
    // Strict schemas: the runtime validates tool parameters; images via blob attachments (to confirm in spike 0.3).
    this.capabilities = {
      nativeTools: true,
      strictSchemas: true,
      vision: options.vision ?? true,
      promptCaching: false,
    };
  }

  private async session(system: string, tools: Parameters<typeof sessionOptions>[3]) {
    this.sdk ??= this.options.sdk ?? (await loadSdk());
    const env = this.options.env ?? process.env;
    const token = this.options.gitHubTokenEnv ? env[this.options.gitHubTokenEnv] : undefined;
    this.client ??= await this.sdk.createClient(token ? { gitHubToken: token } : {});
    let captured: { tool: string; args: unknown } | undefined;
    const options = sessionOptions(this.sdk, this.model, system, tools, (tool, args) => {
      if (captured) return false;
      captured = { tool, args };
      return true;
    });
    const session = await this.client.createSession(options);
    // Copilot bills premium requests, not tokens: count requests; tokens only when the runtime reports them.
    const usage: Usage = { ...emptyUsage(), requests: 1 };
    session.on('assistant.usage', (e) => {
      usage.inputTokens += e.data?.inputTokens ?? 0;
      usage.outputTokens += e.data?.outputTokens ?? 0;
      if (e.data?.cacheReadTokens) usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + e.data.cacheReadTokens;
    });
    return { session, usage, captured: () => captured };
  }

  private attachments(images: DecisionRequest['images']) {
    return this.capabilities.vision && images?.length
      ? images.map((i) => ({ type: 'blob' as const, data: i.data.toString('base64'), mimeType: i.mediaType }))
      : undefined;
  }

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    const { session, usage, captured } = await this.session(req.system, req.tools);
    try {
      const attachments = this.attachments(req.images);
      const msg = await session.sendAndWait({
        prompt: `${req.context}\n\n${req.observation}`,
        ...(attachments && { attachments }),
      });
      const text = msg?.data?.content || undefined;
      const call = captured();
      return call
        ? { call, ...(text && { text }), stop: 'tool', usage }
        : { ...(text && { text }), stop: 'text', usage };
    } finally {
      await session.disconnect?.().catch(() => undefined);
    }
  }

  /** structured(): the same capture with one tool, submit_result, whose parameters are the requested schema. */
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const tool = {
      name: SUBMIT_TOOL,
      description: `Submit the ${req.schemaName} result.`,
      jsonSchema: req.jsonSchema,
    };
    const { session, usage, captured } = await this.session(`${req.system}\n\nAnswer by calling ${SUBMIT_TOOL}.`, [
      tool,
    ]);
    try {
      const attachments = this.attachments(req.images);
      const msg = await session.sendAndWait({ prompt: req.prompt, ...(attachments && { attachments }) });
      const call = captured();
      return { value: call?.args, text: msg?.data?.content ?? '', stop: call ? 'tool' : 'text', usage };
    } finally {
      await session.disconnect?.().catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    await this.client?.stop?.();
  }
}

/** The provider factory the loader calls (docs/05 §7). */
export function createProvider(options: Record<string, unknown>): LlmProvider {
  return new CopilotProvider(options as CopilotOptions);
}
