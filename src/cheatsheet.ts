// Curated reference of the most useful Dokku commands, grouped by area.
// Placeholders: <app> = application name, <domain> = hostname, <key> = env var.
// Sourced from https://dokku.com/docs/ — verify flags against your Dokku version.

export interface CheatGroup {
  group: string;
  items: Array<[command: string, description: string]>;
}

export const CHEATSHEET: CheatGroup[] = [
  {
    group: 'Apps',
    items: [
      ['dokku apps:list', 'List all apps'],
      ['dokku apps:create <app>', 'Create a new app'],
      ['dokku apps:destroy <app>', 'Destroy an app (irreversible)'],
      ['dokku apps:report [<app>]', 'Show app metadata (add --format json)'],
      ['dokku apps:rename <old> <new>', 'Rename an app'],
      ['dokku apps:clone <src> <dst>', 'Clone an app to a new one'],
      ['dokku apps:lock <app>', 'Prevent further deploys'],
      ['dokku apps:unlock <app>', 'Allow deploys again'],
    ],
  },
  {
    group: 'Deploy & Git',
    items: [
      ['git remote add dokku dokku@HOST:<app>', 'Add the deploy remote (run locally)'],
      ['git push dokku main', 'Deploy by pushing your branch'],
      ['dokku git:sync <app> <repo-url>', 'Pull code from a remote repo'],
      ['dokku git:from-image <app> <image>', 'Deploy from a Docker image'],
      ['dokku git:set <app> deploy-branch <br>', 'Change the deploy branch'],
      ['dokku ps:rebuild <app>', 'Rebuild from the current source'],
      ['dokku build-env:set <app> <k>=<v>', 'Set a build-time env var'],
    ],
  },
  {
    group: 'Process & Scale',
    items: [
      ['dokku ps:report [<app>]', 'Process status (add --format json)'],
      ['dokku ps:scale <app> web=3 worker=1', 'Set process scale'],
      ['dokku ps:restart <app>', 'Restart all processes'],
      ['dokku ps:stop <app>', 'Stop the app'],
      ['dokku ps:start <app>', 'Start the app'],
      ['dokku ps:rebuild <app>', 'Rebuild and redeploy'],
      ['dokku ps:set <app> restart-policy <p>', 'e.g. on-failure:10, always'],
    ],
  },
  {
    group: 'Domains',
    items: [
      ['dokku domains:report [<app>]', 'Show vhosts (add --format json)'],
      ['dokku domains:add <app> <domain>', 'Add a domain to an app'],
      ['dokku domains:remove <app> <domain>', 'Remove a domain'],
      ['dokku domains:set <app> <domain>...', 'Replace all domains'],
      ['dokku domains:clear <app>', 'Remove all app domains'],
      ['dokku domains:add-global <domain>', 'Add a server-wide domain'],
      ['dokku domains:enable <app>', 'Enable vhost-based routing'],
    ],
  },
  {
    group: "SSL / Let's Encrypt",
    items: [
      ['dokku letsencrypt:set <app> email <e>', 'Set the ACME contact email'],
      ['dokku letsencrypt:enable <app>', 'Issue + enable a certificate'],
      ['dokku letsencrypt:auto-renew <app>', 'Renew now'],
      ['dokku letsencrypt:cron-job --add', 'Schedule automatic renewals'],
      ['dokku letsencrypt:list', 'List certs and expiry'],
      ['dokku certs:report [<app>]', 'Show SSL details (add --format json)'],
      ['dokku certs:add <app> CRT KEY', 'Install a manual certificate'],
    ],
  },
  {
    group: 'Config & Env',
    items: [
      ['dokku config:show <app>', 'Show env vars (add --format json)'],
      ['dokku config:get <app> <key>', 'Print one variable'],
      ['dokku config:set <app> <k>=<v>', 'Set var(s) and restart'],
      ['dokku config:set --no-restart <app> K=V', 'Set without restart'],
      ['dokku config:unset <app> <key>', 'Remove a variable'],
      ['dokku config:export <app>', 'Export as shell/env/json'],
    ],
  },
  {
    group: 'Logs & Inspect',
    items: [
      ['dokku logs <app> -t', 'Tail application logs'],
      ['dokku logs <app> -n 200', 'Last 200 log lines'],
      ['dokku logs <app> --ps web', 'Logs for one process type'],
      ['dokku enter <app> web', 'Shell into a running container'],
      ['dokku run <app> <cmd>', 'Run a one-off command'],
      ['dokku inspect <app>', 'Low-level docker inspect'],
      ['dokku nginx:show-config <app>', 'Show generated proxy config'],
    ],
  },
  {
    group: 'Datastores (plugins)',
    items: [
      ['dokku postgres:create <svc>', 'Create a Postgres service'],
      ['dokku postgres:link <svc> <app>', 'Link service -> app (DATABASE_URL)'],
      ['dokku postgres:list', 'List Postgres services'],
      ['dokku postgres:export <svc> > db.dump', 'Back up a database'],
      ['dokku redis:create <svc>', 'Create a Redis service'],
      ['dokku redis:link <svc> <app>', 'Link Redis to an app'],
      ['dokku mysql:create <svc>', 'Create a MySQL service'],
    ],
  },
  {
    group: 'Storage & Networking',
    items: [
      ['dokku storage:mount <app> /host:/path', 'Mount a persistent volume'],
      ['dokku storage:list <app>', 'List mounts'],
      ['dokku ports:set <app> http:80:5000', 'Map proxy port -> container port'],
      ['dokku ports:report <app>', 'Show port mappings'],
      ['dokku proxy:report <app>', 'Show proxy status'],
      ['dokku network:report <app>', 'Show network attachments'],
    ],
  },
  {
    group: 'Plugins & Maintenance',
    items: [
      ['dokku plugin:list', 'List installed plugins'],
      ['sudo dokku plugin:install <git-url>', 'Install a plugin'],
      ['sudo dokku plugin:update <name>', 'Update a plugin'],
      ['dokku version', 'Show Dokku version'],
      ['dokku cleanup', 'Remove stale containers/images'],
      ['dokku ps:report --format json', 'Machine-readable status for scripts'],
      ['dokku maintenance:enable <app>', 'Serve a maintenance page'],
    ],
  },
];
