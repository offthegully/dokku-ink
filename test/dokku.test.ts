// Unit tests for the dokku JSON parsing layer.
// Run with: npm test   (node:test runner via tsx)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApps,
  buildAppDetail,
  parseDatastorePlugins,
  parseDf,
  parseDockerStats,
  parseServiceInfo,
  parseServiceList,
  parseSize,
  toBool,
} from '../src/dokku.js';
import {
  appUsage,
  daysUntil,
  fmtAge,
  fmtAgeDays,
  fmtBytes,
  fmtDate,
  fmtPct,
  sslBadge,
  runningBadge,
  soonestCert,
  leadingTimestamp,
} from '../src/ui.js';
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
    /✓/,
  );
  assert.equal(sslBadge(null).text, 'none');
  assert.equal(
    sslBadge({ enabled: true, issuer: null, hostnames: [], startsAt: null, verified: null, expiresAt: '2000-01-01' }).text.includes('expired'),
    true,
  );
});

test('fmtAge formats compact durations', () => {
  assert.equal(fmtAge(0), '0s');
  assert.equal(fmtAge(59), '59s');
  assert.equal(fmtAge(60), '1m');
  assert.equal(fmtAge(3599), '59m');
  assert.equal(fmtAge(7200), '2h');
});

test('leadingTimestamp extracts and orders docker -t timestamps', () => {
  const a = leadingTimestamp('2026-07-01T18:22:29.599983966Z app[web.1]: GET / 200');
  const b = leadingTimestamp('2026-07-01T20:55:23.828667019Z app[web.1]: GET / 200');
  assert.equal(a, '2026-07-01T18:22:29.599983966Z');
  assert.ok(a! < b!); // lexicographic order == chronological order
  assert.equal(leadingTimestamp('log stream ended (exit 1)'), null);
});

test('parseSize handles docker stats units', () => {
  assert.equal(parseSize('55.2MiB'), Math.round(55.2 * 1024 * 1024));
  assert.equal(parseSize('1.9GiB'), Math.round(1.9 * 1024 ** 3));
  assert.equal(parseSize('512kB'), 512_000);
  assert.equal(parseSize('0B'), 0);
  assert.equal(parseSize('garbage'), null);
  assert.equal(parseSize(undefined), null);
});

test('parseDockerStats maps NDJSON samples by container name', () => {
  const out = [
    '{"Name":"blog.web.1","CPUPerc":"0.42%","MemUsage":"182MiB / 2GiB","MemPerc":"8.9%"}',
    '{"Name":"api.web.2","CPUPerc":"5.20%","MemUsage":"298MiB / 2GiB"}',
    'not json at all',
    '{"Container":"legacy-key","CPUPerc":"1%","MemUsage":"10MiB / 1GiB"}',
  ].join('\n');
  const map = parseDockerStats(out);
  assert.equal(map['blog.web.1'].cpuPct, 0.42);
  assert.equal(map['blog.web.1'].memBytes, 182 * 1024 * 1024);
  assert.equal(map['blog.web.1'].memLimitBytes, 2 * 1024 ** 3);
  assert.equal(map['api.web.2'].cpuPct, 5.2);
  assert.ok(map['legacy-key']); // falls back to the Container field
  assert.equal(Object.keys(map).length, 3);
});

test('appUsage sums container samples for an app', () => {
  const apps = buildApps(['blog'], appsRep, psRep, domRep, certRep);
  const stats = parseDockerStats(
    [
      '{"Name":"blog.web.1","CPUPerc":"0.4%","MemUsage":"100MiB / 2GiB"}',
      '{"Name":"blog.web.2","CPUPerc":"0.6%","MemUsage":"100MiB / 2GiB"}',
      '{"Name":"other.web.1","CPUPerc":"99%","MemUsage":"1GiB / 2GiB"}',
    ].join('\n'),
  );
  const u = appUsage(apps[0], stats);
  assert.equal(u.cpu, 1.0);
  assert.equal(u.mem, 200 * 1024 * 1024); // worker.1 has no sample; ignored
  assert.deepEqual(appUsage(apps[0], null), { cpu: null, mem: null });
});

test('parseDf reads POSIX df -Pk output', () => {
  const d = parseDf(
    'Filesystem     1024-blocks     Used Available Capacity Mounted on\n' +
      '/dev/vda1         50331648 30838784  19492864      62% /\n',
  );
  assert.equal(d?.usedPct, 62);
  assert.equal(d?.totalBytes, 50331648 * 1024);
  assert.equal(parseDf('garbage'), null);
});

