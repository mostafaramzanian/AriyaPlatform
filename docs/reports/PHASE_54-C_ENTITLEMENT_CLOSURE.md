# PHASE 54-C — PLATFORM MODULE / FEATURE ENTITLEMENT — CLOSURE

Scope: the three entitlement amendments of the 54-A freeze
(`docs/reports/PHASE_54_PLATFORM_RULE_ENGINE_SPEC.md`) — Amendment 1, §43 (D14: the module/feature
entitlement layer), Amendment 2, §44 (D15: the module-entitlement tenant scope) and Amendment 3, §45
(D16: module/tenant membership storage) — implemented in the order §43.12 froze, and measured against
the gates §43.10 and §45.8 name.

What this phase is **not**: the leave-domain implementation phases of §15–§37 and their gates 4–8, 10
and 12. Nothing here stores a leave row, opens an approval, resolves an approver, counts a limit
window or renders a leave screen. §44's own execution gate (D15-G1) is unchanged and still FAILED as
reported there; this phase implements D16's mechanism, which is what §45.9 left open, and does not
pretend the D15 finding was repaired by it. §39's stop conditions were not met, and none of them was
resolved by guessing.

## 1. THE LINE THIS PHASE HAD TO HOLD

Seven properties decide whether this is the amendment the specification froze or a convenient
approximation of it. Each is held by code or by a gate, not by a comment:

1. **Entitlement is honoured by the BOUNDARY, never by a rule (§5 rules 1–4, §43.11).** The resolver
   is a platform service (`platform/entitlement/platform-entitlement.service.ts`); the rule engine
   does not import it, no rule can read entitlement, and no business module gained a new source of
   truth. `architecture-boundaries.spec.ts` (unchanged) stayed green, which is what makes the claim
   checkable rather than stylistic.
2. **Absence stays the default (§43.7, §43.9).** There is no hook, trigger, default or lazy creation
   anywhere: an unprovisioned module is refused `MODULE_NOT_FOUND`, a registered-but-disabled one
   `MODULE_DISABLED`, an out-of-scope tenant `MODULE_FORBIDDEN`, and a tenant that was never granted
   the feature `FEATURE_NOT_GRANTED`. The seven-row truth table of §43.9 is asserted row by row.
3. **The tenancy of a REQUEST is never chosen by a caller (§25 rule 7, §43.5).** The guard reads the
   tenant from the authenticated actor and from nothing else: a `?tenantId=` query, a body field or a
   header cannot influence the decision, and the guard spec asserts that the request is not reached
   at all. The tenant ids an admin GRANT body names are the subject of a configuration fact under a
   manage permission — the distinction the code states where a reader would try to "fix" one rule
   into the other.
4. **`DISABLE ≠ DELETE` (§43.11).** Turning a module or a feature off refuses ACCESS and deletes
   nothing: no leave request, balance, type, policy or history is touched, and re-enabling restores
   exactly what was there. The five migrations are additive — no `DROP TABLE`, no `DROP COLUMN`, no
   `TRUNCATE`, no `DELETE FROM`, no `ALTER … TYPE`, and no narrowed bound — asserted by reading the
   SQL as text.
5. **No new RBAC surface (§43.8).** The six admin routes reuse the registry's EXISTING
   `admin.modules.read` / `admin.modules.manage` codes and hang off the registry's path prefix, so no
   permission matrix had to be re-seeded. Every route carries `@Roles(...)`, and a gate reads the
   controller to prove it.
6. **Nothing reads Core's entitlement tables across a database boundary (§24, §43.11).** HR holds no
   Core handle and reaches entitlement only through the port; the HR source gate asserts that
   entitlement imports appear only in HR CONTROLLERS and `hr.module.ts`, never in an HR service or
   repository, and that `hr_db` received nothing.
