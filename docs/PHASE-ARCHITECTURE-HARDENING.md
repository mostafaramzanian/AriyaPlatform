# PHASE — Architecture Hardening & Boundary Integrity

Verification/regression + documentation-hardening phase only. No new business
features, no behavior changes to Financial Check Issuance, Production, Commerce,
HR or Core. The goal is to confirm the repository enforces architecture rules so
a new bounded context cannot silently pass gates without registering ownership,
datasource, runtime policy and boundary tests.

## 1. Scope

- Remove/prevent unnecessary `RbacModule` coupling in business modules.
- Confirm a single canonical datasource registry.
- Align tooling scripts and Docker packaging with that registry.
- Keep `runtime-policy.json`, `runtime-datasources.ts`, Docker and health
  composition consistent.
- Update stale top-level architecture documentation.
- Record process-architecture observations only; no extraction in this phase.

## 2. Preflight findings

An inventory of the current tree showed that the hardening had already been
applied in earlier commits (`ARCH-2`, `ARCH-1.2/1.3`, `Phase 51-HR-ARCH-3A`,
`Phase PRODUCTION-BOM-HEADER`, `Phase F1`):

- `FinancialModule` and `ProductionModule` do **not** import `RbacModule`
  (only metadata `@Roles` remains).
- `HrModule`, `CommerceModule`, `CorrespondenceModule` already follow the same
  pattern.
- `runtime-datasources.ts` already lists all eight owners including
  `production` and `financial`.
- `architecture-boundaries.spec.ts` already derives the owner map from
  `DATASOURCE_OWNERS` and asserts filesystem parity, so a new unregistered
  Prisma project fails the architecture gate.
- Root `package.json` and `apps/api/package.json` already expose
  `db:migrate:production` and `db:migrate:financial`.
- `Dockerfile.backend` already packages Production/Financial schemas and
  comments.
- The only residual drift was in top-level documentation: `ARCHITECTURE.md` did
  not describe bounded contexts beyond the original marketing modules, and
  `FOLDER_STRUCTURE.md` omitted the newer datasource/runtime files and the
  additional DB env vars.

## 3. Initial architecture state

```text
AuthModule
  └── RbacModule
        └── CorePermissionSource / RoleService / PermissionService
              (PermissionSource token)

Runtime roots:
  core        → CoreHealthModule only
  cms         → Core + CMS
  combined    → Core, CMS, Correspondence, HR, Commerce, Production, Financial
  future-hr   → Core + HR

Datasource ownership:
  core, cms, observability, correspondence, hr, commerce, production, financial
  each with its own Prisma project, generated client, module/service.

Business modules consume:
  - PlatformAuditModule (port)
  - UserDirectoryModule (port)
  - PlatformEntitlementModule (port)
  - their own Prisma module
  - never Core's PrismaModule
  - never RbacModule
```

## 4. RbacModule coupling

Verified with `grep` across `apps/api/src/modules`:

| Module | Imports RbacModule? |
|---|---|
| `financial/financial.module.ts` | No |
| `production/production.module.ts` | No |
| `hr/hr.module.ts` | No |
| `commerce/commerce.module.ts` | No (verified by existing tests) |
| `correspondence/correspondence.module.ts` | No (verified by existing tests) |

The architecture tests for this (`architecture-boundaries.spec.ts` + module
isolation specs) already pass.

## 5. Auth composition change

No source change was required; the composition already is:

```text
AppModule / CoreAppModule / cms-app.module.ts
  └── AuthModule
        └── RbacModule
              └── PermissionSource (Core or token-backed)
  └── [business modules] (declare @Roles metadata only)
```

`RolesGuard` is a global `APP_GUARD` registered at the runtime root, resolving
`PermissionSource` from the runtime's chosen binding.

## 6. Canonical datasource registry

Single source of truth: `apps/api/src/runtime-datasources.ts`.

- `DATASOURCE_OWNERS` maps each `*_DATABASE_URL` to owner, schema path, migration
  root, generated client dir, module class/file, generate script and status.
- `RUNTIME_DATASOURCE_MATRIX` declares `required`/`optional`/`not-used` per
  runtime.
- `runtimePolicy.json` is emitted by `npm run arch:policy` and consumed by
  Docker (`scripts/runtime-policy.mjs`).
- Health graph and architecture tests derive from the same source.

Verified: regenerating `runtime-policy.json` produced no diff against the
committed file.

## 7. Boundary test hardening

`architecture-boundaries.spec.ts` already contains:

- `keeps independently owned business modules out of CoreAppModule` — derived
  from `discoverIndependentModules`.
- `binds every independent Prisma schema to its owned datasource — derived from the owner registry`.
- `registers an owner for EVERY prisma project on disk` — fails when a new
  `prisma/<x>/schema.prisma` exists without a `DATASOURCE_OWNERS` entry.
- `forbids Core Prisma persistence in independent modules`.
- `does not let independent business modules import Core or Observability Prisma services`.
- `keeps the datasource to client binding out of the health engine`.

These gates ran green.

## 8. Runtime policy consistency

