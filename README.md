# dokku-ink

A terminal dashboard for [Dokku](https://dokku.com/). It's a single self-contained binary that runs on your Dokku host (or connects to one over SSH). It shows your apps, processes, CPU/memory, domains, SSL, config, logs and datastore services in one live view, and you can run any Dokku command from the same screen. There's no web UI to host and nothing else to install.

```
 dokku-ink · my-server                        ↻ 12s   disk 61%   3 apps   LIVE
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

- **See everything at once.** Each app's run state, process scale, CPU/memory, domains, certificate expiry, health checks, linked databases and more, in one table you move through with the arrow keys.
- **Run any Dokku command in place.** Press `:` and type it. `$app` expands to the selected app, output streams live, and the dashboard refreshes afterward. `R`/`S`/`B` prefill restart/stop/rebuild, and `c` opens a searchable cheat sheet of common commands.
- **Safe by default.** Destructive commands ask for confirmation. Secrets stay masked until you press `s`. Commands run without a shell, so pipes and `;` do nothing.
- **Stays current.** It refreshes on a timer and, if you've run `dokku events:on`, within seconds of a deploy or restart. On most hosts a refresh makes the same number of `dokku` calls however many apps you have, so it stays fast over SSH.

## Get it

This detects your OS and architecture (Linux or macOS, x64 or arm64), downloads the matching binary from the latest [release](https://github.com/offthegully/dokku-ink/releases), and installs it to `/usr/local/bin` (or `~/.local/bin` if that isn't writable):

```bash
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | sh
```

The binary needs no Node or Bun. For live data it only needs the `dokku` command on your `PATH`, or an SSH target that has it. Without Dokku it shows demo data.

<details>
<summary>Other ways to install</summary>

**Pin a version or change the install location:**

```bash
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | DOKKU_INK_VERSION=v0.1.6 sh
curl -fsSL https://raw.githubusercontent.com/offthegully/dokku-ink/main/install.sh | DOKKU_INK_INSTALL_DIR="$HOME/bin" sh
```

**Download it yourself:** grab `dokku-ink-<os>-<arch>` from the [releases page](https://github.com/offthegully/dokku-ink/releases), `chmod +x` it, and put it on your `PATH`.

**From source** (needs Node 18+):

```bash
git clone https://github.com/offthegully/dokku-ink.git
cd dokku-ink
npm install && npm run build
npm link             # global `dokku-ink`, or: node dist/index.js
```

</details>

## Usage

```bash
dokku-ink                      # on a Dokku host
dokku-ink --ssh dokku@my-host  # against a remote host over SSH
dokku-ink --demo               # sample data, no Dokku needed
dokku-ink --doctor             # print diagnostics and exit
```

### Over SSH

`--ssh <dest>` (or `DOKKU_INK_SSH=<dest>`) runs everything on the remote host over one shared SSH connection. It needs key-based auth; if SSH would ask for a password, it fails straight away rather than hanging.

- `dokku@my-host` works with no setup if your deploy key is authorized. It's Dokku's restricted user, though, so the CPU/MEM columns and disk usage show `—`.
- Any other user that can run `dokku` and `docker` (e.g. `ubuntu@my-host` in the `docker` group) gets full metrics.

## The dashboard

Each view has the app table on top and details for the selected app below.

1. **Overview**: deploy info, restart policy, ports, storage, resource limits, linked services, domains and SSL expiry.
2. **Processes**: each container's status, CPU and memory, with the scale you asked for next to what's actually running.
3. **Config / Env**: environment variables, masked until you press `s`.
4. **Logs**: live tail with scrollback (`j`/`k`).
5. **Services**: postgres, redis, mysql, mongo and other datastore plugins, with status, version, connection string and linked apps.

### Keys

| Key                        | Action                                                  |
| -------------------------- | ------------------------------------------------------- |
| `1`–`5`, `←`/`→`, `tab`    | Switch view                                             |
| `↑` / `↓`                  | Select an app (or service)                              |
| `j` / `k`                  | Scroll the detail pane                                  |
| `/`                        | Filter the app list (or the cheat sheet)                |
| `:`                        | Run a dokku command (`↑`/`↓` for history, `esc` to stop) |
| `R` / `S` / `B`            | Prefill restart / stop / rebuild for the selected app   |
| `F` / `I`                  | Prefill `logs:failed` / `ps:inspect`                    |
| `c`                        | Cheat sheet; `enter` copies a command into `:`          |
| `s`                        | Show / hide secrets                                     |
| `r`                        | Refresh now                                             |
| `?`                        | Help                                                    |
| `q` / `Ctrl-C`             | Quit                                                    |

At the `:` prompt the leading `dokku` is optional, so `:ps:scale api web=2` works. Restart, stop, rebuild, `apps:destroy`, `domains:clear` and `config:unset` ask y/N first.

## Configuration

| Env var                     | Default  | Purpose                                              |
| --------------------------- | -------- | ---------------------------------------------------- |
| `DOKKU_INK_REFRESH`         | `30`     | Refresh interval in seconds (`0` turns it off). The Processes view refreshes every 10s, and CPU/memory never more often than every 15s. |
| `DOKKU_INK_SSH`             | none     | Remote host, same as `--ssh`                         |
| `DOKKU_INK_BIN`             | `dokku`  | Path to the `dokku` binary                           |
| `DOKKU_INK_HOST`            | hostname or SSH host | Label shown in the header                |
| `DOKKU_INK_DEMO`            | none     | `1` forces demo data                                 |
| `DOKKU_INK_NO_UPDATE_CHECK` | none     | Turns off the daily check for a newer release (`NO_UPDATE_NOTIFIER` works too) |

## Troubleshooting

If the dashboard is empty or looks wrong, run:

```bash
dokku-ink --doctor
```

It shows what each `dokku` command returned and whether it could be parsed, whether batched reports work on your host, and whether docker metrics and event-driven refresh are available. Dokku 0.38+ gives the cleanest data; older versions still work with less detail.

## Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`) whenever a tag starting with `v` is pushed.

```bash
npm test && npm run typecheck
npm version patch        # or minor / major
git push --follow-tags
```

`npm version` needs a clean working tree. It updates `package.json`, commits it (e.g. `0.1.7`), and creates the matching `v0.1.7` tag. A plain `git push` doesn't send tags, so without `--follow-tags` nothing gets built. The workflow then:

1. Cross-compiles the four binaries (`linux`/`darwin` × `x64`/`arm64`) with Bun.
2. Creates a GitHub Release named after the tag, with auto-generated notes, and attaches the binaries.

After that, the install script's default of "latest" picks it up, and running copies show the update in their header within a day.

Good to know:

- **Keep the tag and `package.json` in sync.** The binary's `--version` comes from `package.json`, not the tag. Using `npm version` rather than `git tag` keeps them the same.
- **Test the build locally first** with `bun run build:binaries`. The output lands in `./build`.
- **If the workflow fails,** fix it on `main` and move the tag: `git tag -f v0.1.7 && git push -f origin v0.1.7`. If the release was already created, remove it first with `gh release delete v0.1.7 --cleanup-tag`, then create and push the tag again.

## License

MIT
