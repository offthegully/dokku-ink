process.env.DOKKU_DASH_DEMO = '1';
const React = (await import('react')).default;
const { render } = await import('ink-testing-library');
const { default: App } = await import('./src/App.js');
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const { stdin, unmount } = render(React.createElement(App));
await tick();
stdin.write('5'); // logs view starts the demo generator
await tick(40);
unmount();
console.log('unmounted; if the process hangs now, something leaked');
