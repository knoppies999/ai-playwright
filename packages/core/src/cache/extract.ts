// Deterministic extract replay (docs/06 §5): rebuild the value from the elements it was read from, by JSON
// path, converting each leaf's text to the type its schema wants. No model call.
import type { z } from 'zod';

type Def = {
  type?: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  entries?: Record<string, string>;
};
const defOf = (schema: z.ZodType): Def => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Unwraps optional/nullable/default wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (let i = 0; i < 5; i++) {
    const def = defOf(s);
    if (['optional', 'nullable', 'default', 'readonly'].includes(def.type ?? '') && def.innerType) s = def.innerType;
    else break;
  }
  return s;
}

/** The schema at a JSON path: "0.name" → array element → object field "name". */
export function schemaAt(schema: z.ZodType, path: string): z.ZodType | undefined {
  let s: z.ZodType | undefined = unwrap(schema);
  for (const seg of path === '' ? [] : path.split('.')) {
    if (!s) return undefined;
    const def = defOf(s);
    if (def.type === 'array') s = def.element && unwrap(def.element);
    else if (def.type === 'object') s = def.shape?.[seg] && unwrap(def.shape[seg]);
    else return undefined;
  }
  return s;
}

/** Converts element text to a leaf value: "$29.99" → 29.99 for numbers, the trimmed text for strings. */
export function coerceLeaf(schema: z.ZodType, text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.replace(/\s+/g, ' ').trim();
  const def = defOf(unwrap(schema));
  switch (def.type) {
    case 'number': {
      const m = /-?\d+(?:\.\d+)?/.exec(t.replace(/(\d),(?=\d{3}\b)/g, '$1'));
      return m ? { ok: true, value: Number(m[0]) } : { ok: false };
    }
    case 'string':
      return { ok: true, value: t };
    case 'boolean':
      if (/^(true|yes|on|checked)$/i.test(t)) return { ok: true, value: true };
      if (/^(false|no|off|unchecked)$/i.test(t)) return { ok: true, value: false };
      return { ok: false };
    case 'enum': {
      const options = Object.values(def.entries ?? {});
      const hit =
        options.find((o) => o.toLowerCase() === t.toLowerCase()) ??
        options.find((o) => t.toLowerCase().includes(o.toLowerCase()));
      return hit !== undefined ? { ok: true, value: hit } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

/** Builds the value from path → text pairs. Returns undefined if any leaf can't be converted. */
export function rebuildValue(
  schema: z.ZodType,
  leaves: { path: string; text: string }[],
): { ok: true; value: unknown } | { ok: false } {
  if (leaves.length === 1 && leaves[0]!.path === '') return coerceLeaf(schema, leaves[0]!.text);
  const root: unknown = defOf(unwrap(schema)).type === 'array' ? [] : {};
  for (const { path, text } of leaves) {
    const leafSchema = schemaAt(schema, path);
    if (!leafSchema) return { ok: false };
    const leaf = coerceLeaf(leafSchema, text);
    if (!leaf.ok) return { ok: false };
    const segs = path.split('.');
    let cur = root as Record<string, unknown>;
    segs.forEach((seg, i) => {
      if (i === segs.length - 1) cur[seg] = leaf.value;
      else cur = (cur[seg] ??= /^\d+$/.test(segs[i + 1]!) ? [] : {}) as Record<string, unknown>;
    });
  }
  return { ok: true, value: root };
}
