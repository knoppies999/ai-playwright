// Parsing, masking and pruning of Playwright AI-mode ARIA snapshots (docs/04 §1.2).
// Everything here is pure and deterministic: same input → byte-identical output (AGENTS.md rule 7).

export interface SnapNode {
  role: string;
  /** Accessible name, unescaped. */
  name?: string;
  /** Raw bracket attributes without brackets, e.g. `ref=e5`, `level=1`, `cursor=pointer`, `aria-hidden`. */
  attrs: string[];
  ref?: string;
  /** Text after the colon on the same line. */
  value?: string;
  /** The line ends with `:` (children follow, or a value is given). */
  colon: boolean;
  children: SnapNode[];
  /** Lines that didn't parse as `- item` are kept verbatim under their parent. */
  verbatim?: string;
}

const ITEM = /^(\s*)- (.*)$/;

export function parseSnapshot(yaml: string): SnapNode[] {
  const roots: SnapNode[] = [];
  const stack: { indent: number; node: SnapNode }[] = [];
  for (const line of yaml.split('\n')) {
    if (line.trim() === '') continue;
    const m = ITEM.exec(line);
    const indent = m ? m[1]!.length : line.length - line.trimStart().length;
    const node: SnapNode = m
      ? parseItem(m[2]!)
      : { role: '', attrs: [], colon: false, children: [], verbatim: line.trim() };
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1]!.node.children.push(node);
    else roots.push(node);
    stack.push({ indent, node });
  }
  return roots;
}

function parseItem(content: string): SnapNode {
  const roleMatch = /^("(?:[^"\\]|\\.)*"|[^\s"[:]+)/.exec(content);
  if (!roleMatch) return { role: '', attrs: [], colon: false, children: [], verbatim: `- ${content}` };
  let rest = content.slice(roleMatch[0].length);
  const node: SnapNode = { role: roleMatch[0], attrs: [], colon: false, children: [] };
  const nameMatch = /^ "((?:[^"\\]|\\.)*)"/.exec(rest);
  if (nameMatch) {
    node.name = nameMatch[1]!.replace(/\\(.)/g, '$1');
    rest = rest.slice(nameMatch[0].length);
  }
  for (let attr = /^ \[([^\]]*)\]/.exec(rest); attr; attr = /^ \[([^\]]*)\]/.exec(rest)) {
    node.attrs.push(attr[1]!);
    if (attr[1]!.startsWith('ref=')) node.ref = attr[1]!.slice(4);
    rest = rest.slice(attr[0].length);
  }
  if (rest.startsWith(':')) {
    node.colon = true;
    const value = rest.slice(1).trim();
    if (value) node.value = value;
  } else if (rest.trim()) {
    // Unexpected trailing text: keep it as the value so nothing is lost.
    node.value = rest.trim();
  }
  return node;
}

const escapeName = (name: string) => name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export function renderNode(node: SnapNode): string {
  if (node.verbatim !== undefined) return node.verbatim;
  const name = node.name !== undefined ? ` "${escapeName(node.name)}"` : '';
  const attrs = node.attrs.map((a) => ` [${a}]`).join('');
  const colon = node.colon || node.children.length ? ':' : '';
  const value = node.value !== undefined ? ` ${node.value}` : '';
  return `- ${node.role}${name}${attrs}${colon}${value}`;
}

export function renderSnapshot(nodes: SnapNode[], indent = 0): string {
  const lines: string[] = [];
  const walk = (list: SnapNode[], depth: number) => {
    for (const node of list) {
      lines.push(`${'  '.repeat(depth)}${renderNode(node)}`);
      walk(node.children, depth + 1);
    }
  };
  walk(nodes, indent);
  return lines.join('\n');
}

/** All refs in a snapshot text, in document order, without duplicates. */
export function refsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\[ref=([^\]]+)\]/g)].map((m) => m[1]!))];
}

export function findByRef(nodes: SnapNode[], ref: string): { node: SnapNode; ancestors: SnapNode[] } | undefined {
  const walk = (list: SnapNode[], ancestors: SnapNode[]): { node: SnapNode; ancestors: SnapNode[] } | undefined => {
    for (const node of list) {
      if (node.ref === ref) return { node, ancestors };
      const found = walk(node.children, [...ancestors, node]);
      if (found) return found;
    }
    return undefined;
  };
  return walk(nodes, []);
}

