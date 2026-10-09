import { defineConfig, devices } from '@playwright/test';
import { withAipw } from '@aipw/test';
import { saucedemo } from './examples/targets/saucedemo/target.js';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional; CI passes variables directly
}

const saucedemoUse = {
  ...devices['Desktop Chrome'],
  baseURL: saucedemo.baseURL,
  testIdAttribute: saucedemo.testIdAttributes[0],
};

export default defineConfig(
  withAipw({
    testDir: 'examples/tests',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI
      ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]]
      : [['list'], ['html', { open: 'never' }]],
    use: {
      trace: 'retain-on-failure',
    },
    projects: [
      {
        // Engine wiring with FakeProvider on local fixture pages: no AI, no network.
        name: 'fixtures',
        testDir: 'examples/tests/fixtures',
        use: { ...devices['Desktop Chrome'], testIdAttribute: 'data-test' },
      },
      {
        // Plain-Playwright smoke spec for the public target. Light load only; not a CI gate (risk R13).
        name: 'saucedemo',
        testDir: 'examples/tests/saucedemo',
        grepInvert: /@llm/,
        use: saucedemoUse,
      },
      {
        // Usability suite with real AI calls (npm run e2e:llm). Uses AIPW_PROVIDER, default claude-code.
        name: 'saucedemo-llm',
        testDir: 'examples/tests/saucedemo',
        grep: /@llm/,
        use: saucedemoUse,
      },
    ],
  }),
);
