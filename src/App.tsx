// Main TUI for dokku-dash: a read-only dashboard over a Dokku host plus a
// built-in command cheat sheet.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  theme,
  truncate,
  padEnd,
  fmtAge,
  fmtAgeDays,
  fmtBytes,
  fmtDate,
  fmtPct,
  appUsage,
  daysUntil,
  leadingTimestamp,
  runningBadge,
  soonestCert,
  sslBadge,
  windowed,
} from './ui.js';
import {
  loadOverview,
  loadOverviewLight,
  loadConfig,
  loadServices,
  loadStats,
  loadAppDetail,
  runCommand,
  tailLogs,
  watchEvents,
} from './dokku.js';
import { remoteLabel } from './exec.js';
import { CHEATSHEET } from './cheatsheet.js';
import type {
  AppDetail,
  DokkuApp,
  DokkuService,
  HostDisk,
  Overview,
  Source,
  StatsMap,
  StatsResult,
} from './types.js';

interface ViewDef {
  key: 'apps' | 'domains' | 'process' | 'config' | 'logs' | 'services' | 'cheatsheet';
  label: string;
  /** Compact label for the tab bar on narrow terminals. */
  short: string;
  perApp: boolean;
}

const VIEWS: ViewDef[] = [
  { key: 'apps', label: 'Apps', short: 'Apps', perApp: false },
  { key: 'domains', label: 'Domains & SSL', short: 'Domains', perApp: true },
  { key: 'process', label: 'Processes', short: 'Procs', perApp: true },
  { key: 'config', label: 'Config / Env', short: 'Config', perApp: true },
  { key: 'logs', label: 'Logs', short: 'Logs', perApp: true },
  { key: 'services', label: 'Services', short: 'Services', perApp: false },
  { key: 'cheatsheet', label: 'Cheat Sheet', short: 'Cheats', perApp: false },
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
// Most polls are "light" (ps + docker stats only); every Nth does the full
// report sweep. Deploys/config changes trigger a full refresh via events.
const FULL_REFRESH_EVERY = 5;

const LOG_CAP = 500;
// Keep per-app log buffers around after leaving the view, so flipping between
// apps (or views) and back doesn't drop scrollback or re-replay history.
const LOG_CACHE_TTL_MS = 5 * 60_000;
// Output kept for a `:` command — deploys/rebuilds stream a lot of lines.
const CMD_CAP = 1000;

interface LogLine {
  text: string;
  err: boolean;
}

// Single-key actions that prefill (never auto-run) the `:` prompt for the
// selected app. Uppercase so they can't collide with navigation keys.
const QUICK_ACTIONS: Record<string, string> = {
  R: 'ps:restart $app',
  S: 'ps:stop $app',
  B: 'ps:rebuild $app',
};

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
  disk,
  refreshing,
  age,
}: {
  source: Source;
  host: string;
  count: number;
  cert: { app: string; days: number } | null;
  disk: HostDisk | null;
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
        {disk ? (
          <Text color={disk.usedPct >= 90 ? theme.bad : disk.usedPct >= 80 ? theme.warn : theme.dim}>
            disk {disk.usedPct}%{'  '}
          </Text>
        ) : null}
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

// One-line view switcher under the header. Full labels when they fit, compact
// ones otherwise — either way the digits stay visible as the hotkeys.
function TabBar({ view, columns }: { view: number; columns: number }): ReactNode {
  const fullWidth = VIEWS.reduce((s, v, i) => s + String(i + 1).length + v.label.length + 5, 2);
  const useShort = fullWidth > columns;
  return (
    <Box paddingX={1}>
      {VIEWS.map((v, i) => {
        const sel = i === view;
        const label = ` ${i + 1} ${useShort ? v.short : v.label} `;
        return (
          <Text key={v.key}>
            {sel ? (
              <Text backgroundColor={theme.accent} color="black" bold>
                {label}
              </Text>
            ) : (
              <Text>
                <Text color={theme.accent}> {i + 1} </Text>
                <Text color={theme.dim}>{useShort ? v.short : v.label} </Text>
              </Text>
            )}
            <Text> </Text>
          </Text>
        );
      })}
    </Box>
  );
}

function AppSelector({
  apps,
  selected,
  height,
  filter,
  width,
}: {
  apps: DokkuApp[];
  selected: number;
  height: number;
  filter: string;
  width: number;
}): ReactNode {
  const { start, items } = windowed(apps, selected, height);
  const nameW = Math.max(8, width - 8); // borders + padding + status dot
  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle="round" borderColor={theme.dim} paddingX={1}>
      <Text wrap="truncate-end" color={theme.dim}>APPS{filter ? <Text color={theme.warn}> /{filter}</Text> : null}</Text>
      {items.map((a, i) => {
        const idx = start + i;
        const sel = idx === selected;
        const dot = a.running === true ? theme.good : a.running === false ? theme.bad : theme.dim;
        return (
          <Box key={a.name}>
            <Text color={dot}>{sel ? '●' : '·'} </Text>
            <Text wrap="truncate-end" backgroundColor={sel ? theme.accent : undefined} color={sel ? 'black' : theme.text}>
              {padEnd(a.name, nameW)}
            </Text>
          </Box>
        );
      })}
      {apps.length === 0 ? <Text color={theme.dim}> no match</Text> : null}
    </Box>
  );
}

