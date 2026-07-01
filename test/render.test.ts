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

  stdin.write('5'); // Cheat Sheet view
  await tick(20);
  assert.match(lastFrame() ?? '', /dokku apps:list|Deploy|Process/);

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
