# ADR-0005: Runtime and Database Boundaries

**Date:** 2026-09-15
**Status:** APPROVED
**Phase:** ARCH-1 → ARCH-2

## Decision

Aria has three explicit composition roots:

| Entrypoint | Root module | Responsibility | Required databases |
|---|---|---|---|
| `src/core-main.ts` | `CoreAppModule` | Core platform plus business capabilities currently classified as legacy Core business modules | Core |
| `src/main.ts` | `AppModule` | Combined local/development runtime; deterministic superset of Core plus CMS and independently owned Correspondence | Core, CMS, Correspondence |
| `src/cms-main.ts` | `CmsAppModule` | CMS-only business runtime; protected routes still use Core Identity/RBAC | CMS, Core |

The backend image defaults to the combined runtime. The current Compose service explicitly selects the Core runtime. A future independently deployable business module receives its own entrypoint and root module; it is never added to `CoreAppModule`.

`AppModule` and `CoreAppModule` are intentionally different: the former is the combined composition root, while the latter is the Core deployment root. The architecture test requires every Core module to be present in the combined root, preventing accidental route loss.

## Module classification

| Capability | Classification | Current persistence | Direction |
|---|---|---|---|
| Identity, Tenant, Auth/RBAC, User Directory, Storage, Notifications, AI, Rules | Platform capability | Core | Remain behind platform contracts |
| Module Platform, Integrations, Preferences, Search | Platform capability | Core | Remain Core-owned |
| Support, Messaging, Surveys, Calendar | Legacy Core business module | Core | Extraction candidates; not extracted in ARCH-1 |
| Correspondence | Independent business module | Correspondence | Database-independent now; remote-runtime decoupling remains future work |
| CMS Blog/Media | Independent data owner with Identity/RBAC coupling | CMS | Runtime identity decoupling remains future work |
| HR | Future independent business module | HR | Must use platform contracts and its own Prisma project/runtime |

Database independence does not imply remote runtime independence. Correspondence may temporarily import local platform capability modules, but it must not import Core Prisma or be imported by `CoreAppModule`.

## Persistence source of truth

| Owner | Schema | Environment variable | Runtime status | Migration command |
|---|---|---|---|---|
| Core | `prisma/core/schema.prisma` | `CORE_DATABASE_URL` | Required by every current runtime | `npm run db:migrate:core` |
| CMS | `prisma/cms/schema.prisma` | `CMS_DATABASE_URL` | Required by combined/CMS runtimes | `npm run db:migrate:cms` |
| Observability | `prisma/observability/schema.prisma` | `OBSERVABILITY_DATABASE_URL` | Optional; failure must not make Core unavailable | `npm run db:migrate:observability` |
| Correspondence | `prisma/correspondence/schema.prisma` | `CORRESPONDENCE_DATABASE_URL` | Required by combined runtime | `npm run db:migrate:correspondence` |

`prisma/schema.prisma`, `prisma/migrations`, and `DATABASE_URL` are deprecated compatibility history. They are retained to avoid rewriting or deleting applied history, but no build, startup, deployment, or migration command may use them. New migrations must be created only in the owner-specific projects.

Prisma is the only schema/migration mechanism. TypeORM commands and dependencies are retired because no runtime source uses them.

## Migration and startup policy

Migrations are a dedicated deployment step, not application startup behavior. Run only the commands for databases required by the target runtime.

| Runtime | Required migration commands |
|---|---|
| Core | `npm run db:migrate:core` |
| CMS | `npm run db:migrate:core`, `npm run db:migrate:cms` |
| Combined | `npm run db:migrate:core`, `npm run db:migrate:cms`, `npm run db:migrate:correspondence` |
| Future HR | `npm run db:migrate:core`, `npm run db:migrate:hr` |

`npm run db:migrate` is the explicit all-owner orchestration command for full-stack development only; it is not the default production deployment command. Owner-specific commands are available at the repository root.

