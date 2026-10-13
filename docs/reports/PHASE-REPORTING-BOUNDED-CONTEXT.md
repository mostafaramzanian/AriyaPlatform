# Phase Report — Reporting Bounded Context Foundation

> Implementation commit: **`83a080a`** — `feat(reporting): establish reporting bounded context`.
> Baseline before this phase: `38566f8` (the Reporting AI consumer phase).

## 1. What this phase is

The **bounded-context foundation** for Reporting: the reporting context is made
real by making its OWNERSHIP explicit and its boundaries executable — and by
nothing else, because the repository establishes **no Reporting business
contract** to implement. No domain entity was invented, no route was created, no
permission was seeded, no database was declared. The deliverable is the
boundary: what Reporting owns, what it must never own, and where its
dependencies may land — enforced by `reporting-isolation.spec.ts` and documented
here, so the next phase that DOES bring a real report contract (a) inherits a
clean context to build in and (b) is forced, by named failing gates, to declare
its contract surface deliberately.

## 2. Pre-flight evidence (four-way classification)

### CONFIRMED REQUIREMENT

**None for Reporting business behavior.** A repository-wide search — tracked
files in `apps/`, `packages/`, `docs/`, `infrastructure/`, `.github/`, plus
`git log --all -- '*report*' '*reporting*'` and the deletion history — found NO
report type, report definition, KPI formula, dashboard, widget, filter, schedule,
subscription, export, report permission, aggregation rule, metric, data
warehouse or materialized view anywhere in the repository. No `Report`, `Metric`
or `Dashboard` Prisma model exists in any of the eight schemas. No `reporting.*`
permission string exists in the RBAC constants or any seed migration. No
`REPORTING` member exists in the `PermissionDomain` enum. No `prisma/reporting`
directory exists. The git history contains no reverted or deleted Reporting
domain work (`git log --all --diff-filter=D -- '*report*'` returns only an
unrelated 2026 RBAC documentation file).

### ARCHITECTURAL CONSTRAINT

1. Reporting IS a bounded context: `apps/api/src/modules/reporting/`, whose
   composition root is registered in `app.module.ts` (combined runtime) and
   deliberately NOT in `core-app.module.ts` / `cms-app.module.ts` — the same
   rule Correspondence, HR, Commerce, Production and Financial hold
   (`fec78be`; `modules/README.md`).
2. Its single dependency is `PlatformAIModule` -> `AI_GATEWAY`
   (`AIGatewayContract`, embed-only) — `docs/architecture/AI-PLATFORM.md` §11
   states "Reporting depends on `PlatformAIModule` + `AI_GATEWAY` only".
3. Executable AI-boundary gates already exist in `src/ai/ai-boundaries.spec.ts`:
   Reporting sources cannot import `src/ai/**`, `src/database/**`,
   `src/generated/**`, `CryptoService`, provider SDKs, or read `process.env`.
4. Module conventions from `apps/api/src/modules/README.md`: business modules
   never import Core's `PrismaModule`; identity/RBAC lookups go through platform
   contracts; `@Roles` is metadata resolved by the global `RolesGuard`, so no
   business module imports `RbacModule` (Financial E2 / Production E2 precedent).
5. Every bounded context carries an isolation suite (`hr-isolation`,
   `commerce-isolation`, `correspondence-isolation`, `production-isolation`,
   `financial-isolation`) pinning its promises executably. Reporting had none —
   this phase adds it.

### FUTURE / ROADMAP

1. Commerce GAP-4 "KPI / summary" is recorded as "STILL OPEN — intentionally
   deferred to a **future Reporting module**" (`PHASE-C3-LINE-ROUTING-...:404`).
   That is a roadmap POINTER, not a contract: the same documents record "no
   `GET …/summary` analog exists" and that "richer analytics need a new endpoint
   family (**product decision first**)" (`PHASE-UI-0-...§26-GAP-4`;
   `PHASE-UI-5-...:36`). No KPI is defined anywhere — no formula, no input set,
   no output shape. Implementing it now would be fabricated business behavior.
2. "before freezing Commerce and starting Reporting architecture"
   (`PHASE-COMMERCE-FINAL-STABILIZATION.md`) — a sequencing note that this phase
   is the sanctioned next step; it defines no Reporting content.
3. `AI-PLATFORM.md`: "AI Decision Support composes on Reporting's semantic
   layer" — future extension point; no semantic layer is specified.

### UNSUPPORTED / UNKNOWN

Everything business-level: report types, report definitions, KPI formulas,
dashboards, widgets, filters, scheduling, subscriptions, exports, report
permissions, financial/production/HR metrics, aggregation rules, date/number
semantics, output contracts, data warehouse structures, materialized views, AI
summaries/explanations. Each stays UNSUPPORTED until a requirement specifies it;
none was fabricated.

## 3. Contract decision

**What Reporting now guarantees (the whole list):**

