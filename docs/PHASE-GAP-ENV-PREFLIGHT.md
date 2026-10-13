# PHASE GAP-ENV — PREFLIGHT / ENVIRONMENT · RUNTIME · DEPLOYMENT CONTRACT DISCOVERY
## Environment and deployment entry point, after Commerce phases C1–C9

**Status:** discovery-only. No source, schema, migration, Dockerfile, `docker-compose.yml`, env file, nginx config, seed or test file was modified. Nothing was built, migrated, seeded or restarted. The only artifact of this phase is this report.

**Repository:** `E:\ERP` · **Branch:** `master` · **HEAD:** `c0fab92` ("test(commerce): order U teardown before pinned versions") · **Working tree:** NOT clean — 130 `git status --porcelain` entries before this document was written (65 untracked, 65 modified/deleted; 131 after, the new entry being this file). The uncommitted work adds the C7/C8/C9 Commerce audit-read/timeline and search-source surface (3 untracked migration directories, modified `commerce`/`core` schemas, `seed.ts` modified, `seed.js` deleted). Every finding below is stated against the tree as it exists now, and each finding says whether HEAD and the working tree agree.

**Read-only checks run:** directory listings; `Select-String`/`findstr` audits over `apps/api/{src,prisma,test,scripts}`, `apps/web/{src,.next}`, `infrastructure/**`, `nginx/**`, `docs/**`, root files; `git ls-files`, `git status --porcelain`, `git check-ignore`, `git log -S`, `git show HEAD:docker-compose.yml`; `docker compose config`, `docker compose up --dry-run`, `docker ps -a`, `docker inspect` (labels, mounts, env, `Config.Cmd`), `docker logs`, `docker exec` (read-only `ls`/`grep`/`nginx -T`/`env`); `prisma migrate status` and `prisma validate` per schema; live HTTP probes (`/api/v1/health`, `/api/v1/live`, `/api/v1/ready`, `/.well-known/jwks.json`, CORS `OPTIONS`); three Jest suites run to green. **No build, no `prisma generate`, no migration, no seed, no database write, no container recreate.**

---

## Coverage map — the 19 required areas, letters A–S

| § | Area | Primary question answered |
|---|---|---|
| A | Scope | What GAP-ENV is, and what is out of scope |
| B | Method | What was read, run and deliberately not run |
| C | Declared deployment contract | What the repository says gets deployed |
| D | Deployed reality | What is actually running right now |
| E | Entry point gap | Which composition root serves Commerce — and which one is pinned |
| F | Image staleness / code-schema drift | Whether the running artifact contains C1–C9 |
| G | Datasource & database contract | Six schemas, six URLs, one cluster |
| H | Migration contract & status | Per-schema migration state and deploy order |
| I | The seventh Prisma project | The legacy root schema the CLI uses by default |
| J | Prisma CLI/client env loading | cwd, `.env` vs `.env.local`, `P1012` |
| K | Env-var contract | `.env.example` vs compose vs code |
| L | Secrets & key material | JWT signing keys, JWKS, placeholders |
| M | Health / readiness / liveness | What the API proves, and what compose never asks |
| N | CORS & error semantics | Allow-list, and the 500 on a rejected origin |
| O | Dependency classification | required / optional / silently degraded |
| P | Frontend configuration | `NEXT_PUBLIC_*` is build-time, and it is baked wrong |
| Q | Ingress / edge contract | The nginx service in compose is not a proxy |
| R | Test & e2e environment | Two jest configs, dead `globalSetup`, external dbproxy |
| S | CI/CD, seed, operator docs | The absent release pipeline and the docs that claim it exists |

**Finding classification used throughout (A–E):**

| Class | Meaning |
|---|---|
| **A — CONTRACT GAP** | The repository's own declared contract is self-contradictory or cannot be executed as written. A source/config change is required. |
| **B — DEPLOYMENT DRIFT** | The deployed artifact does not match the declared contract. No source change alone fixes it; a rebuild/recreate (operator action) does. |
| **C — OPERATIONAL PREREQUISITE** | Nothing is wrong in the repository, but the environment must supply something that no committed file supplies. |
| **D — DOCUMENTATION GAP** | A repository document (README/ARCHITECTURE/FOLDER_STRUCTURE/doc link) states something that is not true of the tree. |
| **E — NO GAP (verified)** | Checked and correct; recorded so a later phase does not "fix" it or assume it was never checked. |

---

## A. SCOPE AND THE QUESTION GAP-ENV ASKS

`GAP-ENV` is the standing **environment / deployment entry point** gap named in the phase reports. It appears across the Commerce series as an explicitly deferred item, never investigated:

- `docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md:42` — "**GAP-ENV** environment / deployment entry point | **NOTED (operator action)** | Docker `aria-erp-web` predates every UI phase".
- `docs/PHASE-C3-LINE-ROUTING-CONFIGURATION-HTTP-CONTRACT.md:410` — "GAP-ENV deployment / runtime alignment | STILL OPEN — untouched".
- `docs/PHASE-C5-COMMERCIAL-QUOTATION-GAP-CLOSURE-CONTRACT.md:305` — "GAP-9 Notifications OPEN · GAP-ENV Deployment OPEN".
- `docs/PHASE-C8-COMMERCE-SEARCH-CONTRACT.md:58,790` and `docs/PHASE-C9-COMMERCE-SEARCH-SOURCE-CONTRACT.md:369` — GAP-ENV listed as untouched/OPEN at the close of each phase.
- `docs/PHASE-C6-AUDIT-READ-TIMELINE-CONTRACT.md:6` — the phase explicitly did **not** touch GAP-ENV.

So the question this preflight answers, from source and from the live stack only:

> After Commerce phases **C1–C9**, is the platform's environment / runtime / deployment contract — the entry point actually deployed, the environment that entry point reads, the databases and migrations behind it, the secrets it needs, the edge in front of it, and the pipeline that produces it — **coherent, executable and reproducible from this repository**? Where it is not, what exactly is missing?

