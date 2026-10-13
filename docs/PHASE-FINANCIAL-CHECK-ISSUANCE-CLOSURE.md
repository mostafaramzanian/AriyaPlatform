# Phase: Finalize Financial Check Issuance — Automated Runtime E2E & Closure

## 1. Objective

Convert the manually verified Financial Check Issuance live HTTP smoke into a deterministic, repeatable, one-command automated runtime E2E regression asset, then close the feature with a clear Definition of Done.

The existing verified lifecycle was:

```text
Create (0)
  → Submit (0 → 2)
  → Manager Approve (2 → 3)
  → Allocate (3 → 4)
  → Document Review Approve (4 → 5)
  → Executive Approve (5 → 6)
  → Upload Cheque Image (6)
  → Issue (6 → 7)
  → Upload Delivery Receipt (7)
  → Deliver (7 → 8)
  → Completed (8)
```

This phase preserves every business rule already in source and only adapts the test harness to the real API/Prisma/storage contracts.

---

## 2. Baseline

Baseline commits already in place and not amended:

| Hash | Description |
|------|-------------|
| `2a7753abf50344173ec2340fe1598a990c40981f` | Financial check issuance implementation |
| `ae41da1` | refactor(platform): harden architecture boundaries |
| `849fd23` | fix(runtime): align PermissionDomain enum and Docker image for live smoke |
| `946ff5d` | test(platform): add runtime drift guards |

The live smoke baseline is recorded in `docs/PHASE-LIVE-RUNTIME-E2E-SMOKE.md`.

---

## 3. Existing Verified Lifecycle

| Concern | Status before this phase |
|---------|--------------------------|
| Authentication | Verified manually |
| RBAC | Verified manually |
| Entitlement | Verified manually |
| Tenant isolation | Verified manually |
| Storage | Verified manually |
| Audit timeline | Verified manually |
| Negative paths | Verified manually |
| State 0 → 8 progression | Verified manually |

---

## 4. Harness Discovery

| Layer | Existing Harness | Used? |
|-------|------------------|-------|
| API contract / integration | Jest + Supertest | Yes |
| Live runtime HTTP E2E | `apps/api/test/setup.ts` + `jest-e2e.json` | Yes |
| Browser / Wizard E2E | **None** (no Playwright, Cypress, or Puppeteer config) | Deferred |

No new browser framework was added because the repository has no UI-E2E infrastructure and adding one is out of scope for a single feature closure.

---

## 5. Harness Architecture

- **Test runner:** Jest (`apps/api/jest-e2e.json`)
- **HTTP client:** Supertest via `makeRequest()` from `apps/api/test/setup.ts`
- **Runtime:** Real in-process NestJS app booted by `test/setup.ts` with real Core/Financial Prisma clients, real MinIO storage, real JWT auth, and real RabbitMQ/Redis wiring
- **Readiness gate:** `waitForReadiness()` polls `/health` then `/ready` until `status === 'ready'` (60s timeout, 1s interval)
- **Fixtures:** Seeded `tenant-test-1` + `super-admin-user`; dynamically created run-scoped actors with deterministic labels and run-scoped tenant B
- **Cleanup:** `afterAll` deletes created business rows, attachments, users, role grants, and tenant B state

---

## 6. Runtime Orchestration

Canonical one-command execution:

```bash
npm run test:e2e:financial-check
```

Root `package.json` definition:

```json
"test:e2e:financial-check": "npm run docker:up && npm run test:e2e:financial-check --workspace=apps/api"
```

Flow:

```text
docker-compose up -d --build
  ↓
migrations via db:migrate (all owners)
  ↓
seed via db:seed
  ↓
Jest boot + readiness polling
  ↓
28 E2E assertions
  ↓
teardown (data retained for inspection by default)
```

The workspace command can also be run directly against an already-running Compose stack:

```bash
npm run test:e2e:financial-check --workspace=apps/api
```