test('fmtBytes and fmtPct format compactly', () => {
  assert.equal(fmtBytes(24 * 1024 * 1024), '24M');
  assert.equal(fmtBytes(1.4 * 1024 ** 3), '1.4G');
  assert.equal(fmtBytes(null), '—');
  assert.equal(fmtPct(0.42), '0.4%');
  assert.equal(fmtPct(11.3), '11%');
  assert.equal(fmtPct(null), '—');
});

test('fmtDate accepts ISO strings and epoch seconds', () => {
  assert.equal(fmtDate('2026-06-28T21:14:00Z'), '2026-06-28');
  assert.equal(fmtDate('1730556060'), '2024-11-02'); // dokku created-at shape
  assert.equal(fmtDate(null), '—');
});

test('daysUntil / fmtAgeDays accept epoch seconds like fmtDate', () => {
  const epoch = String(Math.floor((Date.now() - 20 * 86400000) / 1000)); // 20 days ago
  assert.equal(daysUntil(epoch), -20);
  assert.equal(fmtAgeDays(epoch), '20d'); // the apps-table AGE column
  assert.equal(fmtAgeDays('not a date'), '—');
});

test('parseDatastorePlugins finds enabled datastore plugins', () => {
  const out = [
    '  00_dokku-standard    0.38.0 enabled    dokku core standard plugin',
    '  postgres             1.38.0 enabled    dokku postgres service plugin',
    '  redis                1.36.5 disabled   dokku redis service plugin',
    '  letsencrypt          0.22.0 enabled    Automated installation of let\'s encrypt certs',
  ].join('\n');
  assert.deepEqual(parseDatastorePlugins(out), ['postgres']);
});

test('parseServiceList skips banners and column headers', () => {
  const out =
    '=====> Postgres services\n' +
    'NAME     VERSION              STATUS    EXPOSED PORTS    LINKS\n' +
    'blog-db  postgres:16.2        running   -                blog\n' +
    'api-db   postgres:16.2        running   -                api\n';
  assert.deepEqual(parseServiceList(out), ['blog-db', 'api-db']);
});

test('parseServiceInfo extracts indented key/value rows', () => {
  const out =
    '=====> blog-db postgres service information\n' +
    '       Config dir:          /var/lib/dokku/services/postgres/blog-db/config\n' +
    '       Dsn:                 postgres://postgres:pw@dokku-postgres-blog-db:5432/blog_db\n' +
    '       Exposed ports:       -\n' +
    '       Links:               blog api\n' +
    '       Status:              running\n' +
    '       Version:             postgres:16.2\n';
  const kv = parseServiceInfo(out);
  assert.equal(kv['status'], 'running');
  assert.equal(kv['version'], 'postgres:16.2');
  assert.equal(kv['links'], 'blog api');
  assert.equal(kv['exposed ports'], undefined); // "-" means unset
  assert.match(kv['dsn'], /^postgres:\/\//);
});

test('buildAppDetail assembles drill-in reports (both key shapes)', () => {
  const d = buildAppDetail(
    { map: 'http:80:5000 https:443:5000' },
    { 'deploy-branch': 'main', sha: 'abc1234def', 'last-updated-at': '1751100840' },
    { 'initial-network': 'bridge', 'attach-post-create': 'internal' },
    '=====> blog storage volume mounts:\n' +
      '       /var/lib/dokku/data/storage/blog:/app/uploads\n',
  );
  assert.deepEqual(d.ports, ['http:80:5000', 'https:443:5000']);
  assert.deepEqual(d.storage, ['/var/lib/dokku/data/storage/blog:/app/uploads']);
  assert.equal(d.git.branch, 'main');
  assert.equal(d.git.sha, 'abc1234def');
  assert.equal(d.network.initial, 'bridge');
  assert.equal(d.network.attachPostCreate, 'internal');

  // Older plugin-prefixed keys and empty inputs.
  const d2 = buildAppDetail(
    { 'ports-map': 'http:80:3000' },
    { 'git-deploy-branch': 'develop', 'git-sha': 'ffff' },
    undefined,
    '',
  );
  assert.deepEqual(d2.ports, ['http:80:3000']);
  assert.equal(d2.git.branch, 'develop');
  const empty = buildAppDetail(undefined, undefined, undefined, '');
  assert.deepEqual(empty.ports, []);
  assert.equal(empty.git.sha, null);
});

test('soonestCert picks the certificate expiring first', () => {
  const apps = buildApps(['blog', 'staging'], appsRep, psRep, domRep, certRep);
  // Only blog has an enabled cert (2099) -> it wins; staging's disabled cert is ignored.
  const s = soonestCert(apps);
  assert.equal(s?.app, 'blog');
  assert.ok(s!.days > 0);
  assert.equal(soonestCert([]), null);
});
