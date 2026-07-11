#!/usr/bin/env node
// Entry point: parse a couple of flags, then render the Ink app.

import { createRequire } from 'node:module';
import { render } from 'ink';
import App from './App.js';

// The version is baked in at compile time for the standalone binary (see
// scripts/build.ts, which replaces __DOKKU_INK_VERSION__ via --define). When
// running from src/ (tsx/bun) or dist/ (node) that token is undefined, so we
// fall back to reading package.json one level above the entry point.
declare const __DOKKU_INK_VERSION__: string | undefined;
const version =
  typeof __DOKKU_INK_VERSION__ !== 'undefined'
    ? __DOKKU_INK_VERSION__
    : (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(`dokku-ink ${version}`);
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
  process.env.DOKKU_INK_SSH = dest;
}
if (args.includes('--doctor') || args.includes('doctor')) {
  const { runDoctor } = await import('./dokku.js');
  console.log(await runDoctor());
  process.exit(0);
}
if (args.includes('--demo')) {
  process.env.DOKKU_INK_DEMO = '1';
}

if (!process.stdout.isTTY && process.env.DOKKU_INK_DEMO !== '1') {
  console.error(
    'dokku-ink needs an interactive terminal. Try `dokku-ink --demo` to preview, or run it in a real TTY.',
  );
  process.exit(1);
}

// Ink repaints the whole frame on every render (freshness tick, poll results,
// lazy detail loads), and the erase-then-rewrite is visible as flicker on many
// terminals. Wrapping each write in DEC 2026 "synchronized output" markers
// makes supporting terminals (iTerm2, Ghostty, Kitty, WezTerm, …) buffer the
// repaint and swap it in atomically; others ignore the markers unharmed.
const syncStdout = process.stdout.isTTY
  ? (new Proxy(process.stdout, {
      get(target, prop) {
        if (prop === 'write') {
          return (chunk: string | Uint8Array, ...rest: unknown[]) =>
            (target.write as (...args: unknown[]) => boolean)(
              `\u001B[?2026h${chunk}\u001B[?2026l`,
              ...rest,
            );
        }
        const value = target[prop as keyof typeof target];
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as NodeJS.WriteStream)
  : process.stdout;

const { waitUntilExit } = render(<App version={version} />, { stdout: syncStdout, exitOnCtrlC: false });
await waitUntilExit();

function printHelp(): void {
  console.log(`dokku-ink — a terminal dashboard & cheat sheet for Dokku

USAGE
  dokku-ink [options]

OPTIONS
  --demo         Show demo data (no Dokku required)
  --ssh <dest>   Run against a remote host over SSH (e.g. dokku@my-host);
                 use a non-dokku user to also get docker CPU/MEM metrics
  --doctor       Probe the dokku CLI and print diagnostics (no TUI)
  -h, --help     Show this help
  -v, --version  Show version

KEYS (inside the dashboard)
  1-7            Jump to a view
  ↑ / ↓          Select the app in the table (move in Services/Cheat Sheet)
  ← / → (h/l)    Switch view (tab / shift-tab too)
  j / k          Scroll the detail pane (Logs scrollback, long Config lists)
  enter          Insert a cheat-sheet command into the : prompt
  /              Filter the app list (or the cheat sheet); esc clears
  s              Reveal / hide secrets (Config values, service DSN)
  R / S / B      Prefill restart / stop / rebuild for the selected app
  :              Open the command line (run any dokku command;
                 $app expands to the selected app, esc cancels/kills)
  r              Refresh data from Dokku
  ?              Help overlay
  q / Ctrl-C     Quit

ENV
  DOKKU_INK_BIN      Path to the dokku binary (default: dokku)
  DOKKU_INK_SSH      Remote target, same as --ssh (e.g. dokku@my-host)
  DOKKU_INK_HOST     Label shown in the header (default: hostname)
  DOKKU_INK_DEMO     Set to 1 to force demo data
  DOKKU_INK_REFRESH  Auto-refresh interval in seconds (default: 30, 0 = off)
  DOKKU_INK_NO_UPDATE_CHECK  Set to disable the on-launch new-release check

Run this on your Dokku host (or point --ssh at one); it shells out to
the \`dokku\` CLI (read-only) — no REST API or extra services needed.`);
}
