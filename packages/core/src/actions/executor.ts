// ActionExecutor (docs/02 §3): resolves refs, substitutes placeholders, performs the Playwright call
// and waits for the page to settle. It never throws for page problems: errors become the action's
// result string, which the model sees on its next turn.
import type { Locator } from 'playwright-core';
import { PlaceholderError, type DataResolver } from '../data/resolver.js';
import { expandRef, findByRef } from '../observe/snapshot.js';
import type { Observation } from '../observe/observer.js';
import { synthesizeLocators, type SynthOptions } from '../locators/synth.js';
import type { StepSession } from '../step/session.js';
import type { ActionRecord, TargetDescriptor } from '../types.js';
import type { ToolCall } from './schemas.js';

export interface ExecutorOptions {
  data: DataResolver;
  synth: Omit<SynthOptions, 'role' | 'name'>;
  actionTimeoutMs: number;
  settle: { maxMs: number; networkQuietMs: number };
  expandMaxTokens: number;
  allowSecretsAnywhere: boolean;
  isAllowedUrl: (url: string) => boolean;
}

class ActionError extends Error {}

/** Playwright errors carry long call logs; the model needs the first line and a little context. */
export function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const [first, ...rest] = text.split('\n');
  const log = rest.filter((l) => l.trim().startsWith('-')).slice(0, 3);
  return [first, ...log].join('\n').slice(0, 600);
}

export class ActionExecutor {
  constructor(
    private readonly session: StepSession,
    private readonly opts: ExecutorOptions,
  ) {}

  private get page() {
    return this.session.page;
  }

  /** Resolves a ref seen by the model to a live, unique element. */
  private async resolve(ref: string, obs: Observation): Promise<Locator> {
    if (!obs.refs.has(ref))
      throw new ActionError(`Ref ${ref} is not in the current snapshot. Use a ref from the latest snapshot.`);
    const loc = this.page.locator(`aria-ref=${ref}`);
    const count = await loc.count().catch(() => 0);
    // A ref belongs to an element; if the element is gone, acting on it would wait for the full timeout (spike 0.1).
    if (count !== 1)
      throw new ActionError(`The element for ref ${ref} is gone (the page changed). Look at the new snapshot.`);
    return loc;
  }

  private async describe(ref: string, loc: Locator, obs: Observation): Promise<TargetDescriptor> {
    const node = findByRef(obs.tree, ref)?.node;
    const role = node?.role;
    const name = node?.name;
    const candidates = await synthesizeLocators(this.page, loc, { ...this.opts.synth, role, name }).catch(() => []);
    return { ref, role, name, candidates };
  }

  private resolveValue(text: string): { value: string; usesSecret: boolean } {
    try {
      return this.opts.data.resolve(text);
    } catch (error) {
      if (error instanceof PlaceholderError) throw new ActionError(error.message);
      throw error;
    }
  }

  /** docs/08 §4 rule 4: secrets only go into credential fields, so an injected page can't harvest them. */
  private async guardSecret(loc: Locator, usesSecret: boolean): Promise<void> {
    if (!usesSecret || this.opts.allowSecretsAnywhere) return;
    const ok = await loc.evaluate((el) => {
      const input = el as HTMLInputElement;
      return input.type === 'password' || /password|one-time-code/i.test(input.autocomplete ?? '');
    });
    if (!ok) throw new ActionError('Secrets can only be entered into password or one-time-code fields.');
  }

  async execute(call: ToolCall, obs: Observation): Promise<ActionRecord> {
    const started = Date.now();
    const before = { url: this.page.url(), snapshotHash: obs.snapshotHash };
    const record: ActionRecord = {
      tool: call.tool,
      args: call.args as Record<string, unknown>,
      intent: 'intent' in call.args ? call.args.intent : undefined,
      result: 'ok',
      before,
      after: { url: before.url },
      durationMs: 0,
    };
    try {
      // A native dialog blocks the page, so the Playwright call that opened it would wait for its whole
      // timeout. Whichever comes first wins; the call finishes in the background once the dialog is handled.
      const page = this.page;
      let onDialog: (() => void) | undefined;
      const dialogOpened = new Promise<'dialog'>((resolve) => {
        onDialog = () => resolve('dialog');
        page.once('dialog', onDialog);
      });
      const action = this.perform(call, obs, record);
      action.catch(() => undefined);
      const winner = await Promise.race([action.then(() => 'done' as const), dialogOpened]).finally(() => {
        page.off('dialog', onDialog!);
      });
      if (winner === 'dialog') record.output = 'A native dialog opened.';
      else await this.settle(before.url);
    } catch (error) {
      record.result = error instanceof ActionError ? error.message : `Error: ${shortError(error)}`;
    }
    record.after = { url: this.page.url() };
    record.durationMs = Date.now() - started;
    return record;
  }