7. **`RESTRICTED_MEMBERS` is a storage state the admin API cannot express (§45.4 item 5, §45.8).**
   The scope enum keeps its frozen pair, the DTO layer cannot name the new member, and both admin DTOs
   REFUSE it as validation — so an operator cannot move a module into or out of the enumerated
   membership mode, because that would be a provisioning decision wearing a scope edit.

## 2. WHAT WAS BUILT

### 2.1 The decision path — `apps/api/src/platform/entitlement/` (new, 10 files, 1,927 lines)

- **`entitlement.contract.ts`** (161 lines) — the whole vocabulary and the one seam: the
  `ENTITLEMENT_PORT` string token (the same idiom `AUDIT_PORT` and `USER_DIRECTORY` already
  established), the two metadata keys, the six §43.2 refusal codes as a union, the label record
  over that union, `EntitlementRequest` — which has **no `tenantId` field** — the total
  `EntitlementDecision` (`{ ok: true } | { ok: false; failure }`), the port with **one read-only
  method** (`decide`), and the two decorators. `combineEntitlementRequirement()` states the three
  wiring rules as refusals: neither declaration → `null` (the guard then refuses); a feature-only
  declaration → the module question is STILL asked, with the feature's own module id; two
  declarations naming different modules → `null`, because picking one would be a decision made by a
  guard.
- **`platform-entitlement.service.ts`** (165 lines) — the only implementation. It reads the tenant
  from `RequestContextService`, the same source `ModuleRegistryService.resolve()` uses, and walks
  the §43.9 table row by row in frozen order. `ALL` and `RESTRICTED` resolve with the query count
  they already had; only `RESTRICTED_MEMBERS` costs one more read, and it is the only scope that
  reads the child table.
- **`module-entitlement.guard.ts`** (90 lines) — the boundary gate. It reflects metadata
  handler-first (`getAllAndOverride`, the order `JwtAuthGuard` and `RolesGuard` both use), refuses a
  decorated surface with no declaration as `ENTITLEMENT_NOT_DECLARED` **without asking the port**,
  and throws a uniform `403 { statusCode, code, moduleId, featureId? }`. It never calls
  `switchToHttp` and never reads a request part: that absence is the mechanism by which a caller
  cannot claim a tenancy (§25 rule 7), and a spec asserts it.
- **`platform-entitlement.module.ts`** (55 lines) — imports `PrismaModule` and `RbacModule` (the very
  import `module-platform.module.ts` already makes for its own admin surface), binds the token with
  `useExisting` so there is one instance and one resolver, and **exports only the token**.
  `PlatformEntitlementService` and `ModuleFeatureService` stay module-private, so no consumer can
  reach a mutation method — the same structural choice `AuditPort` makes. The guard is deliberately
  not exported: HR lists the class in `providers` (§43.6), and the token is what it resolves
  against. A module that applies the guard without providing the token fails at BOOT, not at
  request time, because the guard injects without `@Optional()`.

### 2.2 The admin surface — `module-feature.controller.ts` (142), `module-feature.service.ts` (382), `dto/module-feature.dto.ts` (190)

Six routes, all on the registry's own `admin/modules` prefix and under its EXISTING codes
(`admin.modules.read` × 2, `admin.modules.manage` × 4), so no permission matrix had to be
re-seeded: list features, declare a feature, update (the enabled toggle), list a feature's tenants,
grant, revoke. Every route carries `@Roles(...)`, and a spec reads the controller to prove it.

The service writes **one audit row per change** through the same `AuditService` boundary the
registry's mutations use, under the frozen six-action vocabulary
(`module.feature.declared | updated | enabled | disabled | granted | revoked`, resource
`ModuleFeature`). A write that changes nothing — re-declaring an unchanged feature, re-granting
tenants that already hold the row — writes no audit row; a revoke that removes nothing is a `404`
and writes none either. The audit dependency is `@Optional()`, for the registry's own stated reason:
a failed audit write must not fail the request.

