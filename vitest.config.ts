import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/** Prompt files are imported as text, like tsup's `--loader .md=text` in the build. */
const markdownAsText: Plugin = {
  name: 'markdown-as-text',
  load(id) {
    if (id.endsWith('.md')) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
    return undefined;
  },
};

export default defineConfig({
  plugins: [markdownAsText],
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