- `runtime-datasources.ts` and `runtime-policy.json` match (verified by
  regeneration + diff).
- `Dockerfile.backend` copies `prisma/production` and `prisma/financial` and
  references `runtime-policy.mjs` for pruning.
- `apps/api/package.json` includes `prisma:generate:production/financial` and
  `prisma:migrate:production/financial`.
- Root `package.json` re-exports these commands.

## 9. Root tooling consistency

Root scripts already cover all owners:

```json
"db:migrate:production"
"db:migrate:financial"
"prisma:generate:production"
"prisma:generate:financial"
```

All schema paths, generated-client dirs and env names align with
`runtime-datasources.ts`. No new scripts were added.

## 10. Docker consistency

`infrastructure/docker/Dockerfile.backend`:

- Header lists Core, CMS, Correspondence, HR, Commerce, Production, Financial.
- Copies `prisma/production` and `prisma/financial` in the runner stage.
- Uses `runtime-policy.mjs prune-clients-for combined`.
- No manual enumeration of clients.

No Dockerfile changes were required.

## 11. Documentation corrections

- `ARCHITECTURE.md` — added section **4.4 Bounded Contexts & Runtime
  Boundaries** describing the eight owners, canonical registry, auth boundary
  and deployment topology.
- `FOLDER_STRUCTURE.md` — extended the **Key Files Summary** with
  `hr/commerce/production/financial` schemas, `runtime-datasources.ts`,
  `scripts/runtime-policy.mjs`, `runtime-policy.json`. Extended the backend
  env-var example with `HR_DATABASE_URL`, `COMMERCE_DATABASE_URL`,
  `PRODUCTION_DATABASE_URL`, `FINANCE_DATABASE_URL`.

## 12. Process architecture observations

The current workflow/process primitives live inside `modules/commerce/workflow`
and are consumed only by Commerce. Candidate primitives for a future
`src/platform/process` extraction (observed, not extracted) include:

- workflow definition / version / step
- action / actor policy
- transition rules
- condition/config validation
- decision workspace / pending inbox

No extraction was performed because it would change import graphs without a
business requirement in this phase. Commerce workflow does not import Financial
or Production code, and no process code is duplicated across business modules
yet.

## 13. Files changed

- `docs/PHASE-ARCHITECTURE-HARDENING.md` (new)
- `ARCHITECTURE.md`
- `FOLDER_STRUCTURE.md`

No source/test/business files were modified.

## 14. Tests executed

- `npx tsc --noEmit -p tsconfig.json` (api)
- `npm run type-check --workspace=apps/web`
- `npx jest src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts src/modules/financial/financial-isolation.spec.ts src/modules/production/production-isolation.spec.ts src/auth/rbac --runInBand`
- `npm run test --workspace=apps/api` (full API suite)

## 15. Exact test results

| Suite | Result |
|---|---|
| API type-check | PASS |
| Web type-check | PASS |
| Architecture + policy + financial/production isolation + rbac | 9 suites / 121 tests PASS |
| Full API suite | **239 suites / 3945 tests PASS** |

## 16. Prisma validation results

- `prisma/core/schema.prisma` — valid
- `prisma/financial/schema.prisma` — valid
- `prisma/production/schema.prisma` — valid

## 17. Known limitations

- Full CI does not run e2e or Docker builds (documented in GAP-ENV-1).
- `runtime-policy.json` is generated and committed; it must be regenerated when
  `runtime-datasources.ts` changes (enforced by `runtime-policy.spec.ts`).
- `ARCHITECTURE.md` remains a high-level ADR; detailed phase contracts are in
  `docs/PHASE-*.md`.

## 18. Intentionally deferred items

- Extraction of a generic `platform/process` module — deferred until a second
  business module needs the same primitives.
- Standalone runtime for Production/Financial — deferred; they currently run in
  the `combined` runtime and retain independent data ownership.
- Quotation (GAP-6) — contract-blocked, out of scope.
- Platform revocation feed and asymmetric token posture — deferred to phase 3B.

## 19. Reviewer checklist

- [x] Financial no longer imports RbacModule unnecessarily
- [x] Production no longer imports RbacModule unnecessarily
- [x] RolesGuard still works
- [x] PermissionSource composition remains valid
- [x] No business module gained Core Prisma coupling
- [x] Datasource ownership has one canonical source
- [x] Production datasource is registered
- [x] Financial datasource is registered
- [x] Missing datasource registration causes architecture test failure
- [x] Runtime topology remains unchanged
- [x] runtime-policy remains consistent
- [x] root scripts are synchronized
- [x] Docker comments/config reflect actual packaged contexts
- [x] ARCHITECTURE.md reflects current architecture
- [x] FOLDER_STRUCTURE.md reflects current architecture
- [x] Commerce workflow is not imported into Financial
- [x] No Financial business behavior changed
- [x] No Production business behavior changed
- [x] No unrelated artifacts committed
- [x] Full relevant test suites are green
- [x] Prisma validation passes
- [x] Report is truthful and reproducible

## 20. Commit hash

`f3d77a8`
