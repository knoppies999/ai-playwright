// `aipw cache code <spec>`: the plain Playwright a spec's plans replay, per test and in spec order. For reading what
// was recorded, or for turning a stable flow into ordinary code. Placeholders become identifiers: {{data.email}} →
// data.email (the values you pass to ai.act), {{secret.password}} → secret('password').
import type { CompiledCheck, PlanAction, PlanFile, PlanTarget, StepPlan } from '@aipw/core';

const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A string literal, or an expression when the whole value is one placeholder. */
export function codeValue(v: string): string {
  const whole = /^\{\{\s*(data|secret|values)\.([\w$]+)\s*\}\}$/.exec(v);
  if (whole) {
    const [, kind, name] = whole;
    return kind === 'secret' ? `secret(${quote(name!)})` : `${kind}.${name}`;
  }
  return /\{\{.+?\}\}/.test(v) ? `${quote(v)} /* TODO: placeholder */` : quote(v);
}

const at = (t: PlanTarget | undefined) => t?.locators[0]?.display;
const noLocator = (tool: string, t: PlanTarget | undefined) =>
  `// ${tool} ${t?.role ?? 'element'}${t?.name ? ` "${t.name}"` : ''}: no stored locator (heals by AI on replay)`;

function actionCode(a: PlanAction): string[] {
  const args = a.args;
  const on = (t: PlanTarget | undefined, call: string) =>
    at(t) ? [`await page.${at(t)}.${call};`] : [noLocator(a.tool, t)];
  switch (a.tool) {
    case 'click':
      return on(a.target, args.clickCount === 2 ? 'dblclick()' : 'click()');
    case 'hover':
      return on(a.target, 'hover()');
    case 'fill':
      return on(a.target, `fill(${codeValue(String(args.value))})`);
    case 'type':
      return [
        ...on(a.target, `pressSequentially(${codeValue(String(args.text))})`),
        ...(args.submit ? on(a.target, "press('Enter')") : []),
      ];
    case 'fill_form':
      return (args.fields as { value: string }[]).flatMap((f, i) => on(a.targets?.[i], `fill(${codeValue(f.value)})`));
    case 'select_option':
      return on(a.target, `selectOption([${(args.values as string[]).map(codeValue).join(', ')}])`);
    case 'set_checked':
      return on(a.target, `setChecked(${String(args.checked)})`);
    case 'press':
      return a.target
        ? on(a.target, `press(${quote(String(args.key))})`)
        : [`await page.keyboard.press(${quote(String(args.key))});`];
    case 'wait_for':
      if (typeof args.text === 'string') return [`await page.getByText(${quote(args.text)}).first().waitFor();`];
      if (typeof args.ms === 'number') return [`await page.waitForTimeout(${args.ms});`];
      return [`// wait_for: no text to wait for`];
    case 'navigate':
      return [`await page.goto(${quote(String(args.url))});`];
    case 'go_back':
      return ['await page.goBack();'];
    case 'scroll':
      return [
        `await page.mouse.wheel(0, ${args.direction === 'up' ? -1 : 1} * 600); // scroll ${String(args.direction)}`,
      ];
    default:
      return [`// ${a.tool}${a.intent ? ` (${a.intent})` : ''}: keep this as an AI step or a code tool`];
  }
}

const regexLiteral = (s: string) => `/${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/`;

function checkCode(c: CompiledCheck): string {
  const not = c.not ? '.not' : '';
  const arg = c.args[0];
  if (c.expect === 'toHaveURL') return `await expect(page)${not}.toHaveURL(${regexLiteral(String(arg))});`;
  const loc = at(c.target);
  if (!loc) return `// ${c.expect}: no stored locator`;
  const value = arg === undefined ? '' : typeof arg === 'number' ? String(arg) : quote(String(arg));
  return `await expect(page.${loc})${not}.${c.expect}(${c.expect === 'toHaveCount' ? Number(arg) : value});`;
}

export function stepCode(step: StepPlan): string[] {
  const head = `// ai.${step.kind}(${quote(step.instruction)})`;
  switch (step.kind) {
    case 'act':
      return [head, ...(step.actions ?? []).flatMap(actionCode)];
    case 'assert':
      return step.compiled?.length
        ? [head, ...step.compiled.map(checkCode)]
        : [`${head}: judged by the AI on every run, no code equivalent${step.note ? ` (${step.note})` : ''}`];
    case 'extract':
      return step.sources?.length
        ? [
            head,
            ...step.sources.map(
              (s) =>
                `${at(s.target) ? `await page.${at(s.target)}.innerText()` : '/* no stored locator */'}; // ${s.path || 'value'}`,
            ),
          ]
        : [`${head}: read by the AI on every run, no code equivalent`];
    case 'locate':
      return [head, at(step.target) ? `page.${at(step.target)}` : '// no stored locator'];
  }
}

/**
 * Plans are keyed by hash, so they have no order. Given the spec's source, sorts steps by where their instruction
 * appears in it, as a string literal so "Save" isn't found inside "Saved". Lines of an ai.run script aren't quoted,
 * so longer instructions are also found bare (${…} instructions come last).
 */
export function inSpecOrder(steps: StepPlan[], specSource?: string): StepPlan[] {
  const position = (step: StepPlan) => {
    const found = ["'", '"', '`']
      .map((q) => specSource?.indexOf(`${q}${step.instruction}${q}`) ?? -1)
      .filter((i) => i >= 0);
    if (!found.length && step.instruction.length >= 12) {
      const bare = specSource?.indexOf(step.instruction) ?? -1;
      if (bare >= 0) found.push(bare);
    }
    return found.length ? Math.min(...found) : Number.MAX_SAFE_INTEGER;
  };
  return [...steps].sort((a, b) => position(a) - position(b));
}

/** Code for every test in a plan file, steps in the order their instructions appear in the spec. */
export function plansToCode(file: PlanFile, specSource?: string, grep?: string): string {
  const out: string[] = [];
  for (const [title, steps] of Object.entries(file.tests).sort(([a], [b]) => a.localeCompare(b))) {
    if (grep && !title.includes(grep)) continue;
    out.push(`// ── ${title}`);
    for (const step of inSpecOrder(Object.values(steps), specSource)) out.push(...stepCode(step));
    out.push('');
  }
  return out.join('\n');
}
