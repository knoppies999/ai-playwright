// The public API behind the `ai` fixture (docs/03): act, assert, check, extract, locate, run.
// Every call is one step: it opens a StepSession, runs the loop or a structured judgement, emits
// events and closes the session. Plan caching (Phase 4) will sit in front of the loop here.
import type { Locator, Page } from 'playwright-core';
import { z } from 'zod';
import { ActionExecutor } from '../actions/executor.js';
import { actTools } from '../actions/schemas.js';
import { OrdinalCounter, stepKey } from '../cache/keys.js';
import type { StepPlan } from '../cache/plan.js';
import { planFromAct } from '../cache/record.js';
import { describePlan, replayAct } from '../cache/replay.js';
import type { PlanStore } from '../cache/store.js';
import type { AipwConfig, CacheMode } from '../config.js';
import { Redactor } from '../data/redactor.js';
import { DataResolver, envSecrets } from '../data/resolver.js';
import {
  AiAssertionError,
  AiCacheReplayOnlyMiss,
  AiExtractError,
  AiHealedError,
  AiStepError,
  type Callsite,
  type StepFailureKind,
} from '../errors.js';
import { EventBus } from '../events/bus.js';
import { runAgentLoop, trajectory } from '../loop/agent-loop.js';
import { buildObservation, SYSTEM_PROMPTS } from '../loop/prompt.js';
import { addUsage, emptyUsage, type LlmProvider, type Usage } from '../llm/provider.js';
import { buildLocator } from '../locators/expr.js';
import { synthesizeLocators, type LocatorCandidate } from '../locators/synth.js';
import { findByRef } from '../observe/snapshot.js';
import type { ActionRecord, StepContext, StepKind, StepOptions } from '../types.js';
import { StepSession } from './session.js';
import { StructuredValidationError, structuredWithRepair } from './structured.js';

export interface AiDeps {
  page: Page;
  provider: LlmProvider;
  config: AipwConfig;
  /** baseURL origin is always an allowed navigation target. */
  baseURL?: string;
  /** Playwright's testIdAttribute (`use.testIdAttribute`), so matching ids become getByTestId(). */
  playwrightTestIdAttribute?: string;
  /** Wraps each AI step, e.g. in Playwright's test.step. */
  wrapStep?: <T>(title: string, fn: () => Promise<T>) => Promise<T>;
  /** Where the ai.* call was made, for errors and reports. */
  captureCallsite?: () => Callsite | undefined;
  /** Prefix for step ids, e.g. the test id. */
  idPrefix?: string;
  events?: EventBus;
  redactor?: Redactor;
  /** Values generated or extracted earlier in the test, shared across pages. */
  values?: Record<string, unknown>;
  /** Plan cache for this test (docs/06). Without it every step goes to the AI. */
  cache?: {
    store: PlanStore;
    /** "describe > test title" */
    testTitle: string;
    /** heal.policy report: healed plans go here instead of the committed plan file. */
    healedStore?: PlanStore;
  };
}

export interface ActResult {
  summary: string;
  evidence: string[];
  actions: ActionRecord[];
  values: Record<string, unknown>;
  source: 'cache' | 'ai' | 'healed';
  usage: Usage;
}

export interface Verdict {
  pass: boolean;
  reason: string;
  evidence: string[];
}

export interface AssertOptions {
  timeout?: number;
  scope?: Locator;
  hints?: string[];
}

export interface LocateResult {
  locator: Locator;
  candidates: LocatorCandidate[];
}

const VerdictSchema = z.strictObject({
  pass: z.boolean(),
  reason: z.string(),
  evidence: z.array(z.string()),
});

const LocateSchema = z.strictObject({
  ref: z.string().nullable(),
  reason: z.string(),
});

const ASSERT_VERBS = /^(verify|check|assert|expect|ensure)\b[:\s]*/i;
const EXTRACT_LINE = /^(?:extract|read|get)\s+(.+?)\s+as\s+([A-Za-z_]\w*)\s*$/i;
const BULLET = /^(?:[-*•]|\d+[.)])\s+/;

