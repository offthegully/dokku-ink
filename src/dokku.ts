// Data layer for dokku-dash.
//
// Strategy: this tool is meant to run *on the Dokku host*, so instead of
// standing up a REST API we just shell out to the `dokku` binary and parse its
// structured output. Dokku's report commands support `--format json`
// (clean keys since v0.38.0), which we use where available with defensive
// fallbacks. When `dokku` is not on PATH (e.g. local dev), we transparently
// fall back to rich demo data so every view is still explorable.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DEMO } from './demo.js';
import type {
  ConfigResult,
  DokkuApp,
  Overview,
  ProcInstance,
  Process,
  RawReport,
  Source,
  Ssl,
} from './types.js';

const execFileAsync = promisify(execFile);

const DOKKU_BIN = process.env.DOKKU_DASH_BIN || 'dokku';

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

let _hasDokku: boolean | null = null;

export async function hasDokku(): Promise<boolean> {
  if (process.env.DOKKU_DASH_DEMO === '1') return false;
  if (_hasDokku !== null) return _hasDokku;
  try {
    await execFileAsync(DOKKU_BIN, ['version'], { timeout: 8000 });
    _hasDokku = true;
  } catch {
    _hasDokku = false;
  }
  return _hasDokku;
}

async function dokku(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(DOKKU_BIN, args, {
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

// Like dokku() but never throws — captures stdout/stderr/error for diagnostics.
async function dokkuRaw(args: string[]): Promise<RawResult> {
  try {
    const { stdout, stderr } = await execFileAsync(DOKKU_BIN, args, {
      timeout: 20000,
      maxBuffer: 1024 * 1024 * 16,
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '', error: err.message ?? String(e) };
  }
}

// Parse `dokku apps:list` output into app names, tolerant of the "=====> My Apps"
// header and of names being newline- or whitespace-separated.
function parseAppNames(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('=====>') || t.startsWith('----') || t.startsWith('!')) continue;
    const tok = t.split(/\s+/)[0];
    if (tok) names.push(tok);
  }
  return names;
}

// Fetch a single app's `--format json` report. On Dokku 0.38+ the no-arg form
// emits one JSON object *per app per line* (NDJSON) with no app key, which is
// ambiguous to map back; calling per app returns one clean object we can attach
// to that exact app. Returns undefined when the command errors or isn't JSON.
async function reportForApp(plugin: string, app: string): Promise<Record<string, string> | undefined> {
  const r = await dokkuRaw([`${plugin}:report`, app, '--format', 'json']);
  if (!r.ok) return undefined;
  try {
    const obj = JSON.parse(r.stdout.trim());
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}

// Run an async fn over items with bounded concurrency (keeps process fan-out
// reasonable on hosts with many apps: N apps × 4 reports).
async function mapLimit<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export function toBool(v: unknown): boolean {
  return v === true || v === 'true' || v === '1';
}

function pick(obj: Record<string, string> | undefined, ...keys: string[]): string | undefined {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== '') return obj[k];
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
function parseProcesses(psEntry: Record<string, string> | undefined): Process[] {
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

function normalizeCerts(certEntry: Record<string, string> | undefined): Ssl | null {
  if (!certEntry) return null;
  const enabled = toBool(pick(certEntry, 'ssl-enabled', 'enabled'));
  const hostnames = pick(certEntry, 'ssl-hostnames', 'hostnames');
  const issuer = pick(certEntry, 'ssl-issuer', 'issuer');
  const expiresAt = pick(certEntry, 'ssl-expires-at', 'expires-at');
  const startsAt = pick(certEntry, 'ssl-starts-at', 'starts-at');
  const verified = pick(certEntry, 'ssl-verified', 'verified');
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
    return { apps: structuredClone(DEMO.apps), source: 'demo', warnings: [] };
  }

  const warnings: string[] = [];
  let names: string[] = [];

  // App names from `dokku apps:list` (header-tolerant parsing; no --quiet needed).
  const listed = await dokkuRaw(['apps:list']);
  if (listed.ok) {
    names = parseAppNames(listed.stdout);
  } else {
    warnings.push(`apps:list failed: ${listed.error ?? listed.stderr}`);
  }

  // Fetch each report per app (see reportForApp) and key the results by app.
  const appsRep: Record<string, Record<string, string>> = {};
  const psRep: Record<string, Record<string, string>> = {};
  const domRep: Record<string, Record<string, string>> = {};
  const certRep: Record<string, Record<string, string>> = {};

  // Each worker fires 4 reports in parallel, so this is up to 16 concurrent
  // dokku invocations — plenty, without hammering the host.
  await mapLimit(names, 4, async (name) => {
    const [a, ps, dom, cert] = await Promise.all([
      reportForApp('apps', name),
      reportForApp('ps', name),
      reportForApp('domains', name),
      reportForApp('certs', name),
    ]);
    if (a) appsRep[name] = a;
    if (ps) psRep[name] = ps;
    if (dom) domRep[name] = dom;
    if (cert) certRep[name] = cert;
  });

  const apps = buildApps(names, appsRep, psRep, domRep, certRep);
  return { apps, source: 'dokku', warnings };
}

// Pure normalisation from raw dokku JSON reports into the app model.
// Exported so it can be unit-tested against sample dokku output.
export function buildApps(
  names: string[],
  appsRep: RawReport,
  psRep: RawReport,
  domRep: RawReport,
  certRep: RawReport,
): DokkuApp[] {
  return names.map((name) => {
    const a = (appsRep && appsRep[name]) || {};
    const ps = (psRep && psRep[name]) || {};
    const dom = (domRep && domRep[name]) || {};
    const cert = (certRep && certRep[name]) || {};

    const runningRaw = pick(ps, 'running');
    const appEnabled = pick(dom, 'app-enabled');
    return {
      name,
      running: runningRaw === undefined ? null : toBool(runningRaw),
      deployed: toBool(pick(ps, 'deployed')),
      deploySource: pick(a, 'deploy-source', 'deploy-source-metadata') || null,
      createdAt: pick(a, 'created-at') || null,
      restartPolicy: pick(ps, 'restart-policy', 'computed-restart-policy') || null,
      processes: parseProcesses(ps),
      domains: splitHosts(pick(dom, 'app-vhosts')),
      domainsEnabled: appEnabled === undefined ? null : toBool(appEnabled),
      ssl: normalizeCerts(cert),
    };
  });
}

// Per-app environment variables.
export async function loadConfig(appName: string, source: Source): Promise<ConfigResult> {
  if (source === 'demo' || !(await hasDokku())) {
    return { vars: structuredClone(DEMO.config[appName] || {}), source: 'demo' };
  }

  // Try JSON first (newer dokku), then fall back to parsing config:show text.
  try {
    const out = await dokku(['config:show', appName, '--format', 'json']);
    const parsed = JSON.parse(out);
    if (parsed && typeof parsed === 'object') {
      return { vars: parsed as Record<string, string>, source: 'dokku' };
    }
  } catch {
    /* fall through */
  }

  const vars: Record<string, string> = {};
  try {
    const out = await dokku(['config:show', appName]);
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('=====>')) continue;
      const idx = trimmed.indexOf(':');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim();
      if (key) vars[key] = value;
    }
  } catch (e) {
    return { vars: {}, source: 'dokku', error: (e as Error).message };
  }
  return { vars, source: 'dokku' };
}

// ---------------------------------------------------------------------------
// Log tailing
// ---------------------------------------------------------------------------

export type LogSink = (line: string, isErr: boolean) => void;

// Stream `dokku logs <app> -t` line by line. Returns a stop function that
// kills the child (or the demo generator). `onEnd` fires if the stream dies
// on its own — e.g. the app has no deployed containers to tail.
export function tailLogs(app: string, source: Source, onLine: LogSink, onEnd: (msg: string) => void): () => void {
  if (source === 'demo') {
    const paths = ['/', '/health', '/api/items', '/login', '/static/app.css'];
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

  const child = spawn(DOKKU_BIN, ['logs', app, '-t', '-n', '100'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // App output can carry ANSI colour codes, tabs and \r — all of which throw
  // off Ink's width math and cause the layout to jitter. Strip to plain text.
  const sanitize = (s: string) =>
    s.replace(/\r$/, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\t/g, '  ');
  const readLines = (stream: NodeJS.ReadableStream, isErr: boolean) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(sanitize(line), isErr);
      }
    });
  };
  readLines(child.stdout, false);
  readLines(child.stderr, true);

  let stopped = false;
  child.on('error', (e) => {
    if (!stopped) onEnd(`log stream failed: ${e.message}`);
  });
  child.on('exit', (code, signal) => {
    if (!stopped) onEnd(`log stream ended (${signal ?? `exit ${code}`})`);
  });
  return () => {
    stopped = true;
    child.kill('SIGTERM');
  };
}

