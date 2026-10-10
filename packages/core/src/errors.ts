// Error types from docs/03 §10. Every error carries the step id and callsite so reports can point
// at the line in the spec, and a nudge hint for reproducing the step later (Phase 6).

export interface Callsite {
  file: string;
  line: number;
  column: number;
}

export type StepFailureKind = 'not_found' | 'ambiguous' | 'blocked' | 'unexpected_state' | 'limit';

export interface AiErrorContext {
  stepId?: string;
  callsite?: Callsite;
}

function nudgeHint(callsite?: Callsite): string | undefined {
  return callsite ? `npx aipw nudge ${callsite.file}:${callsite.line}` : undefined;
}

export class AiError extends Error {
  readonly stepId?: string;
  readonly callsite?: Callsite;
  readonly nudgeHint?: string;

  constructor(message: string, context: AiErrorContext = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.stepId = context.stepId;
    this.callsite = context.callsite;
    this.nudgeHint = nudgeHint(context.callsite);
  }
}

/** The model called `fail`, or a limit was hit. */
export class AiStepError extends AiError {
  constructor(
    readonly kind: StepFailureKind,
    readonly reason: string,
    context: AiErrorContext = {},
    /** Trajectory and last observation, for reports. */
    readonly details: { trajectory?: string[]; snapshot?: string } = {},
  ) {
    super(`AI step failed (${kind}): ${reason}`, context);
  }
}

export class AiAssertionError extends AiError {
  constructor(
    readonly condition: string,
    readonly reason: string,
    readonly evidence: string[],
    context: AiErrorContext = {},
  ) {
    super(`AI assertion failed: ${condition}\nReason: ${reason}`, context);
  }
}

export class AiExtractError extends AiError {
  constructor(
    readonly what: string,
    readonly issues: string,
    context: AiErrorContext = {},
  ) {
    super(`AI extract failed: ${what}\n${issues}`, context);
  }
}

/** replay-only mode and no plan exists for the step (docs/03 §10). */
export class AiCacheReplayOnlyMiss extends AiError {
  constructor(
    readonly instruction: string,
    context: AiErrorContext = {},
  ) {
    super(
      `No cached plan for "${instruction}" and the cache is replay-only. Record it locally first (AIPW_CACHE=auto), then commit the plan file.`,
      context,
    );
  }
}

/** heal.policy = fail: the step healed, and plan changes must be reviewed. */
export class AiHealedError extends AiError {
  constructor(
    readonly instruction: string,
    readonly before: string,
    readonly after: string,
    context: AiErrorContext = {},
  ) {
    super(`Step healed, please review: "${instruction}"\nWas: ${before}\nNow: ${after}`, context);
  }
}

export type ProviderErrorKind =
  'auth' | 'rate_limit' | 'refusal' | 'content_filter' | 'no_tool_call' | 'network' | 'other';

export class AiProviderError extends AiError {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    context: AiErrorContext = {},
    options?: ErrorOptions,
  ) {
    super(message, context, options);
  }
}

/** A budget limit from config.budget was reached (docs/09 §1). The step fails; later steps in the run do too. */
export class AiBudgetExceeded extends AiError {
  constructor(
    readonly scope: 'step' | 'run',
    readonly spent: string,
    context: AiErrorContext = {},
  ) {
    super(
      `aipw budget exceeded for this ${scope === 'run' ? 'run (this worker)' : 'step'}: ${spent}. Raise budget.${scope === 'run' ? 'perRun…' : 'perStepUsd'} in aipw.config.ts, or replay from cache.`,
      context,
    );
  }
}
