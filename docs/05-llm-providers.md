# 05 — LLM providers

## 1. Principle

The engine owns the loop (decision D5). A provider answers two kinds of question:

1. **`decide`**: given the system prompt, task, history, observation and tool list, return **one tool call**.
2. **`structured`**: given a prompt and a JSON Schema, return one JSON object (used by `assert`, `extract`,
   `locate`, remedy synthesis and compiled checks).

Everything provider-specific (wire format, tool schema dialect, images, caching, refusals, retries)
stays inside the adapter package. The neutral types are modelled on OpenAI-style chat + function
calling (decision D3), so any OpenAI-compatible endpoint works through one adapter.

## 2. Interface

```ts
// packages/core/src/llm/provider.ts
export interface LlmProvider {
  readonly id: string;                     // 'anthropic' | 'openai' | 'copilot' | 'fake' | ...
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
  structured<T>(req: StructuredRequest<T>, signal?: AbortSignal): Promise<StructuredResponse<T>>;
  dispose?(): Promise<void>;
}

export interface ProviderCapabilities {
  nativeTools: boolean;        // false → adapter emulates tool calls via JSON output
  strictSchemas: boolean;      // provider enforces the JSON Schema on tool args
  vision: boolean;
  promptCaching: boolean;
  maxInputTokens?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  jsonSchema: JsonSchema;      // generated from Zod: z.toJSONSchema(schema) (zod v4)
}

export interface DecisionRequest {
  system: string;              // stable per run (cache-friendly)
  tools: ToolSpec[];           // stable per step
  context: string;             // hints + task + history (text)
  observation: string;         // URL, tabs, notices, snapshot (text)
  images?: { mediaType: 'image/jpeg' | 'image/png'; data: Buffer }[];
}

export interface DecisionResponse {
  call?: { tool: string; args: unknown };  // unvalidated; the loop validates with Zod
  text?: string;                           // model's rationale or stray text
  stop: 'tool' | 'text' | 'refusal' | 'length' | 'error';
  usage: Usage;
}

export interface StructuredRequest<T> {
  system: string;
  prompt: string;
  images?: DecisionRequest['images'];
  schemaName: string;
  jsonSchema: JsonSchema;
  zod: ZodType<T>;              // adapter may use it for local validation
}

export interface Usage {
  inputTokens: number; outputTokens: number;
  cacheReadTokens?: number; cacheWriteTokens?: number;
  costUsd?: number;             // from a price table in config, if known
  requests: number;
}
```

### 2.1 Cross-provider schema rules

To make one Zod schema work as a strict tool schema on every provider:
- Every object has `additionalProperties: false`, and **every property is listed in `required`**.
- Optional inputs are **nullable**, not omitted: `button: z.enum(['left','right','middle']).nullable()`.
- No `oneOf` at the top level of tool inputs. Use separate tools instead.
- Keep descriptions short and in the schema (`.describe()`). They are the tool documentation the model sees.

These are the constraints of OpenAI strict function calling, the strictest of the three. Anthropic
strict tools and the Copilot SDK accept the same schemas.

## 3. Adapter: Anthropic (`@aipw/provider-anthropic`) — development on this machine

Uses the official SDK `@anthropic-ai/sdk`. Credentials come from `ANTHROPIC_API_KEY` (or an `ant auth login`
profile; the zero-arg client resolves it).

```ts
import Anthropic from '@anthropic-ai/sdk';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  private client = new Anthropic();
  constructor(readonly model = 'claude-opus-5-5', private opts: { effort?: 'low' | 'medium' | 'high' } = {}) {}

  async decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',                       // re-run on a fallback model if the request is declined
      ...(this.opts.effort && { output_config: { effort: this.opts.effort } }),
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      tools: req.tools.map((t) => ({
        name: t.name, description: t.description, input_schema: t.jsonSchema, strict: true,
      })),
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: req.context },
          ...(req.images ?? []).map((img) => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mediaType, data: img.data.toString('base64') },
          })),
          { type: 'text', text: req.observation },
        ],
      }],
    }, { signal });

    if (res.stop_reason === 'refusal') return { stop: 'refusal', text: res.stop_details?.explanation, usage: toUsage(res) };
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return toolUse
      ? { call: { tool: toolUse.name, args: toolUse.input }, text, stop: 'tool', usage: toUsage(res) }
      : { text, stop: res.stop_reason === 'max_tokens' ? 'length' : 'text', usage: toUsage(res) };
  }
  // structured(): client.messages.parse({... output_config: { format: zodOutputFormat(req.zod) } })
}
```

