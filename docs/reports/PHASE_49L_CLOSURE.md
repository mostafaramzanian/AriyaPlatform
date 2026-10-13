# PHASE 49L — CORE AUTOMATION & INTEGRATION PLATFORM

**PHASE: 49L**
**STATUS: GREEN**

Provider-neutral integration layer with n8n as its first adapter. Aria emits versioned,
minimised, HMAC-signed domain events to a configured automation engine and accepts signed
callbacks back; the engine owns the workflow graph and nothing else. Verified against
PostgreSQL 16 / core_db with the real Core process, a real HTTP peer and a real browser.

Closure evidence was produced on this machine on 2026-09-04. Every figure below was
observed in a captured command output; where something was **not** verified it says so.

---

## 1. AUDIT

Read-only audit performed before any code was written (§2). What already existed:

**Existing integration architecture — none.** `grep` for `webhook` across the repository
found only marketing copy (`apps/web/src/app/(marketing)/integrations/page.tsx`,
`architecture/page.tsx`) and aspirational lines in `ARCHITECTURE.md` /
`CMS_FOUNDATION_SUMMARY.md`. No outbound HTTP integration, no callback route, no adapter,
no provider abstraction. `axios` is in `apps/api/package.json` but **nothing under
`apps/api/src` imports it** (verified by search) — so the outbound transport decision was
open, and `fetch` was chosen to match `OpenAIProvider` and `HealthService`.

**Existing event architecture — RabbitMQ, and deliberately not reused.**
`NotificationPublisher` publishes to a `domain_events` topic exchange, and
`AuditService.publishAuditEvent` feeds it. It was inspected and rejected as the outbound
contract for three reasons that are properties of the code:

1. **No envelope.** `publishAuditEvent` spreads the whole `AuditOptions` — including
   `oldValue`/`newValue`, i.e. full before/after records. Redaction happens on the way into
   `AuditLog`, not on the way onto the exchange. That is the opposite of §11.
2. **No version field**, so a consumer cannot distinguish `ticket.created` v1 from v2 (§7).
3. **No execution identity.** `publish` swallows every failure and returns `void`, so
   nothing can report ACCEPTED/FAILED per destination (§19).

The RabbitMQ path is **untouched**. 49L is an additional, narrower contract.

**Existing security.** `JwtAuthGuard` (passport-jwt) + `RolesGuard` reading `roles`
metadata; `@Public()` for health/auth. `CryptoService` (49J-0) provides AES-256-GCM under
`AI_CONFIG_ENCRYPTION_KEY` and a constant-time `matches`. **No mTLS anywhere** — no client
certificate, no CA, no `https.Agent` with `cert`, nothing in `nginx/` requesting one. The
closest service-to-service precedent is MinIO's AWS SigV4, i.e. HMAC over a canonical
request, which is the model 49L follows (§16).

**Existing retry / idempotency.** Two bounded `setInterval` pollers:
`AuditDispatcherService` (30 s, `take: 50`, backoff `min(300000, (attempts+1)*60000)`) and
`ReminderDispatcherService` (49I: 30 s, `take: 100`, claim by conditional `updateMany`,
`unref()`ed timer). Idempotency precedent: `Message_conversationId_senderId_clientMessageId_key`
— a unique index, not a read-then-write check. 49L reuses both patterns exactly.
`@nestjs/schedule` and `cron` are **absent** from `apps/api/package.json` (verified).

**Correlation.** `RequestContextMiddleware` mints `requestId` + `correlationId` per request
into `AsyncLocalStorage`; `TenantContextInterceptor` adds `userId`/`tenantId`. 49L reads
the same context rather than inventing an identifier.

---

## 2. ARCHITECTURE

| Piece | File | Role |
| --- | --- | --- |
| Contract | `integration.contract.ts` | Envelope, event types, versions, adapter interface. Mentions no engine, no URL, no header, no signature. |
| Gateway/service | `integration.service.ts` | Config CRUD, dispatch, execution tracking, bounded retry, callback application, connection test. |
| Emit façade | `automation.service.ts` | The **only** export of `IntegrationsModule`. Two methods. |
| Registry | `integration-provider.registry.ts` | `IntegrationKey` → adapter. One key, one class. |
| n8n adapter | `n8n-integration.provider.ts` | The **only** file that knows n8n exists. |
| Signing | `integration-signature.ts` | HMAC-SHA256 over a length-prefixed canonical string. |
| SSRF policy | `integration-url.guard.ts` | Scheme, credentials, private/loopback, metadata, own-infrastructure. |
| Admin HTTP | `integration.controller.ts` | JWT + `@Roles` on every route. |
| Callback HTTP | `integration-callback.controller.ts` | `@Public()`, HMAC-authenticated. |
| Retry timer | `automation-retry.service.ts` | 30 s `setInterval`, unref'd, non-overlapping. |

**Provider neutrality is structural, not a convention.** `AutomationService` and
`IntegrationService` import the registry and the contract types; neither imports
`N8nIntegrationProvider`. Adding a second engine is: write an adapter, add an enum member,
add one `case`, add one descriptor. No business module changes, because no business module
can see any of it.

**`IntegrationsModule` exports `AutomationService` and NOT `IntegrationService`.** That
asymmetry is the §3 contract made enforceable: `SupportModule` imports the module and can
emit, and cannot reach configuration, secrets, the provider registry or the retry pass even
by accident.

**n8n is not mandatory.** With no row, a disabled row, an unreachable engine, a missing
secret or an undecryptable one, `emit` returns a result object and the business operation
completes. Proven three ways: unit (`trigger` SKIPPED/FAILED paths), integration E2E
(check 33: engine killed, trigger still `202`), browser (empty state reads
«آریا بدون آن کامل کار می‌کند»).

### 2.1 Event contract

`INTEGRATION_EVENT_TYPES` has exactly three members, each backed by a state change that
already happens in this repository:

| Event | Version | Emitted from | Payload |
| --- | --- | --- | --- |
| `ticket.created` | 1 | `SupportService.createTicket`, after `$transaction` commits | `ticketId, trackingNumber, type, priority, status` |
| `ticket.updated` | 1 | `SupportService.updateTicket` | `ticketId, status, priority, changedFields` |
| `ticket.resolved` | 1 | `SupportService.changeStatus` reaching `RESOLVED` only | `ticketId, trackingNumber, priority, status` |

**Six event types from the prompt's examples are deliberately absent**, and the reason is
per-event rather than blanket:

- `notification.created` — `NotificationService.createForUser` *is* the delivery mechanism;
  emitting for it invites a loop where an automation creates a notification that emits an
  event that creates a notification.
- `message.sent` — `MessagingService` fans out over WebSocket at chat frequency; one
  outbound HTTP call per message is exactly the per-row fan-out §44 forbids.
- `calendar.reminder.due` — `ReminderDispatcherService` claims rows with a conditional
  UPDATE that makes delivery exactly-once; putting a network round-trip inside that window
  would break the property.
- `survey.published`, `user.created`, `user.updated` — no consumer exists; §6 forbids
  inventing events nothing listens to.

**`CLOSED` is silent too.** Closure follows resolution, so a workflow needing both would
fire twice for one logical outcome.

**Event ids are derived, not random**, so retries at the business layer cannot duplicate
deliveries: `ticket.created:<id>`, `ticket.resolved:<id>`, and
`ticket.updated:<id>:<updatedAt ms>` — the timestamp discriminates two genuinely different
updates to one ticket, which a fixed id would collapse into a dropped duplicate.

### 2.2 Module contract (§33/§34)

The seam is `TriggerAutomationInput` + `AutomationDispatchResult`. A module supplies an
event type, a source, a minimised payload and optionally a stable id; it receives a
normalized outcome with no HTTP status, no response body and no header. Nothing in either
type names a destination, so a Local module and a Remote module are the same shape from
Core's side — the difference is one `IntegrationConfig` row.

**Core knows no module's schema.** The support payload is five scalars picked by
`SupportService` itself; `IntegrationService` never reads a `Ticket`.

**No module federation, no generic event bus** (§35): `AutomationService.emit` is an
explicit call, and there is no subscriber registry, no topic router and no in-process bus.

---

## 3. CONFIGURATION

**Core Settings, not env.** `IntegrationConfig` holds `baseUrl`, `webhookPath`, `enabled`,
`timeoutMs`, `maxAttempts` and the encrypted secret; it is managed at
`/admin/integrations`. There is deliberately **no `N8N_BASE_URL` and no
`N8N_WEBHOOK_SECRET`** anywhere: an operator must be able to repoint, rotate and disable
without a redeploy, and §15 forbids one credential living in both env and the database.

**One env var, and it is a policy rather than a credential.**
`INTEGRATION_ALLOW_PRIVATE_TARGETS` (default **false**) permits private/loopback targets.
It is a property of the network the process runs in, is read on **every** dispatch rather
than cached at boot, and is documented in `apps/api/.env.example` (+26 lines) and set to
`"true"` for the compose `api` service only, with the reason stated inline.

**One secret store.** The webhook secret uses the same `CryptoService`, the same
AES-256-GCM envelope shape and the same `AI_CONFIG_ENCRYPTION_KEY` as 49J-0 credentials. No
second key, no second table, no plaintext column.

**Rotation is one-way.** `POST /admin/integrations/:id/secret` generates 32 random bytes
(`randomBytes`, 64 hex chars), stores the envelope and returns the value **once**. No route
returns a stored secret; the single projection has no branch that could.

**Connection test** posts a fixed server-side probe event and records `SUCCESS`/`FAILURE` +
`lastTestedAt` on the config row. It writes **no** execution row — a test is not a domain
event, and recording one would pollute the delivery history §19 exists to keep meaningful.

---

## 4. SECURITY

### 4.1 Service-to-service authentication (§16)

**HMAC-SHA256 over a length-prefixed canonical string**, with the shared secret encrypted
at rest through 49J-0's `CryptoService`. mTLS was rejected because nothing in the repository
does it and adding it means adding certificate issuance and rotation infrastructure for one
integration (§1 forbids that creep). A JWT was rejected because a user token is the wrong
credential for a machine.

Canonical string, in fixed order, each field emitted as `<byteLength>:<value>` joined by
`\n`: method, path, timestamp, eventId, idempotencyKey, keyed body digest.

**The length prefix is load-bearing, and it is tested by attack rather than by shape.**
With a plain `join(':')`, `eventId="a:b" + key="c"` and `eventId="a" + key="b:c"` render
identically, so one signature would authenticate two different requests. The spec
constructs exactly that pair and asserts the signatures differ.

Headers: `x-aria-signature`, `x-aria-timestamp`, `x-aria-event-id`, `x-aria-integration`,
`x-aria-idempotency-key`.

### 4.2 Replay protection (§17)

- **±5 minutes, symmetric.** A one-sided window would reject a caller whose clock is a
  minute fast — the common case with container clock drift — while a future-dated request
  would stay replayable for as long as it is dated ahead.
- **Timestamp is checked BEFORE the HMAC**, so a flood of stale requests costs no
  computation.
