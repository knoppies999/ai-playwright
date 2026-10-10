import { resolve } from 'node:path';
// The public API behind the `ai` fixture (docs/03): act, assert, check, extract, locate, run.
// Every call is one step: it opens a StepSession, runs the loop or a structured judgement, emits
// events and closes the session. Plan caching (Phase 4) will sit in front of the loop here.
import type { Locator, Page } from 'playwright-core';
import { z } from 'zod';
import { ActionExecutor } from '../actions/executor.js';
import { actTools, TOOL_SCHEMAS, type CodeTool } from '../actions/schemas.js';
import { OrdinalCounter, stepKey } from '../cache/keys.js';
import type { CompiledCheck, PlanTarget, StepPlan } from '../cache/plan.js';
import { planFromAct } from '../cache/record.js';
import { describeCheck, runCompiledCheck } from '../cache/checks.js';
import { rebuildValue } from '../cache/extract.js';
import { applyHeals, describePlan, healByFingerprint, replayAct, resolveTarget } from '../cache/replay.js';
import type { PlanStore } from '../cache/store.js';
import type { AipwConfig, CacheMode } from '../config.js';
import { Redactor } from '../data/redactor.js';
import { createGenerators, type Generators } from '../data/generators.js';
import { loadHints } from '../hints/store.js';
import type { NudgeController } from '../nudge/controller.js';
import type { PauseState } from '../nudge/protocol.js';
import { codeRemedy, synthesizeRemedy } from '../nudge/remedy.js';
import { DataResolver, secretSource } from '../data/resolver.js';
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
import { fingerprintOf } from '../locators/fingerprint.js';
import { synthesizeLocators, type LocatorCandidate, type Rung } from '../locators/synth.js';
import type { Observation } from '../observe/observer.js';
import { findByRef } from '../observe/snapshot.js';
import type { ActionRecord, StepContext, StepKind, StepOptions, StepOutcome } from '../types.js';
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
  /** Test-data generators, seeded per test (docs/08 §3). Shared with the gen fixture. */
  gen?: Generators;
  /** Code tools registered with ai.tools.register, shared with ai.on(page). */
  codeTools?: Map<string, CodeTool>;
  /** Nudge mode (docs/07): set by @aipw/test when run under `aipw nudge`. */
  nudge?: NudgeController;
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
  source: 'cache' | 'ai' | 'healed' | 'nudged';
  usage: Usage;
}

export interface Verdict {
  pass: boolean;
  reason: string;
  evidence: string[];
  /** The model's proposed compiled check (see docs/06 §5); null when it can't be expressed. */
  check?: {
    expect: CompiledCheck['expect'];
    ref: string | null;
    args: string[];
    not: boolean;
  } | null;
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
  check: z
    .strictObject({
      expect: z.enum([
        'toBeVisible',
        'toBeHidden',
        'toContainText',
        'toHaveText',
        'toHaveCount',
        'toHaveURL',
        'toHaveValue',
      ]),
      ref: z.string().nullable().describe('The element the check is about; null for toHaveURL'),
      args: z.array(z.string()).describe('Expected text, count or URL fragment; [] for toBeVisible/toBeHidden'),
      not: z.boolean(),
    })
    .nullable()
    .describe(
      'When pass is true: a deterministic Playwright check that confirms this next time without you; null if none fits',
    ),
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
  readonly gen: Generators;
  private readonly codeTools: Map<string, CodeTool>;

  /** Your own functions the model may call from English steps (docs/03 §7). Recorded in plans like actions. */
  readonly tools = {
    register: <S extends z.ZodObject>(tool: {
      name: string;
      description: string;
      input: S;
      run: (args: z.infer<S>) => unknown;
    }) => {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error(`Code tool names are snake_case: "${tool.name}"`);
      if (tool.name in TOOL_SCHEMAS) throw new Error(`"${tool.name}" is a built-in tool name.`);
      this.codeTools.set(tool.name, tool as unknown as CodeTool);
    },
    unregister: (name: string) => this.codeTools.delete(name),
    list: () => [...this.codeTools.keys()],
  };
  private _page: Page;
  /** Usage of every step run through this instance. */
  usage: Usage = emptyUsage();

