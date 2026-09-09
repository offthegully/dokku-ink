// Data layer for dokku-ink.
//
// Strategy: this tool is meant to run *on the Dokku host*, so instead of
// standing up a REST API we just shell out to the `dokku` binary and parse its
// structured output. Dokku's report commands support `--format json`
// (clean keys since v0.38.0), which we use where available with defensive
// fallbacks. When `dokku` is not on PATH (e.g. local dev), we transparently
// fall back to rich demo data so every view is still explorable.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { DEMO } from "./demo.js";
import {
  dokkuInvocation,
  hostInvocation,
  isRemote,
  remoteLabel,
  DOKKU_BIN,
} from "./exec.js";
import type {
  AppDetail,
  ConfigResult,
  ContainerStat,
  DokkuApp,
  DokkuService,
  HostDisk,
  Overview,
  ProcInstance,
  Process,
  RawReport,
  ResourceEntry,
  ServicesResult,
  Source,
  Ssl,
  StatsMap,
  StatsResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

// Memoized as a *promise*, not a result: loadOverview, loadStats and the lazy
// loaders all probe concurrently on startup, and caching only the resolved
// value let every one of them spawn its own `dokku version` — three SSH
// handshakes, one of which pays the cold ControlMaster setup.
let _hasDokku: Promise<boolean> | null = null;

export async function hasDokku(): Promise<boolean> {
  if (process.env.DOKKU_INK_DEMO === "1") return false;
  if (_hasDokku) return _hasDokku;
  _hasDokku = (async () => {
    try {
      const inv = dokkuInvocation(["version"]);
      // SSH cold-start (handshake + auth) can exceed a local-tuned timeout.
      await execFileAsync(inv.cmd, inv.argv, { timeout: isRemote() ? 15000 : 8000 });
      return true;
    } catch {
      return false;
    }
  })();
  return _hasDokku;
}

async function dokku(args: string[]): Promise<string> {
  const inv = dokkuInvocation(args);
  const { stdout } = await execFileAsync(inv.cmd, inv.argv, {
    timeout: 20000,
    maxBuffer: 1024 * 1024 * 16,
  });
  return stdout;
}

interface RawResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

async function rawExec(
  cmd: string,
  argv: string[],
  timeout = 20000,
): Promise<RawResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      timeout,
      maxBuffer: 1024 * 1024 * 16,
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      error: err.message ?? String(e),
    };
  }
}

// Like dokku() but never throws — captures stdout/stderr/error for diagnostics.
async function dokkuRaw(args: string[], timeout = 20000): Promise<RawResult> {
  const inv = dokkuInvocation(args);
  return rawExec(inv.cmd, inv.argv, timeout);
}

// Host-level command (docker, df). Resolves to a failed result when the
// target can't run them (SSH as the restricted dokku user).
async function hostRaw(command: string[], timeout = 20000): Promise<RawResult> {
  const inv = hostInvocation(command);
  if (!inv)
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: "host commands unavailable over dokku@ SSH",
    };
  return rawExec(inv.cmd, inv.argv, timeout);
}

// Parse `dokku apps:list` output into app names, tolerant of the "=====> My Apps"
// header and of names being newline- or whitespace-separated.
function parseAppNames(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (
      !t ||
      t.startsWith("=====>") ||
      t.startsWith("----") ||
      t.startsWith("!")
    )
      continue;
    const tok = t.split(/\s+/)[0];
    if (tok) names.push(tok);
  }
  return names;
}

// The report plugins fetched for every app on a full sweep. Each one is a
// single batched invocation (see reportAllApps), so adding a plugin here costs
// one command per refresh, not one per app.
const SWEEP_PLUGINS = [
  "apps",
  "ps",
  "domains",
  "certs",
  "checks",
  "proxy",
  "cron",
] as const;

type SweepPlugin = (typeof SWEEP_PLUGINS)[number];
export type SweepReports = Record<SweepPlugin, RawReport>;

// Fetch every app's `<plugin>:report --format json` in ONE invocation.
//
// The no-arg form emits one JSON object per app per line (NDJSON) with no app
// key in it, so the objects have to be matched back by position. That is safe:
// every plugin's report command iterates common.DokkuApps(), which is an
// os.ReadDir of DOKKU_ROOT — the same deterministic order `apps:list` returns.
// loadOverview still verifies the row count (and the app names, which
// apps:report carries in its `dir` key) before trusting the alignment, and
// falls back to per-app calls when anything disagrees.
//
// Returns null when the command failed or emitted something unparseable.
async function reportAllApps(
  plugin: string,
): Promise<Array<Record<string, string>> | null> {
  // A batched report does N apps' worth of work in one call, so it needs more
  // headroom than a single-app one.
  const r = await dokkuRaw([`${plugin}:report`, "--format", "json"], 40000);
  if (!r.ok) return null;
  const rows: Array<Record<string, string>> = [];
  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue; // skips the "no apps exist" warning
    try {
      const obj = JSON.parse(t);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
      rows.push(obj as Record<string, string>);
    } catch {
      return null;
    }
  }
  return rows;
}

