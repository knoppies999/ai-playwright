// Step keys (docs/06 §3): stable across runs and data values, different for different steps.
import { createHash } from 'node:crypto';

export interface StepKeyInput {
  kind: string;
  instruction: string;
  dataKeys: string[];
  secretNames: string[];
  /** locator.toString() of the scope, plus the active test-id attribute (spike 0.6). */
  scopeDescriptor?: string;
  /** nth call with the same kind + instruction in the same test. */
  ordinal: number;
  /** options.key pins the key, so instruction edits don't orphan the plan. */
  pinned?: string;
}

export const normaliseInstruction = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

export function stepKey(input: StepKeyInput): string {
  const parts = input.pinned
    ? ['pinned', input.pinned, String(input.ordinal)]
    : [
        input.kind,
        normaliseInstruction(input.instruction),
        [...input.dataKeys].sort().join(','),
        [...input.secretNames].sort().join(','),
        input.scopeDescriptor ?? '',
        String(input.ordinal),
      ];
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

/** Counts calls per kind + instruction within one test, to derive ordinals. */
export class OrdinalCounter {
  private readonly counts = new Map<string, number>();

  /** The ordinal the next call would get, without counting it. */
  peek(kind: string, instruction: string, pinned?: string): number {
    return this.counts.get(pinned ? `pinned:${pinned}` : `${kind}:${normaliseInstruction(instruction)}`) ?? 0;
  }

  next(kind: string, instruction: string, pinned?: string): number {
    const base = pinned ? `pinned:${pinned}` : `${kind}:${normaliseInstruction(instruction)}`;
    const n = this.counts.get(base) ?? 0;
    this.counts.set(base, n + 1);
    return n;
  }
}
