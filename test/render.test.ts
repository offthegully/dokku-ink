// Smoke test: the app renders in demo mode and reacts to key input,
// without throwing. Uses ink-testing-library's virtual terminal.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DOKKU_DASH_DEMO = '1';

const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { default: App } = await import('../src/App.js');

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test('renders the dashboard with demo data', async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick(); // let loadOverview() resolve

  const frame = lastFrame() ?? '';
  assert.match(frame, /dokku-dash/);
  assert.match(frame, /DEMO DATA/);
  assert.match(frame, /blog/); // first demo app
  assert.match(frame, /Cheat Sheet/); // menu label
  assert.match(frame, /CPU/); // usage columns from demo docker stats
  assert.match(frame, /disk 61%/); // demo host disk in the header

  stdin.write('7'); // Cheat Sheet view
  await tick(20);
  assert.match(lastFrame() ?? '', /dokku apps:list|Deploy|Process/);

  stdin.write('5'); // Logs view (demo generator)
  await tick(20);
  assert.match(lastFrame() ?? '', /dokku logs -t/);

  unmount();
});

test('services view lists demo datastores and masks the DSN', async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
  stdin.write('6'); // Services view
  await tick(40); // let loadServices() resolve
  const frame = lastFrame() ?? '';
  assert.match(frame, /blog-db/);
  assert.match(frame, /postgres/);
  assert.match(frame, /LINKED APPS/);
  assert.doesNotMatch(frame, /s3cr3t/); // DSN masked by default
  stdin.write('s'); // reveal
  await tick(20);
  assert.match(lastFrame() ?? '', /postgres:\/\//);
  unmount();
});

test('enter opens the app detail drill-in and esc closes it', async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
  stdin.write('\r'); // enter on the Apps view (blog selected)
  await tick(40); // let loadAppDetail() resolve
  const frame = lastFrame() ?? '';
  assert.match(frame, /APP DETAIL/);
  assert.match(frame, /PORTS/);
  assert.match(frame, /http:80:5000/);
  assert.match(frame, /STORAGE/);
  stdin.write(''); // escape closes
  await tick(20);
  assert.doesNotMatch(lastFrame() ?? '', /APP DETAIL/);
  unmount();
});

test('`/` filters the app list live', async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
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
  unmount();
});

test('`?` opens the help overlay', async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
  stdin.write('?');
  await tick(20);
  assert.match(lastFrame() ?? '', /HELP/);
  stdin.write('');
  await tick(20);
  assert.doesNotMatch(lastFrame() ?? '', /HELP/);
  unmount();
});

test('cheat sheet enter prefills the `:` prompt', async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
  stdin.write('7'); // Cheat Sheet
  await tick(20);
  stdin.write('\r'); // first item: dokku apps:list
  await tick(20);
  assert.match(lastFrame() ?? '', /: dokku apps:list/);
  unmount();
});

test('`:` opens the command bar and escape closes it', async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
  stdin.write(':');
  await tick(20);
  assert.match(lastFrame() ?? '', /: dokku/);
  stdin.write('ps:restart');
  await tick(20);
  assert.match(lastFrame() ?? '', /ps:restart/);
  stdin.write(''); // escape — cancel without running
  await tick(20);
  assert.doesNotMatch(lastFrame() ?? '', /: dokku/);
  unmount();
});

test('config view masks values until revealed', async () => {
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
  stdin.write('4'); // Config / Env view
  await tick(40);
  assert.match(lastFrame() ?? '', /reveal/); // hint shown, values masked
  stdin.write('s'); // reveal
  await tick(20);
  assert.match(lastFrame() ?? '', /hide/);
  unmount();
});
