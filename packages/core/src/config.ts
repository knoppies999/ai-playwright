import { z } from 'zod';
import { DEFAULT_REJECT_TEST_ID_VALUES, DEFAULT_TEST_ID_ATTRIBUTES } from './locators/test-ids.js';

// Zod is the single source of truth for config (AGENTS.md rule 3). Only the sections that exist
// so far are modelled; the rest of docs/09 §1 lands with the phase that needs it.

const ProviderEntrySchema = z.looseObject({
  /** npm package that implements the adapter, loaded with dynamic import(). */
  package: z.string(),
  model: z.string().optional(),
});

export const AipwConfigSchema = z.object({
  provider: z.string().default('claude-code'),
  providers: z.record(z.string(), ProviderEntrySchema).default({}),
  testIds: z
    .object({
      attributes: z.array(z.string()).default([...DEFAULT_TEST_ID_ATTRIBUTES]),
      autoDetect: z.boolean().default(true),
      rejectValues: z.array(z.instanceof(RegExp)).default([...DEFAULT_REJECT_TEST_ID_VALUES]),
    })
    .prefault({}),
  navigation: z
    .object({
      /** The baseURL origin and the page's origin when a step starts are always allowed too. */
      allowedOrigins: z.array(z.url()).default([]),
    })
    .prefault({}),
  steps: z
    .object({
      /** Decisions per ai.act. */
      maxActions: z.number().int().min(1).default(12),
      timeoutMs: z.number().int().min(1000).default(120_000),
      assertTimeoutMs: z.number().int().min(0).default(5_000),
      /** Playwright timeout for one action (click, fill…). */
      actionTimeoutMs: z.number().int().min(100).default(5_000),
    })
    .prefault({}),
  snapshot: z
    .object({
      maxTokens: z.number().int().min(500).default(6_000),
      collapseSiblingsOver: z.number().int().min(2).default(15),
    })
    .prefault({}),
  settle: z
    .object({
      /** Upper bound for waiting after an action and for the snapshot to stop changing. */
      maxMs: z.number().int().min(0).default(3_000),
      networkQuietMs: z.number().int().min(0).default(300),
      /** Gap between the two snapshots that must match before the page counts as stable. */
      snapshotIntervalMs: z.number().int().min(0).default(150),
    })
    .prefault({}),
  secrets: z
    .object({
      /** 'env', or a function returning the value for a secret name (e.g. from Azure Key Vault). */
      provider: z
        .union([z.literal('env'), z.custom<(name: string) => string | undefined>((v) => typeof v === 'function')])
        .default('env'),
      /**
       * How secrets are typed. 'evaluate' sets the value by script, so it stays out of the trace's action log
       * (spike 0.7); traces also need snapshots off to keep it out of DOM snapshots.
       */
      fillMode: z.enum(['fill', 'evaluate']).default('fill'),
      /** Secret name → environment variable. */
      map: z.record(z.string(), z.string()).default({}),
      /** Allow secrets in fields that aren't credential fields (docs/08 §4 rule 4). */
      allowAnyField: z.boolean().default(false),
    })
    .prefault({}),
  hints: z
    .object({
      /** Folder with hints/<host-port>.md files, relative to the working directory (docs/09 §1). */
      dir: z.string().default('hints'),
    })
    .prefault({}),
  cache: z
    .object({
      /** docs/06 §1. AIPW_CACHE overrides it. */
      mode: z.enum(['auto', 'replay-only', 'ai-only', 'refresh']).default('auto'),
      /** Plan files live in this folder next to each spec. */
      dir: z.string().default('__aipw__'),
    })
    .prefault({}),
  heal: z
    .object({
      /** accept: write the healed plan · report: keep the old plan, write the new one to .aipw/healed/ · fail: fail the test. */
      policy: z.enum(['accept', 'report', 'fail']).default(process.env.CI ? 'report' : 'accept'),
      /** Fingerprint heals cost nothing and are deterministic, so they are allowed in replay-only mode. */
      fingerprintInReplayOnly: z.boolean().default(true),
    })
    .prefault({}),
  /** Hard stops (docs/09 §1). A step or run that goes over fails with AiBudgetExceeded. */
  budget: z
    .object({
      perStepUsd: z.number().positive().optional(),
      /** Per Playwright worker process: workers don't share a counter. */
      perRunUsd: z.number().positive().optional(),
      /** For providers without token pricing (Copilot); also per worker. */
      perRunRequests: z.number().int().positive().optional(),
    })
    .prefault({}),
  /** Retries for rate limits (429) and network errors, with exponential backoff and full jitter. */
  retry: z
    .object({
      retries: z.number().int().min(0).default(4),
      baseMs: z.number().int().positive().default(1_000),
      /** Longest single wait; a provider asking to wait longer than this fails the call instead. */
      maxMs: z.number().int().positive().default(30_000),
    })
    .prefault({}),
  /** USD per 1M tokens, keyed "provider:model", for cost estimates when the provider gives none. */
  pricing: z
    .record(z.string(), z.object({ input: z.number(), output: z.number(), cacheRead: z.number().optional() }))
    .default({}),
});

export type CacheMode = AipwConfig['cache']['mode'];

export type AipwConfigInput = z.input<typeof AipwConfigSchema>;
export type AipwConfig = z.output<typeof AipwConfigSchema>;

/** Typed helper for `aipw.config.ts`. Returns its input unchanged; validation happens in `resolveConfig`. */
export function defineAipwConfig(config: AipwConfigInput): AipwConfigInput {
  return config;
}

/** Validates a config and fills in defaults. Throws a readable error on invalid input. */
export function resolveConfig(input: AipwConfigInput = {}): AipwConfig {
  const result = AipwConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid aipw config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
