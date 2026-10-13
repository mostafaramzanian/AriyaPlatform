# PHASE PRODUCTION-RUNTIME-REFRESH

A small deployment-verification phase: rebuild the API image from the current repository state
and recreate only the API container, so the live runtime matches the working tree.

**No application source, no schema and no migration was changed.**

---

## 1. Scope

**In scope.** Refresh the running API deployment so the live runtime carries the completed
Production BOM Header implementation: a fresh `docker compose build api`, a `docker compose
up -d api` that recreates **only** the API service, then verification of `/live`, `/ready`,
in-container artifacts and a regression smoke.

**Out of scope.** Application source, schema, migrations, BOM behaviour, BOM Item, Product Tree,
code generation, Commerce, database reset/recreation, and any image or tagging change. See §9.

**Two deployment-configuration gaps were found in the pre-check and closed first** (§2.2). Both
are compose/Dockerfile contract, not application code, and both would have failed the success
criteria had they been left:

1. `PRODUCTION_DATABASE_URL` was **absent** from the compose `api` service environment — the
   rebuilt container would have had no URL, the `required` `productionDatabase` probe would have
   failed closed, and `/ready` would have reported `blocking: [...]`.
2. `Dockerfile.backend` did **not copy `prisma/production`** into the runner stage, so the image
   could not bring `production_db` to the revision the running code expects — for exactly the
   reason the Commerce and HR copies are there.

---

## 2. Pre-state

### 2.1 Repository

| Item | Value |
| --- | --- |
| HEAD | **`840226b`** on **`master`** — unchanged before and after |
| Working tree | the known Production BOM Header changes (24 tracked files + Production prisma/module trees), plus the previous phase's deployment edits |
| Build context | `E:\ERP` (resolved by `docker compose config`, exit 0) — the **current repository** |
| Dockerfile | `./infrastructure/docker/Dockerfile.backend` |
| Entrypoint | `CMD ["node", "dist/main.js"]` — confirmed present in the image at `/app/apps/api/dist/main.js` |
| Production DB config in image source | present: `env.validation.ts` (2 hits in `dist/config/env.validation.js`), `health.contract.ts` (1 hit in `dist/health/health.contract.js`) |

### 2.2 Deployment-configuration gaps found before building

| # | Gap | Consequence if not fixed | Fix |
| --- | --- | --- | --- |
| 1 | `PRODUCTION_DATABASE_URL` missing from `docker-compose.yml` `api.environment` (only six `*_DATABASE_URL` present) | `productionDatabase` probe fails closed → `/ready` returns `blocking: ["productionDatabase"]` | added as the seventh, with a comment in the same style as the Commerce entry |
| 2 | `Dockerfile.backend` runner stage copies `prisma/{core,cms,correspondence,hr,commerce}` but **not** `prisma/production` | `npm run prisma:migrate:production` unavailable inside the image layout | added the copy + updated the header comment |
| — | Prune list for `combined` | *verified, no change needed* — `node scripts/runtime-policy.mjs prune-clients-for combined` returns **`observability-client` only**, so `production-client` is **kept** | none |

Neither gap required touching application source: one is compose environment, one is a Dockerfile
`COPY`.

### 2.3 Live state before

```
container  aria-erp-api   9527043f70d6   image c6ced7d28d8c   created 2026-10-02T15:07:20Z   Up 14 hours (healthy)
image      erp-api:latest c6ced7d28d8c   built 16 hours ago   1.59GB
postgres   aria-erp-postgres e62c1275990f   created 2026-10-02T15:07:00Z   Up 14 hours (healthy)
```

Evidence the image was stale (from the previous phase, re-confirmed now):

```
$ docker exec aria-erp-api grep -rl productionDatabase /app/dist/health   → (none)
$ docker exec aria-erp-api grep -c PRODUCTION_DATABASE_URL /app/dist/config/env.validation.js → 0
```

---

## 3. Build

`docker compose build api` — one fresh build, no `--no-cache`, because Docker's `COPY . .` layer
is content-addressed: the working tree changed (the whole Production module, prisma project and
the health/datasource wiring), so the copy layer and every layer after it were rebuilt from
scratch. Cache was therefore **not** able to preserve stale artifacts, and it did not — the build
log shows `[builder 6/8] COPY . .` and `[builder 7/8] RUN npm run build --workspace=apps/api`
(which runs `prisma:generate` for every owner, production included) running in this build rather
than being restored.

```
#18 [builder 6/8] COPY . .
#19 [builder 7/8] RUN npm run build --workspace=apps/api
   … prisma:generate:core … postbuild …
 Image erp-api Built
```

