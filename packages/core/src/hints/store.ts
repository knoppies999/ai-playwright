// HintStore (docs/09 §1, docs/07 §6.5): site knowledge in hints/<origin>.md, injected into prompts.
// File name: the URL's host and port with ':' → '-' (localhost-5173.md). "## Everywhere" applies to every
// path; any other "## " heading is a path glob (* within a segment, ** across segments).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** ~1,500 tokens (docs/09 §1). */
const MAX_HINT_CHARS = 6000;

export function hintFileName(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (!u.host) return undefined;
    return `${u.host.replace(/:/g, '-')}.md`;
  } catch {
    return undefined;
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@GLOBSTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@GLOBSTAR@@/g, '.*');
  return new RegExp(`^${escaped}$`);
}

interface Section {
  heading: string;
  lines: string[];
}

function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  for (const line of markdown.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = { heading: h[1]!, lines: [] };
      sections.push(current);
    } else if (current && line.trim()) current.lines.push(line.trim());
  }
  return sections;
}

const appliesTo = (heading: string, path: string) =>
  heading.toLowerCase() === 'everywhere' || globToRegExp(heading).test(path);

/** Hints for a URL: lines from every matching section, site-wide first, capped. */
export function loadHints(dir: string, url: string): string[] {
  const name = hintFileName(url);
  if (!name) return [];
  const file = join(dir, name);
  if (!existsSync(file)) return [];
  const path = new URL(url).pathname;
  const sections = parseSections(readFileSync(file, 'utf8')).filter((s) => appliesTo(s.heading, path));
  sections.sort(
    (a, b) => Number(b.heading.toLowerCase() === 'everywhere') - Number(a.heading.toLowerCase() === 'everywhere'),
  );
  const out: string[] = [];
  let size = 0;
  for (const line of sections.flatMap((s) => s.lines)) {
    const text = line.replace(/^[-*]\s+/, '');
    if (size + text.length > MAX_HINT_CHARS) break;
    out.push(text);
    size += text.length;
  }
  return out;
}

export interface NewHint {
  scope: 'site' | 'path';
  /** For path hints: the glob heading, e.g. /users/new or /settings/**. */
  pathPattern?: string | null;
  text: string;
}

/** Appends a hint under the right section, creating the file and section if needed. Returns the file path. */
export function writeHint(dir: string, url: string, hint: NewHint): string {
  const name = hintFileName(url);
  if (!name) throw new Error(`Can't derive a hints file from ${url}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const heading = hint.scope === 'site' || !hint.pathPattern ? 'Everywhere' : hint.pathPattern;
  const bullet = `- ${hint.text.trim().replace(/\n+/g, ' ')}`;
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : `# Site: ${new URL(url).host}\n`;
  const lines = existing.replace(/\s+$/, '').split('\n');
  const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (at < 0) {
    lines.push('', `## ${heading}`, bullet);
  } else {
    let end = at + 1;
    while (end < lines.length && !lines[end]!.startsWith('## ')) end++;
    while (end > at + 1 && !lines[end - 1]!.trim()) end--;
    lines.splice(end, 0, bullet);
  }
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
