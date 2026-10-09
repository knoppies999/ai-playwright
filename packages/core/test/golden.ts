import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const TEST_DIR = dirname(fileURLToPath(import.meta.url));

export const fixture = (...parts: string[]) => readFileSync(join(TEST_DIR, 'fixtures', ...parts), 'utf8');

/**
 * Compares `actual` with `test/golden/<name>`. Run with UPDATE_GOLDEN=1 to (re)write the file; a
 * missing golden file is written on first run and the test fails so the new file gets reviewed.
 */
export function expectGolden(name: string, actual: string): void {
  const path = join(TEST_DIR, 'golden', name);
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual.endsWith('\n') ? actual : `${actual}\n`);
    if (!process.env.UPDATE_GOLDEN) throw new Error(`Golden file ${name} was missing and has been written. Review it.`);
    return;
  }
  expect(actual.endsWith('\n') ? actual : `${actual}\n`).toBe(readFileSync(path, 'utf8'));
}
