// Spike 0.7: where does a secret show up in a Playwright trace when it is typed with fill(),
// with pressSequentially(), or set through evaluate() (docs/08 §4 rule 3b)?
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launch, OUT_DIR, out } from './lib.js';

const HTML = `<form><label>User <input name="u"></label><label>Password <input type="password" name="p"></label></form>`;

type Mode = 'fill' | 'pressSequentially' | 'evaluate' | 'evaluate-noSnapshots';

async function record(mode: Mode, secret: string): Promise<string> {
  const browser = await launch();
  const context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: mode !== 'evaluate-noSnapshots' });
  const page = await context.newPage();
  await page.setContent(HTML);
  const field = page.getByLabel('Password');
  if (mode === 'fill') await field.fill(secret);
  if (mode === 'pressSequentially') await field.pressSequentially(secret);
  if (mode.startsWith('evaluate')) {
    await field.evaluate((el, v) => {
      (el as HTMLInputElement).value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, secret);
  }
  await page.getByLabel('User').click(); // one more action so a DOM snapshot is taken after the value is set
  const zip = join(OUT_DIR, `0.7-${mode}.zip`);
  await context.tracing.stop({ path: zip });
  await browser.close();
  return zip;
}

function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name);
    if (statSync(path).isFile() && readFileSync(path).includes(needle)) hits.push(name);
  }
  return hits;
}

const results = [];
for (const mode of ['fill', 'pressSequentially', 'evaluate', 'evaluate-noSnapshots'] as Mode[]) {
  const secret = `Spike07-${mode}-Zq9x`;
  const zip = await record(mode, secret);
  const dir = join(OUT_DIR, `0.7-${mode}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Windows' own bsdtar reads zip files; Git Bash's GNU tar would treat 'C:' as a remote host.
  const tar = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'unzip';
  execFileSync(tar, process.platform === 'win32' ? ['-xf', zip, '-C', dir] : ['-q', zip, '-d', dir]);
  const hits = filesContaining(dir, secret);
  // Where exactly in the trace events?
  const traceLines = readFileSync(join(dir, 'trace.trace'), 'utf8')
    .split('\n')
    .filter((l) => l.includes(secret))
    .map((l) => {
      const e = JSON.parse(l);
      return `${e.type}${e.method ? `:${e.method}` : ''}${e.snapshot ? ':dom-snapshot' : ''}`;
    });
  results.push({
    mode,
    leaked: hits.length > 0,
    files: hits.join(', '),
    traceEvents: [...new Set(traceLines)].join(', '),
  });
}
console.table(results);
out('0.7-results.json', results);