`dto/module-feature.dto.ts` cannot name `RESTRICTED_MEMBERS` at all (the scope enum keeps its frozen
pair), the module-side scope DTO refuses the member as validation, and both DTOs enforce the slug
shape `^[a-z0-9]+(-[a-z0-9]+)*$` inside a 2–64 window — the same constraint the SQL `CHECK`s
enforce, so absence and malformed input are refused by validation rather than discovered by a `422`.

### 2.3 The tenant scope and the membership source — `module-registry.service.ts` (+96 / −51), `module-registry.service.spec.ts` (+174 / −52), `core/schema.prisma` (+171 / −1)

`resolve()` gains a `switch` over `tenantScope` with a **refusing default**: `ALL` stays query-free,
`RESTRICTED` keeps reading `tenantIds` alone, and the new `RESTRICTED_MEMBERS` branch reads
`ModuleRegistrationTenant` — its only membership source, since the constraint requires its
`tenantIds` array to be empty — by the composite unique key. A tenant-less caller is refused
*before* the membership lookup. The schema adds the three Core-owned models (`ModuleFeature`,
`ModuleFeatureGrant`, `ModuleRegistrationTenant`) and the `RESTRICTED_MEMBERS` enum member; the two
back-relations are Prisma relation fields only, so no column was added to `ModuleRegistration` or
`Tenant`.

### 2.4 The five migrations (new, 499 lines of SQL, all additive and idempotent)

| File | Lines | Does |
|---|---|---|
| `20260921120000_add_module_feature_entitlement` | 147 | the two D14 tables, their indexes, `CHECK`s and three FKs — no `ALTER` on any existing table |
| `20260921120100_add_module_tenant_scope_explicit` | 31 | one statement: `ALTER TYPE … ADD VALUE IF NOT EXISTS 'RESTRICTED_MEMBERS'` — alone, because 55P04 forbids *using* a freshly added value in the transaction that added it |
| `20260921120200_add_module_registration_tenant_membership` | 118 | the child table, its unique key, index and FKs, and the `ModuleRegistration` constraint REPLACED under the same name, keeping the frozen `RESTRICTED` branch verbatim and adding a `RESTRICTED_MEMBERS` branch that requires an empty `tenantIds` |
| `20260921120300_seed_hr_module_tenant_membership` | 113 | the only file that writes data: the `hr` registration row plus `INSERT … SELECT` over `Tenant` with `ON CONFLICT … DO NOTHING` — the tenant set is READ, never listed, and a bound smaller than the set raises and stops rather than truncating |
| `20260921120400_seed_hr_leave_feature_entitlement` | 90 | §43.7's provisioning act: declares `hr`/`leave` and grants it to every tenant that exists at that moment, idempotently |

`module-entitlement-migrations.spec.ts` (340 lines, 7 tests) reads these files **as text**: that the
file it claims to read exists (a renamed migration must fail, not pass vacuously), that the enum
value is added in one file and used in another, that the replacement constraint still contains the
frozen branch and narrows nothing, that the seed reads the tenant set and is idempotent, that every
file is additive (`DROP TABLE`/`DELETE`/`TRUNCATE`/narrowed bound all asserted absent), that no
`@db.` native type or FK type mismatch exists, and that the admin write contract cannot express — or
even name — `RESTRICTED_MEMBERS`.

### 2.5 The HR wiring (the module that declares, and never decides)

- `hr.constants.ts` (+34): `HR_MODULE_ID = 'hr'` and `HR_FEATURE = { LEAVE: 'leave' }`. Both exist so
  the id an HR controller decorates with, the `ModuleRegistration` row the migration inserts and the
  feature row that hangs off it cannot drift apart — and because the two files cannot import each
  other across the Core/HR boundary, gate 4 compares the migration's SQL against this constant as
  text.
