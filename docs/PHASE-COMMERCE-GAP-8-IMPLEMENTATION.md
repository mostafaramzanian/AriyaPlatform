# Phase Commerce GAP-8 — Implementation Record

**Status:** Implemented. Fork A adopted (platform identity is an opaque bounded string).
**Scope:** (1) Commerce's Core-identity references stop assuming UUID v4; (2) `prisma/seed.ts`
becomes a complete, idempotent, reproducible platform bootstrap.
**Authority:** `docs/PHASE-COMMERCE-GAP-8-PREFLIGHT.md` §11.2 (Workstreams 1 and 2), §11.3
(the fork), §11.4 (frontend), §11.5 (tests), §11.7 (things that must not change).

---

## 1. The gap, stated once

Commerce validated seven fields that name a **Core `User.id`** with `@IsUUID('4')`
(`purchase.dto.ts` `requesterId` ×3; `commercial.dto.ts` `liaisonUserId` ×2,
`approverUserId` ×2), while the platform's own identity contract already declared that
identity an **opaque string, 1..64 characters**
(`platform/identity/identity.contract.ts:80`, `MAX_IDENTITY_USER_ID = 64`) and the columns
that store it are `TEXT` in both databases. The two disagreed only about *shape*, and the
seeded administrator's id (`super-admin-user`) sat on the wrong side of that disagreement:
a fresh, correctly-seeded database could log in as the administrator and then have every
Commerce write refused — not by the membership boundary, but by a format rule nothing in
the platform required.

Two independent defects produced that outcome, and the remediation treats them as two
independent workstreams:

1. **Identity-reference contract drift** (the `@IsUUID('4')` fields).
2. **An incomplete bootstrap** (`prisma/seed.ts` created the administrator with no
   `tenantId`, so the documented environment could not be reproduced from the repository;
   a stale `prisma/seed.js` shadowed it).

## 2. The decision — Fork A (and why)

The preflight offered two directions (§11.3). **Fork A** was adopted: **the platform
contract is the authoritative one, and Commerce aligns to it.** On the seven Core-identity
fields the platform identity rule (`@IsString() @MaxLength(64)`) **replaces** `@IsUUID('4')`;
the admin id is *not* re-keyed.

Chosen because it is the only option under which **all four authoritative sources agree**
and **no security boundary is touched**: the membership check (`assertMember`) is
untouched, the columns are already `TEXT`, nothing validates a tenant on the wire, and the
change is *widening-only* — no request accepted today becomes refused. Fork B ("declare
UUID v4 normative, re-key the seed") was rejected: it is larger (a platform-level normative
statement plus a live re-key plus fixture churn), it would still refuse any future non-v4
Core id (import/SSO/legacy), and it would leave the `actorUserId`-vs-`requesterId`
inconsistency in place.

The governing sentence, unchanged from the preflight: **the DTO decides shape; the gateway
decides membership.**

## 3. What changed

