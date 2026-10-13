# Business Modules

## Conventions

Independent business modules MUST live under `src/modules/<module-name>` and own:

- `prisma/<module-name>/schema.prisma`
- `prisma/<module-name>/migrations/`
- `src/modules/<module-name>/database/<module-name>-prisma.service.ts`
- `src/modules/<module-name>/database/<module-name>-prisma.module.ts`
- `src/modules/<module-name>/<module-name>.module.ts`

They MUST NOT import `database/prisma.service` or `PrismaModule` (Core Prisma).
They MUST NOT be imported by `CoreAppModule`.
Identity/RBAC/platform lookups MUST go through platform contracts/ports or
`ModuleClient`, never directly through Core internals.

### Persistence within a module

Persistence is its own layer inside a module, not the place a rule is decided
(Phase 51-HR-ARCH-1, following `cms/blog` and the same reasoning):

- exactly ONE `<aggregate>.repository.ts` per aggregate issues Prisma statements;
- no `.service.ts` injects the module's Prisma client — it calls a repository
  method instead, so a change to a domain rule and a change to a query never
  look the same in review;
- the tenant is the FIRST argument of every repository method and appears in the
  `where` of every query, so visibility is readable from the signature rather
  than inferred from an ambient actor;
- a repository translates nothing: no audit row, no domain exception, no
  lifecycle decision. `P2002` reaches the service, which is the layer that can
  explain it to an API client.

## Current modules

- `cms` — independent data owner with Core Identity coupling for protected routes.
- `correspondence` — Phase 50-MOD-CORR; independent database and persistence.
- `hr` — Phase 51-HR; independent database, own client, one repository per
  aggregate, guarded by `hr-isolation.spec.ts`.

### HR layering (Phase 51-HR-ARCH-1B)

HR is split into four tiers, and the direction between them is enforced by
`hr-application-boundaries.spec.ts`:

```
controller → application service → repository → HR database client
                     ↘ domain (pure) ↗
```

- `hr/domain/` holds the rules that need no database, no request and no tenant
  to give the same answer: interval parsing, formatting and the strict successor
  ordering (`employment-interval.ts`), and the ancestor-walk cycle decision
  (`organization-hierarchy.ts`). **A domain file imports NOTHING** — not NestJS,
  not Prisma, not a repository, not an audit service — and the guard asserts zero
  import specifiers per file, so a rule is testable without a container and
  without a fake Prisma driver.
- an application service owns orchestration only: it fetches, decides the HTTP
  status, and writes the audit entry. It never talks to Prisma and never carries
  a transport type; the domain returns DECISIONS and the service maps them to the
  same exceptions it threw before the extraction.
- a controller delegates to a service and never reaches persistence.
- a repository is the only tier that talks to `HrPrismaService`, and every
  tenant-owned read takes `tenantId` as its FIRST parameter (asserted, §17).

Nothing about enforcement changed: the interval-overlap `EXCLUDE` constraint, the
composite tenant foreign keys and `OrganizationUnit_no_cycle_guard` remain the
real guarantees. The domain and application tiers exist so an invalid request is
answered with a readable `400`/`409` before it reaches the database — they are
not a second, weaker copy of them.

## Legacy Core business modules (extraction candidates)

These are still loaded inside Core but are documented as extraction candidates:

- `calendar`
- `messaging`
- `support`
- `surveys`

They live directly under `src/` for historical reasons. New extraction phases
should move them to `src/modules/<module-name>` following the convention above.
