# dokku-ink

A terminal dashboard and command center for [Dokku](https://dokku.com/). One self-contained binary that runs on your Dokku host (or points at one over SSH) and shows everything in one live view — apps, processes, CPU/memory, domains, SSL, config, logs and datastore services — with a built-in command line and cheat sheet so you can manage it all from the same screen. No web UI to host, no service to expose, nothing else to install.

```
 dokku-ink · my-server                        ↻ 12s   disk 61%   5 apps   LIVE
╭─────────────────────────────────────────────────────────────────────────────╮
│   NAME       STATUS     PROCESSES       CPU    MEM    SSL     DOMAIN        │
│ › blog       ● running  web×2 worker×1  2.8%   598M   LE ✔    blog.exam… +1 │
│   api        ● running  web×3           14%    913M   LE ✔    api.example.… │
│   staging    ○ stopped  web×1           —      —      none    staging.exam… │
╰─────────────────────────────────────────────────────────────────────────────╯
╭─────────────────────────────────────────────────────────────────────────────╮
│  1 Overview   2 Processes   3 Config / Env   4 Logs   5 Services            │
│                                                                             │
│  blog  ● running   cpu 2.8% · mem 598M                                      │
│  DOMAINS  routing enabled              SSL                                  │
│   • blog.example.com  ✓ cert            LE ✔ · expires in 27d               │
╰─────────────────────────────────────────────────────────────────────────────╯
 1-5 view  ←→ switch view  ↑↓ app  / filter  R/S/B actions  : command  q quit
```

## What it does

- **Everything at a glance** — every app's run state, process scale, per-container CPU/memory, domains, certificate expiry, port mappings, storage mounts and linked databases, in one table you navigate with arrow keys.
- **Run any Dokku command without leaving** — press `:` and type it (`ps:scale api web=2`, `letsencrypt:auto-renew`, anything). `$app` expands to the selected app, output streams live into the pane, and the dashboard refreshes itself afterward so you immediately see the result.
- **One-key actions** — `R`/`S`/`B` prefill restart / stop / rebuild for the selected app; you just hit enter to run it.
- **A cheat sheet that's also a launcher** — press `c` for a filterable reference of the most useful Dokku commands, grouped by area. Hit enter on any of them to drop it into the command line, pre-filled with the selected app.
- **Live tail of logs** — per-app log streaming with scrollback, stderr highlighted.
- **Datastore services too** — postgres, redis, mysql, mongo and friends: status, version, exposed ports, connection string and which apps they're linked to.
- **Guardrails built in** — destructive commands (`ps:stop`, `apps:destroy`, `config:unset`, …) ask for a y/N confirmation before running. Commands are spawned directly with no shell, so pipes and `;` tricks do nothing, and anything that would normally prompt for confirmation aborts instead of hanging.
- **Secrets stay masked** — env var values and database connection strings are hidden until you press `s`.
- **Feels live, not polled** — auto-refresh plus Dokku's events stream (when enabled) means deploys, restarts and scale changes show up within seconds, and the header tells you exactly how fresh the data is.
- **Works anywhere** — on the host itself, against a remote host over SSH, or with `--demo` sample data so you can try it without Dokku at all.

## Get it

One command — it detects your OS/arch (Linux or macOS, x64 or arm64), grabs the matching binary from the latest [release](https://github.com/offthegully/dokku-ink/releases), and installs it to `/usr/local/bin` (falling back to `~/.local/bin`):

```bash
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | sh
```

Then:

```bash
dokku-ink            # live dashboard on a Dokku host
dokku-ink --demo     # try it anywhere, no Dokku needed
```

The binary is fully self-contained — no Node, no Bun, no runtime to install. The only requirement for live data is the `dokku` command on your `PATH` (or an SSH target that has it, see below). Without Dokku present it falls back to demo data automatically.

<details>
<summary>Other ways to install</summary>

**Pin a version or change the install location:**

```bash
# install a specific release tag instead of latest
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | DOKKU_INK_VERSION=v0.1.0 sh

# install somewhere else (e.g. no root, no sudo)
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | DOKKU_INK_INSTALL_DIR="$HOME/bin" sh
```

**Download the binary yourself:** grab `dokku-ink-<os>-<arch>` from the [releases page](https://github.com/offthegully/dokku-ink/releases), `chmod +x` it, and drop it anywhere on your `PATH`.

**Run from source** (needs Node 18+):

```bash
git clone https://github.com/offthegully/dokku-ink.git
cd dokku-ink
npm install && npm run build
npm link             # global `dokku-ink`, or: node dist/index.js
```

</details>

## Usage

```bash
dokku-ink                      # live dashboard (local dokku CLI)
dokku-ink --ssh dokku@my-host  # remote dashboard over SSH
dokku-ink --demo               # sample data, no Dokku required
dokku-ink --doctor             # print diagnostics without the TUI
dokku-ink --help
```

### Don't want to run it on the server?

Point it at a host with `--ssh <dest>` (or `DOKKU_INK_SSH=<dest>`) and everything runs remotely over a single multiplexed SSH connection:

```bash
dokku-ink --ssh dokku@my-host   # Dokku's own SSH user — zero setup if your
                                # deploy key is already authorized
dokku-ink --ssh ubuntu@my-host  # any user that can run `dokku`
```

The trade-off: `dokku@host` is Dokku's restricted user, so only dokku commands work — the CPU/MEM columns and disk readout show `—`. Any other user (with docker access, typically the `docker` group) gets full metrics too. Connections are key-only; a password prompt fails fast instead of hanging the UI.

## The dashboard

Five views, all sharing the same layout: a table on top (`↑`/`↓` selects a row), detail for the selected row below. Switch with the number keys, `←`/`→`, or `tab`.

1. **Overview** — the works for the selected app: created date, deploy source, git branch/SHA/last-deploy, restart policy, port mappings, storage mounts, linked services, plus its domains and SSL certificate status (issuer and expiry, highlighted when expiring soon).
2. **Processes** — per-process scale and each container's status, CPU and memory.
3. **Config / Env** — environment variables, values masked until you press `s`.
4. **Logs** — live tail for the selected app, `j`/`k` for scrollback, stderr highlighted. Buffers are kept per app, so flipping between apps doesn't lose your place.
5. **Services** — datastore services from the official plugin family (postgres, redis, mysql, mongo, …) with status, version, ports, connection string (`s` to reveal) and linked apps.

The **cheat sheet** (`c`) opens as an overlay from any view — a filterable reference covering apps, deploys, scaling, domains, Let's Encrypt, config, logs, datastores, storage and maintenance. Enter inserts the highlighted command into the `:` prompt.

## Running commands

Press `:` and type any dokku command, with or without the leading `dokku`:

```
:ps:restart $app
:ps:scale api web=2
:letsencrypt:auto-renew
```

- `$app` expands to the currently selected app.
- Output streams live; `↑`/`↓` scrolls it, `esc` kills a running command or closes the result.
- `↑`/`↓` at the prompt cycles your command history.
- Destructive commands (restart, stop, rebuild, destroy, `domains:clear`, `config:unset`) show a y/N confirmation first — whether you typed them, used a quick-action key, or picked them from the cheat sheet.
- The dashboard refreshes automatically afterward, so the views reflect what you just did.

## Keys

| Key            | Action                                        |
| -------------- | --------------------------------------------- |
| `1`–`5`        | Jump to a view                                |
| `↑` / `↓`      | Select the app (or service) in the table      |
| `←` / `→` (`h`/`l`), `tab` | Switch view                       |
| `j` / `k`      | Scroll the detail pane (log scrollback, long config lists) |
| `:`            | Open the command line                         |
| `R` / `S` / `B`| Prefill restart / stop / rebuild for the selected app |
| `c`            | Command cheat sheet; `enter` inserts into `:` |
| `/`            | Filter the app list (or the cheat sheet)      |
| `s`            | Reveal / hide secrets (config values, service DSN) |
| `r`            | Refresh now                                   |
| `esc`          | Close an overlay, cancel a prompt, kill a running command |
| `?`            | Help                                          |
| `q` / `Ctrl-C` | Quit                                          |

## Configuration

| Env var             | Default    | Purpose                                  |
| ------------------- | ---------- | ---------------------------------------- |
| `DOKKU_INK_BIN`     | `dokku`    | Path to the `dokku` binary               |
| `DOKKU_INK_SSH`     | –          | Remote target, same as `--ssh` (e.g. `dokku@my-host`) |
| `DOKKU_INK_HOST`    | hostname   | Label shown in the header                |
| `DOKKU_INK_DEMO`    | –          | Set to `1` to force demo data            |
| `DOKKU_INK_REFRESH` | `30`       | Auto-refresh interval in seconds (`0` disables) |
| `DOKKU_INK_NO_UPDATE_CHECK` | – | Disable the on-launch check for a newer release (also honors `NO_UPDATE_NOTIFIER`) |

## Troubleshooting

If the dashboard shows no apps or looks empty, run the built-in probe:

```bash
dokku-ink --doctor
```

It prints exactly what your Dokku returns for each command and whether it could be parsed — `dokku version`, `apps:list`, each JSON report, and the final result — so a failing command or a version mismatch is pinpointed immediately. It also tells you whether docker metrics are available and whether event-driven refresh is active. Dokku 0.38+ gives the cleanest data; older versions degrade gracefully.

## License

MIT
