# PHASE PRODUCTION-BOM-HEADER — IMPLEMENTATION

The first executable slice of **Production → BOM**: the **BOM Header**, with an isolated
persistence boundary, tenant isolation, authorization, an approver snapshot, a lifecycle and
audit. This document is the report of what was actually built, what was deliberately not
built, and how each claim is falsified.

Companion documents (read, not modified): `PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md`,
`PHASE-PRODUCTION-BOM-CONTRACT-CLOSURE.md`,
`PHASE-PRODUCTION-BOM-M1-M7-DECISION-CLOSURE.md`,
`PHASE-PRODUCTION-BOM-FINAL-DECISION-CLOSURE.md`.

---

## 1. Scope

**Goal.** Deliver the first vertical slice of the Production bounded context — a BOM Header
that can be authored, routed, decided, read and audited — as a real, bootable, permission-
gated, entitlement-gated, tenant-isolated API surface with its own database.

**In scope.**

* A new bounded context (`Production`) registered in the COMBINED composition root only.
* Its own Prisma project, database (`production_db`), migration history and generated client.
* The `BomHeader` aggregate: create, list, read, edit-while-draft, submit, and the three
  decision acts (approve / reject / request-correction).
* Three permissions, one module registration, one feature and one feature grant — all seeded
  in Core's own migration history.
* Audit through the platform's ONE trail (`AUDIT_PORT`), never a module-local table.
* Identity verification (`USER_DIRECTORY`) for the requester and the approver.
* Tests: 10 new suites, 102 new tests.

**Out of scope, by decision** (see §14): BOM **items**, BOM **code generation**, Project and
Product Tree (which do not exist), supplier/purchase consumption, notifications, search,
workflow engine, any frontend screen, and any change to Commerce, HR or Correspondence.

**Definition of done.** `tsc --noEmit` clean; the full unit suite green; the four Core
migrations applied to a live `core_db` and the Production baseline applied to a live
`production_db`; `prisma migrate diff` reporting no drift between the live database and
`schema.prisma`.

---

## 2. Ownership statement (required)

This phase implements, and must not be read as widening, the ownership map the final decision
closure fixed. Stated verbatim:

```
Production   OWNS :  BOM (header + items) · BOM lifecycle · BOM approval state
                     · BOM code ALLOCATION MECHANISM (not the prefix value)
Production   REFERENCES (opaque, tenant-safe, read-only):
                     Project · Product Tree · User identity · Supplier · Purchase · future Quality
Production   OWNS NOTHING OF:  Project master · Product Tree master (or its code)
                     · Supplier master · Procurement lifecycle · Quality subsystem
```

**What this phase adds to that map, and only this:** the `BomHeader` row, the `BomStatus`
lifecycle, the recorded approver decision, and the per-tenant `production` / `bom`
entitlement. The **items** half of "BOM (header + items)" is *not* implemented — the closure
says Production owns it, and this phase deliberately does not model it (§14). The **code
allocation mechanism** is likewise not implemented.

**The boundary in one sentence:** Production *points at* a Project and a Product Tree
(opaque, tenant-safe, read-only strings, `VARCHAR(128)`, no foreign key, no local table, no
cache of their structure) and *owns* the BOM that points at them.


---

## 3. Deliverables — exact file inventory

### 3.1 New — Production module (`apps/api/src/modules/production/`)

| File | Lines | Role |
| --- | ---: | --- |
| `production.constants.ts` | 86 | `PRODUCTION_MODULE_ID`, `PRODUCTION_FEATURE.BOM`, the audit resource, the page bounds |
| `production-actor.ts` | 90 | `resolveProductionActor(req)` — the only source of `tenantId` / `userId` |
| `production-audit.gateway.ts` | 144 | The ONE surface through which Production writes the platform trail |
| `production.module.ts` | 76 | The composition root; registers the controller and the guard |
| `database/production-prisma.module.ts` | 28 | Binds `PRODUCTION_PRISMA_CLIENT` |
| `database/production-prisma.service.ts` | 46 | `ProductionPrismaService extends PrismaClient` |
| `bom/bom-status.ts` | 138 | Status vocabulary, editability, transition graph, Persian decision labels |
| `bom/bom.dto.ts` | 284 | Create / Update / Decide / List DTOs, the view and the page window |
| `bom/bom.repository.ts` | 227 | Every statement against `production_db`, all tenant-scoped |
| `bom/bom.service.ts` | 446 | Orchestration: identity, self-approval, freeze, audit |
| `bom/bom.controller.ts` | 184 | The eight routes and their boundary decorators |

### 3.2 New — Production specs (10 suites, 102 tests)

| File | Lines |
| --- | ---: |
| `production-actor.spec.ts` | 177 |
| `production-audit.gateway.spec.ts` | 150 |
| `production-entitlement.spec.ts` | 348 |
| `production-isolation.spec.ts` | 315 |
| `production-schema.spec.ts` | 227 |
| `bom/bom-status.spec.ts` | 138 |
| `bom/bom.dto.spec.ts` | 247 |
| `bom/bom.repository.spec.ts` | 253 |
| `bom/bom.service.spec.ts` | 477 |
| `bom/bom.controller.spec.ts` | 249 |

### 3.3 New — persistence (`apps/api/prisma/production/`)

| File | Role |
| --- | --- |
| `schema.prisma` | The `BomHeader` model, `BomStatus` / `ManagerOpinion` enums, tenant-first indexes, **no foreign keys** |
| `migrations/20261002220459_production_baseline/migration.sql` | `CREATE TYPE` ×2, `CREATE TABLE "BomHeader"`, three indexes, and the hand-written approver `CHECK` |

