# Deployment Guide

This document is the authoritative deployment/runtime contract for the Aria ERP
compose stack (GAP-ENV-1). It describes only what exists in the repository.

## Services

`docker-compose.yml` defines: `postgres` (pgvector/pgvector:pg16, host `:5433`),
`redis`, `rabbitmq`, `minio`, `mailpit`, `api` (`:3001`), `web` (`:3000`),
`nginx` (`:80`), and `e2e-dbproxy` (`:5544`, socat → postgres, for host-side
tooling and e2e).

## Authoritative entry point

The `api` service runs the **combined** runtime: `node dist/main.js`
(AppModule). This is the only composition root that registers CommerceModule,
HrModule and CorrespondenceModule. The image default (`Dockerfile.backend`) and
the compose `command` agree on it.

`dist/core-main.js` (CoreAppModule) is a **separate** deployment contract served
by `infrastructure/docker/Dockerfile.core`. It cannot serve any Commerce/HR/
Correspondence route and must never be substituted into the `api` service.

## Build → artifact → runtime

- `docker compose build api` (or `npm run docker:up`, which now passes `--build`)
  always rebuilds the image from the current tree. Do not run stale local images;
  the compose contract is build-from-source.
- `Dockerfile.backend` runs `npm run build --workspace=apps/api`, which generates
  all six Prisma clients, compiles `dist/`, and prunes `observability-client`
  (the combined runtime marks observability `optional`).
- `Dockerfile.frontend` inlines `NEXT_PUBLIC_*` at build time via ARGs
  (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`). Compose supplies them through
  `web.build.args`; container environment cannot change a built bundle.

## Databases

Seven databases on the single postgres service, all owned by `aria_user`:

| Database | Owner | Required by `combined` | Migration |
|---|---|---|---|
| `core_db` | Core | yes | `npm run db:migrate:core` |
| `cms_db` | CMS | yes | `npm run db:migrate:cms` |
| `correspondence_db` | Correspondence | yes | `npm run db:migrate:correspondence` |
| `hr_db` | HR | yes | `npm run db:migrate:hr` |
| `commerce_db` | Commerce | yes | `npm run db:migrate:commerce` |
| `production_db` | Production (BOM) | yes | `npm run db:migrate:production` |
| `observability_db` | Observability | optional | `npm run db:migrate:observability` |

Creation: `infrastructure/postgres/initdb/01-create-databases.sql` is mounted at
`/docker-entrypoint-initdb.d` and runs automatically on first init of a **fresh**
volume. On an existing volume it does not run — execute it manually once:

```bash
docker exec -i aria-erp-postgres psql -U aria_user -d aria_erp \
  -f /docker-entrypoint-initdb.d/01-create-databases.sql
```

Migrations are a dedicated deployment step, never container startup. Order:
`db:migrate` runs core → cms → observability → correspondence → hr → commerce;
for deployments prefer the per-owner `db:migrate:*` commands. Host-side Prisma
commands read `apps/api/.env` (which should point at `localhost:5544` when using
the e2e dbproxy, or `localhost:5433` for the published compose port — pick one
and keep it consistent).

## Secrets

JWT signing material comes from `./secrets/` mounted as Docker secrets at
`/run/secrets/` (`JWT_SIGNING_KEYS`, `JWT_ACTIVE_KEY_ID`). Generate outside git —
`secrets/` is gitignored. See `docs/reports/PHASE_52-ARCH-3C-R1_ACTIVATION.md`
for the rotation procedure. `docker-compose.yml` interpolates `OPENAI_API_KEY`
and `AI_CONFIG_ENCRYPTION_KEY` from the host environment or the root `.env`
(gitignored) — never from tracked files.

## Environment files — who reads what

| File | Consumer | Tracked? |
|---|---|---|
| `apps/api/.env` | Prisma CLI + generated Prisma clients | no |
| `apps/api/.env.local` | NestJS app on the host (`ConfigModule`) | no |
| `apps/api/.env.e2e` | Jest e2e harness | yes (test values only) |
| `apps/api/.env.example` | template for `.env` and `.env.local` | yes |
| `apps/web/.env.example` → `.env.local` | Next.js dev/build on host | template yes / local no |
| root `.env` | compose `${VAR}` interpolation | no |

In containers no env file exists; every variable arrives from the compose
`environment:` block or Docker secrets.

## Mail

The code reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`.
Compose sets `SMTP_HOST=mailpit`, `SMTP_PORT=1025`, `EMAIL_FROM`; auth is omitted
because Mailpit accepts anonymous submission. The `MAIL_*`/`SMTP_PASSWORD`
spellings are not read anywhere.

## Observability

`OBSERVABILITY_ENABLED=false` in compose: the combined image prunes
`observability-client` and does not ship `prisma/observability`, so `true` would
configure persistence that cannot exist. Disabled mode is a real no-op (pino
stdout logging is unaffected, `/ready` reports `observabilityDatabase` as
`optionalDegraded`). To enable: create `observability_db`, ship an image that
carries the observability schema + client, set `OBSERVABILITY_ENABLED=true`.

## Edge / TLS

`nginx` mounts `infrastructure/nginx/` and serves port **80** only, proxying
`/` → web, `/api/` and `/.well-known/jwks.json` → api, `/health` →
`api/v1/health`. CORS is owned by the API (the edge adds no `Access-Control-*`
headers). **TLS is terminated externally** — publish 443 from a load balancer /
ingress in front of this stack; this compose contract does not manage
certificates.

## Healthchecks

`api` healthchecks `GET /api/v1/ready` (returns 200 only when every required
datasource answers); `web` healthchecks `/`; `nginx` healthchecks `/health`.
`web` waits for `api` healthy; `nginx` waits for both healthy.

## E2E bootstrap

`npm run test:e2e --workspace=apps/api` uses `apps/api/jest-e2e.json`, which wires
`test/global-setup.ts` (loads `.env.e2e`, waits for postgres on the published
port, runs `db:migrate` for all six owners, then `db:seed`) and
`test/global-teardown.ts`. Host-side access to the compose postgres is via the
`e2e-dbproxy` service on `localhost:5544`:

```bash
docker compose up -d postgres e2e-dbproxy
npm run test:e2e --workspace=apps/api
```

## Seed

`npm run db:seed` seeds `core_db` (roles, permissions, bootstrap tenant
`tenant-test-1`, super-admin `admin@localhost`). It is a development/test tool
and **refuses to run under `NODE_ENV=production`**. There is no production seed
path; provision production administrators through the platform.

## CI

`.github/workflows/ci.yml` runs: dependency install, Prisma client generation,
API type-check, web type-check, the architecture/runtime-policy/env-validation
contract suites, Commerce unit regressions, and API + web builds. It does not
run e2e (no database services in CI yet) and does not deploy.