- `hr.module.ts` (+13 / −1): imports `PlatformEntitlementModule` and lists `ModuleEntitlementGuard`
  in `providers`. Entitlement appears in exactly two places in the whole module — controllers and
  this file — and a gate fails the build if it appears anywhere else.
- HR controllers (+64 across six files): attendance, employees, organization and positions declare
  `@RequiresModule(HR_MODULE_ID)`; the two Leave controllers additionally declare
  `@RequiresFeature(HR_MODULE_ID, HR_FEATURE.LEAVE)`. No HR service, repository or gateway learned
  the word entitlement.
- `hr-isolation.spec.ts` (+168, 2 new tests): gate 3 reads every HR controller from disk and asserts
  the decorators above, that the guard is in `providers`, and that entitlement imports appear only in
  controllers and `hr.module.ts`; gate 4 reads the seed SQL against `hr.constants.ts`. `hr_db`
  received no table, column, migration or index.

### 2.6 The web console — `modules-api.ts` (+286 / −6), `CoreModulesView.tsx` (+536 / −8)

`modules-api.ts` gains the client half of the vocabulary and none of the policy: the failure union
plus `ENTITLEMENT_FAILURE_LABELS` as a complete `Record` over it (adding a code is a **type error**,
not a forgotten label), `entitlementFailureLabel()` which renders the raw code rather than a lie when
it meets an unknown one, the six API functions (`listModuleFeatures`, `declareModuleFeature`,
`updateModuleFeature`, `listModuleFeatureTenants`, `grantModuleFeature`, `revokeModuleFeature`),
`isValidModuleId`/`isValidFeatureId` mirroring the two SQL `CHECK`s as *separate* constraints,
`featureEffectiveState()` with `FEATURE_EFFECTIVE_STATE_PRESENTATION` (the same module-first order
§43.9 freezes, so the UI cannot disagree with the resolver), and `parseTenantIdList()` for the
operator's input.

`CoreModulesView.tsx` renders the per-module features panel: the list, declare, enable/disable, and
the per-tenant grant/revoke rows, every state as a Persian label. A read-only caller sees no write
affordance, refusals are named as the resolver named them (a module refusal stays a module refusal
even when the tenant holds a grant), and an invalid feature id is refused locally instead of
travelling to a `422`.

## 3. THE GATES THIS PHASE ADDS — EACH ABLE TO FAIL, EACH RUN

The specification froze eight gates in §43.10 and seven more in §45.8. Every one exists, and every
one was executed on this tree. The mapping is exact — no gate was renamed into something easier:

| §43.10 gate | The failure it catches | Where it lives | Measured |
|---|---|---|---|
| 1 — resolver truth table | a branch that allows by default, or a reordered step that lets an unprovisioned module through | `platform-entitlement.service.spec.ts` (15 tests: all seven rows §43.9 names, plus scope, null-tenant and ordering cases) | pass |
| 2 — guard | a surface that opens when its decorator is forgotten; a tenant a caller can claim | `module-entitlement.guard.spec.ts` (9 tests; includes "never calls `switchToHttp` and never injects a request part") | pass |
| 3 — HR source | a new HR controller that ships ungated; entitlement leaking into HR's application layer | `hr-isolation.spec.ts` (new test) | pass |
| 4 — constant ↔ provisioning drift | a constant renamed without moving the provisioned row, refusing a working module in production | `hr-isolation.spec.ts` (new test, reading the seed SQL as text) | pass |
| 5 — migration | a destructive provisioning step; a non-idempotent seed; a silent truncation of the tenant list | `module-entitlement-migrations.spec.ts` (7 tests) | pass |
| 6 — admin controller | an `admin/modules/**` route anyone can call; an unrecorded grant or revocation | `module-feature.controller.spec.ts` (6 tests) | pass |
| 7 — boundaries | the amendment quietly becoming a way for HR to read Core's database | `architecture-boundaries.spec.ts` (unchanged, 23 tests) and `hr-isolation.spec.ts` | pass |
| 8 — web | a raw machine code rendered to an operator; a form that discovers the id rule through a `422` | `modules-api.spec.ts` (16 new tests) and `CoreModulesView.spec.tsx` (9 new tests) | pass |

