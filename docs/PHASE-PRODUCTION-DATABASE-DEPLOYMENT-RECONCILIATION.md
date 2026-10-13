# PHASE PRODUCTION-DATABASE-DEPLOYMENT-RECONCILIATION

A small deployment/bootstrap fix phase. It reconciles the finding recorded in
`PHASE-PRODUCTION-BOM-PRODUCT-TREE-CODE-DECISION.md` (Appendix D) and repairs the
bootstrap mechanism that finding exposed.

**No BOM business semantics were changed.**

---

## 1. Scope

**In scope.** Make the authoritative PostgreSQL bootstrap path create `production_db`
automatically, using the repository's established database-creation convention, so that a fresh
Postgres volume brought up through `docker-compose.yml` needs **no manual database creation**.

**Out of scope.** BOM Item, Product Tree, code generation, `standardPartCode`, Procurement, the
BOM Header's behaviour, and any Project/Product Tree contract. All untouched — see §11.

**Discovery before editing** (§3) covered: `docker-compose.yml`, `infrastructure/postgres/initdb/*`,
any production-specific initdb file, Production Prisma configuration, `.env.example`,
`.env.e2e`, `runtime-datasources.ts`, `docs/DEPLOYMENT.md`, `.github/workflows/ci.yml`, and the
database-creation conventions used by the other bounded contexts. Nothing was guessed.

---

## 2. Finding

### 2.1 The reported finding

`production_db` was registered in the runtime datasource policy and in `.env.example` /
`.env.e2e`, but **`docker-compose.yml` mounts `./infrastructure/postgres/initdb`, which created
only the six pre-Production databases.** The `production_db` line had been written to a
**root-level, untracked** `initdb/01-create-databases.sql` that compose never mounts.

Consequence: a fresh volume initialised through the authoritative compose path did **not**
create `production_db`, so the Production runtime would need a hidden manual step.

This was already prescribed by the contract closure —
`PHASE-PRODUCTION-BOM-CONTRACT-CLOSURE.md` §10 item 10 reads:

> `infrastructure/postgres/initdb/01-create-databases.sql`: `CREATE DATABASE production_db`
> guarded by `NOT EXISTS` — *the ownership-contract comment block listing all six*

The previous phase wrote it to the wrong file. This phase puts it where the contract says.

### 2.2 The deeper finding, discovered during validation

**The authoritative initdb file has never worked at all.** It wrapped every guard in a single
`DO $$ BEGIN … CREATE DATABASE …; END $$;` block. PostgreSQL forbids `CREATE DATABASE` inside a
function:

```
ERROR:  CREATE DATABASE cannot be executed from a function
CONTEXT:  SQL statement "CREATE DATABASE core_db OWNER aria_user"
PL/pgSQL function inline_code_block line 4 at SQL statement
```

The official PostgreSQL entrypoint runs `*.sql` under `ON_ERROR_STOP=1`, so that error **aborted
initialisation** and the container came up with **none** of the databases. Confirmed on an
isolated throwaway volume during this phase (§8 C) — the container's own log shows the script
running and dying at line 59.

**What this means in practice:**

