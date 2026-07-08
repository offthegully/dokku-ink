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

    stdin.write('5'); // Logs view (demo generator)
    await tick(20);
    assert.match(lastFrame() ?? '', /dokku logs -t/);
  }));

test('services view lists demo datastores and masks the DSN', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('6'); // Services view
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
  withApp(async ({ lastFrame }) => {
    await tick(300); // debounce + loadAppDetail() for the selected row
    const frame = lastFrame() ?? '';
    assert.match(frame, /GIT/);
    assert.match(frame, /PORTS/);
    assert.match(frame, /http:80:5000/);
    assert.match(frame, /STORAGE/);
    assert.match(frame, /blog-db/); // linked service in the summary
  }));

test('tab cycles to the next view', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('\t');
    await tick(20);
    const frame = lastFrame() ?? '';
    assert.match(frame, /SSL CERTIFICATE/); // Domains detail in the bottom pane
    assert.match(frame, /NAME.*STATUS.*PROCESSES/); // apps table stays on top
  }));

test('←/→ switches the detail tab and ↑↓ still selects the app', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('[C'); // → to Domains & SSL
    await tick(20);
    assert.match(lastFrame() ?? '', /SSL CERTIFICATE/);
    stdin.write('[B'); // ↓ selects the next app in the table
    await tick(20);
    assert.match(lastFrame() ?? '', /api {2}● running/); // detail follows the selection
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

test('config view masks values until revealed', () =>
  withApp(async ({ lastFrame, stdin }) => {
    stdin.write('4'); // Config / Env view
    await tick(40);
    assert.match(lastFrame() ?? '', /reveal/); // hint shown, values masked
    stdin.write('s'); // reveal
    await tick(20);
    assert.match(lastFrame() ?? '', /hide/);
  }));
