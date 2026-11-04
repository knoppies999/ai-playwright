import { describe, expect, it } from 'vitest';
import { allowEntry, allowHint, isAllowedUrl } from '../src/step/origins.js';

const allowed = (...urls: string[]) => new Set(urls.map((u) => allowEntry(u)!).filter(Boolean));

describe('navigation allow-list', () => {
  it('allows exact origins and wildcard subdomains', () => {
    const list = allowed('https://en.wikipedia.org/wiki/Main_Page', 'https://*.wikimedia.org');
    expect(isAllowedUrl('https://en.wikipedia.org/wiki/Table_Mountain', list)).toBe(true);
    expect(isAllowedUrl('https://af.wikipedia.org/wiki/Tafelberg', list)).toBe(false);
    expect(isAllowedUrl('https://upload.wikimedia.org/x.png', list)).toBe(true);
    expect(isAllowedUrl('http://upload.wikimedia.org/x.png', list)).toBe(false);
    expect(isAllowedUrl('https://evilwikimedia.org/', list)).toBe(false);
    expect(isAllowedUrl('about:blank', list)).toBe(true);
  });

  it('says how to allow a blocked navigation', () => {
    expect(allowHint('https://af.wikipedia.org/wiki/Tafelberg')).toBe(
      'If that\'s expected, add "https://af.wikipedia.org" to navigation.allowedOrigins in aipw.config.ts, or "https://*.wikipedia.org" for all its subdomains.',
    );
  });
});
