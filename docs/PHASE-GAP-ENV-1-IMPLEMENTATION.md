# PHASE GAP-ENV-1 — DEPLOYMENT CONTRACT IMPLEMENTATION

Status: implementation report. Companion to `docs/PHASE-GAP-ENV-PREFLIGHT.md`
(29 findings: 18×A, 3×B, 4×C, 2×D, 2×E). No business logic, DTO, schema or
workflow change was made.

## Scope

Deployment/runtime contract only: entry point, image/artifact freshness, nginx,
observability configuration, environment contract, mail naming, CORS failure
semantics, healthchecks, web build inputs, e2e bootstrap, seed guard, database
bootstrap prerequisites, e2e dbproxy, documentation alignment, minimal CI.

## Worktree checkpoint

The pre-flight 130-entry worktree (completed C1R–C9 backend + Commerce admin UI +
phase docs) was committed before any deployment file was touched:

- `7ee3584` `feat(commerce): land C1R-C9 backend surfaces and migrations`
- `bb6380d` `feat(web): add commerce admin UI and shared api client`
- `f1091cb` `docs: record C2-C9, GAP-8/9, UI phase contracts and GAP-ENV preflight`

Remaining untracked entries are QA screenshots/scripts (`apps/web/phaseui*`),
`apps/web/next-env.d.ts`, `apps/web/tsconfig.tsbuildinfo`, `backups/`, `secrets/`
— left untracked deliberately.

## Authoritative runtime entry point

`dist/main.js` (AppModule / combined runtime) — the only root registering
CommerceModule, HrModule, CorrespondenceModule. Aligned everywhere:

- `docker-compose.yml` `api.command` → `exec node dist/main.js` (was core-main)
- `Dockerfile.backend` CMD `dist/main.js` + comment corrected
- `npm run start:prod` → `node dist/main` (unchanged, already correct)
- `Dockerfile.core` retains `dist/core-main.js` as the separate Core-only image

## Image/artifact contract

`npm run docker:up` → `docker-compose up -d --build`: compose deployments rebuild
from the current tree instead of silently reusing a stale image. Fresh `erp-api`
and `erp-web` images built and verified (see Validation ledger).

## Reverse proxy contract

Compose now mounts `infrastructure/nginx/` (the authoritative tree). The stock
`nginx/` placeholder was deleted. `api.conf` was corrected: `/health` proxies to
`/api/v1/health` (was `api/health` → 404); edge CORS wildcard headers and the
OPTIONS short-circuit removed (API owns CORS); the Swagger block removed (Swagger
is `/api/v1/docs` and disabled unless `ENABLE_SWAGGER`). `frontend.conf` gained
`/api/`, `= /health`, `= /.well-known/jwks.json` on the default `localhost`
server. Port 443 is no longer published — there is no TLS server in this repo;
TLS termination is external (documented in `docs/DEPLOYMENT.md`).

## Observability contract

- `OBSERVABILITY_ENABLED` in compose → `"false"` (documented default). The
  combined image prunes `observability-client` and ships no `prisma/observability`
  schema, so `true` could never persist — it only produced an error loop.
- `observability-prisma.service.ts` fallback is now a DEEP no-op: any
  `client.<model>.<method>(...)` chain resolves instead of throwing
  `is not a function`. Enabling persistence requires an image that ships the
  observability schema + client plus `observability_db` — an explicit contract.

## Environment contract

Documented file-per-consumer table in `docs/DEPLOYMENT.md` and in
`apps/api/.env.example` header:

- `apps/api/.env` — Prisma CLI + generated clients (host tooling)
- `apps/api/.env.local` — NestJS runtime on host
- `apps/api/.env.e2e` — Jest e2e (tracked)
- root `.env` — compose `${VAR}` interpolation
- `apps/web/.env.local` — Next dev/build on host (new `apps/web/.env.example`)

Fixed: duplicated `CORS_ORIGINS` in `.env.example`; `AI_CONFIG_ENCRYPTION_KEY`
now interpolated by compose; `secrets/` added to `.gitignore`.

## Mail contract

Canonical names = `EmailService` readers: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASS`, `EMAIL_FROM`. `.env.example` and compose updated; `MAIL_*`,
`SMTP_PASSWORD`, `SMTP_FROM` spellings removed.

## CORS behavior

`buildCorsOrigin` now passes `ForbiddenException` through the CORS callback, so a
denied origin answers 403 through the exception filter instead of an unhandled
500. Allow-list, credentials and no-Origin pass-through unchanged. Spec asserts
`HttpException` + `403`.

## Healthchecks

Compose healthchecks added: `api` → `GET /api/v1/ready`; `web` → `/`;
`nginx` → `/health` (→ `api/v1/health`); `mailpit` → real HTTP check (was
`exit 0`). `web` waits for `api` healthy; `nginx` waits for both.

## Web build/runtime contract

`Dockerfile.frontend` declares `ARG NEXT_PUBLIC_API_URL` /
`NEXT_PUBLIC_APP_URL` with `ENV` pass-through in the builder stage; compose
supplies them under `web.build.args`. The inert container-level
`NEXT_PUBLIC_API_URL` env was removed. Format documented: must end with `/api`.
Root `.env.example` and `FOLDER_STRUCTURE.md` corrected to
`http://localhost:3001/api`; new `apps/web/.env.example` created.

