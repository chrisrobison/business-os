# Business OS (Foundation)

Modular, API-first business operating system with a reusable kernel and dynamically loaded modules.

## What is included

- Core kernel (`/core`) with:
  - universal business entity CRUD/search APIs
  - event bus with publish/subscribe
  - plugin loader
  - modular data connector abstraction
- Plugin examples (`/modules`):
  - `salon-module` (appointment scheduling + calendar + appointment events)
  - `example-module` (minimal reference plugin)
- Responsive dashboard (`/ui/dashboard`) with dynamic module panels
- User app runtime (`/ui/app`) driven by app-definition JSON and component hooks

## Data Connector Switching

The app uses a connector factory. Set `DB_CLIENT` to switch backend:

- `DB_CLIENT=mysql`
- `DB_CLIENT=postgres`
- `DB_CLIENT=sqlite` (uses `DB_FILE`, defaults to `./data/business-os.sqlite`)

Both connectors expose the same interface used by the kernel and modules.

## Authentication + Authorization

- All `/api/*` endpoints require `Authorization: Bearer <jwt>` except:
  - `/health`
  - `/ready`
  - `POST /api/auth/login`
- Role model: `owner`, `admin`, `staff`, `viewer`
- Admin tenancy endpoints (`/api/admin/tenancy/*`) require `owner` or `admin`.
- Entity mutation endpoints (`POST/PUT/DELETE` under `/api/*` entity routes) require `owner`, `admin`, or `staff`.

Auth env vars:

- `AUTH_JWT_SECRET` (required, 32+ chars)
- `AUTH_TOKEN_TTL_SECONDS` (default `28800`, 8 hours)

Security env vars:

- `TRUST_PROXY` (`false` by default)
- `TENANCY_TRUST_FORWARDED_HOST` (`false` by default)
- `CORS_ALLOWLIST` (comma-separated origins; empty means allow all origins)
- `RATE_LIMIT_WINDOW_MS` (default `60000`)
- `RATE_LIMIT_MAX` (default `300`)
- `API_BODY_LIMIT` (default `1mb`)
- `AUTH_BODY_LIMIT` (default `32kb`)

## Multi-Tenant (One DB Per Tenant)

- A separate control-plane DB stores tenancy metadata:
  - `customers`
  - `instances` (each instance has its own DB connection config)
  - `instance_domains` (indexed host/domain lookup per request)
- Every request resolves tenant by `Host` header + derived domain.
- Each tenant instance points to its own database (SQLite file, MySQL DB, or Postgres DB).
- Unknown host/domain mappings are rejected when `TENANCY_STRICT_HOST_MATCH=true`.

Control-plane env vars:

- `CONTROL_DB_CLIENT`
- `CONTROL_DB_HOST`
- `CONTROL_DB_PORT`
- `CONTROL_DB_USER`
- `CONTROL_DB_PASSWORD`
- `CONTROL_DB_NAME`
- `CONTROL_DB_FILE`
- `TENANCY_BOOTSTRAP_HOST` (default `localhost`)
- `TENANCY_BOOTSTRAP_DOMAIN` (default `localhost`)

## Run

1. Copy `.env.example` to `.env` and set DB credentials.
   For SQLite local dev, set `DB_CLIENT=sqlite`.
2. Install dependencies:

```bash
npm install
```

3. Initialize schema:

```bash
npm run db:init
```

4. Create first owner login identity (required before using authenticated APIs):

```bash
npm run auth:create-owner -- --email owner@example.com --password 'change-this-password' --name 'Owner User'
```

5. (Upgrade only) If your database already has existing data and you are upgrading to dual IDs,
run the additive migration/backfill:

```bash
npm run db:migrate:public-ids
```

6. Start server:

```bash
npm run start
```

- API: `http://localhost:3010/api`
- Readiness: `http://localhost:3010/ready`
- Dashboard: `http://localhost:3010/dashboard`
- Tenancy Admin: `http://localhost:3010/admin`
- User App Runtime: `http://localhost:3010/app`
  - Salon vertical app: `http://localhost:3010/app?app=salon`

App runtime configuration is loaded from `config/apps/*.json` (default: `default.json`).

## Example APIs

- `POST /api/auth/login` with `{ "email": "...", "password": "..." }`
- `GET /api/auth/me`
- `POST /api/customers`
- `GET /api/invoices?q=acme`
- `POST /api/payments`
- `GET /api/events`
- `GET /api/analytics`
- `POST /api/modules/salon-module/appointments`
- `GET /api/modules/salon-module/dashboard`
- `GET /api/modules/salon-module/calendar?month=2026-03&date=2026-03-10`
- `GET /api/modules/salon-module/clients?q=emma`
- `GET /api/system/metrics`

Tenancy admin APIs:

- `GET /api/admin/tenancy/summary`
- `GET /api/admin/tenancy/customers`
- `POST /api/admin/tenancy/customers`
- `GET /api/admin/tenancy/instances`
- `POST /api/admin/tenancy/instances`
- `GET /api/admin/tenancy/domains`
- `POST /api/admin/tenancy/domains`

## Identifier Model

- Internal identity remains UUID in `id` for all entity relationships.
- Business entities also get a stable, human-facing `public_id` (for example `ORD-100001`).
- Entity routes support either UUID or `public_id`:
  - `GET /api/orders/<uuid>`
  - `GET /api/orders/ORD-100001`

## Developer Docs

- Interface runtime guide: `docs/interface-runtime-guide.md`
- Backup and restore playbook: `docs/backup-restore-playbook.md`

## Testing

```bash
npm test
npm run test:migrations
```

## Docker

```bash
docker compose up --build
```

Optional reverse proxy profile:

```bash
docker compose --profile proxy up --build
```
