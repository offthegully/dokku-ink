// Main TUI for dokku-ink: a read-only dashboard over a Dokku host plus a
// built-in command cheat sheet.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  theme,
  truncate,
  padEnd,
  padNum,
  fmtAge,
  fmtAgeDays,
  fmtBytes,
  fmtDate,
  fmtIssuer,
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
import { checkForUpdate } from './update.js';
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
  key: 'apps' | 'process' | 'config' | 'logs' | 'services';
  label: string;
  /** Compact label for the tab bar on narrow terminals. */
  short: string;
  /**
   * Every view shares one master-detail layout: a table on top (↑↓ selects),
   * a tab strip, and a detail pane for the selection below. Per-app views put
   * the apps table on top; Services swaps in the services table instead. The
   * cheat sheet lives outside the strip as an overlay (`c`).
   */
  perApp: boolean;
}

const VIEWS: ViewDef[] = [
  { key: 'apps', label: 'Overview', short: 'Info', perApp: true },
  { key: 'process', label: 'Processes', short: 'Procs', perApp: true },
  { key: 'config', label: 'Config / Env', short: 'Config', perApp: true },
  { key: 'logs', label: 'Logs', short: 'Logs', perApp: true },
  { key: 'services', label: 'Services', short: 'Services', perApp: false },
];