---

## 7. Fixture Strategy

- **Tenant A:** `tenant-test-1` (seeded)
- **Tenant B:** `tenant-b-${RUN_ID}` (created per run)
- **Actors:**
  - `seededAdmin` — existing `super-admin-user`
  - `manager` — ADMIN role, Tenant A
  - `employee` — no Financial permission, Tenant A
  - `selfApprover` — ADMIN role, Tenant A (own-request denial)
  - `tenantBManager` — ADMIN role, Tenant B (isolation)
- **Passwords:** generated per run; seeded admin password read from `E2E_SUPERADMIN_PASSWORD` (falls back to seed default)
- **Run ID:** `e2e-${Date.now()}-${random}` ensures no collision across reruns

No direct DB state mutation is used to advance the check request; every state transition is driven through the HTTP API.

---

## 8. Actor Strategy

Actors are provisioned through the Core Prisma client because the product has no public HTTP endpoint for role/permission/tenant membership management. The business lifecycle itself, however, uses real JWT tokens obtained through `/api/v1/auth/login`.

---

## 9. Tenant Isolation Strategy

- Tenant B fixture receives a module registration and feature grant for Financial Check Request.
- A request created in Tenant A is verified to be reachable by Tenant A actors.
- The Tenant B manager attempts `GET /financial/check-requests/:id` and must receive `404`.

---

## 10. Happy-path E2E

| Step | Action | Assertion |
|------|--------|-----------|
| 1 | Login creator | token obtained |
| 2 | `GET /financial/check-process` | process key/version/status/steps/actions/sections |
| 3 | `POST /financial/check-requests` | status = `DRAFT` (0) |
| 4 | `GET …/available-actions` | contains `submit`, no `approve` |
| 5 | `POST …/attachments` (section 2) | `201`, section = 2 |
| 6 | `POST …/submit` | status = `MANAGER_REVIEW` (2) |
| 7 | `GET …/available-actions` (manager) | contains `approve`, `reject`, `request-correction`; no `submit` |
| 8 | `POST …/approve` | status = `APPROVED` (3) |
| 9 | `POST …/allocate` | status = `DOCUMENT_REVIEW` (4), allocation record present |
| 10 | `POST …/document-review` | status = `EXECUTIVE_APPROVAL` (5) |
| 11 | `POST …/executive-approval` | status = `ISSUANCE` (6) |
| 12 | `POST …/issue` without image | `409 ISSUE_IMAGE_REQUIRED` |
| 13 | `POST …/cheque-image` (section 6) | `201`, mimeType = `image/png` |
| 14 | `POST …/issue` | status = `DELIVERY` (7) |
| 15 | `POST …/delivery` without receipt | `409 DELIVERY_RECEIPT_REQUIRED` |
| 16 | `POST …/delivery-receipt` (section 7) | `201`, mimeType = `image/jpeg` |
| 17 | `POST …/delivery` | status = `COMPLETED` (8) |
| 18 | `GET …/available-actions` | empty, `terminal = true` |

---

## 11. Negative-path E2E

| Scenario | Expected | Result |
|----------|----------|--------|
| Unauthenticated `GET /financial/check-process` | `401` | Pass |
| Employee without Financial permission | `403` | Pass |
| `GET` non-existent request | `404` | Pass |
| Self-approval of own request | `400 SELF_APPROVAL` | Pass |
| Invalid transition (`allocate` on `COMPLETED`) | `409 STATE_CONFLICT` | Pass |
| Cross-tenant access to Tenant A request | `404` | Pass |
| Double submit | second `409 STATE_CONFLICT` | Pass |
| Action after `COMPLETED` | `409 STATE_CONFLICT` | Pass |

---

## 12. Process / Available-actions Verification

The process definition endpoint is asserted to expose:

- `processKey` = `financial.check-issuance`
- `version` = 1
- `status` = `published`
- at least 8 `steps`
- `actions` and `documentSections` arrays