// Match batched NDJSON rows onto app names by position. null when the row
// count disagrees with the app list — the caller then re-fetches per app.
function alignRows(
  names: string[],
  rows: Array<Record<string, string>> | null,
): Record<string, Record<string, string>> | null {
  if (!rows || rows.length !== names.length) return null;
  const out: Record<string, Record<string, string>> = {};
  names.forEach((n, i) => (out[n] = rows[i]));
  return out;
}

// App names as carried by apps:report itself: its `dir` key is
// $DOKKU_ROOT/<app>. Returns null unless every row has one, which is what
// makes the batched apps report self-identifying rather than order-dependent.
export function namesFromAppsRows(
  rows: Array<Record<string, string>> | null,
): string[] | null {
  if (!rows || rows.length === 0) return null;
  const names: string[] = [];
  for (const row of rows) {
    const dir = pick(row, "dir", "app-dir");
    if (!dir) return null;
    const base = dir.replace(/\/+$/, "").split("/").pop();
    if (!base) return null;
    names.push(base);
  }
  return names;
}

const sameNames = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

// Per-app fallback for one plugin: the old N-invocations-per-report path, used
// only when the batched call failed or its rows could not be aligned.
async function reportPerApp(
  plugin: string,
  names: string[],
): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  await mapLimit(names, 8, async (name) => {
    const rep = await reportForApp(plugin, name);
    if (rep) out[name] = rep;
  });
  return out;
}

// Fetch a single app's `--format json` report — the fallback path, and what
// the per-app drill-in (ports/git/network/resource) still uses.
// Returns undefined when the command errors or isn't JSON.
async function reportForApp(
  plugin: string,
  app: string,
): Promise<Record<string, string> | undefined> {
  const r = await dokkuRaw([`${plugin}:report`, app, "--format", "json"]);
  if (!r.ok) return undefined;
  try {
    const obj = JSON.parse(r.stdout.trim());
    return obj && typeof obj === "object" && !Array.isArray(obj)
      ? (obj as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
}

// Run an async fn over items with bounded concurrency (keeps process fan-out
// reasonable on hosts with many apps: N apps × 4 reports).
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<void>,
): Promise<void> {
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) break;
        await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
}

export function toBool(v: unknown): boolean {
  return v === true || v === "true" || v === "1";
}

function pick(
  obj: Record<string, string> | undefined,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== "") return obj[k];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