// Auto-refresh cadence for overview data. Configurable via DOKKU_INK_REFRESH
// (seconds); 0 disables polling.
const REFRESH_SECONDS = (() => {
  const raw = Number(process.env.DOKKU_INK_REFRESH ?? 30);
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

// Commands that need a confirm step before running — matched on the typed
// text itself (not just the R/S/B hotkeys), so hand-typing `ps:stop foo` into
// `:` gets the same guard as pressing S. The QUICK_ACTIONS verbs are pulled
// in automatically so a new hotkey can't silently skip confirmation; the rest
// are other irreversible/data-losing commands reachable from the free-form
// `:` prompt or the cheat sheet (see cheatsheet.ts's "irreversible" entries).
const OTHER_DESTRUCTIVE_VERBS = ['apps:destroy', 'domains:clear', 'config:unset'];
const DESTRUCTIVE_VERBS = [
  ...new Set(Object.values(QUICK_ACTIONS).map((cmd) => cmd.split(' ')[0])),
  ...OTHER_DESTRUCTIVE_VERBS,
];
const DESTRUCTIVE_RE = new RegExp(`^(${DESTRUCTIVE_VERBS.join('|')})\\b`, 'i');

// Strips the optional leading "dokku " a user may type — the one true
// normalization startCommand, isDestructive, and the confirm prompt all use,
// so a typed "dokku ps:stop foo" is treated identically to "ps:stop foo"
// everywhere instead of only some of these agreeing.
function stripDokkuPrefix(cmd: string): string {
  return cmd.trim().replace(/^dokku\s+/, '');
}

function isDestructive(cmd: string): boolean {
  return DESTRUCTIVE_RE.test(stripDokkuPrefix(cmd));
}

// Expands the literal `$app` token to the selected app's name — the same
// substitution startCommand runs, reused so what a confirm prompt displays
// matches what will actually execute.
function resolveAppPlaceholder(cmd: string, appName?: string): string {
  return cmd
    .split(/\s+/)
    .map((t) => (t === '$app' ? appName ?? t : t))
    .join(' ');
}

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
  update,
}: {
  source: Source;
  host: string;
  count: number;
  cert: { app: string; days: number } | null;
  disk: HostDisk | null;
  refreshing: boolean;
  age: number | null; // seconds since the last successful refresh
  update?: string | null; // latest release tag when a newer one is available
}): ReactNode {
  // Fixed-width slot so the readout never nudges the rest of the header.
  const fresh = refreshing ? '↻ …' : age !== null ? `↻ ${fmtAge(age)}` : '';
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text color={theme.accent} bold>
          dokku-ink
        </Text>
        <Text wrap="truncate-end" color={theme.dim}> · {host}</Text>
      </Box>
      <Box>
        {update ? (
          <Text color={theme.good}>↑ {update.replace(/^v/i, '')}{'  '}</Text>
        ) : null}
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

// One-line view switcher that sits on the detail pane — in per-app views it
// doubles as the separator between the apps table and the detail below. Full
// labels when they fit, compact ones otherwise — either way the digits stay
// visible as the hotkeys. An active `/` filter shows at the end of the strip.
function TabBar({ view, columns, filter }: { view: number; columns: number; filter?: string }): ReactNode {
  const fullWidth = VIEWS.reduce((s, v, i) => s + String(i + 1).length + v.label.length + 5, 2);
  const useShort = fullWidth > columns;
  return (
    <Box>
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
      {filter ? <Text color={theme.warn}> /{filter}</Text> : null}
    </Box>
  );
}

function Footer({ view, columns, overlay }: { view: number; columns: number; overlay?: 'cheat' | null }): ReactNode {
  const v = VIEWS[view];
  // [key, label, priority] — on narrow terminals the lowest-priority hints are
  // dropped whole rather than letting the layout squeeze every label. `?` is
  // kept at all costs: it's how the remaining keys stay discoverable.
  const keys: Array<[string, string, number]> = [];
  if (overlay === 'cheat') {
    keys.push(['↑↓', 'move', 9]);
    keys.push(['↵', 'insert cmd', 8]);
    keys.push(['/', 'filter', 5]);
    keys.push([':', 'command', 7]);
    keys.push(['esc/q', 'close', 10]);
  } else {
    keys.push([`1-${VIEWS.length}`, 'view', 4]);
    keys.push(['←→', 'switch view', 3]);
    keys.push(['↑↓', v.perApp ? 'app' : 'move', 9]);
    if (v.key === 'logs' || v.key === 'config') keys.push(['j/k', 'scroll', 6]);
    if (v.perApp) keys.push(['/', 'filter', 5]);
    if (v.key === 'config' || v.key === 'services') keys.push(['s', 'reveal/hide', 5]);
    if (v.perApp) keys.push(['R/S/B', 'actions', 4]);
    keys.push([':', 'command', 7]);
    keys.push(['c', 'cheats', 6]);
    keys.push(['r', 'refresh', 2]);
    keys.push(['?', 'help', 10]);
    keys.push(['q', 'quit', 8]);
  }

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

// Replaces the CommandBar for one extra keypress before a destructive
// command actually runs. Shows the command with `$app` already resolved —
// the whole point of confirming a per-app action is naming the app.
function ConfirmBar({ cmd, app }: { cmd: string; app?: string }): ReactNode {
  return (
    <Box paddingX={1}>
      <Text color={theme.warn} bold wrap="truncate-end">
        ⚠ run "dokku {resolveAppPlaceholder(cmd, app)}"?{' '}
      </Text>
      <Text wrap="truncate-end" color={theme.dim}>enter/y confirm · esc/n cancel</Text>
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

// The Overview tab's detail pane: a compact drill-in for the selected app.
// Config/runtime facts fill the left column; domains and the SSL certificate
// fill the right one (stacked vertically on narrow terminals).
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
  const sb = sslBadge(app.ssl);
  const days = app.ssl ? daysUntil(app.ssl.expiresAt) : null;
  const stacked = width < 90;
  const leftW = Math.min(72, Math.max(36, Math.floor(width * 0.5)));
  const left = (
    <>
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
        // Same rows as the loaded state so the pane doesn't collapse and
        // re-expand (a visible flash) while the detail reports stream in.
        <>
          {(['GIT', 'PORTS', 'STORAGE', 'NETWORK'] as const).map((t) => (
            <Text key={t} wrap="truncate-end">
              {lbl(t)}
              <Text color={theme.dim}>{loading ? '…' : '—'}</Text>
            </Text>
          ))}
        </>
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
    </>
  );
  const right = (
    <>
      <Text wrap="truncate-end">
        {lbl('DOMAINS')}
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
                <Text color={theme.good}>  ✓ cert</Text>
              ) : (
                <Text color={theme.warn}>  ✗ no cert</Text>
              )}
            </Text>
          );
        })
      )}
      <Text> </Text>
      <Text wrap="truncate-end">
        {lbl('SSL')}
        <Text color={sb.color}>{sb.text}</Text>
        {app.ssl ? (
          <>
            {app.ssl.issuer ? ` · ${fmtIssuer(app.ssl.issuer)}` : ''}
            {` · expires ${fmtDate(app.ssl.expiresAt)}`}
            {days !== null ? <Text color={days <= 14 ? theme.warn : theme.dim}> ({days}d)</Text> : null}
            {/* dokku reports verified:no for routine self-managed LE certs —
                worth a note, not a warning color. */}
            {app.ssl.verified === false ? <Text color={theme.dim}> · unverified</Text> : null}
          </>
        ) : null}
      </Text>
    </>
  );
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={theme.accent}>
          {app.name}
        </Text>
        <Text color={theme.dim}>
          {'  '}created {fmtDate(app.createdAt)} · deploy {app.deploySource || '—'} · restart {app.restartPolicy || '—'}
        </Text>
      </Text>
      {stacked ? (
        <>
          {left}
          <Text> </Text>
          {right}
        </>
      ) : (
        <Box>
          <Box flexDirection="column" width={leftW} flexShrink={0} marginRight={2}>
            {left}
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {right}
          </Box>
        </Box>
      )}
    </Box>
  );
}

