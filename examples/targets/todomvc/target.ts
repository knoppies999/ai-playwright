// Target profile for TodoMVC as hosted by Playwright (demo.playwright.dev/todomvc): static files on a CDN, so pages
// load in about 0.1 s and never sleep. Small, but it has hover-only buttons (delete), double-click editing, filters,
// a toggle-all and persistence in localStorage. Each Playwright test gets a fresh context, so every test starts with
// an empty list.

export const todomvc = {
  name: 'todomvc',
  baseURL: 'https://demo.playwright.dev/todomvc/',
  /** data-testid on todo items, titles and the counter; Playwright's default testIdAttribute. */
  testIdAttributes: ['data-testid'],
} as const;