// Pull the per-process scale + container statuses out of a ps:report entry.
// Dokku derives these keys from its CONTAINER.<type>.<n> files, so they look
// like "status-web.1": "running (abc123)". Accept a dash separator too for
// older/alternative shapes.
function parseProcesses(
  psEntry: Record<string, string> | undefined,
): Process[] {
  if (!psEntry) return [];
  const byType = new Map<string, ProcInstance[]>();
  for (const [key, value] of Object.entries(psEntry)) {
    const m = /^status-(.+)[.-](\d+)$/.exec(key);
    if (!m) continue;
    const type = m[1];
    const idx = Number(m[2]);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push({ index: idx, status: String(value) });
  }
  return [...byType.entries()]
    .map(([type, instances]) => ({
      type,
      scale: instances.length,
      instances: instances.sort((a, b) => a.index - b.index),
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function splitHosts(str: string | undefined): string[] {
  if (!str) return [];
  return String(str)
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeCerts(
  certEntry: Record<string, string> | undefined,
): Ssl | null {
  if (!certEntry) return null;
  const enabled = toBool(pick(certEntry, "ssl-enabled", "enabled"));
  const hostnames = pick(certEntry, "ssl-hostnames", "hostnames");
  const issuer = pick(certEntry, "ssl-issuer", "issuer");
  const expiresAt = pick(certEntry, "ssl-expires-at", "expires-at");
  const startsAt = pick(certEntry, "ssl-starts-at", "starts-at");
  const verified = pick(certEntry, "ssl-verified", "verified");
  if (!enabled && !hostnames && !issuer && !expiresAt) return null;
  return {
    enabled,
    hostnames: splitHosts(hostnames),
    issuer: issuer || null,
    expiresAt: expiresAt || null,
    startsAt: startsAt || null,
    verified: verified === undefined ? null : toBool(verified),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadOverview(): Promise<Overview> {
  if (!(await hasDokku())) {
    return { apps: structuredClone(DEMO.apps), source: "demo", warnings: [] };
  }

  const warnings: string[] = [];

  // One batched call per plugin, plus apps:list — all in parallel, and all
  // flat in the number of apps (a 12-app host used to need 49 invocations
  // here, a 30-app host 121).
  const [listed, ...batched] = await Promise.all([
    // --format json is the clean shape; the text parser stays as a fallback
    // for dokku builds that reject the flag on apps:list.
    dokkuRaw(["apps:list", "--format", "json"]),
    ...SWEEP_PLUGINS.map((plugin) => reportAllApps(plugin)),
  ]);
  const rows = Object.fromEntries(
    SWEEP_PLUGINS.map((plugin, i) => [plugin, batched[i]]),
  ) as Record<SweepPlugin, Array<Record<string, string>> | null>;

  let names: string[] = [];
  if (listed.ok) {
    names = parseAppList(listed.stdout);
  } else {
    const retry = await dokkuRaw(["apps:list"]);
    if (retry.ok) names = parseAppNames(retry.stdout);
    else warnings.push(`apps:list failed: ${retry.error ?? retry.stderr}`);
  }

  // Cross-check the batched alignment against the names apps:report carries
  // in its own `dir` key. If those disagree with apps:list, the positional
  // mapping cannot be trusted for any plugin and we fall back per app.
  const reported = namesFromAppsRows(rows.apps);
  let trustOrder = true;
  if (reported && !sameNames(reported, names)) {
    if (names.length === 0) {
      names = reported; // apps:list failed; the report can still name them
    } else {
      trustOrder = false;
      warnings.push(
        "batched reports disagreed with apps:list — fell back to per-app reports",
      );
    }
  }
  if (reported && trustOrder) names = reported;

  const reports = {} as SweepReports;
  await Promise.all(
    SWEEP_PLUGINS.map(async (plugin) => {
      const aligned = trustOrder ? alignRows(names, rows[plugin]) : null;
      reports[plugin] = aligned ?? (await reportPerApp(plugin, names));
    }),
  );

  return { apps: buildApps(names, reports), source: "dokku", warnings };
}

// `dokku apps:list --format json` -> ["blog", "staging"]. Falls back to the
// text parser when the output isn't the expected JSON array.
export function parseAppList(out: string): string[] {
  const t = out.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr)) return arr.filter((n): n is string => typeof n === "string");
    } catch {
      /* fall through to the text parser */
    }
  }
  return parseAppNames(out);
}

// Pure normalisation from raw dokku JSON reports into the app model.
// Exported so it can be unit-tested against sample dokku output.
export function buildApps(names: string[], reports: Partial<SweepReports>): DokkuApp[] {
  const at = (plugin: SweepPlugin, name: string): Record<string, string> =>
    (reports[plugin] && reports[plugin]![name]) || {};

  return names.map((name) => {
    const a = at("apps", name);
    const ps = at("ps", name);
    const dom = at("domains", name);
    const cert = at("certs", name);

    const runningRaw = pick(ps, "running");
    const appEnabled = pick(dom, "app-enabled");
    return {
      name,
      running: runningRaw === undefined ? null : toBool(runningRaw),
      deployed: toBool(pick(ps, "deployed")),
      deploySource: pick(a, "deploy-source", "deploy-source-metadata") || null,
      createdAt: pick(a, "created-at") || null,
      restartPolicy:
        pick(ps, "restart-policy", "computed-restart-policy") || null,
      processes: parseProcesses(ps),
      domains: splitHosts(pick(dom, "app-vhosts")),
      domainsEnabled: appEnabled === undefined ? null : toBool(appEnabled),
      ssl: normalizeCerts(cert),
      locked: toBool(pick(a, "locked", "app-locked")),
      checks: normalizeChecks(reports.checks?.[name]),
      proxy: normalizeProxy(reports.proxy?.[name]),
      cronTasks: parseCount(pick(reports.cron?.[name], "task-count", "cron-task-count")),
    };
  });
}

// `checks:report` reports disabled/skipped process types as space-separated
// lists, with "none" standing in for an empty one. `_all_` means every type.
function normalizeChecks(
  entry: Record<string, string> | undefined,
): DokkuApp["checks"] {
  if (!entry) return null;
  const list = (...keys: string[]): string[] => {
    const raw = pick(entry, ...keys);
    if (!raw || /^none$/i.test(raw.trim())) return [];
    return splitHosts(raw);
  };
  return {
    disabled: list("disabled-list", "checks-disabled-list"),
    skipped: list("skipped-list", "checks-skipped-list"),
  };
}

// `proxy:report` — prefer the computed values (per-app, else global, else the
// built-in default), which is what actually applies at deploy time.
function normalizeProxy(
  entry: Record<string, string> | undefined,
): DokkuApp["proxy"] {
  if (!entry) return null;
  const enabled = pick(entry, "enabled", "proxy-enabled");
  return {
    type: pick(entry, "computed-type", "type", "proxy-computed-type", "proxy-type") ?? null,
    enabled: enabled === undefined ? null : toBool(enabled),
    port: pick(entry, "computed-proxy-port", "proxy-port", "proxy-computed-proxy-port") ?? null,
    sslPort:
      pick(entry, "computed-proxy-ssl-port", "proxy-ssl-port", "proxy-computed-proxy-ssl-port") ??
      null,
  };
}

function parseCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Cheap refresh between full ones: only ps:report changes minute-to-minute,
// so re-fetch just that (one batched call) and graft it onto the previous
// snapshot. Domains, certs and app metadata only move on deploys/config
// changes, which trigger a full refresh via the events watcher anyway.
export async function loadOverviewLight(prev: Overview): Promise<Overview> {
  if (prev.source !== "dokku" || !(await hasDokku())) return loadOverview();
  const names = prev.apps.map((a) => a.name);
  const rows = await reportAllApps("ps");
  // Two different failures, two different answers: a row count that disagrees
  // with the previous snapshot means an app was created or destroyed, so the
  // whole snapshot is stale and needs the full sweep. A batched report this
  // host simply can't serve just means falling back to one call per app —
  // escalating to a full refresh every poll would be far more expensive.
  if (rows && rows.length !== names.length) return loadOverview();
  const psRep = alignRows(names, rows) ?? (await reportPerApp("ps", names));
  const apps = prev.apps.map((a) => {
    const ps = psRep[a.name];
    if (!ps) return a;
    const runningRaw = pick(ps, "running");
    return {
      ...a,
      running: runningRaw === undefined ? null : toBool(runningRaw),
      deployed: toBool(pick(ps, "deployed")),
      restartPolicy:
        pick(ps, "restart-policy", "computed-restart-policy") || null,
      processes: parseProcesses(ps),
    };
  });
  return { apps, source: "dokku", warnings: prev.warnings };
}

// ---------------------------------------------------------------------------
// Container metrics (docker stats) + host disk
// ---------------------------------------------------------------------------

let _hasDocker: Promise<boolean> | null = null;

async function hasDocker(): Promise<boolean> {
  if (_hasDocker) return _hasDocker;
  _hasDocker = hostRaw(
    ["docker", "version", "--format", "{{.Server.Version}}"],
    10000,
  ).then((r) => r.ok);
  return _hasDocker;
}

// "55.2MiB", "1.9GiB", "512kB" -> bytes. docker stats mixes binary (MiB) and
// decimal (MB) suffixes depending on version; both are close enough for a
// dashboard readout.
export function parseSize(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^([\d.]+)\s*([KMGTP]?i?B?)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  const exp = unit.startsWith("K")
    ? 1
    : unit.startsWith("M")
      ? 2
      : unit.startsWith("G")
        ? 3
        : unit.startsWith("T")
          ? 4
          : unit.startsWith("P")
            ? 5
            : 0;
  const base = unit.includes("I") ? 1024 : 1000;
  return Math.round(n * base ** exp);
}

const pctNum = (s: string | undefined): number | null => {
  if (!s) return null;
  const n = Number(s.replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
};

// Parse `docker stats --no-stream --format {{json .}}` NDJSON output into a
// map keyed by container name (dokku names containers `<app>.<proc>.<n>`).
export function parseDockerStats(out: string): StatsMap {
  const map: StatsMap = {};
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const j = JSON.parse(t) as Record<string, string>;
      const name = j.Name || j.Container;
      if (!name) continue;
      const [used, limit] = String(j.MemUsage || "")
        .split("/")
        .map((s) => s.trim());
      const stat: ContainerStat = {
        name,
        cpuPct: pctNum(j.CPUPerc),
        memBytes: parseSize(used),
        memLimitBytes: parseSize(limit),
      };
      map[name] = stat;
    } catch {
      /* skip malformed line */
    }
  }
  return map;
}

// Parse POSIX `df -Pk /` output (sizes in 1K blocks).
export function parseDf(out: string): HostDisk | null {
  const lines = out.trim().split("\n");
  if (lines.length < 2) return null;
  const cols = lines[1].trim().split(/\s+/);
  if (cols.length < 5) return null;
  const totalK = Number(cols[1]);
  const usedK = Number(cols[2]);
  const pct = Number(cols[4].replace("%", ""));
  if (!Number.isFinite(totalK) || !Number.isFinite(usedK)) return null;
  return {
    usedPct: Number.isFinite(pct)
      ? pct
      : Math.round((usedK / Math.max(1, totalK)) * 100),
    usedBytes: usedK * 1024,
    totalBytes: totalK * 1024,
  };
}

// Snapshot per-container CPU/memory plus root-disk usage. Returns stats:null
// when docker isn't reachable (dashboard renders "—" instead of numbers).
export async function loadStats(): Promise<StatsResult> {
  if (!(await hasDokku())) {
    return {
      stats: structuredClone(DEMO.stats),
      disk: { ...DEMO.disk },
      source: "demo",
    };
  }
  if (!(await hasDocker())) return { stats: null, disk: null, source: "dokku" };
  const [statsRes, dfRes] = await Promise.all([
    // --no-stream still waits out one sampling interval (~2s); give it room.
    hostRaw(
      ["docker", "stats", "--no-stream", "--format", "{{json .}}"],
      30000,
    ),
    hostRaw(["df", "-Pk", "/"], 10000),
  ]);
  return {
    stats: statsRes.ok ? parseDockerStats(statsRes.stdout) : null,
    disk: dfRes.ok ? parseDf(dfRes.stdout) : null,
    source: "dokku",
  };
}

// ---------------------------------------------------------------------------
// Datastore services (official plugin family: postgres, redis, mysql, …)
// ---------------------------------------------------------------------------

// The official dokku datastore plugins all share the list/info CLI shape.
const DATASTORE_PLUGINS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "memcached",
  "rabbitmq",
  "elasticsearch",
  "couchdb",
  "clickhouse",
  "meilisearch",
  "nats",
  "solr",
  "typesense",
];

// Installed+enabled datastore plugins from `dokku plugin:list` output, whose
// lines look like: "  postgres             1.38.0 enabled    dokku postgres service plugin".
export function parseDatastorePlugins(out: string): string[] {
  const found: string[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    const name = t.split(/\s+/)[0];
    if (name && DATASTORE_PLUGINS.includes(name) && /\benabled\b/.test(t)) {
      found.push(name);
    }
  }
  return found;
}

let _plugins: string[] | null = null;

async function datastorePlugins(): Promise<string[]> {
  if (_plugins !== null) return _plugins;
  const r = await dokkuRaw(["plugin:list"]);
  _plugins = r.ok ? parseDatastorePlugins(r.stdout) : [];
  return _plugins;
}

// Service names from `dokku <plugin>:list` — tolerate the "=====>" banner and
// the NAME/VERSION/... column header row.
export function parseServiceList(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("=====>") || t.startsWith("!")) continue;
    const tok = t.split(/\s+/)[0];
    if (!tok || tok === "NAME") continue;
    names.push(tok);
  }
  return names;
}

