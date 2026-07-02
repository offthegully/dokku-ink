// Demo data used when `dokku` is not available (local dev / preview).

import type { AppDetail, DokkuApp, DokkuService, HostDisk, StatsMap } from './types.js';

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
      createdAt: '2025-11-02T14:21:00Z',
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
        startsAt: '2026-05-01T00:00:00Z',
        expiresAt: '2026-07-30T00:00:00Z',
        verified: true,
      },
    },
    {
      name: 'api',
      running: true,
      deployed: true,
      deploySource: 'herokuish',
      createdAt: '2025-08-19T09:05:00Z',
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
        startsAt: '2026-06-10T00:00:00Z',
        expiresAt: '2026-09-08T00:00:00Z',
        verified: true,
      },
    },
    {
      name: 'staging',
      running: false,
      deployed: true,
      deploySource: 'git',
      createdAt: '2026-03-30T18:44:00Z',
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
    },
    {
      name: 'metrics',
      running: true,
      deployed: true,
      deploySource: 'metabase/metabase:latest',
      createdAt: '2026-01-12T11:30:00Z',
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
        startsAt: '2026-04-15T00:00:00Z',
        expiresAt: '2026-07-05T00:00:00Z', // expiring soon
        verified: true,
      },
    },
    {
      name: 'landing',
      running: true,
      deployed: true,
      deploySource: 'dockerfile',
      createdAt: '2025-06-01T08:00:00Z',
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
      ports: ['http:80:5000', 'https:443:5000'],
      storage: ['/var/lib/dokku/data/storage/blog-uploads:/app/public/uploads'],
      git: { branch: 'main', sha: '4f2a91c', lastUpdated: '2026-06-28T21:14:00Z', sourceImage: null },
      network: { initial: 'bridge', attachPostCreate: null, attachPostDeploy: null },
    },
    api: {
      ports: ['http:80:5000', 'https:443:5000'],
      storage: [],
      git: { branch: 'main', sha: 'b81d3e0', lastUpdated: '2026-07-01T09:02:00Z', sourceImage: null },
      network: { initial: 'bridge', attachPostCreate: 'internal-net', attachPostDeploy: null },
    },
    staging: {
      ports: ['http:80:5000'],
      storage: [],
      git: { branch: 'develop', sha: '9cc2f17', lastUpdated: '2026-05-19T16:40:00Z', sourceImage: null },
      network: { initial: 'bridge', attachPostCreate: null, attachPostDeploy: null },
    },
    metrics: {
      ports: ['http:80:3000', 'https:443:3000'],
      storage: ['/var/lib/dokku/data/storage/metabase:/metabase-data'],
      git: { branch: null, sha: null, lastUpdated: null, sourceImage: 'metabase/metabase:latest' },
      network: { initial: 'bridge', attachPostCreate: null, attachPostDeploy: null },
    },
    landing: {
      ports: ['http:80:8080'],
      storage: [],
      git: { branch: 'main', sha: '0de91aa', lastUpdated: '2026-04-02T11:00:00Z', sourceImage: null },
      network: { initial: 'bridge', attachPostCreate: null, attachPostDeploy: null },
    },
  },
};
