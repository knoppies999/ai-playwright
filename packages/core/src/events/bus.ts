// Typed events for reporters, logs and (later) the nudge UI. Everything emitted is redacted first.
import type { Redactor } from '../data/redactor.js';
import type { Callsite } from '../errors.js';
import type { Usage } from '../llm/provider.js';
import type { ActionRecord, StepKind } from '../types.js';

export type AipwEvent =
  | { type: 'step:start'; stepId: string; kind: StepKind | 'run'; instruction: string; callsite?: Callsite }
  | {
      type: 'decision';
      stepId: string;
      turn: number;
      tool: string;
      args: unknown;
      text?: string;
      repaired: boolean;
      usage: Usage;
      ms: number;
    }
  | { type: 'action'; stepId: string; record: ActionRecord }
  | { type: 'observation'; stepId: string; url: string; snapshot: string; snapshotHash: string }
  | { type: 'verdict'; stepId: string; pass: boolean; reason: string; evidence: string[]; usage: Usage }
  | {
      type: 'step:end';
      stepId: string;
      kind: StepKind | 'run';
      instruction: string;
      status: 'passed' | 'failed';
      ms: number;
      usage: Usage;
      error?: string;
    };

export type Listener = (event: AipwEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly redactor: Redactor) {}

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: AipwEvent): void {
    const safe = this.redactor.redactDeep(event);
    for (const l of this.listeners) {
      try {
        l(safe);
      } catch {
        // A broken listener must never break a test.
      }
    }
  }
}
