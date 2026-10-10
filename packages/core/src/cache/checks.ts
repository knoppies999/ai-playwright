// Compiled checks for cached assertions (docs/06 §5): deterministic Playwright checks the model proposed
// when it first judged the assertion true. Replay runs them with no AI. Core can't depend on
// @playwright/test's expect, so the web-first behaviour (poll until the timeout) is implemented here.
import type { Page } from 'playwright-core';
import type { CompiledCheck } from './plan.js';
import { resolveTarget } from './replay.js';

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

async function evaluateOnce(page: Page, check: CompiledCheck): Promise<boolean> {
  const [arg] = check.args;
  if (check.expect === 'toHaveURL') return page.url().includes(String(arg));
  if (!check.target) return false;
  if (check.expect === 'toHaveCount') {
    // Count all matches of the first stored locator, not just a unique one.
    const { buildLocator } = await import('../locators/expr.js');
    const loc = buildLocator(page, check.target.locators[0]!.expr);
    return (await loc.count()) === Number(arg);
  }
  let loc;
  try {
    loc = await resolveTarget(page, check.target, 0);
  } catch {
    return check.expect === 'toBeHidden';
  }
  switch (check.expect) {
    case 'toBeVisible':
      return loc.isVisible();
    case 'toBeHidden':
      return loc.isHidden();
    // ai.assert is about what the page shows, so text checks also require the element to be visible
    // (Playwright's toContainText alone would pass on hidden text).
    case 'toContainText':
      return (await loc.isVisible()) && norm(await loc.innerText()).includes(norm(String(arg)));
    case 'toHaveText':
      return (await loc.isVisible()) && norm(await loc.innerText()) === norm(String(arg));
    case 'toHaveValue':
      return (await loc.inputValue()) === String(arg);
  }
}

/** Polls until the check holds (or, with `not`, stops holding) or the timeout passes. */
export async function runCompiledCheck(page: Page, check: CompiledCheck, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok: boolean;
    try {
      ok = (await evaluateOnce(page, check)) !== Boolean(check.not);
    } catch {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function describeCheck(check: CompiledCheck): string {
  const target = check.target?.locators[0]?.display ?? 'page';
  return `expect(${target})${check.not ? '.not' : ''}.${check.expect}(${check.args.map((a) => JSON.stringify(a)).join(', ')})`;
}
