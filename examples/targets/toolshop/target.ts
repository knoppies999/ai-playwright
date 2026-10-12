// Target profile for Practice Software Testing's "Toolshop" (practicesoftwaretesting.com): a public demo shop built
// for test-automation practice. A richer target than SauceDemo: search, filters, sorting, pagination, product pages,
// a multi-step checkout with a guest path, registration, accounts, a contact form, rentals and languages.
// Public site: keep the load light (one worker) and never make it a CI gate (risk R13).

export const toolshop = {
  name: 'toolshop',
  baseURL: 'https://practicesoftwaretesting.com',

  /**
   * `data-test` on most elements (checked 2026-10-10). Products and categories carry generated ids
   * (`product-01M4KFJH…`), which LocatorSynth's generated-value filter skips in favour of role/name locators.
   */
  testIdAttributes: ['data-test'],

  /** The account suite registers a fresh user each run; its password is generated, never written in a spec. */
  secrets: {
    password: 'TOOLSHOP_PASSWORD',
  },
} as const;
