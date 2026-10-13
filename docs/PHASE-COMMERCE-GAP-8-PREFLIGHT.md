# PHASE COMMERCE GAP-8 — PREFLIGHT / CONTRACT DISCOVERY
## Member / Identity Consistency

**Status:** discovery-only. No schema, migration, DTO, seed, fixture, frontend or runtime file was modified.
The only artifact of this phase is this report.

**Repository:** `E:\ERP` · **HEAD:** `c0fab92` ("test(commerce): order U teardown before pinned versions") ·
**Working tree:** NOT clean — 56 modified / 26 untracked files carrying the C7/C8/C9/UI-phase work already
in progress. Verified: the uncommitted diff does **not** change any identity validator (the `purchase.dto.ts`
diff is the additive timeline DTO only), so every finding below holds for both HEAD and the current tree.

**Read-only checks run:** directory listings, `Select-String` audits over `apps/api/**`, `apps/api/prisma/**`,
`apps/api/test/**`, `apps/web/src/**`, `docs/**`; `git status`/`git diff --stat`; reads of the pre-49h/49i/49j
database dumps under `backups/`. No build, no test run, no migration, no database write.

---

## 1. Scope

GAP-8 is the identity/member consistency question raised during Phase UI-5:

> Commerce's identity-bearing DTO fields (`requesterId`, `liaisonUserId`, `approverUserId`, …) are validated
> `@IsUUID('4')`, while the platform's own seeded administrator id is the literal string `super-admin-user` —
> a real tenant member whose id no Commerce DTO accepts. Is the DTO validation wrong, is the seed/data wrong,
> or is something else the authoritative contract?

This preflight establishes, from source only:

1. the platform identity/user model and the canonical identifier type;
2. the tenant-membership contract;
3. the user-directory / identity-gateway contracts (in-process **and** out-of-process);
4. every Commerce contract that consumes a Core identity id, and what it actually enforces;
5. the real runtime data flow for both identity paths (seeded/admin → Commerce write; authenticated actor → service);
6. the seed / fixture / live-database facts behind `super-admin-user` and `tenant-test-1`;
7. the frontend picker contract;
8. the tests that exist, and the assertions that are missing.

Explicitly out of scope this phase: implementing any fix, changing `@IsUUID` or any validator, changing
seeds/migrations/DTOs, frontend changes, or any “compatibility hack”.

---

## 2. Sources Inspected

| Area | Files (authoritative ones in bold) |
|---|---|
| Core identity schema | **`apps/api/prisma/core/schema.prisma`** (Tenant 150-172, User 175-264, UserRole 312-328), `prisma/core/migrations/20260824105833_add_tenant_foundation/migration.sql` |
| Core seeds | **`apps/api/prisma/seed.ts`**, `apps/api/prisma/seed.js` (legacy), `apps/api/package.json` (`prisma.seed`) |
| Auth / issuance | `src/auth/auth.service.ts`, `src/auth/strategies/jwt.strategy.ts`, `src/platform/auth/token-issuer.ts`, `src/platform/auth/token-contract.ts`, `src/platform/auth/claims-tenant-resolver.ts`, `src/platform/auth/tenant-resolver.contract.ts` |
| Tenant context | **`src/tenant/core-tenant-resolver.ts`**, **`src/tenant/tenant-context.guard.ts`**, `src/tenant/tenant-context.interceptor.ts`, `src/tenant/tenant.service.ts` |
| Identity port (in-process) | **`src/platform/user-directory/user-directory.contract.ts`**, **`src/platform/user-directory/core-user-directory.adapter.ts`**, `src/platform/user-directory/README.md`, `src/platform/user-directory/user-directory.spec.ts` |
| Identity transport (out-of-process) | **`src/platform/identity/identity.contract.ts`**, `src/platform/identity/platform-identity.controller.ts` (+ spec), `src/platform/identity/platform-identity.module.ts` |
| Directory HTTP surface | **`src/users/users.controller.ts`**, **`src/users/directory.service.ts`**, `src/users/dto/directory-query.dto.ts`, `src/users/users.service.ts` |
| RBAC / permission seed | `src/auth/rbac/constants/permissions.ts`, `prisma/core/migrations/20260828093000_seed_admin_permission_grants/migration.sql` |
| Commerce actor / gateways | **`src/modules/commerce/commerce-actor.ts`**, **`src/modules/commerce/commerce-identity.gateway.ts`**, `commerce-gateways.spec.ts`, `commerce-isolation.spec.ts` |
| Commerce DTOs (identity fields) | **`commerce/purchase/purchase.dto.ts`**, **`commerce/commercial/commercial.dto.ts`**, `commerce/workflow/workflow-configuration.dto.ts`, `workflow-execution.dto.ts`, `workflow-line-routing.dto.ts`, `receiving/receiving.dto.ts`, `returns/return.dto.ts` |
| Commerce services / repos | `purchase/purchase.service.ts`, `commercial/commercial-liaison.ts`, `workflow/workflow-configuration.service.ts`, `workflow-execution.service.ts`, `workflow-line-routing.service.ts` |
| Commerce persistence | `prisma/commerce/schema.prisma` (+ migrations dir), `database/commerce-prisma.service.ts` |
| E2E suites / helpers | `test/commerce-integration.e2e-spec.ts`, `commerce-tenant.e2e-spec.ts`, `commerce-lifecycle.e2e-spec.ts`, `commerce-search.e2e-spec.ts`, `users-directory.e2e-spec.ts`, `module-entitlement-runtime.e2e-spec.ts`, `app.e2e-spec.ts`, `media.e2e-spec.ts`, `test/global-setup.ts`, `test/setup.ts` |
| Frontend | **`apps/web/src/components/commerce/settings/CommerceMemberPicker.tsx`**, **`apps/web/src/components/commerce/CommercePurchaseCreateView.tsx`**, `src/lib/directory-api.ts`, `src/components/core/core-nav.ts`, component specs |
| QA scripts | `apps/web/phaseui3-qa-dataprep.mjs`, `.tmp/ui3-qa-membership.sql` |
| Live DB evidence | `backups/core_db_pre_49j.sql` (User COPY 37193-37194, Tenant COPY 37051), `core_db_pre_49h.sql`, `core_db_pre_49i.sql` (searched) |
| Prior GAP-8 records | `docs/PHASE-UI-0-COMMERCE-UX-CONTRACT.md` (§26-GAP-8, §UI-5-A appendix), `docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md`, `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md`, `docs/PHASE-C1-P-COMMERCIAL-FOUNDATION-CONTRACT.md`, `apps/api/prisma/hr/migrations/20260916120000_hr_tenant_identifier_text/migration.sql` |

---

## 3. The Authoritative Identity Contract

### A. Canonical user/member identifier type

