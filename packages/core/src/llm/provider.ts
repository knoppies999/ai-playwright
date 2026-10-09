// The provider contract (docs/05 §2). Providers answer two questions and nothing else:
// "which one tool call next?" (decide) and "fill in this JSON schema" (structured).
import type { z } from 'zod';

export type JsonSchema = Record<string, unknown>;

export interface ProviderCapabilities {
  /** false → the adapter emulates tool calls through JSON output. */
  nativeTools: boolean;
  /** The provider enforces the JSON Schema on tool arguments. */
  strictSchemas: boolean;
  vision: boolean;
  promptCaching: boolean;
  maxInputTokens?: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** Generated from `schema` (never hand-written). */
  jsonSchema: JsonSchema;
  /** The Zod source of truth. Adapters that take Zod (Agent SDK, Copilot SDK) use it directly. */
  schema: z.ZodObject;
}

export interface ImageInput {
  mediaType: 'image/jpeg' | 'image/png';
  data: Buffer;
}

export interface DecisionRequest {
  /** Stable per run (prompt-cache friendly). */
  system: string;
  /** Stable per step. */
  tools: ToolSpec[];
  /** Hints + task + history. */
  context: string;
  /** URL, tabs, notices, snapshot. */
  observation: string;
  images?: ImageInput[];
}

export type StopReason = 'tool' | 'text' | 'refusal' | 'length' | 'error';

export interface DecisionResponse {
  /** Unvalidated: the loop validates `args` with the tool's Zod schema. */
  call?: { tool: string; args: unknown };
  text?: string;
  stop: StopReason;
  usage: Usage;
}

export interface StructuredRequest<T = unknown> {
  system: string;
  prompt: string;
  images?: ImageInput[];
  schemaName: string;
  jsonSchema: JsonSchema;
  schema: z.ZodType<T>;
}

export interface StructuredResponse<T = unknown> {
  /** Unvalidated: the caller validates with the Zod schema and may run a repair turn. */
  value: unknown;
  text?: string;
  stop: StopReason;
  usage: Usage;
  /** Only set by callers after validation. */
  parsed?: T;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** API-equivalent cost estimate in USD, if known. */
  costUsd?: number;
  requests: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, requests: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number) => (x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0));
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens),
    costUsd: sum(a.costUsd, b.costUsd),
    requests: a.requests + b.requests,
  };
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  decide(req: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse>;
  structured<T>(req: StructuredRequest<T>, signal?: AbortSignal): Promise<StructuredResponse<T>>;
  dispose?(): Promise<void>;
}

/** What a provider package exports: `export function createProvider(options): LlmProvider`. */
export type ProviderFactory = (options: Record<string, unknown>) => LlmProvider | Promise<LlmProvider>;