| Claim | Reality |
| --- | --- |
| "initdb creates the six databases on first init" (the file's own header, `docker-compose.yml`, `docs/DEPLOYMENT.md`, `FOLDER_STRUCTURE.md`) | **Never true.** The mechanism aborted before creating any. |
| Why the six databases exist today | **An operator created them by hand** against the live cluster. |
| Why `production_db` exists today | Same — created by hand in the previous phase. |
| The file's own "run it manually on an existing cluster" instruction | Also failed — the same `DO` block errors under `psql -f`. |

So this phase does two things, both required to satisfy "fresh bootstrap creates
`production_db` automatically": it **repairs the mechanism** and it **adds the missing database**.
Adding only the line, without the repair, would have left criterion #2 unsatisfiable.

---

## 3. Existing deployment contract

Discovered, not assumed:

| # | Contract fact | Where it is stated |
| --- | --- | --- |
| 1 | **Naming** — `<owner>_db`, lower snake case: `core_db`, `cms_db`, `correspondence_db`, `hr_db`, `commerce_db`, `observability_db`, `production_db` | `infrastructure/postgres/initdb/01-create-databases.sql`, `docs/DEPLOYMENT.md` |
| 2 | **One single Postgres service** for every database (`aria-erp-postgres`, `pgvector/pgvector:pg16`); no per-database container | `docker-compose.yml` |
| 3 | **All databases share one role** — `aria_user`. **No database-specific role exists**; `POSTGRES_USER: aria_user` is the only role the image creates | `docker-compose.yml`, every `CREATE DATABASE … OWNER aria_user` |
| 4 | **`POSTGRES_DB: aria_erp`** is the cluster's default/connect-back database; it is *not* one of the owned databases and is not created by the script | `docker-compose.yml` |
| 5 | **Host port `5433 → 5432`**; a `socat` sidecar `aria-erp-e2e-dbproxy` maps **`5544 → postgres:5432`**, and every `*_DATABASE_URL` in `.env.e2e` points at `localhost:5544` | `docker-compose.yml`, `apps/api/.env.e2e`, `apps/api/test/global-setup.ts` |
| 6 | **Initdb is the official mechanism**: the directory is mounted read-only at `/docker-entrypoint-initdb.d`, which the image executes **lexically** — hence the `01-` prefix | `docker-compose.yml` |
| 7 | **Migrations are never applied by initdb** — each database is brought to its schema revision by `npm run db:migrate:<owner>` | `docs/DEPLOYMENT.md`, the file's header |
| 8 | **Seed is separate** — `npm run db:seed` seeds `core_db` only and refuses under `NODE_ENV=production` | `docs/DEPLOYMENT.md` |
| 9 | **CI creates no databases.** `.github/workflows/ci.yml` explicitly skips e2e because it "needs the compose databases" | `.github/workflows/ci.yml` |
| 10 | **`app_e2e` is referenced nowhere** in the repository — not in `.env.e2e`, CI, tests or compose. It existed only inside the deleted untracked copy | full-tree search |

---

## 4. Authoritative initdb path

**Exactly one, and it is unchanged:**

```
infrastructure/postgres/initdb/01-create-databases.sql
        ↓ read-only bind mount (docker-compose.yml)
   /docker-entrypoint-initdb.d
```

Verified by resolving the compose configuration rather than by reading the YAML:

```yaml
- type: bind
  source: E:\ERP\infrastructure\postgres\initdb
  target: /docker-entrypoint-initdb.d
  read_only: true
```

**Why this one and not the other.** It is tracked by git, it is the path `docker-compose.yml`
mounts, and it is the path `docs/DEPLOYMENT.md`, `FOLDER_STRUCTURE.md` and the contract closure
all name. The root-level `initdb/01-create-databases.sql` was untracked, referenced by nothing,
**not mounted**, and — worse — unguarded: its statements were bare `CREATE DATABASE` with no
`IF NOT EXISTS`, so it would have failed on the first re-run anyway. It also created an
unreferenced `app_e2e`.

**Second copy removed, not duplicated.** The `production_db` line was *integrated* into the
authoritative file, and the root `initdb/` directory was then deleted. There is now one file, one
mount, one source of truth; `git status` shows no `initdb/` entry. No second compose-only
bootstrap architecture was created — no new mount, no new script, no new service.

---

## 5. Production database bootstrap

### 5.1 The line

Added to the authoritative file in the established `guarded + OWNER aria_user` style, between
`commerce_db` and `observability_db` (business contexts together, the optional one last):

```sql
-- Phase PRODUCTION-BOM-HEADER: the Production bounded context owns production_db,
-- its own Prisma project (prisma/production/schema.prisma) and its own migration
-- history, exactly as Commerce owns commerce_db. Required by the `combined`
-- runtime, which composes ProductionModule; `not-used` in `core`.
SELECT 'CREATE DATABASE production_db OWNER aria_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'production_db')\gexec
```

### 5.2 The mechanism repair (required, not optional)

| Before (broken) | After (working) |
| --- | --- |
| `DO $$ BEGIN IF NOT EXISTS (…) THEN CREATE DATABASE x OWNER aria_user; END IF; END $$;` | `SELECT 'CREATE DATABASE x OWNER aria_user' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'x')\gexec` |
| **Rejected** — `CREATE DATABASE cannot be executed from a function` | **Accepted** — the guard is evaluated by psql; `\gexec` issues the statement only when a row is returned |
| `ON_ERROR_STOP=1` aborted the whole file → **zero** databases created | each statement is independent; one failing cannot abort the rest |

Re-expressed this way, the file's own stated promise — *"It is idempotent: each statement is
guarded by a NOT EXISTS check, so re-running it changes nothing"* — becomes true for the first
time, and the header now documents **why** the form is what it is, so a future reader cannot
"tidy" it back into a `DO` block.

### 5.3 The ownership-contract comment

Updated in the same file, as the closure prescribed: `production_db` listed between
`commerce_db` and `observability_db`, marked **required by `combined`**, with the reason (its own
Prisma project and migration history) and the `not-used in core` note.

---

## 6. Compose changes

**One comment block. Nothing else.**

```diff
-      # GAP-ENV-1: creates the six owned databases on FIRST init of a fresh volume
-      # (official initdb mechanism). Existing volumes are untouched — create any
-      # missing database manually with the same file (see its header comment).
+      # GAP-ENV-1: creates the SEVEN owned databases on FIRST init of a fresh volume
+      # (official initdb mechanism) — core, cms, correspondence, hr, commerce,
+      # production, observability. That mounted file is the ONE authoritative
+      # bootstrap; nothing else in this repository creates databases. Existing
+      # volumes are untouched — create any missing database manually with the same
+      # file (see its header comment), which is how production_db was added to
+      # already-initialised clusters.
        - ./infrastructure/postgres/initdb:/docker-entrypoint-initdb.d:ro
```

**Deliberately unchanged:** the mount path (already authoritative), the host port `5433:5432` (no
reason — the established contract stands), `POSTGRES_USER`/`PASSWORD`/`DB` (shared-role contract,
§3 #3), the `5544` socat sidecar (the `.env.e2e` contract), the `postgres_data_pgv` volume
declaration (pre-existing migration history), and every other service.

**The compose contract no longer depends on:** untracked SQL files (the root copy is gone),
developer-local paths (the mount is repo-relative), a manually created `production_db` (now
automated), or a hidden host PostgreSQL instance (nothing outside the compose service is
consulted; the only other Postgres in the host is an unrelated `postgres:15` container that
nothing in this repository references).


---

## 7. Migration / seed boundary

The boundary is unchanged and was not encroached on:

| Layer | Responsibility | Changed here? |
| --- | --- | --- |
| **initdb** | **database creation only** — seven `CREATE DATABASE` statements; no DDL, no tables, no constraints, no extensions, no `INSERT` | added one database; repaired the guard form |
| **Prisma migrations** | schema creation/update — `npm run db:migrate:<owner>` | **no** |
| **Seed** | bootstrap/application data — `npm run db:seed` into `core_db` | **no** |

Verified:

* the authoritative file contains **zero** `CREATE TABLE` / `CREATE INDEX` / `ALTER` / `INSERT`
  and **zero** Prisma invocation;
* `production_db`'s schema still comes from exactly one source — the applied migration:
  `prisma migrate status --schema=prisma/production/schema.prisma` → *1 migration found*,
  *Database schema is up to date!*;
* no cross-database foreign key exists (PostgreSQL cannot express one; asserted by
  `production-schema.spec.ts` §E);
* **the existing `production_db` was not dropped, recreated or reset** — no `DROP DATABASE`,
  no `migrate reset`, no volume deletion ran at any point in this phase.

---

## 8. Validation

### A. Static

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` (apps/api) | **exit 0, no errors** |
| `npx jest src/health src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` | **8 suites / 127 tests, all pass** — this is the code-level proof that `productionDatabase` is `required` in `combined` and `not-used` in `core`, and that the datasource matrix and the runtime policy agree |
| `npx prisma generate` / `arch:policy` | not re-run — no datasource, owner or schema change was made |

### B. Compose

| Check | Result |
| --- | --- |
| `docker compose config` | **exit 0** |
| resolved initdb mount | `source: E:\ERP\infrastructure\postgres\initdb` → `target: /docker-entrypoint-initdb.d`, `read_only: true` |
| number of initdb mounts | **1** (no second bootstrap path) |
| host port mapping | unchanged: `5433:5432` |

`docker compose config` prints one pre-existing warning — *"`version` is obsolete"* — which
predates this phase and is unrelated to databases.

### C. Fresh-bootstrap verification (non-destructive, isolated)

An **isolated throwaway container with a throwaway volume** was used. It never touched
`aria-erp-postgres` or `erp_postgres_data_pgv`, published no ports, and was removed with its
volume afterwards (verified: no `prod-initdb-*` container or volume remains).

```
docker run -d --name prod-initdb-verify \
  -e POSTGRES_USER=aria_user -e POSTGRES_PASSWORD=aria_password -e POSTGRES_DB=aria_erp \
  --mount type=volume,source=prod-initdb-verify-vol,target=/var/lib/postgresql/data \
  --mount type=bind,source=E:/ERP/infrastructure/postgres/initdb,target=/docker-entrypoint-initdb.d,readonly \
  pgvector/pgvector:pg16
```

**Result — a fresh cluster now has all seven owned databases:**

```
aria_erp          => aria_user      (POSTGRES_DB, created by the image)
cms_db            => aria_user  ✓
commerce_db       => aria_user  ✓
core_db           => aria_user  ✓
correspondence_db => aria_user  ✓
hr_db             => aria_user  ✓
observability_db  => aria_user  ✓
production_db     => aria_user  ✓
postgres          => aria_user      (image default)
```

| Assertion | Result |
| --- | --- |
| Fresh initialization creates `production_db` automatically | **YES** |
| The other six databases still exist after the fix | **YES** (all seven + `aria_erp`) |
| `production_db` is reachable | **YES** — `production_db ok, version PostgreSQL 16.15` |
| Initdb script exits 0 (no `ON_ERROR_STOP` abort) | **YES** |
| Idempotence — the same file re-run against the populated cluster | **exit 0**, no statements emitted, database count unchanged at **9** |
| User's existing application database untouched | **YES** — `aria-erp-postgres` remained `Up 13 hours (healthy)` throughout |


### D. Runtime

| Assertion | Result |
| --- | --- |
| **Production Prisma connects** | **YES** — `npx prisma migrate status --schema=prisma/production/schema.prisma` resolves `Production database "production_db" … at localhost:5544`, *1 migration found*, **Database schema is up to date!** |
| **`production_db` exists on the live cluster, owned by `aria_user`** | **YES** — `production_db => aria_user` |
| **API starts / is running normally** | **YES** — `aria-erp-api Up 13 hours (healthy)`; `GET /api/v1/live` → `{"runtime":"combined","status":"alive"}` |
| **Commerce readiness** | **YES** — `GET /api/v1/ready` → `status: "ready"`, `commerceDatabase: true`, `requirements.commerceDatabase: "required"` |
| **Core / CMS / Correspondence / HR readiness** | all `true` in the same payload |
| **Commerce regression** | **YES** — `npx jest src/modules/commerce src/modules/production` → **57 suites / 828 tests, all pass** |
| Existing observability state unchanged | `observabilityDatabase: false` as `optional` → `optionalDegraded`, pre-existing and deliberate |

**The one honest caveat — a stale image, not a stale contract.** The live readiness payload does
not yet contain a `productionDatabase` entry, because the running `erp-api` image was built
**before** the BOM Header phase:

```
$ docker exec aria-erp-api sh -c "grep -rl productionDatabase /app/dist/health"
(no output)
$ docker exec aria-erp-api sh -c "grep -c PRODUCTION_DATABASE_URL /app/dist/config/env.validation.js"
0
```

The working tree *does* carry it (`health.contract.ts` declares the `productionDatabase` check
key, `combined-health.module.ts` composes `ProductionPrismaModule`, `env.validation.ts` declares
`PRODUCTION_DATABASE_URL`) — and the suite in §8 A proves the `combined` readiness answer
includes `productionDatabase: required`. **Rebuilding/restarting the live API container is a
deployment action against a running stack and was deliberately NOT performed here**: this phase
reconciles a bootstrap *contract*, and forcing an image rebuild would restart services that are
currently healthy. See §12 for the one remaining step.

### E. What was explicitly NOT done

No `DROP DATABASE`. No `migrate reset`. No `docker volume rm` on any project volume. No
`docker restart` of `aria-erp-postgres` or `aria-erp-api`. No `docker compose down`. The live
stack reported `Up 13 hours (healthy)` for every service both before and after validation.

---

## 9. Documentation changes

Updated so the documentation matches the now-true reality — and only where it was factually
wrong.

| File | Change |
| --- | --- |
| `docs/DEPLOYMENT.md` | "**Six** databases" → "**Seven** databases"; added the `production_db` row (`Production (BOM)`, required, `npm run db:migrate:production`) |
| `FOLDER_STRUCTURE.md` | "# **Six** owned databases, first-init only" → "# **Seven** owned databases, first-init only" |
| `ARCHITECTURE.md` | "(**six** databases, one per owner)" → "(**seven** databases, one per owner)" |
| `docker-compose.yml` | the initdb comment now says seven, names them, and states that the mounted file is the ONE authoritative bootstrap (§6) |
| `infrastructure/postgres/initdb/01-create-databases.sql` | ownership contract now lists `production_db`; header documents the `DO`-block failure and why `\gexec` is used (§5) |
| `docs/PHASE-PRODUCTION-BOM-HEADER-IMPLEMENTATION.md` | §3.5 file-inventory row and §19.1 item 6 corrected: the previous phase wrote to the wrong path; the line now lives in the authoritative file and the competing copy was removed |
| `docs/PHASE-PRODUCTION-BOM-PRODUCT-TREE-CODE-DECISION.md` | Appendix D adjacent observations 1 and 2 now carry an explicit **→ RESOLVED** pointer to this document |

**Not rewritten:** `docs/PHASE-GAP-ENV-1-IMPLEMENTATION.md` (it says the file "creates the six
owned databases" — a historical statement about what that phase built, accurate as a record), and
`docs/PHASE-PRODUCTION-BOM-CONTRACT-CLOSURE.md` §10 item 10 (the prescription this phase
executed). Historical phase reports describe the state at their own time; only references that
are wrong *today* were touched.

### What the deployment documentation now states

| Question | Answer as now documented |
| --- | --- |
| **Does `production_db` exist?** | Yes — listed in `docs/DEPLOYMENT.md`'s database table and in the initdb ownership contract |
| **Who creates it?** | The initdb script, via the compose mount — `CREATE DATABASE production_db OWNER aria_user`, guarded by `NOT EXISTS` |
| **When is it created?** | Automatically on **first** init of a fresh postgres volume; on an existing volume the same file is run once manually (its idempotence now makes that instruction true) |
| **Who owns schema migrations?** | `npm run db:migrate:production` (Prisma), never initdb |
| **Is seed data required?** | No — `npm run db:seed` seeds `core_db` only and refuses under `NODE_ENV=production`; Production ships with no seed |
| **Does fresh compose initialization create it automatically?** | **Yes** — proven on an isolated volume (§8 C) |


---

## 10. Git / worktree state

**HEAD before: `840226b` (`master`) — HEAD after: `840226b` (`master`).** No commit, no `git add`,
no `reset`, no `clean`, no `amend`, no `rebase`, no history rewrite. Everything below is an
unstaged working-tree change left for review.

**Changed by this phase:**

| File | State | Change |
| --- | --- | --- |
| `infrastructure/postgres/initdb/01-create-databases.sql` | `M` (tracked) | added `production_db`; repaired the guard mechanism; documented the repair; updated the ownership contract |
| `docker-compose.yml` | `M` (tracked) | initdb comment only (§6) |
| `docs/DEPLOYMENT.md` | `M` (tracked) | six → seven + `production_db` row |
| `FOLDER_STRUCTURE.md` | `M` (tracked) | six → seven |
| `ARCHITECTURE.md` | `M` (tracked) | six → seven |
| `docs/PHASE-PRODUCTION-BOM-HEADER-IMPLEMENTATION.md` | untracked (annotated) | two factually-wrong references corrected |
| `docs/PHASE-PRODUCTION-BOM-PRODUCT-TREE-CODE-DECISION.md` | untracked (annotated) | two `→ RESOLVED` pointers |
| `docs/PHASE-PRODUCTION-DATABASE-DEPLOYMENT-RECONCILIATION.md` | **NEW** | this document |

**Removed:** `initdb/01-create-databases.sql` (untracked, unmounted, unguarded) — the competing
copy. `git status` shows no `initdb/` entry.

**Not committed / not present:** local `.env` files (still git-ignored), credentials, database
dumps, generated artifacts introduced by this phase, and temporary test volumes — every temp file
this phase created (`.tmp-compose-config.txt`, `.tmp-compose-warn.txt`, `.tmp-cfg.txt`,
`.tmp-fresh-bootstrap.cmd`, `.tmp-fresh-bootstrap.ps1`, `.tmp-fresh-databases.txt`,
`.tmp-fresh-owners.txt`, `.tmp-fresh-initdb.log`, `apps/api/.tmp-jest.log`) was deleted, and
`Get-ChildItem -Filter '.tmp-*'` returns none.

**Pre-existing working-tree changes carried over** (untouched by this phase): the BOM Header
phase's `apps/api/**` wiring, `apps/api/prisma/production/`, the four Production Core migrations,
`apps/api/src/modules/production/`, and the unrelated untracked `backups/`, `apps/web/phaseui*`
and `apps/web/next-env.d.ts` entries.

**Containers / volumes:** the throwaway `prod-initdb-verify` container and
`prod-initdb-verify-vol` volume were both removed (verified). `erp_postgres_data_pgv` and
`erp_postgres_data` were never touched.

---

## 11. Non-goals

1. **No BOM Item.** Not created, not sketched, not migrated.
2. **No Product Tree.** No model, table, node, hierarchy, CRUD or code generation.
3. **No code generation / `standardPartCode`.** I-1 remains blocked; this phase does not touch it.
4. **No change to BOM Header business behaviour** — no route, DTO, service, repository, status
   rule, permission, entitlement row or test assertion was altered.
5. **No Procurement/Commerce change** — `src/modules/commerce/**` is untouched.
6. **No invented Project or Product Tree contract.**
7. **No new health endpoint, no new datasource, no new runtime, no new migration, no new seed.**
8. **No drop/recreate of the existing `production_db`**; no `DROP DATABASE`, no `migrate reset`,
   no volume deletion.
9. **No image rebuild or stack restart** — the live deployment was observed, not touched.
10. **No commit, no history rewrite, no `git clean`.**

---

## 12. Final status

**CLOSED.** All ten success criteria:

| # | Criterion | Status |
| ---: | --- | --- |
| 1 | `docker-compose` uses one authoritative initdb path | **PASS** — one bind mount, resolved by `docker compose config`; the competing root copy is deleted |
| 2 | Fresh PostgreSQL bootstrap creates `production_db` automatically | **PASS** — proven on an isolated throwaway volume: all seven databases created, `production_db` present and reachable |
| 3 | Existing databases remain unchanged | **PASS** — live cluster still holds all seven owned databases; no drop/reset/volume deletion; `aria-erp-postgres` stayed `Up 13 hours (healthy)` |
| 4 | Production Prisma connects successfully | **PASS** — `prisma migrate status` on `production_db` → *up to date* |
| 5 | Production readiness remains healthy | **PASS at code level** — 127 health/architecture/policy tests green; **the live API image predates the Production phase** and will report `productionDatabase` only after a rebuild (§8 D) |
| 6 | No manual database creation required | **PASS** — a fresh volume needs none |
| 7 | Prisma migrations remain responsible for schema | **PASS** — §7 |
| 8 | Seed remains responsible for bootstrap data | **PASS** — §7 |
| 9 | Documentation matches reality | **PASS** — §9 |
| 10 | No BOM business semantics changed | **PASS** — §11 |

### Residual deployment issue — one, and it is not a contract issue

**The running `erp-api` container is a stale image.** It was built before the BOM Header phase, so
its `/app/dist/health` has no `productionDatabase` check and its `env.validation.js` has no
`PRODUCTION_DATABASE_URL`. Consequences:

* `GET /api/v1/ready` on the live stack does not yet report `productionDatabase` (it reports
  everything else as `ready`);
* the container therefore does not open a `production_db` connection.

**Fix, when the operator is ready:** rebuild and roll the API service —
`docker compose build api && docker compose up -d api`. That is a deployment action against a
healthy running stack and was out of scope for a bootstrap-contract reconciliation.

**Everything else is green.** The fix this phase was asked for is complete: a fresh Postgres
volume initialised through `docker-compose.yml` now produces all seven databases, including
`production_db`, with no manual step — and, for the first time since GAP-ENV-1, the initdb file
actually does what every document in the repository already claimed it did.

**Next step on the main path:** back to **I-1** — either an authoritative Product Tree Code
source/format (§15 of `PHASE-PRODUCTION-BOM-PRODUCT-TREE-CODE-DECISION.md`, options 1a/1b/1c), or
an explicit acceptance that `standardPartCode` is out of scope for V1. Engineering must not
choose between them.

| 11 | **Nothing else in the repository creates databases** | full-tree search for `CREATE DATABASE` |