### 3.4 New — Core migrations (`apps/api/prisma/core/migrations/`)

| Migration | What it writes |
| --- | --- |
| `20261002100000_add_production_permission_domain` | `ALTER TYPE "PermissionDomain" ADD VALUE IF NOT EXISTS 'PRODUCTION'` |
| `20261002100100_seed_production_permission_grants` | The three `Permission` rows + `RolePermission` rows for `SUPER_ADMIN` and `ADMIN` |
| `20261002100200_seed_production_module_tenant_membership` | The `production` `ModuleRegistration` (`enabled`, `RESTRICTED_MEMBERS`, empty `tenantIds`) + one `ModuleRegistrationTenant` row per existing tenant |
| `20261002100300_seed_production_bom_feature_entitlement` | The `production`/`bom` `ModuleFeature` (`enabled = true`) + one `ModuleFeatureGrant` per existing tenant |

The domain migration is a **separate file** from the permission seed for a specific,
already-paid-for reason: PostgreSQL cannot USE a newly added enum value inside the
transaction that added it (SQLSTATE `55P04`). Correspondence, HR and Commerce each learned
that with their own standalone domain migration; Production repeats the shape.

### 3.5 Modified

| File | Change |
| --- | --- |
| `apps/api/src/app.module.ts` | Imports and composes `ProductionModule` (COMBINED root only) |
| `apps/api/src/runtime-datasources.ts` | `Datasource` union, `DATASOURCES`, the four runtime rows, the owner registry entry, `DatasourceOwner` / `DATASOURCE_OWNER_ORDER` |
| `apps/api/src/health/health-tokens.ts` | `PRODUCTION_PRISMA_CLIENT` |
| `apps/api/src/health/datasource-probe.registry.ts` | The `production` probe definition |
| `apps/api/src/health/health.contract.ts` | The `productionDatabase` check key |
| `apps/api/src/health/combined-health.module.ts` | `ProductionPrismaModule` in the combined health graph |
| `apps/api/src/config/env.validation.ts` | `PRODUCTION_DATABASE_URL` |
| `apps/api/src/auth/rbac/constants/permissions.ts` | The three permissions, `PermissionToDomain`, `PermissionsByDomain.PRODUCTION` |
| `apps/api/src/auth/rbac/constants/roles.ts` | The three permissions on `SUPER_ADMIN` and `ADMIN` |
| `apps/api/prisma/core/schema.prisma` | `PermissionDomain.PRODUCTION` |
| `apps/api/package.json` | `prisma:generate:production`, `prisma:migrate:production`, wired into `prisma:generate` and `db:migrate` |
| `apps/api/src/architecture-boundaries.spec.ts` | The two exact-equality datasource lists |
| `apps/api/src/health/datasource-health.probe.spec.ts`, `health.service.spec.ts`, `readiness.evaluator.spec.ts` | The combined / core expectations |
| `apps/api/runtime-policy.json` | Regenerated (`npm run arch:policy`) |
| `apps/api/.env.example`, `apps/api/.env.e2e` | `PRODUCTION_DATABASE_URL` documented / configured |
| `infrastructure/postgres/initdb/01-create-databases.sql` | `CREATE DATABASE production_db` — **reconciled here in `PHASE-PRODUCTION-DATABASE-DEPLOYMENT-RECONCILIATION.md`.** This phase had written it to a root-level `initdb/01-create-databases.sql` that compose does *not* mount; that competing copy was removed and the line was integrated into the one authoritative file, which is the file the contract closure (§10 item 10) prescribed. |

`apps/api/src/generated/production-client/` was regenerated from
`prisma/production/schema.prisma` (`npm run prisma:generate:production`). It is a build
artifact and is not tracked.

**No file under `src/modules/commerce/**`, `src/modules/hr/**` or
`src/modules/correspondence/**` was created, modified or deleted.** The shared files this
phase touched that those modules also read — `permissions.ts` and `roles.ts` — were only

---

## 4. Runtime topology and datasource policy

Production is an **independent bounded context**, and that is a statement about deployment
rather than about folders.

| Runtime | `PRODUCTION_DATABASE_URL` | Why |
| --- | --- | --- |
| `core` | `not-used` | The Core-only deployable boots with zero Production knowledge, ships no Production client and reaches `production_db` never |
| `combined` | `required` | It composes `ProductionModule`, so `production_db` is a startup dependency and a readiness blocker |
| `cms`, `hr`, `correspondence`, `purchase`, `future-hr` | `not-used` | They do not serve Production |

The ownership registry entry records `production` as `implemented` — schema, migrations,
generated client and Prisma module/service all exist. `runtime-policy.json` is a projection of
that registry, regenerated by `npm run arch:policy`; the diff is exactly the new datasource
and the two derived lists (`notInstantiatedOwners`, `prunedClientDirs`).

**Health.** `productionDatabase` joined `DatasourceCheckKey`, so a runtime that serves
Production can NAME the check. In `combined` it is `required` and fails closed: a missing
probe answer blocks readiness rather than being skipped. In `core` it is `not-used`, skipped
and reported — the same shape Commerce has held since Phase C1 step F.

**Environment.** `PRODUCTION_DATABASE_URL` is documented in `.env.example` (with the
"must not reuse Core's, HR's or Commerce's URL" note the other owners carry) and configured in
`.env.e2e`. Local values live in the git-ignored `.env` / `.env.e2e`.