export class Ai {
  readonly events: EventBus;
  readonly redactor: Redactor;
  readonly values: Record<string, unknown>;
  private ordinal = 0;
  private readonly stepOrdinals = new OrdinalCounter();
  private _page: Page;
  /** Usage of every step run through this instance. */
  usage: Usage = emptyUsage();

  constructor(private readonly deps: AiDeps) {
    this._page = deps.page;
    this.redactor = deps.redactor ?? new Redactor();
    this.events = deps.events ?? new EventBus(this.redactor);
    this.values = deps.values ?? {};
  }

  /** The active page: changes when an AI step switches tabs. */
  get page(): Page {
    return this._page;
  }

  /** An `ai` bound to another page, sharing events, values and secrets. */
  on(page: Page): Ai {
    return new Ai({ ...this.deps, page, events: this.events, redactor: this.redactor, values: this.values });
  }

  // ---------------------------------------------------------------------------------------------

  private get config() {
    return this.deps.config;
  }

  private allowedOrigins(startUrl: string): Set<string> {
    const origins = new Set<string>();
    for (const u of [...this.config.navigation.allowedOrigins, this.deps.baseURL, startUrl]) {
      try {
        if (u) origins.add(new URL(u).origin);
      } catch {
        // not a URL (about:blank)
      }
    }
    return origins;
  }

  private isAllowed(origins: Set<string>) {
    return (url: string) => {
      if (/^(about|data|blob):/.test(url)) return true;
      try {
        return origins.has(new URL(url).origin);
      } catch {
        return false;
      }
    };
  }

  private async openSession(): Promise<StepSession> {
    const { snapshot, settle } = this.config;
    return StepSession.open(this._page, {
      prune: { maxTokens: snapshot.maxTokens, collapseSiblingsOver: snapshot.collapseSiblingsOver, maxTextLength: 300 },
      stableMaxMs: settle.maxMs,
      stableIntervalMs: settle.snapshotIntervalMs,
      secrets: () => this.redactor.secrets,
    });
  }

