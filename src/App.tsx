// Main TUI for dokku-dash: a read-only dashboard over a Dokku host plus a
// built-in command cheat sheet.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  theme,
  truncate,
  padEnd,
  fmtDate,
  daysUntil,
  runningBadge,
  sslBadge,
  windowed,
} from './ui.js';
import { loadOverview, loadConfig } from './dokku.js';
import { CHEATSHEET } from './cheatsheet.js';
import type { DokkuApp, Overview, Source } from './types.js';

interface ViewDef {
  key: 'apps' | 'domains' | 'process' | 'config' | 'cheatsheet';
  label: string;
  perApp: boolean;
}

const VIEWS: ViewDef[] = [
  { key: 'apps', label: 'Apps', perApp: false },
  { key: 'domains', label: 'Domains & SSL', perApp: true },
  { key: 'process', label: 'Processes', perApp: true },
  { key: 'config', label: 'Config / Env', perApp: true },
  { key: 'cheatsheet', label: 'Cheat Sheet', perApp: false },
];

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

function Loading(): ReactNode {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % frames.length), 90);
    return () => clearInterval(t);
  }, []);
  return (
    <Box padding={1}>
      <Text color={theme.accent}>{frames[i]} </Text>
      <Text>Loading Dokku data…</Text>
    </Box>
  );
}

function Header({ source, host, count }: { source: Source; host: string; count: number }): ReactNode {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Text color={theme.accent} bold>
          dokku-dash
        </Text>
        <Text wrap="truncate-end" color={theme.dim}> · {host}</Text>
      </Box>
      <Box>
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
    <Box flexDirection="column" width={24} borderStyle="round" borderColor={focused ? theme.accent : theme.dim} paddingX={1}>
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
    <Box flexDirection="column" width={20} borderStyle="round" borderColor={focused ? theme.accent : theme.dim} paddingX={1}>
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
    ['1-5', 'view'],
    ['tab', focused === 'menu' ? 'focus list' : 'focus menu'],
    ['↑↓', focused === 'menu' ? 'change view' : v.perApp ? 'select app' : 'scroll'],
  ];
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
  width,
  viewport,
  scroll,
}: {
  apps: DokkuApp[];
  width: number;
  viewport: number;
  scroll: number;
}): ReactNode {
  if (apps.length === 0) return <Text color={theme.dim}>No apps found.</Text>;
  // Fixed-width columns first, then the flexible DOMAIN column last so it can
  // truncate without disturbing alignment. Every cell is truncate-end so a
  // narrow terminal degrades gracefully instead of wrapping the grid.
  const nameW = 14;
  const statusW = 10;
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

function DomainsView({ app, width }: { app?: DokkuApp; width: number }): ReactNode {
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

function ProcessView({ app, width }: { app?: DokkuApp; width: number }): ReactNode {
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
  width,
  viewport,
  scroll,
}: {
  app?: DokkuApp;
  config?: Record<string, string>;
  loading: boolean;
  reveal: boolean;
  width: number;
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
  const [configCache, setConfigCache] = useState<Record<string, Record<string, string>>>({});
  const [configLoading, setConfigLoading] = useState(false);

  const apps = data ? data.apps : [];
  const source: Source = data ? data.source : 'demo';
  const currentView = VIEWS[view];
  const currentApp: DokkuApp | undefined = apps[selectedApp];

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await loadOverview();
    setData(result);
    setConfigCache({});
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setScroll(0);
  }, [view]);

  useEffect(() => {
    if (selectedApp > apps.length - 1) setSelectedApp(Math.max(0, apps.length - 1));
  }, [apps.length, selectedApp]);

  // Lazily load config for the selected app when on the config view.
  useEffect(() => {
    if (currentView.key !== 'config' || !currentApp) return;
    if (configCache[currentApp.name]) return;
    let cancelled = false;
    setConfigLoading(true);
    void loadConfig(currentApp.name, source).then((res) => {
      if (cancelled) return;
      setConfigCache((c) => ({ ...c, [currentApp.name]: res.vars }));
      setConfigLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [currentView.key, currentApp, source, configCache]);

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
      if (currentView.key === 'config') {
        const total = currentApp ? Object.keys(configCache[currentApp.name] || {}).length : 0;
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
        <Header source={source} host={hostLabel()} count={0} />
        <Loading />
      </Box>
    );
  }

  let content: ReactNode = null;
  switch (currentView.key) {
    case 'apps':
      content = <AppsView apps={apps} width={colBudget} viewport={viewport} scroll={scroll} />;
      break;
    case 'domains':
      content = <DomainsView app={currentApp} width={colBudget} />;
      break;
    case 'process':
      content = <ProcessView app={currentApp} width={colBudget} />;
      break;
    case 'config':
      content = (
        <ConfigView
          app={currentApp}
          config={currentApp ? configCache[currentApp.name] : {}}
          loading={configLoading && !(currentApp && configCache[currentApp.name])}
          reveal={reveal}
          width={colBudget}
          viewport={viewport}
          scroll={scroll}
        />
      );
      break;
    case 'cheatsheet':
      content = <CheatsheetView width={colBudget} viewport={viewport} scroll={scroll} />;
      break;
  }

  return (
    <Box flexDirection="column" height={rows}>
      <Header source={source} host={hostLabel()} count={apps.length} />
      <Box flexGrow={1}>
        <Menu view={view} focused={focus === 'menu'} />
        {currentView.perApp ? (
          <AppSelector apps={apps} selected={selectedApp} focused={focus === 'content'} height={viewport} />
        ) : null}
        <Box
          flexGrow={1}
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
