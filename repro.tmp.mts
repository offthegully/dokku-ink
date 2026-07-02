process.env.DOKKU_DASH_DEMO = '1';
const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { default: App } = await import('./src/App.js');

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

{
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
  stdin.write('6');
  await tick(60);
  console.log('=== SERVICES FRAME ===');
  console.log(lastFrame());
  unmount();
}
{
  const { lastFrame, stdin, unmount } = render(React.createElement(App));
  await tick();
  stdin.write('4');
  await tick(60);
  console.log('=== CONFIG FRAME ===');
  console.log(lastFrame());
  stdin.write('s');
  await tick(30);
  console.log('=== CONFIG AFTER s ===');
  console.log(lastFrame());
  unmount();
}
process.exit(0);
