// Smoke test: the app renders in demo mode and reacts to key input,
// without throwing. Uses ink-testing-library's virtual terminal.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOKKU_INK_DEMO = '1';

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { default: App } = await import('../src/App.js');

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

type Instance = ReturnType<typeof render>;

// Always unmount, even when an assertion throws — a mounted app's polling
// intervals would otherwise keep the test process alive forever.
async function withApp(fn: (inst: Instance) => Promise<void>): Promise<void> {
  const inst = render(React.createElement(App));
  try {
    await tick(); // let loadOverview() resolve
    await fn(inst);
  } finally {
    inst.unmount();
  }
}

test('renders the dashboard with demo data', () =>
  withApp(async ({ lastFrame, stdin }) => {
    const frame = lastFrame() ?? '';
    assert.match(frame, /dokku-ink/);
    assert.match(frame, /DEMO DATA/);
    assert.match(frame, /blog/); // first demo app
    assert.match(frame, /Services/); // tab-bar label
    assert.match(frame, /CPU/); // usage columns from demo docker stats
    assert.match(frame, /disk 61%/); // demo host disk in the header

    stdin.write('c'); // Cheat Sheet overlay
    await tick(20);
    assert.match(lastFrame() ?? '', /CHEAT SHEET/);
    assert.match(lastFrame() ?? '', /dokku apps:list|Deploy|Process/);
    stdin.write(''); // esc closes the overlay
    await tick(20);

    stdin.write('4'); // Logs view (demo generator)
    await tick(20);
    assert.match(lastFrame() ?? '', /dokku logs -t/);
  }));

test('services view lists demo datastores and masks the DSN', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('5'); // Services view
    await tick(40); // let loadServices() resolve
    const frame = lastFrame() ?? '';
    assert.match(frame, /PLUGIN/); // services table replaces the apps table on top
    assert.match(frame, /blog-db/);
    assert.match(frame, /postgres/);
    assert.match(frame, /api-cache/); // redis service listed too
    assert.match(frame, /VERSION/); // selected service's detail pane below
    assert.doesNotMatch(frame, /s3cr3t/); // DSN masked by default
    stdin.write('s'); // reveal
    await tick(20);
    assert.match(lastFrame() ?? '', /postgres:\/\//);
  }));

test('apps view auto-loads the selected app summary pane', () =>
  withApp(async ({ lastFrame, frames }) => {
    await tick(300); // debounce + loadAppDetail() for the selected row
    const frame = lastFrame() ?? '';
    assert.match(frame, /GIT/);
    assert.match(frame, /PORTS/);
    assert.match(frame, /http:80:5000/);
    assert.match(frame, /STORAGE/);
    assert.match(frame, /blog-db/); // linked service in the summary
    // Domains + SSL are merged into the Overview pane. Assert across the
    // accumulated frames, not just the last write: ink-testing-library's
    // captured frames can drop or overlay individual rows (a capture artifact
    // — real terminals render correctly; see also the release.1 note below).
    const all = frames.join('\n');
    assert.match(all, /blog\.example\.com {2}✓ cert/);
    assert.match(all, /SSL {6}LE ✓ · Let's Encrypt · expires 2026-07-30/);
  }));

test('tab cycles to the next view', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('\t');
    await tick(20);
    const frame = lastFrame() ?? '';
    assert.match(frame, /PROCESSES/); // Processes detail in the bottom pane
    assert.match(frame, /DEPLOY/);
    assert.match(frame, /NAME.*STATUS.*PROCESSES/); // apps table stays on top
  }));

test('←/→ switches the detail tab and ↑↓ still selects the app', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('[C'); // → to Processes
    await tick(20);
    assert.match(lastFrame() ?? '', /DEPLOY/);
    stdin.write('[B'); // ↓ selects the next app in the table
    await tick(20);
    // `release.1` only exists in api's process list — proves the detail pane
    // followed the selection. (Don't assert on the bold header line: lastFrame
    // can capture an incremental diff write that mangles leading bold chars.)
    assert.match(lastFrame() ?? '', /release\.1/);
    stdin.write('[D'); // ← back to Overview
    await tick(300); // debounce + loadAppDetail()
    assert.match(lastFrame() ?? '', /GIT/);
  }));

test('`/` filters the app list live', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('/');
    await tick(20);
    stdin.write('api');
    await tick(20);
    const frame = lastFrame() ?? '';
    assert.match(frame, /api/);
    assert.doesNotMatch(frame, /\bblog\b/); // filtered out of the table
    stdin.write(''); // esc clears the filter
    await tick(20);
    assert.match(lastFrame() ?? '', /blog/);
  }));

test('`?` opens the help overlay', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('?');
    await tick(20);
    assert.match(lastFrame() ?? '', /HELP/);
    stdin.write('');
    await tick(20);
    assert.doesNotMatch(lastFrame() ?? '', /HELP/);
  }));