Notes for the implementer:
- **Model default `claude-opus-5-5`.** Override via config (`model`). Effort is tunable via
  `output_config.effort` (Opus 5.5 defaults to `medium`). Measure `low` vs `medium` with the conformance
  suite before changing the default.
- **Forced tool choice (`any`/`tool`) returns a 400 on current models.** Use `auto` + the system-prompt
  instruction "call exactly one tool". The loop's repair turn handles the rare text-only reply.
- **Refusals**: check `stop_reason === 'refusal'` before reading content. `fallbacks: 'default'` with beta
  `server-side-fallback-2026-07-01` lets the API retry on a fallback model automatically. Drop it if your
  account or platform doesn't support it.
- **Thinking** stays at the model default (adaptive). Because each decision is a fresh single-turn request (D6), no
  thinking blocks are ever replayed, so preserved-thinking and history-editing rules don't apply.
- **Prompt caching**: tools → system render first and are stable. `cache_control` on the system block caches
  both. Check `usage.cache_read_input_tokens > 0` from the second decision onward.
- Use the SDK's typed errors (`Anthropic.RateLimitError`, `Anthropic.APIError`) for retry/backoff decisions.
  The SDK already retries 429/5xx twice.

## 3a. Adapter: Claude Code subscription (`@aipw/provider-claude-code`) — default on this machine

Decision D12. Uses `@anthropic-ai/claude-agent-sdk`, which runs a bundled Claude Code process. With
`ANTHROPIC_API_KEY` **unset**, it authenticates as the signed-in Claude Code user (`claude auth login`), so AI steps
count against that **Claude plan's usage limits** instead of billing an API key. Personal, local use only: the
pipeline keeps using Foundry, and a subscription login must never be shared by a team or used by a hosted service.

