# PHASE — FINAL COMMERCE STABILIZATION

Verification/regression phase only. No feature code, no contract changes, no
schema changes. Companion to `docs/PHASE-GAP-ENV-1-IMPLEMENTATION.md`.

## Scope

Regression + boundary audit across C1–C9, GAP-8, GAP-9, GAP-ENV-1, Commerce UI,
tenant isolation, and platform boundaries — before freezing Commerce and
starting Reporting architecture.

## Versions/checkpoints reviewed

| Checkpoint | Content |
|---|---|
| `7ee3584` | C1R–C9 backend surfaces + migrations |
| `bb6380d` | Commerce admin UI + shared api client |
| `f1091cb` | Phase docs + GAP-ENV preflight |
| `7b32d56` | GAP-ENV-1 deployment contract remediation |
| `a40d36a` | GAP-ENV-1 validation ledger |

Stabilization ran at `a40d36a` + this report commit.

## Contract inventory

| Surface | Owner module | Public surface | Persistence | Authorization | Tenant | Verification |
|---|---|---|---|---|---|---|
| Purchase CRUD/submit | `commerce/purchase` | `/api/v1/commerce/purchase-documents` | commerce_db | module guard + permission | tenantId predicate on every query | unit + e2e green |
| Completion / CLOSED | `commerce/completion` | `…/completion-policies`, doc transitions | commerce_db | guard | tenant-scoped | 401 live, unit/e2e green |
| Payment / receiving / returns | `commerce/{payment,receiving,returns}` | `…/payments`, `…/receipts`, `…/returns` | commerce_db | guards | tenant-scoped | e2e 404-for-foreign green |
| Workflow defs/execution/decisions/pending/cancel | `commerce/workflow` | `…/workflow-definitions|instances|pending-decisions` | commerce_db | guard | tenant-scoped | green |
| Line routing (version pin) | `commerce/workflow` | `…/routing-versions` | commerce_db | guard | tenant-scoped, composite FK | green |
| Commercial groups/config/lifecycle/approvals/workspace | `commerce/commercial` | `…/commercial-*` | commerce_db | guard | tenant-scoped | green |
| Identity | `CommerceIdentityGateway` → Core directory/member | opaque platform user IDs | none (port) | membership validated per request | tenant member scope | GAP-8 e2e green |
| Tenant | tenant resolver → Core | tenant context | none (port) | — | — | tenant suite green |
| Audit | `CommerceAuditGateway` → Core audit | read timeline + emit | core audit DB (read via port) | entitlement | tenant | C6/C7 green |
| Search | `SEARCH_SOURCE` port (C9) → platform `GET /search` | projection out | core search index | entitlement | tenant | C8/C9 e2e green |
| Notifications | `CommerceNotificationGateway` → Core NotificationService | GAP-9 events | core notifications | tenant-matched | tenant | GAP-9 e2e green |
| Entitlement | module-entitlement guard | gate on `commerce` module | core entitlement | entitlement check | tenant | runtime e2e green |
| Deployment | GAP-ENV-1 | `dist/main.js`, healthchecks, nginx | — | — | — | live verified |

## API regression results

- `src/modules/commerce`: **47 suites / 726 tests — all pass**
- Contract suites: architecture-boundaries 24, runtime-policy 32,
  env.validation 17, tenant unit (4 files) 25 → **7 suites / 98 tests — all pass**
- Failures: none. Skipped: none observed.

## E2E regression results

`jest-e2e.json` (wired globalSetup → six-owner `db:migrate` + `db:seed`,
dbproxy `localhost:5544`):

- commerce-lifecycle 41, commerce-integration, commerce-tenant 26,
  commerce-gap8-identity, commerce-gap9-notifications, commerce-search,
  commerce-search-source, seed-conformance 6, module-entitlement-runtime
- **9 suites / 142 tests — all pass** (real DB, real tenant resolution, real
  notification path, real search-source projection).

## Tenant/authorization sweep

- Every Commerce file touching Prisma carries tenant predicates (grep sweep).
- Isolation spec (34) encodes per-repository tenant requirements — green.
- Identity (opaque platform ID) / membership (tenant-scoped validation) /
  authorization (permission checks) remain distinct; requester, liaison,
  approver, assignee, recipient all validated through the identity gateway —
  none treated as authorization alone (GAP-8 tests green).
- Foreign access answered 404 (indistinguishable), never cross-tenant reads.

## Platform boundary sweep