  constructor(private readonly deps: AiDeps) {
    this._page = deps.page;
    this.redactor = deps.redactor ?? new Redactor();
    this.events = deps.events ?? new EventBus(this.redactor);
    this.values = deps.values ?? {};
    this.gen = deps.gen ?? createGenerators({ seed: deps.idPrefix ?? 'aipw' });
    this.codeTools = deps.codeTools ?? new Map();
  }

  /** The active page: changes when an AI step switches tabs. */
  get page(): Page {
    return this._page;
  }

  /** An `ai` bound to another page, sharing events, values and secrets. */
  on(page: Page): Ai {
    return new Ai({
      ...this.deps,
      page,
      events: this.events,
      redactor: this.redactor,
      values: this.values,
      gen: this.gen,
      codeTools: this.codeTools,
    });
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

  private stepKeyFor(kind: StepKind, instruction: string, options: StepOptions, peek = false): string {
    const testIdAttribute = this.deps.playwrightTestIdAttribute ?? 'data-testid';
    return stepKey({
      kind,
      instruction,
      dataKeys: Object.keys(options.data ?? {}),
      secretNames: options.secrets ?? [],
      // getByTestId('x') hides the attribute name, so it is part of the scope descriptor (spike 0.6).
      scopeDescriptor: options.scope ? `${options.scope.toString()}|${testIdAttribute}` : undefined,
      ordinal: peek
        ? this.stepOrdinals.peek(kind, instruction, options.key)
        : this.stepOrdinals.next(kind, instruction, options.key),
      pinned: options.key,
    });
  }

  private synthOptions() {
    return {
      testIdAttributes: this.config.testIds.attributes,
      playwrightTestIdAttribute: this.deps.playwrightTestIdAttribute ?? 'data-testid',
      rejectTestIdValues: this.config.testIds.rejectValues,
    };
  }

  /** heal.policy (docs/06 §6): accept writes the plan, report writes it aside, fail fails the test. */
  private async storeHealed(
    cache: NonNullable<AiDeps['cache']>,
    key: string,
    before: StepPlan,
    after: StepPlan,
    instruction: string,
    ctx: StepContext,
  ) {
    const policy = this.config.heal.policy;
    if (policy === 'accept') await cache.store.put(cache.testTitle, key, after, { healed: true });
    else if (policy === 'report') await cache.healedStore?.put(cache.testTitle, key, after, { healed: true });
    else
      throw new AiHealedError(instruction, describePlan(before), describePlan(after), {
        stepId: ctx.id,
        callsite: ctx.callsite,
      });
  }

  private addUsage(u: Usage) {
    this.usage = addUsage(this.usage, u);
  }

  // ---------------------------------------------------------------------------------------------

  /** Performs whatever UI actions satisfy the instruction (docs/03 §2). */
  async act(instruction: string, options: StepOptions = {}): Promise<ActResult> {
    const nudged = await this.nudgeBeforeStep('act', instruction, options);
    if (nudged.skip) {
      return {
        summary: 'Skipped in nudge mode',
        evidence: [],
        actions: [],
        values: this.values,
        source: 'nudged',
        usage: emptyUsage(),
      };
    }
    ({ instruction, options } = nudged);
    return this.step(
      'act',
      instruction,
      async (ctx) => {
        const session = await this.openSession();
        try {
          const data = new DataResolver(
            options.data ?? {},
            options.secrets ?? [],
            secretSource(this.config.secrets.provider, this.config.secrets.map),
            this.values,
            this.redactor,
            this.gen,
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
            secretFillMode: this.config.secrets.fillMode,
            isAllowedUrl,
            codeTools: this.codeTools,
          });
          const stepTools = new Map(
            [...this.codeTools].filter(([name]) => !options.tools || options.tools.includes(name)),
          );
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
                codeTools: this.codeTools,
                // Fingerprint heals cost nothing and are deterministic, so replay-only may use them too (docs/12 §6).
                ...((mode === 'auto' || this.config.heal.fingerprintInReplayOnly) && {
                  fingerprintHeal: { synth: this.synthOptions() },
                }),
              });
              this._page = session.page;
              if (replay.ok) {
                this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'hit', key });
                if (replay.healed.length) {
                  const healedPlan = {
                    ...applyHeals(plan, replay.healed),
                    recordedWith: { ...plan.recordedWith, at: new Date().toISOString() },
                  };
                  const describe = (t: { role?: string; name?: string; locators: { display: string }[] }) =>
                    `${t.role ?? 'element'} "${t.name ?? ''}" (${t.locators[0]?.display ?? 'no locator'})`;
                  for (const h of replay.healed) {
                    this.events.emit({
                      type: 'heal',
                      stepId: ctx.id,
                      key,
                      source: 'fingerprint',
                      policy: this.config.heal.policy,
                      before: describe(h.before),
                      after: describe(h.after),
                      reason: `all stored locators failed; fingerprint score ${h.score.toFixed(2)}`,
                    });
                  }
                  await this.storeHealed(cache, key, plan, healedPlan, instruction, ctx);
                }
                return {
                  summary: 'Replayed from the plan cache',
                  evidence: [],
                  actions: replay.records,
                  values: this.values,
                  source: replay.healed.length ? 'healed' : 'cache',
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
            tools: actTools({ allowNavigation: options.allowNavigation ?? false, askHuman: !!this.deps.nudge }),
            nudge: this.deps.nudge,
            codeTools: stepTools,
            hints: [...loadHints(resolve(this.config.hints.dir), startUrl), ...healingHint, ...(options.hints ?? [])],
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
              await this.storeHealed(cache, key, healing.plan, plan, instruction, ctx);
            }
          }
          if (this.deps.nudge && outcome.human?.length) await this.offerRemedies(instruction, outcome, startUrl);
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

