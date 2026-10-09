// The Observer (docs/04 §1): a stable, masked, pruned AI snapshot plus the page-state extras.
import { createHash } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import type { PageState } from './page-state.js';
import { maskSnapshot, parseSnapshot, pruneSnapshot, type PruneOptions, type SnapNode } from './snapshot.js';

export interface Observation {
  url: string;
  title: string;
  tabs: { index: number; url: string; title: string; active: boolean }[];
  dialogs: { type: string; message: string }[];
  notices: string[];
  /** Pruned, masked snapshot text the model sees. */
  snapshot: string;
  snapshotHash: string;
  /** Refs the model may use. `expand` adds more. */
  refs: Set<string>;
  truncated: boolean;
  /** The full masked tree, for expand and for target descriptions. */
  tree: SnapNode[];
}

export interface ObserverOptions {
  prune: PruneOptions;
  /** Max time to wait for two identical consecutive snapshots. */
  stableMaxMs: number;
  stableIntervalMs: number;
  /** Secret values registered so far (the Redactor's list). */
  secrets: () => readonly string[];
}

/** Values of credential fields in every frame: they must never reach a model (spike 0.1). */
async function credentialValues(page: Page): Promise<string[]> {
  const perFrame = await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate(() =>
          Array.from(document.querySelectorAll('input'))
            .filter((i) => i.type === 'password' || /password|one-time-code/i.test(i.autocomplete ?? ''))
            .map((i) => i.value)
            .filter((v) => v !== ''),
        )
        .catch(() => [] as string[]),
    ),
  );
  return perFrame.flat();
}

export class Observer {
  constructor(
    private readonly state: PageState,
    private readonly options: ObserverOptions,
  ) {}

  get page(): Page {
    return this.state.page;
  }

  /** Snapshots until two consecutive snapshots match (images and late content settle), within a cap. */
  async stableSnapshot(scope?: Locator): Promise<string> {
    const take = () => (scope ?? this.page).ariaSnapshot({ mode: 'ai', timeout: 5_000 });
    const deadline = Date.now() + this.options.stableMaxMs;
    let previous = await take();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.options.stableIntervalMs));
      const next = await take();
      if (next === previous) return next;
      previous = next;
    }
    return previous;
  }

  async observe(scope?: Locator): Promise<Observation> {
    const page = this.page;
    // A pending native dialog blocks page scripts, so the snapshot can't be taken until it's handled.
    const blocked = this.state.dialogs.length > 0;
    const raw = blocked
      ? '- (page is blocked by a native dialog: call handle_dialog)'
      : await this.stableSnapshot(scope);
    const sensitive = [...(blocked ? [] : await credentialValues(page)), ...this.options.secrets()];
    const tree = maskSnapshot(parseSnapshot(raw), sensitive);
    const pruned = pruneSnapshot(tree, this.options.prune);
    const pages = page.context().pages();
    return {
      url: page.url(),
      title: blocked ? '' : await page.title().catch(() => ''),
      tabs: await Promise.all(
        pages.map(async (p, index) => ({
          index,
          url: p.url(),
          title: p === page && blocked ? '' : await p.title().catch(() => ''),
          active: p === page,
        })),
      ),
      dialogs: this.state.dialogs.map(({ type, message }) => ({ type, message })),
      notices: blocked ? [] : await this.state.drainNotices(),
      snapshot: pruned.text,
      snapshotHash: createHash('sha1').update(pruned.text).digest('hex'),
      refs: new Set(pruned.refs),
      truncated: pruned.truncated,
      tree,
    };
  }
}
