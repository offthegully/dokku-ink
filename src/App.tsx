// Main TUI for dokku-dash: a read-only dashboard over a Dokku host plus a
// built-in command cheat sheet.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  theme,
  truncate,
  padEnd,
  fmtAge,
  fmtDate,
  daysUntil,
  leadingTimestamp,
  runningBadge,
  soonestCert,
  sslBadge,
  windowed,
} from './ui.js';
import { loadOverview, loadConfig, tailLogs, watchEvents } from './dokku.js';
import { CHEATSHEET } from './cheatsheet.js';
import type { DokkuApp, Overview, Source } from './types.js';

interface ViewDef {
  key: 'apps' | 'domains' | 'process' | 'config' | 'logs' | 'cheatsheet';
  label: string;
  perApp: boolean;
}

const VIEWS: ViewDef[] = [
  { key: 'apps', label: 'Apps', perApp: false },
  { key: 'domains', label: 'Domains & SSL', perApp: true },
  { key: 'process', label: 'Processes', perApp: true },
  { key: 'config', label: 'Config / Env', perApp: true },
  { key: 'logs', label: 'Logs', perApp: true },
  { key: 'cheatsheet', label: 'Cheat Sheet', perApp: false },
];

// Auto-refresh cadence for overview data. Configurable via DOKKU_DASH_REFRESH
// (seconds); 0 disables polling.
const REFRESH_SECONDS = (() => {
  const raw = Number(process.env.DOKKU_DASH_REFRESH ?? 30);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
})();
// The view you're staring at should feel closer to real time: while the
// Processes view is open, poll on a tighter leash (never slower than the
// configured cadence, never faster than 10s).
const FAST_REFRESH_SECONDS = REFRESH_SECONDS ? Math.min(10, REFRESH_SECONDS) : 0;

const LOG_CAP = 500;
// Keep per-app log buffers around after leaving the view, so flipping between
// apps (or views) and back doesn't drop scrollback or re-replay history.
const LOG_CACHE_TTL_MS = 5 * 60_000;

interface LogLine {
  text: string;
  err: boolean;
}

type Focus = 'menu' | 'content';

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useTerminalSize(): { columns: number; rows: number } {
  const get = () => ({
    columns: process.stdout?.columns || 80,
    rows: process.stdout?.rows || 24,
  });
  const [size, setSize] = useState(get);
  useEffect(() => {
    const on = () => setSize(get());
    process.stdout?.on?.('resize', on);
    return () => {
      process.stdout?.off?.('resize', on);
    };
  }, []);
  return size;
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function Loading(): ReactNode {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % SPINNER.length), 90);
    return () => clearInterval(t);
  }, []);
  return (
    <Box padding={1}>
      <Text color={theme.accent}>{SPINNER[i]} </Text>
      <Text>Loading Dokku data…</Text>
    </Box>
  );
}

function Header({
  source,
  host,
  count,
  cert,
  refreshing,
  age,
}: {
  source: Source;
  host: string;
  count: number;
  cert: { app: string; days: number } | null;
  refreshing: boolean;
  age: number | null; // seconds since the last successful refresh
}): ReactNode {
  // Fixed-width slot so the readout never nudges the rest of the header.
  const fresh = refreshing ? '↻ …' : age !== null ? `↻ ${fmtAge(age)}` : '';
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text color={theme.accent} bold>
          dokku-dash
        </Text>
        <Text wrap="truncate-end" color={theme.dim}> · {host}</Text>
      </Box>
      <Box>
        <Text color={refreshing ? theme.accent : theme.dim}>{padEnd(fresh, 8)}</Text>
        {cert ? (
          <Text wrap="truncate-end" color={cert.days < 0 ? theme.bad : cert.days <= 14 ? theme.warn : theme.dim}>
            cert: {cert.app} {cert.days < 0 ? 'expired' : `${cert.days}d`}{'  '}
          </Text>
        ) : null}
        <Text color={theme.dim}>
          {count} app{count === 1 ? '' : 's'}{'  '}
        </Text>
        {source === 'demo' ? (
          <Text backgroundColor={theme.warn} color="black">
            {' DEMO DATA '}
          </Text>
        ) : (
          <Text backgroundColor={theme.good} color="black">
            {' LIVE '}
          </Text>
        )}
      </Box>
    </Box>
  );
}

