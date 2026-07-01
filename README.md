# dokku-dash

A terminal dashboard and command cheat sheet for [Dokku](https://dokku.com/), built with [Ink](https://github.com/vadimdemedes/ink) and TypeScript. It runs **directly on your Dokku host** and gives you a Claude-Code-style TUI to see your apps, domains, SSL, processes and config at a glance — no web front-end to host, no service to expose.

This first version is **read-only**: it visualizes state and ships a built-in cheat sheet. It does not change anything on the server.

```
 dokku-dash · my-server                                       5 apps   LIVE
╭──────────────────╮╭───────────────────────────────────────────────────────╮
│ VIEWS            ││ APPS                                                  │
│ › 1 Apps         ││ NAME        STATUS    PROCESSES      SSL    DOMAIN     │
│   2 Domains & SSL││ blog        ● running web×2 worker×1 LE ✔   blog.…  +1 │
│   3 Processes    ││ api         ● running web×3          LE ✔   api.example│
│   4 Config / Env ││ staging     ○ stopped web×1          none   staging.…  │
│   5 Logs         ││ metrics     ● running web×1          LE 4d… metrics.…  │
│   6 Cheat Sheet  ││                                                        │
╰──────────────────╯╰───────────────────────────────────────────────────────╯
 1-6 view   tab focus list   ↑↓ change view   r refresh   q quit
```

## Why no REST API?

Dokku doesn't ship an official open-source REST API (Dokku Pro has a paid one, and there are unofficial community wrappers). Since this tool is meant to run **on the server**, the simplest and safest design is to shell out to the local `dokku` CLI directly. Dokku's report commands support machine-readable JSON output (`dokku <plugin>:report --format json`, clean keys since v0.38.0), so there's nothing to parse fragilely and nothing new to secure. If you later want remote/off-server access, a REST layer can be added — but you don't need one to use this.

## Requirements

- Node.js 18+ on the Dokku host
- The `dokku` command available on `PATH` for the user running the tool

Without Dokku present (e.g. on your laptop), it automatically runs with **demo data** so you can try the interface.

## Install

```bash
git clone <your-repo> dokku-dash
cd dokku-dash
npm install      # installs deps
npm run build    # compiles TypeScript -> dist/
```

Then run it:

```bash
node dist/index.js     # or: npm start
```

Optionally make it a global `dokku-dash` command:

```bash
npm link         # or: npm install -g .
dokku-dash
```

## Usage

```bash
dokku-dash            # live dashboard (reads the local dokku CLI)
dokku-dash --demo     # sample data, no Dokku required
dokku-dash --help
```

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
| `↑` / `↓` (`j`/`k`) | Move within the focused pane (scrollback in Logs) |
| `←` / `→` (`h`/`l`) | Switch app (in per-app views)            |
| `tab`          | Toggle focus between the menu and the list    |
| `s`            | Reveal / hide values (Config view)            |
| `r`            | Refresh data from Dokku                       |
| `q` / `Ctrl-C` | Quit                                          |

### Views

- **Apps** — every app with run status, process types × scale, SSL summary and primary domain.
- **Domains & SSL** — per-app vhosts, routing enabled/disabled, and certificate issuer + expiry (highlighted when expiring within 14 days).
- **Processes** — per-process scale and individual container statuses, plus restart policy.
- **Config / Env** — environment variables per app. **Values are masked by default**; press `s` to reveal. Use with care — env vars often contain secrets.
- **Logs** — live tail of `dokku logs <app> -t` for the selected app (last 500 lines kept; `↑`/`↓` for scrollback, stderr highlighted). Buffers are cached per app for 5 minutes, so switching apps or views and back keeps your history — the re-attach replay is deduped by timestamp instead of repeating.
- **Cheat Sheet** — a scrollable reference of the most useful `dokku` commands, grouped by area.

## Troubleshooting

If the dashboard shows no apps (or looks empty), run the built-in probe — it
prints exactly what your Dokku returns for each command and whether the tool
could parse it, without launching the TUI:

```bash
dokku-dash --doctor
# from source:  bun src/index.tsx --doctor   (or)   npx tsx src/index.tsx --doctor
```

The output shows `dokku version`, `apps:list`, and each `--format json` report,
plus the final normalized result (`loadOverview() -> source=…, apps=…`). If a
report says "NOT valid JSON" or a command FAILED, that pinpoints the mismatch
with your Dokku version.

## Configuration

| Env var             | Default    | Purpose                                  |
| ------------------- | ---------- | ---------------------------------------- |
| `DOKKU_DASH_BIN`    | `dokku`    | Path to the `dokku` binary               |
| `DOKKU_DASH_HOST`   | hostname   | Label shown in the header                |
| `DOKKU_DASH_DEMO`   | –          | Set to `1` to force demo data            |
| `DOKKU_DASH_REFRESH`| `30`       | Auto-refresh interval in seconds (`0` disables) |

## How it reads data

On launch, on `r`, and every `DOKKU_DASH_REFRESH` seconds (background, no
spinner) it runs, read-only:

- `dokku apps:list`
- then, per app (bounded concurrency): `dokku apps:report <app> --format json`, `dokku ps:report <app> --format json`, `dokku domains:report <app> --format json`, `dokku certs:report <app> --format json`

Config is loaded lazily per app via `dokku config:show <app>` (JSON when available) and silently refetched after each refresh, so the Config view tracks reality too. Parsing is defensive: missing plugins or older Dokku versions degrade gracefully rather than crashing.

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

Everything under `src/` is TypeScript; `dist/` holds the compiled output (git-ignored) and is what the `dokku-dash` bin runs.

Project layout:

```
src/
  index.tsx      entry point (shebang + flags + render)
  App.tsx        TUI: layout, navigation, views
  dokku.ts       data layer (dokku CLI -> normalized model) + demo fallback
  demo.ts        sample data used when dokku is absent
  cheatsheet.ts  curated command reference
  ui.ts          presentation helpers (badges, truncation, windowing)
  types.ts       shared types
test/            parsing + render tests
```

## Roadmap ideas

Read-only today by design. Natural next steps: datastore/service views (postgres/redis), one-key actions (restart/rebuild) behind a confirmation, and an optional remote mode via a small API on the host.

## License

MIT