Out of scope, deliberately: implementing any fix; changing any source, schema, migration, Dockerfile, compose file, nginx config, env file or test; re-creating or restarting a container; running a migration, seed or build; deciding which of two competing contracts wins (that is the implementation prompt's job). GAP-ENV is a *contract discovery* phase.

---

## B. METHOD, ARTIFACTS AND READ-ONLY GUARANTEE

Three evidence families were used, and **every claim below names which one produced it**:

1. **Repository source** — files read directly, cited as `path:line`.
2. **Repository metadata** — git state (`ls-files`, `status`, `check-ignore`, `log -S`, `show HEAD:`) and Prisma CLI output (`migrate status`, `validate`) run read-only.
3. **Live stack probes** — HTTP requests against the running containers, `docker inspect` metadata, `docker logs` tails, and read-only `docker exec` (`ls`, `grep`, `env`, `nginx -T`).

Deliberately **not** done, so this report cannot be mistaken for an implementation: no `docker compose up/down/restart/build`, no container recreate (a `--dry-run` was used to *observe* what compose would do without doing it), no `prisma migrate`, `db push`, `generate` or `seed`, no file write outside this document, no environment variable persisted.

Three previously-failing Jest invocations were re-run with a working configuration and are green (evidence for §R): `src/config/env.validation.spec.ts` 17/17, `src/architecture-boundaries.spec.ts` 24/24, `src/runtime-policy.spec.ts` 32/32.

**Two probe limitations are recorded honestly:** (1) the Prisma CLI here is invoked as `node node_modules/prisma/build/index.js …` because the `npx prisma` shim is not usable in this shell; (2) that CLI's schema-path handling differs per subcommand — `migrate status` honours `--schema=<path>`, while a *positional* path to `validate` is ignored and the **default** `prisma/schema.prisma` is validated instead. This is itself a finding (§I), and every statement below uses the form that was actually observed.

---

## C. THE DECLARED DEPLOYMENT CONTRACT (what the repository says is deployed)

Read together, `docker-compose.yml`, the four Dockerfiles, `runtime-policy.json` and ADR-0005 declare:

| Element | Declared |
|---|---|
| Services | `postgres` (`pgvector/pgvector:pg16`, published `5433:5432`), `redis` (`7.4`), `rabbitmq` (`3.13-management-alpine`), `minio`, `mailpit`, `api` (`3001`), `web` (`3000`), `nginx` (`80`,`443`) — `docker-compose.yml:28-99,119-331` |
| API image | `infrastructure/docker/Dockerfile.backend` — "Combined runtime image … Ships Core, CMS, Correspondence, HR and Commerce modules" (`Dockerfile.backend:1-3`, used at `docker-compose.yml:120-122`) |
| API command | compose pins **core-main**: `exec node dist/core-main.js`, after loading the two Docker secrets (`docker-compose.yml:292-299`; identical in `HEAD` per `git show HEAD:docker-compose.yml`) |
| Image default | `CMD ["node", "dist/main.js"]` — "The default image is the documented combined composition root; Compose may select core-main explicitly" (`Dockerfile.backend` tail) |
| Runtimes | `runtime-policy.json` declares four: `core`, `cms`, `combined`, `future-hr` |
| Migrations | "a dedicated deployment step … never container startup" (`Dockerfile.backend`; `docker-compose.yml:127-128`); `entrypoint.sh` performs none; ADR-0005:62 — "Docker/Compose and production orchestration must not add a second implicit migration path" |
| Health | ADR-0005:64-92 — `HealthService` is parametrised by `RUNTIME_ID`; readiness is computed from `runtimePolicy(runtimeId)` |
| Secrets | JWT signing material from `/run/secrets/`, never in git (`docker-compose.yml:333-339`) |
| Web | built by `Dockerfile.frontend`, started with `npm run start`, `NEXT_PUBLIC_API_URL: http://localhost:3001` as a **container environment variable** (`docker-compose.yml:302-315`) |

The **first contradiction** is visible in this table alone: the image is *combined* (`Dockerfile.backend:1-3`) while the command is *core* (`docker-compose.yml:299`). §E shows why that is not cosmetic.

---

## D. THE DEPLOYED REALITY (what is actually running)

Live probes (`docker ps -a`, `docker inspect`, HTTP) on the running stack:

| Container | Image | Status | Started |
|---|---|---|---|
| `aria-erp-api` | `erp-api` (= `erp-api:latest`, built `2026-09-30T13:42Z`) | Up | `2026-10-02T11:06Z` (created `2026-09-30T13:59Z`) |
| `aria-erp-web` | `erp-web` (`erp-web:latest`, 2 weeks old) | Up | same engine restart |
| `aria-erp-postgres` | `pgvector/pgvector:pg16` | healthy | published `5433` |
| `aria-erp-redis`, `aria-erp-rabbitmq`, `aria-erp-minio`, `aria-erp-mailpit` | as declared | healthy | — |
| `aria-erp-nginx` | `nginx:1.29-alpine` | Up | published `80`,`443` |
| `aria-erp-e2e-dbproxy` | `alpine/socat:latest` | Up | `5432/tcp -> 5544` |
| `aria-erp-postgres2` | `postgres:16.3-alpine` | **Exited (255) 5 weeks ago** | dead leftover, not in compose |

Three facts about `aria-erp-api` matter more than the rest, each from `docker inspect`:

1. **Its `Config.Cmd` is not the committed compose command.** Observed:
   `IFS= read -r JWT_ACTIVE_KEY_ID < /run/secrets/JWT_ACTIVE_KEY_ID && … export … && exec node dist/main.js`
   The secret-loading prefix matches `docker-compose.yml:296-298`, but the final exec is **`dist/main.js`**, whereas compose (and `HEAD`) say **`dist/core-main.js`**.
2. **It was created at `2026-09-30T13:59Z`**, i.e. *before* the newest commit that changed the API command — `824e074 "feat(commerce): compose Commerce into combined runtime (C1 F)"` (`git log --oneline -- docker-compose.yml`). It has since only been *restarted* (engine restart, `StartedAt 2026-10-02T11:06Z`), so it still runs the command captured at creation time.
3. **Compose says it would replace it.** `docker compose up --dry-run` (read-only) prints:
   `Container aria-erp-api Recreate` / `Container aria-erp-api Recreated`.

So the declared contract (§C) and the running container (§D) disagree on the single most consequential line in the deployment: the process that boots. Compose labels on the container are from project `erp`, `version 5.5.0`, config-hash `50dd50b4…`, `working_dir E:\ERP` — i.e. the container *was* created by an earlier revision of this same compose project, not hand-run; the drift is a stale-command drift, not a renegade container.

HTTP probes against the running API (`http://localhost:3001`):

| Path | Result |
|---|---|
| `/api/v1/health` | 200 |
| `/api/v1/live` | 200 (`{"runtime":…,"status":"alive"}`) |
| `/api/v1/ready` | 200, body declares `"runtime":"combined"` |
| `/api/v1/health/live` | **404** (a path some documentation implies) |
| `/.well-known/jwks.json` | 200, `{"keys":[{…,"kid":"gate-a-rsa-1","alg":"RS256"}…]}`, 431 bytes |
| `/api/v1/commerce/purchase-documents` | 401 (route exists, guard answers) |
| `/api/v1/commerce/completion-policies` | **404** |
| `/api/v1/admin/observability/logs`, `/audit-events` | 401 (routes exist) |
| `/api/v1/docs`, `/api/docs` | **404** |

The `ready` body is the authoritative runtime self-description and is worth quoting verbatim (abridged):

```json
{"runtime":"combined","status":"ready",
 "checks":{"coreDatabase":true,"cmsDatabase":true,"observabilityDatabase":false,
           "correspondenceDatabase":true,"hrDatabase":true,"commerceDatabase":true,
           "redis":true,"rabbitmq":true,"storage":true},
 "requirements":{"coreDatabase":"required","cmsDatabase":"required","observabilityDatabase":"optional",
                 "correspondenceDatabase":"required","hrDatabase":"required","commerceDatabase":"required",
                 "redis":"optional","rabbitmq":"optional","storage":"optional"},
 "notConfigured":[],"optionalDegraded":["observabilityDatabase"],"blocking":[]}
```

**Read that against §C/§E:** the *running* process is the **combined** runtime (it answers for `cmsDatabase`, `hrDatabase`, `commerceDatabase`), i.e. `dist/main.js`. The *declared* command is core-main, whose policy marks CMS/HR/Correspondence/Commerce `not-used` (see §E). The two are not different spellings of the same deployment — they serve different route sets.

---

## E. THE ENTRY POINT GAP — COMPOSE PINS A RUNTIME THAT CANNOT SERVE COMMERCE

This is the **headline finding of GAP-ENV**, established entirely from repository source:

| Claim | Evidence |
|---|---|
| `dist/core-main.js` boots `CoreAppModule` only | `apps/api/src/core-main.ts:7` (`import { CoreAppModule } from './core-app.module'`), `:22` (`NestFactory.create(CoreAppModule…)`), `:73` (`setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] })`) |
| `CoreAppModule` imports **no** Commerce, HR, Correspondence or CMS module | `apps/api/src/core-app.module.ts:1-39` (complete import list: Auth, Redis, Users, Tenant, Prisma, `CoreHealthModule`, Notifications, Storage, AI, Rules, Messaging, Support, Surveys, Calendar, Search, Preferences, Integrations, ModulePlatform, PlatformAudit, PlatformIdentity, Observability — and nothing else) and `:60-209` (complete `imports:` array) |
| `CommerceModule` exists **only** in the combined root | `apps/api/src/app.module.ts:51` (import), `:137` (registered); `HrModule` `:43,130`; `CorrespondenceModule` `:36,125` — none in `core-app.module.ts` |
| The policy says the same | `apps/api/runtime-policy.json` → `runtimes.core.datasources.COMMERCE_DATABASE_URL.requirement = "not-used"`; `runtimes.core.notInstantiatedOwners` includes `commerce`; `runtimes.core.prunedClientDirs` includes `commerce-client`; `runtimes.core.health = { className: "CoreHealthModule", appModuleFile: "core-app.module.ts" }` |
| Compose pins core-main | `docker-compose.yml:292-299` — `command: … exec node dist/core-main.js` (identical in `HEAD`) |
| ADR-0005 repeats it | `ADR-0005-ARCH-1-RUNTIME-AND-DATABASE-BOUNDARIES.md:17` — "The backend image defaults to the combined runtime. The current Compose service explicitly selects the Core runtime." |

**Therefore `docker compose up -d --force-recreate` — the operation compose itself announces (§D.3) — boots a process in which no Commerce route exists.** Every C1–C9 endpoint (`/commerce/*`, completion policies, pending decisions, workflow instances, search, search-source) leaves the deployed API and answers 404, exactly as `/api/v1/commerce/completion-policies` already does today for a different reason (§F). The 401 currently observed on `/api/v1/commerce/purchase-documents` exists only because the *running* container deviates from the committed compose file and runs `main.js`.

Two aggravating details, both from source:

1. **This defect class is already documented once, inside the compose file.** `docker-compose.yml:281-289` records the Phase 49G-5 incident: "The Dockerfile default is `node dist/main.js` … The container that had been serving :3001 was started by hand as `node dist/core-main.js`, so the ticketing and messaging routes existed at runtime while this file said nothing about it. Recreating the service from compose therefore silently dropped `/tickets`. Declaring the command here makes the compose definition match the runtime it is meant to describe." That fix made compose match the runtime **of that moment** — a Core-only runtime. Phases C1–C9 then added Commerce to the *combined* root and the *combined* policy (`824e074`), and the pin was never revisited, so the pin is now the thing that would drop Commerce.
2. **The suppression is asymmetric:** `runtime-policy.json` marks Commerce `required` in the combined runtime (the live `/ready` body confirms `"commerceDatabase":"required"`), and `Dockerfile.backend:58-66` ships the Commerce schema and its migration history precisely because "`commerce_db` is required by this image". The image carries everything Commerce needs — under a command that cannot use it.

**Classification: A — CONTRACT GAP** (compose command vs. composition roots vs. runtime policy), with **B — DEPLOYMENT DRIFT** as its live consequence (§D).

---

## F. IMAGE STALENESS AND CODE/SCHEMA DRIFT IN THE RUNNING ARTIFACT

The running API image was built `2026-09-30T13:42Z`. Three later C-phase surfaces are demonstrably absent from it (`docker exec`, read-only):

```
/app/apps/api/dist/modules/commerce/  → commercial database dto payment purchase receiving returns workflow …
                                        NO completion/       NO search/
/app/apps/api/dist/platform/          → NO search-source/
```

| Observation | Consequence |
|---|---|
| `dist/modules/commerce/completion` absent | C4R purchase-completion policy has no route in the deployed API → live `/api/v1/commerce/completion-policies` = **404** |
| `dist/modules/commerce/search` and `dist/platform/search-source` absent | C8/C9 search and search-source surfaces absent from the running artifact |
| `prisma/commerce/migrations/20261001000000_purchase_completion_policy` exists on disk and is **applied** (§H) | **the database is ahead of the deployed code** — the image was never rebuilt after the schema advanced |
| `dist/modules/commerce/{commercial,purchase,workflow,…}` present | C1/P-era code is deployed; the gap begins at C4R and runs through C9 |

**The observability artifact is a sharper, separately-classified drift** (quantified in §O):

- `docker exec aria-erp-api ls /app/apps/api/dist/generated/` → `cms-client commerce-client core-client correspondence-client hr-client` — **`observability-client` is absent**, which is *by design* (`runtime-policy.json` → `runtimes.combined.image.prunedArtifacts` prunes `observability-client`; `Dockerfile.backend` runs `node apps/api/scripts/runtime-policy.mjs prune-clients-for combined`).
- `docker exec aria-erp-api ls /app/apps/api/prisma/` → `cms commerce core correspondence hr migrations` — **`prisma/observability` is not in the image at all**. `Dockerfile.backend:54-66` copies core, cms, correspondence, hr, commerce and the legacy `migrations` directory, but never `prisma/observability`. (`Dockerfile.core:48-49` copies core + legacy migrations only, consistent with its own policy.)
- Yet `docker-compose.yml:192-195` sets `OBSERVABILITY_DATABASE_URL` **and** `OBSERVABILITY_ENABLED: "true"` for that same service.
- `docker logs aria-erp-api` then shows, on a loop:

```
{"level":40,"context":"ObservabilityRetentionService","err":"this.prisma.retentionRun.create is not a function","msg":"Failed to record RetentionRun row"}
{"level":40,"context":"ObservabilityWriter","failedBatches":5,"droppedRows":3,"err":"this.prisma.applicationLog.createMany is not a function","msg":"Observability batch write failed; rows discarded"}
```

`model RetentionRun` does exist in the tree (`apps/api/prisma/observability/schema.prisma:535`), so the call matches the schema — but the deployed artifact has no observability client, and the "degrade to a no-op" the policy reasons about is **not** what happens: the process keeps attempting the write, logs level-40 errors on every flush, discards the batches, and can never provision `observability_db`, because the schema directory is not shipped either. Readiness nonetheless stays correct and non-blocking (`optionalDegraded:["observabilityDatabase"]`, `blocking:[]`) — which is exactly why this persists unnoticed.

**Classification:** the three image-lag rows are **B — DEPLOYMENT DRIFT** (artifact older than the tree); the observability degradation path and the "enabled but unshippable" compose configuration are **A — CONTRACT GAP** (declared "optional and degrades" vs. implemented "attempts and errors"; a service told to use a database whose schema and client the image does not carry).

---

## G. DATASOURCE AND DATABASE CONTRACT (six schemas, six URLs, one cluster)

The platform declares **six independent Prisma projects**, all on one PostgreSQL server, each with its own URL variable and its own migration history:

| Owner | Schema | URL variable | Scripts (generate / migrate) | Combined requirement |
|---|---|---|---|---|
| core | `prisma/core/schema.prisma` | `CORE_DATABASE_URL` | `prisma:generate:core` / `prisma:migrate:core` | required |
| cms | `prisma/cms/schema.prisma` | `CMS_DATABASE_URL` | `prisma:generate:cms` / `prisma:migrate:cms` | required |
| observability | `prisma/observability/schema.prisma` | `OBSERVABILITY_DATABASE_URL` | `prisma:generate:observability` / `prisma:migrate:observability` | optional |
| correspondence | `prisma/correspondence/schema.prisma` | `CORRESPONDENCE_DATABASE_URL` | `prisma:generate:correspondence` / `prisma:migrate:correspondence` | required |
| hr | `prisma/hr/schema.prisma` | `HR_DATABASE_URL` | `prisma:generate:hr` / `prisma:migrate:hr` | required |
| commerce | `prisma/commerce/schema.prisma` | `COMMERCE_DATABASE_URL` | `prisma:generate:commerce` / `prisma:migrate:commerce` | required |

Sources: `apps/api/package.json` (the twelve scripts above plus the `prisma:generate` and `db:migrate` orchestrators); `apps/api/runtime-policy.json`; `apps/api/src/config/env.validation.ts`; `docker-compose.yml:129,130,144,161,178,192`; `Dockerfile.backend:54-66`.

Two contract facts on which the rest of GAP-ENV depends:

1. **Five of the six databases are unprovisioned by the repository.** The compose `postgres` service sets `POSTGRES_DB: aria_erp` only (`docker-compose.yml:31`); `core_db`, `cms_db`, `correspondence_db`, `hr_db`, `commerce_db` and `observability_db` must already exist. The compose file admits this for exactly one of them, in a comment (`:135-136` — "The container is created once by the operator against this cluster (`CREATE DATABASE correspondence_db OWNER aria_user`)"), and nothing in the repository creates any of them: no initdb script (`infrastructure/` contains only `docker/` and `nginx/`), no root `scripts/` directory, and no `CREATE DATABASE` statement anywhere in the tree. `aria-erp-postgres2` (a dead `postgres:16.3-alpine`, exited five weeks ago) is the leftover of that manual phase.
2. **The multi-database design is real, not cosmetic.** `env.validation.ts:77-86` warns that `COMMERCE_DATABASE_URL MUST NOT POINT AT core_db or hr_db` (Commerce owns records whose deletion semantics must not cascade from Core's `User`), and `runtime-policy.json` encodes the per-runtime `not-used` sets. The `combined` runtime is the only one that instantiates all six (`runtimes.combined.prismaProjects = core, cms, observability, correspondence, hr, commerce`).

**Classification: C — OPERATIONAL PREREQUISITE** (six databases must exist before any documented command can succeed; one of them is mentioned, and only in a compose comment) + **D — DOCUMENTATION GAP** (README's "Database Operations" section lists migration commands but never states that the databases must be created first). The per-runtime requirement matrix itself is **E — verified correct and self-consistent** (policy, validator and live `/ready` agree).

---

## H. MIGRATION CONTRACT, PER-SCHEMA STATUS AND DEPLOY ORDER

**Contract:** migrations are a *deployment step*, never startup — `Dockerfile.backend` ("Schema migrations are a dedicated deployment step (`npm run db:migrate`), never container startup"), `docker-compose.yml:127-128`, `apps/api/entrypoint.sh` (which performs none), and ADR-0005:62 ("must not add a second implicit migration path"). Verified: `docker-compose.yml` has no migrate command for any service; the API container starts straight into `node dist/<entrypoint>.js`.

**Deploy order** is fixed in `apps/api/package.json`:
`db:migrate` → `prisma:migrate:core` → `:cms` → `:observability` → `:correspondence` → `:hr` → `:commerce`, each a `prisma migrate deploy --schema=prisma/<owner>/schema.prisma`. Per-owner `prisma:migrate:*` commands exist for a targeted deployment. Because each owner is a separate physical database, cross-owner ordering is not load-bearing — but the *orchestration is all-or-nothing*, which matters below.

**Observed status** (`node node_modules/prisma/build/index.js migrate status --schema=…`, cwd `apps/api`, read-only):

| Owner | CLI result | Target reached |
|---|---|---|
| core | `47 migrations found in prisma/migrations` · `Database schema is up to date!` | `core_db @ localhost:5544` |
| commerce | `12 migrations found in prisma/migrations` · `Database schema is up to date!` | `commerce_db @ localhost:5544` |
| hr | `11 migrations found in prisma/migrations` · `Database schema is up to date!` | `hr_db @ localhost:5544` |
| cms | `1 migration found in prisma/migrations` · `Database schema is up to date!` | `cms_db @ localhost:5544` |
| correspondence | `1 migration found in prisma/migrations` · `Database schema is up to date!` | `correspondence_db @ localhost:5544` |
| observability | **`Error code: P1012 — Environment variable not found: OBSERVABILITY_DATABASE_URL`** | *(not reached)* |

Two independent problems are visible here.

**H.1 — The CLI reaches the e2e cluster, not the compose cluster.** Every successful command above printed `localhost:5544`, because that is what the developer `.env` files contain (§K): `apps/api/.env:24-28,45` and `apps/api/.env.local:4-9` point *every* `*_DATABASE_URL` at `localhost:5544`, the hand-started `aria-erp-e2e-dbproxy` socat proxy, while the compose stack publishes PostgreSQL at **5433** and the API itself uses host `postgres`. So the statuses above prove the *e2e* databases are current — not the containers' databases. A `npm run db:migrate` from this tree therefore migrates the e2e cluster, and says nothing about the deployed one. **A.**

**H.2 — The documented all-owner orchestration cannot complete on this machine.** `db:migrate` runs `prisma:migrate:observability` in the middle of the chain, and `apps/api/.env` (the file the CLI reads) contains no `OBSERVABILITY_DATABASE_URL` (the key exists only in `apps/api/.env.e2e:64` and `apps/api/.env.example:67`). The command therefore fails with `P1012` and, because it is a `&&` chain, **halts before `correspondence`, `hr` and `commerce`** — the three newest owners, including the one the current phase set targets. **A.**

**H.3 — Three migration directories are applied to a database but are not in git.** The working tree adds, untracked:

```
apps/api/prisma/commerce/migrations/20260930000000_commercial_approval_inbox_index/
apps/api/prisma/commerce/migrations/20261001000000_purchase_completion_policy/
apps/api/prisma/core/migrations/20261001120000_add_external_search_source/
```

Tracked-vs-on-disk counts (each owner directory also holds a tracked `migration_lock.toml`, hence the path counts): core **46 tracked dirs / 47 on disk**, commerce **10 / 12**, hr **11 / 11**, cms **1 / 1**, correspondence **1 / 1**, observability **1 / 1**. Because `migrate status` reports commerce as *up to date* with `12 migrations found`, the live database has the untracked migrations applied. **A clean checkout cannot reproduce the deployed schema** — the C4R/C8/C9 schema exists simultaneously in the database and in the developer's working tree, and in *neither* of the two artifacts a deployment would use (HEAD or the image). `prisma/seed.js` is likewise deleted in the working tree (`git status`), and `prisma/seed.ts` is modified.

**Classification: A — CONTRACT GAP** (H.1, H.2, H.3: the migration contract is executable, but not against the deployed environment, not as a complete orchestration, and not from the committed tree) + **E — verified** for the "no implicit migration at startup" rule, which holds in compose, in `entrypoint.sh` and in the image CMD.

---

## I. THE SEVENTH PRISMA PROJECT — THE DEPRECATED ROOT SCHEMA IS THE CLI'S DEFAULT

`apps/api/prisma/` contains **seven** projects, not six: the six owners plus a deprecated root project.

| Fact | Evidence |
|---|---|
| The root project exists | `apps/api/prisma/schema.prisma` — `datasource db { provider = "postgresql"; url = env("DATABASE_URL") }`, with a generator that has **no `output`** (so it targets the default client location, unlike the six owners) |
| It is deprecated **on purpose** | ADR-0005:43 — "`prisma/schema.prisma`, `prisma/migrations`, and `DATABASE_URL` are deprecated compatibility history. They are retained to avoid rewriting or deleting…" |
| Its history is still in the tree | `apps/api/prisma/migrations/{20260728_initial_schema, 20260729_add_fine_grained_admin_permissions, 20260822_drop_cms_core_user_fk}` + `migration_lock.toml` |
| It is shipped into both images | `Dockerfile.backend:66` and `Dockerfile.core:49` copy `apps/api/prisma/migrations` (the legacy history) — while every npm script names one of the six owners and **no script names the root project** |
| `DATABASE_URL` has no application reader | no source file reads `env.DATABASE_URL` (the only hits are the `*_DATABASE_URL` names); `apps/api/.env.e2e:8` records it as "legacy (pre-split, unused by application code)" |
| **The CLI defaults to it** | Observed: `node …/prisma/build/index.js validate prisma/observability/schema.prisma` (positional path) printed `Prisma schema loaded from prisma\schema.prisma` and validated **the legacy project**, not observability. `migrate status --schema=…` honours the flag; the positional form does not |

**Consequence:** an operator running a generic `prisma migrate deploy` / `prisma migrate dev` / `prisma db push` from `apps/api` without `--schema=` operates on the **deprecated** project, against whatever `DATABASE_URL` resolves to — and in this tree that is the **e2e** cluster (`localhost:5544/aria_erp`, `apps/api/.env:28`). The migration contract has a default target that no npm script, ADR step or README instruction ever mentions.

**Classification: E — verified** for retaining the legacy history (documented in ADR-0005:43, inert where it is not used) + **A — CONTRACT GAP** for the unguarded default: the CLI's implicit target is a deprecated project, which is exactly the kind of ambiguity GAP-ENV exists to surface.

---

## J. PRISMA CLI AND CLIENT ENV-LOADING CONTRACT (cwd, `.env` vs `.env.local`)

Four different consumers read environment configuration, and **they do not read the same file**. This was measured, not assumed:

| Consumer | Reads | Evidence |
|---|---|---|
| NestJS application (`AppModule`, `CoreAppModule`) | `apps/api/.env.local`, plus the real process environment | `apps/api/src/app.module.ts:60-62` — `ConfigModule.forRoot({ …, envFilePath: '.env.local' })`; `apps/api/src/core-app.module.ts:55-57` — identical. `@nestjs/config` then copies what it loaded into `process.env` (`node_modules/@nestjs/config/dist/config.module.js:206` — `process.env[key] = value`) |
| Prisma **CLI** (`migrate`, `validate`, `generate`) | `.env` resolved from **`process.cwd()`** | Observed: run from `apps/api` it prints `Environment variables loaded from .env` and reaches `localhost:5544`; the *identically-phrased* command run from the repository root prints the same line and then fails `P1012` for `CORE_DATABASE_URL`, because only the root `.env` is in scope — and that file contains comments only (it documents the JWT key-rotation staging; `git check-ignore` confirms it is gitignored) |
| Generated **Prisma Client**, at import time | `.env` relative to the generated client directory | `apps/api/src/generated/core-client/index.js:1206-1210` — `"relativeEnvPaths": { "rootEnvPath": null, "schemaEnvPath": "../../../.env" }`, `"relativePath": "../../../prisma/core"`. Observed probe: `delete process.env.CORE_DATABASE_URL; delete process.env.RABBITMQ_URL;` then `require('./src/generated/core-client')` → `after client import: RABBITMQ_URL set = true ; CORE set = true` |
| Jest e2e harness | `.env.e2e` (tracked) | `apps/api/test/jest-setup.ts:6-25` — `dotenv.config({ path: found })` over `test/.env.e2e`, `../.env.e2e`, `.env.e2e`, then forces `NODE_ENV=test` |

Three of those behaviours are contract-relevant:

**J.1 — The application and the database tools read different files.** A developer who follows README (`cp apps/api/.env.example apps/api/.env.local`, `README.md:60-61`) configures *Nest*; the Prisma CLI, the seed and the generated clients look for `apps/api/.env`, which README never mentions. Both files must exist **and agree** — and today they do not agree (§K). **A.**

**J.2 — Importing a generated client silently populates `process.env`.** The probe above shows a side effect on the hosting process: merely importing `core-client` set `CORE_DATABASE_URL` **and** `RABBITMQ_URL` (a variable that is not even a Prisma datasource) from `apps/api/.env`. In host tooling, unit tests and scripts, the effective environment therefore depends on which modules happen to be imported and on which `.env` sits next to `apps/api`. In the container the behaviour is inert because **no env file is shipped** — `Dockerfile.backend` states it explicitly ("NO env file is baked into this image … all runtime configuration now arrives as environment variables from the orchestrator"), and `docker exec` confirms `/app/apps/api/.env*` does not exist. **A** (host-side contract) + **E** (container side, verified).

**J.3 — The validator covers only the boot-critical minimum, deliberately.** `env.validation.ts` requires `CORE_DATABASE_URL` (`:40`) and the JWT secrets (`:93`), treats the other five database URLs as `z.string().optional()` (`:41,54,70,86`), and adds production-only rules for CORS (`:261`), the AI configuration key (`:272`) and secret placeholders (`noPlaceholder`, `:17-23`). ADR-0005:182 documents why: "`config/env.validation.ts` answers 'is this value a valid URL?', and says nothing about which runtime needs it." The practical consequence is that a **combined** runtime started without `COMMERCE_DATABASE_URL` passes validation and then fails inside Prisma at client construction/connect time — a runtime error rather than a configuration error. Recorded as **E** (documented decision), with the failure mode noted for the implementation phase.

**Classification: A — CONTRACT GAP** (J.1, J.2: two env files, only one documented, with an import-time side effect that mutates the host environment) + **E — verified** (J.3 documented separation; the container ships no env file).

---

## K. ENV-VAR CONTRACT: EXAMPLE vs COMPOSE vs CODE

Three artifacts describe the same variables, and they disagree. Key counts measured directly (names only):

| File | Keys | Notable |
|---|---|---|
| `apps/api/.env.example` (tracked) | 65 | complete template: six DB URLs on `localhost:5433`, `REDIS_URL`, `RABBITMQ_URL`, `MINIO_*`, `MAIL_*` **and** `SMTP_*`, `JWT_*`, `CORS_ORIGINS`/`CORS_ORIGIN`, `OPENAI_*`, `AI_CONFIG_ENCRYPTION_KEY`, retention windows, rate limits |
| `docker-compose.yml` `api.environment` (tracked) | 32 names | six DB URLs on host `postgres:5432`, `REDIS_URL=redis://redis:6379`, `RABBITMQ_URL=…@rabbitmq:5672`, `MINIO_*`, **`MAIL_HOST`/`MAIL_PORT` only**, `JWT_SECRET`/`JWT_REFRESH_SECRET` **placeholders**, `OPENAI_API_KEY: ${OPENAI_API_KEY:-}` |
| `apps/api/.env` (untracked, machine-local) | 22 | six DB URLs on **`localhost:5544`**, `RABBITMQ_URL=…@rabbitmq:5672`, `MAIL_*`+`EMAIL_FROM`, `APP_URL`, `CORS_ORIGIN`, `PORT`, `JWT_*`, `OTEL_EXPORTER_OTLP_ENDPOINT`, **no `OBSERVABILITY_DATABASE_URL`**, no `MINIO_HOST/BUCKET/…` |
| `apps/api/.env.local` (untracked, machine-local, the file Nest reads) | 12 | `PORT=4000`, five DB URLs on **`localhost:5544`**, `REDIS_URL=localhost:6379`, `JWT_*`, `CORS_ORIGINS=http://localhost:3003,http://localhost:8080`, **no `COMMERCE_DATABASE_URL`**, no `OBSERVABILITY_DATABASE_URL` |
| `apps/api/.env.e2e` (tracked) | 33 | six DB URLs on `localhost:5544`, `API_BASE_URL=http://localhost:3001`, `API_PORT=3001`, `DATABASE_URL` marked legacy at `:8` |

Findings, in order of consequence:

**K.1 — The API port contract has three values.** `.env.local:2` says `PORT=4000`; `.env.example`, README, compose and `.env.e2e:53` all say `3001`; the running container listens on `3001` (`docker-compose.yml:126,266`). A host `npm run start:dev` therefore comes up on a port no other artifact describes, while the *frontend* developer file `apps/web/.env.local` points at `http://localhost:4000/api` — a port that is **closed** on this machine (TCP probe: connection refused; nothing in the stack listens there). **A.**

**K.2 — The mail contract does not match the code.** `.env.example:195-201` and `docker-compose.yml:224-225` describe `MAIL_HOST`, `MAIL_PORT`, `MAIL_FROM`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`; the only reader is `apps/api/src/notifications/email/email.service.ts:10-13` — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, **`SMTP_PASS`** (not `SMTP_PASSWORD`) — with the sender at `:30` from **`EMAIL_FROM`**. A container-environment probe shows the API carries `MAIL_HOST=mailpit`, `MAIL_PORT=1025` and **no `SMTP_HOST`/`SMTP_PASS`**, so `email.service.ts:15-24` takes the `else` branch and logs *"SMTP not configured — emails will be logged to console"*. Mailpit therefore never receives application mail from the deployed stack, and the documented variable that would enable it (`SMTP_PASSWORD`) is not the name the code reads. **A.**

**K.3 — The example declares the same key twice.** `apps/api/.env.example:186` sets `CORS_ORIGINS=http://localhost:3000`; `:299` sets `CORS_ORIGINS=` **empty**. The later line wins in every dotenv implementation, so copying the template yields an empty allow-list. The live API accepts `http://localhost:3000` only because compose sets `CORS_ORIGIN` (`docker-compose.yml:226`), not because of the template. **A/D.**

**K.4 — The template's host is the compose host; the machine's files use a third host.** `.env.example` correctly uses `localhost:5433` (the published compose port) — that is what a fresh developer gets. The two *actual* files a developer is told to create replace it with `localhost:5544`, served by a container that is not in compose (`aria-erp-e2e-dbproxy`, labels `{}`, `docker ps`). See §R.4. **A.**

**Classification: A — CONTRACT GAP** (K.1–K.3, each independently reproducible) + **D** for the duplicated `CORS_ORIGINS` documentation defect. The `.env.example` content, apart from that duplicate, is **E — complete and consistent with the six-owner design**.

---

## L. SECRETS AND KEY MATERIAL

| Fact | Evidence |
|---|---|
| Key material exists on disk, outside git | `secrets/JWT_SIGNING_KEYS` and `secrets/JWT_ACTIVE_KEY_ID`; `git status --porcelain` shows `?? secrets/` |
| **It is not gitignored** | `.gitignore:12,18-20,53-59` covers `dist/`, `.env`, `.env.local`, `.env.*.local` and the generated clients — there is **no** `secrets/` rule, and `git check-ignore` matches nothing for `secrets/`. The "never commit" is asserted in a compose comment (`docker-compose.yml:334-335` — "These files are generated outside git and must never be committed") but **not enforced by git** |
| Compose injects them as secrets, never as env values | `docker-compose.yml:333-339` (top-level `secrets:` with `file:`), `:262-264` (`api.secrets`), `:292-299` (shell reads `/run/secrets/*` into env, then `exec`) |
| The running container confirms the mechanism | `docker exec`: `/run/secrets/JWT_ACTIVE_KEY_ID` (13 B), `/run/secrets/JWT_SIGNING_KEYS` (1825 B, dated 2026-09-20 i.e. Phase 52-ARCH-3C-R1); `/proc/1/environ` contains both variable names exactly once each |
| The keys are actually serving | `GET /.well-known/jwks.json` → 200, `{"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"gate-a-rsa-1",…}]}` (431 B, with `cache-control: public, max-age=300`). `gate-a-rsa-1` matches the Phase Gate A provisioning commit `c91485e` |
| The documented variable is honoured exactly | `TOKEN_JWKS_PATH = '/.well-known/jwks.json'` (`apps/api/src/platform/auth/token-contract.ts:133`), excluded from the `api/v1` prefix in both bootstraps (`main.ts:69-74`, `core-main.ts:65-73`) — Core is the issuer, and the exclusion is deliberate and documented |
| Production would refuse the compose placeholders | `docker-compose.yml:227-228` sets `JWT_SECRET`/`JWT_REFRESH_SECRET` to `your_super_secret_jwt_key_change_in_production`, and `env.validation.ts:17-23` (`noPlaceholder`, rejecting `change`/`default`/`dev-secret`) exists precisely to make that a boot failure. Composed with `NODE_ENV: development` (`:125`) it does not fire |

**Why this matters for GAP-ENV:** the JWT path is the one part of the environment contract that is *complete and provable* — generation, mount, load, publish, verify are all reachable and all observed working. Its one weakness is enforcement rather than behaviour: the single sentence promising the keys never enter git is a comment, and the directory that holds them is not ignored.

**Classification: E — verified** (provisioning, mount, load, JWKS publication all correct and observable) + **A — CONTRACT GAP** (`secrets/` untracked but not ignored; the promise "must never be committed" is documentary only) + **C — OPERATIONAL PREREQUISITE** (the key files must be generated outside the repository; the only procedure is `docs/reports/PHASE_52-ARCH-3C-R1_ACTIVATION.md`, not a deployment guide).

---

## M. HEALTH, READINESS AND LIVENESS CONTRACT

**What the API implements** (`apps/api/src/health/health.controller.ts`): `@Controller()` with three `@Public()` routes — `GET health` (`:24-26`), `GET live` (`:32-37`), `GET ready` (`:58-60`). With the global prefix, the served paths are `/api/v1/health`, `/api/v1/live`, `/api/v1/ready`. ADR-0005:81-92 explains the design: readiness is the *status code*, computed from `runtimePolicy(runtimeId)` through `DatasourceHealthProbe` + `InfrastructureHealthProbe`; a probe fault is caught so a wiring error answers 503 rather than 500.

**What was observed** (live probes, §D): `/api/v1/health` 200; `/api/v1/live` 200; `/api/v1/ready` 200 with the full per-datasource report including `requirements` and `optionalDegraded`. The `runtime` field in both `live` and `ready` is the deployment's own self-identification — the strongest single probe available to an operator, and it reports `"combined"`.

**Three contract problems:**

**M.1 — The repository documents a health path that does not exist.** `COMPREHENSIVE_PHASE_A_REPORT.md:304-311,670` instructs `curl …/api/v1/health/live` and `…/api/v1/health/ready`; `CRITICAL_ISSUES_AND_FIXES.md:269-270` describes `/api/v1/live` and `/api/v1/ready` correctly. Live probe: `/api/v1/health/live` → **404**, `/api/v1/health/ready` → 404 (the controller has no such routes), while `/api/v1/live` and `/api/v1/ready` → 200. Two root-level reports contradict each other about the probe contract. **D.**

**M.2 — Compose never asks the API or the web container whether they are alive.** `docker-compose.yml` defines `healthcheck` for `postgres` (`:36-41`), `redis` (`:52-57`), `rabbitmq` (`:72-77`), `minio` (`:93-98`) and `mailpit` (`:110-114`) — but **not** for `api` (`:119-299`) and **not** for `web` (`:302-315`), and `nginx` declares none either (`:317-331`). The `api` service's `depends_on` uses `condition: service_healthy` for the five infrastructure services (`:267-277`), so the API waits for *them*; nothing in the stack waits for, or ever re-checks, the API. The API's own readiness system — the thing ADR-0005 spent three sub-phases building — is therefore **unused by the deployment that ships it**. **A.**

**M.3 — `nginx` is declared to depend on `api` and `web` by start order only** (`:326-328`), with no health gate, and (see §Q) no proxy configuration to route to either.
**A** (consequence of M.2), documented in §Q.

Also recorded, and **not** a defect: the API container's own health picture is fully trustworthy even while observability is broken, because `optionalDegraded`/`blocking` are reported separately (§F). That is the policy working as designed — **E**.

**Classification: A — CONTRACT GAP** (M.2/M.3: no healthcheck for the two application containers, and the readiness subsystem is not wired into the orchestrator that is supposed to consume it) + **D — DOCUMENTATION GAP** (M.1).

---

## N. CORS AND ERROR SEMANTICS AT THE EDGE

**The configured contract** is explicit and strict: `buildCorsOrigin` (`apps/api/src/config/env.validation.ts:288-303`) resolves `CORS_ORIGINS ?? CORS_ORIGIN` into a `Set` allow-list, allows requests with **no** `Origin` (server-to-server), allows a listed origin, and answers **`callback(new Error("CORS origin <o> is not allowed"), false)`** for anything else. Both bootstraps install it with `credentials: true` (`main.ts:58-65`, `core-main.ts:54-61`), and `env.validation.ts:261` refuses to boot in production with an empty allow-list.

**Observed behaviour** (`curl --noproxy '*'`, because a host proxy otherwise intercepts `localhost`):

| Request | Result |
|---|---|
| `OPTIONS /api/v1/auth/login`, `Origin: http://localhost:3000` | **204** with `Access-Control-Allow-Origin: http://localhost:3000`, `Access-Control-Allow-Credentials: true`, `Access-Control-Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE`, `Vary: Origin, Access-Control-Request-Headers` |
| `OPTIONS /api/v1/auth/login`, `Origin: http://evil.example` | **500** `{"statusCode":500,"message":"Internal server error"}`, **no** `Access-Control-Allow-Origin` |

The allow-list works — the disallowed origin is refused. **But the refusal is an unhandled 500**, not a 403: the callback passes an `Error` to Nest's CORS layer with no exception filter to translate it, so a legitimate security decision is reported as a server fault. It inflates error rates and misleads any monitoring that counts 5xx as "the service is broken". Note also `vary: Origin` *without* `Access-Control-Request-Headers` on the normal API responses versus the explicit `Vary` header on the preflight — a cache-correctness wrinkle worth naming but not worth inflating.

**Classification: A — CONTRACT GAP** (refusal semantics: a denied origin is a 4xx-class decision, and it is emitted as 500) + **E** (allow-list resolution, credentials flag, production non-empty rule, and the no-Origin pass-through are all correct and were observed working).

---

## O. DEPENDENCY CLASSIFICATION — required / optional / silently degraded

The platform classifies nine dependencies in `runtime-policy.json` and mirrors the classification in `/ready`'s `requirements`. Measured against the **combined** runtime (the one actually serving, §D):

| Dependency | Declared | Live status | Verified behaviour |
|---|---|---|---|
| `coreDatabase` | required | ok | Used by auth/RBAC/tenant/notifications; CMS/HR/Correspondence/Commerce each hold their own |
| `cmsDatabase` | required | ok | Required by combined policy; the running container answers for it |
| `correspondenceDatabase` | required | ok | Same |
| `hrDatabase` | required | ok | Same (`ADR-0005:40` keeps the Core-side HR classification, the module requirement is separate) |
| `commerceDatabase` | **required** (since `824e074`) | ok | The newest requirement — and the one the pinned compose command cannot satisfy (§E) |
| `observabilityDatabase` | optional | **failed / degraded** | `optionalDegraded:["observabilityDatabase"]`, `blocking:[]`; but the degradation is **noisy, not silent** (§F: level-40 errors per flush, batches discarded). Also: no compose healthcheck can ever see this, and the shipped image carries no observability schema or client |
| `redis` | optional | ok | `REDIS_URL=redis://redis:6379`; used by sessions/rate-limit via `REDIS_CLIENT` |
| `rabbitmq` | optional | ok | Health uses a bare TCP probe by design (`ADR-0005:105`); the audit ingest consumer and the notification publisher are the real users |
| `storage` (MinIO) | optional | ok | `MINIO_ENDPOINT=minio:9000`, `MINIO_BUCKET=aria-erp`, credentials `minioadmin/minioadmin` from compose (`:202-204`) |

**Dependencies that are *not* in the policy at all but are real**, and therefore classified here rather than by the platform:

| Dependency | Where it bites | Classification |
|---|---|---|
| **Mail (SMTP)** | `email.service.ts` reads `SMTP_HOST/PORT/USER/PASS` + `EMAIL_FROM`; compose supplies `MAIL_HOST/MAIL_PORT` only → the else-branch warns and logs (§K.2). Not in `runtime-policy.json`, not in `/ready`'s requirements | **A** — an unmonitored dependency with a mismatched variable contract |
| **AI configuration key** | `AI_CONFIG_ENCRYPTION_KEY` is required in production by the validator (`:272`) and passed by compose **only if the host env supplies it** — compose does not set it, so the value is empty in the deployed container | **C** — a production prerequisite that the compose file neither sets nor documents |
| **External search / pgvector** | Two migrations add a global-search projection and an external search source (`core/migrations/20261001120000_add_external_search_source`, plus the `add_global_search_projection` history); the postgres image is `pgvector/pgvector:pg16` so the extension is available, but no artifact checks it | **C/E** — available in the image, unverified at runtime |
| **Identity gateway (Commerce)** | `src/modules/commerce/commerce-identity.gateway.ts` resolves actors through Core RBAC rather than a shared table | **E** — boundary-legal and documented |

**The classification verdict:** the policy's required/optional split is **correct and self-consistent** (E), but the *deployment* exercises none of it — compose has no healthcheck on the API (M.2), so "optional and degraded" and "required and missing" look identical to every orchestrator. The one dependency that is genuinely broken right now (observability) is the one the policy calls optional, which is why the stack reports `ready`.

**Classification: A — CONTRACT GAP** (mail variable contract; observability degradation is error-loud rather than silent) + **C — OPERATIONAL PREREQUISITE** (`AI_CONFIG_ENCRYPTION_KEY`, pgvector verification) + **E** (the policy's own classification, and the live statuses, agree with each other).

---

## P. FRONTEND CONFIGURATION — `NEXT_PUBLIC_*` IS A BUILD INPUT, NOT A RUNTIME ONE

The web app resolves its API base once, at build time:

```
apps/web/src/lib/constants.ts:1-4
  export const API_BASE_URL  = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';
  export const API_VERSION    = 'v1';
  export const API_ENDPOINT   = `${API_BASE_URL}/${API_VERSION}`;   // → http://localhost:3001/api/v1
```

**P.1 — The value is inlined into the bundle, and the container's env var cannot change it.** `Dockerfile.frontend`'s builder stage runs `npm run build --workspace=apps/web` with no `ARG`/`ENV NEXT_PUBLIC_API_URL`; the runner stage sets only `NODE_ENV` and `NEXT_TELEMETRY_DISABLED`. Compose sets `NEXT_PUBLIC_API_URL: http://localhost:3001` as a **container** variable (`docker-compose.yml:307`). Probe of the deployed image shows what the browser actually receives:

```
docker exec aria-erp-web grep -o 'http://localhost:3001/api' .next/static/chunks/2kpz0twsnpox9.js
→ http://localhost:3001/api
```

i.e. the **code default**, inlined at build. The compose variable is inert for client code; only a rebuild changes it. **A.**

**P.2 — The value's *format* is undefined, and the three definitions disagree.**

| Source | Value | With `API_ENDPOINT` becomes |
|---|---|---|
| code default (`constants.ts:2`) | `http://localhost:3001/api` | `http://localhost:3001/api/v1` ✅ matches the served routes |
| root `.env.example:7`, `FOLDER_STRUCTURE.md:563`, compose (`:307`) | `http://localhost:3001` | `http://localhost:3001/v1` ❌ no such route |
| `apps/web/.env.local:1` (the file a developer is told to create) | `http://localhost:4000/api` | port **4000** — refused by every probe |

Two of the three documented sources specify a value that, if used as the build input, breaks every API call; the third points at a dead port (§K.1). Nothing states that `NEXT_PUBLIC_API_URL` must *end with* `/api`. **A.**

**P.3 — `NEXT_PUBLIC_APP_URL` is never set anywhere**, so the deployed app falls back to `https://aria-platform.com` (`constants.ts:8`), observed in the running image's server chunks (`https://aria-platform.com`, two hits in `.next/server/chunks`). Any absolute URL the app renders — sitemap, canonical, share links — points at a domain this repository does not own. **A/C.**

**P.4 — Build-context hygiene is adequate, deliberately.** `.dockerignore` excludes `node_modules`, `dist`, `.next`, `.env`, `.env.*` (keeping `!.env.example`), logs, backups and QA artifacts, so a fresh image build does not inherit local secrets or stale `.next` output — **E**, verified by reading the file. The one consequence: in a clean build `NEXT_PUBLIC_*` comes from *code defaults* (P.1), not from any committed value.

**Classification: A — CONTRACT GAP** (P.1–P.3: a build-time input with no build argument, no defined format, and two contradictory published values) + **E** (build-context exclusions).

---

## Q. INGRESS / EDGE CONTRACT — THE DEPLOYED NGINX IS NOT A PROXY

Two nginx trees exist, and **compose mounts the wrong one**:

| Tree | Contents | Mounted? |
|---|---|---|
| `./nginx/**` (repo root) | `nginx.conf` (325 B, minimal), `conf.d/default.conf` (154 B: `listen 80; server_name _; root /usr/share/nginx/html; location / { try_files … =404; }`), `html/index.html` (366 B) | **Yes** — `docker-compose.yml:324-325` mounts `./nginx/nginx.conf` and `./nginx/conf.d` |
| `./infrastructure/nginx/**` | `nginx.conf` (1398 B: gzip, log format, **security headers** `:35-39`), `conf.d/api.conf` (2736 B: `upstream api{server api:3001}`, `/api/`, `/health`, exact-match JWKS proxy, Swagger block), `conf.d/frontend.conf` (1370 B: `upstream web{server web:3000}`, asset caching) | **No** — nothing references it |

**Q.1 — The published edge serves the stock welcome page and routes nothing.** `docker exec aria-erp-nginx nginx -T` yields exactly one server: `listen 80; server_name _; root /usr/share/nginx/html; location /`. Live probes: `http://localhost:80/` → 200 **"Welcome to nginx!"** (896 B — the *image's* stock page, not the repo's 366 B file, which is not mounted either); `http://localhost:80/health` → 404; `http://localhost:80/api/v1/health` → 404; `http://localhost:80/admin/commerce` → 404. Port `443:443` is published while the config has **no TLS server**, so the HTTPS port terminates nowhere. The application is reachable only by raw container port (`:3000`, `:3001`) — which is also the only way CORS permits (allow-list `http://localhost:3000,http://localhost:3003`, `docker-compose.yml:226`). **B — the declared edge lives in `infrastructure/nginx`; the deployed edge is a placeholder.**

**Q.2 — The "real" tree, if mounted, still contradicts the API it fronts.** Three defects are visible in `api.conf` alone:

- `:35-38` — `location /health { proxy_pass http://api/health; }`, but the API serves **`/api/v1/health`** (global prefix `api/v1`; only `/.well-known/jwks.json` is excluded — `main.ts:74`). Probe: `http://localhost:3001/health` → **404**. The ingress health probe would always fail.
- `:64-68` — proxies `/api/docs` → `http://api/api/docs`, while Swagger mounts at `api/v1/docs` **and** is disabled: `ENABLE_SWAGGER` is absent from the container environment (probe), so `setupSwagger` returns early and `/api/v1/docs` → 404 (observed). Two layers of wrongness on one route.
- `:24-31` — adds `Access-Control-Allow-Origin '*'` from nginx and answers `OPTIONS` with 204 at the edge, overriding the API's credential-bearing allow-list (§N). A response carrying both `*` and `credentials: true` is rejected by browsers; the edge would undo the application's CORS contract on every proxied route.

**Classification: B — DEPLOYMENT DRIFT** (Q.1: the proxy configuration that exists is not the one deployed; the deployed one proxies nothing) + **A — CONTRACT GAP** (Q.2: the undeployed proxy's health path, Swagger path and wildcard-CORS assumptions are incompatible with the API contract it would front) + **D** (the repo's own `nginx/html/index.html` is dead — not mounted, not served).

---

## R. TEST AND E2E ENVIRONMENT

**R.1 — The e2e suite is green, and it is the only executable proof of this contract.** Three suites were run read-only in this phase, from `apps/api`, with the repository's own configuration:

| Command | Result |
|---|---|
| `node …/jest.js --runInBand src/config/env.validation.spec.ts` | **PASS — 1 suite, 17 tests, 0 failures** |
| `node …/jest.js --runInBand src/architecture-boundaries.spec.ts` | **PASS — 1 suite, 24 tests, 0 failures** (53.6 s) |
| `node …/jest.js --runInBand src/runtime-policy.spec.ts` | **PASS — 1 suite, 32 tests, 0 failures** (23.0 s) |

Note for the implementation phase: the *observed* invocation form matters. `npm run test:e2e` points jest at `./jest-e2e.json`; passing `--config ./test/jest-e2e.json` instead makes jest resolve `rootDir` to `apps/api/test` and fail validation (`Module <rootDir>/test/jest-setup.ts … was not found`) — a foot-gun the two near-identical config files invite (§R.2). **A/D.**

**R.2 — Two e2e configs, and neither wires the bootstrap that exists.** `apps/api/jest-e2e.json` and `apps/api/test/jest-e2e.json` both declare `testMatch: ["**/test/**/*.e2e-spec.ts"]` and both set `setupFiles`/`setupFilesAfterEnv` — but **neither declares `globalSetup`/`globalTeardown`**, although `apps/api/test/global-setup.ts` and `apps/api/test/global-teardown.ts` exist. A repository-wide search finds **no reference to either file** anywhere. Whatever database preparation they perform therefore never happens when the suite runs, and the 24 e2e spec files that `--listTests` enumerates rely on external state alone. **A.**

**R.3 — The e2e environment is real, tracked and separate.** `.env.e2e` (33 keys, **tracked**) points all six databases at `localhost:5544`, `REDIS_URL=localhost:6379`, `RABBITMQ_URL=…localhost:5672`, `API_BASE_URL=http://localhost:3001`, and marks `DATABASE_URL` legacy at `:8`. `test/jest-setup.ts:11-17` loads it by searching `test/.env.e2e`, then `../.env.e2e`, then `.env.e2e`, and forces `NODE_ENV=test`. A coherent, deliberately separate contract — **E**.

**R.4 — Port 5544 is served by a container no repository file declares.** `apps/api/.env`, `apps/api/.env.local` and `.env.e2e` all use `localhost:5544`; `docker ps` shows `aria-erp-e2e-dbproxy` (`alpine/socat:latest`, `5432/tcp -> 0.0.0.0:5544`, compose labels `{}` — i.e. **not** created by this compose project). The compose stack publishes PostgreSQL on **5433** and the API reaches `postgres:5432` internally. The developer/e2e database path therefore depends entirely on a hand-started proxy that exists only on this machine, and every host-side Prisma command silently targets it (§H.1, §I). The e2e *contract* is documented; the e2e *infrastructure* is not in the repository at all. **C/B.**

**R.5 — `.env.example` has no web counterpart.** README instructs `cp apps/web/.env.example apps/web/.env.local` (`README.md:60`), but `apps/web/.env.example` **does not exist** — only the repository-root `.env.example` (10 `NEXT_PUBLIC_*` keys) does. Following README literally fails. **D.**

**Classification: A — CONTRACT GAP** (R.2 unwired e2e bootstrap; R.1's config-path foot-gun) + **C — OPERATIONAL PREREQUISITE** (R.4) + **D — DOCUMENTATION GAP** (R.5) + **E** (R.1 green results, R.3 tracked e2e environment).

---

## S. CI/CD, SEEDING AND OPERATOR DOCUMENTATION

**S.1 — There is no CI/CD of any kind, while three documents say there is.** Verified absent: `.github/`, `.gitlab-ci.yml`, `azure-pipelines.yml`, `Jenkinsfile`, `.circleci/`. Verified present and claiming otherwise:

| Claim | Location |
|---|---|
| "**CI/CD**: GitHub Actions" | `README.md:92` |
| "**GitHub Actions Workflows**:" (followed by a workflow description) | `ARCHITECTURE.md:503` |
| "├── scripts/" and "k8s/ # Kubernetes manifests" | `ARCHITECTURE.md:105`, `FOLDER_STRUCTURE.md:454,480` |
| "Setup GitHub Actions workflows" (listed as a project step) | `FOLDER_STRUCTURE.md:588` |

Neither `scripts/` (repository root) nor `k8s/` exists, and no workflow file exists anywhere in the tree. (`apps/api/scripts/` **does** exist and is tracked — 12 files including `runtime-policy.mjs`, used by `Dockerfile.backend` — which is a different directory from the root `scripts/` these documents describe.) **D**, plus an **A** consequence: nothing in this repository runs a build, a test, a migration or a `docker build` on a change, so every finding in §C–§R stays invisible until a human runs it. The only documented deployment path is `docker:up = docker-compose up -d` (`package.json`), which neither rebuilds images nor migrates nor seeds — precisely the shape that produced §F's stale image.

**S.2 — The seed is idempotent and unguarded.** `apps/api/prisma/seed.ts` (179 lines) uses `upsert` throughout (`:21,45,64,84,115,131,155`), so re-running is safe and deterministic in *effect*. It creates a super-admin from `process.env.E2E_SUPERADMIN_EMAIL || 'admin@localhost'` and `E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!'` (`:127-128`, bcrypt cost 10 at `:129`), and it has **no `NODE_ENV` guard** and **no dry-run mode** — `main().catch(e => { console.error(e); process.exit(1); })` (`:172-178`) is the whole safety apparatus. Pointed at a production URL it would create or reset a super-admin with a published default password. It also writes **only** the Core database (`:1` — `import { PrismaClient } from '../src/generated/core-client'`), so five of the six databases have no seed path at all. The working tree deletes `prisma/seed.js` and modifies `prisma/seed.ts` (uncommitted). **A.**

**S.3 — The operator documentation the README links to does not exist.** `docs/DEPLOYMENT.md`, `docs/API.md`, `docs/DATABASE.md`, `docs/CONTRIBUTING.md`, `CONTRIBUTING.md` — all referenced (`README.md:238,244,247`) and all absent. Two more stale README claims: "**API Docs**: http://localhost:3001/api/docs" (`:51`) — the route is `/api/v1/docs` **and** it is disabled by default (`ENABLE_SWAGGER` is unset in the container, so `setupSwagger` returns early and both `/api/docs` and `/api/v1/docs` answer 404); "**PostgreSQL**: localhost:5432" (`:52`) — the published compose port is **5433** (`docker-compose.yml:33`) and the host-side files use 5544. The repository root also carries development debris **tracked in git**: `e2e-test-output.txt`, `PHASE_A_FINAL_SUMMARY.txt`, `PHASE_A_FINAL_SUMMARY.zip`. **D.**

**S.4 — What is documented and correct** (so the implementation phase does not re-litigate it): the runtime/datasource matrix and its rationale (`ADR-0005`), the cross-runtime token contract (`ADR-0006`, §A–§F), the JWT key-rotation procedure (`docs/reports/PHASE_52-ARCH-3C-R1_ACTIVATION.md`, three steps mirrored in `.env.example`), the "migrations are never startup" rule (three independent artifacts), and the per-owner migrate/generate scripts (root + api `package.json`). **E.**

**Classification: D — DOCUMENTATION GAP** (S.1's false CI/CD claims; S.3's dangling links and stale endpoints/ports) + **A — CONTRACT GAP** (S.1's absent pipeline; S.2's unguarded, Core-only seed) + **E** (S.4).

---

## FINDINGS REGISTER (every finding, one classification each)

| # | Finding | Class | Evidence |
|---|---|---|---|
| 1 | Compose pins `dist/core-main.js`, but only `AppModule` (`dist/main.js`) registers `CommerceModule`/`HrModule`/`CorrespondenceModule`; recreating the API service would drop every C1–C9 route | **A** | `docker-compose.yml:292-299`; `core-main.ts:7,22`; `core-app.module.ts:1-39,60-209`; `app.module.ts:51,137`; `runtime-policy.json` (`runtimes.core…commerce-client`) |
| 2 | Live API container runs `dist/main.js` with the secret-loader wrapper — created before `824e074` and never recreated; `docker compose config` still resolves `core-main.js` | **B** | `docker inspect Config.Cmd`; `docker compose config` → `exec node dist/core-main.js`; container created `2026-09-30T13:59Z`; `docker compose up --dry-run` → `Recreate` |
| 3 | Image `erp-api:latest` (built `2026-09-30T13:42Z`) lacks `dist/…/completion`, `dist/…/search`, `dist/platform/search-source` → C4R/C8/C9 routes 404 live while their migrations are applied | **B** | `docker exec ls`; live 404s; §H status table |
| 4 | Observability: `prisma/observability` not shipped in the image and `observability-client` pruned, yet compose sets `OBSERVABILITY_DATABASE_URL` + `OBSERVABILITY_ENABLED=true`; writer/retention log `is not a function` and drop batches forever | **A** | `Dockerfile.backend:54-66`; `docker exec ls /app/apps/api/prisma`; `runtime-policy.json` `combined.image.prunedArtifacts`; `docker logs`; `docker-compose.yml:192-195` |
| 5 | Five of six databases must be hand-created; nothing in the repo creates them | **C** | `docker-compose.yml:31` (`POSTGRES_DB` only), `:135-136` (one operator comment); no init script anywhere |
| 6 | `npm run db:migrate` cannot complete: no `OBSERVABILITY_DATABASE_URL` in `apps/api/.env` → `P1012` mid-chain, before correspondence/hr/commerce | **A** | `prisma migrate status --schema=prisma/observability/schema.prisma` → P1012; `apps/api/package.json` chain |
| 7 | Host-side Prisma commands migrate the **e2e** cluster (`localhost:5544`), not the compose cluster (`5433`) | **A** | `apps/api/.env:24-28,45`; `.env.local:4-9`; status table shows `localhost:5544` |
| 8 | Deprecated root project `prisma/schema.prisma` is the CLI's default target; a bare `prisma …` without `--schema` operates on legacy history (`DATABASE_URL`) | **A** | `apps/api/prisma/schema.prisma`; ADR-0005:43; observed `validate` resolving `prisma\schema.prisma`; both Dockerfiles ship `prisma/migrations` |
| 9 | Three migration dirs + `commerce`/`core` schema edits are applied to the DB but **untracked** — a clean checkout cannot reproduce the deployed schema | **A** | `git status --porcelain`; tracked-vs-disk counts (core 46/47, commerce 10/12) |
| 10 | Nest reads `.env.local`; Prisma CLI/clients read `.env`; README documents only `.env.local` | **A** | `app.module.ts:60-62`; `core-app.module.ts:55-57`; `README.md:60-61`; P1012 evidence |
| 11 | Importing a generated Prisma client mutates the host `process.env` from `apps/api/.env` | **A** | `core-client/index.js:1206-1210` (`schemaEnvPath: "../../../.env"`); observed probe (`RABBITMQ_URL set = true`) |
| 12 | `PORT`/API base have three incompatible values; the dev web file targets a **closed** port 4000 | **A** | `.env.local:2` (`4000`); `.env.e2e:53`/compose/README (`3001`); `apps/web/.env.local:1`; TCP probe refused |
| 13 | Mail contract mismatch: compose/example define `MAIL_*` + `SMTP_PASSWORD`; code reads `SMTP_HOST/PORT/USER/PASS` + `EMAIL_FROM` → deployed API always logs mail to console, mailpit unused | **A** | `email.service.ts:10-13,30,15-24`; `docker-compose.yml:224-225`; container env probe (`MAIL_HOST` set, `SMTP_HOST` absent) |
| 14 | `.env.example` declares `CORS_ORIGINS` twice (second empty) → copying the template yields an empty allow-list | **A** | `apps/api/.env.example:186` vs `:299` |
| 15 | `secrets/` untracked but **not gitignored**; the "must never be committed" promise exists only as a comment | **A** | `.gitignore:12,18-20`; `git status` `?? secrets/`; `docker-compose.yml:334-335` |
| 16 | No compose healthcheck for `api`, `web` or `nginx`; `mailpit` healthcheck is `exit 0` yet gates startup; `/ready` unused by the orchestrator | **A** | `docker-compose.yml:36-41,52-57,72-77,93-98,110-114` vs no block at `:119,302,317`; `:277` |
| 17 | CORS refusal emits **HTTP 500** instead of 403 | **A** | `env.validation.ts:288-303`; live `OPTIONS` probe with `evil.example` → 500 |
| 18 | `NEXT_PUBLIC_API_URL` is a build-time input with no `ARG` and three conflicting documented values (two of them wrong by construction); `NEXT_PUBLIC_APP_URL` never set | **A** | `Dockerfile.frontend`; `docker-compose.yml:307`; `constants.ts:2,8`; chunk probe; `.env.example:7`; `FOLDER_STRUCTURE.md:563` |
| 19 | E2e bootstrap (`test/global-setup.ts`, `global-teardown.ts`) exists but is wired into **no** jest config | **A** | both `jest-e2e.json` files lack `globalSetup`; repo-wide search finds zero references |
| 20 | E2e depends on `aria-erp-e2e-dbproxy` (socat) — a container no committed file creates | **C** | `.env.e2e` (5544); `docker ps` labels `{}`; compose has no such service |
| 21 | `AI_CONFIG_ENCRYPTION_KEY` (production-required by the validator) is not set by compose | **C** | `env.validation.ts:272`; container env probe (absent) |
| 22 | Key material must be generated outside the repo; the only procedure lives in a phase report | **C** | `docker-compose.yml:333-339`; `docs/reports/PHASE_52-ARCH-3C-R1_ACTIVATION.md` |
| 23 | Deployed nginx is the stock welcome page: `./nginx` mounted instead of `./infrastructure/nginx` (real proxy unused); `443` published with no TLS server | **B** | `docker-compose.yml:324-325`; `nginx -T`; live `:80`/`:443` probes; `infrastructure/nginx/**` unreferenced |
| 24 | The *undeployed* proxy config would still break the contract: `/health`→`api/health` (404), `/api/docs`→wrong path and disabled, edge adds `ACAO *` over credentials | **A** | `infrastructure/nginx/conf.d/api.conf:24-31,35-38,64-68`; live `:3001/health`→404; Swagger probe |
| 25 | No CI/CD anywhere; root `scripts/`, `k8s/` absent — while README/ARCHITECTURE/FOLDER_STRUCTURE document them | **D** | `README.md:92,107`; `ARCHITECTURE.md:105,503`; `FOLDER_STRUCTURE.md:454,480,588`; `Test-Path` all false |
| 26 | Docs reference missing files (`docs/DEPLOYMENT.md`, `docs/API.md`, `docs/DATABASE.md`, `docs/CONTRIBUTING.md`, `apps/web/.env.example`) and stale endpoints/ports (API-docs URL, Postgres `5432`, `/api/v1/health/live`) | **D** | `README.md:51,52,60,238,244,247`; `Test-Path` false; live 404s |
| 27 | Seed: no `NODE_ENV` guard, defaults `admin@localhost`/`ChangeMe123!`, Core-database-only — five of six databases have no seed path | **A** | `prisma/seed.ts:1,127-129,172-178` |
| 28 | Backend image's "production" runner stage deliberately carries dev dependencies, full `src/`, `test/` and jest config for in-container e2e | **E** | `Dockerfile.backend` (stated intent in comments) |
| 29 | Runtime/datasource policy, JWT secret provisioning, health semantics, tracked `.env.e2e`, `.dockerignore` exclusions, migrations-never-at-startup — verified correct | **E** | §G, §L, §M, §R.3, §P.4, §H |

**Register totals: 18 × A (contract) · 3 × B (drift) · 4 × C (operational prerequisite) · 2 × D (documentation) · 2 × E (verified/no gap) — 29 findings.**

---

## EXACT GAP-ENV CLASSIFICATION

**`MIXED — DEPLOYMENT ENTRY POINT UNDEFINED, DEPLOYMENT ARTIFACT STALE, ENVIRONMENT CONTRACT SPLIT ACROSS FILES`**

The gap is not one thing, and it must not be reported as one:

1. **The entry point is contradictory — the core of GAP-ENV** (finding 1). Three different answers to "which process serves this system?" coexist in one commit: the image default (`CMD node dist/main.js`, combined), the compose pin (`dist/core-main.js`, core-only), and the running container (`dist/main.js`, combined — created before the pin landed). Only the *combined* one can serve C1–C9, and it is the one **not** written in the deployment file. The deployment manifest, the runtime policy and the module graph disagree about what a container runs → **A**.
2. **The deployment artifact is stale** (findings 2, 3, 23) → **B**, fixable by rebuild/recreate, not by editing application code.
3. **The environment contract is split across four files with different readers and no authoritative one** (findings 6, 7, 8, 10, 11, 12, 13, 14): `.env.example` (template), `.env` (Prisma CLI + generated clients), `.env.local` (Nest), `.env.e2e` (Jest), plus compose's own `environment:` block. No source change can repair this — someone must *decide* the file-per-consumer rule and write it down → **A**.
4. **Three genuinely external prerequisites are undocumented as prerequisites** (findings 5, 20, 22): six databases, the e2e socat proxy, the key-generation step → **C**.
5. **The controls that would have caught all of the above do not exist** (findings 25, 26): no CI, and the docs describe CI/k8s/`scripts/` that are not there → **D** — but operationally the highest-leverage item, since every A- and B-class finding is exactly what a first pipeline would have failed on.
6. **What is verified good is genuinely good** (findings 28, 29 and every **E** in §G–§S): the six-schema policy and its JSON projection, its health projection, JWT secret provisioning and JWKS publication, the tracked e2e environment, the "migrations never at startup" rule, and the three green contract suites (17 + 24 + 32 tests).

**One-line verdict for the phase chain:** GAP-ENV is **OPEN**, **A-dominant (18 of 29)**; the single highest-severity item is **finding 1 — the compose-pinned entry point cannot serve the Commerce surface that C1–C9 delivered**, currently masked only because the running container predates the pin.

---

## STOP / BLOCKED STATUS

**Not stopped. Not blocked.** Every STOP condition is cleared by evidence:

- **Authoritative entry point identified:** `main.ts` (combined) is the only composition root registering `CommerceModule`; `core-main.ts` (core) is what compose pins; the running container runs combined — `/ready` reports `"runtime":"combined"` (§D).
- **No conflicting external contracts:** ADR-0005, ADR-0006 and `runtime-policy.json` agree on requirements; the disagreement is *inside* the deployment files, not between subsystems.
- **Migration state readable per schema:** five of six owners report `Database schema is up to date!`; the sixth fails only on a missing env variable (finding 6), which is a finding, not an obstruction.
- **No probe required a write:** every claim was provable with read-only inspection, HTTP probes, `docker exec` reads and three green Jest suites.
- **Decisions required belong to the implementation prompt, not this phase:** (a) which entry point is authoritative for the C1–C9 deployment; (b) whether the untracked C7–C9 work is committed before or by the GAP-ENV implementation phase; (c) whether the e2e dbproxy becomes a declared compose service or is documented as host tooling.

---

## FINAL RESPONSE (preflight summary)

- **GAP-ENV classification:** `MIXED` — **A-dominant**: `DEPLOYMENT-ENTRY-POINT-CONTRADICTORY · ARTIFACT-STALE · ENV-CONTRACT-SPLIT-ACROSS-FILES`. Register: **18 × A · 3 × B · 4 × C · 2 × D · 2 × E = 29 findings**.
- **Does an authoritative environment/deployment contract exist?** **Partly.** The *policy* layer — `runtime-policy.json`, `env.validation.ts`, ADR-0005/0006, `.env.example` — is complete and self-consistent (verified, §G–§L, §R.3). The *execution* layer — compose `command`, mounted nginx, image contents, the `.env` family, healthchecks, CI — does not implement it.
- **Authoritative owner:** `runtime-policy.json` + ADR-0005 define *what* a runtime needs; `docker-compose.yml` defines *how* it is deployed — and the two currently disagree about the entry point (finding 1).
- **Exact capability currently missing:** one declared entry point for the deployed runtime; one authoritative env file per consumer; a rebuild of the deployment artifact from the current tree; and any automated check that would notice the next divergence.
- **Platform/Core changes required?** **Yes, but small and declarative:** (1) decide and rewrite the compose `command` (combined vs core) and remove the now-false comment at `docker-compose.yml:281-289`; (2) either ship `prisma/observability` + its client or stop setting `OBSERVABILITY_ENABLED` — and make the writer's degradation a real no-op instead of `is not a function` loop; (3) align the mail variable names (`MAIL_*`/`SMTP_PASSWORD` vs `SMTP_*`/`SMTP_PASS`) with `email.service.ts`; (4) answer a denied CORS origin with 403, not 500 (`buildCorsOrigin`'s error path); (5) wire `globalSetup` into a jest config (or delete the dead bootstrap); (6) add a `NODE_ENV` guard to the seed. **No business-logic, schema or Commerce-surface change is implied.**
- **Exact next implementation phase:** **GAP-ENV-1 — deployment contract**, in this order: commit/decide the untracked C7–C9 worktree → declare the entry point and reconcile compose with `runtime-policy.json` → rebuild `erp-api`/`erp-web` from the current tree → wire healthchecks (compose `healthcheck` against `/ready`) and mount the real nginx tree → unify the env-file contract and fix `.env.example` → declare the six databases, the e2e dbproxy and the key-generation step as bootstrap steps → repair or retract the documentation (CI/k8s/`scripts/`, missing `docs/*.md`, stale ports and health paths) → add the minimal CI that runs the three green suites plus `prisma migrate status` for all six schemas.
- **Files changed by this phase:** `docs/PHASE-GAP-ENV-PREFLIGHT.md` — **only**. No source, schema, migration, Dockerfile, compose, nginx, env, seed or test file was touched.
- **Checks performed:** read-only file reads and `Select-String`/`findstr` audits over `apps/api/{src,prisma,test,scripts}`, `apps/web/{src,.next}`, `infrastructure/**`, `nginx/**`, `docs/**` and root files; `git status --porcelain`, `git ls-files`, `git check-ignore`, `git log -S`, `git show HEAD:…`; `docker compose config`, `docker compose up --dry-run`, `docker ps -a`, `docker inspect`, `docker logs`, `docker exec` (read-only `ls`/`grep`/`env`/`nginx -T`); per-schema `prisma migrate status` and `prisma validate`; live HTTP probes (`/api/v1/health`, `/api/v1/live`, `/api/v1/ready`, `/.well-known/jwks.json`, commerce route set, CORS `OPTIONS` allowed/denied, Swagger paths, nginx `:80` and `:443`); three Jest suites run to green — `env.validation` 17, `architecture-boundaries` 24, `runtime-policy` 32. **No build, no `prisma generate`, no migration, no seed, no container recreate, no database write, no file write outside this document.**
- **Blockers:** **none** for this preflight. Three decisions are queued for the implementation prompt (authoritative entry point; commit the untracked C7–C9 work; ownership of the e2e dbproxy).