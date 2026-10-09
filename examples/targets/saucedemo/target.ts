// Target profile for the first public usability target (decision D11, open question Q1 → SauceDemo).
// SauceDemo is a public demo shop run by Sauce Labs. Use it for usability runs only, keep the load
// light, and never make it a CI gate (risk R13).

export const saucedemo = {
  name: 'saucedemo',
  baseURL: 'https://www.saucedemo.com',

  /**
   * Test-id attributes found by spike 0.1c: `data-test` only, on 304 elements across 8 pages.
   * List items reuse ids (`inventory-item` ×6, `inventory-item-name` ×6…), so those need an
   * anchored locator (docs/12 L5); buttons carry unique ids such as `add-to-cart-sauce-labs-backpack`.
   */
  testIdAttributes: ['data-test'],

  /**
   * Demo users. The password is public (the login page prints it) but is still read from the
   * environment, so specs handle it exactly like a real secret.
   */
  users: {
    standard: 'standard_user',
    lockedOut: 'locked_out_user',
    problem: 'problem_user',
    performanceGlitch: 'performance_glitch_user',
    error: 'error_user',
    visual: 'visual_user',
  },
  secrets: {
    password: 'SAUCEDEMO_PASSWORD',
  },
} as const;

/** Reads a secret named in the profile from the environment, with a clear error when it is missing. */
export function targetSecret(name: keyof typeof saucedemo.secrets): string {
  const variable = saucedemo.secrets[name];
  const value = process.env[variable];
  if (!value) throw new Error(`Set ${variable} (copy .env.example to .env).`);
  return value;
}
