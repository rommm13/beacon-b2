# Beacon

Beacon is a self-hosted Remote Monitoring & Management (RMM) platform. It runs a lightweight Go agent on managed endpoints (Windows, macOS, Linux), a Cloudflare Workers backend for check-ins and administration, and a Vue 3 dashboard for day-to-day operations.

Platform capabilities are not assumed to be identical. See the
[beta platform support matrix and acceptance checklists](docs/BETA_PLATFORM_SUPPORT.md)
for the current Windows, Linux, and macOS support contract, and
[`docs/BETA_SUPPORT.md`](docs/BETA_SUPPORT.md) for how to report a problem and
diagnose it yourself.

It covers the core of what a commercial RMM product does — device enrollment and approval, policy-based monitoring and alerting, remote shell sessions, scripted automation, Windows patch management, and inventory auditing — without a per-endpoint license fee, running entirely on infrastructure you control.

## Support this project

Beacon is in open beta and maintained by Synertek Cloud Services. If it’s useful to you, sponsorships help fund continued development, maintainer time, and hosting costs. You can use the GitHub Sponsor button on this repository to support its development—thank you.

## Architecture

```
agent/        Go agent — runs on managed endpoints, checks in every 60s
worker/       Cloudflare Worker (Hono + D1) — backend API, cron alert evaluation,
              Durable Object for remote shell/TCP tunnel sessions
dashboard/    Vue 3 + Vite SPA — the admin UI (Cloudflare Pages)
migrations/   D1 SQL migrations
scripts/      Utility scripts (local dev seeding, etc.)
```

Data flow: agents enroll against the Worker API, then check in once a minute with host metrics (disk, CPU, memory, uptime, AV status). The Worker evaluates check-ins against a **policy → monitor** system (see below) and raises alerts. Remote shell/TCP sessions are proxied through a Durable Object so a technician's browser can reach an endpoint with no inbound firewall rule needed.

## B2 architecture (feat/backblaze-b2)

This branch migrates object storage to **Backblaze B2 over the S3-compatible API**. It does **not** use Cloudflare R2 and does **not** require a VPS.

Text diagram:

```
ChatGPT
  -> Cloudflare MCP (tool calls)
    -> Beacon Worker (Cloudflare Workers, Hono + D1 + Durable Objects)
      -> Backblaze B2 (S3-compatible endpoint, bucket objects)
```

Key points:
- The Beacon Worker remains the control plane and API surface.
- File/object payloads are stored in a B2 bucket via the S3-compatible endpoint/region configured for that bucket.
- Secrets/IDs are supplied through Worker secrets or local dev vars; never commit real values. Use `.env.example` (repo root) and `worker/.env.example` as non-secret templates.

### Redeploy from scratch (brief)

1. **Upstream/license:** keep this fork aligned with upstream and preserve AGPL-3.0 licensing.
   - Upstream: https://github.com/synertek-cloud-services/beacon
   - License: keep `LICENSE` (AGPL-3.0) intact; preserve notices when redistributing/modifying.
2. **B2:** create a Backblaze B2 bucket and an application key with the minimum required access; note bucket name, S3 endpoint, and region (example: `eu-central-003`).
3. **Cloudflare:** create/configure the Worker (D1, Durable Objects, bindings as required by Beacon) and the dashboard/Pages project as in the upstream self-hosting flow.
4. **Config:** copy example files locally (do not commit): `worker/wrangler.toml.example` -> `worker/wrangler.toml`, `worker/.dev.vars.example` -> `worker/.dev.vars`, `dashboard/.env.production` as needed; fill placeholders from `.env.example` / `worker/.env.example` with real B2 values via secrets/dev vars.
5. **Database:** apply migrations (`make migrate-local` for local, Wrangler/D1 migration flow for production as per Beacon release process).
6. **Deploy:** deploy Worker and dashboard; verify Worker health and a basic authenticated/API path before enrolling devices.
7. **Validate:** confirm object read/write paths hit B2 (S3 API), and that no R2/VPS dependency is introduced.

## Features

