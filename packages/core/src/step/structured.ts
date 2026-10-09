// structured() with Zod validation and one repair turn (docs/03 §4).
import { z } from 'zod';
import { toJsonSchema } from '../actions/schemas.js';
import { addUsage, emptyUsage, type LlmProvider, type Usage } from '../llm/provider.js';

export class StructuredValidationError extends Error {
  constructor(
    readonly issues: string,
    readonly usage: Usage,
  ) {
    super(issues);
  }
}

export async function structuredWithRepair<T>(
  provider: LlmProvider,
  req: { system: string; prompt: string; schemaName: string; schema: z.ZodType<T> },
  signal?: AbortSignal,
): Promise<{ value: T; usage: Usage }> {
  const jsonSchema = toJsonSchema(req.schema);
  let usage = emptyUsage();
  let prompt = req.prompt;
  let issues = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await provider.structured(
      { system: req.system, prompt, schemaName: req.schemaName, jsonSchema, schema: req.schema },
      signal,
    );
    usage = addUsage(usage, res.usage);
    const parsed = req.schema.safeParse(res.value);
    if (parsed.success) return { value: parsed.data, usage };
    issues = z.prettifyError(parsed.error);
    prompt = `${req.prompt}\n\nYOUR PREVIOUS ANSWER WAS INVALID\nAnswer: ${JSON.stringify(res.value)?.slice(0, 2000)}\nProblems:\n${issues}`;
  }
  throw new StructuredValidationError(issues, usage);
}
