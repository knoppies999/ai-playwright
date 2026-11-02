import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { LineReader } from '../src/nudge.js';

describe('LineReader (nudge prompts)', () => {
  it('keeps lines that arrive before a prompt, echoes piped input, and ends with undefined', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = '';
    output.on('data', (c) => (printed += String(c)));
    const reader = new LineReader(input, output);

    input.end('h use the Notifications section\nc\n');
    await new Promise((r) => setTimeout(r, 20)); // both lines and the end arrive before anyone asks

    await expect(reader.ask('nudge> ')).resolves.toBe('h use the Notifications section');
    await expect(reader.ask('nudge> ')).resolves.toBe('c');
    await expect(reader.ask('nudge> ')).resolves.toBeUndefined();
    expect(printed).toBe('nudge> h use the Notifications section\nnudge> c\nnudge> (end of input)\n');
    reader.close();
  });

  it('waits for a line that has not arrived yet', async () => {
    const input = new PassThrough();
    const reader = new LineReader(input, new PassThrough());
    const answer = reader.ask('> ');
    input.write('run\n');
    await expect(answer).resolves.toBe('run');
    reader.close();
  });
});
