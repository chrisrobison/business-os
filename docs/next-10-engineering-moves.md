# Next 10 Engineering Moves (Priority Order)

## 1) Add authentication + tenant-scoped authorization (non-negotiable)
- Implement auth (JWT/session) and require it for all `/api/*` except health.
- Add role model (`owner/admin/staff/viewer`) and enforce permissions at route layer.
- Bind every request to `tenantId` + `userId` in request context.
- **Definition of done:** unauthenticated requests fail; cross-tenant access is impossible.

## 2) Lock down tenancy boundary at the data layer
- Add explicit tenant checks in repository access (not just host resolution middleware).
- Prevent fallback-to-default-tenant for protected APIs in strict mode.
- Add audit logs for host/domain misses and tenant resolution anomalies.
- **Definition of done:** even if routing/middleware regresses, repository still blocks tenant leakage.

## 3) Build a real automated test suite (start with integration)
- Add `npm test` with Node test runner/Jest/Vitest.
- Priority tests:
  - tenant resolution and strict host behavior
  - CRUD by UUID/public_id
  - module load/migration behavior
  - authz rules per role
- **Definition of done:** CI runs tests on PR; failures block merge.

## 4) Add request validation and schema contracts
- Validate body/query/params for every endpoint (Zod/Ajv).
- Reject unknown/invalid fields and unsafe limits/offsets.
- Version response envelopes for admin/system endpoints.
- **Definition of done:** no route trusts raw `req.body` blindly.

## 5) Add production-grade security middleware
- Helmet, CORS allowlist by env, rate limiting, payload size limits per route.
- Sanitize and normalize headers used for tenancy (`x-forwarded-host` trust policy).
- Add CSRF protections if cookie auth is used.
- **Definition of done:** baseline OWASP API controls are in place.

## 6) Fix scalability hotspots in query patterns
- Push filtering/pagination into SQL (especially module endpoints doing fetch-then-filter).
- Add indexes for frequent filters (`start_at`, `customer_id`, `public_id`, status fields).
- Add cursor pagination for large lists.
- **Definition of done:** no endpoint reads 1000+ rows to filter in JS for normal operations.

## 7) Add observability (logs, metrics, tracing-lite)
- Structured JSON logs with request id, tenant id, user id, latency, status.
- Basic metrics: request count/error rate/p95 latency per route.
- Add health/readiness checks that test DB/connectivity.
- **Definition of done:** you can answer “what broke, for whom, and when” in 5 minutes.

## 8) Introduce migration discipline and schema versioning
- Unify core + module migration tracking with clear ordering and rollback policy.
- Add startup guard: fail fast on pending/broken migrations.
- Add migration smoke test in CI against sqlite + postgres.
- **Definition of done:** schema evolution is deterministic and boring.

## 9) Harden plugin/module execution model
- Define module manifest permissions (entities/events/jobs/routes).
- Validate manifests on load; reject undeclared capabilities.
- Add module-level error isolation and startup diagnostics.
- **Definition of done:** modules can’t quietly do anything they want without declaration.

## 10) Ship deployment + operations baseline
- Add Dockerfile + compose (app + db + optional reverse proxy).
- Add environment profiles (`dev/staging/prod`) and secure defaults.
- Add backup/restore playbook for control DB + tenant DBs.
- **Definition of done:** one-command local spin-up, repeatable staging deploy, documented recovery path.

---

## Recommended execution order
1 → 2 → 3 → 5 → 6 → 7 → 4 → 8 → 9 → 10

Rationale: security and correctness first, then reliability and scale, then platform hardening.
