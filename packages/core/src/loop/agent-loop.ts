// The agent loop (docs/04 §3): observe → decide → validate → execute → settle, until done, fail or a
// limit. One tool call per decision, fresh prompt per decision (AGENTS.md rule 2).
import type { ActionExecutor } from '../actions/executor.js';
import { toolSpecs, validateCall, type ToolCall, type ToolName } from '../actions/schemas.js';
import { AiProviderError } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import { addUsage, emptyUsage, type DecisionRequest, type LlmProvider, type Usage } from '../llm/provider.js';
import { refsIn } from '../observe/snapshot.js';
import type { StepSession } from '../step/session.js';
import type { ActionRecord, StepContext, StepOutcome } from '../types.js';
import { buildContext, buildObservation, historyLine, SYSTEM_PROMPTS } from './prompt.js';

export interface LoopDeps {
  session: StepSession;
  provider: LlmProvider;
  executor: ActionExecutor;
  events: EventBus;
  tools: ToolName[];
  hints: string[];
  secretPlaceholders: string[];
  isAllowedUrl: (url: string) => boolean;
  maxActions: number;
  /** Epoch ms after which the step stops. */
  deadline: number;
  signal?: AbortSignal;
}

interface Decision {
  call: ToolCall;
  text?: string;
  usage: Usage;
  repaired: boolean;
}

/** One provider call, plus at most one repair turn for a missing or invalid tool call (docs/04 §4.2). */
export async function decideWithRepair(
  provider: LlmProvider,
  req: DecisionRequest,
  offered: readonly string[],
  signal?: AbortSignal,
): Promise<Decision> {
  let usage = emptyUsage();
  let problem = '';
  let lastText: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const request =
      attempt === 0 ? req : { ...req, context: `${req.context}\n\nYOUR PREVIOUS REPLY WAS INVALID\n${problem}` };
    const res = await provider.decide(request, signal);
    usage = addUsage(usage, res.usage);
    lastText = res.text;
    if (res.stop === 'refusal')
      throw new AiProviderError('refusal', `The model refused: ${res.text ?? 'no explanation'}`);
    if (!res.call) {
      problem = 'You replied with text only. Respond by calling exactly one tool.';
      continue;
    }
    const validated = validateCall(res.call, offered);
    if (validated.ok) return { call: validated.call, text: res.text, usage, repaired: attempt > 0 };
    problem = `${validated.error}\nCall exactly one of the offered tools with valid arguments.`;
  }
  throw new AiProviderError(
    'no_tool_call',
    `The model did not produce a valid tool call after a repair turn: ${problem}` +
      (lastText ? `\nIts last reply: ${lastText.slice(0, 500)}` : ''),
  );
}

const targetKey = (r: ActionRecord) => `${r.tool}:${r.target?.ref ?? JSON.stringify(r.args)}`;
const PASSIVE = new Set(['expand', 'wait_for']);

/** docs/04 §3.2: the same tool + target three times in a row, or three actions that changed nothing. */
function noProgress(history: ActionRecord[], currentHash: string): string | undefined {
  const active = history.filter((r) => !PASSIVE.has(r.tool));
  const last3 = active.slice(-3);
  if (last3.length < 3) return undefined;
  if (last3.every((r) => targetKey(r) === targetKey(last3[0]!))) return `repeated ${targetKey(last3[0]!)} three times`;
  if (last3.every((r) => r.before.snapshotHash === currentHash && r.before.url === last3[0]!.before.url)) {
    return 'the last three actions did not change the page';
  }
  return undefined;
}

export async function runAgentLoop(step: StepContext, deps: LoopDeps): Promise<StepOutcome> {
  const history: ActionRecord[] = [];
  const specs = toolSpecs(deps.tools);
  const offered = deps.tools as readonly string[];
  const expandedRefs = new Set<string>();
  let expanded: string | undefined;
  let usage = emptyUsage();
  let lastSnapshot: string | undefined;

  const finish = (status: StepOutcome['status'], summary: string, extra: Partial<StepOutcome> = {}): StepOutcome => ({
    status,
    actions: history,
    summary,
    evidence: [],
    usage,
    source: 'ai',
    lastSnapshot,
    ...extra,
  });
  const failLimit = (reason: string) => finish('failed', reason, { failure: { kind: 'limit', reason } });

  for (let turn = 0; turn < deps.maxActions; turn++) {
    if (Date.now() > deps.deadline) return failLimit('step timeout reached');
    if (deps.signal?.aborted) return failLimit('aborted');

    const obs = await deps.session.observer.observe(step.options.scope);
    expandedRefs.forEach((r) => obs.refs.add(r));
    lastSnapshot = obs.snapshot;
    deps.events.emit({
      type: 'observation',
      stepId: step.id,
      url: obs.url,
      snapshot: obs.snapshot,
      snapshotHash: obs.snapshotHash,
    });

    const stuck = noProgress(history, obs.snapshotHash);
    if (stuck) return failLimit(`no progress: ${stuck}`);

    const last = history[history.length - 1];
    const req: DecisionRequest = {
      system: SYSTEM_PROMPTS.act,
      tools: specs,
      context: buildContext({ step, hints: deps.hints, secretPlaceholders: deps.secretPlaceholders, history }),
      observation: buildObservation(obs, { lastResult: last?.result, expanded }),
    };
    const started = Date.now();
    const decision = await decideWithRepair(deps.provider, req, offered, deps.signal);
    usage = addUsage(usage, decision.usage);
    deps.events.emit({
      type: 'decision',
      stepId: step.id,
      turn,
      tool: decision.call.tool,
      args: decision.call.args,
      text: decision.text,
      repaired: decision.repaired,
      usage: decision.usage,
      ms: Date.now() - started,
    });

    if (decision.call.tool === 'done') {
      return finish('done', decision.call.args.summary, { evidence: decision.call.args.evidence });
    }
    if (decision.call.tool === 'fail') {
      return finish('failed', decision.call.args.reason, { failure: decision.call.args });
    }

    const record = await deps.executor.execute(decision.call, obs);
    history.push(record);
    deps.events.emit({ type: 'action', stepId: step.id, record });

    expanded = record.tool === 'expand' && record.output ? record.output : undefined;
    if (expanded) refsIn(expanded).forEach((r) => expandedRefs.add(r));

    const url = deps.session.page.url();
    if (!deps.isAllowedUrl(url)) {
      return finish('failed', `navigated to a URL outside the allowed origins: ${url}`, {
        failure: { kind: 'blocked', reason: `navigated to ${url}` },
      });
    }
  }
  return failLimit(`maxActions (${deps.maxActions}) reached`);
}

export const trajectory = (outcome: StepOutcome): string[] => outcome.actions.map((r, i) => historyLine(i, r));
