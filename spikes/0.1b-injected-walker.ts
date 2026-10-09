// Spike 0.1b: prototype of the injected walker (docs/12 §2 R2). addInitScript defines window.__aipw;
// at observe time each frame tags interesting elements with data-aipw-ref and returns YAML lines.
// Compares its output with Playwright's AI snapshot on the same pages.
import type { Page } from '@playwright/test';
import { launch, out, refsIn, SAUCEDEMO_PAGES } from './lib.js';

// Runs in the page. Kept dependency-free for the spike: role and name computation is simplified
// (the real walker would bundle dom-accessibility-api).
function walkerInit(): void {
  const TEST_ID = /^(data)?(test|qa|cy|pw|e2e|automation)(id)?$/;
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  const IMPLICIT: Record<string, string> = {
    A: 'link',
    BUTTON: 'button',
    SELECT: 'combobox',
    TEXTAREA: 'textbox',
    NAV: 'navigation',
    MAIN: 'main',
    HEADER: 'banner',
    FOOTER: 'contentinfo',
    FORM: 'form',
    TABLE: 'table',
    TR: 'row',
    LI: 'listitem',
    UL: 'list',
    OL: 'list',
    H1: 'heading',
    H2: 'heading',
    H3: 'heading',
    H4: 'heading',
    H5: 'heading',
    H6: 'heading',
    IMG: 'img',
    DIALOG: 'dialog',
    IFRAME: 'iframe',
    OPTION: 'option',
  };
  const INPUT_ROLES: Record<string, string> = {
    checkbox: 'checkbox',
    radio: 'radio',
    button: 'button',
    submit: 'button',
    reset: 'button',
    range: 'slider',
    search: 'searchbox',
    email: 'textbox',
    text: 'textbox',
    password: 'textbox',
    tel: 'textbox',
    url: 'textbox',
    number: 'spinbutton',
  };
  const INTERACTIVE = new Set([
    'link',
    'button',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'slider',
    'spinbutton',
    'option',
    'menuitem',
    'tab',
    'switch',
  ]);
  const KEEP = new Set([
    ...INTERACTIVE,
    'heading',
    'img',
    'dialog',
    'navigation',
    'main',
    'banner',
    'contentinfo',
    'form',
    'table',
    'row',
    'list',
    'listitem',
    'iframe',
    'alert',
    'status',
  ]);

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0]!;
    if (el.tagName === 'INPUT') return INPUT_ROLES[(el as HTMLInputElement).type] ?? 'textbox';
    if (el.tagName === 'A' && !el.hasAttribute('href')) return null;
    return IMPLICIT[el.tagName] ?? null;
  };
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by)
      return by
        .split(' ')
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
    if (el.id) {
      const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent!.trim();
    }
    const attr = el.getAttribute('alt') ?? el.getAttribute('placeholder') ?? el.getAttribute('title');
    if (attr) return attr;
    if (el.tagName === 'INPUT' && ['submit', 'button'].includes((el as HTMLInputElement).type))
      return (el as HTMLInputElement).value;
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  };
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };

  let counter = 0;
  (window as unknown as { __aipw: unknown }).__aipw = {
    snapshot(opts: { prefix: string }): string {
      document.querySelectorAll('[data-aipw-ref]').forEach((e) => e.removeAttribute('data-aipw-ref'));
      const lines: string[] = [];
      const visit = (root: Element | ShadowRoot, depth: number) => {
        for (const el of Array.from(root.children)) {
          let next = depth;
          const role = roleOf(el);
          if (role && KEEP.has(role) && visible(el)) {
            const ref = `${opts.prefix}e${++counter}`;
            el.setAttribute('data-aipw-ref', ref);
            const testIds = el.getAttributeNames().filter((a) => TEST_ID.test(norm(a)));
            const tid = testIds.map((a) => ` [testid=${el.getAttribute(a)}]`).join('');
            const name = nameOf(el);
            const isSecret = el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'password';
            const value = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? (el as HTMLInputElement).value : '';
            const shown = value ? `: ${isSecret ? '••••' : value}` : '';
            lines.push(`${'  '.repeat(depth)}- ${role}${name ? ` "${name}"` : ''} [ref=${ref}]${tid}${shown}`);
            next = depth + 1;
          }
          if (el.shadowRoot) visit(el.shadowRoot, next);
          visit(el, next);
        }
      };
      visit(document.body, 0);
      return lines.join('\n');
    },
  };
}

