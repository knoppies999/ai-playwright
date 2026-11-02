// The reporter `aipw nudge` runs Playwright with. A nudge session ends runs on purpose (a rewind, the end of a
// verification run, the user quitting); those are part of the session, not test failures, so they print one quiet
// line. Real failures are printed in full.
import type { Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter';

/** RewindSignal, VerifyDone and the user's quit all say "aipw nudge:". */
export const isNudgeStop = (result: Pick<TestResult, 'errors'>) =>
  result.errors.length > 0 && result.errors.every((e) => /aipw nudge:/.test(e.message ?? ''));

const title = (test: TestCase) => test.titlePath().filter(Boolean).slice(1).join(' › ');

function formatError(error: TestError): string {
  return [error.message, error.snippet].filter(Boolean).join('\n');
}

export default class NudgeReporter implements Reporter {
  printsToStdio(): boolean {
    return true;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const seconds = (result.duration / 1000).toFixed(1);
    if (isNudgeStop(result)) {
      const message = result.errors[0]?.message?.replace(/^.*aipw nudge: /s, '').split('\n')[0] ?? '';
      console.log(`  ·  ${title(test)} (${seconds}s): ${message}`);
      return;
    }
    const mark = result.status === 'passed' ? 'ok' : result.status === 'skipped' ? '-' : 'x';
    console.log(`  ${mark}  ${title(test)} (${seconds}s)`);
    for (const error of result.errors) console.log(`\n${formatError(error)}\n`);
  }
}
