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
      /** The baseURL origin is always allowed in addition to these. */
      allowedOrigins: z.array(z.url()).default([]),
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