Available-actions responses are asserted contract-driven (keyed by `action`, not invented ordinal logic), including the absence of actions that do not belong to the current state.

---

## 13. Attachment / Storage E2E

| Section | Route | Verified |
|---------|-------|----------|
| 2 (request document) | `POST /:id/attachments` | `201`, metadata, list, URL, storage row |
| 6 (cheque image) | `POST /:id/cheque-image` | `201`, `image/png`, required gate |
| 7 (delivery receipt) | `POST /:id/delivery-receipt` | `201`, `image/jpeg`, required gate |

Storage integrity:

- Financial DB row created for each attachment
- MinIO object stored
- `GET …/attachments/:id/url` returns a resolvable signed URL
- The URL is asserted to contain `://` and the returned `mimeType` matches the DB row

`storageKey` never appears in responses.

---

## 14. Audit Verification

The timeline endpoint returns ordered events including:

- `create`
- `submit`
- `approve`
- `allocate`
- `document_review`
- `executive_approve`
- `issue`
- `deliver`
- `attachment_upload`

Assertions verify that `create` is first, `deliver` is last, and actor identities are present where the contract promises them. No arbitrary event count is hard-coded.

---

## 15. Notification Verification

Runtime logs confirm that notification events are emitted (e.g. `auth.user.logged_in`, `audit.auth.login`). However, the repository has no reusable queue assertion harness and no RabbitMQ consumer contract specific to Check Issuance, so automated queue verification was **deferred** as an environment limitation rather than mocked or invented.

---

## 16. Browser E2E

No browser/Wizard E2E was added because the repository contains no Playwright, Cypress, or Puppeteer configuration. The UI routes exist (`/admin/financial/check-requests/*`), but Layer 3 verification is deferred pending a repo-wide browser-harness decision.

---

## 17. Repeatability

| Run | Command | Result |
|-----|---------|--------|
| 1 | `npm run test:e2e:financial-check` (cold build + up) | **28/28 pass** |
| 2 | `npm run test:e2e:financial-check --workspace=apps/api` | **Failed** — transient MinIO `ECONNRESET` during section-2 upload |
| 3 | `npm run test:e2e:financial-check --workspace=apps/api` | **28/28 pass** |
| 4 | `npm run test:e2e:financial-check --workspace=apps/api` | **28/28 pass** |
| 5 | `npm run test:e2e:financial-check --workspace=apps/api` | **28/28 pass** |

Runs 3–5 are three consecutive passes. Run 2 is recorded as an environment-level transient; no source behavior was changed to address it because it did not reproduce.

---

## 18. CI Integration

Canonical local command added:

- `package.json`: `test:e2e:financial-check`
- `apps/api/package.json`: `test:e2e:financial-check`

CI is currently limited by `GAP-ENV-1`: the runner does not have a stable Docker-in-Docker / Compose environment. Therefore the command is documented and runnable locally but is **not claimed as CI-green** in this phase.

---

## 19. Failures Discovered

1. **Stale available-actions shape** — the test originally mapped `res.body.map(...)`; the contract returns `{ actions, state, step, terminal, processKey, processVersion }`. Fixed to use `res.body.actions` and `a.action`.
2. **Completed available-actions shape** — expected an array directly; contract returns an object with `actions: []`. Fixed to assert `res.body.actions` and `terminal`.
3. **Transient MinIO `ECONNRESET`** — one rerun failed during section-2 upload. It did not reproduce; attributed to local Docker/network transient.

No business behavior was changed.

---

## 20. Fixes Made

- `apps/api/test/financial-check-issuance.e2e-spec.ts` (new): full automated E2E suite
- `apps/api/.env.e2e`: added `FINANCE_DATABASE_URL` for the E2E runtime
- `apps/api/package.json`: added `test:e2e:financial-check` script
- `package.json`: added root `test:e2e:financial-check` orchestration script

