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

4. (Upgrade only) If your database already has existing data and you are upgrading to dual IDs,
run the additive migration/backfill:

```bash
npm run db:migrate:public-ids
```

5. Start server:

```bash
npm run start
```

- API: `http://localhost:3010/api`
- Dashboard: `http://localhost:3010/dashboard`
- User App Runtime: `http://localhost:3010/app`
  - Salon vertical app: `http://localhost:3010/app?app=salon`

App runtime configuration is loaded from `config/apps/*.json` (default: `default.json`).

## Example APIs

- `POST /api/customers`
- `GET /api/invoices?q=acme`
- `POST /api/payments`
- `GET /api/events`
- `GET /api/analytics`
- `POST /api/modules/salon-module/appointments`
- `GET /api/modules/salon-module/dashboard`
- `GET /api/modules/salon-module/calendar?month=2026-03&date=2026-03-10`
- `GET /api/modules/salon-module/clients?q=emma`

## Identifier Model

- Internal identity remains UUID in `id` for all entity relationships.
- Business entities also get a stable, human-facing `public_id` (for example `ORD-100001`).
- Entity routes support either UUID or `public_id`:
  - `GET /api/orders/<uuid>`
  - `GET /api/orders/ORD-100001`

## Developer Docs

- Interface runtime guide: `docs/interface-runtime-guide.md`
