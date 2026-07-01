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
  --doctor       Probe the dokku CLI and print diagnostics (no TUI)
  -h, --help     Show this help
  -v, --version  Show version

KEYS (inside the dashboard)
  1-6            Jump to a view
  ↑ / ↓ (j/k)    Move within the focused pane (scrollback in Logs)
  ← / → (h/l)    Switch app (in per-app views)
  tab            Toggle focus between the menu and the list/content
  s              Reveal / hide values (Config view)
  r              Refresh data from Dokku
  q / Ctrl-C     Quit

ENV
  DOKKU_DASH_BIN      Path to the dokku binary (default: dokku)
  DOKKU_DASH_HOST     Label shown in the header (default: hostname)
  DOKKU_DASH_DEMO     Set to 1 to force demo data
  DOKKU_DASH_REFRESH  Auto-refresh interval in seconds (default: 30, 0 = off)

Run this directly on your Dokku host; it shells out to the local
\`dokku\` CLI (read-only) — no REST API or extra services needed.`);
}
