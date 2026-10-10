// The agent loop (docs/04 §3): observe → decide → validate → execute → settle, until done, fail or a
// limit. One tool call per decision, fresh prompt per decision (AGENTS.md rule 2).
import type { ActionExecutor } from '../actions/executor.js';
import {
  codeToolSpecs,
  isCodeCall,
  toolSpecs,
  validateCall,
  type AnyToolCall,
  type CodeTool,
  type ToolName,
} from '../actions/schemas.js';
import { TOOL_SCHEMAS } from '../actions/schemas.js';
import { AiProviderError } from '../errors.js';
import type { EventBus } from '../events/bus.js';
import { addUsage, emptyUsage, type DecisionRequest, type LlmProvider, type Usage } from '../llm/provider.js';
import type { NudgeController } from '../nudge/controller.js';
import { alternatives, callFor, pickedRef, softUndo, waitForPick } from '../nudge/correct.js';
import { startRecording } from '../nudge/recorder.js';
import type { NudgeCommand, PauseState, PickTool } from '../nudge/protocol.js';
import type { Observation } from '../observe/observer.js';
import { findByRef, refsIn } from '../observe/snapshot.js';
import type { StepSession } from '../step/session.js';
import type { ActionRecord, StepContext, StepOutcome } from '../types.js';
import { buildContext, buildObservation, historyLine, SYSTEM_PROMPTS } from './prompt.js';

export interface LoopDeps {
  session: StepSession;
  provider: LlmProvider;
  executor: ActionExecutor;
  events: EventBus;
  tools: ToolName[];
  /** Code tools this step may call (docs/03 §7). */
  codeTools?: ReadonlyMap<string, CodeTool>;
  hints: string[];
  secretPlaceholders: string[];
  isAllowedUrl: (url: string) => boolean;
  maxActions: number;
  /** Epoch ms after which the step stops. */
  deadline: number;
  signal?: AbortSignal;
  /** Nudge mode (docs/07): pauses before actions, on fail, and for ask_human. */
  nudge?: NudgeController;
}

