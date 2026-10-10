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
      ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }], ['@aipw/test/reporter']]
      : [['list'], ['html', { open: 'never' }], ['@aipw/test/reporter']],
    use: {
      trace: 'retain-on-failure',
    },
    // The demo app (examples/demo-app): local, no dependencies, used for healing tests from Phase 4 on.
    webServer: {
      command: 'node examples/demo-app/server.mjs',
      url: 'http://localhost:5173/login',
      reuseExistingServer: !process.env.CI,
    },
    projects: [
      {
        // Engine wiring with FakeProvider on local fixture pages: no AI, no network.
        name: 'fixtures',
        testDir: 'examples/tests/fixtures',
        use: { ...devices['Desktop Chrome'], testIdAttribute: 'data-test' },
      },
      {
        // Healing scenarios on the demo app with FakeProvider: no AI, localhost only.
        name: 'demo',
        testDir: 'examples/tests/demo',
        use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:5173' },
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
