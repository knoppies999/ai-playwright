import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceLeaf, rebuildValue, schemaAt } from '../src/cache/extract.js';

describe('extract replay helpers', () => {
  it('coerces leaf text by schema type', () => {
    expect(coerceLeaf(z.number(), '$29.99')).toEqual({ ok: true, value: 29.99 });
    expect(coerceLeaf(z.number(), 'Total: R 1,234.50')).toEqual({ ok: true, value: 1234.5 });
    expect(coerceLeaf(z.string(), '  Sauce Labs\n Backpack ')).toEqual({ ok: true, value: 'Sauce Labs Backpack' });
    expect(coerceLeaf(z.enum(['Active', 'Disabled']), 'Status: active')).toEqual({ ok: true, value: 'Active' });
    expect(coerceLeaf(z.number(), 'none')).toEqual({ ok: false });
    expect(coerceLeaf(z.number().nullable(), '7')).toEqual({ ok: true, value: 7 });
  });

  it('finds the schema at a JSON path', () => {
    const schema = z.array(z.object({ name: z.string(), quantity: z.number() }));
    expect(schemaAt(schema, '1.quantity')).toBeDefined();
    expect(schemaAt(schema, '1.price')).toBeUndefined();
  });

  it('rebuilds arrays and objects from leaves', () => {
    expect(
      rebuildValue(z.array(z.number()), [
        { path: '0', text: '$7.99' },
        { path: '1', text: '$9.99' },
      ]),
    ).toEqual({ ok: true, value: [7.99, 9.99] });
    const cart = z.array(z.object({ name: z.string(), quantity: z.number() }));
    expect(
      rebuildValue(cart, [
        { path: '0.name', text: 'Backpack' },
        { path: '0.quantity', text: '1' },
        { path: '1.name', text: 'Bike Light' },
        { path: '1.quantity', text: '2' },
      ]),
    ).toEqual({
      ok: true,
      value: [
        { name: 'Backpack', quantity: 1 },
        { name: 'Bike Light', quantity: 2 },
      ],
    });
    expect(rebuildValue(z.object({ total: z.number() }), [{ path: 'total', text: 'Total: $49.66' }])).toEqual({
      ok: true,
      value: { total: 49.66 },
    });
    expect(rebuildValue(z.number(), [{ path: '', text: '42 items' }])).toEqual({ ok: true, value: 42 });
  });
});
