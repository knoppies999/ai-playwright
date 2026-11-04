// Which origins an AI step may navigate to (AGENTS.md rule 6): the baseURL origin, the page's origin when the step
// starts, and navigation.allowedOrigins, where "https://*.wikipedia.org" allows every subdomain.

/** An allow-list entry: an exact origin, or a wildcard "https://*.example.org" kept as written (lower-cased). */
export function allowEntry(url: string): string | undefined {
  if (/^[a-z][\w+.-]*:\/\/\*\./i.test(url)) return url.toLowerCase().replace(/\/+$/, '');
  try {
    return new URL(url).origin;
  } catch {
    return undefined; // not a URL (about:blank)
  }
}

export function isAllowedUrl(url: string, allowed: ReadonlySet<string>): boolean {
  if (/^(about|data|blob):/.test(url)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (allowed.has(u.origin)) return true;
  for (const entry of allowed) {
    const m = /^([a-z][\w+.-]*:)\/\/\*\.([^/:]+)(?::(\d+))?$/.exec(entry);
    if (m && u.protocol === m[1] && u.hostname.endsWith(`.${m[2]}`) && (m[3] ?? '') === u.port) return true;
  }
  return false;
}

/** For a blocked navigation: the config line that would allow it. */
export function allowHint(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.hostname.split('.');
    const wildcard =
      parts.length > 2 ? `, or "${u.protocol}//*.${parts.slice(1).join('.')}" for all its subdomains` : '';
    return `If that's expected, add "${u.origin}" to navigation.allowedOrigins in aipw.config.ts${wildcard}.`;
  } catch {
    return '';
  }
}