**Scripts.** `npm run prisma:generate:production` and `npm run prisma:migrate:production`
exist on their own and are wired into `npm run prisma:generate` and `npm run db:migrate`, so a
full local bootstrap provisions Production alongside the other five owners.

---

## 5. The Production database

`production_db` is a separate PostgreSQL database with its own Prisma project
(`prisma/production/schema.prisma`), its own migration directory and its own generated client
(`src/generated/production-client`). It shares nothing with Core, CMS, Correspondence, HR or
Commerce.

### 5.1 The `BomHeader` table

One table, one model:

```
id                UUID        PK            (the row's OWN id — a UUID v4, minted client-side)
tenant_id         TEXT        NOT NULL
title             VARCHAR(200) NOT NULL     (a STORED snapshot — never derived: M-1)
project_ref       VARCHAR(128) NOT NULL     (opaque external reference)
product_tree_ref  VARCHAR(128) NOT NULL     (opaque external reference)
requester_user_id TEXT        NOT NULL     (opaque PLATFORM id, never a UUID)
approver_user_id  TEXT                     (the snapshot; required by the CHECK once routed)
status            "BomStatus" NOT NULL DEFAULT 'DRAFT'
manager_opinion   "ManagerOpinion"         (NULL until decided — never a default)
comments          VARCHAR(2000)
submitted_at      TIMESTAMPTZ(6)
decided_at        TIMESTAMPTZ(6)
decided_by_user_id TEXT
created_at        TIMESTAMPTZ(6) NOT NULL
updated_at        TIMESTAMPTZ(6) NOT NULL
```

**No foreign key exists — anywhere.** A foreign key cannot cross a database boundary, so one
here would be either a dangling reference or a join into another owner's table. The
consequence is stated rather than hidden: the referential facts that are not enforced by a
constraint are enforced by the *service* (requester membership, approver membership) and by
the schema's own `CHECK`.

### 5.2 The indexes, and why each exists

| Index | Serves |
| --- | --- |
| `BomHeader_tenantId_id_key` (UNIQUE) | The tenant-first pair. It is also the composite target a future `BomItem` needs, so adding the child table will not have to alter this one. |
| `BomHeader_tenantId_status_updatedAt_idx` | "this tenant's documents, most recently touched first" — the operational list read |
| `BomHeader_tenantId_approverUserId_status_idx` | "what is waiting for THIS approver" — the decision read. It leads with the tenant and the approver, never with the status alone, so a cross-tenant scan by approver id is not expressible. |

Every index leads with `tenant_id`. `production-schema.spec.ts` §D reads all three back from
the SQL and asserts exactly that.

### 5.3 The one hand-written statement

```
ALTER TABLE "BomHeader"
  ADD CONSTRAINT "BomHeader_submitted_requires_approver"
  CHECK ("status" = 'DRAFT' OR "approver_user_id" IS NOT NULL);
```

Prisma cannot model a `CHECK`. It is declared in the migration exactly as Commerce's
`counter >= 0` check is, with the reason written next to it: *an invariant that lives only in
the service is an invariant a second caller can violate*. The service already refuses the
transition; this is what makes the refusal retroactively provable. Because the constraint is
in the migration and not in the schema, `prisma migrate diff` reports it as a known,
documented difference rather than as drift.

### 5.4 The two enums