// The always-visible apps table on top of every per-app view. ↑↓ moves the
// selection; the detail pane below tracks it.
function AppTable({
  apps,
  stats,
  selected,
  height,
}: {
  apps: DokkuApp[];
  stats: StatsMap | null;
  selected: number;
  height: number;
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
  // One row for the header, one for the window hint when the list overflows.
  const listRows = Math.max(1, height - 1 - (apps.length > height - 1 ? 1 : 0));
  const { start, items } = windowed(apps, selected, listRows);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end" color={theme.dim}>
        {'  ' +
          padEnd('NAME', nameW) +
          padEnd('STATUS', statusW) +
          padEnd('PROCESSES', procW) +
          padNum('CPU', cpuW) +
          padNum('MEM', memW) +
          padNum('AGE', ageW) +
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
        // The whole row inverts on selection so the scan line is unmissable;
        // per-cell status colors only apply to unselected rows.
        const cell = (color: string) =>
          isSel ? { backgroundColor: theme.accent, color: 'black' } : { color };
        return (
          <Box key={a.name}>
            <Text color={theme.accent}>{isSel ? '› ' : '  '}</Text>
            <Text wrap="truncate-end" bold {...cell(theme.text)}>
              {padEnd(a.name, nameW)}
            </Text>
            <Text wrap="truncate-end" {...cell(rb.color)}>{padEnd(rb.text, statusW)}</Text>
            <Text wrap="truncate-end" {...cell(theme.text)}>{padEnd(proc, procW)}</Text>
            <Text wrap="truncate-end" {...cell(usage.cpu !== null && usage.cpu >= 80 ? theme.warn : theme.dim)}>
              {padNum(fmtPct(usage.cpu), cpuW)}
            </Text>
            <Text wrap="truncate-end" {...cell(theme.dim)}>{padNum(fmtBytes(usage.mem), memW)}</Text>
            <Text wrap="truncate-end" {...cell(theme.dim)}>{padNum(fmtAgeDays(a.createdAt), ageW)}</Text>
            <Text wrap="truncate-end" {...cell(sb.color)}>{padEnd(sb.text, sslW)}</Text>
            <Text wrap="truncate-end" {...cell(theme.dim)}>{domain}</Text>
          </Box>
        );
      })}
      {windowHint(apps.length, start, items.length)}
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
  if (loading) {
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold color={theme.accent}>{app.name}</Text>
          <Text color={theme.dim}>{'  '}· loading config…</Text>
        </Text>
      </Box>
    );
  }
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

function serviceStatusColor(status: string | null): string {
  return status && /run/i.test(status) ? theme.good : status ? theme.bad : theme.dim;
}

