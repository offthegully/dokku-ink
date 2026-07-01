// Data layer for dokku-dash.
//
// Strategy: this tool is meant to run *on the Dokku host*, so instead of
// standing up a REST API we just shell out to the `dokku` binary and parse its
// structured output. Dokku's report commands support `--format json`
// (clean keys since v0.38.0), which we use where available with defensive
// fallbacks. When `dokku` is not on PATH (e.g. local dev), we transparently
// fall back to rich demo data so every view is still explorable.

import { execFile } from 'node:child_process';
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

// Try to parse a `--format json` report. Returns an object keyed by app name,
// or null when the command/flag is unavailable or output is not JSON.
async function jsonReport(plugin: string): Promise<RawReport> {
  try {
    const out = await dokku([`${plugin}:report`, '--format', 'json']);
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === 'object' ? (parsed as RawReport) : null;
  } catch {
    return null;
  }
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
// Keys look like: "status-web-1": "running (abc123)", "status-worker-1": "..."
function parseProcesses(psEntry: Record<string, string> | undefined): Process[] {
  if (!psEntry) return [];
  const byType = new Map<string, ProcInstance[]>();
  for (const [key, value] of Object.entries(psEntry)) {
    const m = /^status-(.+)-(\d+)$/.exec(key);
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

  // App names. Prefer apps:list --quiet (one name per line).
  try {
    const out = await dokku(['apps:list', '--quiet']);
    names = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    warnings.push(`apps:list failed: ${(e as Error).message}`);
  }

  const [appsRep, psRep, domRep, certRep] = await Promise.all([
    jsonReport('apps'),
    jsonReport('ps'),
    jsonReport('domains'),
    jsonReport('certs'),
  ]);

  if (names.length === 0 && appsRep) names = Object.keys(appsRep);

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
      restartPolicy: pick(ps, 'restart-policy') || null,
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