// ---------------------------------------------------------------------------
// Diagnostics: `dokku-dash --doctor`
// ---------------------------------------------------------------------------

const indent = (s: string) => s.split('\n').map((l) => '  ' + l).join('\n');
const clip = (s: string, n = 500) => (s.length > n ? s.slice(0, n) + '\n  …(truncated)' : s);

export async function runDoctor(): Promise<string> {
  const L: string[] = [];
  L.push('dokku-dash doctor');
  L.push(`binary: ${DOKKU_BIN}   (override with DOKKU_DASH_BIN)`);
  L.push('');

  const v = await dokkuRaw(['version']);
  L.push(`# dokku version  ->  ${v.ok ? 'OK' : 'FAILED'}`);
  L.push(indent(clip((v.stdout || v.stderr || v.error || '').trim(), 200)));
  L.push('');

  const al = await dokkuRaw(['apps:list']);
  L.push(`# dokku apps:list  ->  ${al.ok ? 'OK' : 'FAILED'}`);
  L.push(indent(clip((al.ok ? al.stdout : al.error || al.stderr).trim(), 400)));
  const names = al.ok ? parseAppNames(al.stdout) : [];
  L.push(`  parsed ${names.length} name(s): ${names.join(', ') || '(none)'}`);
  L.push('');

  // Normalize first so the probes can target an app that actually has
  // containers — probing a never-deployed app shows no status keys and would
  // hide process-parsing bugs.
  const ov = await loadOverview();
  const probe = (ov.source === 'dokku' ? ov.apps.find((a) => a.running)?.name : undefined) ?? names[0];

  // Probe the actual strategy: per-app `<plugin>:report <app> --format json`.
  for (const plugin of ['apps', 'ps', 'domains', 'certs']) {
    if (!probe) break;
    const r = await dokkuRaw([`${plugin}:report`, probe, '--format', 'json']);
    let verdict: string;
    let keys = '';
    let obj: Record<string, string> | undefined;
    if (!r.ok) {
      verdict = 'FAILED (command errored)';
    } else {
      try {
        obj = JSON.parse(r.stdout.trim());
        verdict = 'OK (valid JSON)';
        keys = Object.keys(obj!).slice(0, 20).join(', ');
      } catch (e) {
        verdict = 'NOT valid JSON: ' + (e as Error).message;
      }
    }
    L.push(`# dokku ${plugin}:report ${probe} --format json  ->  ${verdict}`);
    L.push(indent(clip((r.ok ? r.stdout : r.error || r.stderr).trim(), plugin === 'ps' ? 900 : 300)));
    if (keys) L.push(`  keys: ${keys}`);
    if (plugin === 'ps' && obj) {
      const procs = parseProcesses(obj);
      L.push(`  parsed processes: ${procs.map((p) => `${p.type}×${p.scale}`).join(', ') || '(none)'}`);
    }
    L.push('');
  }

  L.push(`# loadOverview()  ->  source=${ov.source}, apps=${ov.apps.length}`);
  L.push(
    indent(
      ov.apps
        .map(
          (a) =>
            `${a.name}  running=${a.running}  procs=${a.processes.map((p) => `${p.type}x${p.scale}`).join(',') || '-'}  domains=${a.domains.join(' ') || '-'}  ssl=${a.ssl ? 'yes' : 'no'}`,
        )
        .join('\n') || '(no apps)',
    ),
  );
  if (ov.warnings.length) {
    L.push('warnings:');
    L.push(indent(ov.warnings.join('\n')));
  }
  return L.join('\n');
}