// The Services view's master list — sits in the top box where the apps table
// lives on per-app views, so switching to tab 6 keeps the same skeleton.
function ServicesTable({
  services,
  loading,
  cursor,
  height,
}: {
  services: DokkuService[] | null;
  loading: boolean;
  cursor: number;
  height: number;
}): ReactNode {
  if (loading && !services) return <Text color={theme.dim}>Probing datastore plugins…</Text>;
  const list = services ?? [];
  if (list.length === 0) return <Text color={theme.dim}>No datastore services found.</Text>;
  const pluginW = 12;
  const nameW = Math.min(24, Math.max(6, ...list.map((s) => s.name.length)) + 2);
  const statusW = 10;
  const versionW = Math.min(28, Math.max(9, ...list.map((s) => (s.version ?? '—').length)) + 2);
  const listRows = Math.max(1, height - 1 - (list.length > height - 1 ? 1 : 0));
  const { start, items } = windowed(list, cursor, listRows);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end" color={theme.dim}>
        {'  ' + padEnd('PLUGIN', pluginW) + padEnd('NAME', nameW) + padEnd('STATUS', statusW) + padEnd('VERSION', versionW) + 'LINKED APPS'}
      </Text>
      {items.map((s, i) => {
        const isSel = start + i === cursor;
        const cell = (color: string) =>
          isSel ? { backgroundColor: theme.accent, color: 'black' } : { color };
        return (
          <Box key={`${s.plugin}/${s.name}`}>
            <Text color={theme.accent}>{isSel ? '› ' : '  '}</Text>
            <Text wrap="truncate-end" {...cell(theme.dim)}>{padEnd(s.plugin, pluginW)}</Text>
            <Text wrap="truncate-end" bold {...cell(theme.text)}>
              {padEnd(s.name, nameW)}
            </Text>
            <Text wrap="truncate-end" {...cell(serviceStatusColor(s.status))}>{padEnd(s.status ?? '?', statusW)}</Text>
            <Text wrap="truncate-end" {...cell(theme.dim)}>{padEnd(s.version ?? '—', versionW)}</Text>
            <Text wrap="truncate-end" {...cell(theme.text)}>{s.links.join(' ') || '—'}</Text>
          </Box>
        );
      })}
      {windowHint(list.length, start, items.length)}
    </Box>
  );
}

// The Services view's detail pane: everything about the selected service,
// mirroring the labeled-rows shape of the app Overview pane.
function ServiceDetail({
  service,
  apps,
  reveal,
}: {
  service?: DokkuService;
  apps: DokkuApp[];
  reveal: boolean;
}): ReactNode {
  if (!service) {
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
  const lbl = (t: string) => <Text color={theme.dim}>{padEnd(t, 9)}</Text>;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color={theme.accent}>
          {service.plugin}/{service.name}
        </Text>
        {'  '}
        <Text color={serviceStatusColor(service.status)}>● {service.status ?? 'unknown'}</Text>
      </Text>
      <Text> </Text>
      <Text wrap="truncate-end">
        {lbl('VERSION')}
        {service.version ?? <Text color={theme.dim}>—</Text>}
      </Text>
      <Text wrap="truncate-end">
        {lbl('EXPOSED')}
        {service.exposedPorts ?? <Text color={theme.dim}>(not exposed)</Text>}
      </Text>
      <Text wrap="truncate-end">
        {lbl('DSN')}
        {service.dsn ? (
          <Text color={reveal ? theme.text : theme.dim}>{reveal ? service.dsn : '•'.repeat(12) + '  (s to reveal)'}</Text>
        ) : (
          <Text color={theme.dim}>—</Text>
        )}
      </Text>
      <Text wrap="truncate-end">
        {lbl('LINKED')}
        {service.links.length === 0 ? (
          <Text color={theme.dim}>(no linked apps)</Text>
        ) : (
          service.links.map((name, i) => {
            const app = apps.find((a) => a.name === name);
            const rb = app ? runningBadge(app) : null;
            return (
              <Text key={name}>
                {i > 0 ? ' · ' : ''}
                {name}
                {rb ? <Text color={rb.color}> {rb.text}</Text> : null}
              </Text>
            );
          })
        )}
      </Text>
    </Box>
  );
}