const MASK = '••••';

/**
 * Masks values that must never reach a model: credential-field values read from the page, and resolved
 * secrets. A node whose whole value equals one of them is masked; secrets of 4+ characters are also
 * scrubbed wherever they appear (names, values, URLs).
 */
export function maskSnapshot(nodes: SnapNode[], sensitiveValues: readonly string[]): SnapNode[] {
  const exact = new Set(sensitiveValues.filter((v) => v !== ''));
  const scrub = [...exact].filter((v) => v.length >= 4).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const clean = (s: string | undefined) =>
    s === undefined ? s : exact.has(s) ? MASK : scrub.reduce((acc, v) => acc.split(v).join(MASK), s);
  const walk = (list: SnapNode[]): SnapNode[] =>
    list.map((n) => ({
      ...n,
      name: clean(n.name),
      value: clean(n.value),
      verbatim: clean(n.verbatim),
      children: walk(n.children),
    }));
  return walk(nodes);
}

export interface PruneOptions {
  /** Token budget, estimated as characters / 4. */
  maxTokens: number;
  /** Runs of more than this many same-role siblings are collapsed. */
  collapseSiblingsOver: number;
  /** Text values longer than this are truncated. */
  maxTextLength: number;
}

export const DEFAULT_PRUNE_OPTIONS: PruneOptions = { maxTokens: 6000, collapseSiblingsOver: 15, maxTextLength: 300 };

const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'treeitem',
]);

export const approxTokens = (text: string): number => Math.ceil(text.length / 4);

const describe = (n: SnapNode) => `${n.role}${n.name ? ` "${n.name}"` : n.value ? ` "${n.value}"` : ''}`;

function countNodes(list: SnapNode[]): number {
  return list.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

/** Hidden subtrees (aria-hidden) become one line that names what is inside, without refs. */
function collapseHidden(list: SnapNode[]): SnapNode[] {
  return list.map((n) => {
    if (n.attrs.includes('aria-hidden')) {
      const inside: string[] = [];
      const walk = (l: SnapNode[]) =>
        l.forEach((c) => {
          if (INTERACTIVE.has(c.role)) inside.push(describe(c));
          walk(c.children);
        });
      walk(n.children);
      const shown = inside.slice(0, 8).join(', ') + (inside.length > 8 ? `, … ${inside.length - 8} more` : '');
      return {
        role: 'hidden',
        attrs: [],
        colon: true,
        value: inside.length ? `contains ${shown} (not usable until it is shown)` : '(hidden content)',
        children: [],
      };
    }
    return { ...n, children: collapseHidden(n.children) };
  });
}

const isWrapper = (n: SnapNode) =>
  (n.role === 'generic' || n.role === 'none' || n.role === 'presentation') &&
  !n.name &&
  !n.value &&
  !n.attrs.some((a) => a.startsWith('cursor='));

/**
 * Drops wrappers and noise: unnamed generics without text, presentation roles, unnamed images.
 * Exception: when 2+ sibling wrappers each hold several children they are repeated items (product
 * cards, rows built from divs), so they stay as `group` nodes to keep each item's controls together.
 */
function dropNoise(list: SnapNode[], maxTextLength: number): SnapNode[] {
  const out: SnapNode[] = [];
  const itemWrappers = list.filter((n) => isWrapper(n) && n.children.length >= 2).length >= 2;
  for (const n of list) {
    const children = dropNoise(n.children, maxTextLength);
    if (isWrapper(n)) {
      if (itemWrappers && n.children.length >= 2) out.push({ role: 'group', attrs: [], colon: true, children });
      else out.push(...children);
      continue;
    }
    if (n.role === 'img' && !n.name && !children.length) continue;
    const attrs = n.attrs.filter((a) => a !== 'cursor=pointer' || n.role === 'generic');
    let value = n.value;
    if (value && value.length > maxTextLength) value = `${value.slice(0, maxTextLength)}…`;
    if (n.role === '/url' && value && value.length > 120) value = `${value.slice(0, 120)}…`;
    out.push({ ...n, attrs, value, children });
  }
  return out;
}

/** Long runs of same-role siblings keep the first 10 and last 2. */
function collapseRuns(list: SnapNode[], over: number): SnapNode[] {
  const out: SnapNode[] = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j < list.length && list[j]!.role === list[i]!.role && list[i]!.verbatim === undefined) j++;
    const run = list.slice(i, Math.max(j, i + 1));
    if (run.length > over) {
      out.push(...run.slice(0, 10).map((n) => ({ ...n, children: collapseRuns(n.children, over) })));
      out.push({
        role: '…',
        attrs: [],
        colon: false,
        value: `${run.length - 12} more ${run[0]!.role} items (scroll, filter or use a more specific instruction)`,
        children: [],
      });
      out.push(...run.slice(-2).map((n) => ({ ...n, children: collapseRuns(n.children, over) })));
    } else {
      out.push(...run.map((n) => ({ ...n, children: collapseRuns(n.children, over) })));
    }
    i += run.length;
  }
  return out;
}