**Which usage it draws from (checked 2026-10-09, support article "Use the Claude Agent SDK with your Claude plan").**
A change that would have moved Agent SDK and `claude -p` usage off subscription limits (announced for 15 June 2026)
was **paused**: Agent SDK usage "still draw[s] from your subscription limits". Since 7 October 2026, Max and Team plans
*also* include monthly API credits that cover the Agent SDK and `claude -p`. Spike 0.5b checks which pool a run
actually uses (compare the plan's usage page before and after). This can change again, so `aipw doctor` will
link the article.

Like the Copilot SDK, the Agent SDK is an agent runtime, so the adapter uses the same **capture** pattern: our tools
are in-process MCP tools whose handlers record the call instead of running it.

```ts
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';

async decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
  let captured: { tool: string; args: unknown } | undefined;
  const server = createSdkMcpServer({
    name: 'aipw', version,
    tools: req.tools.map((t) => tool(t.name, t.description, zodShapeFor(t), async (args) => {
      captured ??= { tool: t.name, args };
      return { content: [{ type: 'text', text: 'Recorded. Stop now.' }] };
    })),
  });
  for await (const msg of query({
    prompt: `${req.context}\n\n${req.observation}`,
    options: {
      model: this.model,                     // undefined → the plan's default model
      systemPrompt: req.system,              // replaces Claude Code's own system prompt
      tools: [],                             // no built-in tools at all (no shell, files, web)
      mcpServers: { aipw: server },
      allowedTools: req.tools.map((t) => `mcp__aipw__${t.name}`),
      permissionMode: 'dontAsk',             // anything not allowed is denied, never prompted
      settingSources: [],                    // ignore ~/.claude settings, CLAUDE.md and hooks
      strictMcpConfig: true,                 // only our server: no claude.ai account connectors (spike 0.5b)
      persistSession: false,                 // don't write session transcripts
      maxTurns: 1,                           // end right after the tool call: ~5 s instead of ~9 s (spike 0.5b)
      cwd: emptyTempDir,
      abortController,                       // wired to `signal`
    },
  })) { /* collect usage from the 'result' message */ }
  // maxTurns: 1 makes the iterator throw "Reached maximum number of turns" after the result message.
  // The adapter catches exactly that error when a call was captured; anything else is a real failure.
  return captured ? { call: captured, stop: 'tool', usage } : { stop: 'text', usage };
}
```

`structured()` uses `outputFormat: { type: 'json_schema', schema }` and reads `structured_output` from the result
message. No tools are needed. Strip the `$schema` key from `z.toJSONSchema()` output first: the CLI rejects Zod's
draft 2020-12 marker.

Notes:
- **Tool schemas.** `tool()` takes a Zod raw shape, not JSON Schema. The adapter gets the Zod object from the tool
  registry (Zod is the source of truth anyway). Tool names reach the model as `mcp__aipw__<name>`; the adapter strips the prefix.
- **Usage.** The result message has `modelUsage` (tokens per model) and `total_cost_usd`. The cost is the API-equivalent
  estimate, not what the subscription charges; reports show it as "equivalent cost" and count `requests`.
- **Latency.** Every `query()` starts a Claude Code process. Spike 0.5b measured ~5 s per decision on Opus 5.5 (Pro
  plan), process start included, and ~$0.012 equivalent cost. That's acceptable for now. If it becomes the bottleneck,
  try a faster model (`AIPW_CLAUDE_MODEL`) first, then one streaming-input session per AI step (the Copilot fallback, §5 item 4).
- **Safety.** `tools: []` only removes *built-in* tools. Without `strictMcpConfig: true`, the model was also offered the
  account's claude.ai connectors (e.g. a docs connector). `allowedTools` + `dontAsk` would still deny them, but they
  must not be offered at all.
- **Limits.** An uncached run makes one request per decision. Lean on the plan cache; `budget.perRunRequests` applies.
- **Do not set `ANTHROPIC_API_KEY`** in the shell that runs tests with this provider, or the SDK silently uses the key.
- Phase 0 found the CLI not signed in on this machine even though the desktop app was. The desktop app's sign-in doesn't
  carry over: run `claude auth login` once. `aipw doctor --provider claude-code` will check `claude auth status`.

## 4. Adapter: OpenAI-compatible (`@aipw/provider-openai`) — pipelines (via Microsoft Foundry)

Uses the official `openai` npm package against **any** Chat Completions-compatible endpoint. The pipelines use
**OpenAI models deployed in Microsoft Foundry** (preset `foundry`, §4.2).

```ts
import OpenAI, { AzureOpenAI } from 'openai';

const client = cfg.azure
  ? new AzureOpenAI({ endpoint: cfg.azure.endpoint, apiKey: env(cfg.apiKeyEnv), apiVersion: cfg.azure.apiVersion, deployment: cfg.azure.deployment })
  : new OpenAI({ baseURL: cfg.baseURL, apiKey: env(cfg.apiKeyEnv) });

const res = await client.chat.completions.create({
  model: cfg.model,
  messages: [
    { role: 'system', content: req.system },
    { role: 'user', content: [
      { type: 'text', text: req.context },
      ...images.map((i) => ({ type: 'image_url' as const, image_url: { url: `data:${i.mediaType};base64,${i.data.toString('base64')}` } })),
      { type: 'text', text: req.observation },
    ] },
  ],
  tools: req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.jsonSchema, strict: cfg.compat.strictTools } })),
  tool_choice: cfg.compat.toolChoiceRequired ? 'required' : 'auto',
  ...(cfg.compat.parallelToolCallsParam && { parallel_tool_calls: false }),
}, { signal });

const call = res.choices[0]?.message.tool_calls?.find((c) => c.type === 'function');
// args: JSON.parse(call.function.arguments). Parse errors → repair turn.
```

`structured()` uses `response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } }`.
If `compat.jsonSchemaResponseFormat` is false, it falls back to `{ type: 'json_object' }`, puts the schema in the prompt and validates locally.

### 4.1 Endpoint presets

| Preset | `baseURL` | Auth env | Notes |
|---|---|---|---|
| **`foundry`** | `https://<resource>.openai.azure.com/openai/v1/` (or `https://<resource>.services.ai.azure.com/openai/v1/`) | Entra ID (keyless, recommended) or `AZURE_FOUNDRY_API_KEY` | **Pipelines.** `model` = Foundry **deployment name**. No `api-version` on the v1 route |
| `openai` | default | `OPENAI_API_KEY` | OpenAI directly |
| `azure-openai` | `AzureOpenAI` client | `AZURE_OPENAI_API_KEY` (or Entra ID token provider) | Legacy versioned Azure OpenAI routes. Prefer `foundry` |
| `github-models` | `https://models.github.ai/inference` | `GITHUB_TOKEN` (PAT with models scope) | Free tier, rate-limited. Handy fallback for local runs |
| `ollama` | `http://localhost:11434/v1` | none | Fully local. Tool calling and vision depend on the model |
| `lmstudio` / `vllm` | your URL | optional | |

Each preset ships `compat` flags (`strictTools`, `toolChoiceRequired`, `parallelToolCallsParam`, `vision`,
`jsonSchemaResponseFormat`). Defaults are conservative, and the user can override per config.
`aipw doctor` probes an endpoint and prints which flags work.

### 4.2 Microsoft Foundry (pipelines)

Foundry exposes deployed models through an OpenAI **v1-compatible** route. The standard `openai` client works
unchanged: point `baseURL` at it and pass the **deployment name** as `model`.

```ts
import OpenAI from 'openai';
import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';

// Keyless (recommended in pipelines): the identity needs an inference role on the Foundry resource
const tokenProvider = getBearerTokenProvider(new DefaultAzureCredential(), 'https://ai.azure.com/.default');

const client = new OpenAI({
  baseURL: `https://${process.env.AZURE_FOUNDRY_RESOURCE}.openai.azure.com/openai/v1/`,
  apiKey: process.env.AZURE_FOUNDRY_API_KEY ?? tokenProvider,   // API key, or Entra token provider
});