## E2E bootstrap

`apps/api/jest-e2e.json` now declares `globalSetup`/`globalTeardown`.
`test/global-setup.ts` provisions via `npm run db:migrate` (all six owners) +
`npm run db:seed` instead of a bare `prisma migrate deploy` that silently
targeted the deprecated root project. The duplicate `test/jest-e2e.json` was
repaired (rootDir-relative paths) so `--config test/jest-e2e.json` also works.

## Seed guard

`prisma/seed.ts` refuses `NODE_ENV=production` with a clear error — the seed is
development/test only; there is no supported production seed path.

## Database/bootstrap prerequisites

`infrastructure/postgres/initdb/01-create-databases.sql` creates the six owned
databases on first cluster init (official initdb mechanism, idempotent guards).
On existing volumes the same file can be run manually — documented in
`docs/DEPLOYMENT.md`.

## DBProxy contract

`e2e-dbproxy` (`alpine/socat`, `5544 → postgres:5432`) is now a declared compose
service, matching the `localhost:5544` URLs in `.env.e2e`. Start it only when
running host tooling/e2e: `docker compose up -d postgres e2e-dbproxy`.

## Documentation alignment

- README: env-copy instructions (`.env` + `.env.local`), API-docs URL
  (`/api/v1/docs`, `ENABLE_SWAGGER`), Postgres port 5433, real project structure,
  docs links only to existing files, CI claim now real.
- ARCHITECTURE: `scripts/`/`docker/` root dirs removed; CI/CD section describes
  the actual workflow; Kubernetes claims replaced with the real compose contract.
- FOLDER_STRUCTURE: nonexistent `k8s/`/`terraform/`/`scripts/`/`CODEOWNERS`
  entries removed; `NEXT_PUBLIC_API_URL` format fixed; ports corrected to 5433.
- COMPREHENSIVE_PHASE_A_REPORT: `/api/v1/health/live|ready` → `/api/v1/live|ready`.

## CI contract

`.github/workflows/ci.yml` — two jobs: API (install → prisma generate →
`tsc --noEmit` → env/architecture/policy suites → Commerce unit regressions →
`nest build`) and web (install → `tsc --noEmit` → jest → `next build` with
explicit `NEXT_PUBLIC_API_URL`). Checks only; no e2e (needs compose DBs), no
deploy.

## Validation ledger

| Check | Result |
|---|---|
| `tsc --noEmit` (api) | pass |
| `tsc --noEmit` (web `type-check`) | pass |
| `docker compose config` | valid; resolves `exec node dist/main.js` |
| `docker compose build api` | fresh `erp-api:latest`; dist contains `commerce/completion`, `commerce/search`, `commerce/pending`, `platform/search-source`; `observability-client` pruned per policy |
| `docker compose build web` | fresh `erp-web:latest`; bundle inlines `http://localhost:3001/api` (build ARG wins over `.env.local`) |
| `docker compose up -d` | all services recreated; api/web/nginx/mailpit healthy |
| API `Config.Cmd` | `exec node dist/main.js` (verified via `docker inspect`) |
| `/api/v1/ready` | 200, `runtime: combined`, all required datasources ok |
| `/api/v1/commerce/completion-policies` | 401 (route exists — was 404 on the stale image) |
| `/api/v1/commerce/purchase-documents`, `/api/v1/hr/employees`, `/api/v1/correspondence/letters` | 401 (auth-guarded, present) |
| `/.well-known/jwks.json` | 200 |
| CORS allowed origin preflight | 204 + `Access-Control-Allow-Origin` |
| CORS denied origin | **403** (was 500) |
| nginx `:80` | `/health` 200, `/api/v1/health` 200, `/` 200, `/admin/commerce` 200, JWKS 200 |
| Observability logs | zero `is not a function`; single `writer disabled` line |
| Mail | container carries `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `EMAIL_FROM`; `mailpit:8025` reachable from api |
| e2e-dbproxy | declared service; `localhost:5544` → `core_db` verified |
| e2e globalSetup | wired; runs all-owner `db:migrate` + `db:seed`; seed-conformance 6/6, commerce-tenant 26/26 |
| Contract suites | env.validation 17/17, architecture 24/24, runtime-policy 32/32, commerce-isolation 34/34 |

## Known residual limitations

- `.env` / `.env.local` on this machine point at the e2e proxy port (5544); a
  developer must keep them consistent with whichever cluster they target.
- `apps/api/.env` is still machine-local; the contract is documented, not
  enforced.
- CI does not run e2e or container builds.
- `observability_db` remains optional; enabled-persistence requires a
  deliberately different image.

## Final GAP-ENV-1 status

**CLOSED** — commit `7b32d56`. Every A-class finding has a source fix or an
explicit documented contract; both B-class drifts were rebuilt/recreated and
verified live; the C-class prerequisites are documented in
`docs/DEPLOYMENT.md` with the initdb and dbproxy mechanisms now committed.