test('cheat sheet enter prefills the `:` prompt and closes the overlay', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('c'); // Cheat Sheet overlay
    await tick(20);
    stdin.write('\r'); // first item: dokku apps:list
    await tick(20);
    const frame = lastFrame() ?? '';
    assert.match(frame, /: dokku apps:list/);
    assert.doesNotMatch(frame, /CHEAT SHEET/); // overlay closed on insert
  }));

test('`:` opens the command bar and escape closes it', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write(':');
    await tick(20);
    assert.match(lastFrame() ?? '', /: dokku/);
    stdin.write('ps:restart');
    await tick(20);
    assert.match(lastFrame() ?? '', /ps:restart/);
    stdin.write(''); // escape — cancel without running
    await tick(20);
    assert.doesNotMatch(lastFrame() ?? '', /: dokku/);
  }));

test('R/S/B quick actions prefill the `:` prompt and require a confirm before running', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('S'); // prefill ps:stop for the selected app
    await tick(20);
    assert.match(lastFrame() ?? '', /: dokku ps:stop \$app/);

    stdin.write('\r'); // first enter — must NOT run yet
    await tick(20);
    let frame = lastFrame() ?? '';
    // The selected app's name is resolved in the confirm text, not left as
    // the literal `$app` placeholder — otherwise the dialog doesn't actually
    // say what it's about to affect.
    assert.match(frame, /run "dokku ps:stop blog"\?/);
    assert.doesNotMatch(frame, /COMMAND/);

    stdin.write('\x1b'); // esc backs out of the confirm, back to the editable prompt
    await tick(20);
    frame = lastFrame() ?? '';
    assert.match(frame, /: dokku ps:stop \$app/);
    assert.doesNotMatch(frame, /run "dokku/);

    stdin.write('\r'); // enter again to re-reach the confirm step
    await tick(20);
    stdin.write('n'); // 'n' cancels just like esc
    await tick(20);
    frame = lastFrame() ?? '';
    assert.match(frame, /: dokku ps:stop \$app/);
    assert.doesNotMatch(frame, /run "dokku/);

    stdin.write('\r'); // enter a third time to re-reach the confirm step
    await tick(20);
    stdin.write('y'); // 'y' confirms just like enter
    await tick(80);
    frame = lastFrame() ?? '';
    assert.match(frame, /COMMAND/);
    assert.match(frame, /\$ dokku ps:stop blog/);
  }));

test('non-destructive `:` commands still run on a single enter', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write(':');
    await tick(20);
    stdin.write('apps:list');
    await tick(20);
    stdin.write('\r');
    await tick(80);
    const frame = lastFrame() ?? '';
    assert.match(frame, /COMMAND/);
    assert.match(frame, /\$ dokku apps:list/);
  }));

test('confirm guard cannot be bypassed by a `dokku ` prefix, different casing, or other irreversible verbs', () =>
  withApp(async ({ lastFrame, stdin }) => {
    // "dokku ps:stop" — startCommand strips the `dokku ` prefix before
    // running, so the confirm check has to match on the same stripped text.
    stdin.write(':');
    await tick(20);
    stdin.write('dokku ps:stop blog');
    await tick(20);
    stdin.write('\r');
    await tick(20);
    let frame = lastFrame() ?? '';
    assert.match(frame, /run "dokku ps:stop blog"\?/);
    assert.doesNotMatch(frame, /COMMAND/);
    stdin.write('\x1b'); // cancel
    await tick(20);
    stdin.write('\x1b'); // close the `:` prompt entirely
    await tick(20);

    // Case shouldn't matter.
    stdin.write(':');
    await tick(20);
    stdin.write('Ps:Stop blog');
    await tick(20);
    stdin.write('\r');
    await tick(20);
    frame = lastFrame() ?? '';
    assert.match(frame, /run "dokku Ps:Stop blog"\?/);
    assert.doesNotMatch(frame, /COMMAND/);
    stdin.write('\x1b');
    await tick(20);
    stdin.write('\x1b');
    await tick(20);

    // Other irreversible commands beyond the R/S/B trio also get gated —
    // apps:destroy is the cheat sheet's own example of an irreversible command.
    stdin.write(':');
    await tick(20);
    stdin.write('apps:destroy blog');
    await tick(20);
    stdin.write('\r');
    await tick(20);
    frame = lastFrame() ?? '';
    assert.match(frame, /run "dokku apps:destroy blog"\?/);
    assert.doesNotMatch(frame, /COMMAND/);
  }));

test('config view masks values until revealed', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('3'); // Config / Env view
    await tick(40);
    assert.match(lastFrame() ?? '', /reveal/); // hint shown, values masked
    stdin.write('s'); // reveal
    await tick(20);
    assert.match(lastFrame() ?? '', /hide/);
  }));