function Menu({ view, focused }: { view: number; focused: boolean }): ReactNode {
  return (
    <Box flexDirection="column" width={24} flexShrink={0} borderStyle="round" borderColor={focused ? theme.accent : theme.dim} paddingX={1}>
      <Text color={theme.dim}>VIEWS</Text>
      {VIEWS.map((v, i) => {
        const sel = i === view;
        return (
          <Text key={v.key} wrap="truncate-end" backgroundColor={sel ? theme.accent : undefined} color={sel ? 'black' : theme.text}>
            {sel ? '›' : ' '} {i + 1} {padEnd(v.label, 14)}
          </Text>
        );
      })}
    </Box>
  );
}

function AppSelector({
  apps,
  selected,
  focused,
  height,
}: {
  apps: DokkuApp[];
  selected: number;
  focused: boolean;
  height: number;
}): ReactNode {
  const { start, items } = windowed(apps, selected, height);
  return (
    <Box flexDirection="column" width={20} flexShrink={0} borderStyle="round" borderColor={focused ? theme.accent : theme.dim} paddingX={1}>
      <Text color={theme.dim}>APPS</Text>
      {items.map((a, i) => {
        const idx = start + i;
        const sel = idx === selected;
        const dot = a.running === true ? theme.good : a.running === false ? theme.bad : theme.dim;
        return (
          <Box key={a.name}>
            <Text color={dot}>{sel ? '●' : '·'} </Text>
            <Text wrap="truncate-end" backgroundColor={sel && focused ? theme.accent : undefined} color={sel && focused ? 'black' : theme.text}>
              {padEnd(a.name, 12)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function Footer({ view, focused }: { view: number; focused: Focus }): ReactNode {
  const v = VIEWS[view];
  const keys: Array<[string, string]> = [
    [`1-${VIEWS.length}`, 'view'],
    ['tab', focused === 'menu' ? 'focus list' : 'focus menu'],
    ['↑↓', focused === 'menu' ? 'change view' : v.key === 'logs' ? 'scroll logs' : v.perApp ? 'select app' : 'scroll'],
  ];
  if (v.perApp) keys.push(['←→', 'switch app']);
  if (v.key === 'config') keys.push(['s', 'reveal/hide']);
  keys.push(['r', 'refresh']);
  keys.push(['q', 'quit']);
  return (
    <Box paddingX={1}>
      {keys.map(([k, label], i) => (
        <Text key={k}>
          <Text color={theme.accent} bold>
            {k}
          </Text>
          <Text color={theme.dim}>
            {' '}
            {label}
            {i < keys.length - 1 ? '   ' : ''}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function AppsView({
  apps,
  viewport,
  scroll,
}: {
  apps: DokkuApp[];
  viewport: number;
  scroll: number;
}): ReactNode {
  if (apps.length === 0) return <Text color={theme.dim}>No apps found.</Text>;
  // Fixed-width columns first, then the flexible DOMAIN column last so it can
  // truncate without disturbing alignment. Every cell is truncate-end so a
  // narrow terminal degrades gracefully instead of wrapping the grid.
  const nameW = Math.min(28, Math.max(10, ...apps.map((a) => a.name.length)) + 2);
  const statusW = 16;
  const procW = 16;
  const sslW = 11;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end" color={theme.dim}>
        {padEnd('NAME', nameW) + padEnd('STATUS', statusW) + padEnd('PROCESSES', procW) + padEnd('SSL', sslW) + 'DOMAIN'}
      </Text>
      {apps.slice(scroll, scroll + viewport).map((a) => {
        const rb = runningBadge(a);
        const proc = a.processes.map((p) => `${p.type}×${p.scale}`).join(' ') || '—';
        const domain =
          a.domains.length === 0 ? '—' : a.domains[0] + (a.domains.length > 1 ? ` +${a.domains.length - 1}` : '');
        const sb = sslBadge(a.ssl);
        return (
          <Box key={a.name}>
            <Text wrap="truncate-end" bold>{padEnd(a.name, nameW)}</Text>
            <Text wrap="truncate-end" color={rb.color}>{padEnd(rb.text, statusW)}</Text>
            <Text wrap="truncate-end">{padEnd(proc, procW)}</Text>
            <Text wrap="truncate-end" color={sb.color}>{padEnd(sb.text, sslW)}</Text>
            <Text wrap="truncate-end" color={theme.dim}>{domain}</Text>
          </Box>
        );
      })}
      {scrollHint(apps.length, scroll, viewport)}
    </Box>
  );
}

function DomainsView({ app }: { app?: DokkuApp }): ReactNode {
  if (!app) return <Text color={theme.dim}>No app selected.</Text>;
  const sb = sslBadge(app.ssl);
  const days = app.ssl ? daysUntil(app.ssl.expiresAt) : null;
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        {app.name}
      </Text>
      <Text>
        Routing:{' '}
        {app.domainsEnabled === false ? (
          <Text color={theme.warn}>disabled</Text>
        ) : (
          <Text color={theme.good}>enabled</Text>
        )}
      </Text>
      <Text> </Text>
      <Text color={theme.dim}>DOMAINS</Text>
      {app.domains.length === 0 ? (
        <Text color={theme.dim}> (none set)</Text>
      ) : (
        app.domains.map((d, i) => (
          <Text key={i} wrap="truncate-end">
            {' '}• {d}
          </Text>
        ))
      )}
      <Text> </Text>
      <Text color={theme.dim}>SSL CERTIFICATE</Text>
      <Text wrap="truncate-end">
        {' '}
        Status: <Text color={sb.color}>{sb.text}</Text>
      </Text>
      {app.ssl ? (
        <>
          {app.ssl.issuer ? <Text wrap="truncate-end"> Issuer: {app.ssl.issuer}</Text> : null}
          <Text wrap="truncate-end">
            {' '}
            Expires: {fmtDate(app.ssl.expiresAt)}
            {days !== null ? <Text color={days <= 14 ? theme.warn : theme.dim}> ({days}d)</Text> : null}
          </Text>
        </>
      ) : null}
    </Box>
  );
}

function statusColor(s: string): string {
  if (/^running/i.test(s)) return theme.good;
  if (/^exited \(0\)/i.test(s)) return theme.dim;
  if (/^exited/i.test(s)) return theme.bad;
  return theme.warn;
}

function ProcessView({ app }: { app?: DokkuApp }): ReactNode {
  if (!app) return <Text color={theme.dim}>No app selected.</Text>;
  const rb = runningBadge(app);
  return (
    <Box flexDirection="column">
      <Text bold color={theme.accent}>
        {app.name}
      </Text>
      <Text>
        State: <Text color={rb.color}>{rb.text}</Text>
        {'   '}Restart: {app.restartPolicy || '—'}
      </Text>
      <Text> </Text>
      {app.processes.length === 0 ? <Text color={theme.dim}>No process info (not deployed?)</Text> : null}
      {app.processes.map((p) => (
        <Box key={p.type} flexDirection="column">
          <Text bold>
            {p.type} <Text color={theme.dim}>scale {p.scale}</Text>
          </Text>
          {p.instances.map((inst) => (
            <Text key={inst.index} wrap="truncate-end">
              {'  '}
              {p.type}.{inst.index}{'  '}
              <Text color={statusColor(inst.status)}>{inst.status}</Text>
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function ConfigView({
  app,
  config,
  loading,
  reveal,
  viewport,
  scroll,
}: {
  app?: DokkuApp;
  config?: Record<string, string>;
  loading: boolean;
  reveal: boolean;
  viewport: number;
  scroll: number;
}): ReactNode {
  if (!app) return <Text color={theme.dim}>No app selected.</Text>;
  if (loading) return <Text color={theme.dim}>Loading config for {app.name}…</Text>;
  const entries = Object.entries(config || {}).sort((a, b) => a[0].localeCompare(b[0]));
  const head = (
    <Text wrap="truncate-end">
      <Text bold color={theme.accent}>
        {app.name}
      </Text>
      <Text color={reveal ? theme.bad : theme.dim}>
        {'  '}
        {reveal ? '· values shown — press s to hide' : `· ${entries.length} vars · press s to reveal`}
      </Text>
    </Text>
  );
  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        {head}
        <Text color={theme.dim}>No config set.</Text>
      </Box>
    );
  }
  const keyW = Math.min(28, Math.max(8, entries.reduce((m, [k]) => Math.max(m, k.length), 0)));
  return (
    <Box flexDirection="column">
      {head}
      {entries.slice(scroll, scroll + viewport).map(([k, v]) => {
        const shown = reveal ? String(v) : '•'.repeat(8);
        return (
          <Box key={k}>
            <Text wrap="truncate-end" color={theme.accent}>{padEnd(k, keyW)}</Text>
            <Text color={theme.dim}> = </Text>
            <Text wrap="truncate-end" color={reveal ? theme.text : theme.dim}>{shown}</Text>
          </Box>
        );
      })}
      {scrollHint(entries.length, scroll, viewport)}
    </Box>
  );
}

function LogsView({
  app,
  lines,
  viewport,
  offset,
  width,
}: {
  app?: DokkuApp;
  lines: LogLine[];
  viewport: number;
  offset: number; // scrollback distance from the live tail (0 = following)
  width: number;
}): ReactNode {
  if (!app) return <Text color={theme.dim}>No app selected.</Text>;
  const rows = Math.max(1, viewport - 1); // one row reserved for the status line
  const end = Math.max(0, lines.length - offset);
  const visible = lines.slice(Math.max(0, end - rows), end);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={theme.accent}>
          {app.name}
        </Text>
        <Text color={theme.dim}>
          {'  '}· dokku logs -t · {lines.length}{lines.length === LOG_CAP ? '+' : ''} lines
        </Text>
        {offset > 0 ? <Text color={theme.warn}>  · scrollback ↑{offset} (↓ to follow)</Text> : null}
      </Text>
      {visible.length === 0 ? (
        <Text color={theme.dim}>Waiting for log output…</Text>
      ) : (
        // Truncated in JS (not just wrap=) so Yoga never measures an over-wide
        // line — long lines would otherwise squeeze the fixed side panes.
        visible.map((l, i) => (
          <Text key={end - visible.length + i} color={l.err ? theme.warn : theme.text}>
            {truncate(l.text, width)}
          </Text>
        ))
      )}
    </Box>
  );
}

type CheatLine =
  | { type: 'spacer' }
  | { type: 'group'; text: string }
  | { type: 'item'; cmd: string; desc: string };

function cheatLines(): CheatLine[] {
  const out: CheatLine[] = [];
  CHEATSHEET.forEach((g, gi) => {
    if (gi > 0) out.push({ type: 'spacer' });
    out.push({ type: 'group', text: g.group });
    g.items.forEach(([cmd, desc]) => out.push({ type: 'item', cmd, desc }));
  });
  return out;
}

function CheatsheetView({
  width,
  viewport,
  scroll,
}: {
  width: number;
  viewport: number;
  scroll: number;
}): ReactNode {
  const lines = cheatLines();
  const cmdW = Math.min(44, Math.max(22, Math.floor(width * 0.5)));
  return (
    <Box flexDirection="column">
      {lines.slice(scroll, scroll + viewport).map((l, i) => {
        if (l.type === 'spacer') return <Text key={i}> </Text>;
        if (l.type === 'group')
          return (
            <Text key={i} bold color={theme.accent}>
              ▌ {l.text}
            </Text>
          );
        return (
          <Box key={i}>
            <Text wrap="truncate-end" color={theme.good}>{padEnd(truncate(l.cmd, cmdW), cmdW)}</Text>
            <Text wrap="truncate-end" color={theme.dim}> {l.desc}</Text>
          </Box>
        );
      })}
      {scrollHint(lines.length, scroll, viewport)}
    </Box>
  );
}

function scrollHint(total: number, scroll: number, viewport: number): ReactNode {
  if (total <= viewport) return null;
  const more = total - (scroll + viewport);
  const parts: string[] = [];
  if (scroll > 0) parts.push(`↑ ${scroll} above`);
  if (more > 0) parts.push(`↓ ${more} below`);
  return <Text color={theme.dim}>{'  '}{parts.join('   ')}</Text>;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App(): ReactNode {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const [view, setView] = useState(0);
  const [focus, setFocus] = useState<Focus>('menu');
  const [selectedApp, setSelectedApp] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [reveal, setReveal] = useState(false);

  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped on every successful refresh; config entries carry the version they
  // were fetched under, so stale ones refetch silently on the next look.
  const [dataV, setDataV] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [configCache, setConfigCache] = useState<Record<string, { vars: Record<string, string>; v: number }>>({});
  const [configLoading, setConfigLoading] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);

  const apps = data ? data.apps : [];
  const source: Source = data ? data.source : 'demo';
  const currentView = VIEWS[view];
  const currentApp: DokkuApp | undefined = apps[selectedApp];

  // One refresh path for launch, `r`, the poll timer and pushed events — it
  // never flashes the spinner and never drops caches; versioning (dataV)
  // invalidates config entries instead.
  const refreshInFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    const result = await loadOverview();
    setData(result);
    setDataV((v) => v + 1);
    setLastUpdated(Date.now());
    setLoading(false);
    setRefreshing(false);
    refreshInFlight.current = false;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pollSeconds = currentView.key === 'process' ? FAST_REFRESH_SECONDS : REFRESH_SECONDS;
  useEffect(() => {
    if (!pollSeconds) return;
    const t = setInterval(() => {
      void refresh();
    }, pollSeconds * 1000);
    return () => clearInterval(t);
  }, [refresh, pollSeconds]);

  // Event-driven refresh: deploys/restarts/scaling show up within ~2s instead
  // of waiting out the poll. Needs `dokku events:on`; otherwise the watcher
  // dies instantly and polling carries on alone.
  useEffect(() => {
    if (source !== 'dokku') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = watchEvents(() => {
      if (timer) return; // a deploy emits a burst of events — refresh once
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, 2000);
    });
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [source, refresh]);

  // 1s tick so the "↻ 12s" freshness readout in the header stays honest.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setScroll(0);
  }, [view]);

  useEffect(() => {
    if (selectedApp > apps.length - 1) setSelectedApp(Math.max(0, apps.length - 1));
  }, [apps.length, selectedApp]);

  // Tail logs while the Logs view is showing an app. Lines are buffered and
  // flushed on an interval so a chatty app doesn't re-render per line.
  // Buffers are cached per app so coming back within the TTL shows history
  // instantly; the re-attach replay (`-n 100`) is deduped by timestamp.
  const logCache = useRef(new Map<string, { lines: LogLine[]; at: number }>());
  const logApp = currentView.key === 'logs' ? currentApp?.name : undefined;
  useEffect(() => {
    if (!logApp) return;
    const cached = logCache.current.get(logApp);
    const seed = cached && Date.now() - cached.at < LOG_CACHE_TTL_MS ? cached.lines : [];
    setLogLines(seed);

    // The replay is chronological, so drop lines until we pass the last
    // timestamp we already have; anything unstamped ends the sync.
    const lastTs = seed.length ? leadingTimestamp(seed[seed.length - 1].text) : null;
    let syncing = lastTs !== null;
    const buf: LogLine[] = [];
    const push = (text: string, err: boolean) => {
      if (syncing) {
        const ts = leadingTimestamp(text);
        if (ts && ts <= lastTs!) return;
        syncing = false;
      }
      buf.push({ text, err });
    };

    const flush = setInterval(() => {
      if (buf.length === 0) return;
      const chunk = buf.splice(0, buf.length);
      setLogLines((prev) => {
        const next = prev.concat(chunk);
        const capped = next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
        logCache.current.set(logApp, { lines: capped, at: Date.now() });
        return capped;
      });
    }, 150);
    const stop = tailLogs(logApp, source, push, (msg) => push(msg, true));
    return () => {
      clearInterval(flush);
      stop();
      // TTL counts from when we left the view, not from the last log line.
      const cur = logCache.current.get(logApp);
      if (cur) cur.at = Date.now();
    };
  }, [logApp, source]);

  // Lazily load config for the selected app when on the config view. An entry
  // fetched under an older dataV refetches silently (stale values stay on
  // screen meanwhile) so the view tracks `r`, the poll and pushed events.
  useEffect(() => {
    if (currentView.key !== 'config' || !currentApp) return;
    const entry = configCache[currentApp.name];
    if (entry && entry.v === dataV) return;
    let cancelled = false;
    if (!entry) setConfigLoading(true);
    void loadConfig(currentApp.name, source).then((res) => {
      if (cancelled) return;
      setConfigCache((c) => ({ ...c, [currentApp.name]: { vars: res.vars, v: dataV } }));
      setConfigLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentView.key, currentApp, source, configCache, dataV]);

  // Layout sizing. Boxes get explicit widths that sum to `columns` so nothing
  // overflows; `colBudget` is the usable text width inside the content pane
  // (minus borders, padding and a safety margin so lines never soft-wrap).
  const menuW = 24;
  const selW = 20;
  const contentW = Math.max(30, columns - menuW - (currentView.perApp ? selW : 0));
  const colBudget = Math.max(20, contentW - 5);
  const viewport = Math.max(3, rows - 7);

  const clampScroll = useCallback((delta: number, total: number) => {
    setScroll((s) => Math.min(Math.max(0, s + delta), Math.max(0, total - viewport)));
  }, [viewport]);

  useInput((input, key) => {
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
      return;
    }
    if (input >= '1' && input <= String(VIEWS.length)) {
      setView(Number(input) - 1);
      return;
    }
    if (key.tab) {
      setFocus((f) => (f === 'menu' ? 'content' : 'menu'));
      return;
    }
    if (input === 'r') {
      void refresh();
      return;
    }
    if (input === 's' && currentView.key === 'config') {
      setReveal((v) => !v);
      return;
    }

    // ←/→ (h/l) always switches the selected app in per-app views, even when
    // ↑/↓ is busy scrolling long content (e.g. a big config list).
    const left = key.leftArrow || input === 'h';
    const right = key.rightArrow || input === 'l';
    if ((left || right) && currentView.perApp) {
      setSelectedApp((i) => Math.min(Math.max(0, i + (right ? 1 : -1)), apps.length - 1));
      setScroll(0);
      return;
    }

    const up = key.upArrow || input === 'k';
    const down = key.downArrow || input === 'j';
    if (!up && !down) return;
    const delta = up ? -1 : 1;

    if (focus === 'menu') {
      setView((v) => (v + delta + VIEWS.length) % VIEWS.length);
      return;
    }
    // focus === 'content'
    if (currentView.perApp) {
      if (currentView.key === 'logs') {
        // ↑ digs into scrollback, ↓ moves back toward the live tail.
        const max = Math.max(0, logLines.length - (viewport - 1));
        setScroll((s) => Math.min(Math.max(0, s + (up ? 1 : -1)), max));
        return;
      }
      if (currentView.key === 'config') {
        const total = currentApp ? Object.keys(configCache[currentApp.name]?.vars || {}).length : 0;
        if (total > viewport) {
          clampScroll(delta, total);
          return;
        }
      }
      setSelectedApp((i) => Math.min(Math.max(0, i + delta), apps.length - 1));
      setScroll(0);
    } else {
      const total = currentView.key === 'cheatsheet' ? cheatLines().length : apps.length;
      clampScroll(delta, total);
    }
  });

  if (loading && !data) {
    return (
      <Box flexDirection="column" height={rows}>
        <Header source={source} host={hostLabel()} count={0} cert={null} refreshing={false} age={null} />
        <Loading />
      </Box>
    );
  }

  let content: ReactNode = null;
  switch (currentView.key) {
    case 'apps':
      content = <AppsView apps={apps} viewport={viewport} scroll={scroll} />;
      break;
    case 'domains':
      content = <DomainsView app={currentApp} />;
      break;
    case 'process':
      content = <ProcessView app={currentApp} />;
      break;
    case 'config':
      content = (
        <ConfigView
          app={currentApp}
          config={currentApp ? configCache[currentApp.name]?.vars : {}}
          loading={configLoading && !(currentApp && configCache[currentApp.name])}
          reveal={reveal}
          viewport={viewport}
          scroll={scroll}
        />
      );
      break;
    case 'logs':
      content = <LogsView app={currentApp} lines={logLines} viewport={viewport} offset={scroll} width={colBudget} />;
      break;
    case 'cheatsheet':
      content = <CheatsheetView width={colBudget} viewport={viewport} scroll={scroll} />;
      break;
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Header
        source={source}
        host={hostLabel()}
        count={apps.length}
        cert={soonestCert(apps)}
        refreshing={refreshing && !loading}
        age={lastUpdated !== null ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : null}
      />
      <Box flexGrow={1}>
        <Menu view={view} focused={focus === 'menu'} />
        {currentView.perApp ? (
          <AppSelector apps={apps} selected={selectedApp} focused={focus === 'content'} height={viewport} />
        ) : null}
        <Box
          width={contentW}
          flexShrink={0}
          flexDirection="column"
          borderStyle="round"
          borderColor={focus === 'content' && !currentView.perApp ? theme.accent : theme.dim}
          paddingX={1}
        >
          <Text color={theme.dim}>{currentView.label.toUpperCase()}</Text>
          {content}
        </Box>
      </Box>
      <Footer view={view} focused={focus} />
    </Box>
  );
}

function hostLabel(): string {
  return process.env.DOKKU_DASH_HOST || process.env.HOSTNAME || 'local';
}