// `dokku <plugin>:info <svc>` prints indented "Key: value" rows. Lowercased
// key -> value map; empty values dropped.
export function parseServiceInfo(out: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^\s+([A-Za-z][A-Za-z0-9 -]*?):\s*(.*)$/.exec(line);
    if (!m) continue;
    const val = m[2].trim();
    if (val && val !== "-") kv[m[1].trim().toLowerCase()] = val;
  }
  return kv;
}

export async function loadServices(): Promise<ServicesResult> {
  if (!(await hasDokku())) {
    return {
      services: structuredClone(DEMO.services),
      plugins: ["postgres", "redis"],
      source: "demo",
    };
  }
  const plugins = await datastorePlugins();
  const services: DokkuService[] = [];
  const targets: Array<{ plugin: string; name: string }> = [];
  for (const plugin of plugins) {
    const r = await dokkuRaw([`${plugin}:list`]);
    if (!r.ok) continue; // "There are no <X> services" exits non-zero
    for (const name of parseServiceList(r.stdout))
      targets.push({ plugin, name });
  }
  await mapLimit(targets, 4, async ({ plugin, name }) => {
    const r = await dokkuRaw([`${plugin}:info`, name]);
    const kv = r.ok ? parseServiceInfo(r.stdout) : {};
    services.push({
      plugin,
      name,
      status: kv["status"] ?? null,
      version: kv["version"] ?? null,
      links: splitHosts(kv["links"]),
      exposedPorts: kv["exposed ports"] ?? null,
      dsn: kv["dsn"] ?? null,
    });
  });
  services.sort(
    (a, b) => a.plugin.localeCompare(b.plugin) || a.name.localeCompare(b.name),
  );
  return { services, plugins, source: "dokku" };
}