1. It is an independently owned bounded context with an explicit composition
   root, registered only in the combined runtime.
2. It owns NO persistence: no schema, no datasource, no client — and therefore
   cannot become a second source of truth for any data.
3. Its overall dependency surface is exactly `PlatformAIModule`; in-repo imports
   may land only in this module or `src/platform/ai/**`, and the only package it
   may name is `@nestjs/common`.
4. It exposes NO API surface: zero controllers, zero providers, zero exports.
5. It declares NO permission and NO `PermissionDomain` member.
6. It reads no other bounded context's tables (no Prisma surface of any owner).
7. Its entire boundary is executable: every guarantee above is a named,
   non-vacuous assertion that fails on the way in when violated.

**What remains explicitly undefined:** every business concept listed in §2's
UNSUPPORTED section. Their absence is preserved, not papered over.

## 4. Architecture (final dependency direction)

```text
                 (nothing reads Reporting: zero routes, zero exports)

Reporting (src/modules/reporting)
    |  imports: [PlatformAIModule] — exactly this
    v
AI_GATEWAY token -> AIGatewayContract (embed only)
    v
Platform AI runtime (resolution, credentials, capability matrix, providers)

Reporting    x--> src/ai/**            (blocked: ai-boundaries.spec.ts)
Reporting    x--> src/database/**      (blocked: ai-boundaries + isolation)
Reporting    x--> generated/*-client   (blocked: isolation)
Reporting    x--> other bounded contexts' internals   (blocked: isolation)
Reporting    x--> RbacModule           (blocked: isolation)

FUTURE (when a real report contract exists):
Source Business Context -> approved read/query port -> Reporting
```

## 5. Files changed

| File | Change | Why |
| ---- | ------ | --- |
| `apps/api/src/modules/reporting/reporting-isolation.spec.ts` | **NEW** — 15 tests in six groups (A entry point, B persistence, C dependency direction, D authorization, E composition, F deferred surfaces) | The bounded context's whole promise set, re-read from disk so each one is falsifiable. Every scan is non-vacuous; the non-spec file list is EXACT so a second source file must be confronted here first. |
| `apps/api/src/modules/reporting/reporting.module.ts` | Comment/ownership declaration only — no behavior change | States what the context owns (composition root + AI seam) and what it deliberately does not (datasource, client, routes, services, permissions, entities), names the evidence report, and describes the deliberate path any future contract must take. |
| `apps/api/src/app.module.ts` | Comment-only | The registration comment now names the bounded-context foundation and both executable halves of the boundary (`reporting-isolation.spec.ts`, `ai-boundaries.spec.ts`); the registration itself is unchanged. |
| `docs/reports/PHASE-REPORTING-BOUNDED-CONTEXT.md` | **NEW** — this report | The phase record: evidence inventory with classification, contract decision, security, verification, gaps. |

No datasource declaration, no Prisma schema, no migration, no controller, no
DTO, no permission, no seed, no health composition, no runtime policy, no
Docker change — each of those is a boundary the isolation suite now asserts
ABSENT, and each will arrive only with a contract that justifies it.

## 6. Security

- **Tenant isolation.** No tenant surface exists to leak: Reporting has zero
  routes and zero persistence, so there is no query a cross-tenant request
  could reach — the isolation suite's "zero controllers + no Prisma surface of
  any owner" makes a `tenant A report -> tenant B data` path impossible by
  construction. When the first route lands, actor resolution must follow the
  established `resolveFinancialActor` / `resolveProductionActor` pattern: the
  tenant comes from `RequestContextService` (server-derived), never from a body,
  query, path parameter or `req.user.tenantId` fallback, and a request with no
  resolved tenant fails closed (403).
- **Authorization.** No Reporting operation exists, so no Reporting permission
  was created — and that placement is executable: no `reporting.*` string in
  the RBAC constants, no `REPORTING` member in `PermissionDomain`, no
  `RbacModule` import (which would pull Core's `PrismaModule` and
  `NotificationModule` transitively), no RBAC service injection. The global
  guard model (`JwtAuthGuard` + `RolesGuard` as `APP_GUARD`, `PermissionSource`
  bound by each composition root) is untouched.
- **Source-data access.** Reporting cannot reach any owner's database: the
  isolation suite resolves every relative import and rejects anything outside
  `src/modules/reporting/**` and `src/platform/ai/**`, and scans all import
  specifiers for any Prisma / `generated/` / `database/` surface. Approved
  reads of other contexts arrive later through explicit ports, never through a
  second Prisma client.
- **AI boundary.** Reporting reaches AI through exactly one door —
  `AI_GATEWAY` -> `AIGatewayContract` (`embed` only) — and the pre-existing
  `ai-boundaries.spec.ts` gates re-verified green: no `src/ai/**`, no
  `CryptoService`, no provider SDKs, no `process.env` reads from Reporting
  sources. Text generation stays blocked: no provider implements
  `TEXT_GENERATION` and the contract gate pins the interface to `['embed']`.
