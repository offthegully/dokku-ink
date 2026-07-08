# dokku-ink

A terminal dashboard and command cheat sheet for [Dokku](https://dokku.com/), built with [Ink](https://github.com/vadimdemedes/ink) and TypeScript. It runs **directly on your Dokku host** (or against one over SSH with `--ssh`) and gives you a Claude-Code-style TUI to see your apps, domains, SSL, processes, CPU/memory usage, config and datastore services at a glance — no web front-end to host, no service to expose.

The dashboard views are **read-only** — they only observe. Anything that changes state goes through the explicit `:` command line (see below), so nothing mutates your server unless you typed it.

```
 dokku-ink · my-server                        ↻ 12s   disk 61%   5 apps   LIVE
╭─────────────────────────────────────────────────────────────────────────────╮
│   NAME       STATUS     PROCESSES       CPU    MEM    SSL     DOMAIN        │
│ › blog       ● running  web×2 worker×1  2.8%   598M   LE ✔    blog.exam… +1 │
│   api        ● running  web×3           14%    913M   LE ✔    api.example.… │
│   staging    ○ stopped  web×1           —      —      none    staging.exam… │
╰─────────────────────────────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────────────────────────────╮
│  1 Overview  2 Domains & SSL  3 Processes  4 Config / Env  5 Logs  6 Serv…  │
│                                                                             │
│  blog  ● running   cpu 2.8% · mem 598M                                      │
│  DOMAINS  routing enabled              SSL CERTIFICATE                      │
│   • blog.example.com  ✔ cert            Status: LE ✔ · expires 27d          │
╰─────────────────────────────────────────────────────────────────────────────╯
 1-6 view  ←→ switch view  ↑↓ app  / filter  : command  c cheats  q quit
```

Every view shares one layout: a table on top (`↑`/`↓` selects a row) and the
pane below it showing the selected tab's detail for that row. Tabs 1–5 keep
the apps table on top; Services (6) swaps in the datastore services table
instead. `←`/`→` or the number keys switch tabs. The command cheat sheet isn't
live data, so it opens as an overlay (`c`) from any view.

## Why no REST API?

Dokku doesn't ship an official open-source REST API (Dokku Pro has a paid one, and there are unofficial community wrappers). Since this tool is meant to run **on the server**, the simplest and safest design is to shell out to the local `dokku` CLI directly. Dokku's report commands support machine-readable JSON output (`dokku <plugin>:report --format json`, clean keys since v0.38.0), so there's nothing to parse fragilely and nothing new to secure. If you later want remote/off-server access, a REST layer can be added — but you don't need one to use this.

## Requirements

- The `dokku` command available on `PATH` for the user running the tool
- **Nothing else** — the prebuilt binary is fully self-contained (no Node, no Bun, no runtime to install). Node.js 18+ is only needed if you run from source instead.

Without Dokku present (e.g. on your laptop), it automatically runs with **demo data** so you can try the interface.

## Install

The quickest way — a single self-contained binary, no Node or Bun required. This
is the recommended path on a Dokku host:

```bash
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | sh
```

This detects your OS/arch (Linux or macOS, x64 or arm64), downloads the matching
binary from the latest [GitHub Release](https://github.com/offthegully/dokku-ink/releases),
and installs it to `/usr/local/bin/dokku-ink` (falling back to `~/.local/bin` if
that isn't writable). Then just:

```bash
dokku-ink            # or: dokku-ink --demo   to preview without Dokku
```

<details>
<summary>Install options &amp; alternatives</summary>

**Pin a version or change the install location:**

```bash
# install a specific release tag instead of latest
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | DOKKU_INK_VERSION=v0.1.0 sh

# install somewhere else (e.g. no root, no sudo)
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | DOKKU_INK_INSTALL_DIR="$HOME/bin" sh
```

**Prefer to download the binary yourself?** Grab the asset for your platform
(`dokku-ink-<os>-<arch>`) from the [Releases page](https://github.com/offthegully/dokku-ink/releases),
`chmod +x` it, and drop it anywhere on your `PATH`.

**Run from source** (needs Node 18+ or Bun) — best for hacking on it:

```bash
git clone https://github.com/offthegully/dokku-ink.git
cd dokku-ink
npm install
npm run build          # compiles TypeScript -> dist/
node dist/index.js     # or: npm start   ·   or: npm link  for a global `dokku-ink`
```

**Build the standalone binary yourself** (needs Bun):

```bash
bun install
bun run build:binary       # -> ./build/dokku-ink for your current platform
bun run build:binaries     # -> all four release binaries in ./build
```

</details>

## Usage

```bash
dokku-ink                      # live dashboard (reads the local dokku CLI)
dokku-ink --ssh dokku@my-host  # remote dashboard over SSH (see below)
dokku-ink --demo               # sample data, no Dokku required
dokku-ink --help
```

## Remote mode (SSH)

You don't have to run it on the server. Point it at a host with `--ssh <dest>`
(or `DOKKU_INK_SSH=<dest>`) and every dokku invocation is executed remotely
over a multiplexed SSH connection (one handshake, reused for all commands):

```bash
dokku-ink --ssh dokku@my-host   # uses Dokku's own SSH user
dokku-ink --ssh ubuntu@my-host  # any user that can run `dokku` (and docker)
```

Two flavours, one trade-off:

- **`dokku@host`** — Dokku's restricted SSH user. Zero setup if your key is
  already authorized for deploys. Only dokku commands are possible, so the
  CPU/MEM columns and the header disk readout show `—`.
- **any other user** — commands run through a login shell, so `docker stats`
  and `df` work too and you get full metrics. The user needs access to the
  docker daemon (typically membership in the `docker` group).

Keys only (`BatchMode=yes`) — if the connection needs a password it fails fast
rather than hanging the UI. `--doctor` prints which target is active and
whether docker metrics are available.

## Running with Bun

Bun executes TypeScript directly, so **don't use `tsx` under Bun** — `tsx` is a
Node-only loader and running it via Bun fails with
`Cannot find module './cjs/index.cjs'`. Instead run the source (or the build)
with Bun itself:

```bash
bun install
bun run dev:bun          # dev from source:  bun src/index.tsx
bun run demo:bun         # demo from source: bun src/index.tsx --demo

# or build once and run the compiled output (most robust for a server):
bun run build            # tsc compiles to dist/
bun dist/index.js        # or: node dist/index.js
```

`bun run dev` / `bun run demo` intentionally use `tsx` (the Node path) and will
not work under Bun — use the `:bun` variants above. If the interactive UI ever
misbehaves under Bun, the compiled `node dist/index.js` path is the fallback.

### Keys

| Key            | Action                                        |
| -------------- | --------------------------------------------- |
| `1`–`6`        | Jump to a view                                |
| `↑` / `↓`      | Select the row in the top table (app, or service on tab 6) |
| `←` / `→` (`h`/`l`), `tab` | Switch view                       |
| `j` / `k`      | Scroll the detail pane (Logs scrollback, long Config lists) |
| `c`            | Open the command cheat sheet overlay; `enter` inserts the selected command into `:` |
| `esc`          | Close an overlay, cancel a prompt, kill a running command |
| `/`            | Filter the app list (or the cheat sheet); `esc` clears |
| `s`            | Reveal / hide secrets (Config values, service DSN) |
| `R` / `S` / `B`| Prefill restart / stop / rebuild for the selected app (never auto-runs) |
| `:`            | Open the command line (run any dokku command) |
| `r`            | Refresh data from Dokku                       |
| `?`            | Help overlay                                  |
| `q` / `Ctrl-C` | Quit                                          |

### Views

- **Overview** — the default tab: created date, deploy source, restart policy, git branch/SHA/last-deploy, port mappings, persistent storage mounts, docker networks and linked datastore services for the selected app.
- **Domains & SSL** — per-app vhosts, routing enabled/disabled, and certificate issuer + expiry (highlighted when expiring within 14 days).
- **Processes** — per-process scale and individual container statuses with per-container CPU/memory, plus restart policy.
- **Config / Env** — environment variables per app. **Values are masked by default**; press `s` to reveal. Use with care — env vars often contain secrets.
- **Logs** — live tail of `dokku logs <app> -t` for the selected app (last 500 lines kept; `j`/`k` for scrollback, stderr highlighted). Buffers are cached per app for 5 minutes, so switching apps or views and back keeps your history — the re-attach replay is deduped by timestamp instead of repeating.
- **Services** — datastore services from the official plugin family (postgres, redis, mysql, mongo, …) in the top table; the pane below shows the selected service's status, version, exposed ports, DSN (masked until you press `s`) and linked apps with their run state.
- **Cheat Sheet** (`c`, overlay) — a filterable reference of the most useful `dokku` commands, grouped by area. `enter` inserts the selected command into the `:` prompt (with `<app>` pre-substituted as `$app`) so it doubles as a launcher.

The Overview tab's drill-in reports (`git:report`, `ports:report`,
`storage:list`, `network:report`) are fetched lazily for whatever app is
selected and cached until the next full refresh, so holding `↑`/`↓` through
the table doesn't fire a report sweep per row.

### Running commands

Press `:` and type any dokku command (with or without the leading `dokku`) — e.g. `ps:restart $app`, `ps:scale api web=2`, `letsencrypt:auto-renew`. `$app` expands to the currently selected app. Output streams live into the content pane; `↑`/`↓` scrolls it, `esc` kills a running command or closes the result, and the dashboard refreshes automatically afterward so the views reflect what you just did. `↑`/`↓` at the prompt cycles this session's command history.

Safety properties worth knowing:

- The command is spawned directly (`dokku <args>`) — there is **no shell**, so quoting tricks, pipes and `;` do nothing.
- stdin is closed, so commands that normally prompt for confirmation (like `apps:destroy` without `--force`) abort instead of hanging — destroying something requires typing the same explicit flags the CLI would.

## Troubleshooting

If the dashboard shows no apps (or looks empty), run the built-in probe — it
prints exactly what your Dokku returns for each command and whether the tool
could parse it, without launching the TUI:

```bash
dokku-ink --doctor
# from source:  bun src/index.tsx --doctor   (or)   npx tsx src/index.tsx --doctor
```

The output shows `dokku version`, `apps:list`, and each `--format json` report,
plus the final normalized result (`loadOverview() -> source=…, apps=…`). If a
report says "NOT valid JSON" or a command FAILED, that pinpoints the mismatch
with your Dokku version.

## Configuration

| Env var             | Default    | Purpose                                  |
| ------------------- | ---------- | ---------------------------------------- |
| `DOKKU_INK_BIN`    | `dokku`    | Path to the `dokku` binary               |
| `DOKKU_INK_SSH`    | –          | Remote target, same as `--ssh` (e.g. `dokku@my-host`) |
| `DOKKU_INK_HOST`   | hostname   | Label shown in the header                |
| `DOKKU_INK_DEMO`   | –          | Set to `1` to force demo data            |
| `DOKKU_INK_REFRESH`| `30`       | Auto-refresh interval in seconds (`0` disables) |

## How it reads data

A **full refresh** (launch, `r`, pushed events, and every 5th poll) runs,
read-only:

- `dokku apps:list`
- then, per app (bounded concurrency): `dokku apps:report <app> --format json`, `dokku ps:report <app> --format json`, `dokku domains:report <app> --format json`, `dokku certs:report <app> --format json`
- plus `docker stats --no-stream` and `df -Pk /` for usage metrics (skipped gracefully when docker isn't reachable)

The polls in between are **light**: only `ps:report` (the one thing that
changes minute-to-minute) and `docker stats` re-run; domains/certs/metadata are
kept from the previous snapshot. That cuts subprocess churn ~75% without
visible staleness — anything that would change the skipped reports (a deploy, a
domain change) fires a full refresh through the events watcher anyway.

Config is loaded lazily per app via `dokku config:show <app>` (JSON when available), datastore services via `dokku plugin:list` + `<plugin>:list` + `<plugin>:info`, and the app-detail reports (`ports`, `git`, `network`, `storage:list`) only for the selected app — all silently refetched after each full refresh. Parsing is defensive: missing plugins or older Dokku versions degrade gracefully rather than crashing.

Three things make it feel live rather than polled:

- **Fast lane** — while the Processes view is open it polls every 10s (never slower than your configured cadence), so container status changes show up quickly.
- **Event push** — if Dokku's events log is enabled (`dokku events:on`), it also follows `dokku events -t` and refreshes within ~2s of a deploy, restart or scale. Without it, polling carries on alone; `--doctor` tells you which mode you're in.
- **Freshness readout** — the header shows `↻ 12s` (time since the last successful refresh), so the LIVE badge is verifiable at a glance.

## Development

```bash
npm run dev        # run from source with tsx (no build step)
npm run demo       # run from source with demo data
npm run typecheck  # tsc --noEmit
npm test           # unit + render tests (node:test)
npm run build      # emit dist/
```

Everything under `src/` is TypeScript; `dist/` holds the compiled output (git-ignored) and is what the `dokku-ink` bin runs.

Project layout:

```
src/
  index.tsx      entry point (shebang + flags + render)
  App.tsx        TUI: layout, navigation, views
  dokku.ts       data layer (dokku CLI -> normalized model) + demo fallback
  exec.ts        subprocess plumbing: local vs remote (SSH) invocation
  demo.ts        sample data used when dokku is absent
  cheatsheet.ts  curated command reference
  ui.ts          presentation helpers (badges, truncation, windowing)
  types.ts       shared types
test/            parsing + render tests
```

## Roadmap ideas

Read-only today by design (mutations only through the explicit `:` prompt).
Natural next steps: an activity feed from `dokku events -t` (already tailed for
refresh triggers), nginx access/error log views, `letsencrypt:cron-job` status,
and a host/system view (plugin versions, global domains, docker disk usage).

## License

MIT
