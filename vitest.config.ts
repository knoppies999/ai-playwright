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
  resolve: {
    // Test workspace packages from source, never from a stale dist/.
    alias: [{ find: /^@aipw\/([a-z-]+)$/, replacement: `${import.meta.dirname}/packages/$1/src/index.ts` }],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
