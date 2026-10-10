// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', 'test-results/**', 'playwright-report/**', 'spikes/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // AGENTS.md rule 4: stored locator strings are interpreted, never evaluated.
      'no-eval': 'error',
      'no-new-func': 'error',
      // Playwright fixtures must destructure their first argument, even when they use nothing: async ({}, use) => …
      'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Demo app client scripts run in the browser.
    files: ['examples/demo-app/public/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