| Item | Old | New |
| --- | --- | --- |
| `erp-api:latest` id | `c6ced7d28d8c` | **`22b18d541a31`** |
| built | 16 hours before | **2026-10-03 10:17:18 +0330** |
| size | 1.59GB | 1.64GB |

---

## 4. Recreate

```bash
docker compose up -d api
```

Only the `api` service was addressed. Nothing else was in the command, and nothing else changed:

| Service | Container | Created | Status before → after |
| --- | --- | --- | --- |
| **api** | `9527043f70d6…` → **`c286e1a44ff4…`** | 2026-10-03 10:21:40 | Up 14h (healthy) → **Up (healthy)** from the new image |
| postgres | `e62c1275990f…` | **2026-10-02 15:07:00 — unchanged** | Up 14h (healthy) → unchanged |
| redis / rabbitmq / minio / mailpit / nginx / web / e2e-dbproxy | unchanged | unchanged | all still "Up 14 hours" |

| Not done | Verified by |
| --- | --- |
| postgres not recreated | container id and `Created` timestamp identical before and after |
| no volume removed | `docker volume ls` still lists `erp_postgres_data`, `erp_postgres_data_pgv`, `erp_redis_data`, `erp_rabbitmq_data`, `erp_minio_data`, `erp_mailpit_data` |
| no database dropped/reset | **no migration ran in this phase** (§7); `prisma migrate status` was not re-executed and no `db:migrate` was invoked |
| no image/tagging change | the service still resolves `image: erp-api` / `erp-api:latest`; no tag was introduced or renamed |
| no files copied into the container by hand | everything came from the build; artifact checks (§6) were made **through `docker exec` against the image's own layers** |

The `up -d api` command printed only the pre-existing obsolete-`version` warning
(`docker-compose.yml: the attribute 'version' is obsolete`), which predates this phase and is
unrelated to databases or the API image.

---

## 5. Runtime verification

### `/live`

```json
{"runtime":"combined","status":"alive","timestamp":"2026-10-03T06:52:21.048Z"}
```

### `/ready`

```json
{
  "runtime": "combined",
  "status": "ready",
  "checks": {
    "coreDatabase": true, "cmsDatabase": true, "observabilityDatabase": false,
    "correspondenceDatabase": true, "hrDatabase": true, "commerceDatabase": true,
    "productionDatabase": true, "redis": true, "rabbitmq": true, "storage": true
  },
  "requirements": {
    "productionDatabase": "required", "commerceDatabase": "required",
    "observabilityDatabase": "optional"
  },
  "statuses": {
    "productionDatabase": "ok", "commerceDatabase": "ok", "observabilityDatabase": "failed"
  },
  "notConfigured": [],
  "optionalDegraded": ["observabilityDatabase"],
  "blocking": []
}
```

**This is the first time the live payload carries `productionDatabase` at all.**

| Assertion | Result |
| --- | --- |
| `runtime = combined` | **PASS** |
| `productionDatabase` present, **`true`**, requirement **`required`**, status **`ok`** | **PASS** |
| `blocking` empty — no unexpected blocking dependencies | **PASS** (`[]`) |
| `commerceDatabase` **`true`** / `required` / `ok` | **PASS** |
| `notConfigured` empty (every required URL supplied) | **PASS** (`[]`) — proves the compose env fix worked |
| `optionalDegraded` is only the pre-existing `observabilityDatabase` | **PASS** — unchanged, deliberate (client pruned, `OBSERVABILITY_ENABLED=false`) |

### Peripheral services

| Check | Result |
| --- | --- |
| Web | `http://localhost:3000/` → **200** (45,840 bytes) |
| nginx | `aria-erp-nginx Up 14 hours (healthy)` |
| web container | `aria-erp-web Up 14 hours (healthy)` |
| **JWKS** | `GET http://localhost/.well-known/jwks.json` → **200**, real keys returned: `{"keys":[{"kty":"RSA","use":"sig","alg":"RS256","kid":"gate-a-rsa-1","n":"vK1dcz…"}]}` |
| **Commerce endpoints available** | `GET /api/v1/commerce/commercial-groups` → **401**; `GET /api/v1/commerce/purchase-documents` → **401** |
| **Production route present** | `GET /api/v1/production/boms` → **401** |

`401`, not `404`, is the pass condition for the last three: the routes are **registered and
gated** (JWT rejects the anonymous caller). A `404` would have meant the module was not composed
into the running runtime — which is exactly what the stale image produced before this refresh.

---


---

## 6. Artifact verification

Verified **twice**: once directly against the image (`docker run --rm --entrypoint sh erp-api:latest …`)
to prove the build produced them, and once **inside the running container**
(`docker exec aria-erp-api …`) to prove the container is running that build. Container startup
success was not treated as sufficient.

