// Shared presentation utilities used across views.

import type { DokkuApp, Ssl } from './types.js';

export const theme = {
  accent: 'cyan',
  dim: 'gray',
  good: 'green',
  warn: 'yellow',
  bad: 'red',
  text: 'white',
} as const;

export interface Badge {
  text: string;
  color: string;
}

export function truncate(str: unknown, n: number): string {
  const s = String(str ?? '');
  if (s.length <= n) return s;
  if (n <= 1) return s.slice(0, Math.max(0, n));
  return s.slice(0, n - 1) + '…';
}

export function padEnd(str: unknown, n: number): string {
  return truncate(str, n).padEnd(n);
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 10);
}

export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - Date.now()) / 86400000);
}

export function runningBadge(app: Pick<DokkuApp, 'running' | 'deployed'>): Badge {
  if (app.running === true) return { text: '● running', color: theme.good };
  if (app.running === false) {
    // An app that was never deployed isn't in trouble — don't paint it red.
    if (!app.deployed) return { text: '· not deployed', color: theme.dim };
    return { text: '○ stopped', color: theme.bad };
  }
  return { text: '· unknown', color: theme.dim };
}

export function sslBadge(ssl: Ssl | null | undefined): Badge {
  if (!ssl || !ssl.enabled) return { text: 'none', color: theme.dim };
  const days = daysUntil(ssl.expiresAt);
  const issuer = ssl.issuer && /let'?s\s*encrypt/i.test(ssl.issuer) ? 'LE' : 'SSL';
  if (days !== null && days < 0) return { text: `${issuer} expired`, color: theme.bad };
  if (days !== null && days <= 14) return { text: `${issuer} ${days}d left`, color: theme.warn };
  return { text: `${issuer} ✔`, color: theme.good };
}

// The app whose SSL certificate expires soonest — surfaced in the header so
// an upcoming renewal is hard to miss.
export function soonestCert(apps: DokkuApp[]): { app: string; days: number } | null {
  let best: { app: string; days: number } | null = null;
  for (const a of apps) {
    if (!a.ssl?.enabled) continue;
    const days = daysUntil(a.ssl.expiresAt);
    if (days === null) continue;
    if (!best || days < best.days) best = { app: a.name, days };
  }
  return best;
}

// Leading RFC3339 timestamp of a `docker logs -t` line, or null. Used to skip
// the replayed head when re-attaching to a log stream we already have cached:
// timestamps are lexicographically ordered, so `ts <= lastSeen` means "old".
export function leadingTimestamp(line: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)/.exec(line);
  return m ? m[1] : null;
}

// Window an array around a selected index so it fits `size` rows.
export function windowed<T>(
  list: T[],
  selected: number,
  size: number,
): { start: number; items: T[]; end: number } {
  if (list.length <= size) return { start: 0, items: list, end: list.length };
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), list.length - size));
  return { start, items: list.slice(start, start + size), end: start + size };
}
