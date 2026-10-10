// Spec patching for nudge remedies (docs/07 §6.5), with the TypeScript compiler API (no ts-morph): find the
// ai.* call at the recorded line whose first argument is the old instruction, then replace the literal, or the
// whole statement (code remedy / split steps). Quotes and indentation are preserved; nothing else changes.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

export const contentHash = (text: string) => createHash('sha1').update(text).digest('hex');

interface Found {
  call: ts.CallExpression;
  literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
  statement: ts.Statement;
  /** e.g. "ai.act" or "step.act", reused for split steps. */
  callee: string;
}

/** The ai.* call whose first argument equals `instruction`, closest to `line` (1-based). */
export function findAiCall(source: string, instruction: string, line: number): Found | undefined {
  const file = ts.createSourceFile('spec.ts', source, ts.ScriptTarget.Latest, true);
  const matches: Found[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['act', 'assert', 'check', 'extract', 'locate', 'run'].includes(node.expression.name.text)
    ) {
      const first = node.arguments[0];
      if (
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
        first.text === instruction
      ) {
        let statement: ts.Node = node;
        while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent))
          statement = statement.parent;
        matches.push({
          call: node,
          literal: first,
          statement: statement as ts.Statement,
          callee: node.expression.getText(file),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const lineOf = (n: ts.Node) => file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1;
  return matches.sort((a, b) => Math.abs(lineOf(a.call) - line) - Math.abs(lineOf(b.call) - line))[0];
}

function quoteLike(original: string, text: string): string {
  const q = original[0] === '"' ? '"' : original[0] === '`' ? '`' : "'";
  const escaped = text.replace(/\\/g, '\\\\').split(q).join(`\\${q}`);
  return `${q}${q === '`' ? escaped.replace(/\$\{/g, '\\${') : escaped}${q}`;
}

export type Patch =
  { kind: 'instruction'; text: string } | { kind: 'split'; instructions: string[] } | { kind: 'code'; lines: string[] };

/** Applies a remedy to the source. Returns the new source, or an error explaining why it can't. */
export function patchSource(
  source: string,
  at: { instruction: string; line: number },
  patch: Patch,
): { ok: true; source: string } | { ok: false; error: string } {
  const found = findAiCall(source, at.instruction, at.line);
  if (!found)
    return {
      ok: false,
      error: `No ai.* call with the instruction ${JSON.stringify(at.instruction)} near line ${at.line}.`,
    };
  const literalText = source.slice(found.literal.getStart(), found.literal.getEnd());
  if (patch.kind === 'instruction') {
    const start = found.literal.getStart();
    return {
      ok: true,
      source: `${source.slice(0, start)}${quoteLike(literalText, patch.text)}${source.slice(found.literal.getEnd())}`,
    };
  }
  const start = found.statement.getStart();
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const indent = source.slice(lineStart, start);
  const callText = source.slice(found.call.getStart(), found.call.getEnd());
  const lines =
    patch.kind === 'code'
      ? patch.lines
      : patch.instructions.map((i) => {
          const replaced = callText.replace(literalText, quoteLike(literalText, i));
          return `await ${replaced};`;
        });
  const replacement = lines.join(`\n${indent}`);
  return { ok: true, source: `${source.slice(0, start)}${replacement}${source.slice(found.statement.getEnd())}` };
}

/** A small line diff for showing patches before they are applied. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  return [...a.slice(start, endA + 1).map((l) => `- ${l}`), ...b.slice(start, endB + 1).map((l) => `+ ${l}`)].join(
    '\n',
  );
}

/** Patches a file on disk, refusing if it changed since `expectedHash` was taken (docs/07 §6.5). */
export function patchFile(
  path: string,
  expectedHash: string,
  at: { instruction: string; line: number },
  patch: Patch,
): { ok: true; diff: string } | { ok: false; error: string } {
  const current = readFileSync(path, 'utf8');
  if (contentHash(current) !== expectedHash)
    return { ok: false, error: `${path} changed since the session started; apply this by hand.` };
  const result = patchSource(current, at, patch);
  if (!result.ok) return result;
  writeFileSync(path, result.source);
  return { ok: true, diff: lineDiff(current, result.source) };
}
