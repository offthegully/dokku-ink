#!/usr/bin/env node
// Entry point: parse a couple of flags, then render the Ink app.

import { createRequire } from 'node:module';
import { render } from 'ink';
import App from './App.js';

// Works from both src/ (tsx/bun) and dist/ (compiled) — one level below the
// package root either way.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(`dokku-dash ${version}`);
  process.exit(0);
}
// --ssh <dest> must land in the env before the first dokku call (the exec
// layer resolves its target lazily, so setting it here is early enough).
const sshIdx = args.indexOf('--ssh');
if (sshIdx !== -1) {
  const dest = args[sshIdx + 1];
  if (!dest || dest.startsWith('-')) {
    console.error('--ssh needs a destination, e.g. --ssh dokku@my-host');
    process.exit(1);
  }
  process.env.DOKKU_DASH_SSH = dest;
}
if (args.includes('--doctor') || args.includes('doctor')) {
  const { runDoctor } = await import('./dokku.js');
  console.log(await runDoctor());
  process.exit(0);
}
if (args.includes('--demo')) {
  process.env.DOKKU_DASH_DEMO = '1';
}

if (!process.stdout.isTTY && process.env.DOKKU_DASH_DEMO !== '1') {
  console.error(
    'dokku-dash needs an interactive terminal. Try `dokku-dash --demo` to preview, or run it in a real TTY.',
  );
  process.exit(1);
}

const { waitUntilExit } = render(<App />, { exitOnCtrlC: false });
await waitUntilExit();

function printHelp(): void {
  console.log(`dokku-dash — a terminal dashboard & cheat sheet for Dokku

USAGE
  dokku-dash [options]

OPTIONS
  --demo         Show demo data (no Dokku required)
  --ssh <dest>   Run against a remote host over SSH (e.g. dokku@my-host);
                 use a non-dokku user to also get docker CPU/MEM metrics
  --doctor       Probe the dokku CLI and print diagnostics (no TUI)
  -h, --help     Show this help
  -v, --version  Show version

KEYS (inside the dashboard)
  1-7            Jump to a view
  ↑ / ↓ (j/k)    Move within the focused pane (scrollback in Logs)
  ← / → (h/l)    Switch app (in per-app views)
  enter          Open the app detail drill-in; insert a cheat-sheet command
  tab            Toggle focus between the menu and the list/content
  /              Filter the app list (or the cheat sheet); esc clears
  s              Reveal / hide secrets (Config values, service DSN)
  R / S / B      Prefill restart / stop / rebuild for the selected app
  :              Open the command line (run any dokku command;
                 $app expands to the selected app, esc cancels/kills)
  r              Refresh data from Dokku
  ?              Help overlay
  q / Ctrl-C     Quit

ENV
  DOKKU_DASH_BIN      Path to the dokku binary (default: dokku)
  DOKKU_DASH_SSH      Remote target, same as --ssh (e.g. dokku@my-host)
  DOKKU_DASH_HOST     Label shown in the header (default: hostname)
  DOKKU_DASH_DEMO     Set to 1 to force demo data
  DOKKU_DASH_REFRESH  Auto-refresh interval in seconds (default: 30, 0 = off)

Run this on your Dokku host (or point --ssh at one); it shells out to
the \`dokku\` CLI (read-only) — no REST API or extra services needed.`);
}
