// The driver side of nudge (docs/07 §8): accepts the worker's connection, hands each PauseState to a UI and
// sends back the UI's command. UIs are pluggable: the terminal UI in @aipw/cli, a scripted one in tests.
import { createServer, type Server, type Socket } from 'node:net';
import { NudgeCommandSchema, WorkerMessageSchema, type NudgeCommand, type PauseState } from './protocol.js';

export interface NudgeUi {
  onHello?(test: { file: string; title: string }): void;
  onPause(state: PauseState): Promise<NudgeCommand>;
  onProgress?(text: string): void;
  onRewind?(toStep: number): void;
}

export class NudgeServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  /** The rewind target requested by the last session, if any (the driver relaunches the test). */
  pendingRewind?: number;
  /** Every pause seen, for the session summary. */
  readonly pauses: { state: PauseState; command: NudgeCommand }[] = [];

  constructor(private readonly ui: NudgeUi) {}

  async listen(port = 0): Promise<number> {
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('nudge server has no port');
    return address.port;
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const parsed = WorkerMessageSchema.safeParse(JSON.parse(line));
        if (!parsed.success) continue;
        const msg = parsed.data;
        if (msg.type === 'hello') this.ui.onHello?.(msg.test);
        else if (msg.type === 'progress') this.ui.onProgress?.(msg.text);
        else if (msg.type === 'rewind') {
          this.pendingRewind = msg.toStep;
          this.ui.onRewind?.(msg.toStep);
        } else if (msg.type === 'pause') {
          const command = NudgeCommandSchema.parse(await this.ui.onPause(msg.state));
          this.pauses.push({ state: msg.state, command });
          socket.write(`${JSON.stringify({ type: 'command', id: msg.id, command })}\n`);
        }
      }
    });
    socket.on('error', () => undefined);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

/** Answers pauses from a list, for tests and scripted demos. */
export class ScriptedUi implements NudgeUi {
  readonly seen: PauseState[] = [];

  constructor(private readonly answers: ((state: PauseState) => NudgeCommand)[]) {}

  async onPause(state: PauseState): Promise<NudgeCommand> {
    this.seen.push(state);
    const next = this.answers.shift();
    return next ? next(state) : { cmd: 'continue', level: 'none' };
  }
}
