import { defineConfig, devices } from '@playwright/test';
import { saucedemo } from './examples/targets/saucedemo/target.js';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional; CI passes variables directly
}

export default defineConfig({
  testDir: 'examples/tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['junit', { outputFile: 'test-results/junit.xml' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // Public usability target. Light load only; not a CI gate (risk R13).
      name: 'saucedemo',
      testDir: 'examples/tests/saucedemo',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: saucedemo.baseURL,
        testIdAttribute: saucedemo.testIdAttributes[0],
      },
    },
  ],
});
