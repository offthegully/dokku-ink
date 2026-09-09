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

/** Zero-downtime check state from `checks:report`. */
export interface Checks {
  /** Process types with checks turned off entirely ("_all_" = every type). */
  disabled: string[];
  /** Process types whose checks are skipped (deploy proceeds unchecked). */
  skipped: string[];
}

/** Routing facts from `proxy:report` — the layer in front of the containers. */
export interface Proxy {
  type: string | null;
  enabled: boolean | null;
  port: string | null;
  sslPort: string | null;
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
  /** `apps:report` locked — deploys are refused while true. */
  locked: boolean;
  checks: Checks | null;
  proxy: Proxy | null;
  /** `cron:report` task-count — scheduled tasks from app.json. */
  cronTasks: number | null;
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

/** One `resource:limit`/`resource:reserve` entry for a process type. */
export interface ResourceEntry {
  /** Process type, or "_default_" for the app-wide fallback. */
  processType: string;
  limits: Record<string, string>;
  reserves: Record<string, string>;
}

/** Lazily-fetched extras for the per-app drill-in view. */
export interface AppDetail {
  ports: string[];
  storage: string[];
  resources: ResourceEntry[];
  /** Desired formation from `ps:scale` — process type -> quantity. */
  scale: Record<string, number>;
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