function HelpView(): ReactNode {
  // Key column is padded to the widest key so the two columns stay aligned;
  // padEnd truncates anything longer, so keep this >= the longest key below.
  const keyW = 26;
  const rows: Array<[string, string] | null> = [
    [`1-${VIEWS.length}`, 'jump to a view'],
    ['←→ / hl / tab', 'next / previous view'],
    ['↑↓', 'select app · move in lists'],
    ['j / k', 'scroll the detail pane (logs, config)'],
    ['c', 'open the command cheat sheet (enter inserts into `:`)'],
    ['esc', 'close overlay · cancel prompt · kill running command'],
    ['/', 'filter the app list (or cheat sheet) · esc clears'],
    ['s', 'reveal/hide secrets (Config values, service DSN)'],
    null,
    ['R / S / B', 'prefill restart / stop / rebuild for the selected app (enter confirms)'],
    [':', 'type any dokku command ($app → selected app, ↑↓ history)'],
    ['r', 'refresh now (full report sweep)'],
    ['q / ctrl-c', 'quit'],
    null,
    ['DOKKU_INK_SSH', 'run remotely: dokku@host (dokku commands only) or user@host'],
    ['DOKKU_INK_REFRESH', 'poll seconds (default 30, 0 = off)'],
    ['DOKKU_INK_BIN', 'dokku binary path'],
    ['DOKKU_INK_NO_UPDATE_CHECK', 'disable the ↑ new-release check on launch'],
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
              {padEnd(r[0], keyW)}
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
  // Hug the longest visible command (filtering tightens the column) instead of
  // always claiming half the screen and stranding the descriptions far right.
  const longest = lines.reduce((m, l) => (l.type === 'item' ? Math.max(m, l.cmd.length) : m), 0);
  const cmdW = Math.max(22, Math.min(44, longest + 1, Math.floor(width * 0.6)));
  // One row stays reserved for the window hint — overflowing the box makes
  // Yoga squeeze the column and collapse arbitrary rows instead of clipping.
  const rows = Math.max(3, viewport - (lines.length > viewport - 1 ? 1 : 0));
  const { start, items } = windowed(lines, Math.min(cursor, lines.length - 1), rows);
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
            <Text wrap="truncate-end" backgroundColor={sel ? theme.accent : undefined} color={sel ? 'black' : theme.dim}>
              {' '}{l.desc}
            </Text>
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

export default function App({ version }: { version?: string } = {}): ReactNode {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();

  const [view, setView] = useState(0);
  const [selectedApp, setSelectedApp] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [svcReveal, setSvcReveal] = useState(false);
  const [svcCursor, setSvcCursor] = useState(0);
  const [cheatCursor, setCheatCursor] = useState(1); // first item under first group
  const [cheatOpen, setCheatOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // Latest release tag when a newer one exists (else null) — shown as a chip in
  // the header. Resolved once on mount, off the render path.
  const [update, setUpdate] = useState<string | null>(null);

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
  // Set while a destructive command (see isDestructive) is awaiting a second
  // keypress before it actually runs; holds the exact text to run on confirm.
  const [cmdConfirm, setCmdConfirm] = useState<string | null>(null);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const cmdHistory = useRef<string[]>([]);
  const [cmdRun, setCmdRun] = useState<{ cmd: string; running: boolean } | null>(null);
  const [cmdOutput, setCmdOutput] = useState<LogLine[]>([]);
  const [cmdScroll, setCmdScroll] = useState(0);
  const cmdStopRef = useRef<(() => void) | null>(null);

  const currentView = VIEWS[view];
  const source: Source = data ? data.source : 'demo';

  const filterTarget: 'apps' | 'cheat' = cheatOpen ? 'cheat' : 'apps';
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

  // One-shot, best-effort update check. Fires after the first paint so it never
  // delays startup, and checkForUpdate swallows every error, so a failed or
  // slow network is invisible. The cancelled guard just avoids a post-unmount
  // setState during tests.
  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    void checkForUpdate(version).then((tag) => {
      if (!cancelled) setUpdate(tag);
    });
    return () => {
      cancelled = true;
    };
  }, [version]);

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
    const text = stripDokkuPrefix(raw);
    setCmdInput(null);
    setHistIdx(null);
    if (!text) return;
    if (cmdHistory.current[cmdHistory.current.length - 1] !== text) cmdHistory.current.push(text);
    const shown = resolveAppPlaceholder(text, currentApp?.name);
    const args = shown.split(/\s+/);
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
    if (!cheatOpen) return;
    const lines = cheatLines(cheatFilterLive);
    if (lines[cheatCursor]?.type === 'item') return;
    const first = lines.findIndex((l) => l.type === 'item');
    if (first !== -1) setCheatCursor(first);
  }, [cheatOpen, cheatFilterLive, cheatCursor]);

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
  const wantDetail = currentView.perApp;
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

  // Layout sizing. Every view stacks two bordered boxes between header and
  // footer — the master table on top (apps, or services on tab 6), the tabbed
  // detail pane below — so the two halves read as distinct panes. `colBudget`
  // is the usable text width inside a box (minus borders, padding and a safety
  // margin so lines never soft-wrap). The top box hugs its list (header + one
  // row per entry, capped at half the height) instead of claiming a fixed
  // share — short lists stop stranding blank rows, and the split stays put
  // while flipping tabs because it depends only on the unfiltered list length.
  const colBudget = Math.max(20, columns - 7);
  const inner = Math.max(10, rows - 2); // header + footer
  const stripRows = 2; // tab strip + the blank line under it
  const usable = Math.max(6, inner - 4 - stripRows); // minus both boxes' borders
  const masterCount = currentView.key === 'services' ? Math.max(1, services?.list.length ?? 1) : allApps.length;
  const maxTable = Math.max(3, Math.floor(usable / 2));
  const tableRows = Math.min(Math.max(2, masterCount + 1), maxTable);
  const detailViewport = Math.max(3, usable - tableRows);
  const overlayViewport = Math.max(3, inner - 2 - 1); // help/command/cheats take one box, minus a title row

  const clampScroll = useCallback((delta: number, total: number) => {
    setScroll((s) => Math.min(Math.max(0, s + delta), Math.max(0, total - detailViewport)));
  }, [detailViewport]);

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
      // A destructive command is pending a second keypress — this step
      // swallows all input except confirm/cancel.
      if (cmdConfirm !== null) {
        if (key.escape || input === 'n' || input === 'N') {
          setCmdConfirm(null); // back to the editable prompt, nothing ran
          return;
        }
        if (key.return || input === 'y' || input === 'Y') {
          startCommand(cmdConfirm);
          setCmdConfirm(null);
          return;
        }
        return;
      }
      if (key.escape) {
        setCmdInput(null);
        setHistIdx(null);
        return;
      }
      if (key.return) {
        if (isDestructive(cmdInput)) {
          setCmdConfirm(stripDokkuPrefix(cmdInput));
          return;
        }
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
        const max = Math.max(0, cmdOutput.length - (overlayViewport - 1));
        setCmdScroll((s) => Math.min(Math.max(0, s + (up ? 1 : -1)), max));
      }
      return;
    }

    // Cheat sheet overlay: browse (↑↓/jk), filter (/), insert into `:` (enter).
    if (cheatOpen) {
      if (key.escape || input === 'q' || input === 'c') {
        setCheatOpen(false);
        return;
      }
      if (input === ':') {
        setCmdInput('');
        return;
      }
      if (input === '/') {
        setFilterInput(cheatFilter);
        return;
      }
      if (key.return) {
        const lines = cheatLines(cheatFilterLive);
        const line = lines[cheatCursor];
        if (line?.type === 'item') {
          const cmd = cheatToCommand(line.cmd);
          if (cmd) {
            setCheatOpen(false); // land back on the view with the prompt filled
            setCmdInput(cmd);
          }
        }
        return;
      }
      const up = key.upArrow || input === 'k';
      const down = key.downArrow || input === 'j';
      if (up || down) {
        const delta = up ? -1 : 1;
        const lines = cheatLines(cheatFilterLive);
        setCheatCursor((c) => {
          let i = c + delta;
          while (i >= 0 && i < lines.length && lines[i].type !== 'item') i += delta;
          return i >= 0 && i < lines.length ? i : c;
        });
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
    if (input === 'c') {
      setCheatOpen(true);
      return;
    }
    if (input === '/' && currentView.perApp) {
      setFilterInput(appFilter);
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
    if (currentView.perApp && quickAction(input)) return;

    // ←/→ (h/l) steps through the detail tabs, wrapping like tab does.
    const left = key.leftArrow || input === 'h';
    const right = key.rightArrow || input === 'l';
    if (left || right) {
      setView((v) => (v + (right ? 1 : -1) + VIEWS.length) % VIEWS.length);
      return;
    }

    const up = key.upArrow;
    const down = key.downArrow;
    const scrollUp = input === 'k';
    const scrollDown = input === 'j';

    if (currentView.perApp) {
      // Arrows always move the app selection; j/k scrolls the detail pane
      // content (log scrollback, long config lists) without a mode switch.
      if (up || down) {
        setSelectedApp((i) => Math.min(Math.max(0, i + (down ? 1 : -1)), apps.length - 1));
        setScroll(0);
        return;
      }
      if (scrollUp || scrollDown) {
        if (currentView.key === 'logs') {
          // k digs into scrollback, j moves back toward the live tail.
          const max = Math.max(0, logLines.length - (detailViewport - 1));
          setScroll((s) => Math.min(Math.max(0, s + (scrollUp ? 1 : -1)), max));
        } else if (currentView.key === 'config') {
          const total = currentApp ? Object.keys(configCache[currentApp.name]?.vars || {}).length : 0;
          clampScroll(scrollDown ? 1 : -1, total);
        }
      }
      return;
    }

    // Services view: arrows and j/k both move the service cursor.
    if (!up && !down && !scrollUp && !scrollDown) return;
    const delta = up || scrollUp ? -1 : 1;
    if (currentView.key === 'services') {
      const total = services?.list.length ?? 0;
      setSvcCursor((i) => Math.min(Math.max(0, i + delta), Math.max(0, total - 1)));
    }
  });

  if (loading && !data) {
    return (
      <Box flexDirection="column" height={rows}>
        <Header source={source} host={hostLabel()} count={0} cert={null} disk={null} refreshing={false} age={null} update={update} />
        <Loading />
      </Box>
    );
  }

  const currentDetail = currentApp ? detailCache[currentApp.name]?.detail : undefined;
  let content: ReactNode = null;
  switch (currentView.key) {
    case 'apps':
      content = currentApp ? (
        <AppSummary
          app={currentApp}
          detail={currentDetail}
          loading={detailLoading}
          services={services ? services.list : null}
          width={colBudget}
        />
      ) : (
        <Text color={theme.dim}>No app selected.</Text>
      );
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
          viewport={detailViewport}
          scroll={scroll}
        />
      );
      break;
    case 'logs':
      content = <LogsView app={currentApp} lines={logLines} viewport={detailViewport} offset={scroll} width={colBudget} />;
      break;
    case 'services':
      content = (
        <ServiceDetail
          service={services?.list[svcCursor]}
          apps={allApps}
          reveal={svcReveal}
        />
      );
      break;
  }
  // Overlays take over the whole pane until dismissed.
  let overlayTitle: string | null = null;
  let overlayFilter = '';
  if (helpOpen) {
    overlayTitle = 'HELP';
    content = <HelpView />;
  }
  if (cheatOpen) {
    overlayTitle = 'CHEAT SHEET';
    overlayFilter = cheatFilterLive;
    content = (
      <CheatsheetView
        width={colBudget}
        viewport={overlayViewport}
        cursor={cheatCursor}
        filter={cheatFilterLive}
      />
    );
  }
  if (cmdRun) {
    overlayTitle = 'COMMAND';
    content = (
      <CommandView
        cmd={cmdRun.cmd}
        running={cmdRun.running}
        lines={cmdOutput}
        viewport={overlayViewport}
        offset={cmdScroll}
        width={colBudget}
      />
    );
  }

  // The master table on top: apps for per-app views, services on tab 6.
  const master =
    currentView.key === 'services' ? (
      <ServicesTable
        services={services?.list ?? null}
        loading={servicesLoading}
        cursor={svcCursor}
        height={tableRows}
      />
    ) : (
      <AppTable apps={apps} stats={statsMap} selected={selectedApp} height={tableRows} />
    );

  const activeFilter = currentView.perApp ? appFilterLive : '';
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
        update={update}
      />
      {overlayTitle ? (
        <Box flexGrow={1} flexDirection="column" overflow="hidden" borderStyle="round" borderColor={theme.dim} paddingX={2}>
          <Text wrap="truncate-end" color={theme.dim}>
            {overlayTitle}
            {overlayFilter ? <Text color={theme.warn}>  /{overlayFilter}</Text> : null}
          </Text>
          {content}
        </Box>
      ) : (
        <>
          <Box
            height={tableRows + 2}
            flexShrink={0}
            flexDirection="column"
            overflow="hidden"
            borderStyle="round"
            borderColor={theme.dim}
            paddingX={2}
          >
            {master}
          </Box>
          <Box flexGrow={1} flexDirection="column" borderStyle="round" borderColor={theme.dim} paddingX={2}>
            <TabBar view={view} columns={colBudget} filter={activeFilter} />
            <Box flexGrow={1} flexDirection="column" overflow="hidden" marginTop={1}>
              {content}
            </Box>
          </Box>
        </>
      )}
      {cmdInput !== null ? (
        cmdConfirm !== null ? (
          <ConfirmBar cmd={cmdConfirm} app={currentApp?.name} />
        ) : (
          <CommandBar text={cmdInput} app={currentApp?.name} />
        )
      ) : filterInput !== null ? (
        <FilterBar text={filterInput} target={filterTarget === 'cheat' ? 'cheat sheet' : 'apps'} />
      ) : (
        <Footer view={view} columns={columns} overlay={cheatOpen && !cmdRun && !helpOpen ? 'cheat' : null} />
      )}
    </Box>
  );
}

function hostLabel(): string {
  return process.env.DOKKU_INK_HOST || remoteLabel() || process.env.HOSTNAME || 'local';
}
