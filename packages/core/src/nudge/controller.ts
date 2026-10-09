// NudgeController (docs/07 §8): runs in the Playwright worker, decides when to pause, sends PauseState to
// the `aipw nudge` driver and waits for the human's command.
import { createConnection, type Socket } from 'node:net';
import {
  DriverMessageSchema,
  NUDGE_PROTOCOL_VERSION,
  NudgeQuit,
  RewindSignal,
  type BreakLevel,
  type NudgeCommand,
  type PauseState,
  type WorkerMessage,
} from './protocol.js';

/** Line-delimited JSON over a socket. */
class Channel {
  private buffer = '';
  private readonly waiting = new Map<number, (cmd: NudgeCommand) => void>();

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        const parsed = DriverMessageSchema.safeParse(JSON.parse(line));
        if (parsed.success) this.waiting.get(parsed.data.id)?.(parsed.data.command);
      }
    });
    socket.on('close', () => {
      // The driver went away: let paused steps carry on as if 'continue' with no breakpoints.
      for (const resolve of this.waiting.values()) resolve({ cmd: 'continue', level: 'none' });
      this.waiting.clear();
    });
  }

  send(message: WorkerMessage): void {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  request(id: number, message: WorkerMessage): Promise<NudgeCommand> {
    return new Promise((resolve) => {
      this.waiting.set(id, (cmd) => {
        this.waiting.delete(id);
        resolve(cmd);
      });
      this.send(message);
    });
  }

  close(): void {
    this.socket.end();
  }
}

export interface NudgeOptions {
  breakLevel?: BreakLevel;
  /** Suppress breakpoints before this AI step (1-based): set after a rewind (AIPW_NUDGE_RESUME_AT). */
  resumeAt?: number;
}

export type StepInfo = Omit<PauseState['step'], 'index'>;
type PauseContext = Omit<PauseState, 'v' | 'breakLevel' | 'test' | 'step' | 'reason'>;

export class NudgeController {
  breakLevel: BreakLevel;
  private stepIndex = 0;
  private nextId = 1;
  private readonly resumeAt: number;
  private current?: PauseState['step'];

  constructor(
    private readonly channel: {
      request: (id: number, m: WorkerMessage) => Promise<NudgeCommand>;
      send: (m: WorkerMessage) => void;
      close: () => void;
    },
    private readonly test: PauseState['test'],
    options: NudgeOptions = {},
  ) {
    this.breakLevel = options.breakLevel ?? 'step';
    this.resumeAt = options.resumeAt ?? 1;
  }

  /** Connects to the driver on localhost. */
  static async connect(port: number, test: PauseState['test'], options: NudgeOptions = {}): Promise<NudgeController> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection({ host: '127.0.0.1', port }, () => resolve(s));
      s.once('error', reject);
    });
    const channel = new Channel(socket);
    channel.send({ type: 'hello', v: NUDGE_PROTOCOL_VERSION, test });
    return new NudgeController(channel, test, options);
  }

  /** From AIPW_NUDGE_PORT / AIPW_NUDGE_BREAK / AIPW_NUDGE_RESUME_AT, set by `aipw nudge`. */
  static fromEnv(test: PauseState['test'], env: NodeJS.ProcessEnv = process.env): Promise<NudgeController> | undefined {
    if (!env.AIPW_NUDGE_PORT) return undefined;
    if (env.CI) throw new Error('aipw nudge is interactive and refuses to run when CI is set (docs/07 §9).');
    return NudgeController.connect(Number(env.AIPW_NUDGE_PORT), test, {
      breakLevel: (env.AIPW_NUDGE_BREAK as BreakLevel | undefined) ?? 'step',
      resumeAt: env.AIPW_NUDGE_RESUME_AT ? Number(env.AIPW_NUDGE_RESUME_AT) : 1,
    });
  }

  /** Breakpoints are suppressed while fast-forwarding to the rewind target. */
  private get fastForwarding(): boolean {
    return this.resumeAt > 1 && (this.current?.index ?? 0) < this.resumeAt;
  }

  private async pause(reason: PauseState['reason'], ctx: PauseContext): Promise<NudgeCommand> {
    for (;;) {
      const state: PauseState = {
        v: NUDGE_PROTOCOL_VERSION,
        reason,
        breakLevel: this.breakLevel,
        test: this.test,
        // A breakpoint before the first AI step has no step yet.
        step: this.current ?? { index: 0, id: 'start', kind: 'breakpoint', instruction: ctx.note ?? '', cached: false },
        ...ctx,
      };
      const id = this.nextId++;
      const cmd = await this.channel.request(id, { type: 'pause', id, state });
      if (cmd.cmd === 'break') {
        this.breakLevel = cmd.level; // change level, stay paused
        continue;
      }
      if (cmd.cmd === 'continue') {
        if (cmd.level) this.breakLevel = cmd.level;
        return { cmd: 'run' };
      }
      if (cmd.cmd === 'quit') throw new NudgeQuit();
      if (cmd.cmd === 'rewind') {
        this.channel.send({ type: 'rewind', toStep: cmd.toStep });
        throw new RewindSignal(cmd.toStep);
      }
      return cmd;
    }
  }

  /** Before each ai.* step (break level 'step'). */
  async beforeStep(step: StepInfo, ctx: PauseContext = { history: [] }): Promise<NudgeCommand> {
    this.current = { ...step, index: ++this.stepIndex };
    if (this.fastForwarding || this.breakLevel !== 'step') return { cmd: 'run' };
    return this.pause('step', ctx);
  }

  /** Before executing a decision (break level 'action'). */
  async beforeAction(ctx: PauseContext): Promise<NudgeCommand> {
    if (this.fastForwarding || this.breakLevel !== 'action') return { cmd: 'run' };
    return this.pause('decision', ctx);
  }

  /** The AI called fail, or a limit was hit: pause at every level except 'none' (docs/07 §2). */
  async onFail(ctx: PauseContext): Promise<NudgeCommand> {
    if (this.fastForwarding || this.breakLevel === 'none') return { cmd: 'skip' };
    return this.pause('fail', ctx);
  }

  /** ask_human: always pauses; the answer goes back to the model. */
  async ask(question: string, ctx: PauseContext): Promise<string> {
    const cmd = await this.pause('ask', { ...ctx, question });
    return cmd.cmd === 'answer' || cmd.cmd === 'hint' ? cmd.text : '(no answer)';
  }

  /** ai.nudge('…'): a code breakpoint, honoured at every level. */
  async breakpoint(note: string, ctx: PauseContext = { history: [] }): Promise<void> {
    if (this.fastForwarding) return;
    await this.pause('breakpoint', { ...ctx, note });
  }

  progress(text: string): void {
    this.channel.send({ type: 'progress', text });
  }

  close(): void {
    this.channel.close();
  }
}