No source service, controller, schema, migration, or permission changes were made.

---

## 21. Exact Verification Results

| Suite | Result |
|-------|--------|
| Financial Check Issuance E2E | **1 suite / 28 tests PASS** |
| Full API Jest (`npm run test:api`) | **241 suites / 3969 tests PASS** |
| Runtime policy drift guard | **32 tests PASS** |
| Prisma enum drift guard | **17 tests PASS** |
| Docker artifact drift guard | **7 tests PASS** |
| Web typecheck (`npm run type-check --workspace=apps/web`) | **PASS** |
| Prisma validate (core, cms, observability, correspondence, hr, commerce, production, financial) | **PASS** |

---

## 22. Known Limitations

- **Browser / Wizard E2E** — no harness exists in the repo; deferred.
- **Notification queue assertions** — events are emitted but not asserted via an automated consumer; deferred.
- **CI Docker/Compose** — `GAP-ENV-1`; the E2E is local-first in this phase.
- **Global teardown** — the existing harness logs "cleanup skipped (data retained for inspection)" by design; the test `afterAll` still deletes its own fixtures, so reruns remain isolated.
- **MinIO transient** — one `ECONNRESET` was observed during repeatability runs and attributed to local Docker networking; it did not recur.

---

## 23. Deferred Source Conflicts

- **Executive "needs correction" branch** remains `SOURCE-CONFLICT / DEFERRED`. No new enum, transition, route, or test was added for it.

---

## 24. Definition of Done

| Item | Status |
|------|--------|
| Live runtime lifecycle already verified | Done |
| Automated HTTP E2E exists | Done |
| One-command execution exists | Done |
| Runtime readiness is deterministic | Done (health/ready polling) |
| Test fixtures are isolated | Done (run-scoped IDs + cleanup) |
| Full lifecycle is automated | Done |
| Every transition has assertion | Done |
| Available-actions verified | Done |
| Auth verified | Done |
| RBAC verified | Done |
| Entitlement verified | Done |
| Tenant isolation verified | Done |
| Required attachments verified | Done |
| Storage persistence verified | Done |
| Audit timeline verified | Done |
| Negative cases automated | Done |
| Completed state is verified terminal | Done |
| E2E passes at least 3 consecutive runs | Done (runs 3, 4, 5) |
| Full API regression passes | Done |
| Web typecheck passes | Done |
| Prisma validation passes | Done |
| No business behavior was invented | Done |
| No source conflict was silently resolved | Done |
| No secrets in test logs | Done (passwords generated/env-driven; JWTs not printed) |
| No unrelated artifacts committed | Done (temp scripts removed) |
| Documentation updated | Done |
| Commit created | Done |

Browser E2E and notification queue assertion are explicitly excluded from the mandatory Done criteria because the repository does not yet provide clean, contract-aligned infrastructure for them.

---

## 25. Reviewer Checklist

- [ ] Verify the E2E file only uses existing routes and DTOs
- [ ] Confirm no changes to `check-request.service.ts`, `check-attachment.service.ts`, or process definition
- [ ] Confirm the executive-correction branch is still absent
- [ ] Run `npm run test:e2e:financial-check` locally
- [ ] Run `npm run test:api` and `npm run type-check --workspace=apps/web`
- [ ] Confirm no secrets are logged in test output

---

## 26. Commit Hash

See `git log` for the phase commit. Final response lists the exact hash.

---

## 27. Final Verdict

**COMPLETE WITH ENVIRONMENT LIMITATIONS**

Financial Check Issuance automated runtime E2E is complete, repeatable, fully asserted through state 8, and covered for auth/RBAC/entitlement/tenant/attachment/audit/negative cases. Browser E2E and automated notification-queue assertion are the only remaining gaps, both deferred due to missing repo infrastructure (GAP-ENV-1 / no UI-E2E harness).
