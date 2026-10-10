import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hintFileName, loadHints, writeHint } from '../src/hints/store.js';

const FILE = `# Site: localhost:5173

## Everywhere
- Settings pages are in the flyout under the gear icon. Hover it to open it.

## /users/new
- "Province" is a searchable combobox: type, then click the option.

## /settings/**
- Changes save automatically.
`;

describe('HintStore', () => {
  it('names files after host and port', () => {
    expect(hintFileName('http://localhost:5173/users')).toBe('localhost-5173.md');
    expect(hintFileName('https://www.saucedemo.com/inventory.html')).toBe('www.saucedemo.com.md');
    expect(hintFileName('about:blank')).toBeUndefined();
  });

  it('loads site-wide hints plus the sections whose path glob matches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipw-hints-'));
    writeFileSync(join(dir, 'localhost-5173.md'), FILE);
    expect(loadHints(dir, 'http://localhost:5173/users/new')).toEqual([
      'Settings pages are in the flyout under the gear icon. Hover it to open it.',
      '"Province" is a searchable combobox: type, then click the option.',
    ]);
    expect(loadHints(dir, 'http://localhost:5173/settings/profile/edit')).toContain('Changes save automatically.');
    expect(loadHints(dir, 'http://localhost:5173/users')).toHaveLength(1);
    expect(loadHints(dir, 'http://other.test/')).toEqual([]);
  });

  it('appends hints under the right section, creating it when needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aipw-hints-'));
    const file = writeHint(dir, 'http://localhost:5173/app', { scope: 'site', text: 'Users is under Settings.' });
    writeHint(dir, 'http://localhost:5173/app', { scope: 'path', pathPattern: '/users/new', text: 'Phone needs +27.' });
    writeHint(dir, 'http://localhost:5173/app', { scope: 'site', text: 'Toasts vanish after 3 s.' });
    expect(readFileSync(file, 'utf8')).toBe(
      '# Site: localhost:5173\n\n## Everywhere\n- Users is under Settings.\n- Toasts vanish after 3 s.\n\n## /users/new\n- Phone needs +27.\n',
    );
    expect(loadHints(dir, 'http://localhost:5173/users/new')).toEqual([
      'Users is under Settings.',
      'Toasts vanish after 3 s.',
      'Phone needs +27.',
    ]);
  });
});
