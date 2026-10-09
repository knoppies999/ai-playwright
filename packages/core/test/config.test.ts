import { describe, expect, it } from 'vitest';
import { DEFAULT_TEST_ID_ATTRIBUTES } from '../src/locators/test-ids.js';
import { defineAipwConfig, resolveConfig } from '../src/config.js';

describe('resolveConfig', () => {
  it('fills in defaults', () => {
    const config = resolveConfig();
    expect(config.provider).toBe('claude-code');
    expect(config.testIds.attributes).toEqual(DEFAULT_TEST_ID_ATTRIBUTES);
    expect(config.testIds.autoDetect).toBe(true);
    expect(config.navigation.allowedOrigins).toEqual([]);
  });

  it('keeps provider-specific settings', () => {
    const config = resolveConfig(
      defineAipwConfig({
        providers: { foundry: { package: '@aipw/provider-openai', preset: 'foundry', model: 'e2e-agent' } },
      }),
    );
    expect(config.providers.foundry).toEqual({
      package: '@aipw/provider-openai',
      preset: 'foundry',
      model: 'e2e-agent',
    });
  });

  it('reports invalid input readably', () => {
    expect(() => resolveConfig({ navigation: { allowedOrigins: ['not a url'] } })).toThrow(/Invalid aipw config/);
  });
});