// ---------------------------------------------------------------------------
// Per-app drill-in detail (ports, storage, git, network)
// ---------------------------------------------------------------------------

// `resource:report --format json` keys are "<proctype>.<limit|reserve>.<key>",
// e.g. "web.limit.memory": "512m". Only *set* properties are reported, so an
// app with no limits configured yields an empty list. "_default_" is dokku's
// app-wide fallback process type.
export function buildResources(
  entry: Record<string, string> | undefined,
): ResourceEntry[] {
  if (!entry) return [];
  const byType = new Map<string, ResourceEntry>();
  for (const [key, value] of Object.entries(entry)) {
    const m = /^(?:resource-)?(.+)\.(limit|reserve)\.(.+)$/.exec(key);
    if (!m || !value) continue;
    const [, processType, kind, prop] = m;
    let e = byType.get(processType);
    if (!e) {
      e = { processType, limits: {}, reserves: {} };
      byType.set(processType, e);
    }
    (kind === "limit" ? e.limits : e.reserves)[prop] = String(value);
  }
  return [...byType.values()].sort((a, b) => {
    // "_default_" is the fallback for every other type — list it last.
    if (a.processType === "_default_") return 1;
    if (b.processType === "_default_") return -1;
    return a.processType.localeCompare(b.processType);
  });
}

// `ps:scale <app> --format json` -> [{"process_type":"web","quantity":2}].
// This is the *desired* formation, which is what makes a missing container
// visible: the live instance list alone reads as "web ×1" whether the app is
// scaled to 1 or scaled to 3 with two of them dead.
export function parseScale(out: string): Record<string, number> {
  const t = out.trim();
  if (!t.startsWith("[")) return {};
  let arr: unknown;
  try {
    arr = JSON.parse(t);
  } catch {
    return {};
  }
  if (!Array.isArray(arr)) return {};
  const scale: Record<string, number> = {};
  for (const row of arr) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const type = typeof r.process_type === "string" ? r.process_type : null;
    const qty = Number(r.quantity);
    if (type && Number.isFinite(qty)) scale[type] = qty;
  }
  return scale;
}

