// The page an AI step works on. It can change mid-step when the model switches tabs.
import type { Page } from 'playwright-core';
import { Observer, type ObserverOptions } from '../observe/observer.js';
import { PageState } from '../observe/page-state.js';

export class StepSession {
  private constructor(
    public state: PageState,
    public observer: Observer,
    private readonly observerOptions: ObserverOptions,
  ) {}

  static async open(page: Page, observerOptions: ObserverOptions): Promise<StepSession> {
    const state = await PageState.attach(page);
    return new StepSession(state, new Observer(state, observerOptions), observerOptions);
  }

  get page(): Page {
    return this.state.page;
  }

  async switchTo(page: Page): Promise<void> {
    if (page === this.page) return;
    await this.state.detach();
    this.state = await PageState.attach(page);
    this.observer = new Observer(this.state, this.observerOptions);
    await page.bringToFront();
  }

  async close(): Promise<void> {
    await this.state.detach();
  }
}