- **Device enrollment & approval** — token-based enrollment, per-company auto-approve or manual review
- **Policy-based monitoring** — global or per-company policies, each made of one or more monitors (disk space, CPU/memory usage, antivirus health, device online/offline, file size, ping reachability/latency/packet-loss, process state, Windows service state, software install/uninstall/version-change)
- **Alerting** — sustained-condition debounce, auto-resolve, email and webhook notification
- **Remote shell & TCP tunnel sessions** — browser-based, no agent-side listening port
- **Web Remote** — zero-install, browser-based remote desktop (no client software or open ports); one-click Elevate for full administrator access, including an on-screen admin tool menu — see [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for what it does and doesn't cover
- **Scripted automation** — reusable components, variables/secrets, one-off and scheduled jobs, and detailed command results
- **Inventory auditing** — full hardware/software/services snapshot on enrollment, every 24h, or on demand
- **Windows patch management** — scan, approve/ignore, policy scheduling, reboot prompts, and optional Windows Update management
- **Multi-company** — companies, contacts, locations, policy/job targeting, Device Groups, and per-company defaults
- **Administration** — local users, Microsoft Entra ID SSO, three-level RBAC, activity logging, branding, and shared dashboards

## Self-hosting

Beacon uses Cloudflare Workers, D1, Durable Objects, R2, and Pages. The complete
production installation, bootstrap, and first-device procedure is in
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).

For local development after copying the example configuration files:

```bash
pnpm --dir worker install --frozen-lockfile
pnpm --dir dashboard install --frozen-lockfile
make migrate-local     # apply migrations to local D1
make dev                # Worker on http://localhost:8787
# In another terminal:
pnpm --dir dashboard dev
```

Leave `VITE_API_URL` unset for local development; Vite proxies `/v1` to the
local Worker. Never commit `worker/wrangler.toml`, `worker/.dev.vars`, deployment
secret files, or `dashboard/.env.production`.

### Optional fictional demo worlds

After migrations, an operator can populate a **fresh** D1 database with a
fictional demo world for evaluation, screenshots, or local development. Demo
worlds are never applied by migrations and do not create users, SSO settings,
real enrollment tokens, or usable agent credentials.

Available worlds: `matrix`, `minecraft`, `holy-grail`, `fallout`, and
`star-trek`. Each provides companies, contacts, mixed endpoint states, inventory,
device groups, custom fields, alerts, and job history.
They intentionally cannot open Remote Shell or TCP sessions because no live
agent is behind a demo endpoint.

```bash
# Seed a fresh local database.
make seed-demo-local WORLD=matrix

# Rebuild the local database from all migrations, then seed it. This destroys
# local D1 data and requires the explicit reset target.
make seed-demo-reset WORLD=minecraft

# Seed a fresh remote database. This refuses a non-empty database and requires
# an explicit acknowledgement; remote reset is deliberately unsupported.
node scripts/seed-demo.mjs --world fallout --remote --allow-remote
```

Run `node scripts/seed-demo.mjs --help` for a custom database binding or local
Wrangler persistence path. Demo packs use lore-inspired names only; they do
not include third-party images, logos, or dialogue excerpts.

### Maintainer release automation

Beacon's own production releases are performed by GitHub Actions after an
approved PR is merged to `main`. The workflow applies D1 migrations, deploys
the Worker, builds/deploys Pages, and checks Worker health in that order. It
requires these one-time GitHub repository settings:

- Secret `CLOUDFLARE_API_TOKEN` — scoped to deploy the Worker and Pages and
  modify the production D1 database.
- Secret `WORKER_WRANGLER_TOML` — the organization-specific
  `worker/wrangler.toml` content, kept out of source control.
- Variable `CLOUDFLARE_PAGES_PROJECT` — the Pages project name.
- Variable `PRODUCTION_WORKER_URL` — the Worker health-check origin.

Disable automatic production Pages deployments in Cloudflare; otherwise Pages
can publish the frontend before its Worker and database changes are released.
Back up and test recovery before enrolling production endpoints; see the
[backup and recovery runbook](docs/BACKUP_RECOVERY.md).

## Database migrations

Migrations live in `migrations/` and are applied through Wrangler/D1; see the
[self-hosting guide](docs/SELF_HOSTING.md) for production setup. The matching
`worker/src/db/schema.ts` definitions are maintained by hand.

## Security notes

- Normal access uses local or Microsoft Entra ID user sessions with `readonly`,
  `technician`, and `admin` roles. `ADMIN_SECRET` remains break-glass bootstrap
  and recovery access; do not use it as an everyday login.
- `CONFIG_ENCRYPTION_KEY` encrypts recoverable configuration secrets. Losing or
  changing it makes existing encrypted SSO, email, and company secrets unreadable.
- The agent-to-Worker enrollment/check-in flow uses per-device tokens, not the admin secret.
- Released agent binaries are Ed25519-signed. Beacon's project release workflow
  publishes the public generic channel; a fresh host can use it without
  building an agent. Self-hosters may instead generate a host-controlled key
  and publish a separately trusted channel. Both paths are documented in the
  [self-hosting guide](docs/SELF_HOSTING.md#10-use-the-upstream-agent-channel).

## License

Beacon is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See `LICENSE`.
