// Demo data used when `dokku` is not available (local dev / preview).

import type { AppDetail, DokkuApp, DokkuService, HostDisk, StatsMap } from './types.js';

// Demo dates are relative to now, not hardcoded: with fixed timestamps the
// preview drifted into showing every certificate as long expired and every app
// as years old, which is the opposite of what `--demo` is meant to show off.
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();
const daysAhead = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString();

interface DemoData {
  apps: DokkuApp[];
  config: Record<string, Record<string, string>>;
  stats: StatsMap;
  disk: HostDisk;
  services: DokkuService[];
  details: Record<string, AppDetail>;
}

export const DEMO: DemoData = {
  apps: [
    {
      name: 'blog',
      running: true,
      deployed: true,
      deploySource: 'dockerfile',
      createdAt: daysAgo(310),
      restartPolicy: 'on-failure:10',
      processes: [
        {
          type: 'web',
          scale: 2,
          instances: [
            { index: 1, status: 'running (a1b2c3d4)' },
            { index: 2, status: 'running (e5f6a7b8)' },
          ],
        },
        {
          type: 'worker',
          scale: 1,
          instances: [{ index: 1, status: 'running (9c0d1e2f)' }],
        },
      ],
      domains: ['blog.example.com', 'www.blog.example.com'],
      domainsEnabled: true,
      ssl: {
        enabled: true,
        hostnames: ['blog.example.com', 'www.blog.example.com'],
        issuer: "Let's Encrypt",
        startsAt: daysAgo(28),
        expiresAt: daysAhead(62),
        verified: true,
      },
      locked: false,
      checks: { disabled: [], skipped: [] },
      proxy: { type: 'nginx', enabled: true, port: '80', sslPort: '443' },
      cronTasks: 2,
    },
    {
      name: 'api',
      running: true,
      deployed: true,
      deploySource: 'herokuish',
      createdAt: daysAgo(395),
      restartPolicy: 'on-failure:10',
      processes: [
        {
          type: 'web',
          scale: 3,
          instances: [
            { index: 1, status: 'running (11aa22bb)' },
            { index: 2, status: 'running (33cc44dd)' },
            { index: 3, status: 'running (55ee66ff)' },
          ],
        },
        {
          type: 'release',
          scale: 1,
          instances: [{ index: 1, status: 'exited (0)' }],
        },
      ],
      domains: ['api.example.com'],
      domainsEnabled: true,
      ssl: {
        enabled: true,
        hostnames: ['api.example.com'],
        issuer: "Let's Encrypt",
        startsAt: daysAgo(41),
        expiresAt: daysAhead(49),
        verified: true,
      },
      locked: false,
      checks: { disabled: [], skipped: ['worker'] },
      proxy: { type: 'nginx', enabled: true, port: '80', sslPort: '443' },
      cronTasks: 0,
    },
    {
      name: 'staging',
      running: false,
      deployed: true,
      deploySource: 'git',
      createdAt: daysAgo(160),
      restartPolicy: 'on-failure:10',
      processes: [
        {
          type: 'web',
          scale: 1,
          instances: [{ index: 1, status: 'exited (137)' }],
        },
      ],
      domains: ['staging.example.com'],
      domainsEnabled: true,
      ssl: null,
      locked: true,
      checks: { disabled: ['_all_'], skipped: [] },
      proxy: { type: 'nginx', enabled: true, port: '80', sslPort: '443' },
      cronTasks: 0,
    },
    {
      name: 'metrics',
      running: true,
      deployed: true,
      deploySource: 'metabase/metabase:latest',
      createdAt: daysAgo(240),
      restartPolicy: 'always',
      processes: [
        {
          type: 'web',
          scale: 1,
          instances: [{ index: 1, status: 'running (77ab88cd)' }],
        },
      ],
      domains: ['metrics.example.com'],
      domainsEnabled: true,
      ssl: {
        enabled: true,
        hostnames: ['metrics.example.com'],
        issuer: "Let's Encrypt",
        startsAt: daysAgo(81),
        expiresAt: daysAhead(9), // expiring soon — demos the header warning
        verified: true,
      },
      locked: false,
      checks: { disabled: [], skipped: [] },
      proxy: { type: 'traefik', enabled: true, port: '80', sslPort: '443' },
      cronTasks: 1,
    },
    {
      name: 'landing',
      running: true,
      deployed: true,
      deploySource: 'dockerfile',
      createdAt: daysAgo(480),
      restartPolicy: 'on-failure:10',
      processes: [
        {
          type: 'web',
          scale: 1,
          instances: [{ index: 1, status: 'running (90ef12ab)' }],
        },
      ],
      domains: [],
      domainsEnabled: false,
      ssl: null,
      locked: false,
      checks: { disabled: [], skipped: [] },
      proxy: { type: 'nginx', enabled: false, port: '80', sslPort: '443' },
      cronTasks: 0,
    },
  ],

  config: {
    blog: {
      DATABASE_URL: 'postgres://blog:s3cr3t@dokku-postgres-blog:5432/blog',
      SECRET_KEY_BASE: '8f2a9c1e7b4d6a3f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b',
      RAILS_ENV: 'production',
      RAILS_LOG_TO_STDOUT: 'true',
      DOKKU_LETSENCRYPT_EMAIL: 'ops@example.com',
    },
    api: {
      DATABASE_URL: 'postgres://api:hunter2@dokku-postgres-api:5432/api',
      REDIS_URL: 'redis://dokku-redis-api:6379',
      JWT_SECRET: 'eyJhbGciOiJI-demo-secret-do-not-use',
      NODE_ENV: 'production',
      PORT: '5000',
      SENTRY_DSN: 'https://abc123@o0.ingest.sentry.io/0',
    },
    staging: {
      DATABASE_URL: 'postgres://staging:pw@dokku-postgres-staging:5432/staging',
      NODE_ENV: 'staging',
      FEATURE_FLAGS: 'beta-ui,new-billing',
    },
    metrics: {
      MB_DB_TYPE: 'postgres',
      MB_DB_CONNECTION_URI: 'postgres://metabase@dokku-postgres-metrics:5432/metabase',
      MB_ENCRYPTION_SECRET_KEY: 'demo-encryption-key-0123456789abcdef',
    },
    landing: {
      NODE_ENV: 'production',
    },
  },

  // docker stats-shaped usage samples, keyed by container name.
  stats: {
    'blog.web.1': { name: 'blog.web.1', cpuPct: 0.4, memBytes: 182 * 2 ** 20, memLimitBytes: 2 ** 31 },
    'blog.web.2': { name: 'blog.web.2', cpuPct: 0.3, memBytes: 176 * 2 ** 20, memLimitBytes: 2 ** 31 },
    'blog.worker.1': { name: 'blog.worker.1', cpuPct: 2.1, memBytes: 240 * 2 ** 20, memLimitBytes: 2 ** 31 },
    'api.web.1': { name: 'api.web.1', cpuPct: 4.8, memBytes: 310 * 2 ** 20, memLimitBytes: 2 ** 31 },
    'api.web.2': { name: 'api.web.2', cpuPct: 5.2, memBytes: 298 * 2 ** 20, memLimitBytes: 2 ** 31 },
    'api.web.3': { name: 'api.web.3', cpuPct: 3.9, memBytes: 305 * 2 ** 20, memLimitBytes: 2 ** 31 },
    'metrics.web.1': { name: 'metrics.web.1', cpuPct: 11.3, memBytes: 1.4 * 2 ** 30, memLimitBytes: 2 ** 32 },
    'landing.web.1': { name: 'landing.web.1', cpuPct: 0.0, memBytes: 24 * 2 ** 20, memLimitBytes: 2 ** 31 },
  },
  disk: { usedPct: 61, usedBytes: 29 * 2 ** 30, totalBytes: 48 * 2 ** 30 },

  services: [
    {
      plugin: 'postgres',
      name: 'blog-db',
      status: 'running',
      version: 'postgres:16.2',
      links: ['blog'],
      exposedPorts: null,
      dsn: 'postgres://postgres:s3cr3t@dokku-postgres-blog-db:5432/blog_db',
    },
    {
      plugin: 'postgres',
      name: 'api-db',
      status: 'running',
      version: 'postgres:16.2',
      links: ['api', 'staging'],
      exposedPorts: null,
      dsn: 'postgres://postgres:hunter2@dokku-postgres-api-db:5432/api_db',
    },
    {
      plugin: 'redis',
      name: 'api-cache',
      status: 'running',
      version: 'redis:7.2.4',
      links: ['api'],
      exposedPorts: null,
      dsn: 'redis://:pw@dokku-redis-api-cache:6379',
    },
    {
      plugin: 'postgres',
      name: 'scratch-db',
      status: 'exited',
      version: 'postgres:15.6',
      links: [],
      exposedPorts: '5432->15432',
      dsn: 'postgres://postgres:pw@dokku-postgres-scratch-db:5432/scratch_db',
    },
  ],

  details: {
    blog: {
      scale: { web: 2, worker: 1 },
      resources: [{ processType: 'web', limits: { memory: '512m', cpu: '1' }, reserves: { memory: '256m' } }],
      ports: ['http:80:5000', 'https:443:5000'],
      storage: ['/var/lib/dokku/data/storage/blog-uploads:/app/public/uploads'],
      git: { branch: 'main', sha: '4f2a91c', lastUpdated: daysAgo(3), sourceImage: null },
      network: { initial: 'bridge', attachPostCreate: null, attachPostDeploy: null },
    },
    api: {
      scale: { web: 3, worker: 2 },
      resources: [
        { processType: 'web', limits: { memory: '1024m' }, reserves: { memory: '512m', cpu: '0.5' } },
        { processType: 'worker', limits: { memory: '512m' }, reserves: {} },
      ],
      ports: ['http:80:5000', 'https:443:5000'],
      storage: [],
      git: { branch: 'main', sha: 'b81d3e0', lastUpdated: daysAgo(1), sourceImage: null },
      network: { initial: 'bridge', attachPostCreate: 'internal-net', attachPostDeploy: null },
    },
    staging: {
      scale: { web: 1 },
      resources: [],
      ports: ['http:80:5000'],
      storage: [],
      git: { branch: 'develop', sha: '9cc2f17', lastUpdated: daysAgo(44), sourceImage: null },
      network: { initial: 'bridge', attachPostCreate: null, attachPostDeploy: null },
    },
    metrics: {
      scale: { web: 1 },
      resources: [{ processType: '_default_', limits: { memory: '2048m' }, reserves: {} }],
      ports: ['http:80:3000', 'https:443:3000'],
      storage: ['/var/lib/dokku/data/storage/metabase:/metabase-data'],
      git: { branch: null, sha: null, lastUpdated: null, sourceImage: 'metabase/metabase:latest' },
      network: { initial: 'bridge', attachPostCreate: null, attachPostDeploy: null },
    },
    landing: {
      scale: { web: 1 },
      resources: [],
      ports: ['http:80:8080'],
      storage: [],
      git: { branch: 'main', sha: '0de91aa', lastUpdated: daysAgo(91), sourceImage: null },
      network: { initial: 'bridge', attachPostCreate: null, attachPostDeploy: null },
    },
  },
};
