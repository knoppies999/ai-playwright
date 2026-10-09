// DataResolver (docs/08 §2), Phase 2 subset: {{data.x}}, {{secret.x}} and {{values.x}}.
// Generators ({{gen.…}}) arrive in Phase 5. Resolution happens inside the executor, right before
// the Playwright call, so the model and every emitted record only ever contain placeholders.
import type { Redactor } from './redactor.js';

const PLACEHOLDER = /\{\{\s*(data|secret|values)\.([A-Za-z0-9_.-]+)\s*\}\}/g;

export type SecretSource = (name: string) => string | undefined;

/** Reads secrets from environment variables named in config `secrets.map`. */
export function envSecrets(map: Record<string, string>, env: NodeJS.ProcessEnv = process.env): SecretSource {
  return (name) => {
    const variable = map[name];
    return variable ? env[variable] : undefined;
  };
}

export interface Resolved {
  value: string;
  usesSecret: boolean;
}

export class PlaceholderError extends Error {}

export class DataResolver {
  constructor(
    private readonly data: Record<string, unknown>,
    /** Secret names this step may use. */
    private readonly secretNames: readonly string[],
    private readonly secrets: SecretSource,
    /** Values generated or extracted earlier in the test. */
    private readonly values: Record<string, unknown>,
    private readonly redactor: Redactor,
  ) {}

  resolve(text: string): Resolved {
    let usesSecret = false;
    const value = text.replace(PLACEHOLDER, (_match, source: string, path: string) => {
      if (source === 'secret') {
        if (!this.secretNames.includes(path)) {
          throw new PlaceholderError(
            `{{secret.${path}}} is not one of this step's secrets (${this.secretNames.join(', ') || 'none'}).`,
          );
        }
        const secret = this.secrets(path);
        if (secret === undefined)
          throw new PlaceholderError(`Secret "${path}" has no value. Check secrets.map in the aipw config.`);
        this.redactor.register(secret);
        usesSecret = true;
        return secret;
      }
      const found = lookup(source === 'data' ? this.data : this.values, path);
      if (found === undefined) throw new PlaceholderError(`{{${source}.${path}}} is not defined.`);
      return typeof found === 'string' ? found : JSON.stringify(found);
    });
    return { value, usesSecret };
  }

  /** Placeholder names the model may use, for the prompt. */
  get secretPlaceholders(): string[] {
    return this.secretNames.map((n) => `{{secret.${n}}}`);
  }
}

function lookup(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (cur, key) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined),
      obj,
    );
}
