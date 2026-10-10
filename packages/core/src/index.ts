export { AipwConfigSchema, defineAipwConfig, resolveConfig } from './config.js';
export type { AipwConfig, AipwConfigInput } from './config.js';
export {
  DEFAULT_REJECT_TEST_ID_VALUES,
  DEFAULT_TEST_ID_ATTRIBUTES,
  detectTestIdAttributes,
  isConfiguredTestIdAttribute,
  isRejectedTestIdValue,
  looksLikeTestIdAttribute,
  normaliseAttributeName,
} from './locators/test-ids.js';
export type { DetectedTestIdAttribute } from './locators/test-ids.js';

export { Ai } from './step/ai.js';
export type { ActResult, AiDeps, AssertOptions, LocateResult, Verdict } from './step/ai.js';
export type { ActionRecord, StepContext, StepKind, StepOptions, StepOutcome, TargetDescriptor } from './types.js';
export {
  AiAssertionError,
  AiCacheReplayOnlyMiss,
  AiBudgetExceeded,
  AiError,
  AiExtractError,
  AiHealedError,
  AiProviderError,
  AiStepError,
  type Callsite,
  type ProviderErrorKind,
  type StepFailureKind,
} from './errors.js';
export { EventBus, type AipwEvent, type Listener } from './events/bus.js';
export { Redactor, REDACTED } from './data/redactor.js';

export { addUsage, emptyUsage } from './llm/provider.js';
export { BudgetGuard, costOf, resetRunBudget, withBudget, type BudgetLimits, type PricingTable } from './llm/budget.js';
export { backoffMs, withRetry, type RetryOptions } from './llm/retry.js';
export { kindForStatus, postJson, retryAfterMs, type FetchLike } from './llm/http.js';
export { contractDecisionRequest, contractStructuredRequest } from './llm/contract.js';
export type {
  DecisionRequest,
  DecisionResponse,
  ImageInput,
  JsonSchema,
  LlmProvider,
  ProviderCapabilities,
  ProviderFactory,
  StopReason,
  StructuredRequest,
  StructuredResponse,
  ToolSpec,
  Usage,
} from './llm/provider.js';
export { FakeProvider, type ScriptedDecision, type ScriptedStructured } from './llm/fake-provider.js';
export { DEFAULT_PROVIDERS, loadProvider } from './llm/loader.js';

export {
  TOOL_SCHEMAS,
  toJsonSchema,
  toolSpecs,
  type AnyToolCall,
  type CodeTool,
  type CodeToolCall,
  type ToolCall,
  type ToolName,
} from './actions/schemas.js';
export {
  buildLocator,
  describeLocator,
  LocatorExprSchema,
  type LocatorExpr,
  type LocatorStep,
} from './locators/expr.js';
export { synthesizeLocators, type LocatorCandidate, type Rung } from './locators/synth.js';
export { parseSnapshot, pruneSnapshot, renderSnapshot } from './observe/snapshot.js';

export { FilePlanStore, MemoryPlanStore, planFilePath, readPlanFile, type PlanStore } from './cache/store.js';
export { stepKey } from './cache/keys.js';
export { PlanFileSchema, stableStringify, type PlanFile, type StepPlan } from './cache/plan.js';
export type { CacheMode } from './config.js';
export {
  createGenerators,
  GENERATOR_KINDS,
  isValidIban,
  isValidLuhn,
  isValidSaId,
  isValidVat,
  saIdBirthDate,
  TEST_CARDS,
  totp,
  base32Decode,
  type Generators,
  type Person,
} from './data/generators.js';
export { NudgeController, type NudgeOptions } from './nudge/controller.js';
export { NudgeServer, ScriptedUi, type NudgeUi, type Verification } from './nudge/server.js';
export {
  NUDGE_PROTOCOL_VERSION,
  NudgeCommandSchema,
  NudgeQuit,
  PauseStateSchema,
  RewindSignal,
  VerifyDone,
  VerifyJobSchema,
  type BreakLevel,
  type NudgeCommand,
  type PauseState,
  type RemedyBasis,
  type RemedyOption,
  type VerifyJob,
} from './nudge/protocol.js';
export { hintFileName, loadHints, writeHint, type NewHint } from './hints/store.js';
export {
  codeRemedy,
  finalTargets,
  matchesBasis,
  remedyOptions,
  targetFacts,
  RemedySchema,
  remedyPrompt,
  synthesizeRemedy,
  type Remedy,
  type RemedyInput,
} from './nudge/remedy.js';