- **A replayed callback inside the window** finds the execution already terminal and
  receives the existing outcome with `duplicate: true` (§18: "return existing outcome
  safely"). It re-runs nothing.
- **Concurrent callbacks** are resolved by a conditional `updateMany` whose predicate
  excludes terminal states; the loser matches zero rows and reads the winner's outcome.
- **A conflicting replay cannot flip an outcome**: a COMPLETED row presented with
  `status: FAILED` stays COMPLETED (§26 "duplicate with incompatible payload").

### 4.3 Idempotency (§18)

`idempotencyKey = <integration>:<eventId>:v<version>`, **materialised into a UNIQUE INDEX**
rather than checked by a read. Two concurrent triggers for one event would both pass a
`findFirst`; here the second gets P2002 and returns the existing row. Integration E2E check
23 proves the observable consequence: a repeated trigger produced **no second delivery**
(engine delivery count 2 → 2).

The key is scoped by integration (one event fanning out to two targets is two deliveries)
and by version (a v2 payload is not deduplicated against v1).

### 4.4 Tenant isolation (§9)

`AutomationExecution.tenantId` is a snapshot of the triggering context. Every read applies
`where: { tenantId }` **unconditionally, including when it is null** — a null tenant is its
own bucket, and omitting the predicate would widen the query to every tenant-less execution
in the database. Asserted directly in `integration.service.spec.ts` for both the non-null
and the null case.

There is **no cross-tenant view for any role**. §9 forbids inventing a "platform admin sees
all tenant-less events" rule absent an existing policy, and none exists.

`IntegrationConfig` has **no** `tenantId`, matching `AIProviderConfig`: the endpoint and
secret are operator infrastructure, and a per-tenant column would imply tenants may
register their own outbound destinations.

### 4.5 RBAC (§28)

Two permissions, seeded and granted by
`20260904120500_seed_integration_permission_grants`, verified in the database:

| Role | `admin.integrations.read` | `admin.integrations.manage` |
| --- | --- | --- |
| SUPER_ADMIN | ✅ | ✅ |
| ADMIN | ✅ | ✅ |
| OPERATIONS_ADMIN | ✅ | ❌ |
| SECURITY_ADMIN / PARTNER / CUSTOMER / EMPLOYEE / VISITOR | ❌ | ❌ |

Five grant rows observed. Unlike 49J and 49K, RBAC here is a genuine **entry gate**: every
admin route carries `@Roles`, asserted by a spec that discovers handlers off the prototype
and fails on any ungated one. Rotation, the connection test and the manual trigger are all
**write**-level — rotation replaces a credential, the test sends a real signed request to
operator infrastructure, and the trigger causes an outbound side effect.

### 4.6 SSRF protection (§30) — and one defect the E2E found

Layered, all in `integration-url.guard.ts`, applied on write **and again immediately before
every dispatch** because the policy is env-driven and can change without the row changing:

1. **Scheme allowlist** — `http`/`https` only. `file:`, `ftp:`, `gopher:`, `data:`, `ws:`,
   `redis:`, `javascript:` refused.
2. **Credentials in URL** refused rather than stripped.
3. **Private/loopback/link-local literals** refused unless `INTEGRATION_ALLOW_PRIVATE_TARGETS`.
   Covers `localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `10/8`, `172.16/12` (both edges tested),
   `192.168/16`, CGNAT `100.64/10`, multicast, `::1`, `fe80::/10`, `fc00::/7`, and
   IPv4-mapped IPv6.
4. **Cloud metadata endpoints** refused **even when private targets are allowed**.
5. **This process's own infrastructure** refused regardless of the flag.
6. **Path cannot change the authority** — `webhookPath` is resolved against the origin and
   the result re-checked, so `http://redis:6379/` or `//evil.example/x` as a path is refused.

**Layer 5 exists because the integration E2E caught its absence.** Check 36 originally
FAILED with `status=200`: with private targets enabled — the normal local configuration —
`http://redis:6379` was **accepted**, because `redis` is a hostname and this guard performs
no DNS resolution. Aria would have posted a signed envelope at its own Redis. The fix
derives the blocked set from `REDIS_URL`, `RABBITMQ_URL`, `MINIO_ENDPOINT`,
`MINIO_PUBLIC_URL` and the three `*DATABASE_URL`s, matching on **host *and* port** so an
engine sharing a host on another port stays configurable, and filling in default ports so
`redis://redis` and `redis://redis:6379` agree. Re-run: check 36 PASS `status=400`.

Layer 4's IPv4-mapped case was also a fix rather than a first draft: `new URL()` normalises
`[::ffff:10.0.0.1]` to `::ffff:a00:1`, so the dotted-quad match alone let 10.0.0.1 through.
Both spellings are now decoded.

**The manual trigger cannot name a destination.** `TriggerAutomationDto` has no `url` field,
so the §29 anti-pattern `POST /automation { "url": "..." }` is unexpressible, not merely
refused. The controller additionally enumerates the five forwarded fields explicitly.

### 4.7 Secret protection (§15)

- `toPublic()` is the **only** config projection; it emits `hasSecret` and
  `secretUpdatedAt`, never the envelope. No parameter, role check or debug flag changes that.
- Audit payloads carry `hasSecret: true` and a rotation timestamp, never the value —
  asserted by scanning the whole `audit.log` call list for the secret string.
- Nothing logs the signature, the headers, the request body or the response body. Log
  fields are: integration key, event type, status code, duration, short reason.
- `errorCode` is bounded to 100 characters on the inbound DTO, so an upstream stack trace
  cannot be smuggled into the database or the admin UI.
- The connection test returns a Persian message with no status code and no upstream body: a
  status code would distinguish "no such workflow" from "signature rejected" from "engine
  down", turning the endpoint into a probe for the operator's infrastructure.
- Browser checks 15/16: after a reload the generated secret is absent from the DOM and no
  64-hex value appears anywhere on the page.
- Browser check 18: the database holds only a complete AES-GCM envelope, and it does not
  contain the plaintext.

### 4.8 Callback validation (§26)

Seven checks in order, in `integration-callback.controller.ts`:

1. integration key known to the registry — **before any database read**, so the route
   cannot be used to enumerate;
2. config exists **and is enabled**;
3. secret stored **and decryptable** — there is no "no secret configured, so skip
   verification" branch anywhere in the method;
4. timestamp within ±5 minutes;
5. signature matches, compared in constant time;
6. header idempotency key equals the key **derived from the stored `eventVersion`** — a
   sender cannot choose which key its signature covers;
7. only then `applyCallback`, whose entire reach is `status`, `externalExecutionId`,
   `errorCode`, `completedAt` on one located row.

**Every rejection is 401 with the identical message `Callback rejected`.** A spec drives
three different failure classes and asserts the message set has size 1 — no oracle for which
integrations or events exist. The reason is logged for the operator.

**A callback cannot reach arbitrary storage.** `IntegrationCallbackDto` has no `table`,
`field`, `operator`, `where`, `sql` or `entity`; it names an event and reports an outcome.

---

## 5. EXECUTION

**Status model (§20)** — six members, closed:
`PENDING → SENT | ACCEPTED | RETRYING → COMPLETED | FAILED`.

`SENT` and `ACCEPTED` are distinguished honestly: `ACCEPTED` means the engine returned an
execution reference, so something exists on the other side that a callback can refer to.
There is no `SKIPPED` member — when nothing was promised, **no row is written at all**,
because a row no retry pass will claim is noise that makes "how many automations failed"
unanswerable.

**Tracking.** `AutomationExecution` stores `integration`, `eventId`, `eventType`,
`eventVersion`, `source`, `idempotencyKey`, `tenantId`, `actorId`, `correlationId`,
`status`, `externalExecutionId`, `attemptCount`, `nextAttemptAt`, `errorCode` and four
timestamps. **Not stored**: the payload, the engine's log, node detail, request/response
bodies, headers, the signature.

**The row is written BEFORE the attempt.** A crash during the HTTP call leaves the event
visible as PENDING for the retry pass; the reverse ordering would lose it. The cost is a
possible duplicate delivery, which is exactly what the idempotency key lets the consumer
absorb.

**Retry (§21)** — bounded three ways: `maxAttempts` is CHECK-constrained to 1–5, the backoff
comes from a finite four-element table (30 s / 2 m / 5 m / 10 m), and `canRetry` requires
*both* a retryable failure class *and* remaining budget. There is no branch that schedules
beyond `maxAttempts`. Terminal states clear `nextAttemptAt`, enforced by
`AutomationExecution_terminal_not_retryable` — so a completed row cannot be re-claimed and
redelivered.

**Retryability is classified, not assumed**: 5xx and 429 retryable; every other 4xx not,
because replaying a rejected request cannot change the outcome and would burn the budget.

**Claiming.** `processRetries` claims each row with a conditional `updateMany`
(`status = RETRYING AND nextAttemptAt <= now`), the same mechanism
`ReminderDispatcherService` uses. Postgres serialises writers, so at most one caller sees
`count === 1`; a second instance, an overlapping tick or a restart observes zero. Batch is
25 per tick.

**Retry redelivers identity, not the original body — stated rather than hidden.** Because
the payload is deliberately not persisted (§19), a retry rebuilds the envelope from the
recorded contract fields with an **empty payload** and the original `eventId`, so the
consumer's own idempotency key still matches. Asserted explicitly in the service spec, and
recorded in §13 as a deferred trade rather than presented as full redelivery.

**Timeout.** Per-attempt, from the config row, clamped 1000–60000 ms in both the DTO and SQL,
applied via `AbortSignal.timeout` — whose timer is unref'd, so a pending dispatch cannot hold
the event loop or a Jest run open.

**Correlation.** `correlationId` is taken from `RequestContextService`, travels in the
envelope, and is stored on the execution: Aria request → envelope → outbound request →
callback → row. Observed end to end in E2E check 21
(`da1d5c13-e6c9-4982-98b2-a5d534905a54`).

**Failure handling (§22).** A business operation never fails because automation failed.
`SupportService` emits **after** `$transaction` commits and never inside it — no network
round-trip inside a lock window. `AutomationService.emit` additionally catches programming
errors (unknown event type, over-large payload) and returns `SKIPPED / EMIT_REJECTED`, so a
bad automation call cannot 500 a ticket creation.

---

## 6. API

**Outbound.** `IntegrationService.trigger` → registry → `N8nIntegrationProvider.send` →
`POST {baseUrl}{webhookPath}` with the signed envelope. `fetch`, no new dependency.

**Admin surface** (`/admin/integrations`, JWT + `@Roles`):

| Route | Permission | Notes |
| --- | --- | --- |
| `GET /` | read | configs + registry descriptors |
| `GET /executions` | read | tenant-scoped, cursor-paged, cap 50. **Declared before `:id`** so it is not swallowed by the UUID route |
| `GET /:id` | read | |
| `POST /` | manage | 201 |
| `PATCH /:id` | manage | no `integration` field — a row cannot be retargeted |
| `DELETE /:id` | manage | |
| `POST /:id/secret` | manage | returns a generated secret once |
| `POST /:id/test` | manage | 200 for SUCCESS **and** FAILURE |
| `POST /trigger` | manage | 202; no `url` field exists |

**Inbound.** `POST /integrations/:integration/callback` — `@Public()`, HMAC-authenticated,
200 for both first delivery and duplicate.

**Validation.** Every DTO runs under the global `whitelist` + `forbidNonWhitelisted` +
`forbidUnknownValues` pipe, so an unexpected property is a 422 rather than a silently
dropped field. Bounds: `baseUrl` 500, `webhookPath` 300, secret 32–512, `timeoutMs`
1000–60000, `maxAttempts` 1–5, callback `errorCode` 100, envelope 64 KiB.

---

## 7. N8N

**Installed / configured: NO.** Port 5678 is closed on this machine. `docker ps -a` shows
one n8n container, `job_agg_n8n` (`docker.n8n.io/n8nio/n8n:latest`), **Exited (0) 4 weeks
ago** — it belongs to an unrelated project and was not started, not modified and not
inspected. §32 forbids installing n8n as part of this phase, so it was not installed.

**Real workflow-graph E2E: NOT PERFORMED, and not simulated.** No workflow was created, no
node executed, no n8n webhook bound. There is no fabricated "n8n E2E passed" claim anywhere
in this document.

**What WAS performed instead, over real TCP.** `apps/api/scripts/integration-e2e.mjs` runs a
`node:http` server on 127.0.0.1:4599 that behaves like a real webhook consumer: it
**recomputes the canonical string independently and verifies Aria's HMAC** with the shared
secret, records what it saw, and then posts a **real signed callback** back into Aria. A mock
that accepted anything would have proven nothing about signing.

**Result: 43 PASS / 0 FAIL, EXIT=0**, against the real Core process (`node dist/core-main.js`
on :3011) and real Postgres. What it proves on Aria's side of the wire:

- signature verified by an independent implementation (checks 9, 14);
- envelope carries every §8 field (15);
- idempotency header `N8N:<eventId>:v1` (16);
- actor carries `type`+`id` only — key set asserted exactly (17);
- payload minimised: no `subject`, no `requester` (18);
- the secret is absent from the request (19);
- execution ACCEPTED with the engine's reference, not retryable (20);
- correlation id captured (21);
- duplicate trigger → existing outcome, **no second delivery**, still one row (22–24);
- signed callback accepted → COMPLETED, reference updated, not retryable (25–27);
- replayed callback → `duplicate: true` (28);
- unsigned / forged / expired / unknown-event callbacks → **401 each** (29–32);
- engine killed → trigger still 202, recorded RETRYING/UNREACHABLE with a future
  `nextAttemptAt` (33–35);
- **the live retry pass then exhausted the bounded budget**: observed transition to
  `FAILED`, `attemptCount=2`, `nextAttemptAt` cleared, no third attempt (36–37);
- SSRF: redis / metadata / `file:` / credentials-in-URL all refused (38–41);
- admin list requires authentication (42);
- cleanup verified: zero config and zero execution rows left (43).

**What real n8n would add beyond this**: that a workflow node parses the envelope, and that
n8n's own webhook returns the shape the adapter's best-effort `executionId` extraction
expects. Both are recorded in §14 as a factual, non-blocking gap. The adapter deliberately
treats an unparseable response as "no external reference, still accepted", so the unknown
shape cannot become a delivery failure.

---

## 8. MODULE CONTRACT

**Events:** three real ticket events, emitted by `SupportService` after commit.

**Commands:** an inbound callback maps to exactly one explicit Core command,
`applyCallback`, which changes only delivery status on one located row.

**Queries:** none exposed to an external system. A consumer needing ticket detail calls the
authorized ticket API with its own credential and its own authorization edge — which is why
the payload is five scalars.

**Local module:** `SupportModule` imports `IntegrationsModule` and injects
`AutomationService` (`@Optional()`, so every existing trimmed test module still constructs).
It cannot see `IntegrationService`.

**Remote module:** the same contract with an `IntegrationConfig` row pointing at an HTTPS
origin. Versioned envelope, tenant context, correlation id and idempotency key travel
identically; nothing in the contract distinguishes local from remote.

**Database independence:** Core reads no module's tables through this layer, and the engine's
database is never touched. `AutomationExecution` has **no foreign keys at all** — verified in
the database (`contype='f'` count = 0) — so delivery history survives deletion of the
administrator who triggered it.

---

## 9. TESTING

| Gate | Command | Result |
| --- | --- | --- |
| API unit | `node ../../node_modules/jest/bin/jest.js --silent` (apps/api) | **52 suites / 944 tests, EXIT=0** |
| API typecheck | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **EXIT=0**, no diagnostics |
| API build | `nest build` (+ `postbuild`) | **EXIT=0** |
| Web unit | `node ../../node_modules/jest/bin/jest.js --silent` (apps/web) | **42 suites / 705 tests, EXIT=0** |
| Web typecheck | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | **EXIT=0**, no diagnostics |
| Web build | `next build` | **EXIT=0**, 34 routes incl. `/admin/integrations` |
| Integration E2E | `node scripts/integration-e2e.mjs` | **43 PASS / 0 FAIL, EXIT=0** |
| Browser | `node phase49l-validate.mjs` | **29 PASS / 0 FAIL, EXIT=0**, 8 screenshots |
| DB verification | `psql -f scripts/integration-verify.sql` | **EXIT=0** |

Five of these were **re-run once more at hand-off**, after the report was written, to confirm
nothing drifted while it was being written: API 52/944 EXIT=0, web 42/705 EXIT=0, both
typechecks EXIT=0 with no diagnostics, and the DB verification EXIT=0 still reporting 7 checks
/ 7 indexes / 0 foreign keys / 2 permissions / 5 grants / 18 applied migrations / 0 rows.

The API suite moved 938 → **944** during the phase: the six tests added by the
infrastructure-SSRF fix. Both figures were observed after their respective additions.

**The counts reconcile against 49K's closure figures exactly**, which is the check that the
new suites are additions and not replacements:

- API: 43 suites / 775 tests (49K) **+ 9 suites / 169 tests (49L) = 52 / 944** ✅
- Web: 40 suites / 674 tests (49K) **+ 2 suites / 31 tests (49L) = 42 / 705** ✅

**New API specs — 169 tests across 9 files:**

| File | `it(` |
| --- | --- |
| `integration.service.spec.ts` | 57 |
| `integration-url.guard.spec.ts` | 28 |
| `integration-signature.spec.ts` | 21 |
| `n8n-integration.provider.spec.ts` | 18 |
| `integration-callback.controller.spec.ts` | 16 |
| `integration.controller.spec.ts` | 10 |
| `integration-provider.registry.spec.ts` | 7 |
| `automation.service.spec.ts` | 6 |
| `automation-retry.service.spec.ts` | 6 |

**New web specs — 31 tests:** `CoreIntegrationsView.spec.tsx` 16,
`integrations-api.spec.ts` 15.

**§38 coverage, item by item:** event envelope ✅, versioning ✅, tenant propagation ✅,
payload minimization ✅, provider registry ✅, n8n adapter ✅, signature generation ✅,
signature validation ✅, replay protection ✅, idempotency ✅, timeout ✅, failure ✅,
bounded retry ✅, callback validation ✅, RBAC ✅, SSRF protection ✅, execution status
transitions ✅.

**§40 security matrix, all twelve:** invalid signature rejected ✅; expired timestamp
rejected ✅; replay rejected ✅; duplicate event idempotent ✅; wrong tenant — enforced by
predicate, unit-asserted ✅; unauthorized user cannot trigger ✅; arbitrary URL rejected ✅;
private-network SSRF blocked ✅; secret never returned ✅; secret never logged ✅; malformed
callback rejected ✅; unknown event type rejected ✅.

**Browser (§41):** integration list ✅, n8n configuration ✅, enable/disable ✅, connection
test ✅, safe status ✅ (all five states), masked secret ✅, validation error ✅, delivery
history ✅, **no workflow editor** ✅ (asserted by absence), RTL ✅, 390 px no overflow ✅.

**A note on the browser harness's console-error assertion.** Check 9 deliberately submits an
invalid endpoint, which makes the browser log a failed 400 resource load. Rather than
lowering the assertion to a count, the harness classifies: any 4xx `Failed to load resource`
goes to an *expected* bucket (asserted to contain exactly one entry) and everything else
fails the run. Final run: 0 unexpected, 1 expected.

---

## 10. DATABASE

**Two migrations, both additive:**

| Migration | Contents |
| --- | --- |
| `20260904120000_add_integration_platform` | 2 enums, 2 tables, 7 indexes, 7 CHECKs |
| `20260904120500_seed_integration_permission_grants` | 2 `Permission` rows, 5 `RolePermission` grants, all `ON CONFLICT DO NOTHING` |

**Verified in core_db** via `scripts/integration-verify.sql` (EXIT=0):

- tables: `AutomationExecution`, `IntegrationConfig`;
- enums: `IntegrationKey = N8N`;
  `AutomationStatus = PENDING,SENT,ACCEPTED,RETRYING,COMPLETED,FAILED`;
- 7 CHECK constraints, all present with the expected definitions;
- 7 indexes, including the **partial** `AutomationExecution_retryable_idx`
  (`WHERE "nextAttemptAt" IS NOT NULL`), which Prisma cannot express in `schema.prisma`;
- **foreign keys: 0** — deliberate, so delivery history outlives its actor;
- permissions: 2 rows, domain `ADMIN`; grants: 5 rows;
- migration state: **18 applied, 0 unfinished, 0 rolled back**;
- row counts after all verification runs: **0 configs, 0 executions**.

**No destructive DDL.** No `DROP`, no `ALTER` of an existing column, no backfill, no seed
data row. No existing migration was modified — the **16 pre-existing directories** (15
committed plus 49K's untracked `20260903130000_add_user_preferences`) are unchanged and
applied; 16 + 2 = the 18 the database reports. Rollback is two `DROP TABLE` plus two
`DROP TYPE`.

**Not created, by decision (§36):** `Workflow`, `WorkflowNode`, `WorkflowGraph`,
`AutomationEngine`, any generic event store, any queue/offset table. Retry state is two
columns on the execution row.

---

## 11. REGRESSION

**49I — unchanged.** No file under `apps/api/src/calendar` or the calendar UI was touched.
`ReminderDispatcherService` is untouched; 49L imitates its claiming pattern rather than
modifying it. Its specs pass inside the 944.

**49J — unchanged.** No search, vector, embedding or AI-provider file was modified.
`AIModule`, `AIConfigService`, `CryptoService`, `SearchModule` and the pgvector schema are
byte-identical. `CryptoService` is **consumed**, not altered — its own unchanged spec passes.
49J remains YELLOW on its own register; nothing here changes that.

**49K — unchanged in substance.** No dashboard redesign, no preference-architecture change,
no accessibility-framework replacement. Two 49K-owned files gained integration-specific
entries only:

- `core-nav.ts` — one nav item + one icon import;
- `nav-catalogue.ts` — one `NAV_TARGETS` entry gated on `admin.integrations.read`, so the new
  page is favouritable and the favourite stops resolving when the grant is revoked.

`core-nav.spec.ts` grew the corresponding assertion; its existing drift test — which requires
the client tree and the server allowlist to agree entry for entry — passes, and that is what
proves the two additions are consistent rather than merely both present.

**One pre-existing dirty file is NOT 49L's.**
`apps/web/src/components/core/CoreSupportView.tsx` carries a one-line uncommitted change
(`p-4 sm:p-6` → `p-4 sm:p-core-card`) from earlier 49K density work — `p-core-card` is a 49K
Tailwind spacing alias. It predates this phase, is unrelated to integration, and was
deliberately left alone.

**Nothing else regressed:** API 52/52 suites and web 42/42 suites pass; both typechecks and
both builds are clean.

---

## 12. GIT / ARTIFACT HYGIENE

Pre-flight `git status --short` / `git diff --stat` were taken before any edit. **No existing
uncommitted work was overwritten**, and no `git reset`, `clean`, `restore`, `rebase` or force
push was run. Nothing was committed — none was requested.

**Modified (11 files). The deltas are split, because four of them also carry uncommitted 49K
work that was already in the tree — crediting the whole diff to 49L would misreport it:**

| File | Total Δ | 49L's share |
| --- | --- | --- |
| `apps/api/prisma/core/schema.prisma` | +370 | **+188** (2 enums, 2 models); +182 is 49K's `UserPreference` block and its `User` relation |
| `apps/api/src/support/support.service.ts` | +82 | +82 |
| `apps/web/src/components/core/__tests__/core-nav.spec.ts` | +68 | **+1** — one href inside 49K's `SERVER_NAV_TARGETS`; the other +67 is 49K's `isNavTarget` suite |
| `apps/web/src/components/core/core-nav.ts` | +32 | **+14** (icon import + nav entry); +18 is 49K's `isNavTarget` |
| `apps/api/.env.example` | +26 | +26 |
| `apps/api/src/auth/rbac/constants/permissions.ts` | +24 | +24 |
| `apps/api/src/core-app.module.ts` | +24 | **+16**; +8 registers 49K's `PreferencesModule` |
| `apps/api/src/support/support.module.ts` | +17 / −1 | +17 / −1 |
| `docker-compose.yml` | +16 | +16 |
| `apps/api/src/auth/rbac/constants/roles.ts` | +14 | +14 |
| `apps/api/src/preferences/nav-catalogue.ts` | +4 | +4 (file itself is untracked 49K) |

**49L's own footprint in modified files is therefore +402 / −1**, not +673. The rest was
already uncommitted when the phase started.

That +1 line in `core-nav.spec.ts` is the most load-bearing single line in the phase: 49K's
drift test asserts the client nav tree and the server allowlist match **entry for entry**, so
adding the nav item without adding the `NAV_TARGETS` entry — or vice versa — fails the suite.

Plus `apps/web/src/components/core/CoreSupportView.tsx` (+1 / −1), **pre-existing 49K work,
not this phase's** — see §11.

**New: 33 files, plus 8 screenshots.**

| Group | Count |
| --- | --- |
| `apps/api/src/integrations/` sources | 12 (2,836 lines) |
| `apps/api/src/integrations/` specs | 9 (2,175 lines) |
| Migrations | 2 |
| `apps/api/scripts/` | 3 (`integration-verify.sql`, `integration-e2e.mjs`, `integration-e2e-cleanup.sql`) |
| Web client + spec | 2 (`lib/integrations-api.ts`) |
| Web view + spec | 2 (`CoreIntegrationsView.tsx`) |
| Web route | 1 (`app/admin/integrations/page.tsx`) |
| Browser harness | 1 (`phase49l-validate.mjs`) |
| This report | 1 |
| `phase49l-shots/` PNGs | 8 |

**Secrets: none committed and none written to a tracked file.** No n8n credential, no webhook
secret, no runtime config containing a secret, no execution dump, no exported workflow.
`apps/api/.env.example` documents `INTEGRATION_ALLOW_PRIVATE_TARGETS=false` — a policy flag,
not a credential. The AES key used to run the local Core process was passed as a shell
variable inside a temporary `.cmd` wrapper; **all such wrappers and their `.out` captures were
deleted**, verified by `Get-ChildItem l49l-*` returning 0 files and
`git status | Select-String l49l` returning 0 lines.

**Temporary artifacts: cleaned.** The 23 `l49l-*.cmd` wrappers and their captures are gone;
the hand-off re-run used `%TEMP%`, and those files were deleted too (`0` remaining under both
the repository and `%TEMP%`). `phase49l-shots/` (8 PNGs) is retained deliberately as browser
evidence, matching the 49I/49K convention.

**Test state: cleaned.** Both the E2E and the browser harness delete what they create and
then assert the tables are empty; the final DB verification reports 0 configs / 0 executions.
`integration-e2e-cleanup.sql` exists for an interrupted run, and the E2E now says so
explicitly on a 409 instead of failing opaquely.

**Unrelated changes: none introduced.** The tree still carries many pre-existing untracked
artifacts from earlier phases (`k-jest*.out`, `phase48c*-shots/`, `backups/`, `lovable/`,
`tools/`, and two credential-shaped files `apps/api/.tok` / `apps/api/.rid`). None was read,
modified, deleted or staged. **A future commit must stage explicit paths** — `git add .` would
capture those two credential-shaped files.

---

## 13. DEFERRED

Each is a deliberate boundary with a stated reason, not an unfinished task.

1. **Real n8n workflow E2E.** n8n is not installed here and §32 forbids installing it. The
   adapter's HTTP behaviour is proven against a real signature-verifying peer; what remains
   unproven is a workflow node parsing the envelope. Resolution: start a local n8n, point an
   `IntegrationConfig` row at it, bind `/webhook/aria`, run the harness.
2. **DNS-rebinding-proof SSRF.** The guard blocks literals and this process's own
   infrastructure but performs **no DNS resolution** — resolving then handing the URL to
   `fetch` re-resolves it, so an attacker can still win the race. Real protection means
   pinning the resolved address into the socket, which Node's `fetch` does not expose. Stated
   in the module comment and asserted by a test that documents the gap (`localtest.me` passes).
3. **Byte-exact raw-body signature verification.** The inbound signature covers
   `JSON.stringify(dto)` after validation, not the received bytes, because no raw-body parser
   is configured and adding one globally would change request handling for every existing
   route. `forbidNonWhitelisted` guarantees no extra property survives, so reconstruction is
   exact for a well-formed sender that serialises canonically.
4. **Retry redelivers identity, not the original payload.** A consequence of not persisting
   payloads (§19). Asserted explicitly rather than hidden.
5. **Payload schema validation per event type.** `IsObject` bounds size; there is no
   per-`eventType` shape check. The payload is produced by Core, so its shape is code rather
   than input — a schema registry would be validating our own output.
6. **Second integration provider.** One adapter exists, so the registry has one key. Adding
   another is the four-step recipe in §2.
7. **Multi-target fan-out.** `trigger` dispatches to the first enabled integration. The
   idempotency key is already integration-scoped, so fan-out is a loop once a second provider
   exists; building it now would be untestable.
8. **Observability beyond correlation + status.** Latency and failures are logged, not
   aggregated into a metrics backend. No metrics infrastructure exists in this repository and
   §1 forbids introducing one.
9. **Web ESLint.** Still cannot load `eslint-config-next` (circular structure) — a
   **pre-existing** failure carried from 49K, not caused here. 49L therefore has no web lint
   evidence; typecheck and build stand in.

---

## 14. BLOCKERS

**None.** No §49 stop condition was hit:

| Stop condition | Status |
| --- | --- |
| Service auth cannot be made secure | Not hit — HMAC + encrypted secret, tested |
| Replay protection impossible | Not hit — window + terminal-state idempotency |
| Tenant context cannot be preserved | Not hit — snapshot + unconditional predicate |
| Callback cannot be idempotent | Not hit — duplicate returns existing outcome |
| SSRF protection cannot be established | Not hit — six layers; one defect found and fixed |
| Requires direct DB coupling | Not hit — no engine DB access; zero FKs |
| n8n becomes mandatory | Not hit — proven functional with the engine down |
| Distributed infrastructure creep | Not hit — no Kafka / Redis streams / RabbitMQ workflow / Elasticsearch |
| Business modules depend on n8n internals | Not hit — only `AutomationService` is exported |
| Destructive migration required | Not hit — additive only |

**One factual gap, non-blocking:** no real n8n workflow execution was observed (§7, §13.1).
That is a missing corroboration of the engine's half of the wire, not a defect in Aria's, and
it cannot be closed without installing software §32 forbids installing.

---

## 15. FINAL GATE

| Gate | Result | Evidence |
| --- | --- | --- |
| **ARCHITECTURE** | **PASS** | Provider-neutral layer; n8n confined to one adapter; stable versioned envelope; module contract; local/remote identical; n8n not mandatory (E2E 33–35) |
| **SECURITY** | **PASS** | HMAC auth; signature validation (49 signing/URL tests); ±5 min replay window; DB-enforced idempotency; unconditional tenant predicate; 2 seeded permissions with 5 grants; six-layer SSRF; secret never returned or logged; seven-step callback validation with uniform 401 |
| **EXECUTION** | **PASS** | `AutomationExecution` tracking; six-state model; bounded retry observed exhausting its budget live (E2E 36–37); per-attempt timeout; correlation id end to end; failure never propagates |
| **CONFIGURATION** | **PASS** | Core Settings at `/admin/integrations`; enable/disable; connection test; masked secret (browser 13–19); one secret store reusing 49J-0's key |
| **API** | **PASS** | 9 gated admin routes + 1 HMAC callback; DTO validation under `forbidNonWhitelisted`; stable normalized contracts |
| **TESTING** | **PASS** | API 52/944; web 42/705; E2E 43/43; browser 29/29; 2 typechecks; 2 builds — all EXIT=0 |
| **N8N E2E** | **N/A — HONESTLY REPORTED** | n8n not installed (§32); real-HTTP peer E2E performed instead; gap stated in §7 and §13.1, never simulated |
| **DATABASE** | **PASS** | 2 additive migrations; 18 applied / 0 unfinished / 0 rolled back; no destructive DDL; old migrations untouched |
| **REGRESSION** | **PASS** | 49I untouched; 49J untouched; 49K additive-only, drift test passing |

### OVERALL = GREEN

```text
ARCHITECTURE   = GREEN
SECURITY       = GREEN
EXECUTION      = GREEN
CONFIGURATION  = GREEN
API            = GREEN
TESTING        = GREEN
DATABASE       = GREEN
REGRESSION     = GREEN

OVERALL: GREEN
```

### §50 checklist

| Requirement | Status |
| --- | --- |
| Provider-neutral integration layer | ✅ contract + registry; `AutomationService` is the only export |
| n8n adapter implemented | ✅ `N8nIntegrationProvider`, 18 tests |
| Aria fully functional without n8n | ✅ E2E 33–37 with the peer killed; business path unaffected |
| Event envelope + versioning | ✅ `v1`, length-prefixed canonical string |
| Payload minimization | ✅ five scalars; asserted by absence (E2E 18) |
| Tenant propagation | ✅ snapshot + unconditional predicate |
| HMAC signing (outbound) | ✅ verified by an independent implementation (E2E 9, 14) |
| HMAC verification (inbound) | ✅ seven-step validation, uniform 401 |
| Replay protection | ✅ ±5 min window, checked before the HMAC |
| Idempotency | ✅ UNIQUE INDEX, not read-then-write |
| Bounded retry | ✅ budget exhaustion observed live (E2E 36–37) |
| SSRF protection | ✅ six layers; infrastructure-blocking defect found by E2E 36 and fixed |
| Secret encrypted at rest | ✅ reuses `AI_CONFIG_ENCRYPTION_KEY`; never returned, never logged |
| RBAC on admin surface | ✅ 2 seeded permissions, 5 grants, verified in core_db |
| Core Settings UI | ✅ `/admin/integrations`, 29 browser checks, RTL + 390 px |
| Execution history | ✅ `AutomationExecution`, cursor-paged, tenant-scoped |
| Additive migrations only | ✅ 2 new; 18 applied / 0 unfinished / 0 rolled back |
| No workflow editor | ✅ asserted by absence (browser check) |
| **N8N workflow E2E** | ⚠️ **local n8n not present — deferred, not simulated** (§7, §13.1) |

Every mandatory gate passes on observed evidence. The one non-mandatory gate (real n8n E2E)
is conditional by the prompt's own wording — "only if local n8n exists" — and it does not, so
it is reported as such rather than claimed.

**Not started:** 49M. **No workflow editor. No business-domain automation beyond the three
real ticket events. n8n not installed. No coupling to the n8n database. n8n not mandatory. No
Kafka, Redis or RabbitMQ introduced.**

49L = **GREEN**. 49J remains **YELLOW** on its own register, unchanged and untouched.