  /** A durable target (verified locators + fingerprint) for a ref the model named. */
  private async targetFor(obs: Observation, ref: string | null | undefined): Promise<PlanTarget | undefined> {
    if (!ref || !obs.refs.has(ref)) return undefined;
    const node = findByRef(obs.tree, ref)?.node;
    const loc = this._page.locator(`aria-ref=${ref}`);
    const candidates = await synthesizeLocators(this._page, loc, {
      ...this.synthOptions(),
      role: node?.role,
      name: node?.name,
    }).catch(() => []);
    if (!candidates.length) return undefined;
    const fingerprint = await fingerprintOf(loc, node?.role, node?.name);
    return {
      ...(node?.role !== undefined && { role: node.role }),
      ...(node?.name !== undefined && { name: node.name }),
      locators: candidates.map((c) => ({ rung: c.rung, expr: c.expr, display: c.display })),
      ...(fingerprint && { fingerprint }),
    };
  }

  private newPlan(kind: StepKind, instruction: string, extra: Partial<StepPlan>): StepPlan {
    return {
      kind,
      instruction,
      recordedWith: { provider: this.deps.provider.id, model: this.deps.provider.model, at: new Date().toISOString() },
      stats: { heals: 0 },
      ...extra,
    };
  }

  /** Looks up a cached plan for a structured step. Throws in replay-only mode when there is none. */
  private cachedPlan(kind: StepKind, instruction: string, options: StepOptions, ctx: StepContext) {
    const cache = this.deps.cache;
    const mode = this.cacheMode(options);
    const key = this.stepKeyFor(kind, instruction, options);
    const plan =
      cache && (mode === 'auto' || mode === 'replay-only') ? cache.store.get(cache.testTitle, key) : undefined;
    if (cache && mode === 'replay-only' && !plan) {
      throw new AiCacheReplayOnlyMiss(instruction, { stepId: ctx.id, callsite: ctx.callsite });
    }
    return { cache, mode, key, plan };
  }

  /** Turns the model's proposed check into a validated compiled check, or null if it doesn't hold now. */
  private async compileCheck(obs: Observation, check: Verdict['check'], page: Page): Promise<CompiledCheck | null> {
    if (!check) return null;
    let target = check.expect === 'toHaveURL' ? undefined : await this.targetFor(obs, check.ref);
    // A container without a durable locator (e.g. a plain list): for visibility, its first descendant
    // that has one is visible exactly when the container is.
    if (!target && check.ref && (check.expect === 'toBeVisible' || check.expect === 'toBeHidden')) {
      const queue = [...(findByRef(obs.tree, check.ref)?.node.children ?? [])];
      for (let n = queue.shift(); n && !target; n = queue.shift()) {
        if (n.ref) target = await this.targetFor(obs, n.ref);
        queue.push(...n.children);
      }
    }
    if (check.expect !== 'toHaveURL' && !target) return null;
    const compiled: CompiledCheck = {
      expect: check.expect,
      args: check.args,
      ...(target && { target }),
      ...(check.not && { not: true }),
    };
    return (await runCompiledCheck(page, compiled, 1000)) ? compiled : null;
  }

