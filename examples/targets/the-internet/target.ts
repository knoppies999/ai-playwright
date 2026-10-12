// Target profile for "The Internet" (the-internet.herokuapp.com): Sauce Labs' public collection of awkward UI
// patterns, one per page (hover captions, dynamic loading, JS dialogs, sortable tables…). A stress test for the
// agent rather than a realistic app. Public site on a free host: the first request after idle can return a Heroku
// "Application Error" for a few seconds. Keep the load light (one worker); never make it a CI gate (risk R13).

export const theInternet = {
  name: 'the-internet',
  baseURL: 'https://the-internet.herokuapp.com',
  /** No test ids: everything goes through role, label, text and anchored locators (docs/12 L2–L6). */
  testIdAttributes: [] as string[],
  secrets: {
    /** The login page prints its demo password; the spec reads it from there at run time, never from source. */
    password: 'THE_INTERNET_PASSWORD',
  },
} as const;
