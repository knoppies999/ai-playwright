// The Redactor (docs/08 §4 rule 1): every string the framework emits passes through it. Resolved
// secret values are registered here and scrubbed, along with their URL-encoded forms.

export const REDACTED = '[REDACTED]';

export class Redactor {
  private readonly values = new Set<string>();

  register(value: string): void {
    if (value.length === 0) return;
    this.values.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) this.values.add(encoded);
  }

  /** Registered values, longest first. */
  get secrets(): string[] {
    return [...this.values].sort((a, b) => b.length - a.length || a.localeCompare(b));
  }

  redact(text: string): string {
    let out = text;
    for (const v of this.secrets) out = out.split(v).join(REDACTED);
    return out;
  }

  /** Redacts every string inside a JSON-like value. */
  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactDeep(v)])) as T;
    }
    return value;
  }
}
