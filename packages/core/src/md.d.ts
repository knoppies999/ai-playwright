// Prompt files are bundled as text: tsup `--loader .md=text`, and a Vite plugin in vitest.config.ts.
declare module '*.md' {
  const text: string;
  export default text;
}