  private async judge(
    condition: string,
    options: AssertOptions,
    ctx: StepContext,
    timeout: number,
  ): Promise<{ verdict: Verdict; compiled: CompiledCheck | null }> {
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
          this.events.emit({
            type: 'verdict',
            stepId: ctx.id,
            pass: value.pass,
            reason: value.reason,
            evidence: value.evidence,
            check: value.check ?? null,
            usage,
          });
          if (value.pass) return { verdict: value, compiled: await this.compileCheck(obs, value.check, session.page) };
        }
        if (Date.now() >= deadline) return { verdict: verdict!, compiled: null };
        await new Promise((r) => setTimeout(r, 500));
      }
    } finally {
      await session.close();
    }
  }

  /** assert/check with the plan cache: compiled checks replay with no AI; a failed check is re-judged by AI. */
  private async assertStep(
    condition: string,
    options: AssertOptions,
    ctx: StepContext,
    timeout: number,
  ): Promise<Verdict> {
    const { cache, mode, key, plan } = this.cachedPlan('assert', condition, options, ctx);
    if (plan?.compiled?.length) {
      const checks = plan.compiled;
      let ok = true;
      for (const c of checks) ok = ok && (await runCompiledCheck(this._page, c, timeout));
      if (ok) {
        this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'hit', key });
        return {
          pass: true,
          reason: 'The cached compiled check passed.',
          evidence: checks.map(describeCheck),
          check: null,
        };
      }
      this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'broken', key, reason: 'compiled check failed' });
      if (mode === 'replay-only') {
        return {
          pass: false,
          reason: `Compiled check failed: ${checks.map(describeCheck).join('; ')}`,
          evidence: [],
          check: null,
        };
      }
    } else if (plan && mode === 'replay-only') {
      throw new AiStepError(
        'unexpected_state',
        'This assertion has no compiled check, so it needs the AI, and the cache is replay-only.',
        { stepId: ctx.id, callsite: ctx.callsite },
      );
    }
    const { verdict, compiled } = await this.judge(condition, options, ctx, timeout);
    if (cache && mode !== 'ai-only' && verdict.pass) {
      const next = this.newPlan('assert', condition, { compiled: compiled ? [compiled] : null });
      if (plan?.compiled?.length) {
        const before = plan.compiled.map(describeCheck).join('; ');
        const after = compiled ? describeCheck(compiled) : 'AI judgement only';
        this.events.emit({
          type: 'heal',
          stepId: ctx.id,
          key,
          source: 'ai',
          policy: this.config.heal.policy,
          before,
          after,
          reason: 'compiled check failed; the AI says the assertion holds',
        });
        await this.storeHealed(cache, key, plan, next, condition, ctx);
      } else if (!plan || mode === 'refresh') {
        await cache.store.put(cache.testTitle, key, next);
        this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'stored', key });
      }
    }
    return verdict;
  }

  /** Asserts a condition about the page, retrying until the timeout (docs/03 §3). */
  async assert(condition: string, options: AssertOptions = {}): Promise<Verdict> {
    const nudged = await this.nudgeBeforeStep('assert', condition, options);
    if (nudged.skip) return { pass: true, reason: 'Skipped in nudge mode', evidence: [], check: null };
    ({ instruction: condition, options } = nudged);
    return this.step('assert', condition, async (ctx) => {
      const verdict = await this.assertStep(
        condition,
        options,
        ctx,
        options.timeout ?? this.config.steps.assertTimeoutMs,
      );
      if (!verdict.pass) {
        throw new AiAssertionError(condition, verdict.reason, verdict.evidence, {
          stepId: ctx.id,
          callsite: ctx.callsite,
        });
      }
      return verdict;
    });
  }

  /**
   * Nudge mode: pause before the step (docs/07 §2). The human can run it, skip it, add a hint or edit the
   * instruction. Steps are only skippable for act and assert; extract and locate must produce a value.
   */
  private async nudgeBeforeStep<O extends StepOptions>(
    kind: StepKind,
    instruction: string,
    options: O,
  ): Promise<{ instruction: string; options: O; skip: boolean }> {
    const nudge = this.deps.nudge;
    if (!nudge) return { instruction, options, skip: false };
    const cache = this.deps.cache;
    const cached = !!cache?.store.get(cache.testTitle, this.stepKeyFor(kind, instruction, options, true));
    const callsite = this.deps.captureCallsite?.();
    const cmd = await nudge.beforeStep(
      {
        id: `${this.deps.idPrefix ?? 'ai'}:${this.ordinal + 1}`,
        kind,
        instruction,
        cached,
        ...(callsite && { callsite: `${callsite.file}:${callsite.line}` }),
      },
      {
        history: [],
        page: { url: this._page.url(), title: '', tabs: this._page.context().pages().length, dialogs: 0 },
      },
    );
    switch (cmd.cmd) {
      case 'skip':
        return { instruction, options, skip: kind === 'act' || kind === 'assert' };
      case 'hint':
        return { instruction, options: { ...options, hints: [...(options.hints ?? []), cmd.text] }, skip: false };
      case 'edit':
        return { instruction: cmd.instruction, options, skip: false };
      default:
        return { instruction, options, skip: false };
    }
  }

  /** After a human-corrected step: synthesize remedies and offer them to the driver (docs/07 §6). */
  private async offerRemedies(instruction: string, outcome: StepOutcome, pageUrl: string): Promise<void> {
    const corrected = outcome.actions.filter((a) => a.result === 'ok');
    const failed = outcome.actions.filter((a) => a.result !== 'ok');
    try {
      const { remedy, usage } = await synthesizeRemedy(this.deps.provider, {
        instruction,
        failed,
        corrected,
        humanInput: outcome.human ?? [],
        targetFacts: [],
      });
      this.addUsage(usage);
      const code = codeRemedy(corrected);
      const options: NonNullable<PauseState['remedies']>['options'] = [];
      if (remedy.hint && remedy.hint.scope !== 'step')
        options.push({ kind: 'hint', label: `Site hint (${remedy.hint.scope})`, hint: remedy.hint });
      options.push({ kind: 'instruction', label: 'Revised instruction', text: remedy.revisedInstruction });
      if (remedy.splitInto?.length)
        options.push({ kind: 'split', label: 'Split into steps', instructions: remedy.splitInto });
      if (code.length) options.push({ kind: 'code', label: 'Code (from the corrected actions)', lines: code });
      await this.deps.nudge!.offerRemedies({
        diagnosis: remedy.diagnosis,
        category: remedy.category,
        pageUrl,
        options,
      });
    } catch (error) {
      this.deps.nudge!.progress(`Could not build remedies: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A code breakpoint: in nudge mode the test pauses here; otherwise it does nothing (docs/07 §1). */
  async nudge(note = 'breakpoint'): Promise<void> {
    await this.deps.nudge?.breakpoint(note, {
      history: [],
      page: {
        url: this._page.url(),
        title: await this._page.title().catch(() => ''),
        tabs: this._page.context().pages().length,
        dialogs: 0,
      },
    });
  }

  /** Like assert, but returns the verdict instead of throwing. One judgement, no retries by default. */
  async check(condition: string, options: AssertOptions = {}): Promise<Verdict> {
    return this.step('assert', condition, (ctx) => this.assertStep(condition, options, ctx, options.timeout ?? 0));
  }

  /** Reads stored extract sources and rebuilds the value with no AI, or returns undefined. */
  private async replayExtract<T>(plan: StepPlan, schema: z.ZodType<T>): Promise<T | undefined> {
    if (!plan.sources?.length) return undefined;
    const leaves: { path: string; text: string }[] = [];
    for (const { path, target } of plan.sources) {
      try {
        const loc = await resolveTarget(this._page, target, this.config.settle.maxMs);
        leaves.push({ path, text: await loc.innerText() });
      } catch {
        return undefined;
      }
    }
    const rebuilt = rebuildValue(schema, leaves);
    if (!rebuilt.ok) return undefined;
    const parsed = schema.safeParse(rebuilt.value);
    return parsed.success ? parsed.data : undefined;
  }

  /** Extracts data from the page, validated by a Zod schema (docs/03 §4). */
  async extract<T>(what: string, schema: z.ZodType<T>, options: AssertOptions = {}): Promise<T> {
    return this.step('extract', what, async (ctx) => {
      const { cache, mode, key, plan } = this.cachedPlan('extract', what, options, ctx);
      if (plan) {
        const replayed = await this.replayExtract(plan, schema);
        if (replayed !== undefined) {
          this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'hit', key });
          return replayed;
        }
        this.events.emit({
          type: 'cache',
          stepId: ctx.id,
          outcome: 'broken',
          key,
          reason: 'sources missing or unreadable',
        });
        if (mode === 'replay-only') {
          throw new AiExtractError(
            what,
            'The cached sources no longer give a valid value, and the cache is replay-only.',
            { stepId: ctx.id, callsite: ctx.callsite },
          );
        }
      }
      const session = await this.openSession();
      try {
        const obs = await session.observer.observe(options.scope);
        const { value, usage } = await structuredWithRepair(this.deps.provider, {
          system: SYSTEM_PROMPTS.extract,
          prompt: `WHAT: ${what}\n\n${buildObservation(obs)}`,
          schemaName: 'extraction',
          schema: z.strictObject({
            value: schema,
            note: z.string().nullable(),
            sources: z
              .array(z.strictObject({ path: z.string(), ref: z.string() }))
              .describe(
                'For every leaf value: its JSON path ("" for a single value, "0", "1.name", "total") and the ref of the element it was read from',
              ),
          }),
        });
        this.addUsage(usage);
        if (cache && mode !== 'ai-only') {
          // Keep sources only if they rebuild exactly the value the model returned.
          const sources: NonNullable<StepPlan['sources']> = [];
          for (const s of value.sources) {
            const target = await this.targetFor(obs, s.ref);
            if (!target) {
              sources.length = 0;
              break;
            }
            sources.push({ path: s.path, target });
          }
          const next = this.newPlan('extract', what, { sources });
          const check = sources.length ? await this.replayExtract(next, schema) : undefined;
          if (JSON.stringify(check) !== JSON.stringify(value.value)) next.sources = [];
          if (plan) await this.storeHealed(cache, key, plan, next, what, ctx);
          else await cache.store.put(cache.testTitle, key, next);
        }
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
      const context = { stepId: ctx.id, callsite: ctx.callsite };
      const { cache, mode, key, plan } = this.cachedPlan('locate', description, options, ctx);
      if (plan?.target) {
        try {
          const locator = await resolveTarget(this._page, plan.target, this.config.settle.maxMs);
          this.events.emit({ type: 'cache', stepId: ctx.id, outcome: 'hit', key });
          return { locator, candidates: toCandidates(plan.target) };
        } catch {
          const healed = await healByFingerprint(this._page, plan.target, this.synthOptions());
          if (healed) {
            await this.storeHealed(cache!, key, plan, { ...plan, target: healed.target }, description, ctx);
            return {
              locator: buildLocator(this._page, healed.target.locators[0]!.expr),
              candidates: toCandidates(healed.target),
            };
          }
          if (mode === 'replay-only')
            throw new AiStepError('not_found', `The cached element for "${description}" is gone.`, context);
        }
      }
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
        if (!value.ref) throw new AiStepError('not_found', value.reason, context);
        if (!obs.refs.has(value.ref)) {
          throw new AiStepError(
            'not_found',
            `The model returned ref ${value.ref}, which is not in the snapshot.`,
            context,
          );
        }
        const target = await this.targetFor(obs, value.ref);
        if (!target) {
          const node = findByRef(obs.tree, value.ref)?.node;
          throw new AiStepError(
            'not_found',
            `Found ${node?.role ?? 'the element'} "${node?.name ?? value.ref}" but could not build a stable locator for it.`,
            context,
          );
        }
        if (cache && mode !== 'ai-only') {
          const next = this.newPlan('locate', description, { target });
          if (plan) await this.storeHealed(cache, key, plan, next, description, ctx);
          else await cache.store.put(cache.testTitle, key, next);
        }
        return { locator: buildLocator(this._page, target.locators[0]!.expr), candidates: toCandidates(target) };
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

const toCandidates = (t: PlanTarget): LocatorCandidate[] =>
  t.locators.map((l) => ({ rung: l.rung as Rung, expr: l.expr, display: l.display }));

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
