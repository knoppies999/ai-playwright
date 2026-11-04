// A widget that loads its code on first use appears after the page already looked settled (Wikipedia's language
// menu). The next decision must see it, instead of an unchanged page that invites the same click again.
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { Ai } from '../src/step/ai.js';
import { useBrowser } from './browser.js';

const { page: open } = useBrowser();

const PAGE = `<main><button id="menu">Languages</button><div id="panel"></div>
<script>
  document.getElementById('menu').addEventListener('click', () =>
    setTimeout(() => (document.getElementById('panel').innerHTML = '<a href="#af">Afrikaans</a>'), 800));
</script></main>`;

describe('late widgets', () => {
  it('waits for a late change before the next decision', async () => {
    const page = await open(PAGE);
    const ref = (text: string, req: DecisionRequest) =>
      /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')?.[1];
    const provider = new FakeProvider([
      (req: DecisionRequest) => ({
        tool: 'click',
        args: { ref: ref('button "Languages"', req), button: null, modifiers: null, clickCount: null, intent: 'open' },
      }),
      (req: DecisionRequest) =>
        req.observation.includes('Afrikaans')
          ? { tool: 'done', args: { summary: 'menu open', evidence: ['Afrikaans'] } }
          : { tool: 'fail', args: { kind: 'not_found', reason: 'the menu did not open' } },
    ]);
    const ai = new Ai({
      page,
      provider,
      config: resolveConfig({ settle: { maxMs: 1500, networkQuietMs: 50, snapshotIntervalMs: 100 } }),
    });
    await expect(ai.act('Open the languages menu')).resolves.toMatchObject({ summary: 'menu open' });
  });
});