| # | Required artifact | In image | In running container |
| --- | --- | --- | --- |
| 1 | **current application entrypoint** `dist/main.js` | ✅ 3,967 bytes, Oct 3 06:46 | ✅ `/app/apps/api/dist/main.js` |
| 2 | **`production/` module** `src/modules/production` | ✅ | ✅ |
| 3 | — compiled `dist/modules/production` | ✅ `production-actor`, `production-audit.gateway`, `production.constants`, `production.module` | ✅ |
| 4 | — **BOM Header** `dist/modules/production/bom` | ✅ `bom.controller` `bom.dto` `bom.repository` `bom.service` `bom-status` (all five) | ✅ same five |
| 5 | **`health/productionDatabase`** | ✅ `dist/health/health.contract.js` → `productionDatabase` ×1 | ✅ ×1 |
| 6 | **production env validation** | ✅ `dist/config/env.validation.js` → `PRODUCTION_DATABASE_URL` ×2 | ✅ ×2 |
| 7 | combined health composes Production | ✅ `dist/health/combined-health.module.js` → `ProductionPrismaModule` ×3 | ✅ ×3 |
| 8 | `production-client` **not pruned** | ✅ `src/generated/production-client` **and** `dist/generated/production-client` | ✅ `dist/generated/production-client` |
| 9 | **`prisma/production` carried** (the §2.2 fix) | ✅ `schema.prisma` + `migrations` | ✅ `migrations` + `schema.prisma` |
| 10 | **current Commerce implementation** | ✅ `dist/modules/commerce` | ✅ `dist/modules/commerce` |