| WS | Where | Change |
|----|-------|--------|
| 1 | `src/modules/commerce/purchase/purchase.dto.ts` | 3 × `requesterId` → `@IsString() @IsNotEmpty() @MaxLength(64)` on create; `@IsOptional() @IsString() @IsNotEmpty() @MaxLength(64)` on update and list |
| 1 | `src/modules/commerce/commercial/commercial.dto.ts` | 4 × `liaisonUserId`/`approverUserId` → `@IsOptional() @IsString() @MaxLength(64)` |
| 2 | `prisma/seed.ts` | upserts the bootstrap tenant `tenant-test-1` and the administrator `super-admin-user` **with `tenantId`**; idempotent on every run; `super-admin-user` id kept (no churn) |
| 2 | `prisma/seed.js` | deleted — one seed, not two |
| 2 | `test/fixtures/seed-environment.ts` (new) | the single source of the bootstrap constants (`SEED_BOOTSTRAP_TENANT_ID`, `SEED_ADMIN_USER_ID`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`) **and** `runDbSeed()`, which executes the repository's own `npm run db:seed` |
| 4 | `test/module-entitlement-runtime.e2e-spec.ts`, `test/media.e2e-spec.ts`, `test/hr.e2e-spec.ts` | the live values are read from the shared fixture instead of re-typed, so the next seed change cannot silently pass or fail |
| 5 | `components/commerce/CommerceMemberPicker.tsx` | removed the `STORABLE_MEMBER_ID` v4 filter and the "found but unusable" branch |
| 5 | `components/commerce/CommercePurchaseCreateView.tsx` | removed the `UUID_PATTERN` requester gate; the self-default is now `sessionUserId.trim()` |

Everything the DTO now accepts is still **membership-checked exactly as before**: an opaque
id is admitted by the DTO and then either survives `assertMember` (it is a member of the
acting tenant) or is refused with the unchanged `400`
`"userId is not a member of this tenant"`.

### 3.1 The frontend workaround, removed

The UI had grown a shim *because* of the mismatch: `CommerceMemberPicker.tsx` dropped
directory members whose id was not v4 (`STORABLE_MEMBER_ID`), and
`CommercePurchaseCreateView.tsx` refused to pre-select a non-v4 self. Both are gone. The
picker now lists every member the tenant-scoped directory returns, and the create view
pre-selects the session user by its own opaque id (`sessionUserId.trim()`).

## 4. What deliberately did NOT change (the boundary, restated)

- `CommerceIdentityGateway.assertMember` / `profilesFor` semantics, the single-surface gate
  (`commerce-gateways.spec.ts` I7), and the exact non-member refusal.
- `resolveCommerceActor`, tenant resolution, `RequestContextService` scoping, `RolesGuard`
  and `ModuleEntitlementGuard`.
- Every `@IsUUID('4')` on a **Commerce-owned** id (document/line/group/version/payment…)
  and every `ParseUUIDPipe` path param. `workflow-configuration.dto.ts` `actorUserId`
  already matched the platform rule and was not touched.
- Core `User`/`Tenant` schema, `User.tenantId` semantics, `onDelete: SetNull`, the
  directory projections, `platform.identity@v1`, `UserDirectoryContract`.

## 5. Tests

| Test | Kind | What it pins |
|------|------|--------------|
| `src/modules/commerce/commerce-identity.gateway.spec.ts` (new) | unit | the membership matrix: opaque id accepted, cross-tenant / unknown / deleted refused with the same message, the id never echoed, `null`/`undefined` a pass, `profilesFor` dedupes and treats absence as data. The directory double is a **structural** fake (`ConstructorParameters<typeof CommerceIdentityGateway>[0]`) because the Step-H guard forbids a spec inside the module importing the platform contract |
| `src/modules/commerce/purchase/purchase.dto.spec.ts` (updated) | unit | `requesterId` accepts an opaque ≤64 value; refuses empty / >64 / non-string; `tenantId` and `mine` refusals untouched |
| `src/modules/commerce/commercial/commercial.dto.spec.ts` (new) | unit | same rules for `liaisonUserId` / `approverUserId` |
| `test/seed-conformance.e2e-spec.ts` (new) | e2e | runs `npm run db:seed` **twice**: the bootstrap tenant and the attached administrator exist, the administrator holds `SUPER_ADMIN`, its id satisfies both the platform and the Commerce wire contracts, and a second run is idempotent |
| `test/commerce-gap8-identity.e2e-spec.ts` (new) | e2e | the **real** `CoreUserDirectoryAdapter` + `CoreTenantResolver` behind the **real** purchase controller: the seeded opaque id is accepted, persisted verbatim and hydrated; a real cross-tenant member, a tenant-less user, a deleted user and an unknown id are each refused with the exact message; >64 / non-string / empty are refused at the pipe (422) |
| `CommerceMemberPicker.spec.tsx`, `CommercePurchaseCreateView.spec.tsx` (updated) | web | the picker lists a non-v4 member; the create view pre-selects a non-v4 self |

The two e2e suites and the DTO/gateway units are what the preflight §11.5 named as missing
("today only fakes prove this"): the real-directory suite is the end of that chain.

## 6. Validation ledger

Every command below was run against the live databases on `localhost:5544` at
implementation time.

| Command | Result |
|---------|--------|
| `npx jest src/modules/commerce` | **46 suites / 710 tests passed** |
| `npx jest --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` | **2 suites / 56 tests passed** |
| `npx tsc --noEmit -p tsconfig.json` (api) | **clean** |
| `npm run type-check` (web) | **clean** |
| `npx jest src/components/commerce` (web) | **14 suites / 164 tests passed** |
| `npx jest --config ./jest-e2e.json --runInBand test/seed-conformance.e2e-spec.ts` | **6 / 6 passed** |
| `npx jest --config ./jest-e2e.json --runInBand test/commerce-gap8-identity.e2e-spec.ts` | **11 / 11 passed** |
| `npx jest --config ./jest-e2e.json --runInBand test/commerce-tenant.e2e-spec.ts` | **26 / 26 passed** |
| `npx jest --config ./jest-e2e.json --runInBand test/commerce-integration.e2e-spec.ts` | **7 / 7 passed** |
| `npx jest --config ./jest-e2e.json --runInBand test/module-entitlement-runtime.e2e-spec.ts` | **19 / 19 passed** |

The Commerce unit and e2e suites are the ones the DTO widening could have disturbed
(cross-tenant `G3`/`G6` refusals, list scoping); they pass unchanged, which is the
evidence that the change was widening-only. `module-entitlement-runtime` is the suite
whose constants WS4 re-pointed at the shared fixture, so its pass is the evidence that
the WS4 re-wiring is behaviour-preserving.

## 7. Operating the environment

The seeded environment is now reproducible from the repository:

```
npm run db:seed          # root; → apps/api: ts-node prisma/seed.ts
```

It is idempotent, so it is safe on every existing database and is what the new
`seed-conformance` suite executes. The constants that describe it live in
`apps/api/test/fixtures/seed-environment.ts`; specs read from there rather than re-typing
the values, so a future seed change updates every consumer at once.

## 8. Residual notes (not defects)

- **The QA prep scripts** (`apps/web/phaseui3-qa-dataprep.mjs`,
  `phaseui5-visual-qa.mjs`) no longer assert a UUID shape — the gate is tenancy (the id
  appears in the acting tenant's directory) plus the 1..64 platform bound. They still
  assume the QA user has a resolved tenant (registration does not assign one), which is a
  property of the provisioned environment, not of this change.
- **Membership provisioning** — no first-class HTTP surface for tenant creation or
  membership assignment was invented; the preflight recorded it as a platform gap outside
  this phase, and the seed is the bootstrap path.
- **HR** carries the same class of mismatch and was explicitly out of scope.