// Demo data used when `dokku` is not available (local dev / preview).

import type { DokkuApp } from './types.js';

interface DemoData {
  apps: DokkuApp[];
  config: Record<string, Record<string, string>>;
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
};
