// Best-effort "a newer release exists" check, surfaced as a small chip in the
// header. dokku-ink is distributed as self-contained binaries from GitHub
// Releases (see install.sh / README), so the source of truth is the repo's
// latest release tag — not the npm registry. Everything here is non-blocking
// and swallows every error: an update hint is a nicety, never worth a stall or
// a stack trace over the TUI.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const REPO = 'offthegully/dokku-ink';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// Unauthenticated GitHub API allows 60 req/hr per IP, so we only actually hit
// the network once a day and serve the remembered tag from a cache in between.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

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

async function fetchLatestTag(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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
