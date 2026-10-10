// The recorded fixture request for provider contract tests (docs/10 Phase 3): the same decision and structured
// request go through every adapter, and each adapter's wire payload is snapshot-tested. No network.
import { z } from 'zod';
import { actTools, toJsonSchema, toolSpecs } from '../actions/schemas.js';
import type { DecisionRequest, StructuredRequest } from './provider.js';

/** A 1×1 PNG. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

export function contractDecisionRequest(options: { image?: boolean } = {}): DecisionRequest {
  return {
    system: 'You operate a web browser to complete one test step. Call exactly one tool.',
    tools: toolSpecs(actTools({ allowNavigation: false })).filter((t) =>
      ['click', 'fill', 'done', 'fail'].includes(t.name),
    ),
    context:
      'TASK\nkind: act\ninstruction: Save the profile\nDATA: none\n\nHISTORY (actions already taken in this step)\n(none)',
    observation:
      'URL: http://localhost:5173/app\nTITLE: Demo\n\n- region "Profile" [ref=e5]:\n  - button "Save" [ref=e7]',
    ...(options.image && { images: [{ mediaType: 'image/png' as const, data: PIXEL }] }),
  };
}

const VerdictSchema = z.strictObject({
  pass: z.boolean(),
  reason: z.string(),
});

export function contractStructuredRequest(): StructuredRequest<z.infer<typeof VerdictSchema>> {
  return {
    system: 'You judge whether a condition holds on a web page.',
    prompt: 'CONDITION: The status says "Profile saved"\n\nPAGE\n- status: Profile saved',
    schemaName: 'verdict',
    jsonSchema: toJsonSchema(VerdictSchema),
    schema: VerdictSchema,
  };
}
