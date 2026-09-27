// Best-effort "a newer release exists" check, surfaced as a small chip in the
// header. dokku-ink is distributed as self-contained binaries from GitHub
// Releases (see install.sh / README), so the source of truth is the repo's
// latest release tag — not the npm registry. Everything here is non-blocking
// and swallows every error: an update hint is a nicety, never worth a stall or
// a stack trace over the TUI.

import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

const REPO = 'offthegully/dokku-ink';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// Unauthenticated GitHub API allows 60 req/hr per IP, so we only actually hit
// the network once a day and serve the remembered tag from a cache in between.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;
// The binary is tens of MB; give a slow link room before giving up.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

interface Cache {
  checkedAt: number;
  latest: string | null;
}

function optedOut(): boolean {
  // DOKKU_INK_NO_UPDATE_CHECK is ours; NO_UPDATE_NOTIFIER is the de-facto
  // cross-tool convention a lot of people already set globally.
  return Boolean(process.env.DOKKU_INK_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER);
}

function cacheFile(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'dokku-ink', 'update.json');
}

async function readCache(): Promise<Cache | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), 'utf8')) as Partial<Cache>;
    if (typeof parsed.checkedAt !== 'number') return null;
    return { checkedAt: parsed.checkedAt, latest: parsed.latest ?? null };
  } catch {
    return null;
  }
}

async function writeCache(cache: Cache): Promise<void> {
  try {
    const file = cacheFile();
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify(cache));
  } catch {
    // A read-only or unwritable cache dir just means we re-fetch next launch.
  }
}

