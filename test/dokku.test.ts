// Unit tests for the dokku JSON parsing layer.
// Run with: npm test   (node:test runner via tsx)

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApps, toBool } from '../src/dokku.js';
import { sslBadge, runningBadge, soonestCert } from '../src/ui.js';
import type { RawReport } from '../src/types.js';

// Sample shaped like real `dokku <plugin>:report --format json` output
// (keys = flag names with the leading --<plugin>- stripped; values are strings).
const appsRep: RawReport = {
  blog: { 'created-at': '1730556060', 'deploy-source': 'dockerfile' },
  staging: { 'created-at': '1743360000', 'deploy-source': 'git' },
};
const psRep: RawReport = {
  blog: {
    running: 'true',
    deployed: 'true',
    'restart-policy': 'on-failure:10',
    'status-web-1': 'running (a1b2c3)',
    'status-web-2': 'running (d4e5f6)',
    'status-worker-1': 'running (99aa88)',
  },
  staging: {
    running: 'false',
    deployed: 'true',
    'restart-policy': 'on-failure:10',
    'status-web-1': 'exited (137)',
  },
};
const domRep: RawReport = {
  blog: { 'app-enabled': 'true', 'app-vhosts': 'blog.example.com www.blog.example.com' },
  staging: { 'app-enabled': 'true', 'app-vhosts': 'staging.example.com' },
};
const certRep: RawReport = {
  blog: {
    'ssl-enabled': 'true',
    'ssl-issuer': "Let's Encrypt",
    'ssl-hostnames': 'blog.example.com www.blog.example.com',
    'ssl-expires-at': '2099-01-01T00:00:00Z',
    'ssl-verified': 'true',
  },
  staging: { 'ssl-enabled': 'false' },
};

test('toBool coerces dokku string booleans', () => {
  assert.equal(toBool('true'), true);
  assert.equal(toBool(true), true);
  assert.equal(toBool('false'), false);
  assert.equal(toBool(''), false);
  assert.equal(toBool(undefined), false);
});

test('buildApps normalises a running app with multiple processes', () => {
  const apps = buildApps(['blog', 'staging'], appsRep, psRep, domRep, certRep);
  const blog = apps.find((a) => a.name === 'blog')!;
  assert.equal(blog.running, true);
  assert.equal(blog.deploySource, 'dockerfile');
  assert.deepEqual(
    blog.processes.map((p) => `${p.type}:${p.scale}`),
    ['web:2', 'worker:1'],
  );
  assert.equal(blog.processes[0].instances.length, 2);
  assert.deepEqual(blog.domains, ['blog.example.com', 'www.blog.example.com']);
  assert.equal(blog.domainsEnabled, true);
  assert.equal(blog.ssl?.enabled, true);
  assert.match(blog.ssl!.issuer!, /Let's Encrypt/);
});

test('buildApps handles a stopped app with no SSL', () => {
  const apps = buildApps(['staging'], appsRep, psRep, domRep, certRep);
  const s = apps[0];
  assert.equal(s.running, false);
  assert.equal(s.processes[0].instances[0].status, 'exited (137)');
  assert.equal(s.ssl, null); // ssl-enabled false -> normalised to null
});

test('buildApps parses Dokku 0.38 per-app report shapes', () => {
  // 0.38 quirks: certs use `enabled`/`issuer` (no ssl- prefix), ps exposes
  // `computed-restart-policy`, domains carry `app-vhosts`, and process status
  // keys are dot-separated (`status-web.1`, from CONTAINER.web.1 files).
  const apps = buildApps(
    ['x'],
    { x: { 'created-at': '1781837404', 'deploy-source': '', dir: '/home/dokku/x' } },
    { x: { deployed: 'true', running: 'true', 'computed-restart-policy': 'on-failure:10', 'status-web.1': 'running (abc)', 'status-web.2': 'running (def)' } },
    { x: { 'app-enabled': 'true', 'app-vhosts': 'x.example.com', 'global-vhosts': 'example.com' } },
    { x: { dir: '/home/dokku/x/tls', enabled: 'false', hostnames: '', issuer: '' } },
  );
  const a = apps[0];
  assert.equal(a.running, true);
  assert.equal(a.restartPolicy, 'on-failure:10');
  assert.equal(a.processes[0].type, 'web');
  assert.equal(a.processes[0].scale, 2);
  assert.deepEqual(a.domains, ['x.example.com']);
  assert.equal(a.domainsEnabled, true);
  assert.equal(a.ssl, null); // enabled:false -> null
});

test('buildApps is resilient to missing reports', () => {
  const apps = buildApps(['ghost'], null, null, null, null);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].running, null);
  assert.deepEqual(apps[0].processes, []);
  assert.deepEqual(apps[0].domains, []);
  assert.equal(apps[0].ssl, null);
});

test('badges classify state correctly', () => {
  assert.equal(runningBadge({ running: true, deployed: true }).color, 'green');
  assert.equal(runningBadge({ running: false, deployed: true }).color, 'red');
  assert.equal(runningBadge({ running: null, deployed: false }).color, 'gray');
  const nd = runningBadge({ running: false, deployed: false });
  assert.match(nd.text, /not deployed/);
  assert.equal(nd.color, 'gray');

  assert.match(
    sslBadge({ enabled: true, issuer: "Let's Encrypt", hostnames: [], startsAt: null, verified: true, expiresAt: '2099-01-01' }).text,
    /✔/,
  );
  assert.equal(sslBadge(null).text, 'none');
  assert.equal(
    sslBadge({ enabled: true, issuer: null, hostnames: [], startsAt: null, verified: null, expiresAt: '2000-01-01' }).text.includes('expired'),
    true,
  );
});

test('soonestCert picks the certificate expiring first', () => {
  const apps = buildApps(['blog', 'staging'], appsRep, psRep, domRep, certRep);
  // Only blog has an enabled cert (2099) -> it wins; staging's disabled cert is ignored.
  const s = soonestCert(apps);
  assert.equal(s?.app, 'blog');
  assert.ok(s!.days > 0);
  assert.equal(soonestCert([]), null);
});