The §45.8 gates land in `module-entitlement-migrations.spec.ts`, and one of them reads the admin
DTOs as text: migration-text, enum-separation, seed, representation and column-type gates there, the
`resolve()` gate in `module-registry.service.spec.ts` (+4 tests), and the DTO gate in both.

Evidence, both runs made after the last source edit:

```
apps/api  npx jest --runInBand src/platform/entitlement \
  src/module-platform/module-entitlement-migrations.spec.ts \
  src/modules/hr/hr-isolation.spec.ts src/architecture-boundaries.spec.ts
  -> Test Suites: 6 passed, 6 total   Tests: 71 passed, 71 total   (api-phase-final-54c.txt, 16.0 s)

apps/web  npx jest src/lib/__tests__/modules-api.spec.ts \
  src/components/core/__tests__/CoreModulesView.spec.tsx
  -> Test Suites: 2 passed, 2 total   Tests: 56 passed, 56 total   (web-phase-final-54c.txt, 9.4 s)
```

Both commands were re-run after this report was written and reproduced the same two totals
(`api-verify-54c.txt`: 6 suites / 71 tests; `web-verify-54c.txt`: 2 suites / 56 tests).

## 4. STANDING GATES — EVIDENCE, RUN ON THIS TREE

| Gate | Command | Result |
|---|---|---|
| API unit suite | `apps/api`: `npx jest --runInBand` | **140 suites, 2,307 tests, all passing** (85.8 s) |
| Web suite | `apps/web`: `npx jest` | **59 suites, 1,060 tests, all passing** (51.2 s) |
| API types | `apps/api`: `npx tsc --noEmit -p tsconfig.json` | no diagnostics |
| Web types | `apps/web`: `npx tsc --noEmit -p tsconfig.json` | no diagnostics |
| API build | repo root: `npm run build:api` (includes both Prisma client generations and `postbuild`) | completes with no `error TS` |
| API lint, phase surface | `apps/api`: `npx eslint src/platform/entitlement src/module-platform/module-entitlement-migrations.spec.ts src/modules/hr/hr-isolation.spec.ts` | clean |
| API format, phase files | `apps/api`: `npx prettier --check` on the same surface | "All matched files use Prettier code style!" |
| Web format, phase files | `apps/web`: `npx prettier --check` on the two lib files and the two view files | "All matched files use Prettier code style!" |

### 4.1 Three honest notes about the lint and evidence set

1. **The web ESLint gate cannot be measured in this tree, and I am not reporting it as green.** Any
   `npx eslint <file>` under `apps/web` dies before linting with
   `TypeError: Converting circular structure to JSON … property 'react' closes the circle`,
   `Referenced from: apps/web/.eslintrc.js`. Running it against a file this phase never touched
   (`src/lib/integrations-api.ts`) fails **identically**, which is the falsification that makes it a
   pre-existing config defect rather than a finding about this phase. It is recorded here rather than
   repaired, because changing a shared ESLint config is not this phase's change.
2. **A repo-wide Prettier check reports 8 drifting HR files that this phase does not touch**
   (`leave.service.ts`, `leave.repository.ts`, `leave-status.ts`, `dto/leave.dto.ts`,
   `dto/hr-query.dto.ts`, `hr-application-boundaries.spec.ts`, `leave.service.spec.ts`,
   `leave-status.spec.ts`). None appears in this phase's change set; `--write` over them would have
   been a formatting-only edit to files 54-C does not own, so they were left as found and the phase
   check was narrowed to the files this phase changes — where it is clean.