  /** Runs `fn` as one reported step with start/end events. */
  private async step<T>(
    kind: StepKind | 'run',
    instruction: string,
    fn: (ctx: StepContext) => Promise<T>,
    options: StepOptions = {},
  ): Promise<T> {
    const callsite = this.deps.captureCallsite?.();
    const ctx: StepContext = {
      id: `${this.deps.idPrefix ?? 'ai'}:${++this.ordinal}`,
      kind: kind === 'run' ? 'act' : kind,
      instruction,
      options,
      callsite,
    };
    const title = this.redactor.redact(`ai.${kind}: ${instruction}`).slice(0, 200);
    const run = async () => {
      const started = Date.now();
      this.events.emit({ type: 'step:start', stepId: ctx.id, kind, instruction, callsite });
      const before = this.usage;
      try {
        const result = await fn(ctx);
        this.events.emit({
          type: 'step:end',
          stepId: ctx.id,
          kind,
          instruction,
          status: 'passed',
          ms: Date.now() - started,
          usage: diff(this.usage, before),
        });
        return result;
      } catch (error) {
        this.events.emit({
          type: 'step:end',
          stepId: ctx.id,
          kind,
          instruction,
          status: 'failed',
          ms: Date.now() - started,
          usage: diff(this.usage, before),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };
    return this.deps.wrapStep ? this.deps.wrapStep(title, run) : run();
  }

  /** Effective cache mode for one step: per-step option, then AIPW_CACHE, then config. */
  private cacheMode(options: StepOptions): CacheMode {
    if (options.cache === 'off') return 'ai-only';
    if (options.cache === 'refresh') return 'refresh';
    const env = process.env.AIPW_CACHE;
    const modes: CacheMode[] = ['auto', 'replay-only', 'ai-only', 'refresh'];
    return env && (modes as string[]).includes(env) ? (env as CacheMode) : this.config.cache.mode;
  }

  private stepKeyFor(kind: StepKind, instruction: string, options: StepOptions): string {
    const testIdAttribute = this.deps.playwrightTestIdAttribute ?? 'data-testid';
    return stepKey({
      kind,
      instruction,
      dataKeys: Object.keys(options.data ?? {}),
      secretNames: options.secrets ?? [],
      // getByTestId('x') hides the attribute name, so it is part of the scope descriptor (spike 0.6).
      scopeDescriptor: options.scope ? `${options.scope.toString()}|${testIdAttribute}` : undefined,
      ordinal: this.stepOrdinals.next(kind, instruction, options.key),
      pinned: options.key,
    });
  }

  private addUsage(u: Usage) {
    this.usage = addUsage(this.usage, u);
  }

  // ---------------------------------------------------------------------------------------------

  /** Performs whatever UI actions satisfy the instruction (docs/03 §2). */
  async act(instruction: string, options: StepOptions = {}): Promise<ActResult> {
    return this.step(
      'act',
      instruction,
      async (ctx) => {
        const session = await this.openSession();
        try {
          const data = new DataResolver(
            options.data ?? {},
            options.secrets ?? [],
            envSecrets(this.config.secrets.map),
            this.values,
            this.redactor,
          );
          const isAllowedUrl = this.isAllowed(this.allowedOrigins(this._page.url()));
          const executor = new ActionExecutor(session, {
            data,
            synth: {
              testIdAttributes: this.config.testIds.attributes,
              playwrightTestIdAttribute: this.deps.playwrightTestIdAttribute ?? 'data-testid',
              rejectTestIdValues: this.config.testIds.rejectValues,
            },
            actionTimeoutMs: this.config.steps.actionTimeoutMs,
            settle: this.config.settle,
            expandMaxTokens: this.config.snapshot.maxTokens,
            allowSecretsAnywhere: this.config.secrets.allowAnyField,
            isAllowedUrl,
          });
          // Plan cache (docs/06): replay on a hit, record on a miss, heal through the AI loop on a broken replay.
          const cache = this.deps.cache;
          const mode = this.cacheMode(options);
          const key = this.stepKeyFor('act', instruction, options);
          const startUrl = this._page.url();
          let healing: { plan: StepPlan; reason: string } | undefined;
          if (cache && (mode === 'auto' || mode === 'replay-only')) {
            const plan = cache.store.get(cache.testTitle, key);
            if (plan) {
              const replay = await replayAct(plan, {
                page: () => session.page,
                executor,
                events: this.events,
                stepId: ctx.id,
                waitMs: this.config.settle.maxMs,
              });
              this._page = session.page;
              if (replay.ok) {
                this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'hit', key });
                return {
                  summary: 'Replayed from the plan cache',
                  evidence: [],
                  actions: replay.records,
                  values: this.values,
                  source: 'cache',
                  usage: emptyUsage(),
                };
              }
              this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'broken', key, reason: replay.reason });
              if (mode === 'replay-only') {
                throw new AiStepError(
                  'unexpected_state',
                  `Replay failed at action ${replay.failedAt + 1}: ${replay.reason}. Re-record with AIPW_CACHE=auto (or refresh).`,
                  { stepId: ctx.id, callsite: ctx.callsite },
                );
              }
              healing = { plan, reason: replay.reason };
            } else if (mode === 'replay-only') {
              throw new AiCacheReplayOnlyMiss(instruction, { stepId: ctx.id, callsite: ctx.callsite });
            } else {
              this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'miss', key });
            }
          }
          const healingHint = healing
            ? [
                `HEALING: a previously recorded plan for this step no longer works. Recorded plan: ${describePlan(healing.plan)}. ` +
                  `Failure: ${healing.reason} Some of the plan may already have run. Complete the step on the current page; the UI may have changed.`,
              ]
            : [];
          const outcome = await runAgentLoop(ctx, {
            session,
            provider: this.deps.provider,
            executor,
            events: this.events,
            tools: actTools({ allowNavigation: options.allowNavigation ?? false }),
            hints: [...healingHint, ...(options.hints ?? [])],
            secretPlaceholders: data.secretPlaceholders,
            isAllowedUrl,
            maxActions: options.maxActions ?? this.config.steps.maxActions,
            deadline: Date.now() + (options.timeout ?? this.config.steps.timeoutMs),
          });
          this.addUsage(outcome.usage);
          this._page = session.page;
          if (outcome.status === 'failed') {
            throw new AiStepError(
              (outcome.failure?.kind ?? 'unexpected_state') as StepFailureKind,
              outcome.failure?.reason ?? outcome.summary,
              { stepId: ctx.id, callsite: ctx.callsite },
              { trajectory: trajectory(outcome), snapshot: outcome.lastSnapshot },
            );
          }
          if (cache && mode !== 'ai-only') {
            const plan = planFromAct(instruction, outcome.actions, options.data ?? {}, {
              provider: this.deps.provider.id,
              model: this.deps.provider.model,
              now: new Date(),
              startUrl,
              endUrl: session.page.url(),
            });
            const context = { stepId: ctx.id, callsite: ctx.callsite };
            if (!healing) {
              await cache.store.put(cache.testTitle, key, plan);
              this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'stored', key });
            } else {
              this.events.emit({
                type: 'heal',
                stepId: ctx.id,
                key,
                source: 'ai',
                policy: this.config.heal.policy,
                before: describePlan(healing.plan),
                after: describePlan(plan),
                reason: healing.reason,
              });
              if (this.config.heal.policy === 'accept')
                await cache.store.put(cache.testTitle, key, plan, { healed: true });
              else if (this.config.heal.policy === 'report')
                await cache.healedStore?.put(cache.testTitle, key, plan, { healed: true });
              else throw new AiHealedError(instruction, describePlan(healing.plan), describePlan(plan), context);
            }
          }
          return {
            summary: outcome.summary,
            evidence: outcome.evidence,
            actions: outcome.actions,
            values: this.values,
            source: healing ? 'healed' : 'ai',
            usage: outcome.usage,
          };
        } finally {
          await session.close();
        }
      },
      options,
    );
  }

  private async judge(condition: string, options: AssertOptions, ctx: StepContext, timeout: number): Promise<Verdict> {
    const session = await this.openSession();
    try {
      const deadline = Date.now() + timeout;
      let lastHash: string | undefined;
      let verdict: Verdict | undefined;
      for (;;) {
        const obs = await session.observer.observe(options.scope);
        // At most one judgement per distinct snapshot (docs/03 §3).
        if (obs.snapshotHash !== lastHash) {
          lastHash = obs.snapshotHash;
          const hints = options.hints?.length ? `HINTS\n${options.hints.map((h) => `- ${h}`).join('\n')}\n\n` : '';
          const { value, usage } = await structuredWithRepair(this.deps.provider, {
            system: SYSTEM_PROMPTS.assert,
            prompt: `${hints}ASSERTION: ${condition}\n\n${buildObservation(obs)}`,
            schemaName: 'verdict',
            schema: VerdictSchema,
          });
          this.addUsage(usage);
          verdict = value;
          this.events.emit({ type: 'verdict', stepId: ctx.id, ...value, usage });
          if (value.pass) return value;
        }
        if (Date.now() >= deadline) return verdict!;
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await session.close();
    }
  }

  /** Asserts a condition about the page, retrying until the timeout (docs/03 §3). */
  async assert(condition: string, options: AssertOptions = {}): Promise<Verdict> {
    return this.step('assert', condition, async (ctx) => {
      const verdict = await this.judge(condition, options, ctx, options.timeout ?? this.config.steps.assertTimeoutMs);
      if (!verdict.pass) {
        throw new AiAssertionError(condition, verdict.reason, verdict.evidence, {
          stepId: ctx.id,
          callsite: ctx.callsite,
        });
      }
      return verdict;
    });
  }

  /** Like assert, but returns the verdict instead of throwing. One judgement, no retries by default. */
  async check(condition: string, options: AssertOptions = {}): Promise<Verdict> {
    return this.step('assert', condition, (ctx) => this.judge(condition, options, ctx, options.timeout ?? 0));
  }

  /** Extracts data from the page, validated by a Zod schema (docs/03 §4). */
  async extract<T>(what: string, schema: z.ZodType<T>, options: AssertOptions = {}): Promise<T> {
    return this.step('extract', what, async (ctx) => {
      const session = await this.openSession();
      try {
        const obs = await session.observer.observe(options.scope);
        const { value, usage } = await structuredWithRepair(this.deps.provider, {
          system: SYSTEM_PROMPTS.extract,
          prompt: `WHAT: ${what}\n\n${buildObservation(obs)}`,
          schemaName: 'extraction',
          schema: z.strictObject({ value: schema, note: z.string().nullable() }),
        });
        this.addUsage(usage);
        return value.value as T;
      } catch (error) {
        if (error instanceof StructuredValidationError) {
          this.addUsage(error.usage);
          throw new AiExtractError(what, error.issues, { stepId: ctx.id, callsite: ctx.callsite });
        }
        throw error;
      } finally {
        await session.close();
      }
    });
  }

  /** Finds one element and returns a durable locator for it (docs/03 §5). */
  async locate(description: string, options: AssertOptions = {}): Promise<Locator> {
    return (await this.locateWithCandidates(description, options)).locator;
  }

  async locateWithCandidates(description: string, options: AssertOptions = {}): Promise<LocateResult> {
    return this.step('locate', description, async (ctx) => {
      const session = await this.openSession();
      try {
        const obs = await session.observer.observe(options.scope);
        const { value, usage } = await structuredWithRepair(this.deps.provider, {
          system: SYSTEM_PROMPTS.locate,
          prompt: `DESCRIPTION: ${description}\n\n${buildObservation(obs)}`,
          schemaName: 'element',
          schema: LocateSchema,
        });
        this.addUsage(usage);
        const context = { stepId: ctx.id, callsite: ctx.callsite };
        if (!value.ref) throw new AiStepError('not_found', value.reason, context);
        if (!obs.refs.has(value.ref))
          throw new AiStepError(
            'not_found',
            `The model returned ref ${value.ref}, which is not in the snapshot.`,
            context,
          );
        const node = findByRef(obs.tree, value.ref)?.node;
        const candidates = await synthesizeLocators(this._page, this._page.locator(`aria-ref=${value.ref}`), {
          testIdAttributes: this.config.testIds.attributes,
          playwrightTestIdAttribute: this.deps.playwrightTestIdAttribute ?? 'data-testid',
          rejectTestIdValues: this.config.testIds.rejectValues,
          role: node?.role,
          name: node?.name,
        });
        const best = candidates[0];
        if (!best) {
          throw new AiStepError(
            'not_found',
            `Found ${node?.role ?? 'the element'} "${node?.name ?? value.ref}" but could not build a stable locator for it.`,
            context,
          );
        }
        return { locator: buildLocator(this._page, best.expr), candidates };
      } finally {
        await session.close();
      }
    });
  }

  /**
   * Runs an English script: one bullet per step (docs/03 §6). "Verify/Check/Assert/Expect/Ensure …"
   * lines become assertions; "Extract/Read/Get … as name" lines store a string in `values.name`.
   */
  async run(script: string, options: StepOptions = {}): Promise<{ values: Record<string, unknown> }> {
    const lines = script
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => BULLET.test(l))
      .map((l) => l.replace(BULLET, '').replace(/\{\{\s*data\s*\}\}/g, 'the DATA values'));
    return this.step('run', `${lines.length} steps`, async () => {
      for (const line of lines) {
        const extract = EXTRACT_LINE.exec(line);
        if (ASSERT_VERBS.test(line))
          await this.assert(line.replace(ASSERT_VERBS, ''), { scope: options.scope, hints: options.hints });
        else if (extract)
          this.values[extract[2]!] = await this.extract(extract[1]!, z.string(), { scope: options.scope });
        else await this.act(line, options);
      }
      return { values: this.values };
    });
  }
}

function diff(after: Usage, before: Usage): Usage {
  const d = (a?: number, b?: number) => (a === undefined ? undefined : a - (b ?? 0));
  return {
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    cacheReadTokens: d(after.cacheReadTokens, before.cacheReadTokens),
    cacheWriteTokens: d(after.cacheWriteTokens, before.cacheWriteTokens),
    costUsd: d(after.costUsd, before.costUsd),
    requests: after.requests - before.requests,
  };
}