  private async perform(call: ToolCall, obs: Observation, record: ActionRecord): Promise<void> {
    const timeout = this.opts.actionTimeoutMs;
    switch (call.tool) {
      case 'click': {
        const loc = await this.resolve(call.args.ref, obs);
        record.target = await this.describe(call.args.ref, loc, obs);
        await loc.click({
          timeout,
          ...(call.args.button && { button: call.args.button }),
          ...(call.args.modifiers && { modifiers: call.args.modifiers }),
          ...(call.args.clickCount && { clickCount: call.args.clickCount }),
        });
        break;
      }
      case 'hover': {
        const loc = await this.resolve(call.args.ref, obs);
        record.target = await this.describe(call.args.ref, loc, obs);
        await loc.hover({ timeout });
        break;
      }
      case 'fill': {
        const loc = await this.resolve(call.args.ref, obs);
        record.target = await this.describe(call.args.ref, loc, obs);
        const { value, usesSecret } = this.resolveValue(call.args.value);
        await this.guardSecret(loc, usesSecret);
        await loc.fill(value, { timeout });
        break;
      }
      case 'type': {
        const loc = await this.resolve(call.args.ref, obs);
        record.target = await this.describe(call.args.ref, loc, obs);
        const { value, usesSecret } = this.resolveValue(call.args.text);
        await this.guardSecret(loc, usesSecret);
        await loc.pressSequentially(value, { timeout, delay: 20 });
        if (call.args.submit) await loc.press('Enter', { timeout });
        break;
      }
      case 'fill_form': {
        record.targets = [];
        // Resolve and check every field before touching any of them.
        const fields = [];
        for (const f of call.args.fields) {
          const loc = await this.resolve(f.ref, obs);
          record.targets.push(await this.describe(f.ref, loc, obs));
          const resolved = this.resolveValue(f.value);
          await this.guardSecret(loc, resolved.usesSecret);
          fields.push({ loc, value: resolved.value });
        }
        for (const f of fields) await f.loc.fill(f.value, { timeout });
        break;
      }
      case 'select_option': {
        const loc = await this.resolve(call.args.ref, obs);
        record.target = await this.describe(call.args.ref, loc, obs);
        const values = call.args.values.map((v) => this.resolveValue(v).value);
        // Match by label first (what the model sees), then by value.
        await loc
          .selectOption(
            values.map((label) => ({ label })),
            { timeout },
          )
          .catch(async () => {
            await loc.selectOption(values, { timeout });
          });
        break;
      }
      case 'set_checked': {
        const loc = await this.resolve(call.args.ref, obs);
        record.target = await this.describe(call.args.ref, loc, obs);
        await loc.setChecked(call.args.checked, { timeout });
        break;
      }
      case 'press': {
        if (call.args.ref) {
          const loc = await this.resolve(call.args.ref, obs);
          record.target = await this.describe(call.args.ref, loc, obs);
          await loc.press(call.args.key, { timeout });
        } else {
          await this.page.keyboard.press(call.args.key);
        }
        break;
      }
      case 'scroll': {
        const amount = call.args.amount ?? 1;
        const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[call.args.direction];
        if (call.args.ref) {
          const loc = await this.resolve(call.args.ref, obs);
          await loc.evaluate(
            (el, d) => el.scrollBy({ left: d.dx * el.clientWidth * d.amount, top: d.dy * el.clientHeight * d.amount }),
            { dx: dx!, dy: dy!, amount },
          );
        } else {
          const size = this.page.viewportSize() ?? { width: 1280, height: 720 };
          await this.page.mouse.wheel(dx! * size.width * amount, dy! * size.height * amount);
        }
        break;
      }
      case 'wait_for': {
        const waitTimeout = 10_000;
        if (call.args.text) {
          await this.page
            .getByText(call.args.text)
            .first()
            .waitFor({ state: call.args.state ?? 'visible', timeout: waitTimeout });
        } else if (call.args.ref) {
          const loc = this.page.locator(`aria-ref=${call.args.ref}`);
          await loc.waitFor({ state: call.args.state ?? 'visible', timeout: waitTimeout });
        } else {
          await this.page.waitForTimeout(Math.min(call.args.ms ?? 1000, waitTimeout));
        }
        break;
      }
      case 'expand': {
        const expanded = expandRef(obs.tree, call.args.ref, this.opts.expandMaxTokens);
        if (!expanded) throw new ActionError(`Ref ${call.args.ref} is not in the current page snapshot.`);
        expanded.refs.forEach((r) => obs.refs.add(r));
        record.output = expanded.text;
        break;
      }
      case 'handle_dialog': {
        const pending = this.session.state.dialogs.shift();
        if (!pending) throw new ActionError('No native dialog is open.');
        if (call.args.accept) {
          const text = call.args.promptText === null ? undefined : this.resolveValue(call.args.promptText).value;
          await pending.dialog.accept(text);
        } else {
          await pending.dialog.dismiss();
        }
        break;
      }
      case 'switch_tab': {
        const pages = this.page.context().pages();
        const target = pages[call.args.index];
        if (!target) throw new ActionError(`There is no tab ${call.args.index}. Open tabs: 0–${pages.length - 1}.`);
        await this.session.switchTo(target);
        break;
      }
      case 'go_back': {
        await this.page.goBack({ timeout, waitUntil: 'domcontentloaded' });
        break;
      }
      case 'navigate': {
        if (!this.opts.isAllowedUrl(call.args.url))
          throw new ActionError(`Navigation to ${call.args.url} is not allowed.`);
        await this.page.goto(call.args.url, { timeout: 15_000, waitUntil: 'domcontentloaded' });
        break;
      }
      case 'done':
      case 'fail':
        throw new Error(`${call.tool} is not executable`);
    }
  }

  /** After an action: wait for a new document if the URL changed, then for the network to go quiet. */
  private async settle(urlBefore: string): Promise<void> {
    const { maxMs, networkQuietMs } = this.opts.settle;
    if (this.page.url() !== urlBefore) {
      await this.page.waitForLoadState('domcontentloaded', { timeout: maxMs }).catch(() => undefined);
    }
    await this.session.state.networkQuiet(networkQuietMs, maxMs);
  }
}
