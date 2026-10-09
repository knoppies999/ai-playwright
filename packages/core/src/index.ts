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