3. **No migration was applied to a live database in this session.** No `prisma migrate deploy` was
   run against `core_db`, and D15-G1 remains **FAILED** (162 tenants against the live 64-entry
   `RESTRICTED` cap, §44.2). What gate 5 measures is the content of the SQL files, read as text; the
   report claims exactly that and nothing about a deployed schema.

## 5. THE CHANGE, FILE BY FILE

### 5.1 New — 16 files, 2,766 lines

| File | Lines |
|---|---|
| `apps/api/src/platform/entitlement/entitlement.contract.ts` | 161 |
| `apps/api/src/platform/entitlement/platform-entitlement.service.ts` | 165 |
| `apps/api/src/platform/entitlement/platform-entitlement.service.spec.ts` | 356 |
| `apps/api/src/platform/entitlement/module-entitlement.guard.ts` | 90 |
| `apps/api/src/platform/entitlement/module-entitlement.guard.spec.ts` | 253 |
| `apps/api/src/platform/entitlement/module-feature.service.ts` | 382 |
| `apps/api/src/platform/entitlement/module-feature.controller.ts` | 142 |
| `apps/api/src/platform/entitlement/module-feature.controller.spec.ts` | 133 |
| `apps/api/src/platform/entitlement/dto/module-feature.dto.ts` | 190 |
| `apps/api/src/platform/entitlement/platform-entitlement.module.ts` | 55 |
| `apps/api/src/module-platform/module-entitlement-migrations.spec.ts` | 340 |
| `apps/api/prisma/core/migrations/20260921120000_add_module_feature_entitlement/migration.sql` | 147 |
| `apps/api/prisma/core/migrations/20260921120100_add_module_tenant_scope_explicit/migration.sql` | 31 |
| `apps/api/prisma/core/migrations/20260921120200_add_module_registration_tenant_membership/migration.sql` | 118 |
| `apps/api/prisma/core/migrations/20260921120300_seed_hr_module_tenant_membership/migration.sql` | 113 |
| `apps/api/prisma/core/migrations/20260921120400_seed_hr_leave_feature_entitlement/migration.sql` | 90 |

The four new spec files hold 37 of the phase's own tests (15 + 9 + 6 + 7), and 25 more were added to
the two web specs this phase extends.

### 5.2 Modified — 16 tracked files, +2,006 / −132

| File | + | − |
|---|---|---|
| `apps/api/prisma/core/schema.prisma` | 171 | 1 |
| `apps/api/src/module-platform/module-registry.service.ts` | 96 | 51 |
| `apps/api/src/module-platform/module-registry.service.spec.ts` | 174 | 52 |
| `apps/api/src/modules/hr/hr.constants.ts` | 34 | 0 |
| `apps/api/src/modules/hr/hr.module.ts` | 13 | 1 |
| `apps/api/src/modules/hr/hr-isolation.spec.ts` | 168 | 0 |
| `apps/api/src/modules/hr/attendance/attendance.controller.ts` | 8 | 0 |
| `apps/api/src/modules/hr/employees/employees.controller.ts` | 10 | 0 |
| `apps/api/src/modules/hr/leave/leave-requests.controller.ts` | 15 | 0 |
| `apps/api/src/modules/hr/leave/leave-types.controller.ts` | 15 | 0 |
| `apps/api/src/modules/hr/organization/organization.controller.ts` | 8 | 0 |
| `apps/api/src/modules/hr/positions/positions.controller.ts` | 8 | 0 |
| `apps/web/src/lib/modules-api.ts` | 286 | 6 |
| `apps/web/src/lib/__tests__/modules-api.spec.ts` | 247 | 9 |
| `apps/web/src/components/core/CoreModulesView.tsx` | 536 | 8 |
| `apps/web/src/components/core/__tests__/CoreModulesView.spec.tsx` | 217 | 4 |

Documentation, measured separately so the code figures above stay honest:
`docs/reports/PHASE_54_PLATFORM_RULE_ENGINE_SPEC.md` **+878 / −8** — the frozen amendment text of §43
(D14), §44 (D15) and §45 (D16), including the register rows that record D15-G1 as **FAILED**.