// `storage:list <app> --format json` -> ["host:container", …], matching the
// text form buildAppDetail already renders. Dokku 0.38 made volumes named
// first-class entries, so an entry may carry a name and mount options that the
// old "host:container" text form never showed. null when the output isn't the
// expected JSON array (older dokku: fall back to parsing the text).
export function parseStorageJson(out: string): string[] | null {
  const t = out.trim();
  if (!t.startsWith("[")) return null;
  let arr: unknown;
  try {
    arr = JSON.parse(t);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  return arr.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const host = typeof r.host_path === "string" ? r.host_path : "";
    const container = typeof r.container_path === "string" ? r.container_path : "";
    if (!host && !container) return [];
    const name = typeof r.entry_name === "string" && r.entry_name ? `${r.entry_name} ` : "";
    const ro = r.readonly === true ? ":ro" : "";
    return [`${name}${host}:${container}${ro}`];
  });
}

// Pure assembly from raw report objects — exported for tests. Report JSON
// keys vary across dokku versions between plugin-prefixed and bare names, so
// pick() both.
export function buildAppDetail(
  ports: Record<string, string> | undefined,
  git: Record<string, string> | undefined,
  network: Record<string, string> | undefined,
  storageOut: string,
  resource?: Record<string, string>,
  scaleOut?: string,
): AppDetail {
  const portList = splitHosts(
    pick(ports, "map", "ports-map") ?? pick(ports, "map-detected", "ports-map-detected"),
  );
  const storage: string[] = [];
  for (const line of storageOut.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("=====>") || t.startsWith("----->") || t.startsWith("!")) continue;
    if (t.includes(":")) storage.push(t);
  }
  return {
    ports: portList,
    storage,
    resources: buildResources(resource),
    scale: parseScale(scaleOut ?? ""),
    git: {
      branch: pick(git, "deploy-branch", "git-deploy-branch") ?? null,
      sha: pick(git, "sha", "git-sha") ?? null,
      lastUpdated:
        pick(git, "last-updated-at", "git-last-updated-at") ?? null,
      sourceImage: pick(git, "source-image", "git-source-image") ?? null,
    },
    network: {
      initial: pick(network, "initial-network", "network-initial-network") ?? null,
      attachPostCreate:
        pick(network, "attach-post-create", "network-attach-post-create") ?? null,
      attachPostDeploy:
        pick(network, "attach-post-deploy", "network-attach-post-deploy") ?? null,
    },
  };
}

export async function loadAppDetail(
  appName: string,
  source: Source,
): Promise<AppDetail> {
  if (source === "demo" || !(await hasDokku())) {
    return structuredClone(
      DEMO.details[appName] ?? buildAppDetail(undefined, undefined, undefined, ""),
    );
  }
  const [ports, git, network, resource, storage, scale] = await Promise.all([
    reportForApp("ports", appName),
    reportForApp("git", appName),
    reportForApp("network", appName),
    reportForApp("resource", appName),
    dokkuRaw(["storage:list", appName, "--format", "json"]),
    dokkuRaw(["ps:scale", appName, "--format", "json"]),
  ]);
  const storageOut = storage.ok ? storage.stdout : "";
  const detail = buildAppDetail(
    ports,
    git,
    network,
    storageOut,
    resource,
    scale.ok ? scale.stdout : "",
  );
  const asJson = parseStorageJson(storageOut);
  if (asJson) detail.storage = asJson;
  else if (!storage.ok) {
    // Older dokku rejects --format on storage:list; retry the text form.
    const text = await dokkuRaw(["storage:list", appName]);
    if (text.ok) detail.storage = buildAppDetail(undefined, undefined, undefined, text.stdout).storage;
  }
  return detail;
}

// Per-app environment variables.
export async function loadConfig(
  appName: string,
  source: Source,
): Promise<ConfigResult> {
  if (source === "demo" || !(await hasDokku())) {
    return {
      vars: structuredClone(DEMO.config[appName] || {}),
      source: "demo",
    };
  }

  // Try JSON first (newer dokku), then fall back to parsing config:show text.
  try {
    const out = await dokku(["config:show", appName, "--format", "json"]);
    const parsed = JSON.parse(out);
    if (parsed && typeof parsed === "object") {
      return { vars: parsed as Record<string, string>, source: "dokku" };
    }
  } catch {
    /* fall through */
  }

  const vars: Record<string, string> = {};
  try {
    const out = await dokku(["config:show", appName]);
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("=====>")) continue;
      const idx = trimmed.indexOf(":");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key) vars[key] = value;
    }
  } catch (e) {
    return { vars: {}, source: "dokku", error: (e as Error).message };
  }
  return { vars, source: "dokku" };
}

// ---------------------------------------------------------------------------
// Log tailing
// ---------------------------------------------------------------------------

export type LogSink = (line: string, isErr: boolean) => void;

// App output can carry ANSI colour codes, tabs and \r — all of which throw
// off Ink's width math and cause the layout to jitter. Strip to plain text.
const sanitizeLine = (s: string) =>
  s
    .replace(/\r$/, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\t/g, "  ");

// Kill a spawned child and anything it forked. These children run tailing
// commands (`dokku logs -t`, `dokku events -t`) whose underlying plugin
// scripts commonly exec into a pipeline (e.g. `docker logs -f | ...`); a
// plain `child.kill()` only signals the immediate process, orphaning that
// pipeline. The orphan keeps holding the piped stdout open, so Node's event
// loop never goes idle — the dashboard quits visually (Ink unmounts fine)
// but the process itself hangs forever. Spawning with `detached: true`
// makes the child its own process-group leader, so killing `-pid` reaches
// the whole tree; destroying the streams is a backstop for anything left
// holding the pipe regardless.
function killTree(child: ChildProcess): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

