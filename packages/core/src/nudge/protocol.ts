// Nudge protocol (docs/07 §8): the worker's NudgeController sends a PauseState and waits for a NudgeCommand
// from the `aipw nudge` driver. Versioned and Zod-validated on both ends. Transport: newline-delimited JSON
// over TCP (no WebSocket server in Node core; keeping aipw dependency-free).
import { z } from 'zod';

export const NUDGE_PROTOCOL_VERSION = 1;

export const BreakLevelSchema = z.enum(['step', 'action', 'fail', 'none']);
export type BreakLevel = z.infer<typeof BreakLevelSchema>;

export const PauseStateSchema = z.object({
  v: z.literal(NUDGE_PROTOCOL_VERSION),
  /** Why we stopped. */
  reason: z.enum(['step', 'decision', 'fail', 'ask', 'breakpoint', 'remedies']),
  test: z.object({ file: z.string(), title: z.string() }),
  step: z.object({
    /** 1-based AI step number in this test run. */
    index: z.number().int(),
    id: z.string(),
    kind: z.string(),
    instruction: z.string(),
    callsite: z.string().optional(),
    cached: z.boolean(),
  }),
  decision: z
    .object({
      turn: z.number().int(),
      tool: z.string(),
      args: z.unknown(),
      intent: z.string().optional(),
      why: z.string().optional(),
      target: z.object({ ref: z.string(), role: z.string().optional(), name: z.string().optional() }).optional(),
    })
    .optional(),
  page: z.object({ url: z.string(), title: z.string(), tabs: z.number().int(), dialogs: z.number().int() }).optional(),
  snapshot: z.string().optional(),
  history: z.array(z.string()),
  failure: z.object({ kind: z.string(), reason: z.string() }).optional(),
  question: z.string().optional(),
  /** Free text for breakpoints: ai.nudge('check the form before saving'). */
  note: z.string().optional(),
  breakLevel: BreakLevelSchema,
  /** reason 'remedies': better steps to keep after a human-corrected step (docs/07 §6). */
  remedies: z
    .object({
      diagnosis: z.string(),
      category: z.string(),
      pageUrl: z.string(),
      options: z.array(
        z.object({
          kind: z.enum(['hint', 'instruction', 'split', 'code']),
          label: z.string(),
          text: z.string().optional(),
          instructions: z.array(z.string()).optional(),
          lines: z.array(z.string()).optional(),
          hint: z
            .object({ scope: z.enum(['site', 'path', 'step']), pathPattern: z.string().nullable(), text: z.string() })
            .optional(),
        }),
      ),
    })
    .optional(),
});
export type PauseState = z.infer<typeof PauseStateSchema>;

export const NudgeCommandSchema = z.discriminatedUnion('cmd', [
  /** Execute the shown decision (or the whole step at step level). */
  z.object({ cmd: z.literal('run') }),
  /** Skip this decision or step; the test continues. */
  z.object({ cmd: z.literal('skip') }),
  /** Re-plan the current decision with this hint added. */
  z.object({ cmd: z.literal('hint'), text: z.string().min(1) }),
  /** Replace the step's instruction and run it from its start. */
  z.object({ cmd: z.literal('edit'), instruction: z.string().min(1) }),
  /** Answer the AI's ask_human question. */
  z.object({ cmd: z.literal('answer'), text: z.string() }),
  /** Run until the next breakpoint at this level. */
  z.object({ cmd: z.literal('continue'), level: BreakLevelSchema.optional() }),
  /** Change the break level and stay paused. */
  z.object({ cmd: z.literal('break'), level: BreakLevelSchema }),
  /** Restart the test and fast-forward to the start of this AI step (1-based). */
  z.object({ cmd: z.literal('rewind'), toStep: z.number().int().min(1) }),
  /** Stop the test. */
  z.object({ cmd: z.literal('quit') }),
]);
export type NudgeCommand = z.infer<typeof NudgeCommandSchema>;

/** Worker → driver. */
export const WorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    v: z.literal(NUDGE_PROTOCOL_VERSION),
    test: z.object({ file: z.string(), title: z.string() }),
  }),
  z.object({ type: z.literal('pause'), id: z.number().int(), state: PauseStateSchema }),
  z.object({ type: z.literal('progress'), text: z.string() }),
  z.object({ type: z.literal('rewind'), toStep: z.number().int() }),
]);
export type WorkerMessage = z.infer<typeof WorkerMessageSchema>;

/** Driver → worker. */
export const DriverMessageSchema = z.object({
  type: z.literal('command'),
  id: z.number().int(),
  command: NudgeCommandSchema,
});
export type DriverMessage = z.infer<typeof DriverMessageSchema>;

/** Thrown in the worker to end the run so the driver relaunches it and fast-forwards (docs/07 §5.2). */
export class RewindSignal extends Error {
  constructor(readonly toStep: number) {
    super(`aipw nudge: rewinding to AI step ${toStep}`);
    this.name = 'RewindSignal';
  }
}

/** Thrown when the human quits the nudge session. */
export class NudgeQuit extends Error {
  constructor() {
    super('aipw nudge: stopped by the user');
    this.name = 'NudgeQuit';
  }
}
