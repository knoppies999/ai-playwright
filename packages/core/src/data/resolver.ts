// DataResolver (docs/08 §2): {{data.x}}, {{secret.x}}, {{values.x}} and {{gen.kind({...})}}.
// Resolution happens inside the executor, right before the Playwright call, so the model and every
// emitted record only ever contain placeholders.
import type { Generators } from './generators.js';
import type { Redactor } from './redactor.js';

const PLACEHOLDER = /\{\{\s*(?:(data|secret|values)\.([A-Za-z0-9_.-]+)|gen\.([A-Za-z][A-Za-z0-9_]*)\((.*?)\))\s*\}\}/g;

export type SecretSource = (name: string) => string | undefined;

/** Reads secrets from environment variables named in config `secrets.map`. */
export function envSecrets(map: Record<string, string>, env: NodeJS.ProcessEnv = process.env): SecretSource {
  return (name) => {
    const variable = map[name];
    return variable ? env[variable] : undefined;
  };
}

/** Config `secrets.provider` may be 'env' or a function (e.g. reading Azure Key Vault). */
export type SecretProvider = 'env' | ((name: string) => string | undefined);

export function secretSource(provider: SecretProvider, map: Record<string, string>): SecretSource {
  return provider === 'env' ? envSecrets(map) : provider;
}

export interface Resolved {
  value: string;
  usesSecret: boolean;
}

export class PlaceholderError extends Error {}

export class DataResolver {
  /** Placeholder text → value, so the same {{gen.…}} gives the same value within a step. */
  private readonly generated = new Map<string, string>();

  constructor(
    private readonly data: Record<string, unknown>,
    /** Secret names this step may use. */
    private readonly secretNames: readonly string[],
    private readonly secrets: SecretSource,
    /** Values generated or extracted earlier in the test. */
    private readonly values: Record<string, unknown>,
    private readonly redactor: Redactor,
    private readonly gen?: Generators,
  ) {}

  resolve(text: string): Resolved {
    let usesSecret = false;
    const value = text.replace(
      PLACEHOLDER,
      (
        match,
        source: string | undefined,
        path: string | undefined,
        kind: string | undefined,
        rawParams: string | undefined,
      ) => {
        if (kind !== undefined) return this.generate(match, kind, rawParams ?? '');
        if (source === 'secret') {
          if (!this.secretNames.includes(path!)) {
            throw new PlaceholderError(
              `{{secret.${path}}} is not one of this step's secrets (${this.secretNames.join(', ') || 'none'}).`,
            );
          }
          const secret = this.secrets(path!);
          if (secret === undefined)
            throw new PlaceholderError(`Secret "${path}" has no value. Check secrets.map in the aipw config.`);
          this.redactor.register(secret);
          usesSecret = true;
          return secret;
        }
        const found = lookup(source === 'data' ? this.data : this.values, path!);
        if (found === undefined) throw new PlaceholderError(`{{${source}.${path}}} is not defined.`);
        return typeof found === 'string' ? found : JSON.stringify(found);
      },
    );
    return { value, usesSecret };
  }

  private generate(placeholder: string, kind: string, rawParams: string): string {
    const cached = this.generated.get(placeholder);
    if (cached !== undefined) return cached;
    if (!this.gen) throw new PlaceholderError('Generators are not available in this step.');
    let params: Record<string, unknown>;
    try {
      params = rawParams.trim() ? (JSON.parse(rawParams) as Record<string, unknown>) : {};
    } catch {
      throw new PlaceholderError(
        `${placeholder}: parameters must be a JSON object, e.g. {{gen.saId({"born":"1990-04-12"})}}.`,
      );
    }
    try {
      const value = this.gen.call(kind, params);
      this.generated.set(placeholder, value);
      return value;
    } catch (error) {
      throw new PlaceholderError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Calls a generator for the generate_value tool and stores the result under `as`, if given. */
  generateValue(kind: string, params: Record<string, unknown>, as?: string | null): string {
    if (!this.gen) throw new PlaceholderError('Generators are not available in this step.');
    try {
      const value = this.gen.call(kind, params);
      if (as) this.values[as] = value;
      return value;
    } catch (error) {
      throw new PlaceholderError(error instanceof Error ? error.message : String(error));
    }
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