**An opaque string. Not "UUID v4"; not "UUID" as a guarantee. UUID v4 is only the generator DEFAULT of rows
created through Prisma, and the platform's own bootstrap identity violates it.**

Evidence, in descending order of authority:

1. **Core schema — the identifier is TEXT.** `User.id  String @id @default(uuid())`
   (`prisma/core/schema.prisma:176`; `Tenant.id` at :151 is the same shape). Storage is a string column;
   the `uuid()` default is a *generator*, not a constraint.
2. **The platform's own signed identity transport (`platform.identity@v1`) treats ids as opaque strings,
   bounded at 64 chars — and never as UUIDs.** `MAX_IDENTITY_USER_ID = 64`; `IdentityProfilesRequestDto.userIds`
   and `IdentityUserRequestDto.userId` are `@IsString() @MaxLength(64)`; the doc comment states the ids
   "are OPAQUE to this surface. It never parses one, never infers a tenant from one and never trusts one as an
   authorization claim" (`src/platform/identity/identity.contract.ts:79-103`). This is the platform's canonical
   *wire* answer for a Core `User.id`.
3. **The C1 bounded-context contract declares these references opaque.** "References such as: tenantId, userId,
   employeeId, supplierId, requesterId, approverId **are opaque values**. They are NOT cross-database foreign
   keys." (`docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md:290-301`). The C1-P commercial contract then
   spells the same rule for the liaison: "`liaisonUserId` **opaque TEXT** (nullable → §3-K)"
   (`docs/PHASE-C1-P-COMMERCIAL-FOUNDATION-CONTRACT.md:405`).
4. **The platform's own seeded identity is non-UUID and is acknowledged as such by later authoritative
   documents.** `prisma/seed.ts:107` creates the administrator with `id: 'super-admin-user'`. The HR migration
   writes: "the platform's seeded administrator is literally `super-admin-user`" and "the platform's own
   seeded tenant is literally `tenant-test-1`"
   (`prisma/hr/migrations/20260916120000_hr_tenant_identifier_text/migration.sql:8,54`).
5. **Commerce's own persistence layer agrees.** Every identity column is `String … @db.Text` and is documented
   "an OPAQUE Core identity id": `requesterId` (`prisma/commerce/schema.prisma:269-272`), `liaisonUserId` (:1412),
   `approverUserId` (:1477, :1652), `actorUserId` (:883, :1602, :2114). The boundary header repeats:
   "`requesterId` and `approverId` are PLAIN STRING columns holding opaque values" (:20-28).
6. **Commerce's own implemented precedent agrees — in the same module.** The workflow step's `actorUserId` is
   validated `@IsString() @MaxLength(64)` and commented "an OPAQUE Core identity id, verified as a member on
   write" (`src/modules/commerce/workflow/workflow-configuration.dto.ts:259-263, 346-349`) — structurally
   identical to the platform transport's rule (64 chars included).

Conversely, **no source mandates UUID v4 as the platform's identity format.** No validator, schema constraint,
or contract document states it for `User.id`. The only places requiring v4 are (a) several DTO fields in
Commerce and HR, (b) Commerce-owned resource ids, and (c) frontend defensive regexes. The HR migration itself
frames HR's `@IsUUID('4')` as a local limitation: "HR's own contract requires a UUID v4 for `userId` … so TODAY
no API call can store a non-uuid id there and this ALTER fixes NO observed failure" (HR migration:54-56).

### B. Is the identifier globally unique across tenants?

**Yes.** `User.id` is the primary key of one global `"User"` table; `email` is `@unique` too
(`prisma/core/schema.prisma:176-177`). There is one `"User"` relation to one optional `Tenant`
(`tenantId` column), so the id namespace spans all tenants and cannot collide.

### C. Is tenant membership represented separately from User identity?

**No.** Membership is a nullable column on the identity row: `tenantId String?` + FK `Tenant` with
`onDelete: SetNull` (`prisma/core/schema.prisma:199-200`). There is **no** user-membership join table,
no membership history, no invite record. A user belongs to **at most one tenant** (or none). User-role
assignment (`UserRole`, :312-328) is separate and not tenant-scoped by itself.
(`ModuleRegistrationTenant` is module→tenant membership — a different concept, not user membership.)

### D. What Commerce actually owns

- **Raw opaque user-id references only**, stored in `commerce_db` TEXT columns (`requesterId`, `liaisonUserId`,
  `approverUserId`, step `actorUserId`, history `actorUserId`), with **no foreign key and no ability to check
  anything about them locally.**
- **Requester/member validation at the write boundary**: `CommerceIdentityGateway.assertMember(actor, userId)`
  → `USER_DIRECTORY.filterTenantMembers(actor.tenantId, [id])` → a `BadRequestException`
  ("`userId is not a member of this tenant`") when absent (`commerce-identity.gateway.ts:105-115`). Callers:
  `purchase.service.ts:176` (create), `:295` (update), `commercial-liaison.ts:113` (stored liaison when a group
  decides a line), `workflow-configuration.service.ts:714` (`CONFIGURED_USER` step actor),
  `workflow-execution.service.ts:476` and `workflow-line-routing.service.ts:329` (resolved approver at
  decision time).
- **Name hydration for display** via `profilesFor` (`commerce-identity.gateway.ts:132-142`).
- It does **not** own: identity creation, membership assignment, authorization, lifecycle state, or the
  directory itself.

### E. What Platform/Admin owns

- **Identity creation:** the only in-repo creation path is `POST /auth/register` → `UsersService.create`
  (`users.service.ts:25-38`) — which does **not** set `tenantId`; the id comes from the `uuid()` column default.
- **Tenant creation:** `TenantService.create` exists (`tenant.service.ts:14-27`) and there is **no HTTP
  controller for it** (the `src/tenant/` tree contains only the service, resolver, guard, interceptor,
  module and specs). Tests create tenants by direct Prisma calls (`app.e2e-spec.ts:920-925`).
