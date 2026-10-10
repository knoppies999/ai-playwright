// `aipw hints lint [dir]` (docs/09 §4): checks hints/<host-port>.md files for duplicate hints and for size. Hints over
// the prompt cap (~1,500 tokens per page, docs/09 §1) are silently cut when they are loaded, so they are flagged here.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MAX_HINT_CHARS = 6000;

export interface HintProblem {
  file: string;
  line?: number;
  message: string;
}

/** Problems in one hints file's text. */
export function lintHints(file: string, text: string): HintProblem[] {
  const problems: HintProblem[] = [];
  const seen = new Map<string, number>();
  const headings = new Map<string, number>();
  let section = '';
  let chars = 0;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = heading[1]!;
      const before = headings.get(section.toLowerCase());
      if (before) problems.push({ file, line: i + 1, message: `section "## ${section}" repeats line ${before}` });
      headings.set(section.toLowerCase(), i + 1);
      return;
    }
    if (!line || line.startsWith('#') || line.startsWith('<!--')) return;
    if (!section) {
      problems.push({
        file,
        line: i + 1,
        message: 'hint outside a "## Everywhere" or "## /path" section is never loaded',
      });
      return;
    }
    const hint = line.replace(/^[-*]\s+/, '');
    chars += hint.length;
    const key = `${section.toLowerCase()}\n${hint.toLowerCase().replace(/\s+/g, ' ')}`;
    const first = seen.get(key);
    if (first) problems.push({ file, line: i + 1, message: `duplicate of line ${first}` });
    else seen.set(key, i + 1);
  });
  if (chars > MAX_HINT_CHARS)
    problems.push({
      file,
      message: `${chars} characters of hints; a page loads at most ${MAX_HINT_CHARS}, the rest is dropped. Merge or shorten them`,
    });
  return problems;
}

export function runHintsCommand(argv: string[]): number {
  const [sub, dirArg] = argv;
  if (sub !== 'lint') {
    console.error('Usage: aipw hints lint [dir]   (default dir: hints)');
    return 1;
  }
  const dir = resolve(dirArg ?? 'hints');
  if (!existsSync(dir)) {
    console.log(`No hints folder at ${dir}.`);
    return 0;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  const problems = files.flatMap((f) => lintHints(f, readFileSync(join(dir, f), 'utf8')));
  for (const p of problems) console.log(`${p.file}${p.line ? `:${p.line}` : ''}  ${p.message}`);
  console.log(`${files.length} hints file(s), ${problems.length} problem(s).`);
  return problems.length ? 1 : 0;
}
