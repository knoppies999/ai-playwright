#!/usr/bin/env node
import { VERSION } from './index.js';

// Commands from docs/09 §4. Each one lands with the phase that needs it.
const COMMANDS: Record<string, string> = {
  nudge: 'Phase 6',
  doctor: 'Phase 3',
  cache: 'Phase 4',
  hints: 'Phase 6',
  conformance: 'Phase 3',
};

const HELP = `aipw ${VERSION}

Usage: aipw <command> [options]

Commands:
${Object.entries(COMMANDS)
  .map(([name, phase]) => `  ${name.padEnd(12)} (not implemented yet: ${phase})`)
  .join('\n')}

Options:
  --version    Print the version
  --help       Print this help`;

const [command] = process.argv.slice(2);

if (command === undefined || command === '--help' || command === 'help') {
  console.log(HELP);
} else if (command === '--version') {
  console.log(VERSION);
} else if (command in COMMANDS) {
  console.error(`aipw ${command} is not implemented yet (${COMMANDS[command]}).`);
  process.exitCode = 2;
} else {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
}