await client.chat.completions.create({ model: process.env.AIPW_FOUNDRY_DEPLOYMENT!, /* same request as §4 */ });
```

Notes:
- `@azure/identity` is an **optional peer dependency** of `@aipw/provider-openai`, loaded only for the `foundry` preset with no API key.
- `DefaultAzureCredential` picks up `az login` locally and the pipeline's service connection inside the `AzureCLI@2` task
  ([09](09-configuration-reporting-ci.md) §3), so no secret is stored for the model at all.
- We use **Chat Completions**, which every Foundry deployment supports. Strict function calling, `tool_choice: 'required'`,
  `json_schema` response format and image input depend on the **model** deployed. Run `aipw doctor --provider foundry`
  against the actual deployment (spike 0.4).
- Foundry content filters can block requests that contain page text. A filter block is surfaced as
  `AiProviderError(kind: 'content_filter')` rather than a generic 400, so it's recognisable in reports.
- Foundry can also host Claude. If you ever want Claude in the pipeline, that goes through the **Anthropic adapter**
  using the `AnthropicFoundry` client from `@anthropic-ai/foundry-sdk`, not this adapter. Server-side `fallbacks` are not
  available on Foundry, so the adapter omits them there.

## 5. Adapter: GitHub Copilot SDK (`@aipw/provider-copilot`) — local runs on another machine

Uses `@github/copilot-sdk` (GA since June 2026). It bundles the Copilot CLI runtime and authenticates as the
logged-in Copilot user (or a `GITHUB_TOKEN`), so that machine needs a Copilot licence and **no separate API key**.

The Copilot SDK is an *agent runtime*: it runs its own loop and calls tools itself. To keep our engine in
charge of the loop (D5), the adapter **captures** the tool call instead of letting Copilot execute anything:

```ts
import { CopilotClient, defineTool } from '@github/copilot-sdk';

const client = new CopilotClient();            // useLoggedInUser by default; or { gitHubToken: process.env.GITHUB_TOKEN }
await client.start();

