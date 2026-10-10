// Core data types (docs/02 §5).
import type { Locator } from 'playwright-core';
import type { Fingerprint } from './cache/plan.js';
import type { Callsite } from './errors.js';
import type { Usage } from './llm/provider.js';
import type { LocatorCandidate } from './locators/synth.js';

export type StepKind = 'act' | 'assert' | 'extract' | 'locate';

export interface StepOptions {
  /** Values the model must use verbatim; it sees them. */
  data?: Record<string, unknown>;
  /** Secret names; the model only sees {{secret.name}}. */
  secrets?: string[];
  /** Extra guidance for this step only. */
  hints?: string[];
  /** Restrict observation to a region. */
  scope?: Locator;
  maxActions?: number;
  timeout?: number;
  /** May the model call navigate (always limited to allowed origins). */
  allowNavigation?: boolean;
  /** Per-step cache override: off = always AI, don't store; refresh = always AI, overwrite the plan. */
  cache?: 'auto' | 'off' | 'refresh';
  /** Pins the cache key so instruction edits don't orphan the plan (docs/06 §3). */
  key?: string;
  /** Which code tools this step may use (default: all registered). */
  tools?: string[];
}

export interface StepContext {
  id: string;
  kind: StepKind;
  instruction: string;
  options: StepOptions;
  callsite?: Callsite;
}

export interface TargetDescriptor {
  /** The ref the model used. Only meaningful during this step; never stored in plans. */
  ref: string;
  role?: string;
  name?: string;
  /** Verified durable locators, best first (docs/12 §3). */
  candidates: LocatorCandidate[];
  /** For healing without AI when every locator fails (docs/12 §6). */
  fingerprint?: Fingerprint;
}

export interface ActionRecord {
  tool: string;
  /** With placeholders, never resolved secrets. */
  args: Record<string, unknown>;
  intent?: string;
  target?: TargetDescriptor;
  /** fill_form: one target per field. */
  targets?: TargetDescriptor[];
  /** 'ok', or an error message the model sees. */
  result: string;
  /** Text returned to the model (expand output, wait results). */
  output?: string;
  before: { url: string; snapshotHash: string };
  after: { url: string };
  durationMs: number;
}

export interface StepOutcome {
  status: 'done' | 'failed';
  actions: ActionRecord[];
  summary: string;
  evidence: string[];
  failure?: { kind: string; reason: string };
  usage: Usage;
  source: 'ai';
  /** Final observation's snapshot, for reports. */
  lastSnapshot?: string;
}
