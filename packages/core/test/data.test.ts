import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { MemoryPlanStore } from '../src/cache/store.js';
import { resolveConfig } from '../src/config.js';
import { createGenerators, isValidSaId } from '../src/data/generators.js';
import { Redactor } from '../src/data/redactor.js';
import { DataResolver, PlaceholderError } from '../src/data/resolver.js';
import { FakeProvider } from '../src/llm/fake-provider.js';
import type { DecisionRequest } from '../src/llm/provider.js';
import { Ai } from '../src/step/ai.js';
import { useBrowser } from './browser.js';

const { page: open } = useBrowser();

describe('DataResolver generators', () => {
  const resolver = () => new DataResolver({}, [], () => undefined, {}, new Redactor(), createGenerators({ seed: 'r' }));

  it('resolves {{gen.kind(params)}} and reuses the value within a step', () => {
    const r = resolver();
    const a = r.resolve('{{gen.saId({"born":"1990-04-12"})}}').value;
    expect(isValidSaId(a)).toBe(true);
    expect(a.startsWith('900412')).toBe(true);
    expect(r.resolve('ID: {{gen.saId({"born":"1990-04-12"})}}').value).toBe(`ID: ${a}`);
    expect(r.resolve('{{gen.email()}}').value).toMatch(/^aipw\+/);
  });

  it('explains bad parameters and unknown generators', () => {
    expect(() => resolver().resolve('{{gen.saId(born=1990)}}')).toThrow(PlaceholderError);
    expect(() => resolver().resolve('{{gen.nope()}}')).toThrow(/Unknown generator/);
  });
});

const FORM = `<form aria-label="New user">
  <label>ID number <input name="idNumber" data-testid="id-number"></label>
  <button type="button" data-testid="save" onclick="document.body.dataset.saved = document.querySelector('[name=idNumber]').value">Save</button>
</form>`;

async function openForm(): Promise<Page> {
  const page = await open('');
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: FORM }));
  await page.goto('http://app.test/');
  return page;
}

const refOf = (text: string, req: DecisionRequest) =>
  /\[ref=([^\]]+)\]/.exec(req.observation.split('\n').find((l) => l.includes(text)) ?? '')![1];

describe('generate_value', () => {
  it('gives the model a valid value, and the plan replays with a fresh one', async () => {
    const store = new MemoryPlanStore();
    const config = resolveConfig({ settle: { maxMs: 500, networkQuietMs: 50, snapshotIntervalMs: 50 } });
    const provider = new FakeProvider([
      {
        tool: 'generate_value',
        args: { kind: 'saId', params: '{"born":"1990-04-12"}', as: 'idNumber', intent: 'valid ID' },
      },
      (req) => {
        const generated = /ok: (\d{13})/.exec(req.context)![1];
        return { tool: 'fill', args: { ref: refOf('textbox "ID number"', req), value: generated, intent: 'fill ID' } };
      },
      (req) => ({
        tool: 'click',
        args: { ref: refOf('button "Save"', req), button: null, modifiers: null, clickCount: null, intent: 'save' },
      }),
      { tool: 'done', args: { summary: 'saved', evidence: [] } },
    ]);
    const page = await openForm();
    const first = new Ai({
      page,
      provider,
      config,
      cache: { store, testTitle: 't' },
      gen: createGenerators({ seed: 'run-1' }),
    });
    await first.act('Create a user with a valid SA ID number born on 1990-04-12');
    const firstId = await page.locator('body').getAttribute('data-saved');
    expect(isValidSaId(firstId!)).toBe(true);
    expect(first.values.idNumber).toBe(firstId);

    const plan = Object.values(store.file.tests.t!)[0]!;
    expect(plan.actions!.find((a) => a.tool === 'fill')!.args.value).toBe('{{values.idNumber}}');
    expect(JSON.stringify(plan)).not.toContain(firstId!);

    // Replay with another run's seed: no AI, a new valid ID for the same birth date.
    const page2 = await openForm();
    const second = new Ai({
      page: page2,
      provider: new FakeProvider(),
      config,
      cache: { store, testTitle: 't' },
      gen: createGenerators({ seed: 'run-2' }),
    });
    const result = await second.act('Create a user with a valid SA ID number born on 1990-04-12');
    expect(result.source).toBe('cache');
    const secondId = await page2.locator('body').getAttribute('data-saved');
    expect(isValidSaId(secondId!)).toBe(true);
    expect(secondId!.startsWith('900412')).toBe(true);
    expect(secondId).not.toBe(firstId);
  });
});