/** Modal focus: when a dialog is open, keep only dialogs plus a one-line summary of the rest. */
function focusModal(list: SnapNode[]): SnapNode[] {
  const dialogs: SnapNode[] = [];
  const walk = (l: SnapNode[]) =>
    l.forEach((n) => {
      if (n.role === 'dialog' || n.role === 'alertdialog') dialogs.push(n);
      else walk(n.children);
    });
  walk(list);
  if (!dialogs.length) return list;
  const behind = countNodes(list) - dialogs.reduce((s, d) => s + countNodes([d]), 0);
  return [
    ...dialogs,
    { role: '…', attrs: [], colon: false, value: `page behind the dialog: ${behind} nodes not shown`, children: [] },
  ];
}

/** Cuts the tree below `maxDepth`, leaving a pointer to the nearest ref so the model can call expand. */
function limitDepth(list: SnapNode[], maxDepth: number, depth = 0, nearestRef?: string): SnapNode[] {
  return list.map((n) => {
    const ref = n.ref ?? nearestRef;
    if (depth >= maxDepth && n.children.length) {
      const hidden = countNodes(n.children);
      return {
        ...n,
        children: [
          {
            role: '…',
            attrs: [],
            colon: false,
            value: `${hidden} nodes truncated${ref ? ` (call expand with ref=${ref})` : ''}`,
            children: [],
          },
        ],
      };
    }
    return { ...n, children: limitDepth(n.children, maxDepth, depth + 1, ref) };
  });
}

function depthOf(list: SnapNode[]): number {
  return list.reduce((max, n) => Math.max(max, 1 + depthOf(n.children)), 0);
}

export interface PrunedSnapshot {
  text: string;
  /** Refs the model can use: the ones present in `text`. */
  refs: string[];
  truncated: boolean;
}

export function pruneSnapshot(nodes: SnapNode[], options: Partial<PruneOptions> = {}): PrunedSnapshot {
  const opts = { ...DEFAULT_PRUNE_OPTIONS, ...options };
  const base = collapseRuns(
    dropNoise(collapseHidden(focusModal(nodes)), opts.maxTextLength),
    opts.collapseSiblingsOver,
  );
  let text = renderSnapshot(base);
  let truncated = false;
  for (let d = depthOf(base) - 1; approxTokens(text) > opts.maxTokens && d >= 1; d--) {
    text = renderSnapshot(limitDepth(base, d));
    truncated = true;
  }
  if (approxTokens(text) > opts.maxTokens) {
    // Still too big at depth 1: hard cut, at a line boundary.
    const lines = text.split('\n');
    const kept: string[] = [];
    let size = 0;
    for (const line of lines) {
      if ((size + line.length + 1) / 4 > opts.maxTokens - 20) break;
      kept.push(line);
      size += line.length + 1;
    }
    text = `${kept.join('\n')}\n- … ${lines.length - kept.length} more lines not shown (use a scope or a more specific instruction)`;
    truncated = true;
  }
  return { text, refs: refsIn(text), truncated };
}

/** The unpruned subtree under `ref` (for the expand tool), capped at the token budget. */
export function expandRef(nodes: SnapNode[], ref: string, maxTokens: number): PrunedSnapshot | undefined {
  const found = findByRef(nodes, ref);
  if (!found) return undefined;
  return pruneSnapshot([found.node], { maxTokens, collapseSiblingsOver: Number.MAX_SAFE_INTEGER });
}