`BomStatus` = `DRAFT | SUBMITTED | APPROVED | REJECTED`, `ManagerOpinion` =
`APPROVED | REJECTED | NEEDS_CORRECTION`. Both are Production's own — `production-schema.spec.ts`
§C asserts that `CANCELLED` and `CLOSED` (which Commerce's document status has) appear
nowhere, because a state no route can reach is a state that is representable, impossible to
enter, and invisible to every test that only reads the schema.


---

## 6. The BOM Header lifecycle

```
                 submit                 approve
   DRAFT ─────────────────► SUBMITTED ──────────────► APPROVED
     ▲                         │      └─ reject ────► REJECTED
     │                         │
     └──── request-correction ─┘
              (records NEEDS_CORRECTION)
```

* **`DRAFT`** — authored and editable. The requester may change the header fields, and the
  approver may still be re-chosen (the legacy form behaves the same way: the field is
  editable during authoring and frozen afterwards).
* **`SUBMITTED`** — routed to the snapshotted approver. This is the **freeze point**: ordinary
  editing is refused from here on.
* **`APPROVED` / `REJECTED`** — terminal in this phase. Nothing in the source re-opens a
  decided BOM, and a route that could would have to be justified by a contract nobody has
  written yet.
* **A correction is not a fifth state.** The legacy approval task's `نیاز به اصلاح` branch
  wrote `State = 0` — it returned the document to the *editable* state. `requestCorrection`
  moves `SUBMITTED → DRAFT` **and records the decision** (`managerOpinion =
  NEEDS_CORRECTION`, decider, instant), so "returned for correction" stays distinguishable
  from "never submitted" without inventing a state the source does not have.

The graph is declared twice on purpose — `BOM_TRANSITIONS` (what the routes read) and
`canTransitionBomHeader` / `bomStatusAfter` (what they call) — and `bom-status.spec.ts`
enumerates all sixteen `(from, to)` pairs so the two cannot drift.

**Every transition is a conditional write.** `submit`, `updateDraft` and `decide` carry the
expected `from` status *inside* the `WHERE` clause, so two concurrent requests cannot both win
and a retry of a request whose response was lost loses rather than appending a second
decision. A `SELECT … then UPDATE` pair would have neither property.
`bom.repository.spec.ts` asserts the predicate is present in the statement, not merely in a
comment.

**`submit` writes no decision column.** `managerOpinion`, `decidedAt` and `decidedByUserId`
stay `NULL` — "nobody has decided" is readable as `NULL` rather than as a placeholder value —
and the decision columns keep exactly one writer.

---

## 7. Authorization

Three permissions, and deliberately three rather than one:

| Permission | Gates | Why separate |
| --- | --- | --- |
| `production.bom.read` | `GET /production/boms`, `GET /production/boms/:id` | Reading a register is not authoring it |
| `production.bom.manage` | `POST`, `PATCH :id`, `POST :id/submit` | The authorship remit |
| `production.bom.approve` | `POST :id/approve`, `:id/reject`, `:id/request-correction` | **Deciding** is a different remit from authoring |

The names are the decision closure's own §17.3 list — none invented here. Collapsing them
would make "can read the BOM register" imply "can approve a BOM", which is the authorization
failure the legacy system avoided only by accident (its approver was whoever SharePoint's task
happened to be assigned to).

No fourth string exists: there is no `production.config`, and no per-project, per-product-tree
or per-state scope, because no route in this phase would gate on one.

**The grants are narrow.** `SUPER_ADMIN` and `ADMIN` hold all three; `OPERATIONS_ADMIN`,
`SECURITY_ADMIN` and every other role hold **none**. Production data is not a capability that
should be silently attached to an existing role; a tenant that wants a BOM-only operator
creates one through the existing role-management surface.

`roles.ts` was extended for both roles, so the constant and the seeded rows agree —
`production-entitlement.spec.ts` §A–D reads the catalogue, the two maps, the schema enum and
the seed SQL back and checks them **in both directions**, so a fourth string or a dropped one
fails.


---

## 8. Entitlement

`production` is registered with `moduleType = BUSINESS`, `enabled = true`,
`tenantScope = RESTRICTED_MEMBERS` and an **empty** `tenantIds` array — so membership lives in
`ModuleRegistrationTenant` alone, and "restricted to nobody" and "restricted to everybody" are
both unrepresentable. One membership row is inserted **per tenant that exists at the moment the
migration runs**, read via `INSERT … SELECT … CROSS JOIN "Tenant"` rather than listed, followed
by a stop-guard that `RAISE`s if the count does not match the tenant table's.

**Why seed membership at all.** Membership in `RESTRICTED_MEMBERS` is deliberately *not*
writable through the admin API — a scope edit would be a grant decision in disguise — so a
migration is the only auditable path. Not seeding would leave `403 MODULE_FORBIDDEN` for
everyone with no in-phase remedy ("Production silently unavailable"); seeding makes existing
tenants able to use Production once its routes land, while a tenant created *after* the
migration stays fail-closed with no row and nothing granted. The two failure directions are
weighed explicitly, and the choice is recorded in the migration itself rather than left implicit
in an empty table.

**The feature.** One feature — `production` / `bom` — with `enabled = true` (the platform
*offers* it) and one grant row per existing tenant (which tenancies *hold* it). BOM items, code
generation and Purchase consumption are **not** separate features: within an entitled tenant they
are a question of who may act (the permissions in §7), not of whether the tenant holds the
capability.

**The gate is delegated, never re-implemented.** `@RequiresModule(PRODUCTION_MODULE_ID)` and
`@RequiresFeature(PRODUCTION_MODULE_ID, PRODUCTION_FEATURE.BOM)` are declared on the controller;
the *decision* is the platform's `ModuleEntitlementGuard`, provided at the composition root.
`production-entitlement.spec.ts` §G asserts that no Production-owned guard and no `CanActivate`
implementation exists anywhere in the module, and §H that entitlement is named only in
`production.module.ts` and `bom.controller.ts` among non-spec sources.

**Permission ≠ entitlement.** The permission rows answer "may this *user* act"; the
registration/feature rows answer "may this *tenant* hold the module". Neither migration writes
the other's tables (§J), so no single row — and no single file — can decide both.

---

## 9. Tenant isolation

**One resolution path.** `resolveProductionActor(req)` is the only producer of `tenantId` and
`userId`, and it reads `RequestContextService` — populated per request by the established
tenant-context mechanism — never `req.user.tenantId`, never `req.body`, `req.query` or
`req.params`. `production-actor.spec.ts` plants a `tenantId` on the body *and* on `req.user`
simultaneously and asserts the resolved actor still carries the context's tenant; it also pins
the actor's exact key set, so an implementation that spread `...req` onto the actor cannot pass.

**Failing closed.** A request with no resolved tenant is `403`, never "unscoped". The
alternative — continuing without a tenant predicate — is how a multi-tenant module reads
another tenant's BOM.

**The predicate travels with the query.** `tenantId` is the FIRST parameter of every repository
method and appears in EVERY `where`. `findFirst({ where: { id, tenantId } })` is the only shape
used for a single row; `findUnique` is never used, because it cannot carry a tenant predicate
and an id alone is not an isolation key. `production-isolation.spec.ts` §C checks that across
every non-spec source file *with comments stripped*, so the repository's own docblock naming
`findUnique` cannot satisfy the rule.

**A foreign id is indistinguishable from a missing one.** `findById` returns `null` for both, and
the service maps both to `404` — telling a caller which of the two it was would confirm that an
id exists in a tenant the caller cannot see.

**The service never queries.** It holds no client; persistence is the repository's, which is what
keeps the tenant predicate and the conditional status writes in a single reviewable file.


---

## 10. The approver snapshot, self-approval, and identity verification

**The approver is a snapshot, not a resolution (M-5b).** `approverUserId` is stored on the row
and re-verified only as *membership*; the decision check is
`actor.userId === row.approverUserId` against the STORED value, never a re-resolution from a
hierarchy. A `null` actor id (a machine caller) cannot equal a stored id, so a non-human caller
is refused by construction rather than by a separate branch. This is what gives Production **no
dependency on an organisational hierarchy** and **no dependency on a workflow engine**.

**Two identities are verified, not trusted.** `requesterUserId` and `approverUserId` are STATED
by the caller (a delegate may raise a BOM for somebody else — the legacy form allowed exactly
that) and then checked against the acting tenant through `USER_DIRECTORY`. `findTenantMember`
returns a profile for a member and `null` otherwise, so a probing caller learns "not mine" rather
than "belongs to somebody else". A non-member is a `400` naming the FIELD — it is a statement
about the payload, not about the caller's rights — and nothing is stored, because nothing inside
`production_db` could ever check that.

**The approver is re-checked at the freeze.** Between creation and submission a person can leave
the tenant, so `submit` verifies membership again: the concrete meaning of the source's own
refusal to submit when the manager's account could not be resolved
(`یوزر مدیر پروژه در سامانه ست نشده است`). It is *not* re-checked at decision time — re-asking
then would let an identity change flip a decision the frozen-approver rule deliberately protects.

**Self-approval is refused (M-5b §5.6).** The source has no such guard — a search for one
returned nothing — so the brief's own rule governs: an actor may not approve their own request
unless the business explicitly opts in, and V1 does not. The check compares the ROW's two roles
rather than "the actor versus the requester", because a delegate may create a BOM whose requester
is somebody else. Permitting it later is a one-line change.

---

## 11. Audit

**One trail, at the platform.** Production keeps **no audit table**. Every mutation records
through `ProductionAuditGateway`, which is the only file in the module that names `AUDIT_PORT`;
rows land in `core_db."AuditLog"` through the port. A second trail per module would make "who did
what, when" unanswerable. `production-isolation.spec.ts` §D asserts the single-holder property
over code with comments stripped — `production.constants.ts` *names* `AUDIT_PORT` in prose while
explaining why it does not hold it, and the rule must not count that as a holder.

**The gateway owns envelope construction, nothing else.** It generates a fresh `auditId`
(`randomUUID()` — never derived from `requestId`, because one request legitimately emits several
events and a re-delivered event must be recognised rather than duplicated), takes `requestId`,
`correlationId`, `actorId`, `ip` and `userAgent` off the actor, and stamps `tenantId:
actor.tenantId`. A caller-supplied tenant cannot redirect the row — asserted directly.

**It never throws.** A trail write is best-effort by contract; an implementation that let a port
rejection escape would turn an audit outage into a failed BOM mutation, coupling a business write
to a separate system's availability.

**The trail records what was STORED, not what was intended.** Every mutation audits *after* the
repository returned a row — the write is already committed by then — so a refused conditional
write produces no audit row claiming success. The specs assert exactly that for a lost race on
`update`, `submit` and `decide`.

Recorded actions: `create`, `update`, `submit`, `approve`, `reject`, `request_correction`, all on
resource `production.bom`, with before/after values and a `changedFields` list.

**A read half exists and no route calls it.** `ProductionAuditGateway.read(query)` is a verbatim
passthrough to the port that classifies a throwing port as `AUDIT_READ_FAILED` rather than
returning an empty page. The BOM audit timeline is deferred to a later phase; the seam is proven
now rather than invented later.


---

## 12. The HTTP surface

Namespace `production/boms` under the global `api/v1` prefix.

| Method | Path | Permission | Status |
| --- | --- | --- | --- |
| `GET` | `/production/boms` | `production.bom.read` | 200 |
| `GET` | `/production/boms/:id` | `production.bom.read` | 200 / 404 |
| `POST` | `/production/boms` | `production.bom.manage` | 201 |
| `PATCH` | `/production/boms/:id` | `production.bom.manage` | 200 / 409 |
| `POST` | `/production/boms/:id/submit` | `production.bom.manage` | 200 / 409 |
| `POST` | `/production/boms/:id/approve` | `production.bom.approve` | 200 / 403 / 409 |
| `POST` | `/production/boms/:id/reject` | `production.bom.approve` | 200 / 403 / 409 |
| `POST` | `/production/boms/:id/request-correction` | `production.bom.approve` | 200 / 403 / 409 |

**`boms`, not `bom-headers`.** The path names the aggregate the calls address, and the aggregate
is the BOM — whose root row happens to be its header. The items that will hang off it are
`/boms/:id/items`, so the collection that owns `:id` has exactly one meaning.

**`:id` is parsed as a UUID v4** on all six routes that take one — the row's OWN id is a UUID, so
a malformed one is a `400` at the edge rather than a database round-trip. This is the OPPOSITE of
the rule for a platform user id, which is opaque and never a UUID; mixing the two up is how a
legitimate `super-admin-user` gets refused.

**`submit` is `200`, not `201`.** Nothing is created by it: the row's state moves and the answer
is the row. A caller that retried a `201` and re-submitted would be the double-routing the
conditional write exists to refuse. It takes **no body** — the approver is the row's own frozen
snapshot, not a field of the request.

**The controller resolves and delegates.** No rule, no status decision, no query, no audit call.
`bom.controller.spec.ts` discovers the handlers by reflection rather than listing them and asserts
that not one is ungated, that each declares exactly one permission drawn from the `Permissions`
constants, that the gates split authoring from deciding exactly as the remits do, and that each
route passes an actor resolved from the context.

---

## 13. The wire contract

**Every bound is a column width.** `title` ≤ 200, an external reference ≤ 128, a platform user id
≤ 64, `comments` ≤ 2000. A request no column can store must be a `400` naming the field, not a
driver error from Postgres — and the database constraint stays what it is: the last line of
defence rather than the only one. `bom.dto.spec.ts` checks each bound at its exact width and one
past it.

**What is deliberately not on the wire.**

* **No `tenantId`.** It comes from the resolved actor, and the global pipe's `whitelist` +
  `forbidNonWhitelisted` makes sending one a `400` rather than a silently ignored field.
* **No `status`.** The lifecycle is walked by the routes that own each transition; a client that
  could set `APPROVED` directly could approve its own document. A `PATCH` carrying
  `status: "APPROVED"` is a `400` here.
* **No `managerOpinion` / `decidedAt` / `decidedByUserId`** — written by the decision routes only.
* **No `approverUserId` on DECIDE.** The approver is the row's snapshot, never the caller's claim
  about who they are.
* **No `standardPartCode`, no `Code_Ghatae`, no consumption coefficients** — those belong to the
  BOM ITEM aggregate, which does not exist in this phase.
* **No `projectId` / `productTreeId` as anything but an opaque string.** There is no Project or
  Product Tree table to validate against (M-1 / RB-1), and a UUID-shaped validator would reject a
  legitimate legacy id while proving nothing about tenancy.

**The external references are bounded, never format-checked** — `VARCHAR(128)`, and
`production-schema.spec.ts` §G asserts the *column* does not claim a UUID either, while the row's
own `id` does.

**The outcome is fixed by the route, not by the client.** Each decision endpoint passes its own
`expected` opinion to the service, which refuses a body stating a different one — so the reject
endpoint cannot produce an `APPROVED` row even if a client sends `opinion: "APPROVED"`. The
opinion is required, because the legacy approval task refused to act without one
(`نظر مدیر مشخص نشده`) and a decision with no stated outcome is not a decision anybody can later
explain.

**`requesterUserId` is not editable.** It is written once, at create, and is what the self-approval
rule compares a new approver against — so a `PATCH` that states it is refused rather than silently
dropped.

**Pagination** is bounded twice: the DTO enforces the ceiling as a CONTRACT (a `400` for an absurd
`pageSize`) and the service clamps with `Math.min` as the GUARANTEE, so an internal caller that
builds its own query object cannot exceed it either.


---

## 14. Deliberate deferrals

Each of these is a **decision recorded here**, not an oversight. `production-isolation.spec.ts`
§F asserts that no non-spec source file names any of them once comments are stripped, so a later
reader cannot mistake prose about a deferral for an implementation of one.

| Deferred | Why |
| --- | --- |
| **BOM items** (`BomItem`) | A separate aggregate with its own identity, lifetime and rules. The "a BOM must have items before it can be submitted" gate is therefore DEFERRED rather than faked: there is no `hasItems` flag, no placeholder count and no always-true guard. |
| **BOM code generation** | The prefix comes from the Product Tree, whose contract is missing (`RB-1-P` BLOCKED). Inventing a prefix would mean inventing the format of every part code ever printed on a drawing or quoted in a purchase request — not recoverable. The *mechanism* (single-statement allocation) is identified by citing the repository's existing counter pattern; no counter is created. |
| **Project** and **Product Tree** | They do not exist. No `Project` / `ProductTree` table, DTO or port was created; `projectRef` and `productTreeRef` are opaque, tenant-safe, read-only strings. |
| **Purchase consumption** | The five deferred coefficient fields are `NOT-IN-V1`; no write-back Production would have to accept. |
| **Notifications** | The recipient set for a BOM decision is a later phase's decision. No notification import exists. |
| **Global search** | The header has no stable searchable identifier yet (the code is blocked). No search source is registered. |
| **Workflow engine** | The BOM is a guarded state machine on ONE row, not a third engine, and it does not reuse Commerce's closed workflow subject model. |
| **BOM audit timeline** | The gateway's `read` half is built and proven; no route calls it. |
| **Frontend** | No screen, component or label file. See §19 for the nav-catalogue consequence. |

---

## 15. Core migrations and live provisioning

The four Core migrations were applied to a live `core_db` (`prisma migrate deploy`). Verified
afterwards by querying the database through the generated Core client:

| Fact | Observed |
| --- | --- |
| `Permission` rows with domain `PRODUCTION` | 3 — `production.bom.read`, `production.bom.manage`, `production.bom.approve` |
| `RolePermission` rows for those permissions | 6 — all three on `SUPER_ADMIN` and on `ADMIN`, and on **no other role** |
| `ModuleRegistration` for `production` | present; `moduleType = BUSINESS`, `enabled = true`, `tenantScope = RESTRICTED_MEMBERS`, `tenantIds = []`, `protocolVersion = 1` |
| `ModuleRegistrationTenant` rows | 172, equal to the tenant count |
| `ModuleFeature` for `production`/`bom` | present, `enabled = true` |
| `ModuleFeatureGrant` rows for that feature | 172, equal to the tenant count |
| `production_db."BomHeader"` | exists, 0 rows |
| `BomHeader` `CHECK` constraints | exactly one — `BomHeader_submitted_requires_approver` |

The Production baseline was applied with `prisma migrate deploy --schema=prisma/production/schema.prisma`
and `prisma migrate status` now reports **"Database schema is up to date!"** (1 migration found,
none pending).

**Idempotence.** Every seed statement targets an existing unique key with `ON CONFLICT … DO
NOTHING`, and each file ends with a stop-guard that `RAISE`s if the number of rows it produced
does not equal the number of tenants — a migration that *warns* is a migration that finished. A
re-run is indistinguishable from a first run; an operator who provisioned by hand first is not
overwritten, because `DO NOTHING` cannot rewrite a live row's scope, `displayName` or `enabled`.

`production-entitlement.spec.ts` §B re-reads all four files and asserts they contain no `UPDATE`
and no `DELETE`, that every `INSERT` has a matching `ON CONFLICT`, and that none of them contains
a quoted `'hr'` or `'commerce'` literal — so the HR and Commerce registrations cannot be rewritten
from this side even accidentally (§I).


---

## 16. Tests — what each suite exists to falsify

| Suite | Tests | The failure it refuses |
| --- | ---: | --- |
| `production-actor.spec.ts` | 7 | A caller influencing `tenantId`, or a missing tenant becoming "no predicate" |
| `production-audit.gateway.spec.ts` | 7 | A caller-supplied tenant on an audit row; a re-used `auditId`; an audit outage failing a business write; an empty `ok` page masquerading as a successful read |
| `production-entitlement.spec.ts` | 10 | Drift between the constants, the permission catalogue, the schema enum and the four seed files — the `403` naming a module or a permission nobody provisioned |
| `production-isolation.spec.ts` | 7 | A cross-owner client import, a second connection holder, a second query writer, a second audit or identity seam, Production leaking into the Core-only root, a deferred surface arriving unnoticed |
| `production-schema.spec.ts` | 7 | Schema/migration drift; a foreign key appearing; a Commerce state copied in; the approver `CHECK` being dropped or reworded; an external reference claiming a UUID |
| `bom/bom-status.spec.ts` | 7 | "DRAFT is editable" and "DRAFT may not be submitted twice" both ending up true |
| `bom/bom.dto.spec.ts` | 13 | A value no column can store reaching Postgres; a client supplying `tenantId`, `status` or the approver |
| `bom/bom.repository.spec.ts` | 11 | An unscoped read; a `findUnique` creeping in; a transition racing a transition |
| `bom/bom.service.spec.ts` | 23 | An unverified identity being stored; self-approval; the freeze being bypassed; a non-approver deciding; an audit row for a write that was refused |
| `bom/bom.controller.spec.ts` | 10 | A route added without `@Roles`; a decision route gated on `manage`; the entitlement declaration drifting from the constants |
| **Total** | **102** | |

Every file-scanning assertion strips comment lines first, states a non-vacuity floor (how many
files, tables, enums or indexes it read), and reads from disk rather than importing — so an
assertion still fails if a future import throws at module load, and a scan that matched nothing
fails instead of passing quietly.

---

## 17. Validation ledger

| # | Command | Result |
| --- | --- | --- |
| 1 | `npx tsc --noEmit` (apps/api) | clean — no errors |
| 2 | `npx jest src/modules/production` | **10 suites, 102 tests, all passing** |
| 3 | `npx jest` (full unit suite) | **221 suites, 3616 tests, all passing, 0 failures** |
| 4 | `npx jest src/health src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` | 8 suites, 127 tests, all passing |
| 5 | `npx prisma migrate deploy --schema=prisma/core/schema.prisma` | the four Production Core migrations applied |
| 6 | `npx prisma validate --schema=prisma/production/schema.prisma` | "The schema at prisma/production/schema.prisma is valid" |
| 7 | `npx prisma migrate status --schema=prisma/production/schema.prisma` | "Database schema is up to date!" (1 migration, none pending) |
| 8 | `npx prisma migrate diff --from-url <production_db> --to-schema-datamodel prisma/production/schema.prisma --exit-code` | **"No difference detected."** — the live database and the schema agree; the hand-written `CHECK` is reported as the known, documented difference rather than as drift |
| 9 | `npm run prisma:generate` (includes `prisma:generate:production`) | client generated to `src/generated/production-client` |
| 10 | `npm run arch:policy` | `runtime-policy.json` regenerated; `runtime-policy.spec.ts` green |

Live-database checks (queries, not assertions-in-a-file) are enumerated in §15.

---

## 18. Architecture boundaries enforced

| Boundary | Enforced by |
| --- | --- |
| Production reaches only `production_db` | `production-isolation.spec.ts` §B (no other owner's generated client, no other owner's Prisma module) |
| One holder of the connection token; one importer of the client value; one file issuing queries | `production-isolation.spec.ts` §C |
| No `findUnique` anywhere in the module | `production-isolation.spec.ts` §C and `bom.repository.spec.ts` |
| One audit seam; one identity seam; no module-local audit table | `production-isolation.spec.ts` §D |
| Production is composed by the COMBINED root and not by the Core-only root | `production-isolation.spec.ts` §E |
| No deferred surface (items, codes, notification, search, workflow) leaked into source | `production-isolation.spec.ts` §F |
| Every controller carries the whole chain `@RequiresModule` → `@RequiresFeature` → `@UseGuards(ModuleEntitlementGuard)` → `@UseGuards(JwtAuthGuard)` | `production-isolation.spec.ts` §A |
| Entitlement is declared only at the composition root and the controller | `production-entitlement.spec.ts` §H |
| No Production-owned guard and no `CanActivate` implementation | `production-entitlement.spec.ts` §G |
| The datasource matrix and the runtime projection agree with the runtime hosts | `architecture-boundaries.spec.ts`, `runtime-policy.spec.ts`, `health/*.spec.ts` |
| The registry row is `implemented`, so every owner the runtimes instantiate has real artifacts | `datasource-probe.registry.spec.ts` — the "no outstanding target" list stays empty |


---

## 19. Residual notes, decisions taken in-phase, and follow-ups

### 19.1 Decisions taken during implementation (recorded, not hidden)

1. **`production.bom.*` and not `production.*`.** The three permission names are the decision
   closure's own; the *keys* are `PRODUCTION_BOM_READ / MANAGE / APPROVE` so that a later BOM
   ITEM phase can add its own names without a rename.
2. **The `roles.ts` constant was extended** for `SUPER_ADMIN` and `ADMIN` in addition to the seed
   migration, so the constant and the seeded rows agree. Commerce relies on its migration alone;
   HR and Correspondence list their permissions in `roles.ts`. Production follows the HR /
   Correspondence shape, because a constant and a database that disagree is the drift the
   entitlement suite exists to catch.
3. **`ProductionAuditGateway.read` ships with no route.** The timeline is deferred; the seam is
   proven now rather than invented later.
4. **An untracked `docker-compose.e2e.yml` was removed.** It is referenced by nothing in the
   repository (a full-tree search found no reference), it is not tracked by git, and it was not
   in this phase's scope. Its final content was a YAML fragment rather than a runnable compose
   file, so it is not a document this phase could have relied on; leaving a broken compose file
   in the tree would have been worse than leaving none. E2E here runs through `.env.e2e` and the
   local Postgres, which is unchanged. **If that file had intended content, it is not
   recoverable from this session, and it should be re-added deliberately by whoever owns it.**
5. **No `nav-catalogue.ts` entry.** The catalogue is an allowlist of *exact* frontend hrefs, and
   this phase ships no frontend: there is no `/admin/production` route in `apps/web`, so an entry
   would resolve a pinned favourite to a 404. The entry arrives with the screen, in the same
   change that adds the route — which is what the catalogue's own comment requires.
6. **`production_db` was added to the database bootstrap.** *Correction recorded:* this phase
   wrote it into a root-level `initdb/01-create-databases.sql`, which `docker-compose.yml` does
   **not** mount — so a fresh compose volume would not have created it. That is reconciled in
   `docs/PHASE-PRODUCTION-DATABASE-DEPLOYMENT-RECONCILIATION.md`: the line now lives in the
   authoritative `infrastructure/postgres/initdb/01-create-databases.sql` and the competing copy
   is gone.

### 19.2 Residual limitations (accepted, stated)

1. **No BOM item exists**, so a BOM with no items can be submitted. This is the deferral recorded
   in §14, not a gate that was dropped: the legacy rule (`اقلامی ثبت نشده است!`) is an
   ITEM-aggregate rule and is not faked.
2. **The approver snapshot is membership-checked, not hierarchy-checked.** That is the whole point
   of M-5b: Production has no dependency on an organisational hierarchy, and a later phase that
   wants one must add a contract for it rather than a lookup here.
3. **`APPROVED` / `REJECTED` are terminal.** No reopen route exists; a contract for one has not
   been written.
4. **The BOM code is absent**, so the header has no stable human-readable identifier yet and is
   therefore absent from global search (§14).
5. **Feature grants are seeded for tenants that exist at migration time only.** A tenant created
   later is fail-closed until provisioned — the deliberate direction, since `RESTRICTED_MEMBERS`
   membership is not writable through the admin API.

### 19.3 Follow-ups for the next Production phase

1. **`BomItem`** — its own table, its own tenant-first composite key referencing
   `BomHeader(tenant_id, id)`, its own repository, and the *then-real* submit gate.
2. **BOM code allocation** — needs the Product Tree contract (`RB-1-P`); the mechanism is already
   identified by citing the repository's existing atomic counter pattern.
3. **BOM audit timeline** — the gateway's `read` half is ready; the route and the screen are not.
4. **Frontend** — `/admin/production/boms` plus its `nav-catalogue.ts` entry, in one change.
5. **Purchase consumption** — the snapshot/pinning/quantity/supplier/pricing contract and
   immutability-at-consumption, still `NOT REQUIRED FOR V1`.

---

## 20. Final status

**Phase PRODUCTION-BOM-HEADER: COMPLETE.**

* The BOM Header slice is implemented end to end: authoring, routing, deciding, reading, auditing,
  under tenant isolation, permission gates and the platform entitlement gate.
* Production is an independent bounded context with its own database, schema, migrations and
  generated client; nothing else in the repository holds a handle to `production_db`.
* The four Core migrations are applied to a live database and produce exactly the three
  permissions, six role grants, one registration, one feature and one grant/membership per
  existing tenant.
* The Production baseline is applied and the live database matches `schema.prisma` exactly
  (`migrate diff`: "No difference detected").
* `tsc` is clean; the full unit suite is green at **221 suites / 3616 tests**, of which **10
  suites / 102 tests** are this phase's.
* The ownership statement in §2 is implemented, not merely quoted: Production owns the BOM header
  and its lifecycle, references Project and Product Tree opaquely, and owns nothing of either.

**Nothing was faked.** Where a fact was missing (Project, Product Tree, the item aggregate, the
code prefix), the phase recorded the deferral, added no placeholder and created no type that
would have to be deleted later.

*extended*, never re-typed: no existing permission string, key or role-list entry changed.