function Footer({ view, columns }: { view: number; columns: number }): ReactNode {
  const v = VIEWS[view];
  // [key, label, priority] — on narrow terminals the lowest-priority hints are
  // dropped whole rather than letting the layout squeeze every label. `?` is
  // kept at all costs: it's how the remaining keys stay discoverable.
  const keys: Array<[string, string, number]> = [
    [`1-${VIEWS.length}`, 'view', 4],
    ['tab', 'next view', 3],
    ['↑↓', v.key === 'logs' ? 'scroll logs' : 'move', 9],
  ];
  if (v.perApp) keys.push(['←→', 'app', 6]);
  if (v.key === 'cheatsheet') keys.push(['↵', 'insert cmd', 8]);
  if (v.key === 'apps' || v.perApp || v.key === 'cheatsheet') keys.push(['/', 'filter', 5]);
  if (v.key === 'config' || v.key === 'services') keys.push(['s', 'reveal/hide', 5]);
  keys.push([':', 'command', 7]);
  keys.push(['r', 'refresh', 2]);
  keys.push(['?', 'help', 10]);
  keys.push(['q', 'quit', 8]);

  const width = (k: string, label: string) => k.length + label.length + 3; // "k label  "
  let total = keys.reduce((s, [k, label]) => s + width(k, label), 0) + 2;
  const dropped = new Set<number>();
  if (total > columns) {
    const order = keys
      .map((entry, i) => ({ pri: entry[2], i }))
      .sort((a, b) => a.pri - b.pri);
    for (const { i } of order) {
      if (total <= columns) break;
      dropped.add(i);
      total -= width(keys[i][0], keys[i][1]);
    }
  }
  const shown = keys.filter((_, i) => !dropped.has(i));
  return (
    <Box paddingX={1}>
      {shown.map(([k, label], i) => (
        <Text key={k}>
          <Text color={theme.accent} bold>
            {k}
          </Text>
          <Text color={theme.dim}>
            {' '}
            {label}
            {i < shown.length - 1 ? '  ' : ''}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

// The `:` prompt that replaces the footer while a command is being typed.
function CommandBar({ text, app }: { text: string; app?: string }): ReactNode {
  return (
    <Box paddingX={1}>
      <Text color={theme.accent} bold>
        : dokku{' '}
      </Text>
      <Text>{text}</Text>
      <Text color={theme.accent}>▌</Text>
      <Text wrap="truncate-end" color={theme.dim}>
        {'   '}enter run · esc cancel · ↑↓ history{app ? ` · $app → ${app}` : ''}
      </Text>
    </Box>
  );
}

// The `/` prompt that replaces the footer while a filter is being typed.
function FilterBar({ text, target }: { text: string; target: string }): ReactNode {
  return (
    <Box paddingX={1}>
      <Text color={theme.warn} bold>
        / {' '}
      </Text>
      <Text>{text}</Text>
      <Text color={theme.warn}>▌</Text>
      <Text wrap="truncate-end" color={theme.dim}>
        {'   '}filter {target} · enter keep · esc clear
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

// Rows the summary pane under the apps table occupies (separator included).
const SUMMARY_ROWS = 9;

// Compact always-visible drill-in for the selected app, rendered under the
// apps table — replaces the old Enter-to-open detail overlay.
function AppSummary({
  app,
  detail,
  loading,
  services,
  width,
}: {
  app: DokkuApp;
  detail?: AppDetail;
  loading: boolean;
  services: DokkuService[] | null;
  width: number;
}): ReactNode {
  const linked = (services ?? []).filter((s) => s.links.includes(app.name));
  const lbl = (t: string) => <Text color={theme.dim}>{padEnd(t, 9)}</Text>;
  return (
    <Box flexDirection="column">
      <Text> </Text>
      <Text color={theme.dim}>{'─'.repeat(Math.max(10, width))}</Text>
      <Text wrap="truncate-end">
        <Text bold color={theme.accent}>
          {app.name}
        </Text>
        <Text color={theme.dim}>
          {'  '}created {fmtDate(app.createdAt)} · deploy {app.deploySource || '—'} · restart {app.restartPolicy || '—'}
        </Text>
      </Text>
      {detail ? (
        <>
          <Text wrap="truncate-end">
            {lbl('GIT')}
            {detail.git.sourceImage ? (
              `image ${detail.git.sourceImage}`
            ) : detail.git.sha || detail.git.branch ? (
              `branch ${detail.git.branch ?? '—'} · sha ${detail.git.sha ? detail.git.sha.slice(0, 10) : '—'} · deployed ${fmtDate(detail.git.lastUpdated)}`
            ) : (
              <Text color={theme.dim}>(no git metadata)</Text>
            )}
          </Text>
          <Text wrap="truncate-end">
            {lbl('PORTS')}
            {detail.ports.length > 0 ? detail.ports.join(' · ') : <Text color={theme.dim}>(none mapped)</Text>}
          </Text>
          <Text wrap="truncate-end">
            {lbl('STORAGE')}
            {detail.storage.length > 0 ? detail.storage.join(' · ') : <Text color={theme.dim}>(no persistent mounts)</Text>}
          </Text>
          <Text wrap="truncate-end">
            {lbl('NETWORK')}
            {detail.network.initial ?? '—'}
            {detail.network.attachPostCreate ? ` · post-create ${detail.network.attachPostCreate}` : ''}
            {detail.network.attachPostDeploy ? ` · post-deploy ${detail.network.attachPostDeploy}` : ''}
          </Text>
        </>
      ) : (
        <Text color={theme.dim}>{loading ? 'Loading detail reports…' : ' '}</Text>
      )}
      <Text wrap="truncate-end">
        {lbl('LINKED')}
        {services === null ? (
          <Text color={theme.dim}>…</Text>
        ) : linked.length === 0 ? (
          <Text color={theme.dim}>(none)</Text>
        ) : (
          linked.map((s, i) => (
            <Text key={`${s.plugin}/${s.name}`}>
              {i > 0 ? ' · ' : ''}
              {s.plugin}/{s.name}{' '}
              <Text color={s.status && /run/i.test(s.status) ? theme.good : theme.warn}>{s.status ?? '?'}</Text>
            </Text>
          ))
        )}
      </Text>
    </Box>
  );
}

function AppsView({
  apps,
  stats,
  selected,
  viewport,
  width,
  detail,
  detailLoading,
  services,
}: {
  apps: DokkuApp[];
  stats: StatsMap | null;
  selected: number;
  viewport: number;
  width: number;
  detail?: AppDetail;
  detailLoading: boolean;
  services: DokkuService[] | null;
}): ReactNode {
  if (apps.length === 0) return <Text color={theme.dim}>No apps found.</Text>;
  // Fixed-width columns first, then the flexible DOMAIN column last so it can
  // truncate without disturbing alignment. Every cell is truncate-end so a
  // narrow terminal degrades gracefully instead of wrapping the grid.
  const nameW = Math.min(28, Math.max(10, ...apps.map((a) => a.name.length)) + 2);
  const statusW = 15;
  const procW = 16;
  const cpuW = 7;
  const memW = 7;
  const ageW = 6;
  const sslW = 11;
  // The summary pane only appears when the terminal is tall enough to keep a
  // useful table above it.
  const showSummary = viewport >= SUMMARY_ROWS + 5;
  const tableRows = showSummary ? Math.max(4, viewport - SUMMARY_ROWS) : viewport;
  const { start, items } = windowed(apps, selected, tableRows - 1);
  const sel = apps[selected];
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end" color={theme.dim}>
        {'  ' +
          padEnd('NAME', nameW) +
          padEnd('STATUS', statusW) +
          padEnd('PROCESSES', procW) +
          padEnd('CPU', cpuW) +
          padEnd('MEM', memW) +
          padEnd('AGE', ageW) +
          padEnd('SSL', sslW) +
          'DOMAIN'}
      </Text>
      {items.map((a, i) => {
        const isSel = start + i === selected;
        const rb = runningBadge(a);
        const proc = a.processes.map((p) => `${p.type}×${p.scale}`).join(' ') || '—';
        const domain =
          a.domains.length === 0 ? '—' : a.domains[0] + (a.domains.length > 1 ? ` +${a.domains.length - 1}` : '');
        const sb = sslBadge(a.ssl);
        const usage = appUsage(a, stats);
        return (
          <Box key={a.name}>
            <Text color={theme.accent}>{isSel ? '› ' : '  '}</Text>
            <Text wrap="truncate-end" bold backgroundColor={isSel ? theme.accent : undefined} color={isSel ? 'black' : theme.text}>
              {padEnd(a.name, nameW)}
            </Text>
            <Text wrap="truncate-end" color={rb.color}>{padEnd(rb.text, statusW)}</Text>
            <Text wrap="truncate-end">{padEnd(proc, procW)}</Text>
            <Text wrap="truncate-end" color={usage.cpu !== null && usage.cpu >= 80 ? theme.warn : theme.dim}>
              {padEnd(fmtPct(usage.cpu), cpuW)}
            </Text>
            <Text wrap="truncate-end" color={theme.dim}>{padEnd(fmtBytes(usage.mem), memW)}</Text>
            <Text wrap="truncate-end" color={theme.dim}>{padEnd(fmtAgeDays(a.createdAt), ageW)}</Text>
            <Text wrap="truncate-end" color={sb.color}>{padEnd(sb.text, sslW)}</Text>
            <Text wrap="truncate-end" color={theme.dim}>{domain}</Text>
          </Box>
        );
      })}
      {windowHint(apps.length, start, items.length)}
      {showSummary && sel ? (
        <AppSummary app={sel} detail={detail} loading={detailLoading} services={services} width={width} />
      ) : null}
    </Box>
  );
}

// Shared first line of every per-app view: name, run state, live usage.
function AppHeader({ app, stats, extra }: { app: DokkuApp; stats: StatsMap | null; extra?: string }): ReactNode {
  const rb = runningBadge(app);
  const usage = appUsage(app, stats);
  return (
    <>
      <Text wrap="truncate-end">
        <Text bold color={theme.accent}>
          {app.name}
        </Text>
        {'  '}
        <Text color={rb.color}>{rb.text}</Text>
        <Text color={theme.dim}>
          {usage.cpu !== null || usage.mem !== null ? `   cpu ${fmtPct(usage.cpu)} · mem ${fmtBytes(usage.mem)}` : ''}
          {extra ?? ''}
        </Text>
      </Text>
      <Text> </Text>
    </>
  );
}

// Whether the app's certificate covers a domain (wildcard-aware); null when
// there is no cert to check against.
function certCovers(domain: string, ssl: DokkuApp['ssl']): boolean | null {
  if (!ssl?.enabled || ssl.hostnames.length === 0) return null;
  return ssl.hostnames.some((h) =>
    h.startsWith('*.')
      ? domain.endsWith(h.slice(1)) && domain.split('.').length === h.split('.').length
      : h === domain,
  );
}

function DomainsView({
  app,
  detail,
  stats,
  width,
}: {
  app?: DokkuApp;
  detail?: AppDetail;
  stats: StatsMap | null;
  width: number;
}): ReactNode {
  if (!app) return <Text color={theme.dim}>No app selected.</Text>;
  const sb = sslBadge(app.ssl);
  const days = app.ssl ? daysUntil(app.ssl.expiresAt) : null;
  const leftW = Math.min(64, Math.max(28, Math.floor(width * 0.55)));
  return (
    <Box flexDirection="column">
      <AppHeader app={app} stats={stats} />
      <Box>
        <Box flexDirection="column" width={leftW} flexShrink={0} marginRight={2}>
          <Text wrap="truncate-end" color={theme.dim}>
            DOMAINS{'  '}
            {app.domainsEnabled === false ? (
              <Text color={theme.warn}>routing disabled</Text>
            ) : (
              <Text color={theme.good}>routing enabled</Text>
            )}
          </Text>
          {app.domains.length === 0 ? (
            <Text color={theme.dim}> (none set)</Text>
          ) : (
            app.domains.map((d) => {
              const cov = certCovers(d, app.ssl);
              return (
                <Text key={d} wrap="truncate-end">
                  {' '}• {d}
                  {cov === null ? null : cov ? (
                    <Text color={theme.good}>  ✔ cert</Text>
                  ) : (
                    <Text color={theme.warn}>  ✗ no cert</Text>
                  )}
                </Text>
              );
            })
          )}
          <Text> </Text>
          <Text color={theme.dim}>PORTS</Text>
          {!detail ? (
            <Text color={theme.dim}> …</Text>
          ) : detail.ports.length === 0 ? (
            <Text color={theme.dim}> (none mapped)</Text>
          ) : (
            detail.ports.map((p) => (
              <Text key={p} wrap="truncate-end">
                {' '}• {p}
              </Text>
            ))
          )}
        </Box>
        <Box flexDirection="column" flexGrow={1}>
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
              {app.ssl.verified !== null ? (
                <Text wrap="truncate-end">
                  {' '}
                  Verified: <Text color={app.ssl.verified ? theme.good : theme.warn}>{app.ssl.verified ? 'yes' : 'no'}</Text>
                </Text>
              ) : null}
            </>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}

function statusColor(s: string): string {
  if (/^running/i.test(s)) return theme.good;
  if (/^exited \(0\)/i.test(s)) return theme.dim;
  if (/^exited/i.test(s)) return theme.bad;
  return theme.warn;
}

function ProcessView({
  app,
  stats,
  detail,
}: {
  app?: DokkuApp;
  stats: StatsMap | null;
  detail?: AppDetail;
}): ReactNode {
  if (!app) return <Text color={theme.dim}>No app selected.</Text>;
  return (
    <Box flexDirection="column">
      <AppHeader app={app} stats={stats} extra={`   restart ${app.restartPolicy || '—'}`} />
      <Text color={theme.dim}>PROCESSES</Text>
      {app.processes.length === 0 ? <Text color={theme.dim}> No process info (not deployed?)</Text> : null}
      {app.processes.map((p) => (
        <Box key={p.type} flexDirection="column">
          <Text bold>
            {' '}
            {p.type} <Text color={theme.dim}>scale {p.scale}</Text>
          </Text>
          {p.instances.map((inst) => {
            const s = stats?.[`${app.name}.${p.type}.${inst.index}`];
            return (
              <Text key={inst.index} wrap="truncate-end">
                {'   '}
                {p.type}.{inst.index}{'  '}
                <Text color={statusColor(inst.status)}>{inst.status}</Text>
                {s ? (
                  <Text color={theme.dim}>
                    {'  '}cpu {fmtPct(s.cpuPct)} · mem {fmtBytes(s.memBytes)}
                    {s.memLimitBytes ? ` / ${fmtBytes(s.memLimitBytes)}` : ''}
                  </Text>
                ) : null}
              </Text>
            );
          })}
        </Box>
      ))}
      <Text> </Text>
      <Text color={theme.dim}>DEPLOY</Text>
      <Text wrap="truncate-end">
        {' '}via {app.deploySource || '—'}
        {detail?.git.sourceImage ? ` · image ${detail.git.sourceImage}` : ''}
        {detail && !detail.git.sourceImage && (detail.git.branch || detail.git.sha)
          ? ` · branch ${detail.git.branch ?? '—'} · sha ${detail.git.sha ? detail.git.sha.slice(0, 10) : '—'} · deployed ${fmtDate(detail.git.lastUpdated)}`
          : ''}
        <Text color={theme.dim}> · created {fmtDate(app.createdAt)}</Text>
      </Text>
      <Text> </Text>
      <Text color={theme.dim}>NETWORK</Text>
      <Text wrap="truncate-end">
        {' '}initial {detail?.network.initial ?? '—'}
        {detail?.network.attachPostCreate ? ` · post-create ${detail.network.attachPostCreate}` : ''}
        {detail?.network.attachPostDeploy ? ` · post-deploy ${detail.network.attachPostDeploy}` : ''}
        {detail && detail.ports.length > 0 ? <Text color={theme.dim}> · ports {detail.ports.join(', ')}</Text> : null}
      </Text>
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

function ServicesView({
  services,
  loading,
  cursor,
  reveal,
  viewport,
}: {
  services: DokkuService[] | null;
  loading: boolean;
  cursor: number;
  reveal: boolean;
  viewport: number;
}): ReactNode {
  if (loading && !services) return <Text color={theme.dim}>Probing datastore plugins…</Text>;
  const list = services ?? [];
  if (list.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.dim}>No datastore services found.</Text>
        <Text> </Text>
        <Text wrap="truncate-end" color={theme.dim}>
          Install a plugin (postgres, redis, mysql, …) and create services to see them here:
        </Text>
        <Text wrap="truncate-end" color={theme.good}>  sudo dokku plugin:install https://github.com/dokku/dokku-postgres.git</Text>
        <Text wrap="truncate-end" color={theme.good}>  dokku postgres:create my-db && dokku postgres:link my-db my-app</Text>
      </Box>
    );
  }
  const pluginW = 12;
  const nameW = Math.min(24, Math.max(6, ...list.map((s) => s.name.length)) + 2);
  const statusW = 10;
  const versionW = 20;
  const listRows = Math.max(3, viewport - 7);
  const { start, items } = windowed(list, cursor, listRows);
  const sel = list[cursor];
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end" color={theme.dim}>
        {'  ' + padEnd('PLUGIN', pluginW) + padEnd('NAME', nameW) + padEnd('STATUS', statusW) + padEnd('VERSION', versionW) + 'LINKED APPS'}
      </Text>
      {items.map((s, i) => {
        const isSel = start + i === cursor;
        const stColor = s.status && /run/i.test(s.status) ? theme.good : s.status ? theme.bad : theme.dim;
        return (
          <Box key={`${s.plugin}/${s.name}`}>
            <Text color={theme.accent}>{isSel ? '› ' : '  '}</Text>
            <Text wrap="truncate-end" color={theme.dim}>{padEnd(s.plugin, pluginW)}</Text>
            <Text wrap="truncate-end" bold backgroundColor={isSel ? theme.accent : undefined} color={isSel ? 'black' : theme.text}>
              {padEnd(s.name, nameW)}
            </Text>
            <Text wrap="truncate-end" color={stColor}>{padEnd(s.status ?? '?', statusW)}</Text>
            <Text wrap="truncate-end" color={theme.dim}>{padEnd(s.version ?? '—', versionW)}</Text>
            <Text wrap="truncate-end">{s.links.join(' ') || '—'}</Text>
          </Box>
        );
      })}
      {windowHint(list.length, start, items.length)}
      {sel ? (
        <>
          <Text> </Text>
          <Text wrap="truncate-end" bold color={theme.accent}>
            {sel.plugin}/{sel.name}
          </Text>
          {sel.exposedPorts ? <Text wrap="truncate-end"> Exposed: {sel.exposedPorts}</Text> : null}
          <Text wrap="truncate-end">
            {' '}DSN: {sel.dsn ? (
              <Text color={reveal ? theme.text : theme.dim}>{reveal ? sel.dsn : '•'.repeat(12) + '  (s to reveal)'}</Text>
            ) : (
              <Text color={theme.dim}>—</Text>
            )}
          </Text>
        </>
      ) : null}
    </Box>
  );
}

function HelpView(): ReactNode {
  const rows: Array<[string, string] | null> = [
    ['1-7', 'jump to a view'],
    ['tab / shift-tab', 'next / previous view'],
    ['↑↓ / jk', 'move selection · scroll logs/config'],
    ['←→ / hl', 'switch app in per-app views'],
    ['enter', 'insert cheat-sheet command into the `:` prompt'],
    ['esc', 'close help · cancel prompt · kill running command'],
    ['/', 'filter the app list (or cheat sheet) · esc clears'],
    ['s', 'reveal/hide secrets (Config values, service DSN)'],
    null,
    ['R / S / B', 'prefill restart / stop / rebuild for the selected app'],
    [':', 'type any dokku command ($app → selected app, ↑↓ history)'],
    ['r', 'refresh now (full report sweep)'],
    ['q / ctrl-c', 'quit'],
    null,
    ['DOKKU_DASH_SSH', 'run remotely: dokku@host (dokku commands only) or user@host'],
    ['DOKKU_DASH_REFRESH', 'poll seconds (default 30, 0 = off)'],
    ['DOKKU_DASH_BIN', 'dokku binary path'],
    ['dokku events:on', 'enable push-based refresh on the host'],
  ];
  return (
    <Box flexDirection="column">
      {rows.map((r, i) =>
        r === null ? (
          <Text key={i}> </Text>
        ) : (
          <Box key={i}>
            <Text color={theme.accent} bold>
              {padEnd(r[0], 20)}
            </Text>
            <Text wrap="truncate-end" color={theme.text}>{r[1]}</Text>
          </Box>
        ),
      )}
    </Box>
  );
}

function CommandView({
  cmd,
  running,
  lines,
  viewport,
  offset,
  width,
}: {
  cmd: string;
  running: boolean;
  lines: LogLine[];
  viewport: number;
  offset: number;
  width: number;
}): ReactNode {
  const rows = Math.max(1, viewport - 1);
  const end = Math.max(0, lines.length - offset);
  const visible = lines.slice(Math.max(0, end - rows), end);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={theme.accent}>
          $ dokku {cmd}
        </Text>
        <Text color={running ? theme.warn : theme.dim}>
          {'  '}{running ? '· running… (esc kills)' : '· finished (esc closes)'}
        </Text>
        {offset > 0 ? <Text color={theme.warn}>  · scrollback ↑{offset}</Text> : null}
      </Text>
      {visible.length === 0 ? (
        <Text color={theme.dim}>{running ? 'Waiting for output…' : '(no output)'}</Text>
      ) : (
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

function cheatLines(filter: string): CheatLine[] {
  const out: CheatLine[] = [];
  const f = filter.toLowerCase();
  for (const g of CHEATSHEET) {
    const items = f
      ? g.items.filter(([cmd, desc]) => cmd.toLowerCase().includes(f) || desc.toLowerCase().includes(f))
      : g.items;
    if (items.length === 0) continue;
    if (out.length > 0) out.push({ type: 'spacer' });
    out.push({ type: 'group', text: g.group });
    items.forEach(([cmd, desc]) => out.push({ type: 'item', cmd, desc }));
  }
  return out;
}

// "dokku ps:restart <app>" -> "ps:restart $app" for the `:` prompt; null when
// the entry isn't a dokku command (e.g. the `git remote add` line).
export function cheatToCommand(cmd: string): string | null {
  let c = cmd.trim();
  if (c.startsWith('sudo ')) c = c.slice(5);
  if (!c.startsWith('dokku ')) return null;
  return c.slice(6).replace(/<app>/g, '$app');
}

function CheatsheetView({
  width,
  viewport,
  cursor,
  filter,
}: {
  width: number;
  viewport: number;
  cursor: number;
  filter: string;
}): ReactNode {
  const lines = cheatLines(filter);
  if (lines.length === 0) return <Text color={theme.dim}>No commands match “{filter}”.</Text>;
  const cmdW = Math.min(44, Math.max(22, Math.floor(width * 0.5)));
  const { start, items } = windowed(lines, Math.min(cursor, lines.length - 1), viewport);
  return (
    <Box flexDirection="column">
      {items.map((l, i) => {
        const idx = start + i;
        if (l.type === 'spacer') return <Text key={idx}> </Text>;
        if (l.type === 'group')
          return (
            <Text key={idx} bold color={theme.accent}>
              ▌ {l.text}
            </Text>
          );
        const sel = idx === cursor;
        return (
          <Box key={idx}>
            <Text color={theme.accent}>{sel ? '›' : ' '}</Text>
            <Text wrap="truncate-end" backgroundColor={sel ? theme.accent : undefined} color={sel ? 'black' : theme.good}>
              {padEnd(truncate(l.cmd, cmdW), cmdW)}
            </Text>
            <Text wrap="truncate-end" color={theme.dim}> {l.desc}</Text>
          </Box>
        );
      })}
      {windowHint(lines.length, start, items.length)}
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

function windowHint(total: number, start: number, shown: number): ReactNode {
  if (total <= shown) return null;
  const below = total - (start + shown);
  const parts: string[] = [];
  if (start > 0) parts.push(`↑ ${start} above`);
  if (below > 0) parts.push(`↓ ${below} below`);
  return <Text color={theme.dim}>{'  '}{parts.join('   ')}</Text>;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App(): ReactNode {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const [view, setView] = useState(0);
  const [selectedApp, setSelectedApp] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [svcReveal, setSvcReveal] = useState(false);
  const [svcCursor, setSvcCursor] = useState(0);
  const [cheatCursor, setCheatCursor] = useState(1); // first item under first group
  const [helpOpen, setHelpOpen] = useState(false);

  const [data, setData] = useState<Overview | null>(null);
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped on every successful *full* refresh; config/services/detail entries
  // carry the version they were fetched under, so stale ones refetch silently
  // on the next look.
  const [dataV, setDataV] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [configCache, setConfigCache] = useState<Record<string, { vars: Record<string, string>; v: number }>>({});
  const [configLoading, setConfigLoading] = useState(false);
  const [services, setServices] = useState<{ list: DokkuService[]; v: number } | null>(null);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [detailCache, setDetailCache] = useState<Record<string, { detail: AppDetail; v: number }>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [logLines, setLogLines] = useState<LogLine[]>([]);

  // `/` filters — one for the app list (shared by every app-listing view) and
  // one for the cheat sheet. filterInput is the live typing buffer.
  const [appFilter, setAppFilter] = useState('');
  const [cheatFilter, setCheatFilter] = useState('');
  const [filterInput, setFilterInput] = useState<string | null>(null);

  // `:` command line — the prompt text (null = closed), the running/finished
  // command overlay, its streamed output, and a session-local history.
  const [cmdInput, setCmdInput] = useState<string | null>(null);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const cmdHistory = useRef<string[]>([]);
  const [cmdRun, setCmdRun] = useState<{ cmd: string; running: boolean } | null>(null);
  const [cmdOutput, setCmdOutput] = useState<LogLine[]>([]);
  const [cmdScroll, setCmdScroll] = useState(0);
  const cmdStopRef = useRef<(() => void) | null>(null);

  const currentView = VIEWS[view];
  const source: Source = data ? data.source : 'demo';

  const filterTarget: 'apps' | 'cheat' = currentView.key === 'cheatsheet' ? 'cheat' : 'apps';
  const appFilterLive = filterInput !== null && filterTarget === 'apps' ? filterInput : appFilter;
  const cheatFilterLive = filterInput !== null && filterTarget === 'cheat' ? filterInput : cheatFilter;

  const allApps = data ? data.apps : [];
  const apps = appFilterLive
    ? allApps.filter((a) => a.name.toLowerCase().includes(appFilterLive.toLowerCase()))
    : allApps;
  const currentApp: DokkuApp | undefined = apps[selectedApp];
  const statsMap: StatsMap | null = stats?.stats ?? null;

  // One refresh path for launch, `r`, the poll timer and pushed events — it
  // never flashes the spinner and never drops caches; versioning (dataV)
  // invalidates config entries instead. Light mode re-fetches only process
  // status + docker stats and keeps the rest of the previous snapshot.
  const dataRef = useRef<Overview | null>(null);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const refreshInFlight = useRef(false);
  const refresh = useCallback(async (mode: 'full' | 'light' = 'full') => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    const prev = dataRef.current;
    const light = mode === 'light' && prev !== null;
    const [result, statsResult] = await Promise.all([
      light ? loadOverviewLight(prev!) : loadOverview(),
      loadStats(),
    ]);
    setData(result);
    setStats(statsResult);
    if (!light) setDataV((v) => v + 1);
    setLastUpdated(Date.now());
    setLoading(false);
    setRefreshing(false);
    refreshInFlight.current = false;
  }, []);

  useEffect(() => {
    void refresh('full');
  }, [refresh]);

  const pollSeconds = currentView.key === 'process' ? FAST_REFRESH_SECONDS : REFRESH_SECONDS;
  const pollCount = useRef(0);
  useEffect(() => {
    if (!pollSeconds) return;
    const t = setInterval(() => {
      pollCount.current++;
      void refresh(pollCount.current % FULL_REFRESH_EVERY === 0 ? 'full' : 'light');
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
        void refresh('full');
      }, 2000);
    });
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [source, refresh]);

  // Run a typed `:` command. Spawned directly (no shell); `$app` expands to
  // the selected app. Output streams into the overlay with the same buffered
  // flush as logs, and a refresh follows so the views reflect any changes.
  const startCommand = (raw: string) => {
    const text = raw.trim().replace(/^dokku\s+/, '');
    setCmdInput(null);
    setHistIdx(null);
    if (!text) return;
    if (cmdHistory.current[cmdHistory.current.length - 1] !== text) cmdHistory.current.push(text);
    const args = text.split(/\s+/).map((t) => (t === '$app' ? currentApp?.name ?? t : t));
    const shown = args.join(' ');
    cmdStopRef.current?.();
    setCmdOutput([]);
    setCmdScroll(0);
    if (source === 'demo') {
      setCmdRun({ cmd: shown, running: false });
      setCmdOutput([{ text: 'demo mode — no dokku binary to run against', err: true }]);
      return;
    }
    setCmdRun({ cmd: shown, running: true });
    const buf: LogLine[] = [];
    const push = (t: string, err: boolean) => buf.push({ text: t, err });
    const flushNow = () => {
      if (buf.length === 0) return;
      const chunk = buf.splice(0, buf.length);
      setCmdOutput((prev) => {
        const next = prev.concat(chunk);
        return next.length > CMD_CAP ? next.slice(next.length - CMD_CAP) : next;
      });
    };
    const flush = setInterval(flushNow, 150);
    const stop = runCommand(args, push, (msg, ok) => {
      push(msg, !ok);
      clearInterval(flush);
      flushNow();
      setCmdRun((r) => (r ? { ...r, running: false } : r));
      void refresh('full'); // the command may have changed state — show it
    });
    cmdStopRef.current = () => {
      clearInterval(flush);
      stop();
    };
  };

  // Kill a still-running command if the whole app unmounts.
  useEffect(() => () => cmdStopRef.current?.(), []);

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

  useEffect(() => {
    const total = services?.list.length ?? 0;
    if (svcCursor > total - 1) setSvcCursor(Math.max(0, total - 1));
  }, [services, svcCursor]);

  // Keep the cheat-sheet cursor parked on an item row when the filter changes.
  useEffect(() => {
    if (currentView.key !== 'cheatsheet') return;
    const lines = cheatLines(cheatFilterLive);
    if (lines[cheatCursor]?.type === 'item') return;
    const first = lines.findIndex((l) => l.type === 'item');
    if (first !== -1) setCheatCursor(first);
  }, [currentView.key, cheatFilterLive, cheatCursor]);

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

  // Lazily load datastore services when a view needs them (Services itself,
  // plus the Apps summary pane's LINKED line); refetch when dataV moves.
  useEffect(() => {
    if (currentView.key !== 'services' && currentView.key !== 'apps') return;
    if (services && services.v === dataV) return;
    let cancelled = false;
    if (!services) setServicesLoading(true);
    void loadServices().then((res) => {
      if (cancelled) return;
      setServices({ list: res.services, v: dataV });
      setServicesLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentView.key, services, dataV]);

  // Lazily load the drill-in reports (ports/git/network/storage) for whatever
  // app the Apps summary pane or a per-app view is showing. Uncached fetches
  // are debounced a beat so holding ↓ through the list doesn't fire a report
  // sweep per row.
  const wantDetail = currentView.key === 'apps' || currentView.perApp;
  useEffect(() => {
    if (!wantDetail || !currentApp) return;
    const entry = detailCache[currentApp.name];
    if (entry && entry.v === dataV) return;
    let cancelled = false;
    if (!entry) setDetailLoading(true);
    const t = setTimeout(() => {
      void loadAppDetail(currentApp.name, source).then((d) => {
        if (cancelled) return;
        setDetailCache((c) => ({ ...c, [currentApp.name]: { detail: d, v: dataV } }));
        setDetailLoading(false);
      });
    }, entry ? 0 : 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [wantDetail, currentApp, source, detailCache, dataV]);

  // Layout sizing. Boxes get explicit widths that sum to `columns` so nothing
  // overflows; `colBudget` is the usable text width inside the content pane
  // (minus borders, padding and a safety margin so lines never soft-wrap).
  // The app selector grows to fit the longest app name instead of truncating.
  const longestApp = allApps.reduce((m, a) => Math.max(m, a.name.length), 0);
  const selW = Math.min(34, Math.max(18, longestApp + 8));
  const contentW = Math.max(30, columns - (currentView.perApp ? selW : 0));
  const colBudget = Math.max(20, contentW - 7);
  const viewport = Math.max(3, rows - 8); // header + tab bar + borders + title + footer

  const clampScroll = useCallback((delta: number, total: number) => {
    setScroll((s) => Math.min(Math.max(0, s + delta), Math.max(0, total - viewport)));
  }, [viewport]);

  // Prefill a quick action into the `:` prompt (never auto-runs).
  const quickAction = (ch: string): boolean => {
    const cmd = QUICK_ACTIONS[ch];
    if (!cmd || !currentApp) return false;
    setCmdInput(cmd);
    return true;
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    // The `:` prompt owns the keyboard while open.
    if (cmdInput !== null) {
      if (key.escape) {
        setCmdInput(null);
        setHistIdx(null);
        return;
      }
      if (key.return) {
        startCommand(cmdInput);
        return;
      }
      if (key.backspace || key.delete) {
        setCmdInput((s) => (s ?? '').slice(0, -1));
        return;
      }
      if (key.upArrow || key.downArrow) {
        const h = cmdHistory.current;
        if (h.length === 0) return;
        const next = key.upArrow ? (histIdx ?? h.length) - 1 : (histIdx ?? h.length - 1) + 1;
        if (next < 0) return;
        if (next >= h.length) {
          setHistIdx(null);
          setCmdInput('');
          return;
        }
        setHistIdx(next);
        setCmdInput(h[next]);
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab) setCmdInput((s) => (s ?? '') + input);
      return;
    }

    // The `/` filter prompt: live-applied while typing; enter keeps, esc clears.
    if (filterInput !== null) {
      const commit = (value: string) => {
        if (filterTarget === 'cheat') setCheatFilter(value);
        else setAppFilter(value);
        setFilterInput(null);
      };
      if (key.escape) {
        commit('');
        return;
      }
      if (key.return) {
        commit(filterInput);
        return;
      }
      if (key.backspace || key.delete) {
        setFilterInput((s) => (s ?? '').slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) {
        setFilterInput((s) => (s ?? '') + input);
      }
      return;
    }

    // Help overlay swallows everything except its close keys.
    if (helpOpen) {
      if (key.escape || input === 'q' || input === '?') setHelpOpen(false);
      return;
    }

    // Command output overlay: scroll, close (esc/q), or type another command.
    if (cmdRun) {
      if (key.escape || input === 'q') {
        cmdStopRef.current?.();
        cmdStopRef.current = null;
        setCmdRun(null);
        return;
      }
      if (input === ':') {
        setCmdInput('');
        return;
      }
      const up = key.upArrow || input === 'k';
      const down = key.downArrow || input === 'j';
      if (up || down) {
        const max = Math.max(0, cmdOutput.length - (viewport - 1));
        setCmdScroll((s) => Math.min(Math.max(0, s + (up ? 1 : -1)), max));
      }
      return;
    }

    if (input === 'q') {
      exit();
      return;
    }
    if (input === ':') {
      setCmdInput('');
      return;
    }
    if (input === '?') {
      setHelpOpen(true);
      return;
    }
    if (input === '/' && (currentView.key === 'apps' || currentView.perApp || currentView.key === 'cheatsheet')) {
      setFilterInput(filterTarget === 'cheat' ? cheatFilter : appFilter);
      return;
    }
    if (input >= '1' && input <= String(VIEWS.length)) {
      setView(Number(input) - 1);
      return;
    }
    if (key.tab) {
      setView((v) => (v + (key.shift ? -1 : 1) + VIEWS.length) % VIEWS.length);
      return;
    }
    if (input === 'r') {
      void refresh('full');
      return;
    }
    if (input === 's' && currentView.key === 'config') {
      setReveal((v) => !v);
      return;
    }
    if (input === 's' && currentView.key === 'services') {
      setSvcReveal((v) => !v);
      return;
    }
    if ((currentView.key === 'apps' || currentView.perApp) && quickAction(input)) return;

    if (key.return) {
      if (currentView.key === 'cheatsheet') {
        const lines = cheatLines(cheatFilterLive);
        const line = lines[cheatCursor];
        if (line?.type === 'item') {
          const cmd = cheatToCommand(line.cmd);
          if (cmd) setCmdInput(cmd);
        }
      }
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

    if (currentView.key === 'apps') {
      setSelectedApp((i) => Math.min(Math.max(0, i + delta), apps.length - 1));
      return;
    }
    if (currentView.key === 'services') {
      const total = services?.list.length ?? 0;
      setSvcCursor((i) => Math.min(Math.max(0, i + delta), Math.max(0, total - 1)));
      return;
    }
    if (currentView.key === 'cheatsheet') {
      const lines = cheatLines(cheatFilterLive);
      setCheatCursor((c) => {
        let i = c + delta;
        while (i >= 0 && i < lines.length && lines[i].type !== 'item') i += delta;
        return i >= 0 && i < lines.length ? i : c;
      });
      return;
    }
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
    }
  });

  if (loading && !data) {
    return (
      <Box flexDirection="column" height={rows}>
        <Header source={source} host={hostLabel()} count={0} cert={null} disk={null} refreshing={false} age={null} />
        <Loading />
      </Box>
    );
  }

  const currentDetail = currentApp ? detailCache[currentApp.name]?.detail : undefined;
  let content: ReactNode = null;
  switch (currentView.key) {
    case 'apps':
      content = (
        <AppsView
          apps={apps}
          stats={statsMap}
          selected={selectedApp}
          viewport={viewport}
          width={colBudget}
          detail={currentDetail}
          detailLoading={detailLoading}
          services={services ? services.list : null}
        />
      );
      break;
    case 'domains':
      content = <DomainsView app={currentApp} detail={currentDetail} stats={statsMap} width={colBudget} />;
      break;
    case 'process':
      content = <ProcessView app={currentApp} stats={statsMap} detail={currentDetail} />;
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
    case 'services':
      content = (
        <ServicesView
          services={services?.list ?? null}
          loading={servicesLoading}
          cursor={svcCursor}
          reveal={svcReveal}
          viewport={viewport}
        />
      );
      break;
    case 'cheatsheet':
      content = (
        <CheatsheetView
          width={colBudget}
          viewport={viewport}
          cursor={cheatCursor}
          filter={cheatFilterLive}
        />
      );
      break;
  }
  // Overlays take over the content pane until dismissed.
  let paneTitle = currentView.label.toUpperCase();
  if (helpOpen) {
    paneTitle = 'HELP';
    content = <HelpView />;
  }
  if (cmdRun) {
    paneTitle = 'COMMAND';
    content = (
      <CommandView
        cmd={cmdRun.cmd}
        running={cmdRun.running}
        lines={cmdOutput}
        viewport={viewport}
        offset={cmdScroll}
        width={colBudget}
      />
    );
  }

  const activeFilter = currentView.key === 'cheatsheet' ? cheatFilterLive : appFilterLive;
  return (
    <Box flexDirection="column" height={rows}>
      <Header
        source={source}
        host={hostLabel()}
        count={allApps.length}
        cert={soonestCert(allApps)}
        disk={stats?.disk ?? null}
        refreshing={refreshing && !loading}
        age={lastUpdated !== null ? Math.max(0, Math.round((now - lastUpdated) / 1000)) : null}
      />
      <TabBar view={view} columns={columns} />
      <Box flexGrow={1}>
        {currentView.perApp ? (
          <AppSelector apps={apps} selected={selectedApp} height={viewport} filter={appFilterLive} width={selW} />
        ) : null}
        <Box
          width={contentW}
          flexShrink={0}
          flexDirection="column"
          borderStyle="round"
          borderColor={theme.dim}
          paddingX={2}
        >
          <Text wrap="truncate-end" color={theme.dim}>
            {paneTitle}
            {!cmdRun && !helpOpen && activeFilter ? <Text color={theme.warn}>  /{activeFilter}</Text> : null}
          </Text>
          {content}
        </Box>
      </Box>
      {cmdInput !== null ? (
        <CommandBar text={cmdInput} app={currentApp?.name} />
      ) : filterInput !== null ? (
        <FilterBar text={filterInput} target={filterTarget === 'cheat' ? 'cheat sheet' : 'apps'} />
      ) : (
        <Footer view={view} columns={columns} />
      )}
    </Box>
  );
}

function hostLabel(): string {
  return process.env.DOKKU_DASH_HOST || remoteLabel() || process.env.HOSTNAME || 'local';
}