async function decide(req: DecisionRequest): Promise<DecisionResponse> {
  let captured: { tool: string; args: unknown } | undefined;

  const tools = req.tools.map((t) => defineTool(t.name, {
    description: t.description,
    parameters: t.jsonSchema,
    skipPermission: true,
    handler: async (args: unknown) => {
      if (captured) return 'Rejected: only one action per turn. End your turn now.';
      captured = { tool: t.name, args };
      return 'Recorded. The test engine will perform this action. End your turn now; do not call other tools.';
    },
  }));

  await using session = await client.createSession({
    model: cfg.model,                                // from client.listModels(); configurable
    tools,
    availableTools: req.tools.map((t) => t.name),    // ONLY our tools: no shell, no file edits
    systemMessage: { mode: 'replace', content: req.system },
    onPermissionRequest: denyEverything,             // nothing should ask; deny if it does
  });

  const msg = await session.sendAndWait({ prompt: `${req.context}\n\n${req.observation}` });
  return captured
    ? { call: captured, text: msg?.data.content, stop: 'tool', usage: estimateUsage(req, msg) }
    : { text: msg?.data.content, stop: 'text', usage: estimateUsage(req, msg) };
}
```

`structured()` uses the same capture trick with a single tool `submit_result` whose parameters are the requested schema.

**⚠ verify in Phase 0** (these decide the final shape of this adapter):
1. `availableTools` restricted to our names really disables every built-in tool (shell, file edit, web fetch).
2. The turn ends promptly after our handler returns. Otherwise abort the turn once a call is captured.
3. Image attachments on `send`/`sendAndWait`. If unsupported, set `capabilities.vision = false`, or save the
   screenshot to a temp file and attach it as a file.
4. Session-per-decision latency. If session creation is slow, use **one session per AI step** and send each
   new observation as the next message. That breaks D6 for this provider only, which is acceptable; note it in the adapter.
5. Exact `onPermissionRequest` handler signature for "deny".
6. Token usage reporting. Copilot bills in **premium requests** with per-model multipliers, not tokens. Report
   `requests` and treat `costUsd` as unknown. An uncached run can consume many premium requests, so lean on the cache.

**Phase 0 type-level findings** (`@github/copilot-sdk` 1.0.19; still to be confirmed live by spike 0.3):
- `defineTool(name, { isTerminal: true })` ends the agent turn after a successful call. That is exactly the capture
  pattern (item 2), with no abort needed.
- `availableTools` also accepts a `ToolSet` (`new ToolSet().addCustom('*')`), which can't match built-ins by accident.
- Images: `attachments: [{ type: 'blob', data: base64, mimeType: 'image/jpeg' }]` (item 3).
- Deny: the handler returns `{ kind: 'reject', feedback }` (item 5).
- Usage arrives as `assistant.usage` session events (item 6), not on the final message.
- `sendAndWait({ prompt, responseSchema })` takes a Zod schema, so `structured()` may not need the `submit_result` trick.

**Fallback if the spike fails:** run Copilot-machine tests through the OpenAI adapter with the `github-models`
preset (a PAT instead of a Copilot session). No engine changes are needed.

## 6. Fake provider (unit tests)

`FakeProvider` in core replays a scripted list of decisions keyed by step and turn, with optional
assertions on the request (e.g., "the snapshot contains `button "Add user"`"). All core logic is tested with it.
LLM calls never happen in unit tests.

## 7. Selecting a provider

```ts
// aipw.config.ts
export default defineAipwConfig({
  provider: process.env.AIPW_PROVIDER ?? 'claude-code',
  providers: {
    'claude-code': { package: '@aipw/provider-claude-code', model: process.env.AIPW_CLAUDE_MODEL },  // undefined → plan default
    anthropic: { package: '@aipw/provider-anthropic', model: 'claude-opus-5-5' },
    foundry:   { package: '@aipw/provider-openai', preset: 'foundry',
                 resource: process.env.AZURE_FOUNDRY_RESOURCE, model: process.env.AIPW_FOUNDRY_DEPLOYMENT,
                 auth: process.env.AZURE_FOUNDRY_API_KEY ? 'apiKey' : 'entra' },
    openai:    { package: '@aipw/provider-openai', preset: 'openai', model: process.env.AIPW_OPENAI_MODEL },
    copilot:   { package: '@aipw/provider-copilot', model: process.env.AIPW_COPILOT_MODEL },
    ollama:    { package: '@aipw/provider-openai', preset: 'ollama', model: 'qwen3:14b' },
  },
});
```

| Where | `AIPW_PROVIDER` | Credentials |
|---|---|---|
| This machine (dev) | `claude-code` | Claude Code sign-in (`claude auth login`), with `ANTHROPIC_API_KEY` unset |
| This machine, with an API key | `anthropic` | `ANTHROPIC_API_KEY` |
| Other machine (local) | `copilot` | Copilot sign-in on that machine |
| Azure Pipelines | `foundry` | Entra ID via the pipeline's Azure service connection (keyless), or `AZURE_FOUNDRY_API_KEY` as a secret variable |

Optional: a different model for cheap sub-tasks (`assertModel`, `extractModel`), configured per provider. Off by default.

## 8. Provider conformance suite

`examples/tests/conformance/` runs the demo-app scenarios with `AIPW_CACHE=ai-only` against each provider and
writes `conformance-<provider>-<model>.json`:

| Metric | Why |
|---|---|
| Step success rate | Can this model drive this UI at all? |
| Mean decisions per step | Efficiency (fewer is better and cheaper) |
| Repair turns | Schema adherence |
| Tokens / premium requests per step | Cost |
| p50 / p95 decision latency | Speed |

Run it when adopting a new model, and compare against the previous run before switching CI to it.