No file was deleted or renamed, and no `DROP`/`DELETE`/`TRUNCATE` exists anywhere in the change:
the only removals are replaced lines and deleted test scaffolding.

### 5.3 Reproducing every figure above

```powershell
cd E:/ERP
git status --porcelain
git --no-pager diff --numstat -- apps/api/prisma/core/schema.prisma apps/api/src/module-platform `
  apps/api/src/modules/hr apps/web/src/lib apps/web/src/components/core
git --no-pager diff --numstat -- docs/reports/PHASE_54_PLATFORM_RULE_ENGINE_SPEC.md
Get-ChildItem apps/api/src/platform/entitlement -Recurse -File |
  ForEach-Object { (Get-Content $_.FullName).Count }
```

The gate commands are the two `jest` invocations quoted in §3 and the standing-gate commands in §4;
each wrote its output to the text file named beside it, in the repository root.

### 5.4 Status of the working tree when this report was written

The phase's change is uncommitted. The 16 new files are untracked; the 16 modified files carry the
phase's edits; this report is untracked. The tree also contains **earlier phases' uncommitted work**
that 54-C neither touched nor reviewed — above all the `apps/api/test/*.e2e-spec.ts` PermissionSource
migration from 51-HR-ARCH-3A — so `git status` is wider than this phase's change set, and §5.2 is the
honest boundary of what 54-C wrote.

## 6. WHAT IS NOT HERE, AND WHY THAT IS THE PHASE BOUNDARY

**D15-G1 is still FAILED, and nothing here repairs it.** §44's execution gate — 162 existing tenants
against the live 64-entry `RESTRICTED` cap — is reported, not worked around. D16 supplies the
mechanism that makes the finding survivable (explicit membership in a child table instead of a
bounded array), but the migration that would exercise it was **not applied to any database** in this
session, and this report claims nothing about a deployed schema. A gate that failed once is not
quietly green two phases later.

**Deliberately not built, from the specification's own list (§43.9, §45.9), each still absent:**

- no per-tenant module grant table, and no feature-level scope enum — a bounded array would make a
  growing membership harder to express, which is the failure D16 was raised about;
- no coupling between entitlement and permission, in either direction: holding every permission code
  still does not entitle a tenancy, and nothing in RBAC reads entitlement;
- no rule-engine awareness in either direction: no rule reads entitlement, and entitlement reads no
  rule, version or evaluation result — D12's purity is untouched because the resolver is not the
  engine;
- no observable, event, metric, scheduler job or notification for entitlement: refusals are `403`s
  and grants are audit rows, because a business module reacting to entitlement would make
  entitlement a business dependency;
- no `hr_db` change of any kind — no HR table, column, migration or index — and no cross-database FK;
- no operator UI or endpoint for editing membership rows, and no billing, subscription, pricing or
  metering of any kind.

**The leave domain is not here either.** The phases of §15–§37 and their gates 4–8, 10 and 12 are
untouched: nothing in this change stores a leave row, opens an approval, resolves an approver, counts
a limit window or renders a leave screen. The one HR feature this phase names — `hr`/`leave` — is
named as a *declared capability*, not implemented as one.

**There is no e2e coverage of the new admin routes, and none is claimed.** No file in
`apps/api/test/` mentions `admin/modules` or the feature surface, and this phase added none: its
gates are unit specs and static text gates, plus the web suites. Exercising the six routes over a
live HTTP stack requires the migrations applied to a database — exactly what D15-G1 blocks for HR —
and proving the admin surface alone against a schema nobody deployed would prove less than it looks.

**§39's stop conditions were not met, and none of them was resolved by guessing.** Where the
specification froze a bound, a refusal or an ordering, the code states the same thing and a gate can
fail on it; where the specification left something open, it is recorded as open above rather than
closed by an implementation comment.