interface Decision {
  call: AnyToolCall;
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
  codeTools?: ReadonlyMap<string, CodeTool>,
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
    const validated = validateCall(res.call, offered, codeTools);
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
/** Actions that don't act on the page (and code tools, which work off-page) never count as 'no progress'. */
const PASSIVE = new Set(['expand', 'wait_for', 'generate_value', 'ask_human']);
const isPassive = (r: ActionRecord) => PASSIVE.has(r.tool) || !(r.tool in TOOL_SCHEMAS);

/** docs/04 §3.2: the same tool + target three times in a row, or three actions that changed nothing. */
function noProgress(history: ActionRecord[], currentHash: string): string | undefined {
  const active = history.filter((r) => !isPassive(r));
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
  const human: string[] = [];
  const code = [...(deps.codeTools?.values() ?? [])];
  const specs = [...toolSpecs(deps.tools), ...codeToolSpecs(code)];
  const offered = [...deps.tools, ...code.map((t) => t.name)] as readonly string[];
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
    ...(human.length && { human }),
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
    const decision = await decideWithRepair(deps.provider, req, offered, deps.signal, deps.codeTools);
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

    let call = decision.call;
    let execObs = obs;
    const pauseCtx = (extra: Partial<PauseState> = {}) => nudgeContext(obs, history, extra);
    /**
     * pick / undo / options (docs/07 §4) at a decision or fail pause. Returns a call to execute instead of the AI's,
     * 'replan' to go round the loop again, or undefined when the command is something else.
     */
    const correct = async (
      cmd: NudgeCommand,
      rejected: { tool: string; ref?: string; intent?: string; value?: string },
    ): Promise<{ call: AnyToolCall; obs: Observation } | 'replan' | undefined> => {
      const nudge = deps.nudge!;
      const page = deps.session.page;
      if (cmd.cmd === 'options') {
        const found = await alternatives(deps.provider, step.instruction, history, rejected, obs).catch(
          (error: unknown) => {
            nudge.progress(`No alternatives: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          },
        );
        if (found) usage = addUsage(usage, found.usage);
        const alts = found?.alternatives ?? [];
        const answer = await nudge.chooseAlternative(pauseCtx({ alternatives: alts }));
        if (answer.cmd === 'choose' && alts[answer.index]) {
          const a = alts[answer.index]!;
          human.push(`chose instead: ${a.tool} ${a.role ?? 'element'}${a.name ? ` "${a.name}"` : ''}`);
          return { call: callFor(a.tool, a.ref, a.value), obs };
        }
        const again = await correct(answer, rejected);
        if (again) return again;
        // Enter: go ahead with the AI's action (or retry after a fail); s: reject it and re-plan.
        if (answer.cmd === 'run') return rejected.tool === 'fail' ? 'replan' : undefined;
        if (answer.cmd === 'skip') {
          human.push(`rejected: ${rejected.tool}${rejected.intent ? ` (${rejected.intent})` : ''}`);
          history.push(
            passiveRecord(rejected.tool, {}, obs, 'skipped by the person running the test: do not repeat it'),
          );
          return 'replan';
        }
        return applyNudge(answer, step, deps.hints, human) ? 'replan' : undefined;
      }
      if (cmd.cmd === 'pick') {
        nudge.progress('Click the right element in the browser…');
        await waitForPick(page);
        const fresh = await deps.session.observer.observe(step.options.scope);
        const ref = await pickedRef(page, fresh);
        if (!ref) {
          nudge.progress('That element is not in the accessibility snapshot; try its label or container.');
          return 'replan';
        }
        const tool: PickTool =
          cmd.tool ?? (['click', 'hover', 'fill'].includes(rejected.tool) ? (rejected.tool as PickTool) : 'click');
        const node = findByRef(fresh.tree, ref)?.node;
        human.push(`picked: ${tool} ${node?.role ?? 'element'}${node?.name ? ` "${node.name}"` : ''}`);
        return { call: callFor(tool, ref, cmd.value ?? rejected.value ?? null), obs: fresh };
      }
      if (cmd.cmd === 'manual') {
        const recording = await startRecording(page, (loc) => deps.executor.describeElement(loc));
        const after = await nudge.manual(pauseCtx());
        const records = await recording.stop();
        for (const record of records) {
          history.push(record);
          deps.events.emit({ type: 'action', stepId: step.id, record });
        }
        human.push(
          records.length
            ? `did by hand: ${records.map((r, i) => historyLine(history.length - records.length + i, r)).join('; ')}`
            : 'did nothing by hand',
        );
        applyNudge(after, step, deps.hints, human);
        return 'replan';
      }
      if (cmd.cmd === 'undo') {
        const undone = await softUndo(page, history, isPassive);
        if (undone) human.push(`undid: ${undone.tool}${undone.target?.name ? ` "${undone.target.name}"` : ''}`);
        const after = await nudge.afterUndo(
          undone
            ? `Undid ${undone.tool}. Fix the page by hand if needed, then press Enter.`
            : 'Nothing to undo in this step.',
          pauseCtx(),
        );
        applyNudge(after, step, deps.hints, human);
        return 'replan';
      }
      return undefined;
    };

    if (!isCodeCall(call) && call.tool === 'done') {
      return finish('done', call.args.summary, { evidence: call.args.evidence });
    }
    if (!isCodeCall(call) && call.tool === 'fail') {
      // Nudge: a failure pauses for help; a hint, answer, edit, pick or option retries with it (docs/07 §7).
      if (deps.nudge) {
        const failure = call.args;
        const cmd = await deps.nudge.onFail(pauseCtx({ failure }));
        const fix = await correct(cmd, { tool: 'fail', intent: failure.reason });
        if (fix === 'replan' || (!fix && applyNudge(cmd, step, deps.hints, human))) continue;
        if (fix) {
          call = fix.call;
          execObs = fix.obs;
        } else return finish('failed', failure.reason, { failure });
      } else return finish('failed', call.args.reason, { failure: call.args });
    } else if (!isCodeCall(call) && call.tool === 'ask_human') {
      const answer = deps.nudge
        ? await deps.nudge.ask(call.args.question, pauseCtx())
        : '(nobody to ask outside nudge mode)';
      history.push(passiveRecord('ask_human', call.args, obs, 'ok', answer));
      continue;
    } else if (deps.nudge) {
      const args = call.args as { ref?: string | null; intent?: string; value?: string };
      const ref = args.ref ?? undefined;
      const node = ref ? findByRef(obs.tree, ref)?.node : undefined;
      // The AI's target is highlighted in the headed browser while the decision is shown (docs/07 §3).
      const highlight = ref && deps.nudge.pausesBeforeActions;
      if (highlight)
        await deps.session.page
          .locator(`aria-ref=${ref}`)
          .highlight()
          .catch(() => undefined);
      const cmd = await deps.nudge.beforeAction(
        pauseCtx({
          decision: {
            turn,
            tool: call.tool,
            args: call.args,
            intent: args.intent,
            why: decision.text,
            ...(ref && { target: { ref, role: node?.role, name: node?.name } }),
          },
        }),
      );
      if (highlight) await deps.session.page.hideHighlight().catch(() => undefined);
      if (cmd.cmd === 'skip') {
        human.push(`rejected: ${call.tool}${args.intent ? ` (${args.intent})` : ''}`);
        history.push(
          passiveRecord(
            call.tool,
            call.args as Record<string, unknown>,
            obs,
            'skipped by the person running the test: do not repeat it',
          ),
        );
        continue;
      }
      const fix = await correct(cmd, {
        tool: call.tool,
        ...(ref && { ref }),
        ...(args.intent && { intent: args.intent }),
        ...(typeof args.value === 'string' && { value: args.value }),
      });
      if (fix === 'replan') continue;
      if (fix) {
        call = fix.call;
        execObs = fix.obs;
      } else if (cmd.cmd !== 'run' && applyNudge(cmd, step, deps.hints, human)) continue; // hint / edit: re-plan
    }

    const record = await deps.executor.execute(call, execObs);
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

/** Applies a human correction. Returns true when the step should go on (re-plan or retry). */
function applyNudge(cmd: NudgeCommand, step: StepContext, hints: string[], human: string[]): boolean {
  if (cmd.cmd === 'hint') human.push(`hint: ${cmd.text}`);
  if (cmd.cmd === 'answer') human.push(`answer: ${cmd.text}`);
  if (cmd.cmd === 'edit') human.push(`changed the instruction to: ${cmd.instruction}`);
  switch (cmd.cmd) {
    case 'hint':
      hints.push(`From the person running the test: ${cmd.text}`);
      return true;
    case 'answer':
      hints.push(`The person running the test says: ${cmd.text}`);
      return true;
    case 'edit':
      step.instruction = cmd.instruction;
      return true;
    case 'run':
      return true;
    default:
      return false;
  }
}

function nudgeContext(obs: Observation, history: ActionRecord[], extra: Partial<PauseState>) {
  return {
    history: history.map((r, i) => historyLine(i, r)),
    page: { url: obs.url, title: obs.title, tabs: obs.tabs.length, dialogs: obs.dialogs.length },
    snapshot: obs.snapshot,
    ...extra,
  };
}

function passiveRecord(
  tool: string,
  args: Record<string, unknown>,
  obs: Observation,
  result: string,
  output?: string,
): ActionRecord {
  return {
    tool,
    args,
    result,
    ...(output !== undefined && { output }),
    before: { url: obs.url, snapshotHash: obs.snapshotHash },
    after: { url: obs.url },
    durationMs: 0,
  };
}

export const trajectory = (outcome: StepOutcome): string[] => outcome.actions.map((r, i) => historyLine(i, r));