- **Membership assignment:** `TenantService.assignUserToTenant` exists (`tenant.service.ts:41-46`) and is
  **referenced by no controller and no route**; tests and QA scripts assign membership by direct DB writes
  (`app.e2e-spec.ts:936-939`; `.tmp/ui3-qa-membership.sql:1-5` — its own comment: "no HTTP endpoint exists
  for it (recorded as a finding)"). **There is no first-class membership-provisioning surface.**
- **Directory:** `GET /users/directory` and `GET /users/directory/:id` under `JwtAuthGuard` +
  `@Roles(Permissions.ADMIN_USERS_READ)` (`users.controller.ts:90-102`), tenant derived solely from
  `RequestContextService` and never from the request (`directory.service.ts:101-152`).
- **Authorization:** Permission/Role catalogue; `admin.users.read` is seeded to **SUPER_ADMIN (all)** and
  **ADMIN** (migration `20260828093000_seed_admin_permission_grants/migration.sql:23,42-62`).
- **Token issuance:** `tid` is minted from the Core-owned row (`auth.service.ts:85-114`: `select { …, tenantId }`
  → `tokenIssuer.issueAccessToken({ …, tid: dbUser.tenantId })`), and verification never re-reads Core at
  asymmetric trust (`jwt.strategy.ts:99-109`).

### F. Canonical contracts, term by term

| Term | Canonical contract | Source |
|---|---|---|
| **requester** | An opaque Core `User.id` (TEXT, ≤64 at the platform identity wire), REQUIRED on a purchase document; membership asserted against the acting tenant before storage. Commerce wire DTOs currently *additionally* require `@IsUUID('4')` — an implementation artifact (§6/§10). | `prisma/commerce/schema.prisma:269-272`; `purchase.service.ts:175-176`; `purchase.dto.ts:184-186` |
| **liaison** | An opaque Core `User.id`, OPTIONAL and CLEARABLE (`null` = "not configured" is a modelled state); when present it must be a member of the acting tenant, and it is re-checked at resolution time. C1-P contract says "opaque TEXT"; the implemented DTO says `@IsUUID('4')`. | `commercial.dto.ts:98-139`; `commercial-liaison.ts:76-84,113`; C1-P:405 |
| **tenant member** | `User` row with `tenantId = <acting tenant>`. Existence + tenant equality ONLY — the adapter deliberately applies **no `status`/`deletedAt` filter**, preserving pre-extraction behaviour ("Changing who may receive a letter is an authorization decision that belongs in a phase of its own"). | `core-user-directory.adapter.ts:28-34, 68-106` |
| **directory search result** | HTTP: `DirectoryMember` — `id, firstName, lastName, email, phone, avatarUrl, status, department, jobTitle, extension, managerId, manager` (allowlist select, tenant-scoped; cross-tenant manager resolves null). In-process port: `DirectoryUserProfile` — same minus email/status. | `directory.service.ts:28-73`; `user-directory.contract.ts:68-75` |
| **actor / current user** | `CommerceActor` produced only by `resolveCommerceActor(req)`: `tenantId` from `RequestContextService` (403 if unresolved — never from body/query/params), `userId` from `req.user.sub ?? req.user.id ?? context.userId ?? null` (may be null for machine contexts), plus requestId/correlationId/ip/userAgent. | `commerce-actor.ts:41-91` |
| **user id at the platform identity wire** | Opaque string, 1..64 chars, never parsed, membership decided by Core. | `identity.contract.ts:79-103` |

---

## 4. Identity Lifecycle / Ownership Map, and Real Data Flow

### Ownership map

| Lifecycle step | Owner | Surface | Notes |
|---|---|---|---|
| Identity creation | Core (auth) | `POST /auth/register` → `UsersService.create` → Prisma `uuid()` default | No `tenantId` at creation; VISITOR role self-assigned (`auth.service.ts:160-190`). |
| Identity bootstrap (admin) | Core (seed) | `prisma/seed.ts` | Creates `super-admin-user`; **does not create a tenant or set `tenantId`** (see §7). |
| Tenant creation | Core | `TenantService.create` — **no HTTP route** | Tests/scripts call Prisma directly. |
| Membership assignment | Core | `TenantService.assignUserToTenant` — **no HTTP route** | Exercised only by direct DB writes in tests/QA. |
| Token issuance (`tid`) | Core | `AuthService.login` → `TokenIssuer` | `tid = dbUser.tenantId` (may be `null` → tenantless session). |
| Tenant resolution | Platform port | `CoreTenantResolver` (claim-first; Core DB bridge for legacy tokens) | `source: 'claim' | 'core-database' | 'none'` (`core-tenant-resolver.ts:35-53`). |
| Directory reads | Core | `USER_DIRECTORY` port + `GET /users/directory[/:id]` | Same membership predicate in both. |
| Identity reads from a separate runtime | Core | `platform.identity@v1` signed transport | Same four operations; tenant authority stays with Core. |
| Identity references by Commerce | Commerce | Opaque TEXT columns + `assertMember` | Identity is never duplicated; no cross-DB FK. |

### PATH A — seeded/admin user → … → persisted Commerce field

1. **Seed** upserts `User { id: 'super-admin-user', … }` with no `tenantId` (`seed.ts:103-118`).
2. **Live environment state (outside the repo):** the admin row carries tenant `tenant-test-1` — asserted as a
   measured fact by `module-entitlement-runtime.e2e-spec.ts:44-48, 87-97` and by
   `docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md:20`. **No repo artifact creates `tenant-test-1` or attaches the
   admin to it** — the pre-49h/49i/49j dumps contain no such tenant, and in the pre-49j dump the admin's
   `tenantId` is `NULL` (`backups/core_db_pre_49j.sql:37193-37194`, Tenant COPY at :37051). Membership was
   applied to the live DB by an operator/E2E-era write, not provisioned reproducibly.
3. **Membership = the `tenantId` column**; the directory exposes the row only because that column equals the
   caller's tenant (`directory.service.ts:101-135`).
4. **Directory endpoint** `GET /users/directory?q=` (gate `admin.users.read`) returns the row — email-visible,
   id-visible (`users.controller.ts:90-95`).
5. **Frontend selector** consumes `items[].id`; **it filters out any id that is not UUID v4**
   (`CommerceMemberPicker.tsx:41-49, 165-174`), so `super-admin-user` is found-but-hidden, and the picker's
   empty message says exactly that (`CommerceMemberPicker.tsx:285-290`).
6. **Commerce create DTO**: `POST /commerce/purchase-documents` with `requesterId` → `@IsUUID('4')`
   (`purchase.dto.ts:184-186`) → a non-UUID member is refused **400 at the validation pipe**, before any service
   or membership check. A UUID member passes the DTO, then `assertMember` (step 7).
7. **Service/repository**: `assertMember(actor, requesterId)` (`purchase.service.ts:176`) then the row is
   written to `commerce_db` (`requester_id TEXT`) in the acting tenant.
8. **Real-world workaround observed:** `apps/web/phaseui3-qa-dataprep.mjs:5-7, 53-78` registers a **new UUID-v4
   QA user** and uses it as the requester — because the seeded admin cannot be one.

> End-to-end proof that a *member* is refused purely on format exists only negatively: the frontend spec
> `CommercePurchaseCreateView.spec.tsx:191-216` pins "non-UUID self starts unselected", and the UI-5 report
> records the live reproduction (`docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md:20,40`).

### PATH B — authenticated actor → Commerce service/repository

1. **Authentication**: `JwtAuthGuard` → `JwtStrategy.validate`; asymmetric → principal from claims (`sub`,
   `tid`, `perm`, no Core read); legacy → Core row + `tokenVersion` compare (`jwt.strategy.ts:99-137`).
2. **Tenant context (guard phase)**: `TenantContextGuard` asks the `TenantResolver` port and *patches*
   `RequestContextService` (`tenant-context.guard.ts:71-102`); `TenantContextInterceptor` is the fallback for
   routes reached without it, resolving at most once (`tenant-context.interceptor.ts:40-74`).
3. **Authorization**: global `RolesGuard` + `@Roles(Permissions.…)` against `PermissionSource`; then the
   controller-level `ModuleEntitlementGuard` (module must be a member/entitled for the tenant).
4. **Actor**: `resolveCommerceActor(req)` — `tenantId` from context (403 when unresolved, exact message),
   `userId` from `sub`/`id`/context/`null` (`commerce-actor.ts:69-91`).
5. **Service/repository**: services scope by `actor.tenantId`; repositories add `tenant_id = actor.tenantId`
   to every query; identity questions only via the gateway. Cross-tenant reads are 404; DTO-supplied
   `tenantId` is rejected by the global pipe (`whitelist` + `forbidNonWhitelisted`).
6. **G7 verified**: an authenticated principal with no resolvable tenant is refused 403 by Commerce itself
   before any write (`commerce-integration.e2e-spec.ts` header §G7).

---

## 5. Tenant Membership Contract

**What membership IS (today, source-backed):**

- `User.tenantId === actor.tenantId`, evaluated by `filterTenantMembers`/`findTenantMember`
  (`core-user-directory.adapter.ts:68-95`).
- One tenant per user, nullable. `null` = member of no tenant = invisible to every tenant-scoped surface.
- `onDelete: SetNull` on the tenant relation: deleting a tenant silently un-members its users.
- IDs only: `filterTenantMembers` answers "these are mine" and never names a foreign user
  (`user-directory.contract.ts:94-101`).

**What membership is NOT (today, source-backed):**

- Not a lifecycle check: no `status`, no `deletedAt`, no active-window filter — deliberately
  (`core-user-directory.adapter.ts:28-34`). A suspended/inactive-but-present account is still a member.
- Not a role/permission fact: the directory grants nothing; `RolesGuard` decides actions separately.
- Not provisioned by any first-class surface: assignment is a direct DB write today (§4/E).

**Guarantees Commerce currently gets at the boundary (`assertMember`):**

| Question | Guarantee |
|---|---|
| Non-existent user id | Refused 400 (not in the member set). |
| Foreign-tenant user id | Refused 400 (not in *this* tenant's member set) — and the id is not echoed. |
| User with `tenantId = null` | Refused 400 (never a member of any tenant). |
| User who is not a member | Refused 400. |
| Deleted user (row gone) | Refused 400. |
| Inactive/suspended-but-present user | **Accepted** — no lifecycle filter, by documented decision. |
| Directory-invisible user | No such concept: directory visibility *is* the same membership predicate. |
| Empty/null id | `assertMember` passes on `null`/`undefined` (field optionality is the caller's rule); required fields (`requesterId`) can never be empty because the DTO requires a non-empty string. |

**Paths where a syntactically valid id could still be “wrong” (reported, not judged):**

1. **Wrong format, right membership** — `super-admin-user`: refused by the DTO before membership is ever
   consulted. This is the GAP-8 symptom: the *format* check rejects a valid member.
2. **Lifecycle** — an inactive/suspended member is accepted as requester/liaison/approver; no rule today says
   otherwise (adapter decision above). This is undefined-by-contract, not merely untested.
3. **Provisioning** — a freshly registered user (tenantId `null`) is a non-member of *every* tenant until a
   direct DB write assigns a tenant; there is no API for it.

---

## 6. The Commerce Boundary — every identity-bearing contract

### 6.1 Identity fields on the wire (Core identity references)

| DTO field | Validators today | Enforcement after DTO | File:line |
|---|---|---|---|
| `CreatePurchaseDocumentDto.requesterId` (required) | `@IsUUID('4')` | `assertMember` before write | `purchase/purchase.dto.ts:185`; `purchase.service.ts:176` |
| `UpdatePurchaseDocumentDto.requesterId?` | `@IsUUID('4')` | `assertMember` when stated | `purchase.dto.ts:229`; `purchase.service.ts:294-296` |
| `ListPurchaseDocumentsQueryDto.requesterId?` (filter) | `@IsUUID('4')` | Tenant-scoped repository predicate only (no membership assert — a filter, not a reference) | `purchase.dto.ts:270` |
| `CreateCommercialGroupDto.liaisonUserId?` | `@IsUUID('4')` | `CommercialLiaisonResolver.assertTenantMember` before the row exists | `commercial.dto.ts:110`; `commercial-configuration.service.ts:133-141` |
| `UpdateCommercialGroupDto.liaisonUserId?: string \| null` | `@IsUUID('4')` | assert on write when stated non-null; `null` clears without a check | `commercial.dto.ts:137`; `commercial-configuration.service.ts:179-185` |
| `CreateCommercialConfigurationDto.approverUserId?: string \| null` | `@IsUUID('4')` | `isTenantMember` → `COMMERCIAL_CONFIGURATION_INVALID` at validate/publish | `commercial.dto.ts:218`; `commercial-configuration.service.ts:629` |
| `UpdateCommercialConfigurationDto.approverUserId?: string \| null` | `@IsUUID('4')` | same validate/publish checklist | `commercial.dto.ts:282`; `commercial-configuration.service.ts:629` |
| Workflow step `actorUserId?: string \| null` (create **and** update step DTOs) | `@IsString() @MaxLength(64)` — **no UUID** | `assertConfiguredActorMember` → `assertMember` when `actorSource = CONFIGURED_USER` | `workflow-configuration.dto.ts:259-263, 346-349`; `workflow-configuration.service.ts:707-715` |

**The boundary is internally inconsistent.** The same platform value is accepted by `actorUserId` (opaque,
≤64) and refused by `requesterId`/`liaisonUserId`/`approverUserId` (v4). The frontend comment
(`CommerceMemberPicker.tsx:41-48`) asserts all four are `@IsUUID('4')` — factually wrong for `actorUserId`,
whose DTO mirrors the platform identity wire exactly (including the 64-char bound).

### 6.2 `@IsUUID('4')` on Commerce-owned ids — correct, and NOT part of GAP-8

These name `commerce_db` rows generated by the app (`@default(uuid())`) and/or by route `ParseUUIDPipe`; v4 is
their real contract. They must not be touched by any GAP-8 remediation:

- `receiving/dto` `purchaseLineId` (`receiving.dto.ts:57`); `return.dto` `purchaseLineId`, `receiptLineId`,
  `paymentId` (:76, :79, :188); `workflow-execution.dto.ts:47` `subjectId` (a purchase-document id);
  `workflow-line-routing.dto.ts:94` `targetWorkflowDefinitionVersionId`; `workflow-configuration.dto.ts:389`
  step-id list; `commercial.dto.ts:169` `commercialGroupId`, `:303` `documentId`, `:320/:323` `lineId`/`groupId`.
- Path params use `ParseUUIDPipe` (documented in `PHASE-C1-R`/`S` contracts: "a non-UUID in either position is
  400").

---

## 7. Seed / Fixture Findings

### 7.1 The three identity values that matter

| Value | Where | Classification |
|---|---|---|
| `super-admin-user` (admin `User.id`) | `prisma/seed.ts:107`; live DB (`backups/core_db_pre_49j.sql:37194`); referenced by `module-entitlement-runtime.e2e-spec.ts:97`, `media.e2e-spec.ts:67`; JWT `sub` in live session | **Contract-incompatible with Commerce's DTOs; contract-COMPLIANT with the platform's identity model** (opaque TEXT — §3.A). It is the canonical example the platform's own docs cite. |
| `tenant-test-1` (admin's tenant) | Live DB only; cited by HR migration `:8,22`, `module-entitlement-runtime.e2e-spec.ts:88`, `hr.e2e-spec.ts:55,270` | **Unclear / not repository-managed.** No seed, migration, compose file or script in the repo creates it (searched). It exists only in the running dev database. |
| QA decider (`ui3-qa-decider@example.com`, UUID v4) | `phaseui3-qa-dataprep.mjs:21-78` | **Contract-compliant** (registered through the public path; id minted by Prisma default). Created precisely because the admin cannot be used. |

### 7.2 The seed is broken regardless of the UUID question — three findings

1. **It does not create a tenant and does not set `tenantId`.** `prisma/seed.ts:103-118` upserts the user with
   no tenant. A fresh `db:seed` therefore produces an administrator whose login succeeds but whose `tid` is
   `null` — and every tenant-scoped surface (Commerce included) refuses with 403
   (`core-tenant-resolver.ts:44-53` → `commerce-actor.ts:71-77`). The documented live state (admin in
   `tenant-test-1`) **cannot be reproduced from the repository**; it was applied out-of-band (see §4/PATH A.2).
2. **It hard-codes a non-UUID id with three fixed-value companions** (`super-admin-role`, `admin-role`, …,
   `super-admin-user-role`). Role ids are internal-only (safe), but the user id is exactly the value Commerce
   DTOs refuse.
3. **`prisma/seed.js` is a stale duplicate of the same seed** (`seed.js:36-71`, `id: 'super-admin-user'`). Only
   `prisma/seed.ts` is wired (`package.json` `prisma.seed` / `db:seed`), so `seed.js` is dead code — but a
   fork hazard for whoever edits “the seed” next.

### 7.3 Fixture audit (E2E + QA)

| Fixture | Identity values | Classification | Note |
|---|---|---|---|
| `test/commerce-integration.e2e-spec.ts`, `commerce-tenant`, `commerce-lifecycle`, `commerce-search` | `randomUUID()` users in an **in-memory registry**; fake `UserDirectoryContract`, fake resolver, fake entitlement | **Contract-compliant but integration-free** | No Core identity, no real directory, no real tenant row is exercised. GAP-8 cannot be caught by these suites *by construction*. |
| `test/users-directory.e2e-spec.ts` | Users created via Prisma (DB-generated UUIDs), real DB, real interceptor, real `RolesGuard`, stubbed `PermissionSource` | **Compliant; real-path** | Proves directory isolation/privacy, but not the port, not Commerce. |
| `test/module-entitlement-runtime.e2e-spec.ts` | Constants `ADMIN_USER_ID = 'super-admin-user'`, `ADMIN_TENANT_ID = 'tenant-test-1'` | **Pinned to the live, non-reproducible seed state** | If the seed is ever changed, this constant (and its `afterAll` cleanup assumptions) breaks — a coupling the remediation must plan for. |
| `test/media.e2e-spec.ts:67` | `loginBody.id \|\| 'super-admin-user'` fallback | Pinned to the same value | Same coupling. |
| `test/hr.e2e-spec.ts:55,270` | `tenant-test-1` | Pinned to live state | Same. |
| `apps/web/phaseui3-qa-dataprep.mjs` | Registers a fresh v4 user; assigns ADMIN role via `/rbac/assign-role`; **cannot assign membership via HTTP** | **Process gap, values compliant** | Membership assignment happened out-of-band (`.tmp/ui3-qa-membership.sql`). |
| `.tmp/ui3-qa-membership.sql` | `UPDATE "User" SET "tenantId"='tenant-test-1' …` | **Evidence of the missing provisioning surface** | Its own header records the absence as a finding. |

### 7.4 Live-database audit (read-only, from the dumps)

- `core_db_pre_49j.sql` User COPY (`:37193`) → the `super-admin-user` row (`:37194`) has
  `tenantId = NULL` and `updatedAt 2026-08-27`.
- No `tenant-test-1` row exists in `core_db_pre_49h.sql`, `core_db_pre_49i.sql` or `core_db_pre_49j.sql`
  (searched; only doc/comment references exist elsewhere).
- Conclusion: the tenant and the membership were introduced to the live DB **after** the 49j dump and **outside**
  every repository artifact — confirming finding 7.2.1.

---

## 8. Frontend Contract Audit

**The picker** — `apps/web/src/components/commerce/settings/CommerceMemberPicker.tsx`:

- **Exact API it calls:** `GET /users/directory?q=<text>&limit=20` via `fetchDirectory`
  (`directory-api.ts:75-77`), plus `GET /users/directory/:id` for display-name resolution of an existing value
  (`:79-81`). Both go through `coreGet` (session token reuse, `{ data }` envelope unwrap).
- **Exact returned id field:** `items[].id` (`DirectoryMember.id`, `directory-api.ts:25`). `directory-api.ts`
  mirrors the backend shape field-for-field.
- **Identifier format:** whatever the server returns; the UI then **filters to UUID v4** with
  `STORABLE_MEMBER_ID` (`CommerceMemberPicker.tsx:41-49`, applied at `:171`), and reports “found but unusable”
  when the filter removed rows (`:285-290`).
- **Permission gate:** `enabled` prop = caller's `admin.users.read` (the route's own gate,
  `users.controller.ts:90-92`); without it the picker renders a limitation note, issues **no request**, and can
  only display a pre-existing value (`:184-201`). The purchase view computes it at
  `CommercePurchaseCreateView.tsx:196`.
- **Arbitrary ids typed/submitted?** No. The purchase requester is select-only (read-only statement + picker,
  `UI-5-A` decision); the picker has no paste-id path — only search + click (`:293-313`). Client-side Zod
  validation repeats the v4 rule (`CommercePurchaseCreateView.tsx:74,115`).
- **Cross-tenant selection?** Impossible by construction: the directory is tenant-scoped server-side
  (`directory.service.ts:105`), a foreign id is a 404 (`:137-149`), and the picker consumes only that list.
- **Nullable/clearable?** `allowClear` defaults true (liaison, step actor) but is **false for the requester**
  because `CreatePurchaseDocumentDto.requesterId` is required (`CommerceMemberPicker.tsx:128-134`;
  `CommercePurchaseCreateView.tsx:200-208`).
- **UI vs backend DTOs:** the picker deliberately matches the *DTO* (v4 filter) rather than the *platform
  contract* — that is the GAP-8 workaround: a real tenant member (`super-admin-user`) is a member the backend's
  `assertMember` would accept, but which the DTO refuses, so the UI hides it
  (`CommerceMemberPicker.tsx:41-48`; `CommercePurchaseCreateView.spec.tsx:191-216`).
- **Self-default:** used only when the session's own id is v4; otherwise the form starts unselected with
  «کاربری انتخاب نشده است» (`CommercePurchaseCreateView.tsx:200-208`).

No UI redesign is proposed by this preflight; the frontend's v4 assumptions are a faithful mirror of the
backend's current DTOs.

---

## 9. Test Contract Audit

### 9.1 What is currently proven

| Property | Test | Notes |
|---|---|---|
| `requesterId` must be UUID v4 on create | `purchase.dto.spec.ts:199-203` | “requires a UUID requester, because the id is verified against the tenant before it is stored” — the assertion couples format to membership; the two are actually separate checks. |
| `requesterId` filter exists and no `mine` flag | `purchase.dto.spec.ts:334-337` | “the requester filter is an id the service can verify”. |
| `assertMember` called before write; refusal surfaces as `BadRequestException` | `purchase.service.spec.ts:257-259, 395-400, 559-562` | With a **mocked** identity gateway. |
| Only one file in Commerce names `USER_DIRECTORY`; gateway exposes exactly `assertMember` + `profilesFor` | `commerce-gateways.spec.ts:147-167` | Structural gate I7. |
| Directory authorization, tenant isolation, 404-not-403 for foreign ids, privacy projection, search isolation, pagination | `users-directory.e2e-spec.ts:226-282, 408` (real DB) | The strongest identity tests in the repo — but they cover `DirectoryService`, not the `USER_DIRECTORY` port and not Commerce. |
| Port adapter: ids-only membership answers, null for non-member/missing, dedupe+bound, allowlist select | `user-directory.spec.ts:105-127` | Prisma **mocked**; no real database. |
| Frontend: no directory call without `admin.users.read`; non-UUID self starts unselected and blocks step 1 | `CommercePurchaseCreateView.spec.tsx:182-216` | Pins the GAP-8 workaround behaviour. |
| Commerce E2E tenant isolation incl. `liaisonUserId: userA2` (in-memory) | `commerce-integration/tenant/lifecycle/search.e2e-spec.ts` | All identity is faked; the suites' own headers state the seams. |

### 9.2 Missing assertions (the GAP-8 blind spots)

1. **No test connects the REAL directory to Commerce.** `CoreUserDirectoryAdapter.filterTenantMembers` is
   exercised only against a mocked Prisma; Commerce E2E binds a fake directory. Nothing proves that a real
   Core row passes `assertMember` through the real adapter under a real tenant.
2. **No seed-conformance test.** Nothing asserts that `db:seed` output is usable: admin exists, has a
   `tenantId`, and its id is acceptable to the consumers that will name it (Commerce today).
3. **No bootstrap-completeness test.** Nothing asserts a fresh seed creates the tenant + membership the docs
   claim (`tenant-test-1`), so the repository cannot reproduce its own documented environment.
4. **No negative test for a non-member that IS well-formed** at the Commerce HTTP boundary with a real stack
   (only service-level mocks) — i.e., the “foreign/absent member → 400” path through DTO→service→gateway→adapter
   is unproven end-to-end.
5. **No assertion that the seeded administrator can be a requester** (obviously — see 2/3).
6. **No lifecycle assertion** — nothing pins the accepted behaviour for an inactive-but-present member either
   way; the adapter's no-filter decision has no regression test at the Commerce boundary.

---

## 10. Exact GAP-8 Classification

### **MIXED** — three objectively present defects, in this order of authority

**10.1 CONTRACT MISALIGNMENT (present, primary).**

Two authoritative components disagree about what a Core identity reference is allowed to look like:

- **Platform/Core side (opaque string):** schema `String`/TEXT; Core's own signed identity wire accepts
  `@IsString() @MaxLength(64)` and states ids "are OPAQUE"; the C1 bounded-context contract and the C1-P
  contract call `requesterId`/`liaisonUserId` "opaque values"/"opaque TEXT"; the platform's own seed and live
  tenant prove non-UUID values are legitimate platform data.
- **Commerce DTO side (UUID v4):** `requesterId`, `liaisonUserId`, `approverUserId` × the DTOs listed in §6.1
  — **including the field the UI-5 report calls the GAP-8 case** — are `@IsUUID('4')`, while the same module's
  `actorUserId` follows the platform rule (`@IsString() @MaxLength(64)`).

The contradiction is *internal to Commerce as well* (§6.1), and it contradicts the module's own declared
contract (`PHASE-C1-P:405`) and its own persistence documentation ("opaque … `@db.Text`").

**10.2 DATA / SEED MISALIGNMENT (present, independent of 10.1).**

- `prisma/seed.ts` mints `super-admin-user` and **never creates a tenant or a membership** → a fresh seed
  produces an admin who cannot act in any tenant (403 everywhere) — the live state is not reproducible.
- The live admin's tenant (`tenant-test-1`) and membership exist only in the running database, applied outside
  every repository artifact (§7.4).
- `prisma/seed.js` is a stale duplicate of the same wrong-by-consumer-standards seed.
- QA fixtures and E2E constants are pinned to the live values (`super-admin-user`, `tenant-test-1`).

**10.3 RUNTIME VALIDATION GAP (present, bounded — not the GAP-8 symptom).**

- Membership **is** enforced (existence + tenant equality, fail-closed 403 when no tenant) — there is no path
  by which a foreign-tenant, non-member, `tenantId = null` or deleted user is accepted (§5 table).
- What is *not* guaranteed: **lifecycle** (inactive/suspended-but-present members are accepted — documented,
  not accidental) and **provisioning** (membership has no first-class surface; even the register path leaves
  `tenantId` null). These are gaps in the *contract's completeness*, exploitable only by insiders with DB
  access today; they do not weaken the tenant boundary.

**10.4 Why NOT "CLOSED" and why NOT "'DATA/SEED' only".**

The seed is not the only broken component: even with a perfect seed, Commerce's own validator set still
disagrees with the platform's identity contract and with its own `actorUserId`/schema/C1-P statements.
Conversely the contract misalignment alone does not explain the tenantless-admin and non-reproducible
`tenant-test-1` state. Both are real; hence **MIXED**.

**10.5 Why NOT "DATA/SEED MISALIGNMENT" in the naive reading ("platform wants v4, seed gives non-v4").**

Because no platform source requires v4 (§3.A.7 / §10.1). The only component that *states* v4 as a requirement
is the DTO layer of Commerce and HR; everything that *owns* identity says "opaque". The preflight therefore
does **not** accept the pre-phase hypothesis; it reverses it: `super-admin-user` is contract-compliant with
the platform and contract-incompatible only with certain DTO validators.

---

## 11. Evidence-Backed Remediation Contract (NOT implemented)

The plan below is **not** executed in this phase; it is the contract the implementation prompt should be
written against. It is ordered so that each step is independently verifiable.

### 11.1 Authoritative decisions this plan takes (all source-backed)

| Decision | Value | Basis |
|---|---|---|
| Authoritative identity type | **Opaque string** (Core `User.id`; TEXT; bounded ≤64 at the platform identity wire). UUID v4 is the *mint default*, not a rule on references. | §3.A |
| Canonical owner of identity | **Core** (User table; `POST /auth/register`; seed bootstrap). | §4 |
| Canonical owner of tenant membership | **Core** (`User.tenantId`); assignment is a Core-side provisioning concern. | §3.C/§4 |
| The membership boundary | **`CommerceIdentityGateway.assertMember` stays as-is** — unchanged semantics, unchanged refusal, unchanged single-surface gate. | §6 |
| `@IsUUID('4')` on Commerce-owned row ids | **Stays** (they are app-generated v4). | §6.2 |

### 11.2 The smallest remediation — two mandatory workstreams

**Workstream 1 — identity-reference contract alignment (the GAP-8 fix).**

Change the seven Core-identity DTO fields (§6.1) from `@IsUUID('4')` to the platform's own identity-wire rule
as already implemented next door: `@IsString() @MaxLength(MAX_IDENTITY_USER_ID)` (=64, mirroring
`MAX_IDENTITY_USER_ID` in `platform/identity/identity.contract.ts:80`, or importing that constant to avoid a
second bound). Concretely:

- `purchase.dto.ts:185, 229, 270` (`requesterId` × 3)
- `commercial.dto.ts:110, 137, 218, 282` (`liaisonUserId` × 2, `approverUserId` × 2)
- Leave `workflow-configuration.dto.ts` `actorUserId` untouched (it already matches).

Why this is not “weakening validation”: the check that protects the tenant is `assertMember` and it is
untouched; the format check was never a security control (the value is stored as opaque TEXT and has no FK).
This is the only change that makes Commerce agree with the platform contract, with C1-P's own "opaque TEXT"
statement, with Commerce's own `@db.Text` documentation, and with its own `actorUserId` precedent.
The wire change is **widening-only** — no request that is accepted today becomes refused; previously-400
opaque ids become admissible and are then membership-checked as usual. Field names, shapes, endpoints and
error codes for genuine non-members do not change.

**Workstream 2 — reproducible platform bootstrap (independent of Workstream 1).**

`prisma/seed.ts` must become a complete, idempotent bootstrap:

- create (upsert) the bootstrap tenant and the administrator's membership (`tenantId`) — today neither exists
  in the seed, and a fresh database yields a tenantless admin who 403s everywhere;
- keep the admin's id **format decision** explicit (see 11.3 fork) and, whichever way it goes, make the seed
  the single source of the documented environment;
- reconcile or delete the stale `prisma/seed.js` so there is exactly one seed;
- update the constants that are pinned to the live values (`module-entitlement-runtime.e2e-spec.ts:88,97`,
  `media.e2e-spec.ts:67`, `hr.e2e-spec.ts:55,270`) to read from the seed/actual state rather than re-typing
  it, so the next seed change cannot silently pass or fail.

**Not part of this plan (separate platform decisions, deliberately not invented here):**

- an HTTP surface for tenant creation / membership assignment (recorded as a platform gap in §4/E — no
  current GAP-8 consumer requires it, since tests/QA can and do assign membership directly);
- any lifecycle/status rule for membership (§5 — "who may be named" is an authorization decision whose phase
  is not this one; inventing it now would be an invented business rule).

### 11.3 The one fork that must be decided by the implementation prompt

**Fork A (recommended, evidence-backed): platform contract is opaque → Workstream 1 as written.**
The seed may keep `super-admin-user` (no id churn, no audit-history churn, matches the platform's own canon),
and the frontend v4 filters are removed (see 11.4).

**Fork B (alternative): declare “Core mints UUID v4 ids” normative → skip Workstream 1, re-key the seed.**
This requires a platform-level statement + re-keying the admin id in seed and live DB, updating every
constant/docs reference, AND still leaves (a) the `actorUserId` vs `requesterId` inconsistency, (b) any future
non-v4 Core id (import/SSO/legacy) refused, and (c) HR's parallel mismatch (out of scope) in place. It also
requires HrEmployee/admin-id adoption. It is *larger*, not smaller, which is why it is the alternative.

If the fork is not decided, the safe default is A: it is the only option that makes all four authoritative
sources agree and it touches no security boundary.

### 11.4 Frontend changes required — only under Fork A, and only to stop hiding members

- Remove the v4 filters that exist solely because of this mismatch:
  `STORABLE_MEMBER_ID` in `CommerceMemberPicker.tsx:41-49,171` (and the “found but unusable” branch), the
  requester `UUID_PATTERN` gate in `CommercePurchaseCreateView.tsx:74,115,208`, and the UI-5 comment block that
  documents the workaround (`CommerceMemberPicker.tsx:41-48`; `CommercePurchaseCreateView.tsx:200-208`).
- Keep everything else: permission gate, tenant-scoped search, select-only requester, `allowClear=false` for
  the requester. No redesign.
- Under Fork B: no frontend change (the filters become correct), but the picker still cannot offer
  non-v4 members — so no frontend work either way beyond this fork.

### 11.5 Test additions (the assertions §9.2 says are missing)

1. **Seed-conformance test** (new, backend): after `db:seed` against a clean database, the administrator
   exists, has a non-null `tenantId`, belongs to an existing `Tenant`, and its id is accepted by the Commerce
   identity fields (whichever fork is chosen, the test asserts the chosen contract).
2. **Real-directory integration** (new, backend): wire the **real** `CoreUserDirectoryAdapter` as the
   `USER_DIRECTORY` binding for a Commerce test app (or exercise it through the `platform.identity@v1` route
   in-process) and assert: (a) a seeded/minted member passes `assertMember`; (b) a foreign-tenant id and a
   non-existent id each produce the 400 with the exact message; (c) `profilesFor` hydration returns only the
   allowlist. Today only fakes prove this.
3. **DTO spec updates**: the seven fields' spec expectations switch from “refuses non-UUID” to
   “accepts opaque ≤64; refuses empty / >64 / non-string” (Fork A), or gain a v4 assertion update if Fork B.
   Keep the existing `tenantId`-refusal and `mine`-refusal assertions untouched.
4. **Frontend spec updates**: replace `CommercePurchaseCreateView.spec.tsx:191-216` (“non-UUID self starts
   unselected”) with its Fork-A counterpart (“self-default works for the seeded admin”), plus a picker spec
   proving a non-v4 member is listed.
5. **Regression guard**: keep §6.2's Commerce-owned-id UUID tests exactly as they are, so the alignment cannot
   creep from identity references into resource ids.

### 11.6 Is an API contract change necessary?

- **Under Fork A:** yes, a **validation-widening** change on seven fields (same paths, same JSON shapes, no
  new/removed fields, no new error codes for genuine violations). No client is forced to change; the frontend
  change (11.4) is required only to *reveal* members that were previously hidden, not to remain functional.
- **Under Fork B:** no API change; instead a platform-level normative statement plus a seed/live re-key and
  fixture/doc updates.
- **Either way:** no new endpoints, no new permissions, no schema or migration change (the columns are already
  TEXT; nothing validates the tenant on the wire).

### 11.7 Explicit things that must NOT change in the implementation phase

- `CommerceIdentityGateway.assertMember` / `profilesFor` semantics, its single-surface gate
  (`commerce-gateways.spec.ts` I7) and the exact non-member refusal.
- `resolveCommerceActor` / tenant resolution / `RequestContextService` scoping / `RolesGuard` /
  `ModuleEntitlementGuard` / `admin.users.read` gating.
- Commerce-owned id validation (`@IsUUID('4')` on document/line/group/version/payment ids) and all
  `ParseUUIDPipe` path params.
- `User`/`Tenant` schema, `User.tenantId` semantics, `onDelete: SetNull`, the directory projections, the
  `platform.identity@v1` contract, the `UserDirectoryContract` port.
- No new permissions, no new endpoints, no membership/lifecycle rules invented, no HR module changes, no
  compatibility shims outside the two workstreams.

---

## 12. Explicit Non-Goals

1. No implementation, no speculative fix — this report is the only artifact.
2. No weakening, removal or bypass of any authorization check; membership remains the boundary.
3. No new identity model, no membership table, no invite model, no "virtual" ids, no aliasing table.
4. No new permissions or API surfaces.
5. No changes to Commerce-owned id validation or RBAC.
6. No HR-side remediation (HR has the same class of mismatch — documented in its own migration — but GAP-8's
   scope is Commerce; cross-module alignment would be its own phase).
7. No seed/fixture/migration edits in this phase.

---

## 13. STOP / BLOCKED Status

**Not blocked.** The preflight found one authoritative identity contract (opaque string; Core-owned) with
enough source agreement to classify GAP-8 and to specify a minimal, non-weakening remediation:

- an authoritative contract **can** be established (§3);
- a single owning source exists (Core) — the conflicting DTOs are implementers, not owners (§10.1);
- membership semantics are defined, if deliberately minimal: existence + tenant equality (§5);
- nothing about the fix requires weakening validation, bypassing authorization, or accepting arbitrary ids —
  `assertMember` remains the boundary and is untouched by the recommended plan (§11.2/§11.7).

**Two decisions are handed to the implementation prompt, not resolved here:**

1. **The fork (§11.3):** adopt the platform's opaque contract in Commerce (recommended, Fork A) vs declare
   UUID v4 normative and re-key the seed (Fork B). Evidence favors Fork A; the prompt owner must choose.
2. **Membership provisioning / lifecycle** (§5, §11.2 last block): whether any first-class surface or lifecycle
   rule is wanted — explicitly out of the minimal plan; inventing it now would violate the "no invented
   business rules" constraint.

---

## Appendix — Evidence index (one-line lookup)

| Claim | Evidence |
|---|---|
| Identity is TEXT with a v4 *default* | `prisma/core/schema.prisma:151,176` |
| Membership is a nullable column, not a table | `prisma/core/schema.prisma:199-200` |
| Platform identity wire = opaque ≤64 | `platform/identity/identity.contract.ts:79-103` |
| C1 contract says these references are opaque | `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md:290-301` |
| C1-P says liaison is opaque TEXT | `docs/PHASE-C1-P-COMMERCIAL-FOUNDATION-CONTRACT.md:405` |
| Rendered precedent for opaque identity in Commerce | `workflow-configuration.dto.ts:259-263,346-349` |
| Commerce identity columns are `@db.Text` "opaque" | `prisma/commerce/schema.prisma:20-28,269-272,1412,1477,1652` |
| Seed mints `super-admin-user`, no tenant/membership | `prisma/seed.ts:103-118`; `seed.js:36-71` |
| Live admin row had `tenantId = NULL` pre-49j | `backups/core_db_pre_49j.sql:37193-37194` |
| `tenant-test-1` is live-only | HR migration `20260916120000_hr_tenant_identifier_text/migration.sql:8,22`; `module-entitlement-runtime.e2e-spec.ts:88` |
| Membership has no HTTP surface | `tenant.service.ts:41-46` + no controller; `.tmp/ui3-qa-membership.sql:1-3`; `app.e2e-spec.ts:936-939` |
| Commerce validation, per field | §6.1 table |
| `assertMember` = the tenant boundary | `commerce-identity.gateway.ts:105-115`; callers §3.D |
| Directory is tenant-scoped; 404-not-403 | `directory.service.ts:101-152`; `users-directory.e2e-spec.ts:250-282` |
| `admin.users.read` gates + seeding | `users.controller.ts:75-102`; migration `20260828093000_…/migration.sql:23,42-62` |
| Frontend filters v4 as a workaround | `CommerceMemberPicker.tsx:41-49,171`; `CommercePurchaseCreateView.tsx:74,115,200-208` |
| Prior GAP-8 records | `docs/PHASE-UI-0-COMMERCE-UX-CONTRACT.md:1481-1486,1591-1607`; `docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md:20,40` |

*End of preflight report. No runtime, schema, DTO, seed, fixture or frontend file was modified by this phase.*
