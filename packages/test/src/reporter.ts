// `@aipw/test/reporter` (docs/09 §2.2): add it next to your other reporters,
//   reporter: [['list'], ['html'], ['@aipw/test/reporter']]
// It reads each test's aipw-steps.json attachment, prints the run summary, writes .aipw/summary.{md,json} and, on
// Azure Pipelines (TF_BUILD=True), adds the Markdown as a build summary tab.
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  formatSummaryMarkdown,
  formatSummaryText,
  summarizeRun,
  SUMMARY_ATTACHMENT,
  type RunSummary,
  type TestSummary,
} from './summary.js';

export interface AipwReporterOptions {
  /** Where summary.md and summary.json go. Default .aipw */
  outputDir?: string;
  /** Don't print the console summary. */
  quiet?: boolean;
}

export default class AipwReporter implements Reporter {
  /** Last attempt per test: a retried test counts once. */
  private readonly tests = new Map<string, TestSummary>();
  summary?: RunSummary;

  constructor(private readonly options: AipwReporterOptions = {}) {}

  printsToStdio(): boolean {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find((a) => a.name === SUMMARY_ATTACHMENT);
    const body = attachment?.body ?? (attachment?.path ? readFileSync(attachment.path) : undefined);
    if (body) this.tests.set(test.id, JSON.parse(body.toString('utf8')) as TestSummary);
  }

  onEnd(_result: FullResult): void {
    if (!this.tests.size) return;
    this.summary = summarizeRun([...this.tests.values()]);
    const dir = resolve(this.options.outputDir ?? '.aipw');
    mkdirSync(dir, { recursive: true });
    const md = join(dir, 'summary.md');
    writeFileSync(md, formatSummaryMarkdown(this.summary));
    writeFileSync(join(dir, 'summary.json'), `${JSON.stringify(this.summary, null, 2)}\n`);
    // Every step of every test, for `aipw conformance` and other tooling.
    writeFileSync(join(dir, 'steps.json'), `${JSON.stringify([...this.tests.values()], null, 2)}\n`);
    if (!this.options.quiet) console.log(`\n${formatSummaryText(this.summary)}\n`);
    // Azure Pipelines: the Markdown becomes a tab on the build summary page.
    if (process.env.TF_BUILD?.toLowerCase() === 'true') console.log(`##vso[task.uploadsummary]${md}`);
  }
}
