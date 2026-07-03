// Subprocess plumbing: local vs remote (SSH) invocation.
//
// Every dokku/docker call in the data layer goes through here, so the whole
// dashboard can run either directly on the Dokku host or from a laptop with
// DOKKU_INK_SSH=<dest> (or --ssh <dest>) set:
//
//   dokku@host  — Dokku's own SSH user. The server forces the `dokku` command,
//                 so we send the subcommand words directly ("apps:list").
//                 Host-level commands (docker stats, df) are unavailable.
//   user@host   — any other user. We prefix `dokku` / run docker directly;
//                 metrics work if the user can talk to the docker daemon.
//
// ControlMaster multiplexing keeps one TCP/auth handshake alive across the
// dashboard's many short-lived invocations; BatchMode makes a missing key
// fail fast instead of hanging the TUI on a password prompt.

import { tmpdir } from "node:os";
import { join } from "node:path";

export const DOKKU_BIN = () => process.env.DOKKU_INK_BIN || "dokku";

interface SshTarget {
  dest: string;
  dokkuUser: boolean;
}

// Resolved lazily (not at module load) so index.tsx can set the env var from
// a --ssh flag before the first dokku call happens.
let _ssh: SshTarget | null | undefined;

function sshTarget(): SshTarget | null {
  if (_ssh !== undefined) return _ssh;
  const dest = process.env.DOKKU_INK_SSH?.trim();
  _ssh = dest ? { dest, dokkuUser: dest.startsWith("dokku@") } : null;
  return _ssh;
}

export function isRemote(): boolean {
  return sshTarget() !== null;
}

export function remoteLabel(): string | null {
  return sshTarget()?.dest ?? null;
}

const sshOpts = () => [
  "-T",
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${join(tmpdir(), "dokku-ink-%C")}`,
  "-o", "ControlPersist=120",
];

// Remote args pass through the remote login shell — single-quote each word so
// values with spaces/globs/quotes survive intact.
const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

export interface Invocation {
  cmd: string;
  argv: string[];
}

// How to run `dokku <args>` against the configured target.
export function dokkuInvocation(args: string[]): Invocation {
  const t = sshTarget();
  if (!t) return { cmd: DOKKU_BIN(), argv: args };
  const remote = t.dokkuUser ? args : ["dokku", ...args];
  return {
    cmd: "ssh",
    argv: [...sshOpts(), t.dest, "--", remote.map(shq).join(" ")],
  };
}

// How to run a non-dokku host command (docker stats, df). Returns null when
// the target can't run them (SSH as the restricted dokku user).
export function hostInvocation(command: string[]): Invocation | null {
  const t = sshTarget();
  if (!t) return { cmd: command[0], argv: command.slice(1) };
  if (t.dokkuUser) return null;
  return {
    cmd: "ssh",
    argv: [...sshOpts(), t.dest, "--", command.map(shq).join(" ")],
  };
}
