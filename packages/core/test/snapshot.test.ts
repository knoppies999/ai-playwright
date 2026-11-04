import { describe, expect, it } from 'vitest';
import {
  expandRef,
  findByRef,
  maskSnapshot,
  parseSnapshot,
  pruneSnapshot,
  refsIn,
  renderSnapshot,
} from '../src/observe/snapshot.js';
import { expectGolden, fixture } from './golden.js';

const SNAPSHOTS = ['saucedemo-inventory', 'saucedemo-menu-animating', 'saucedemo-checkout-info', 'iframes'];

describe('parseSnapshot / renderSnapshot', () => {
  it.each(SNAPSHOTS)('round-trips %s byte for byte', (name) => {
    const yaml = fixture('snapshots', `${name}.yaml`);
    expect(renderSnapshot(parseSnapshot(yaml))).toBe(yaml.trimEnd());
  });

  it('parses names with escaped quotes, attributes and values', () => {
    const [node] = parseSnapshot('- button "Say \\"hi\\"" [ref=e5] [cursor=pointer]: label text');
    expect(node).toMatchObject({
      role: 'button',
      name: 'Say "hi"',
      ref: 'e5',
      attrs: ['ref=e5', 'cursor=pointer'],
      value: 'label text',
    });
  });

  it("unwraps items YAML single-quoted because their text has ': '", () => {
    const [node] = parseSnapshot(
      `- 'link "Slip Joint Pliers CO₂: A B C D E $9.17 O''Brien" [ref=e123] [cursor=pointer]':`,
    );
    expect(node).toMatchObject({
      role: 'link',
      name: "Slip Joint Pliers CO₂: A B C D E $9.17 O'Brien",
      ref: 'e123',
      colon: true,
    });
  });

  it('finds a node and its ancestors by ref', () => {
    const nodes = parseSnapshot(fixture('snapshots', 'saucedemo-inventory.yaml'));
    const found = findByRef(nodes, 'e47');
    expect(found?.node).toMatchObject({ role: 'button', name: 'Add to cart' });
    expect(found?.ancestors.map((a) => a.ref)).toContain('e32');
  });
});

describe('maskSnapshot', () => {
  it('masks exact credential values and scrubs secrets everywhere', () => {
    const nodes = parseSnapshot(
      [
        '- textbox "Password" [ref=e13]: hunter2!',
        '- text: your code is hunter2! ok',
        '- textbox "Pin" [ref=e14]: 12',
      ].join('\n'),
    );
    expect(renderSnapshot(maskSnapshot(nodes, ['hunter2!', '12']))).toBe(
      ['- textbox "Password" [ref=e13]: ••••', '- text: your code is •••• ok', '- textbox "Pin" [ref=e14]: ••••'].join(
        '\n',
      ),
    );
  });

  it('does not scrub short values inside other text', () => {
    const nodes = parseSnapshot('- text: 12 items');
    expect(renderSnapshot(maskSnapshot(nodes, ['12']))).toBe('- text: 12 items');
  });
});

describe('pruneSnapshot', () => {
  it.each(SNAPSHOTS)('prunes %s (golden)', (name) => {
    const pruned = pruneSnapshot(parseSnapshot(fixture('snapshots', `${name}.yaml`)));
    expectGolden(`prune-${name}.yaml`, pruned.text);
    expect(pruned.refs).toEqual(refsIn(pruned.text));
  });

  it('is deterministic', () => {
    const yaml = fixture('snapshots', 'saucedemo-inventory.yaml');
    expect(pruneSnapshot(parseSnapshot(yaml)).text).toBe(pruneSnapshot(parseSnapshot(yaml)).text);
  });

  it('collapses the closed SauceDemo menu into one line without refs', () => {
    const { text, refs } = pruneSnapshot(parseSnapshot(fixture('snapshots', 'saucedemo-inventory.yaml')));
    expect(text).toContain('- hidden: contains button "All Items"');
    expect(refs).not.toContain('e17'); // "Logout" inside the hidden menu
  });

  it('collapses long sibling runs', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `  - row "User ${i}" [ref=e${i + 10}]`).join('\n');
    const { text } = pruneSnapshot(parseSnapshot(`- table [ref=e1]:\n${rows}`));
    expect(text).toContain('row "User 9"');
    expect(text).not.toContain('row "User 10"');
    expect(text).toContain('28 more row items');
    expect(text).toContain('row "User 39"');
  });

  it('keeps a dialog and summarises the page behind it', () => {
    const yaml = [
      '- main [ref=e1]:',
      '  - button "Behind" [ref=e2]',
      '- dialog "New user" [ref=e3]:',
      '  - button "Save" [ref=e4]',
    ].join('\n');
    const { text, refs } = pruneSnapshot(parseSnapshot(yaml));
    expect(refs).toEqual(['e3', 'e4']);
    expect(text).toContain('page behind the dialog');
  });

  it('respects the token budget by truncating depth and pointing at expand', () => {
    const deep = Array.from({ length: 200 }, (_, i) =>
      [
        `- region "Section ${i}" [ref=s${i}]:`,
        `  - list [ref=l${i}]:`,
        `    - listitem [ref=i${i}]: ${'x'.repeat(40)}`,
      ].join('\n'),
    ).join('\n');
    const pruned = pruneSnapshot(parseSnapshot(deep), { maxTokens: 2000, collapseSiblingsOver: 1000 });
    expect(pruned.truncated).toBe(true);
    expect(pruned.text.length / 4).toBeLessThanOrEqual(2000);
    expect(pruned.text).toMatch(/call expand with ref=|more lines not shown/);
  });

  it('expands a truncated subtree on request', () => {
    const nodes = parseSnapshot(fixture('snapshots', 'saucedemo-inventory.yaml'));
    const expanded = expandRef(nodes, 'e36', 6000);
    expect(expanded?.text).toContain('Sauce Labs Backpack');
    expect(expanded?.refs).toContain('e47');
  });

  it('expands a long table to its first rows in full when every row would only fit with cells cut', () => {
    const cells = (r: number) =>
      Array.from(
        { length: 8 },
        (_, c) => `      - cell "Row ${r} column ${c} with a fairly long text value" [ref=c${r}x${c}]`,
      );
    const rows = Array.from({ length: 100 }, (_, r) => [`    - row [ref=r${r}]:`, ...cells(r)].join('\n'));
    const nodes = parseSnapshot(`- table [ref=t1]:\n  - rowgroup [ref=g1]:\n${rows.join('\n')}`);
    const expanded = expandRef(nodes, 'g1', 2500)!;
    expect(expanded.text).toContain('Row 2 column 7');
    expect(expanded.text).toMatch(/more row items \(call expand with ref=g1/);
  });
});
