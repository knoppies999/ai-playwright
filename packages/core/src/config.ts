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
      provider: z.literal('env').default('env'),
      /** Secret name → environment variable. */
      map: z.record(z.string(), z.string()).default({}),
      /** Allow secrets in fields that aren't credential fields (docs/08 §4 rule 4). */
      allowAnyField: z.boolean().default(false),
    })
    .prefault({}),
});

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