Commerce imports nothing outside its module except `express`, `fs`,
`node:crypto`, `path`. No `core-client`, no CorePrisma, no cross-module source
imports — all platform integration is via in-module gateway ports.
architecture-boundaries + commerce-isolation green.

## Migration/data consistency

`prisma migrate status` (via dbproxy): core 47, cms 1, correspondence 1, hr 11,
commerce 12 — **all "Database schema is up to date!"**. No missing migration,
no ordering conflict, seed conformance green (idempotent double-run).

## Deployment regression

Live stack (fresh `erp-api`/`erp-web` images):
`/api/v1/health|ready|live` → 200; commerce routes → 401 (present);
JWKS → 200; edge `/health`, `/api/v1/health`, `/admin/commerce/*` → 200;
ready reports `runtime: combined`, all required datasources up.
Artifact `dist/` contains `commerce/{completion,search,pending,workflow}`,
`platform/search-source`. `/api/v1/commerce/search` → 404 is correct by design
(search is inbound-only via the platform `GET /search` port; no commerce HTTP
search route exists).

## Frontend regression

**21 suites / 300 tests — all pass** (commerce components, commerce-api lib,
decimals/labels, notifications api/views/bell, member picker, workflow editor).
One React `act()` console warning in `CoreNotificationsView` spec —
pre-existing test-harness cosmetic, not a failure.

## CI verification

`.github/workflows/ci.yml` references only real scripts: `npm ci`,
`prisma:generate`, `tsc --noEmit`, jest contract + commerce suites,
`nest build`, web `type-check`/`test`/`build`. No e2e/Docker claims.
Local-vs-CI: e2e and image builds intentionally local-only (need compose DBs).

## Artifact/worktree hygiene

| Item | Decision |
|---|---|
| `apps/web/phaseui{3,4,5}-{shots,visual-qa.mjs,qa-dataprep.mjs}` | user-owned QA evidence — keep untracked |
| `apps/web/next-env.d.ts`, `tsconfig.tsbuildinfo` | generated — safe to leave untracked |
| `backups/` | user-owned local — keep untracked |
| `secrets/` | user-owned secrets — now gitignored |
| tracked tree | clean |

## Residual findings register

| Item | Class |
|---|---|
| Quotation (C5/GAP-6) | DEFERRED BY CONTRACT — awaiting authoritative contract |
| Platform revocation feed (`platform.revocation@v1`, ttl-bound-only 300s) | DEFERRED BY CONTRACT — ADR-0006 defers to phase 3B |
| HS256 token posture (asymmetric keys unset) | INTENTIONAL LIMITATION — dev/dev-compose posture |
| Observability persistence (client pruned; `OBSERVABILITY_ENABLED=false` default) | INTENTIONAL LIMITATION — requires explicit image variant |
| Swagger off unless `ENABLE_SWAGGER` | INTENTIONAL LIMITATION |
| TLS termination external (no certs in repo; port 443 unpublished) | INTENTIONAL LIMITATION — documented |
| Host `:5433` answered by an unrelated postgres on this workstation | ENVIRONMENT-LOCAL — host path is the declared dbproxy `:5544` |
| `apps/api/.env` lacks `OBSERVABILITY_DATABASE_URL` | ENVIRONMENT-LOCAL — `.env.e2e`/compose carry it; documented contract |
| Mailpit container name has generated prefix after recreate | ENVIRONMENT-LOCAL cosmetic; alias `mailpit` resolves correctly |
| `act()` warning in `CoreNotificationsView` spec | ENVIRONMENT-LOCAL test-harness warning, pre-existing |
| Regressions | NONE |
| Blockers | NONE |

## Deferred/contract-blocked items

- **Quotation / GAP-6** — blocked pending an authoritative contract; explicitly
  out of scope, not a defect.
- **Platform revocation feed, asymmetric key material, observability
  persistence** — future platform work outside Commerce ownership.

## Stabilization decision

**STABILIZED-WITH-LOCAL-NONBLOCKERS**

All contract surfaces green, fresh deployment exposes the current artifact,
tenant/authorization/boundary sweeps clean, no regressions or blockers.
Remaining items are deferred-by-contract or workstation-local.

## Final verification ledger

| Gate | Result |
|---|---|
| Commerce unit | 47 suites / 726 tests pass |
| Contract suites | 7 suites / 98 tests pass |
| Commerce e2e matrix | 9 suites / 142 tests pass |
| Web Commerce regression | 21 suites / 300 tests pass |
| API/web type-check + builds | pass |
| Fresh deployment probes | all green |
| Tenant/boundary/migration sweeps | clean |
| Git | tracked tree clean; no secrets tracked |
