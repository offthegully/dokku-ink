// Shared types for the normalized Dokku data model.

export interface ProcInstance {
  index: number;
  status: string;
}

export interface Process {
  type: string;
  scale: number;
  instances: ProcInstance[];
}

export interface Ssl {
  enabled: boolean;
  hostnames: string[];
  issuer: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  verified: boolean | null;
}

export interface DokkuApp {
  name: string;
  running: boolean | null;
  deployed: boolean;
  deploySource: string | null;
  createdAt: string | null;
  restartPolicy: string | null;
  processes: Process[];
  domains: string[];
  domainsEnabled: boolean | null;
  ssl: Ssl | null;
}

export type Source = 'dokku' | 'demo';

export interface Overview {
  apps: DokkuApp[];
  source: Source;
  warnings: string[];
}

/** Raw `dokku <plugin>:report --format json` output: app -> { key: value }. */
export type RawReport = Record<string, Record<string, string>> | null;

export interface ConfigResult {
  vars: Record<string, string>;
  source: Source;
  error?: string;
}
