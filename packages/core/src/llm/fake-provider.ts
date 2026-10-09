// Scripted provider for tests (docs/05 §6). LLM calls never happen in unit tests.
import type {
  DecisionRequest,
  DecisionResponse,
  LlmProvider,
  ProviderCapabilities,
  StructuredRequest,
  StructuredResponse,
  Usage,
} from './provider.js';

const USAGE: Usage = { inputTokens: 100, outputTokens: 10, requests: 1 };

/** A scripted decision: a tool call, plain text (no tool call), or a function of the request. */
export type ScriptedDecision =
  | { tool: string; args: Record<string, unknown> }
  | { text: string }
  | ((req: DecisionRequest) => Decision | Promise<Decision>);

type Decision = { tool: string; args: Record<string, unknown> } | { text: string };

export type ScriptedStructured = unknown | ((req: StructuredRequest) => unknown);

export class FakeProvider implements LlmProvider {
  readonly id = 'fake';
  readonly model = 'fake';
  readonly capabilities: ProviderCapabilities = {
    nativeTools: true,
    strictSchemas: true,
    vision: false,
    promptCaching: false,
  };
  /** Every request received, for assertions in tests. */
  readonly decisionRequests: DecisionRequest[] = [];
  readonly structuredRequests: StructuredRequest[] = [];

  constructor(
    private readonly decisions: ScriptedDecision[] = [],
    private readonly structuredAnswers: ScriptedStructured[] = [],
  ) {}

  /** Adds more scripted decisions (e.g. per step in a multi-step test). */
  script(...decisions: ScriptedDecision[]): this {
    this.decisions.push(...decisions);
    return this;
  }

  answer(...answers: ScriptedStructured[]): this {
    this.structuredAnswers.push(...answers);
    return this;
  }

  async decide(req: DecisionRequest): Promise<DecisionResponse> {
    this.decisionRequests.push(req);
    const next = this.decisions.shift();
    if (next === undefined) throw new Error('FakeProvider: no scripted decision left');
    const d = typeof next === 'function' ? await next(req) : next;
    if ('text' in d) return { text: d.text, stop: 'text', usage: USAGE };
    return { call: { tool: d.tool, args: d.args }, stop: 'tool', usage: USAGE };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    this.structuredRequests.push(req as StructuredRequest);
    if (!this.structuredAnswers.length) throw new Error('FakeProvider: no scripted structured answer left');
    const next = this.structuredAnswers.shift();
    const value =
      typeof next === 'function' ? (next as (r: StructuredRequest) => unknown)(req as StructuredRequest) : next;
    return { value, stop: 'tool', usage: USAGE };
  }
}