Independent databases cannot migrate atomically. A failed required migration stops deployment before that runtime is started. If a later required database fails after an earlier one succeeds, repair the failed database and rerun: Prisma deployment is idempotent and applied history is not rolled back.

`entrypoint.sh` performs no migrations. Docker/Compose and production orchestration must not add a second implicit migration path.

## Health policy

Phase ARCH-1.2 made the health system consume the runtime matrix directly. `HealthService` is parametrized by a `RUNTIME_ID` token supplied by each composition root; readiness is computed from `runtimePolicy(runtimeId)` instead of hard-coded checks.

Each runtime has an explicit readiness contract:

- **Core runtime**: `CORE_DATABASE_URL` required; Redis, RabbitMQ, MinIO and observability are diagnostic/non-blocking. CMS and Correspondence datasources are `not-used` and are not probed or instantiated.
- **CMS runtime**: `CMS_DATABASE_URL` and `CORE_DATABASE_URL` required (Core is required for Identity/RBAC on protected routes).
- **Combined runtime**: `CORE_DATABASE_URL`, `CMS_DATABASE_URL` and `CORRESPONDENCE_DATABASE_URL` required; observability optional.
- **Future HR runtime**: `HR_DATABASE_URL` required; platform identity contract required but not Core Prisma.

A dedicated `CoreHealthModule` is imported by `CoreAppModule` so that the Core-only runtime never eagerly imports `CmsPrismaModule` or `CorrespondencePrismaModule`. The combined runtime uses `CombinedHealthModule`, which imports all optional Prisma modules but still evaluates only the datasources declared by its policy.

Redis health reuses the existing `REDIS_CLIENT` injected by `RedisModule` instead of opening a second connection. RabbitMQ health performs a short-lived TCP probe rather than opening a new AMQP connection on every request.

Health output exposes component names and status only; never URLs or credentials.

### ARCH-1.3: health is decomposed, and the status code is the answer

ARCH-1.2 made health *read* the policy. ARCH-1.3 made the policy the only thing health depends on, and made readiness visible to systems that do not parse JSON bodies.

`HealthService` is now a thin facade. It runs two probe families and hands the results to a verdict, and does nothing else — it no longer reads the policy, holds datasource clients, opens connections or computes readiness. Each concern became a separate, individually testable unit:

| Unit | Responsibility | The rule it exists to enforce |
|---|---|---|
| `DatasourceHealthProbe` | probes the datasources of one runtime | The policy decides what may be touched, not the DI graph: a `not-used` datasource is never queried, even when its client is injected. A required datasource with no client is `failed`, never healthy by default. |
| `InfrastructureHealthProbe` | probes Redis / RabbitMQ / MinIO | Nothing is invented and no second connection is opened. |
| `ReadinessEvaluator` | the verdict, from the policy alone | Only `required` failures block. A probe cannot downgrade its own requirement. Missing results fail closed. |
| `HealthService` | runs both probe families, then evaluates | A probe family that throws is caught and logged, so a wiring fault still answers 503 (not ready) instead of 500 (request failed). |

The three requirement states have exactly one meaning each, read only by the probes:

- `required` — instantiated and required: a failed or missing probe makes the runtime **not ready**.
- `optional` — instantiated but conditional: an unset variable is `not-configured` and a failing dependency is `failed`; both are reported and neither blocks readiness.
- `not-used` — not instantiated: not probed, reported as `not-used`, never a reason to block or degrade.

Two failures that only probing can detect are reported distinctly: a datasource declared but unconfigured (`not-configured`) is separated from one configured and unreachable (`failed`), and a datasource whose client is missing from the graph is `failed` rather than silently ready.

Infrastructure probing obeys three rules that were previously violated:

1. **No invented configuration.** `RABBITMQ_URL` has no fallback: an unset value is `not-configured`, and there is no built-in `amqp://user:password@host:port` default. A hard-coded credential is a leak even as a development default, and a fallback makes "never configured" indistinguishable from "configured and down" — the distinction an operator most needs to keep.
2. **No second connection.** Redis is probed through the canonical `REDIS_CLIENT` provider, so a health poll cannot multiply connections; when that provider is absent the probe reports the wiring fault instead of building a client inside a health check. RabbitMQ is probed with a bare TCP connect, so health never competes with the application's managed AMQP lifecycle.
3. **Never fatal by default.** Every probe returns a result. Whether a failure blocks readiness is the evaluator's decision, taken from the policy.

#### The HTTP status is the answer

`GET /ready` returns **200 when ready and 503 when not ready**, with the same report body in both cases. It previously returned 200 with `status: 'not-ready'` in the body, which meant every orchestrator, load balancer and dependency manager that reads status codes saw a healthy process while the runtime was saying in its body that it could not serve. A readiness endpoint whose status code never varies cannot gate traffic.

`GET /health` and `GET /live` remain liveness endpoints: they touch no dependency and always answer 200.

The report body carries the discrete probe states (`ok` / `failed` / `not-configured` / `not-used`) per dependency, alongside `requirements`, `checks`, `statuses`, `notConfigured`, `optionalDegraded` and `blocking`. Free-text probe details — which can name hosts and schemas — never leave the server, because this endpoint is intentionally unauthenticated; they are logged server-side on a not-ready verdict, and rejected probe errors are sanitized before they are stored at all.

#### One health graph per runtime, named after the runtime

The health composition of each runtime is declared once, in `RUNTIME_HEALTH_COMPOSITION`:

| Runtime | Health module | Root module | Status |
|---|---|---|---|
| Core | `CoreHealthModule` | `core-app.module.ts` | implemented |
| CMS | `CmsHealthModule` | `cms-app.module.ts` | implemented |
| Combined | `CombinedHealthModule` | `app.module.ts` | implemented |
| Future HR | `HrHealthModule` | `hr-app.module.ts` | target |

`health/health.module.ts` and its `HealthModule` class were deleted. The name was ambiguous and the ambiguity was the defect: `HealthModule` carried the *combined* runtime's policy while `CoreHealthModule` and `CmsHealthModule` sat beside it, so an import told you nothing about which health graph you were looking at — the answer lived in a `RUNTIME_ID` literal inside the file. CMS additionally had its own divergent `cms-health.controller.ts` and `cms-health.service.ts`; both are deleted. All runtimes now share exactly one controller and one service, and `createHealthProviders(runtime)` is the only place that binds a runtime to the health graph, so a module cannot pair one runtime's identity with another runtime's policy.

#### The artifact boundary is derived, not restated

`apps/api/src/runtime-datasources.ts` is the only declaration of the policy. `apps/api/runtime-policy.json` is its machine-readable projection, emitted by `npm run arch:policy` and drift-checked by `npm run test:policy`: a policy edit that was not regenerated fails a test rather than shipping a stale projection to Docker.

`apps/api/scripts/runtime-policy.mjs` is the bridge the images call (`prune-clients-for <runtime>`, `shipped-clients-for <runtime>`, `runtimes`), so a Dockerfile names the runtime it builds and derives its generated-client list from the projection instead of hard-coding it. Two consequences are deliberate:

- The prune runs **after** `npm run build`, because the build regenerates the clients and copies `src/generated` to `dist/generated`. A prune placed before the build is undone by the build — which is what happened before ARCH-1.3, leaving the image boundary decided by the `COPY` lines alone and invisibly.
- An image may prune a client the policy *does* instantiate, but only as a **declared** opt-out in `RUNTIME_DOCKER_IMAGE.prunedArtifacts`, with its reason recorded. The observability client is the only such case: `ObservabilityPrismaService` loads its generated client when the artifact is present and degrades to a no-op when it is not, so Core and the combined image ship without it and observability reports as failed-but-optional rather than vanishing from the report. `future-hr` has no Dockerfile, and `RUNTIME_DOCKER_IMAGE` says so explicitly, so no image is created before its runtime exists.

