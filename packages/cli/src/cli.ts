#!/usr/bin/env node
// The aipw CLI: the commands in docs/09 §4.
import { runCacheCommand } from './cache.js';
import { runConformance } from './conformance.js';
import { runDoctor } from './doctor.js';
import { runHintsCommand } from './hints.js';
import { VERSION } from './index.js';
import { runNudge } from './nudge.js';
import { runSummaryCommand } from './summary.js';

const HELP = `aipw ${VERSION}

Usage: aipw <command> [options]

Commands:
  nudge        <spec[:line]> [--break step|action|fail|none] [--at N] [--fresh] [--verify all|none]
  cache        stats | show <spec> | prune [--dry-run] | refresh <spec> [--grep x]
  doctor       [--provider x] [--probe]
  conformance  --provider x [--project saucedemo-llm] [--out docs/conformance]
  hints        lint [dir]
  summary      [--max-llm-calls N] [--max-cost USD] [--file .aipw/summary.json]

Options:
  --version    Print the version
  --help       Print this help`;

const [command] = process.argv.slice(2);
const rest = process.argv.slice(3);

if (command === undefined || command === '--help' || command === 'help') {
  console.log(HELP);
} else if (command === '--version') {
  console.log(VERSION);
} else if (command === 'nudge') {
  process.exitCode = await runNudge(rest);
} else if (command === 'cache') {
  process.exitCode = runCacheCommand(rest);
} else if (command === 'doctor') {
  process.exitCode = await runDoctor(rest);
} else if (command === 'conformance') {
  process.exitCode = await runConformance(rest);
} else if (command === 'hints') {
  process.exitCode = runHintsCommand(rest);
} else if (command === 'summary') {
  process.exitCode = runSummaryCommand(rest);
} else {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
}