// Feed a child stream to onLine one sanitized line at a time.
function streamLines(
  stream: NodeJS.ReadableStream,
  isErr: boolean,
  onLine: LogSink,
): void {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(sanitizeLine(line), isErr);
    }
  });
}

// Stream `dokku logs <app> -t` line by line. Returns a stop function that
// kills the child (or the demo generator). `onEnd` fires if the stream dies
// on its own — e.g. the app has no deployed containers to tail.
export function tailLogs(
  app: string,
  source: Source,
  onLine: LogSink,
  onEnd: (msg: string) => void,
): () => void {
  if (source === "demo") {
    const paths = ["/", "/health", "/api/items", "/login", "/static/app.css"];
    let n = 0;
    const t = setInterval(() => {
      n++;
      const status = n % 17 === 0 ? 500 : 200;
      const ms = Math.abs(Math.round(Math.sin(n) * 20)) + 5;
      onLine(
        `${new Date().toISOString()} ${app} web.1: GET ${paths[n % paths.length]} ${status} ${ms}ms`,
        status >= 500,
      );
    }, 600);
    return () => clearInterval(t);
  }

  const inv = dokkuInvocation(["logs", app, "-t", "-n", "100"]);
  const child = spawn(inv.cmd, inv.argv, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  streamLines(child.stdout, false, onLine);
  streamLines(child.stderr, true, onLine);

  let stopped = false;
  child.on("error", (e) => {
    if (!stopped) onEnd(`log stream failed: ${e.message}`);
  });
  child.on("exit", (code, signal) => {
    if (!stopped) onEnd(`log stream ended (${signal ?? `exit ${code}`})`);
  });
  return () => {
    stopped = true;
    killTree(child);
  };
}

// Run an arbitrary `dokku <args>` command, streaming its combined output.
// Spawned directly (no shell), so the typed text can't be shell-injected.
// stdin is closed: commands that would prompt for confirmation (e.g.
// apps:destroy without --force) read EOF and abort instead of hanging.
// Returns a stop function that kills the child.
export function runCommand(
  args: string[],
  onLine: LogSink,
  onEnd: (msg: string, ok: boolean) => void,
): () => void {
  const inv = dokkuInvocation(args);
  const child = spawn(inv.cmd, inv.argv, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  streamLines(child.stdout, false, onLine);
  streamLines(child.stderr, true, onLine);

  let stopped = false;
  child.on("error", (e) => {
    if (stopped) return;
    stopped = true;
    onEnd(`✖ failed to run: ${e.message}`, false);
  });
  // 'close' (not 'exit') so the final stdout/stderr chunks land first.
  child.on("close", (code, signal) => {
    if (stopped) return;
    stopped = true;
    onEnd(
      code === 0 ? "✔ done (exit 0)" : `✖ ${signal ?? `exit ${code}`}`,
      code === 0,
    );
  });
  return () => {
    stopped = true;
    killTree(child);
  };
}

// Push-based refresh: follow `dokku events -t` (requires `dokku events:on`)
// and report each event line as it lands. When events logging is disabled or
// the plugin is missing the child exits straight away — `onUnavailable` fires
// once and the caller just stays on polling.
export function watchEvents(
  onEvent: (line: string) => void,
  onUnavailable?: () => void,
): () => void {
  const inv = dokkuInvocation(["events", "-t"]);
  const child = spawn(inv.cmd, inv.argv, {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  let stopped = false;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line && !stopped) onEvent(line);
    }
  });
  const dead = () => {
    if (stopped) return;
    stopped = true;
    onUnavailable?.();
  };
  child.on("error", dead);
  child.on("exit", dead);
  return () => {
    stopped = true;
    killTree(child);
  };
}

// ---------------------------------------------------------------------------
// Diagnostics: `dokku-ink --doctor`
// ---------------------------------------------------------------------------

const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
const clip = (s: string, n = 500) =>
  s.length > n ? s.slice(0, n) + "\n  …(truncated)" : s;