#### What enforces this

| Check | Command |
|---|---|
| Projection drift, requirement/instantiation derivation, Docker bridge | `npm run test:policy` |
| Readiness verdict semantics: blocking, degradation, not-used, fail-closed | `apps/api/src/health/readiness.evaluator.spec.ts` |
| Datasource probing: policy before client, missing clients, sanitization | `apps/api/src/health/datasource-health.probe.spec.ts` |
| Infrastructure probing: no invented configuration, no second connection | `apps/api/src/health/infrastructure-health.probe.spec.ts` |
| Facade behaviour, including a throwing probe family | `apps/api/src/health/health.service.spec.ts` |
| Runtime→datasource matrix, module imports, health module names | `npm run test:architecture` |
| Probe registry: one token per datasource, registration derived from the policy | `apps/api/src/health/datasource-probe.registry.spec.ts` |
| Composed graph in real DI: fail-closed missing clients, the HR seam, not-used never probed | `apps/api/src/health/health.providers.spec.ts` |
| Notification publisher: no credential fallback | `apps/api/src/notifications/notification.publisher.spec.ts` |

### ARCH-2: composition is derived, not hand-written

ARCH-1.3 removed the policy from the health engine. One thing was still written into it by hand: the mapping from a datasource to the client that reaches it. `DatasourceHealthProbe` held one optional constructor parameter per datasource and resolved them with a private `switch (datasource)` — the engine itself knew that `CORE_DATABASE_URL` means `corePrisma`, and `HR_DATABASE_URL` was already a branch in that switch, taught about a datasource that does not exist.

The mapping now lives in `health/datasource-probe.registry.ts`, and the engine knows none of it:

| Piece | What it is | The rule it exists to enforce |
|---|---|---|
| `DatasourceProbeProvider` | the one question asked about a datasource: `query(): Promise<boolean>` | The engine cannot reach a client, only a probe; there is no token it could name to obtain one. |
| `DATASOURCE_PROBES` | one declaration per datasource: the client token that carries it, and how to probe it | Completeness is the type. It is a `Record<Datasource, ...>`, so a datasource without a probe declaration is a compile error, not a runtime surprise. |
| `DATASOURCE_PROBE_PROVIDERS` | the assembled registry of one runtime, injected as an array under one token | The engine cannot look a datasource up by naming a token; it receives what this runtime's policy produced. |
| `createDatasourceProbeProviders(runtime)` | builds that registry from the policy | The injected token list IS `instantiatedDatasources(runtime)`; there is no second list a datasource could be missing from, or present in by mistake. |

Registration is `optional` per datasource, deliberately. A plan entry whose client token has no provider yields **no** registered provider, which the probe reports as `failed`. A hard DI error would make a datasource un-bootable, and treating "no client" as "fine" is how a readiness endpoint ends up certifying a database it never touched.

#### The HR seam

HR remains a target: `DATASOURCE_OWNERS.HR_DATABASE_URL.status` and `RUNTIME_HEALTH_COMPOSITION['future-hr'].status` are still `target`, and no HR module, schema, Prisma project or health module exists. `future-hr` still has no Dockerfile. What ARCH-2 adds is the ability to activate HR **without touching the health engine**: `DATASOURCE_PROBES.HR_DATABASE_URL` is declared and bound to `HR_PRISMA_CLIENT`, so Phase 51-HR only has to provide that client.

Until then the seam has exactly the semantics the gate requires:

- `future-hr` with a bound HR client → HR is probed, `ok`, `required`.
- `future-hr` with no bound client → HR is `failed` and `blocking`, so the runtime is not ready (fails closed).
- `core`, `cms` and `combined` with a bound HR client → HR is `not-used`; the client is never queried.
- HR is never registered for a runtime whose policy says `not-used`, so a `not-used` datasource cannot be probed even when a client is present in the graph.

