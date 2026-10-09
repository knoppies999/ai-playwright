// Serialisable locator expressions and their interpreter (AGENTS.md rule 4: stored locators are
// interpreted step by step through a whitelist, never evaluated as code).
import type { Frame, FrameLocator, Locator, Page } from 'playwright-core';
import { z } from 'zod';

const exact = z.boolean().optional();

export const LocatorStepSchema = z.discriminatedUnion('m', [
  z.strictObject({ m: z.literal('locator'), selector: z.string() }),
  z.strictObject({ m: z.literal('getByTestId'), id: z.string() }),
  z.strictObject({ m: z.literal('getByRole'), role: z.string(), name: z.string().optional(), exact }),
  z.strictObject({ m: z.literal('getByLabel'), text: z.string(), exact }),
  z.strictObject({ m: z.literal('getByPlaceholder'), text: z.string(), exact }),
  z.strictObject({ m: z.literal('getByText'), text: z.string(), exact }),
  z.strictObject({ m: z.literal('getByAltText'), text: z.string(), exact }),
  z.strictObject({ m: z.literal('getByTitle'), text: z.string(), exact }),
  z.strictObject({ m: z.literal('filter'), hasText: z.string() }),
  z.strictObject({ m: z.literal('nth'), index: z.number().int() }),
  z.strictObject({ m: z.literal('contentFrame') }),
]);

export type LocatorStep = z.infer<typeof LocatorStepSchema>;
export const LocatorExprSchema = z.array(LocatorStepSchema).min(1);
export type LocatorExpr = LocatorStep[];

type Root = Page | Frame | Locator | FrameLocator;

const isLocator = (x: Root): x is Locator => 'filter' in x && 'nth' in x && 'evaluate' in x;

/** Builds a Playwright Locator from an expression. Throws on a malformed expression. */
export function buildLocator(root: Page | Frame, expr: LocatorExpr): Locator {
  const steps = LocatorExprSchema.parse(expr);
  let cur: Root = root;
  for (const s of steps) {
    switch (s.m) {
      case 'locator':
        cur = cur.locator(s.selector);
        break;
      case 'getByTestId':
        cur = cur.getByTestId(s.id);
        break;
      case 'getByRole':
        cur = cur.getByRole(s.role as Parameters<Page['getByRole']>[0], {
          ...(s.name !== undefined && { name: s.name }),
          ...(s.exact !== undefined && { exact: s.exact }),
        });
        break;
      case 'getByLabel':
        cur = cur.getByLabel(s.text, { exact: s.exact });
        break;
      case 'getByPlaceholder':
        cur = cur.getByPlaceholder(s.text, { exact: s.exact });
        break;
      case 'getByText':
        cur = cur.getByText(s.text, { exact: s.exact });
        break;
      case 'getByAltText':
        cur = cur.getByAltText(s.text, { exact: s.exact });
        break;
      case 'getByTitle':
        cur = cur.getByTitle(s.text, { exact: s.exact });
        break;
      case 'filter':
        if (!isLocator(cur)) throw new Error('filter must follow a locator');
        cur = cur.filter({ hasText: s.hasText });
        break;
      case 'nth':
        if (!isLocator(cur)) throw new Error('nth must follow a locator');
        cur = cur.nth(s.index);
        break;
      case 'contentFrame':
        if (!isLocator(cur)) throw new Error('contentFrame must follow a locator');
        cur = cur.contentFrame();
        break;
    }
  }
  if (!isLocator(cur)) throw new Error('A locator expression must end with an element locator');
  return cur;
}

/** Readable form, e.g. `getByRole('button', { name: 'Save', exact: true })`. */
export function describeLocator(root: Page | Frame, expr: LocatorExpr): string {
  return buildLocator(root, expr).toString();
}