export async function runDoctor(): Promise<string> {
  const L: string[] = [];
  L.push("dokku-ink doctor");
  L.push(`binary: ${DOKKU_BIN()}   (override with DOKKU_INK_BIN)`);
  L.push(
    isRemote()
      ? `target: ssh ${remoteLabel()}   (from DOKKU_INK_SSH / --ssh)`
      : "target: local",
  );
  L.push("");

  const v = await dokkuRaw(["version"]);
  L.push(`# dokku version  ->  ${v.ok ? "OK" : "FAILED"}`);
  L.push(indent(clip((v.stdout || v.stderr || v.error || "").trim(), 200)));
  L.push("");

  const al = await dokkuRaw(["apps:list"]);
  L.push(`# dokku apps:list  ->  ${al.ok ? "OK" : "FAILED"}`);
  L.push(indent(clip((al.ok ? al.stdout : al.error || al.stderr).trim(), 400)));
  const names = al.ok ? parseAppNames(al.stdout) : [];
  L.push(`  parsed ${names.length} name(s): ${names.join(", ") || "(none)"}`);
  L.push("");

  // Normalize first so the probes can target an app that actually has
  // containers — probing a never-deployed app shows no status keys and would
  // hide process-parsing bugs.
  const ov = await loadOverview();
  const probe =
    (ov.source === "dokku"
      ? ov.apps.find((a) => a.running)?.name
      : undefined) ?? names[0];

  // Probe the batched strategy first: one `<plugin>:report --format json` per
  // plugin for every app at once. This is the path a normal refresh takes, so
  // if it misbehaves on this host the doctor should say so — the dashboard
  // will silently fall back to per-app reports and just be slower.
  L.push("# batched reports (`<plugin>:report --format json`, no app)");
  for (const plugin of SWEEP_PLUGINS) {
    const rows = await reportAllApps(plugin);
    if (rows === null) {
      L.push(`  ${plugin}: FAILED — falls back to one report per app`);
      continue;
    }
    const aligns = rows.length === names.length;
    L.push(
      `  ${plugin}: OK — ${rows.length} row(s)${
        aligns ? "" : ` — does NOT match ${names.length} app(s), falls back per app`
      }`,
    );
  }
  const reportedNames = namesFromAppsRows(await reportAllApps("apps"));
  L.push(
    reportedNames
      ? `  apps:report names itself via \`dir\`: ${reportedNames.join(", ") || "(none)"}${
          sameNames(reportedNames, names) ? " (matches apps:list)" : " (DISAGREES with apps:list)"
        }`
      : "  apps:report has no `dir` key — app names come from apps:list alone",
  );
  L.push("");

  // Probe the per-app fallback: `<plugin>:report <app> --format json`.
  for (const plugin of ["apps", "ps", "domains", "certs", "checks", "proxy", "cron"]) {
    if (!probe) break;
    const r = await dokkuRaw([`${plugin}:report`, probe, "--format", "json"]);
    let verdict: string;
    let keys = "";
    let obj: Record<string, string> | undefined;
    if (!r.ok) {
      verdict = "FAILED (command errored)";
    } else {
      try {
        obj = JSON.parse(r.stdout.trim());
        verdict = "OK (valid JSON)";
        keys = Object.keys(obj!).slice(0, 20).join(", ");
      } catch (e) {
        verdict = "NOT valid JSON: " + (e as Error).message;
      }
    }
    L.push(`# dokku ${plugin}:report ${probe} --format json  ->  ${verdict}`);
    L.push(
      indent(
        clip(
          (r.ok ? r.stdout : r.error || r.stderr).trim(),
          plugin === "ps" ? 900 : 300,
        ),
      ),
    );
    if (keys) L.push(`  keys: ${keys}`);
    if (plugin === "ps" && obj) {
      const procs = parseProcesses(obj);
      L.push(
        `  parsed processes: ${procs.map((p) => `${p.type}×${p.scale}`).join(", ") || "(none)"}`,
      );
    }
    L.push("");
  }

  if (ov.source === "dokku") {
    const stats = await loadStats();
    L.push(
      `# docker stats  ->  ${
        stats.stats
          ? `OK — ${Object.keys(stats.stats).length} container(s) sampled`
          : "unavailable — CPU/MEM columns will show “—”" +
            (isRemote() ? " (host commands need a non-dokku SSH user)" : "")
      }`,
    );
    if (stats.disk) L.push(`  root disk: ${stats.disk.usedPct}% used`);
    L.push("");

    const plugins = await datastorePlugins();
    L.push(
      `# datastore plugins  ->  ${plugins.length ? plugins.join(", ") : "(none detected via plugin:list)"}`,
    );
    if (plugins.length) {
      const svcs = await loadServices();
      L.push(
        indent(
          svcs.services
            .map(
              (s) =>
                `${s.plugin}/${s.name}  status=${s.status ?? "?"}  links=${s.links.join(",") || "-"}`,
            )
            .join("\n") || "(no services)",
        ),
      );
    }
    L.push("");

    const ev = await dokkuRaw(["events"]);
    L.push(
      `# dokku events  ->  ${ev.ok ? "OK — event-driven refresh active" : "unavailable — run `dokku events:on` for push refresh (polling still works)"}`,
    );
    L.push(
      indent(clip((ev.ok ? ev.stdout : ev.error || ev.stderr).trim(), 300)),
    );
    L.push("");
  }

  L.push(`# loadOverview()  ->  source=${ov.source}, apps=${ov.apps.length}`);
  L.push(
    indent(
      ov.apps
        .map(
          (a) =>
            `${a.name}  running=${a.running}  procs=${a.processes.map((p) => `${p.type}x${p.scale}`).join(",") || "-"}  domains=${a.domains.join(" ") || "-"}  ssl=${a.ssl ? "yes" : "no"}`,
        )
        .join("\n") || "(no apps)",
    ),
  );
  if (ov.warnings.length) {
    L.push("warnings:");
    L.push(indent(ov.warnings.join("\n")));
  }
  return L.join("\n");
}
