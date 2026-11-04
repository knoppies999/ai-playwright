// Sites misuse aria-hidden: python.org keeps its open hover menu aria-hidden. On screen, such a subtree is usable and
// must be shown; off screen (SauceDemo's closed side menu, translated away) it stays collapsed.
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { Ai } from '../src/step/ai.js';
import { useBrowser } from './browser.js';

const { page: open } = useBrowser();

const menu = (style: string) => `<nav><a href="#d">Downloads</a>
  <ul aria-hidden="true" style="${style}"><li><a href="#all">All releases</a></li><li><a href="#src">Source code</a></li></ul></nav>`;

async function observationOf(html: string): Promise<string> {
  const page = await open(html);
  let seen = '';
  const provider = new FakeProvider([
    (req: DecisionRequest) => {
      seen = req.observation;
      return { tool: 'done', args: { summary: 'looked', evidence: [] } };
    },
  ]);
  await new Ai({ page, provider, config: resolveConfig({ settle: { maxMs: 200, networkQuietMs: 0 } }) }).act('Look');
  return seen;
}

describe('aria-hidden subtrees', () => {
  it('shows an on-screen aria-hidden menu as usable', async () => {
    const seen = await observationOf(menu(''));
    expect(seen).toMatch(/link "?All releases"? \[ref=|All releases/);
    expect(seen).not.toContain('not usable until it is shown');
  });

  it('keeps an off-screen aria-hidden menu collapsed', async () => {
    const seen = await observationOf(menu('position: fixed; transform: translateX(-200%)'));
    expect(seen).toContain('not usable until it is shown');
  });
});
