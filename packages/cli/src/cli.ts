#!/usr/bin/env node
// The aipw CLI: the commands in docs/09 §4.
import { runCacheCommand } from './cache.js';
import { runConformance } from './conformance.js';
import { runDoctor } from './doctor.js';
import { commandHelp, HELP, isCommand, wantsHelp } from './help.js';
import { runHintsCommand } from './hints.js';
import { runInit } from './init.js';
import { VERSION } from './index.js';
import { runNudge } from './nudge.js';
import { runSummaryCommand } from './summary.js';
import { runTry } from './try.js';

const [command] = process.argv.slice(2);
const rest = process.argv.slice(3);

const RUN: Record<string, (args: string[]) => number | Promise<number>> = {
  try: runTry,
  init: (args) => runInit(args),
  nudge: runNudge,
  cache: (args) => runCacheCommand(args),
  doctor: runDoctor,
  conformance: runConformance,
  hints: runHintsCommand,
  summary: runSummaryCommand,
};

if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
  // `aipw help cache` is `aipw cache --help`.
  const topic = command === 'help' ? rest[0] : undefined;
  console.log(topic && isCommand(topic) ? commandHelp(topic) : HELP);
} else if (command === '--version' || command === '-v') {
  console.log(VERSION);
} else if (isCommand(command)) {
  // --help never runs the command: `aipw init --help` must not write files.
  if (wantsHelp(rest)) console.log(commandHelp(command));
  else process.exitCode = await RUN[command]!(rest);
} else {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
}
