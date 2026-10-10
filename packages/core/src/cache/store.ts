// Plan files on disk: `<spec dir>/__aipw__/<spec file>.plans.json` (docs/06 §2). Parallel workers can
// run tests from the same spec, so every write takes a lock file, re-reads, merges and renames.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { emptyPlanFile, PlanFileSchema, stableStringify, type PlanFile, type StepPlan } from './plan.js';

export function planFilePath(specFile: string, dir = '__aipw__'): string {
  // A relative dir sits next to the spec; an absolute one (e.g. a temp folder in tests) is used as is.
  return join(isAbsolute(dir) ? dir : join(dirname(specFile), dir), `${basename(specFile)}.plans.json`);
}

export function readPlanFile(path: string): PlanFile {
  if (!existsSync(path)) return emptyPlanFile();
  const parsed = PlanFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid plan file ${path}: ${parsed.error.message}`);
  return parsed.data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withLock<T>(path: string, fn: () => T): Promise<T> {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempt > 200) rmSync(lock, { force: true }); // stale lock from a crashed worker (~10 s)
      await sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export interface PlanStore {
  get(test: string, key: string): StepPlan | undefined;
  /** Writes one step's plan, keeping up to 3 previous versions in history. */
  put(test: string, key: string, plan: StepPlan, options?: { healed?: boolean }): Promise<void>;
}

export class FilePlanStore implements PlanStore {
  private snapshot: PlanFile;

  constructor(readonly path: string) {
    this.snapshot = readPlanFile(path);
  }

  get(test: string, key: string): StepPlan | undefined {
    return this.snapshot.tests[test]?.[key];
  }

  async put(test: string, key: string, plan: StepPlan, options: { healed?: boolean } = {}): Promise<void> {
    await withLock(this.path, () => {
      const file = readPlanFile(this.path);
      const steps = (file.tests[test] ??= {});
      const previous = steps[key];
      const next: StepPlan = { ...plan };
      if (previous && options.healed) {
        const { history = [], ...old } = previous;
        next.history = [old, ...history].slice(0, 3);
        next.stats = { heals: previous.stats.heals + 1, lastHealAt: plan.recordedWith.at };
      } else if (previous?.history) {
        next.history = previous.history;
      }
      steps[key] = next;
      const text = stableStringify(file);
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, this.path);
      this.snapshot = file;
    });
  }
}

/** In-memory store for tests. */
export class MemoryPlanStore implements PlanStore {
  readonly file: PlanFile = emptyPlanFile();

  get(test: string, key: string): StepPlan | undefined {
    return this.file.tests[test]?.[key];
  }

  async put(test: string, key: string, plan: StepPlan, options: { healed?: boolean } = {}): Promise<void> {
    const steps = (this.file.tests[test] ??= {});
    const previous = steps[key];
    const next: StepPlan = { ...plan };
    if (previous && options.healed) {
      const { history = [], ...old } = previous;
      next.history = [old, ...history].slice(0, 3);
      next.stats = { heals: previous.stats.heals + 1, lastHealAt: plan.recordedWith.at };
    }
    steps[key] = next;
  }
}