async function fetchLatestTag(timeoutMs = FETCH_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(LATEST_URL, {
      // GitHub rejects requests without a User-Agent; the Accept header pins
      // the response to the versioned REST schema.
      headers: { 'User-Agent': 'dokku-ink', Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { tag_name?: unknown };
    return typeof json.tag_name === 'string' ? json.tag_name : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Semver-ish tuple [major, minor, patch]; ignores a leading `v` and any
 *  `-prerelease`/`+build` suffix. Anything unparseable degrades to 0. */
function parse(version: string): [number, number, number] {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/, 1)[0] ?? '';
  const [maj, min, pat] = core.split('.');
  const n = (s?: string) => {
    const v = parseInt(s ?? '', 10);
    return Number.isFinite(v) ? v : 0;
  };
  return [n(maj), n(min), n(pat)];
}

/** True when `latest` is a strictly higher release than `current`. Exported
 *  for unit tests; the comparison is the only interesting logic here. */
export function isNewer(latest: string, current: string): boolean {
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/**
 * Resolve the latest release tag (cached for a day) and return it only when it
 * is newer than `current`; otherwise null. Never throws — callers can fire it
 * and forget. The tag is returned as published (e.g. `v0.1.4`); the caller
 * strips any `v` for display.
 */
export async function checkForUpdate(current: string): Promise<string | null> {
  if (optedOut()) return null;

  const cached = await readCache();
  let latest: string | null;
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    latest = cached.latest;
  } else {
    latest = await fetchLatestTag();
    // Remember even a null result so a flaky network doesn't re-hit the API on
    // every launch inside the TTL window.
    await writeCache({ checkedAt: Date.now(), latest });
  }

  return latest && isNewer(latest, current) ? latest : null;
}

// --- self-update -----------------------------------------------------------
// `dokku-ink update` (and the dashboard's `U` key) replaces the running binary
// with the latest release, mirroring what install.sh does: same asset names,
// same SHA256SUMS file. Unlike the check above, this path is user-initiated,
// so it reports every failure instead of swallowing it.

/** Release asset for a platform, as named by scripts/build-all.ts; null when
 *  there's no prebuilt binary for it. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : null;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  return os && cpu ? `dokku-ink-${os}-${cpu}` : null;
}

/** Parse `sha256sum` output (`<hex>  <name>`, optionally `*<name>` for binary
 *  mode) into name -> lowercase hex. */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

async function download(url: string): Promise<Buffer | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dokku-ink' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function isPermissionError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

export interface SelfUpdateResult {
  ok: boolean;
  /** Absolute path of the (possibly replaced) binary — relaunch this. */
  binary: string;
  /** False when already on the latest release (ok is still true). */
  updated: boolean;
}

/**
 * Download the latest release for this platform and atomically swap it in
 * over the running binary. Progress and errors go to `log` (stderr by
 * default). `compiled` must be true — from source there's no binary to
 * replace, and process.execPath would be bun itself.
 */
export async function selfUpdate(
  current: string,
  { compiled, log = (m: string) => console.error(m) }: { compiled: boolean; log?: (m: string) => void },
): Promise<SelfUpdateResult> {
  const fail = (msg: string, binary = process.execPath): SelfUpdateResult => {
    log(`\u001B[31merror:\u001B[0m ${msg}`);
    return { ok: false, binary, updated: false };
  };

  if (!compiled) {
    return fail("self-update only works on an installed binary; you're running from source (git pull instead).");
  }
  const asset = assetName();
  if (!asset) return fail(`no prebuilt binary for ${process.platform}/${process.arch}.`);

  // Under sudo, HOME may still be the invoking user's; a root-owned cache
  // file there would silently break the daily check, so don't touch it.
  const remember = (tag: string) =>
    process.env.SUDO_USER ? Promise.resolve() : writeCache({ checkedAt: Date.now(), latest: tag });

  let target: string;
  try {
    target = realpathSync(process.execPath);
  } catch {
    target = process.execPath;
  }

  log('==> checking for the latest release');
  const tag = await fetchLatestTag(15_000);
  if (!tag) return fail("couldn't reach GitHub to find the latest release.", target);
  const latest = tag.replace(/^v/i, '');
  if (!isNewer(tag, current)) {
    log(`==> already on the latest release (${current})`);
    await remember(tag);
    return { ok: true, binary: target, updated: false };
  }

  const base = `https://github.com/${REPO}/releases/download/${tag}`;
  log(`==> downloading ${asset} ${latest} (you have ${current})`);
  let bin: Buffer | null;
  let sumsText: Buffer | null;
  try {
    [bin, sumsText] = await Promise.all([download(`${base}/${asset}`), download(`${base}/SHA256SUMS`)]);
  } catch (err) {
    return fail(`download failed: ${(err as Error).message}`, target);
  }
  if (!bin) return fail(`release ${tag} has no ${asset} asset.`, target);

  // Releases before checksums were published have no SHA256SUMS; accept those
  // on HTTPS alone, but once a sums file exists it must list and match us.
  if (sumsText) {
    const expected = parseSums(sumsText.toString('utf8')).get(asset);
    const actual = createHash('sha256').update(bin).digest('hex');
    if (!expected) return fail(`SHA256SUMS for ${tag} doesn't list ${asset}.`, target);
    if (expected !== actual) return fail(`checksum mismatch for ${asset} (expected ${expected}, got ${actual}).`, target);
    log('==> checksum verified');
  } else {
    log(`==> no SHA256SUMS published for ${tag}; skipping checksum`);
  }

  // Stage next to the target so the final rename stays on one filesystem
  // (atomic, and safe while the old binary is still running).
  const tmp = join(dirname(target), `.${basename(target)}.update-${process.pid}`);
  try {
    await writeFile(tmp, bin, { mode: 0o755 });
  } catch (err) {
    if (isPermissionError(err)) {
      return fail(`no permission to write to ${dirname(target)}. Re-run with: sudo ${target} update`, target);
    }
    return fail(`couldn't stage the new binary: ${(err as Error).message}`, target);
  }

  // Smoke-test before swapping: a truncated or wrong-arch binary fails here,
  // not on the user's next launch.
  const probe = spawnSync(tmp, ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (probe.status !== 0 || !probe.stdout.includes(latest)) {
    await unlink(tmp).catch(() => {});
    return fail(`the downloaded binary didn't run (${(probe.stderr || probe.error?.message || 'no output').trim()}).`, target);
  }

  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    if (isPermissionError(err)) {
      return fail(`no permission to replace ${target}. Re-run with: sudo ${target} update`, target);
    }
    return fail(`couldn't replace ${target}: ${(err as Error).message}`, target);
  }

  await remember(tag);
  log(`==> updated dokku-ink ${current} -> ${latest}`);
  return { ok: true, binary: target, updated: true };
}