`datasourcesAwaitingProbeClient(runtime)` derives that list from the declaration status, so it cannot drift from the datasource's own `status`.

#### Configuration and policy are different questions

`runtime-datasources.ts` answers "may this runtime reach this datasource?", and `runtime-policy.json` is its projection for Docker. `config/env.validation.ts` answers "is this value a valid URL?", and says nothing about which runtime needs it. They stay separate: `future-hr` is a declared runtime with an HR requirement while no HR client, schema, or `HR_DATABASE_URL` validation exists, and the probe fails closed until that intent is implemented. `RABBITMQ_URL` is likewise optional in validation and `optional` in every runtime's policy, so an unset broker is a supported configuration.

#### RabbitMQ has no credential fallback

ARCH-1.3 removed the invented default from infrastructure *probing*. ARCH-2 removed it from the *publisher*: `NotificationPublisher` resolved its URL as `RABBITMQ_URL || 'amqp://<user>:<password>@rabbitmq:5672'`, so a missing variable silently connected with a hard-coded credential instead of reporting that no broker was configured. The literal is gone and `resolveRabbitMqUrl` returns `null`; "no broker" is a state, not an error. An unconfigured process logs that it will not publish and records the audit retry, a configured-but-failing publish keeps its existing fail-fast behaviour, and neither path throws into the HTTP caller.

## Module platform execution model

Two phases are intentionally supported:

- **LOCAL combined execution**: business modules may consume approved local platform adapters (e.g., `UserDirectoryModule`, `NotificationModule`, `StorageModule`).
- **REMOTE execution**: business modules use `ModuleClient` and platform contracts; caller never sees URL, credential, `deploymentMode`, `instanceId` or topology.

New independent business modules MUST live under `src/modules/<module>` and own their own Prisma schema, migrations and service. Legacy Core business modules (`calendar`, `messaging`, `support`, `surveys`) remain extraction candidates and stay where they are until a dedicated extraction phase.

## Security invariants

Phase ARCH-1.2 closed the CMS environment-validation and CORS regressions:

- Every composition root (`main.ts`, `core-main.ts`, `cms-main.ts`) configures `ConfigModule` with the centralized `validateEnv` policy.
- Wildcard CORS origins with credentials enabled are rejected by `validateEnv` in production.
- `cms-main.ts` uses the same `buildCorsOrigin` allowlist builder as the other runtimes; there is no `origin: ... || '*'` fallback.

## HR prerequisites

Before HR implementation:

- `Core.User` and `HR.Employee` remain distinct models.
- HR has `HR_DATABASE_URL`, an owner-specific schema, generated client, and migration history.
- HR persistence cannot import Core Prisma.
- Identity lookup uses the allowlisted, batch-oriented `UserDirectoryContract`.
- HR has its own module/root runtime and is never imported by `CoreAppModule`.
- Platform access uses contracts/ports or `ModuleClient`, not deployment topology or credentials.
- HR must be added to `runtime-datasources.ts` and the `INDEPENDENT_MODULE_OWNER_REGISTRY` so the architecture tests enforce its persistence boundary from the start.
- HR must bind a real `HR_PRISMA_CLIENT` for the already-declared `DATASOURCE_PROBES.HR_DATABASE_URL` entry at the same time its policy stops saying `not-used`. Probing it requires no change to the health engine: Phase ARCH-2 moved the datasource→client mapping out of the engine and into the probe registry. Until that client exists the probe fails closed, so a runtime that requires HR is never ready — deliberately, so a client that was never built cannot be reported as healthy.
- HR must declare its Dockerfile in `RUNTIME_DOCKER_IMAGE` (today `future-hr` has none) before any image is built for it, and regenerate the projection with `npm run arch:policy`.