The prune check (#8) is the one that could silently regress: `runtime-policy.json` declares
`combined.image.prunedArtifacts = [observability-client]` and the build's
`prune-clients-for combined` emitted exactly `observability-client`, so the Production client
survives into both `src/generated` and `dist/generated`.

---

## 7. Regression smoke

```
npx jest src/modules/commerce src/modules/production src/health \
         src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts
```

| Metric | Result |
| --- | --- |
| **Test suites** | **65 passed, 65 total** |
| **Tests** | **955 passed, 955 total** |
| failures | **0** |

Covers, as required:

* **Production module still loads** — `src/modules/production` (10 suites).
* **Commerce still loads** — `src/modules/commerce` (the module's own suites).
* **Tenant isolation unaffected** — `production-isolation.spec.ts`, `bom.repository.spec.ts`,
  `bom.service.spec.ts`, `production-actor.spec.ts`.
* **Health / architecture contract valid** — `src/health` (the `productionDatabase` readiness
  assertions), `architecture-boundaries.spec.ts` (the datasource matrix), `runtime-policy.spec.ts`
  (the regenerated projection).

The six `… failed` strings in the raw log are **log output from negative-path tests** (e.g.
`Production audit write failed`, `commerce.notification.user.failed`, `AUDIT_READ_FAILED`) — they
are assertions that failures are *reported*, not suite failures. The summary line is unambiguous.

No `tsc` run was needed: no TypeScript was changed (§8).

---


---

## 8. Git / worktree state

**HEAD before: `840226b` (`master`) — HEAD after: `840226b` (`master`).** No `git add`, no commit,
no `reset`, no `clean`, no `amend`, no `rebase`, no history rewrite, no generated runtime artifact
committed.

**Tracked files in `git diff --name-only`: 24** — the identical set that was already modified
before this phase (the BOM Header implementation's `apps/api/**` wiring, `runtime-policy.json`,
`ARCHITECTURE.md`, `FOLDER_STRUCTURE.md`, `docs/DEPLOYMENT.md`,
`infrastructure/postgres/initdb/01-create-databases.sql`, `docker-compose.yml`), **plus exactly
one file new to this phase:**

| File | Lines | What this phase changed |
| --- | ---: | --- |
| `infrastructure/docker/Dockerfile.backend` | +10 / −2 | `COPY …/prisma/production` into the runner stage; header comment now lists Production |

`docker-compose.yml` was already modified before this phase (the initdb comment); this phase
**added only** the `PRODUCTION_DATABASE_URL` environment block — `git diff docker-compose.yml`
contains exactly two hunks: the previous phase's initdb comment and this phase's env entry.

**Untracked:** the known carried-over set (Production `prisma/core/migrations` ×4,
`prisma/production/`, `src/modules/production/`, `apps/web/phaseui*`, `backups/`, the phase docs)
**plus** this document. **No `.tmp-*` file remains** — every scratch file this phase created
(`.tmp-build.cmd`, `.tmp-build.log`, `.tmp-cfg.txt`, `apps/api/.tmp-jest.cmd`,
`apps/api/.tmp-jest.log`) was deleted.

**Not committed:** local `.env` files (still git-ignored), credentials, database dumps, throwaway
containers/volumes (none were created this phase), or generated artifacts.

**Live stack:** every container except `aria-erp-api` kept its original id and `Up 14 hours`
status; no volume was created, removed or re-mounted.

---

## 9. Non-goals

1. **No application source changed.** No `.ts` file under `apps/api/src` was edited in this phase.
2. **No schema changed** — `prisma/**` untouched (neither `schema.prisma` nor any migration).
3. **No migration created, and none executed** — no `db:migrate`, no `prisma migrate deploy`,
   no `migrate reset`.
4. **No database dropped, reset or recreated**; no volume deleted; postgres not restarted.
5. **No BOM behaviour changed** — no route, DTO, service, repository, status rule, permission,
   entitlement row or test assertion altered.
6. **No BOM Item, no Product Tree, no code generation, no `standardPartCode`.**
7. **No Commerce change** — `src/modules/commerce/**` untouched.
8. **No new health endpoint** — `/live` and `/ready` are the pre-existing routes; `/ready` simply
   now reports a check the code has always declared.
9. **No image/tagging architecture change** — still `erp-api:latest`, still `image: erp-api`,
   still `Dockerfile.backend`.
10. **No manual file copied into the container** — artifacts come only from the build.
11. **No commit, no history rewrite, no `git clean`.**
12. **No I-1 decision and no BOM Item implementation.**


---

## 10. Final status

**CLOSED.** All eight success criteria:

| # | Criterion | Status |
| ---: | --- | --- |
| 1 | Fresh API image built from current HEAD | **PASS** — `erp-api:latest` = **`22b18d541a31`**, built this phase from build context `E:\ERP` @ `840226b`, 0 build errors |
| 2 | API container recreated from that image | **PASS** — `9527043f70d6…` (image `c6ced7d28d8c`) → **`c286e1a44ff4…`** (image `22b18d541a31`), `Up (healthy)` |
| 3 | Live `/live` healthy | **PASS** — `{"runtime":"combined","status":"alive"}` |
| 4 | Live `/ready` reports Production database correctly | **PASS** — `productionDatabase: true`, `requirement: required`, `status: ok`, **`blocking: []`** |
| 5 | Commerce remains healthy | **PASS** — `commerceDatabase: true / required / ok`; `GET /api/v1/commerce/commercial-groups` and `/purchase-documents` → **401** (routes present and gated) |
| 6 | No database reset/recreation | **PASS** — postgres container id and `Created` unchanged; all six volumes present; **zero migration commands executed** |
| 7 | No source/schema changes needed | **PASS** — no `apps/api/src/**` or `prisma/**` edit; the only new tracked change is `infrastructure/docker/Dockerfile.backend` (+10/−2) plus one compose env block — both deployment configuration, §2.2 |
| 8 | Runtime artifact matches repository state | **PASS** — 10/10 artifact checks, verified **both** in the image and inside the running container (§6) |

### Additional confirmations

* **JWKS available** — `/.well-known/jwks.json` → 200 with `kid: gate-a-rsa-1`.
* **Web reachable** — `http://localhost:3000/` → 200; nginx and web containers healthy.
* **Regression** — **65 suites / 955 tests, 0 failures**, covering Production, Commerce, health,
  architecture boundaries and runtime policy.
* **`production_db` reachable from the runtime** — `productionDatabase: ok` in `/ready`.
* **The image is genuinely current**, not merely restarted: `dist/modules/production/bom` (all
  five files), `productionDatabase` in `health.contract.js`, `PRODUCTION_DATABASE_URL` in
  `env.validation.js`, `prisma/production`, and a retained `production-client`.

### Residual issue

**None blocking.** The one known cosmetic pre-existing condition remains exactly as before:
`optionalDegraded: ["observabilityDatabase"]`, because the combined image deliberately prunes
`observability-client` and runs with `OBSERVABILITY_ENABLED=false`. It is `optional`, not
`required`, and does not appear in `blocking`.

### Status: **REFRESHED AND VERIFIED**

The live runtime now corresponds exactly to the current repository state. **Header + Production
infrastructure are ready; the main path now stops.**

> **STOP.** Do not begin I-1 or BOM Item implementation until one of the two explicit I-1
> business inputs is supplied:
>
> 1. an authoritative **Product Tree Code** contract/source (§15 of
>    `PHASE-PRODUCTION-BOM-PRODUCT-TREE-CODE-DECISION.md`, options 1a / 1b / 1c), **or**
> 2. an explicit decision that **`standardPartCode` is not generated in V1**.
>
> Engineering must not choose between them, and must not guess a prefix.

| error/warning lines in build log | — | **0** |
