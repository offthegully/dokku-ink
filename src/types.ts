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

/** One container's usage sample from `docker stats`, keyed by `<app>.<proc>.<n>`. */
export interface ContainerStat {
  name: string;
  cpuPct: number | null;
  memBytes: number | null;
  memLimitBytes: number | null;
}

export type StatsMap = Record<string, ContainerStat>;

export interface HostDisk {
  usedPct: number;
  usedBytes: number;
  totalBytes: number;
}

export interface StatsResult {
  /** null when docker isn't reachable (e.g. SSH as the dokku user). */
  stats: StatsMap | null;
  disk: HostDisk | null;
  source: Source;
}

/** A datastore service from an official plugin (postgres, redis, mysql, …). */
export interface DokkuService {
  plugin: string;
  name: string;
  status: string | null;
  version: string | null;
  links: string[];
  exposedPorts: string | null;
  /** Connection string — contains credentials; render masked by default. */
  dsn: string | null;
}

export interface ServicesResult {
  services: DokkuService[];
  /** Datastore plugins found installed (empty = none / not probed). */
  plugins: string[];
  source: Source;
}

/** Lazily-fetched extras for the per-app drill-in view. */
export interface AppDetail {
  ports: string[];
  storage: string[];
  git: {
    branch: string | null;
    sha: string | null;
    lastUpdated: string | null;
    sourceImage: string | null;
  };
  network: {
    initial: string | null;
    attachPostCreate: string | null;
    attachPostDeploy: string | null;
  };
}

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
