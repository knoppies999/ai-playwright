import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { callsiteFromStack } from '../src/index.js';

const cwd = join(process.cwd(), 'some app');
const at = (...parts: string[]) => join(cwd, ...parts);

describe('callsiteFromStack', () => {
  it('skips node internals and aipw frames and finds the spec line (async stack)', () => {
    const stack = [
      'Error',
      `    at captureCallsite (${at('packages', 'test', 'dist', 'index.js')}:60:20)`,
      `    at Ai.step (${at('packages', 'core', 'dist', 'index.js')}:900:12)`,
      '    at process.processTicksAndRejections (node:internal/process/task_queues:65:5)',
      `    at async Ai.assert (${at('packages', 'core', 'dist', 'index.js')}:1200:5)`,
      `    at async ${at('tests', 'todo.spec.ts')}:28:5`,
    ].join('\n');
    const own = [at('packages', 'test'), at('packages', 'core')].map((d) => `${d.replace(/\\/g, '/').toLowerCase()}/`);
    expect(callsiteFromStack(stack, cwd, own)).toEqual({ file: 'tests/todo.spec.ts', line: 28, column: 5 });
  });

  it("keeps the user's own packages/core frames", () => {
    const stack = ['Error', `    at async ${at('packages', 'core', 'e2e', 'a.spec.ts')}:4:1`].join('\n');
    expect(callsiteFromStack(stack, cwd, [])).toMatchObject({ file: 'packages/core/e2e/a.spec.ts', line: 4 });
  });

  it('decodes file:// URLs with spaces', () => {
    const stack = ['Error', `    at ${pathToFileURL(at('tests', 'a.spec.ts')).href}:7:3`].join('\n');
    expect(callsiteFromStack(stack, cwd)).toMatchObject({ file: 'tests/a.spec.ts', line: 7 });
  });
});