async function snapshotAllFrames(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const [i, frame] of page.frames().entries()) {
    const yaml = await frame.evaluate((prefix) => (window as any).__aipw.snapshot({ prefix }), `f${i}`);
    parts.push(i === 0 ? yaml : `# frame ${i} ${frame.url()}\n${yaml}`);
  }
  return parts.join('\n');
}

async function resolveAll(page: Page, yaml: string): Promise<{ ok: number; bad: string[] }> {
  let ok = 0;
  const bad: string[] = [];
  for (const ref of refsIn(yaml)) {
    const frameIndex = Number(/^f(\d+)/.exec(ref)![1]);
    const count = await page.frames()[frameIndex]!.locator(`[data-aipw-ref="${ref}"]`).count();
    if (count === 1) ok++;
    else bad.push(`${ref}:${count}`);
  }
  return { ok, bad };
}

const interactiveCount = (yaml: string) =>
  yaml.split('\n').filter((l) => /^\s*- (link|button|textbox|combobox|checkbox|radio|searchbox|spinbutton)\b/.test(l))
    .length;

const browser = await launch();
async function newContext() {
  const context = await browser.newContext();
  // tsx/esbuild wraps named functions with __name(); define it in the page so the serialised walker runs.
  await context.addInitScript({ content: 'globalThis.__name = (f) => f;' });
  await context.addInitScript(walkerInit);
  return context;
}
const rows = [];
for (const [name, go] of SAUCEDEMO_PAGES) {
  // SauceDemo keeps the cart in localStorage, so every journey needs a fresh context.
  const page = await (await newContext()).newPage();
  await go(page);
  await page.waitForTimeout(500); // let images settle (see spike 0.1)
  const started = performance.now();
  const ours = await snapshotAllFrames(page);
  const ms = Math.round(performance.now() - started);
  const theirs = await page.ariaSnapshot({ mode: 'ai' });
  const { ok, bad } = await resolveAll(page, ours);
  out(`0.1b-${name}.yaml`, ours);
  rows.push({
    page: name,
    walkerRefs: refsIn(ours).length,
    resolved: ok,
    bad: bad.slice(0, 3).join(' '),
    walkerInteractive: interactiveCount(ours),
    playwrightInteractive: interactiveCount(theirs),
    walkerChars: ours.length,
    playwrightChars: theirs.length,
    walkerMs: ms,
    withTestId: (ours.match(/\[testid=/g) ?? []).length,
  });
  await page.close();
}

// Frames + shadow DOM fixture
const page = await (await newContext()).newPage();
await page.setContent(`
  <button>Outside</button>
  <iframe srcdoc="<button>Inside frame</button>"></iframe>
  <div id="host"></div>
  <script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML = '<button data-testid="shadow-btn">In shadow</button>';</script>`);
await page.waitForTimeout(200);
// setContent bypasses navigation, so addInitScript did not run in the main frame or the srcdoc frame: inject explicitly.
for (const frame of page.frames()) {
  await frame.evaluate('globalThis.__name = (f) => f');
  await frame.evaluate(walkerInit);
}
const fixture = await snapshotAllFrames(page);
const fixtureResolve = await resolveAll(page, fixture);
await browser.close();

console.table(rows);
console.log(fixture);
console.log('fixture resolve', fixtureResolve);
out('0.1b-results.json', { rows, fixture, fixtureResolve });
