// Page-state extras (docs/04 §1.3): native dialogs held for the model, notices (toasts, alerts,
// live regions) captured even if they vanish, and in-flight requests for settling (docs/04 §3.1).
import type { BrowserContext, Dialog, Page, Request } from 'playwright-core';

/** Runs in every page. Collects text of alert/status/live regions as they appear. Self-contained. */
const NOTICE_COLLECTOR = `(() => {
  if (window.__aipwNotices) return;
  window.__aipwNotices = [];
  const SELECTOR = '[role=alert],[role=status],[aria-live]:not([aria-live=off]),[role=alertdialog]';
  const record = (el) => {
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text && window.__aipwNotices[window.__aipwNotices.length - 1] !== text) window.__aipwNotices.push(text.slice(0, 300));
  };
  const scan = (node) => {
    if (!(node instanceof Element)) return;
    if (node.matches(SELECTOR)) record(node);
    node.querySelectorAll(SELECTOR).forEach(record);
    const live = node.closest && node.closest(SELECTOR);
    if (live && live !== node) record(live);
  };
  const start = () => new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') scan(m.target.parentElement);
      m.addedNodes.forEach(scan);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

const contextsWithCollector = new WeakSet<BrowserContext>();

export interface PendingDialog {
  type: string;
  message: string;
  dialog: Dialog;
}

/** Attached to a page for the duration of an AI step. */
export class PageState {
  readonly dialogs: PendingDialog[] = [];
  private inflight = new Set<Request>();
  private lastNetworkActivity = Date.now();
  private readonly onDialog = (dialog: Dialog) => {
    this.dialogs.push({ type: dialog.type(), message: dialog.message(), dialog });
  };
  private readonly onRequest = (r: Request) => {
    if (['fetch', 'xhr', 'document'].includes(r.resourceType())) {
      this.inflight.add(r);
      this.lastNetworkActivity = Date.now();
    }
  };
  private readonly onRequestDone = (r: Request) => {
    if (this.inflight.delete(r)) this.lastNetworkActivity = Date.now();
  };

  private constructor(readonly page: Page) {}

  static async attach(page: Page): Promise<PageState> {
    const state = new PageState(page);
    const context = page.context();
    if (!contextsWithCollector.has(context)) {
      contextsWithCollector.add(context);
      await context.addInitScript({ content: NOTICE_COLLECTOR });
    }
    // Pages that loaded before the init script was registered get it now.
    await Promise.all(page.frames().map((f) => f.evaluate(NOTICE_COLLECTOR).catch(() => undefined)));
    page.on('dialog', state.onDialog);
    page.on('request', state.onRequest);
    page.on('requestfinished', state.onRequestDone);
    page.on('requestfailed', state.onRequestDone);
    return state;
  }

  /** Detaches listeners. A dialog the model never handled is dismissed so the page doesn't hang. */
  async detach(): Promise<void> {
    this.page.off('dialog', this.onDialog);
    this.page.off('request', this.onRequest);
    this.page.off('requestfinished', this.onRequestDone);
    this.page.off('requestfailed', this.onRequestDone);
    for (const d of this.dialogs.splice(0)) await d.dialog.dismiss().catch(() => undefined);
  }

  /** Notices captured since the last call (main frame). */
  async drainNotices(): Promise<string[]> {
    try {
      return await this.page.evaluate(() => {
        const w = window as unknown as { __aipwNotices?: string[] };
        const notices = w.__aipwNotices ?? [];
        w.__aipwNotices = [];
        return notices;
      });
    } catch {
      return []; // navigating, or a dialog is blocking the page
    }
  }

  /** Waits until no fetch/XHR/document request has been in flight for `quietMs`, at most `maxMs`. */
  async networkQuiet(quietMs: number, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (this.inflight.size === 0 && Date.now() - this.lastNetworkActivity >= quietMs) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
