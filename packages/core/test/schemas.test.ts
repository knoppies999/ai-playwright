import { describe, expect, it } from 'vitest';
import { actTools, TOOL_SCHEMAS, toolSpecs, validateCall, type ToolName } from '../src/actions/schemas.js';

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: unknown;
  items?: Schema;
  anyOf?: Schema[];
};

/** docs/05 §2.1: every object closed, every property required, no top-level oneOf. */
function checkStrict(schema: Schema, path: string): string[] {
  const problems: string[] = [];
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const keys = Object.keys(schema.properties ?? {});
    const missing = keys.filter((k) => !(schema.required ?? []).includes(k));
    if (missing.length) problems.push(`${path}: not required: ${missing.join(', ')}`);
    for (const k of keys) problems.push(...checkStrict(schema.properties![k]!, `${path}.${k}`));
  }
  if (schema.items) problems.push(...checkStrict(schema.items, `${path}[]`));
  for (const [i, s] of (schema.anyOf ?? []).entries()) problems.push(...checkStrict(s, `${path}|${i}`));
  return problems;
}

describe('tool schemas', () => {
  it.each(Object.keys(TOOL_SCHEMAS))('%s follows the cross-provider strict rules', (name) => {
    const [spec] = toolSpecs([name as ToolName]);
    expect(spec!.jsonSchema).not.toHaveProperty('$schema');
    expect(spec!.jsonSchema).not.toHaveProperty('oneOf');
    expect(checkStrict(spec!.jsonSchema as Schema, name)).toEqual([]);
  });

  it('offers navigate only when allowed', () => {
    expect(actTools({ allowNavigation: false })).not.toContain('navigate');
    expect(actTools({ allowNavigation: true })).toContain('navigate');
  });
});

describe('validateCall', () => {
  const offered = actTools({ allowNavigation: false });

  it('accepts a valid call', () => {
    expect(validateCall({ tool: 'hover', args: { ref: 'e7', intent: 'open menu' } }, offered)).toEqual({
      ok: true,
      call: { tool: 'hover', args: { ref: 'e7', intent: 'open menu' } },
    });
  });

  it('rejects unknown and non-offered tools', () => {
    expect(validateCall({ tool: 'shell', args: {} }, offered)).toMatchObject({ ok: false });
    expect(validateCall({ tool: 'navigate', args: { url: 'https://x.test', intent: 'go' } }, offered)).toMatchObject({
      ok: false,
    });
  });

  it('explains invalid arguments', () => {
    const result = validateCall({ tool: 'click', args: { ref: 'e1' } }, offered);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/Invalid arguments for click/);
  });
});
