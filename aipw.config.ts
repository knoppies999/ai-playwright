import { defineAipwConfig } from '@aipw/core';

export default defineAipwConfig({
  // claude-code runs on the signed-in Claude Code subscription (decision D12). Override per run with
  // AIPW_PROVIDER, and the model with AIPW_MODEL.
  provider: 'claude-code',
  secrets: {
    // SauceDemo's public demo password, still treated as a secret (examples/targets/saucedemo).
    map: { password: 'SAUCEDEMO_PASSWORD' },
  },
});