- **Secret handling.** Reporting never touches credentials, endpoints or
  provider configuration: the only value it can inject is the token, and the
  gateway result carries no credential at any depth (AI hardening report §5).
  No new secret, URL or key literal was added by this phase.

## 7. Verification (every command executed)

All commands were run from `apps/api` unless noted; baseline commit `38566f8`.

| # | Check | Command | Result |
| - | ----- | ------- | ------ |
| 1 | Focused Reporting tests | `jest src/modules/reporting --silent` | **PASS** — 2 suites, 19 tests (4 wiring + 15 isolation) |
| 2 | AI boundary gates | `jest src/modules/reporting src/ai/ai-boundaries.spec.ts --silent` | **PASS** — 3 suites, 31 tests (the ai-boundaries suite's 12 included) |
| 3 | Architecture + policy + drift guards | `jest src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts src/prisma-drift-guard.spec.ts src/docker-artifact-guard.spec.ts` | **PASS** — 4 suites, 81 tests |
| 4 | Typecheck | `tsc --noEmit -p tsconfig.json` | **PASS** — exit 0, no diagnostics |
| 5 | Full API unit suite | `jest --silent` (full run) | **PASS** — 249 suites, 4061 tests, 46.4 s — exactly `+1 suite / +15 tests` vs. the recorded 248/4046 baseline |
| 6 | API build | `nest build` (exit code captured) | **PASS** — `BUILD-EXIT=0`, `dist/main.js` emitted |
| 7 | Targeted e2e (stack running) | `jest --config ./jest-e2e.json --runInBand test/app.e2e-spec.ts` | **PASS** — 1 suite, 51 tests; boots the real `AppModule`, i.e. the actual `ReportingModule` registration |
| 8 | AI-seam e2e (Reporting's only dependency) | `jest --config ./jest-e2e.json --runInBand test/search.e2e-spec.ts` | **PASS** — 1 suite, 41 tests; the gateway path Reporting consumes |
| 9 | Lint on touched files | `eslint src/modules/reporting/reporting-isolation.spec.ts src/modules/reporting/reporting.module.ts src/app.module.ts` | **PASS** — exit 0 |
| 10 | Formatting | `prettier --check` + per-file content diff on the 3 touched code files | Warnings are the repo-wide CRLF baseline (`core.autocrlf=true`; untouched files, e.g. `financial-isolation.spec.ts`, warn identically). Content diff: all three touched files **CONTENT-OK — 0 deviations** |
| 11 | git diff / status | `git diff`, `git status --porcelain` | 2 modified + 1 new code file; no unrelated changes |

Pre-existing conditions, recorded not hidden: the full unit run prints the
"worker process failed to exit gracefully" warning that also appears in
historical logs; the prettier CRLF baseline above. No new failure was
introduced; every failure class in this phase is empty (`NEW/INTRODUCED`: none;
pre-existing: the two recorded above; environment: none encountered — the
docker stack answered both e2e suites).

## 8. Deliberately NOT implemented

Nothing from the brief's scope-protection list was built: no dashboard
platform, no BI engine, no data warehouse, no report designer, no scheduled
reporting, no export framework, no notification engine, no AI decision support,
no AI text generation, no RAG, no vector-store work. Concretely absent and
gate-protected: datasource/schema/migrations (no persistence contract), routes/
controllers/DTOs (no API contract), permissions and `PermissionDomain` member
(no operation), search integration (no Search requirement), notifications,
workflows and schedulers (no event/requirement), AI call sites (no domain use
case yet — the first one may consume `embed`; text generation remains blocked
by a missing platform capability).

## 9. Remaining gaps (explicit classification)

- **Implemented:** the Reporting bounded-context foundation — explicit
  ownership at the composition root, 15 executable boundary guarantees across
  six groups, phase record with classified evidence.
- **Intentionally deferred (roadmap, no contract exists):** Commerce GAP-4
  KPI/summary ("product decision first"); Commerce/FIN/HR reporting surfaces;
  AI Decision Support over a "Reporting semantic layer".
- **Unsupported by current requirements:** report types and definitions, KPI
  formulas, dashboards, widgets, filters, scheduling, subscriptions, exports,
  report permissions, financial/production/HR metrics, aggregation rules,
  date/number semantics, output contracts, warehouse/materialized-view
  structures, AI summaries/explanations — each awaits a requirement that
  specifies it (inputs, authorization, tenant scope, source data, aggregation,
  output, precision) before any code.
- **Blocked by missing platform capability:** AI text generation
  (`TEXT_GENERATION` has no implemented provider and the gateway contract gate
  pins `['embed']`); anything needing generated text must wait for a real
  implementation, not a stub.

## 10. Commit

Implementation commit: **`83a080a`** — `feat(reporting): establish reporting
bounded context` (hash recorded here by the follow-up documentation commit, per
repository convention). Baseline: `38566f8`.



