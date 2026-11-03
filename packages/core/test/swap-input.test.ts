// Search boxes that replace themselves with a richer widget on focus (Wikipedia's header search): typing follows
// focus into the replacement, and submitting must too.
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { Ai } from '../src/step/ai.js';
import { useBrowser } from './browser.js';

const { page: open } = useBrowser();

const PAGE = `<main><form id="f" onsubmit="event.preventDefault()"><input type="search" aria-label="Search" id="placeholder"></form><p id="out"></p>
<script>
  document.getElementById('placeholder').addEventListener('focus', (e) => {
    const real = document.createElement('input');
    real.type = 'search';
    real.setAttribute('aria-label', 'Search');
    e.target.replaceWith(real);
    real.focus();
    real.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') document.getElementById('out').textContent = 'Searched: ' + real.value;
    });
  }, { once: true });
</script></main>`;

describe('inputs replaced on focus', () => {
  it('types into the replacement and submits it', async () => {
    const page = await open(PAGE);
    const ref = (req: DecisionRequest) =>
      /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes('searchbox "Search"')) ?? '')?.[1];
    const provider = new FakeProvider([
      (req: DecisionRequest) => ({
        tool: 'type',
        args: { ref: ref(req), text: 'Table Mountain', submit: true, intent: 'search' },
      }),
      { tool: 'done', args: { summary: 'searched', evidence: [] } },
    ]);
    const ai = new Ai({ page, provider, config: resolveConfig({ settle: { maxMs: 300, networkQuietMs: 0 } }) });
    const result = await ai.act('Search for Table Mountain');
    expect(result.actions[0]!.result).toBe('ok');
    await expect(page.locator('#out').textContent()).resolves.toBe('Searched: Table Mountain');
  });
});
