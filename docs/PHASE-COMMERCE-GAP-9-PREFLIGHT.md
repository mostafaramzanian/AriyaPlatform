# PHASE COMMERCE GAP-9 — PREFLIGHT / CONTRACT DISCOVERY
## Notifications

**Status:** discovery-only. No schema, migration, DTO, seed, fixture, frontend, event-routing or runtime file was modified. The only artifact of this phase is this report.

**Repository:** `E:\ERP` · **HEAD:** `c0fab92` ("test(commerce): order U teardown before pinned versions") · **Working tree:** NOT clean — the C7/C8/C9/UI-phase work is in progress (56 modified / 26 untracked). Verified: the uncommitted diff adds a Commerce audit-read/timeline and search-source surface (GAP-5/GAP-7) but **touches no notification contract** — `src/notifications/**`, the Core `Notification` schema/migration and the `/notifications` controller are unchanged by the working tree. Every finding holds for both HEAD and the current tree.

**Read-only checks run:** directory listings; `Select-String` audits over `apps/api/src/**`, `apps/api/prisma/**`, `apps/api/test/**`, `apps/web/src/**`, `docs/**`; `git status`; reads of the Core schema, the `20260828120000_add_notification_center` migration, the notification module/service/controller/publisher, the Commerce and HR gateways, the architecture-boundary and gateway specs, the notification e2e/unit specs, and the web bell/view/client + specs. **No build, no test run, no migration, no database write.**

---

## 1. Scope

GAP-9 is the per-user Commerce notification question raised during Phase UI-5 and re-flagged in UI-0:

> The header **notification bell** wants to say «درخواست X منتظر تأیید شماست». Commerce today emits **only two** platform (AMQP) events — `commerce.purchase_document.submitted` and `commerce.workflow.line.routed` — and there is **no** evidence those become a per-user notification addressed to a recipient. Does an authoritative **user-facing notification contract** already exist on the platform, and what — if anything — must Commerce do to close GAP-9?

This preflight establishes, from source only:

1. whether an authoritative, user-facing notification contract exists (and its owner);
2. what Commerce currently emits, at the transport level, and to whom;
3. whether any mechanism turns those events into a user-visible notification;
4. the recipient, tenant, persistence, read/unread and API semantics of the authoritative contract;
5. the exact Commerce integration point and the smallest source-backed remediation;
6. whether closing GAP-9 is a **Commerce** task or requires a **Platform** contract first.

Explicitly out of scope: implementing any notification behavior, adding a table/migration/endpoint/queue, inventing a notification subsystem, changing the `CommerceNotificationGateway` or `NotificationPublisher`, or any frontend change.

---

## 2. Sources Inspected

| Area | Files (authoritative ones in bold) |
|---|---|
| Core notification persistence | **`apps/api/prisma/core/schema.prisma`** (`enum NotificationType` L52–64, `model Notification` L516), **`apps/api/prisma/core/migrations/20260828120000_add_notification_center/migration.sql`** |
| Notification Center service | **`apps/api/src/notifications/notification.service.ts`**, `notification.service.spec.ts` |
| Notification Center HTTP | **`apps/api/src/notifications/notification.controller.ts`**, `dto/notification-query.dto.ts` |
| Notification wiring | **`apps/api/src/notifications/notification.module.ts`**, `cms-notification.module.ts` |
| Transport / AMQP | **`apps/api/src/notifications/notification.publisher.ts`**, `notification.publisher.spec.ts`; **`apps/api/src/platform/audit/audit.contract.ts`**, `audit-ingest.consumer.ts` (the only `domain_events` consumer) |
| Commerce gateways | **`apps/api/src/modules/commerce/commerce-notification.gateway.ts`**, `commerce-audit.gateway.ts`, `commerce-gateways.spec.ts`, `commerce.module.ts`, `commerce.constants.ts` |
| Commerce event emitters | **`.../purchase/purchase.service.ts`** (L83–85, L403–417), **`.../workflow/workflow-line-routing.service.ts`** (L182–186) |
| HR analogue (the other independent module) | **`apps/api/src/modules/hr/hr-notification.gateway.ts`**, `hr.module.ts` |
| Core in-process consumers | `src/support/support.service.ts`, `src/calendar/reminder-dispatcher.service.ts`, `src/messaging/messaging.service.ts`, `src/modules/correspondence/correspondence.service.ts`, `src/surveys/surveys.service.ts` |
| Boundary policy | **`apps/api/src/architecture-boundaries.spec.ts`**, **`apps/api/src/modules/commerce/commerce-gateways.spec.ts`**, `src/modules/hr/hr-isolation.spec.ts` |
| Commerce recipient concepts | `src/modules/commerce/pending/pending-decisions.service.ts`, `src/modules/commerce/workflow/workflow-execution.repository.ts`, `src/modules/commerce/commercial/commercial-liaison.ts` |
| Frontend | **`apps/web/src/lib/notifications-api.ts`**, `components/core/CoreNotificationBell.tsx`, `components/core/CoreNotificationsView.tsx` (+ their `__tests__`) |
| Prior reports | `docs/PHASE-UI-0-COMMERCE-UX-CONTRACT.md`, `docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md`, `docs/reports/PHASE_49K_CLOSURE.md`, `docs/reports/PHASE_51-HR-ARCH-3B_CLOSURE.md` |
---

## 3. Notification architecture map

There are **two independent things** living under `src/notifications/`, and the whole of GAP-9 turns on not conflating them.

```
  ┌─ Transport / event infrastructure (pre-existing, AMQP) ──────────────────────────────┐
  │  NotificationPublisher.publish(eventType, payload)                                    │
  │      → RabbitMQ topic exchange  domain_events  (durable)                              │
  │      → best-effort, NEVER throws; on failure records an AuditDispatch retry row       │
  │  Consumers bound to domain_events:                                                    │
  │      • AuditIngestConsumer   (queue platform.audit.ingest, binding audit.#) ONLY      │
  │      • (none for commerce.* / mission.* / auth.* / ticket.* / blog.*)                 │
  │  Also: POST /api/v1/test-notification (@Public, app.controller.ts) → publish(test)    │
  └───────────────────────────────────────────────────────────────────────────────────────┘

  ┌─ Persistent user-facing "Notification Center" (Phase 49E, Core) ──────────────────────┐
  │  Model:  core_db."Notification"  (userId, tenantId, type, title, body, readAt,        │
  │                                   sourceType, sourceId, createdAt)                     │
  │  Service: NotificationService.createForUser(...)  ← the ONE server-side creation path  │
  │           listNotifications / getUnreadCount / markRead / markAllRead                  │
  │  HTTP:   GET /notifications, GET /notifications/unread-count,                          │
  │          POST /notifications/:id/read, POST /notifications/read-all  (JwtAuthGuard)    │
  │  UI:     CoreNotificationBell (poll unread-count 60s) + CoreNotificationsView + client │
  └───────────────────────────────────────────────────────────────────────────────────────┘
                                    ▲
        in-process callers (createForUser)  |  transport emitters (publish)
        ────────────────────────────────────┼──────────────────────────────────────────
        support, calendar/reminders,        |  HR  → mission.*         (no consumer)
        messaging, correspondence,          |  Commerce → commerce.*   (no consumer)
        surveys            (Core modules)   |  the "/test-notification" dev route
```

**The seam between the two boxes does not exist.** No code path turns a `domain_events` message produced by `NotificationPublisher` into a row in the `Notification` table. The only writer of `Notification` rows is `NotificationService.createForUser`, and it is called **in-process** — never from a consumer.
---

## 4. Authoritative notification contract

**YES — an authoritative, user-facing notification contract exists. Owner: Core (`src/notifications/`, Phase 49E).** It is a persistent, user-scoped, tenant-scoped in-app Notification Center. Evidence:

**4.1 Persistence (authoritative table).** `core_db."Notification"`, migration `20260828120000_add_notification_center`:
- `id` TEXT PK · `userId` TEXT NOT NULL (FK → `User(id)` ON DELETE CASCADE) · `tenantId` TEXT (nullable) · `type` `NotificationType` NOT NULL DEFAULT `INFORMATION` · `title` TEXT NOT NULL · `body` TEXT NOT NULL · `readAt` TIMESTAMP(3) NULL · `sourceType` TEXT NULL · `sourceId` TEXT NULL · `createdAt` DEFAULT now().
- Indexes: `Notification_userId_createdAt_id_idx (userId, createdAt DESC, id DESC)` (list), `Notification_userId_readAt_idx (userId, readAt)` (unread count). DB CHECKs on `title`/`body` length (1–160 / 1–1000).

**4.2 Types/categories.** `enum NotificationType { SYSTEM, SECURITY, ANNOUNCEMENT, INFORMATION }` — a bounded, closed set; no per-business-domain type (no COMMERCE/TASK/REQUEST) is declared (the enum comment calls a business-domain taxonomy speculative).

**4.3 Public interface (`NotificationService`).**
- `createForUser(input)` — **the single server-side creation path; no HTTP route reaches it.** Input: `{ userId; tenantId?; type; title; body; sourceType?; sourceId? }`. It loads the recipient, **refuses a tenant assertion that does not match the recipient**, and **snapshots the recipient's own `tenantId`** (a caller cannot place a notification into another tenant). Title/body are plain text (`</>` refused), length-bounded; `sourceType`/`sourceId` are opaque refs (`^[A-Za-z0-9._:-]+$`, ≤64).
- `listNotifications(userId, {cursor?, limit?, state?})` → `{ items, hasMore }`, ordered `createdAt desc, id desc`.
- `getUnreadCount(userId)` → `{ count }`.
- `markRead(userId, id)` → `{ id, readAt }` (idempotent — an already-read row keeps its original `readAt`; a foreign/unknown id is a 404, indistinguishable, so it cannot probe other users' rows).
- `markAllRead(userId)` → `{ updated }`.

**4.4 Recipients / tenant / scope.** Recipient is always the authenticated subject (`req.user.sub`) on reads, and always an **explicit Core `userId`** on creation. `NotificationService.scope()` requires `RequestContextService.get().userId === userId` (else `ForbiddenException`) and reads `tenantId` from the request context — **never** from a query/body/path. The allowlisted projection **omits `userId` and `tenantId`**.

**4.5 Timestamps / lifecycle.** `createdAt` is DB-generated on insert; `readAt` is null until read. There is **no** update route, **no** delete/dismiss route, **no** retention policy, and **no** idempotency key on creation (a repeat `createForUser` with the same args inserts a second row — dedup is the caller's concern, which no caller currently performs).

**4.6 Authorization.** The controller is `@UseGuards(JwtAuthGuard)` only — **no `@Roles(...)`**: notifications are personal, not an administered resource; ownership is the sole authorization boundary.

**Therefore the contract is complete for the questions GAP-9 asks of an existing user notification system:** persistence ✓, user notifications ✓, read/unread ✓ (persisted `readAt`), recipient ✓ (explicit `userId`), tenant scoping ✓, notification API ✓ (list/count/mark), badge/count ✓, tenant isolation ✓ (tested). It does **not** provide: event→notification mapping, templates, preferences, delivery channels (email/push), scheduling, dismiss, or an idempotency/dedup rule — none of which it claims to have.
---

## 5. Transport-vs-user-notification analysis

Classification rule applied: an AMQP event is a **user notification** only if a documented consumer turns it into a `Notification` row (or directly calls `createForUser`).

| Artifact | Producer | Recipient info | Consumer | Persistence | User visibility | Classification |
|---|---|---|---|---|---|---|
| `NotificationPublisher.publish` | any module | none | — | best-effort `AuditDispatch` retry only | none | **transport event only** |
| `POST /api/v1/test-notification` (`test.event`) | `app.controller.ts` (Phase A dev) | none | none | none | none | **transport event only** |
| `commerce.purchase_document.submitted` | `PurchaseService` | `requesterId` present but not addressed | none | none | none | **domain/integration event only** |
| `commerce.workflow.line.routed` | `WorkflowLineRoutingService` | none | none | none | none | **domain/integration event only** |
| `mission.*` (6 kinds) | `HrNotificationGateway` | `recipientEmployeeIds[]` present but not consumed | none | none | none | **domain/integration event only** |
| `NotificationService.createForUser` | Core modules (in-process) | explicit `userId` | n/a (direct call) | `Notification` row | **visible in the Center** | **user-facing notification** |

**Conclusion.** Every notification-related *event* in this repository is **transport-only or domain/integration only**. Only `createForUser` produces a user-facing notification, and nothing calls it from a consumer. The HR gateway header explicitly asserts "a consumer in Core can create the actual in-app notifications" — **that consumer does not exist** (the sole `domain_events` consumer is `AuditIngestConsumer` on `audit.#`, a *different* contract that deliberately does not import `NotificationModule`). Commerce and HR both emit events into a topic exchange **nobody drains**.
---

## 6. Commerce event inventory

Commerce's `CommerceNotificationGateway` is the **only** surface allowed to hold `NotificationPublisher` (gate I9, `commerce-gateways.spec.ts`). It stamps `tenantId`, `correlationId` and `emittedAt` **after** the payload spread, so a payload key cannot displace a platform-owned field. It exposes one method: `publish(actor, eventType, payload)`.

Two events are emitted today (both `commerce.*`), and no others:

| Event | Emit site | Actor | Payload | Recipient defined? | Tenant | Entity id | Consumed? | Documented / tested |
|---|---|---|---|---|---|---|---|---|
| `commerce.purchase_document.submitted` | `purchase.service.ts:411` (`COMMERCE_PURCHASE_EVENT.SUBMITTED`) | `resolveCommerceActor` | `documentId, documentNumber, requesterId, status, lineCount` | **No** (`requesterId` carried, not addressed) | ✓ | ✓ documentId | **No** | pinned by `purchase.service.spec.ts:743–746`; contract `docs/PHASE-C1-N-…` |
| `commerce.workflow.line.routed` | `workflow-line-routing.service.ts:182` | actor | `documentId, lineId, workflowInstanceId` | **No** | ✓ | ✓ documentId/lineId | **No** | asserted via `commerce-gateways`/isolation guards |

Commerce acts that **could** plausibly warrant a user notification but emit **no** event at all today:

| Business act | Event emitted? | Recipient concept present? | Notes |
|---|---|---|---|
| purchase submit | ✓ (transport) | `requesterId` in payload | no notification |
| workflow approval / rejection | **✗** | workflow step assignee / approver (execution repo) | decision path writes status + audit only |
| workflow cancellation / terminal outcome | **✗** | — | — |
| commercial approval decision (line) | **✗** | `CommercialApproval` approver | — |
| assignment / reassignment (liaison) | **✗** | `liaisonUserId` (`commercial-liaison.ts`) | — |
| purchase completion / closure | **✗** | — | C4-R: completion publishes no event |
| payment | **✗** | — | Q: append-only, no event |
| receiving / return | **✗** | — | R/S: "this module's notification gateway gains no caller" (module comment) |
| line routing decision | ✓ (transport) | — | no assignment/notification |
| configuration changes (workflow/commercial) | **✗** | — | authoring/publish audited only |

`CommerceModule` **already imports `NotificationModule`** (`commerce.module.ts:2`), which `exports [NotificationPublisher, NotificationService]`. So `NotificationService.createForUser` is **already DI-available inside Commerce today** — nothing imports it, but the wiring to reach it exists.
---

## 7. Recipient/audience contract

The authoritative contract's recipient rules, from source (**not** assumed):

- **The Center does not resolve audiences.** `createForUser` requires an **explicit Core `userId`**; it validates the user exists and snapshots that user's tenant. There is **no** role/group/permission/assignee resolution, no "tenant members" broadcast, and no recipient rule inside `NotificationService`.
- **Every existing caller resolves recipients itself, in-process:** support → ticket `assigneeId`/`requesterId`; calendar → the reminder's own `userId`; messaging → conversation members who are offline; correspondence → `LetterRecipient` rows; surveys → participants. All exclude the actor, and none invents a rule the domain lacks.
- **A recipient must be a Core user id.** The FK is `Notification.userId → User(id)` and the tenant is snapshotted from `User`, so an id that is not a Core user cannot be addressed.

Commerce recipient concepts that **already exist in authoritative Commerce contracts** (candidates only — this phase invents none):

- **`requesterId`** — the purchase document's requester (a Core user id; opaque `@db.Text`, GAP-8; carried in the `submitted` payload today).
- **workflow step assignee / approver** — `WorkflowExecutionRepository` already computes "which pending step belongs to this user" for `PendingDecisionsService`; that predicate is the deliberate-membership source for a "you must decide" notification. Identity is a Core user id (Commerce stores approver ids as opaque TEXT).
- **`liaisonUserId`** — the commercial group's configured liaison (`commercial-liaison.ts`).
- **commercial approval approver** — the `CommercialApproval` actor.
- **actor** — `resolveCommerceActor` (`actor.userId`); the actor must be **excluded** as a recipient (every platform in-process caller enforces "never notify the actor of their own act").

**Not defined anywhere, and not to be assumed here:** the event→recipient mapping for Commerce (which event notifies whom). That is a decision for the implementation contract, informed by the concepts above.

---

## 8. Tenant isolation

**Verified as defined and tested.**

- **Notification tenant key:** `Notification.tenantId`, snapshotted from the recipient `User.tenantId` at creation — never supplied by the caller.
- **Read/list/mark authorization:** every read and update is keyed on the `ownership(userId)` predicate `{ userId, tenantId }`, where `tenantId` comes from `RequestContextService` (populated from the DB by the global `TenantContextInterceptor`), and `userId` must equal both the argument and the request-context subject. A row whose tenant differs from the caller's current tenant context is **invisible even to its own recipient** (the service comment states this explicitly).
- **Cross-tenant prevention:** recipient ids alone are **not** sufficient — the `tenantId` predicate is part of the same `findMany`/`updateMany`/`count` statement, so a mis-scoped id cannot leak a row. A foreign/unknown id on `markRead` is a 404 indistinguishable from "not found".
- **Current-session tenant is required:** `scope()` throws `ForbiddenException` when the request context carries no matching user, so an uncontextualised caller cannot read or write.
- **Existing tests proving isolation:** `test/notifications.e2e-spec.ts` (real Core DB) proves a peer in the *same* tenant and a user in *another* tenant are both invisible to the caller, across `list`, `unread-count`, `markRead` and `markAllRead`; and that `createForUser` snapshots tenant A regardless of caller input.

No tenant-safety gap exists in the authoritative contract. Any Commerce notification created through `createForUser` inherits this isolation automatically (the tenant is the *recipient's*, and Commerce already acts inside a tenant context via `resolveCommerceActor`).
---

## 9. User-facing API contract

Discovered routes (`@Controller('notifications')`, `JwtAuthGuard`, prefix `api/v1`):

| Method · Route | Purpose | Permission | Tenant / session scope | Response | Read/unread semantics |
|---|---|---|---|---|---|
| `GET /api/v1/notifications` | list | none (ownership only) | `req.user.sub` + request-context tenant | `{ items, hasMore }` | `?state=unread|read`; default all |
| `GET /api/v1/notifications/unread-count` | badge | none | caller + tenant | `{ count }` | `readAt IS NULL` |
| `POST /api/v1/notifications/:id/read` | mark one | none | caller + tenant | `{ id, readAt }` | idempotent; 404 if foreign/unknown |
| `POST /api/v1/notifications/read-all` | mark all | none | caller + tenant | `{ updated }` | idempotent |

- **No create/update/delete route exists.** The e2e suite asserts `POST/PUT/PATCH/DELETE /notifications` → 404.
- **Query contract** (`NotificationQueryDto`): `cursor` (≤64), `limit` (`@Min(1)`, capped at 100 by the service), `state ∈ {unread, read}`. The global `ValidationPipe` runs `whitelist + forbidNonWhitelisted`, so `userId` or `tenantId` in the query is **rejected**, not honoured.
- **Ordering / pagination:** `createdAt desc, id desc`; over-fetch-by-one decides `hasMore`; cursor is the last `id`.
- **Response fields:** exactly `{ id, type, title, body, readAt, sourceType, sourceId, createdAt }` — `userId` and `tenantId` are never returned.
- **Error behaviour:** 401 without a bearer token; 404 on an unknown/foreign `markRead` id; 422 for a non-whitelisted query field. No authorization gate beyond ownership.

**Frontend usage (read-only inspection — no change made this phase):**
- `apps/web/src/lib/notifications-api.ts` mirrors exactly the four routes; no client function accepts a `userId`/tenant.
- `CoreNotificationBell.tsx` polls `getUnreadCount()` every `60_000 ms`, renders `formatUnreadBadge(count)` (cap `99+`), opens a panel calling `listNotifications({ limit })` and `markAllNotificationsRead()`. **Polling, not SSE/WebSocket.**
- `CoreNotificationsView.tsx` is the fuller view; both have `__tests__` specs, and `notifications-api.spec.ts` exists. The UI is **generic over the Center** — no Commerce-specific coupling, no per-type rendering a new Commerce notification would require.
- `docs/reports/PHASE_49K_CLOSURE.md:67` records a *planned* dashboard "Notifications widget" over the same contract; it is **not** a prerequisite for GAP-9.

---

## 10. Persistence/lifecycle

**Persisted — yes.** Authoritative model/table: `core_db."Notification"` (see §4.1). Summary:

- **Primary key:** `id` (TEXT). · **Tenant key:** `tenantId` (nullable; snapshotted from the recipient). · **Recipient key:** `userId` (FK → `User(id)` ON DELETE CASCADE). · **Created:** `createdAt` DEFAULT now().
- **Read state:** `readAt` (null = unread). **Payload:** `title`, `body` (plain text, length-bounded), `type` (`NotificationType`), `sourceType`/`sourceId` (opaque, non-FK back-reference — survives the source's deletion).
- **Indexes:** `(userId, createdAt DESC, id DESC)` and `(userId, readAt)`.
- **Retention/deletion policy:** none declared (rows live until the user is deleted, then cascade). **Dismiss/delete: not supported.** **Idempotency/dedup:** none — `createForUser` is not deduplicated; the caller must avoid duplicate emissions (every existing caller relies on the business act firing once).

**Transient/event-only alternative:** the AMQP side (`NotificationPublisher` → `domain_events`) is transient and carries **no** notification persistence; the only durable artifact of a failed publish is a best-effort `AuditDispatch` retry row (an *audit* concern, not a notification).

No new schema is proposed in this phase.
---

## 11. Commerce notification port audit

`commerce-notification.gateway.ts` (Phase C1 Step H) — **not a port for the user-notification contract; a thin transport adapter.**

| Question | Answer (from source) |
|---|---|
| Exact methods | one: `publish(actor, eventType, payload): Promise<void>` |
| Typed? | `actor` is a structural literal `{ tenantId; requestId; correlationId? }`; `eventType: string`; `payload: Record<string, unknown>` — **no notification type union** (deliberately deferred; the file says declaring one would be an invention) |
| Sync or async? | `async`, but the underlying publish is best-effort |
| What it promises | stamps `tenantId`, `correlationId` (falls back to `requestId`), `emittedAt` **after** the payload spread, so a payload key can't displace them |
| Recipient semantics? | **none** — the gateway carries no recipient rule |
| Tenant scope? | `tenantId` from the actor (server-side), applied last |
| Fire-and-forget? | effectively yes — `NotificationPublisher.publish` never throws |
| Errors surfaced? | no; failures are swallowed by the publisher (audit-retry fallback only) |
| Idempotency? | none |
| Versioned events? | no |
| Wired to a real adapter? | yes — `NotificationPublisher` (RabbitMQ). With `RABBITMQ_URL` unset it is a no-op that logs and records an audit retry |
| Used by Commerce? | yes — two call sites (`purchase.service.ts:411`, `workflow-line-routing.service.ts:182`) |
| Owner | Commerce (`@Injectable`, exported by `CommerceModule`); the underlying transport is Core (`NotificationPublisher`) |

**Mismatch against the authoritative Platform contract.** The port is a **transport** seam only. The authoritative user-notification capability is `NotificationService.createForUser` — a *different shape* (explicit recipient + content, synchronous, persisted) — and the gateway does **not** expose it. Commerce emits events into `domain_events`, while the only notification writer is unreachable from any consumer of those events. **No code modifies the port in this phase.**

Boundary facts that matter for remediation:
- `commerce-gateways.spec.ts` gate I9 asserts **only `commerce-notification.gateway.ts` may hold `NotificationPublisher|notification.publisher`**, and forbids `PrismaService`/generated clients in **all three** gateways. It does **not** name `NotificationService`.
- `architecture-boundaries.spec.ts` forbids independent modules from importing Core/Observability **Prisma services/modules** (`database/prisma.service|module`) directly — it does **not** forbid importing `notifications/notification.service` (nor `notifications/notification.module`, which both HR and Commerce already import).
- Commerce's own gate I19 forbids any async work (`setInterval`/`setTimeout`/`@nestjs/schedule`/Bull/`cron`/`queue`) in Commerce source files — **so a Commerce-owned queue consumer is architecturally impossible**; any consumer must be a Platform/Core concern.

---

## 12. Test/e2e audit

| Test file | What it proves | Class |
|---|---|---|
| `test/notifications.e2e-spec.ts` (real Core DB) | ownership; **tenant isolation** (peer same-tenant + other-tenant both invisible) across list/count/markRead/markAllRead; privacy; pagination; mark-read idempotency; mark-all scoping; **no client create route** (404); `createForUser` snapshots recipient tenant; markup refused | **user-visible + tenant isolation + read/unread** |
| `src/notifications/notification.service.spec.ts` | ownership predicate, allowlisted projection, pagination, ordering, mark-read idempotency, content/source validation | **integration (contract unit-level)** |
| `src/notifications/notification.publisher.spec.ts` | no credential fallback; broker-state handling | **transport-only** |
| `platform/audit/audit-ingest.consumer.spec.ts` | the one `domain_events` consumer (`audit.#`) acks/nacks correctly | **transport-only** (not a notification) |
| `src/modules/commerce/commerce-gateways.spec.ts` | gate I9: notification infra behind ONE Commerce surface | **architecture/policy** |
| `src/support/support.service.spec.ts` | a Core module notifies the right recipient and **excludes the actor** via `createForUser` | **recipient selection** |
| `src/calendar/reminder-dispatcher.service.spec.ts` | reminder → `createForUser(INFORMATION)` | **recipient selection** |
| `hr-isolation.spec.ts`, `commerce-isolation.spec.ts` | module boundaries | **architecture/policy** |
| web `notifications-api.spec.ts`, `CoreNotificationBell.spec.tsx`, `CoreNotificationsView.spec.tsx` | client mirrors the 4 routes; badge/bell behaviour | **user-visible (frontend)** |

**What is proven today:** the authoritative Notification Center is correct, persistent, user-scoped and tenant-isolated; Core modules can and do create user notifications; the frontend consumes the center.

**What is NOT proven (the GAP-9 hole):** there is **no** test — anywhere — that any `commerce.*` event (or any `domain_events` message) becomes a user-visible notification, and **no** test that Commerce creates a notification for any recipient. The two `commerce.*` events are transport-only, and nothing asserts a consumer exists. This absence is the whole of GAP-9.
---

## 13. GAP-9 classification

### **PLATFORM-CONTRACT-EXISTS-COMMERCE-WIRING-MISSING**

**Rationale (all source-backed):**

- The authoritative, user-facing notification contract **exists and is complete** for everything GAP-9 asks about an existing system: persistence (`Notification` table), user notifications, persisted read/unread, unread count, recipient = explicit `userId`, tenant scoping, list/mark API, badge, and tested tenant isolation (§4, §8, §9, §10, §12). This rules out **TRANSPORT-ONLY** and **CLOSED**.
- The contract is **reachable from Commerce today**: `CommerceModule` already imports `NotificationModule`, which exports `NotificationService`; and no boundary spec (`architecture-boundaries`, gate I9) forbids a Commerce *service/gateway* from holding `NotificationService` (only `NotificationPublisher`, Prisma clients, and async work are constrained). So this is **not** BLOCKED-BY-CONTRACT, and the minimal fix is a **Commerce** task.
- The gap is exactly one thing: **Commerce never creates a user-facing notification.** Its two `commerce.*` events are transport/domain events with no consumer, and no Commerce service calls `createForUser` (§5, §6, §12).

**Why not PLATFORM-CONTRACT-INCOMPLETE:** every *critical* piece required for **safe** Commerce integration is present — creation enforces recipient existence, tenant snapshotting and content safety; reads enforce ownership + tenant; the boundary rules are satisfied by an in-process call. No new platform capability is a *prerequisite*.

**Secondary defect (recorded, does not change the classification):** two documentation/architecture issues are true and should be filed, but neither blocks the minimal closure:
1. a **phantom consumer** — the HR *and* Commerce gateway headers assert "a consumer in Core creates the in-app notifications"; no such consumer exists (only `AuditIngestConsumer` binds `domain_events`);
2. **no `platform.notification@v1` port** — unlike audit/search/identity/entitlement, the user-notification capability is not exposed as a bounded-context port, so bounded contexts face two idioms (in-process `createForUser` vs. an event with no consumer). This is the ambiguity that made GAP-9 look unsolved.
---

## 14. Evidence-backed remediation contract

Smallest source-backed closure. **No implementation in this phase.**

**Authoritative contract owner:** Core — `src/notifications/` (`NotificationService` / the `Notification` table / the `/notifications` controller). Do **not** build a second one.

**Exact missing capability:** Commerce never creates a user-facing notification. Fix by wiring the existing domain moments to the existing `NotificationService.createForUser`, through the existing `CommerceNotificationGateway` (the one sanctioned surface).

**Exact Commerce integration point:** extend `commerce-notification.gateway.ts` to hold `NotificationService` **alongside** `NotificationPublisher` and expose a user-addressed method (e.g. `notifyUser(actor, recipientId, {type,title,body,sourceType,sourceId})`) that: excludes the actor, swallows failures (never fails the business op), and calls `createForUser`. Update gate I9 to keep the "one surface" invariant while allowing the new method. Call it from the existing emit points only.

**Event(s) to consider — only where the contract supports a recipient:**
- `commerce.purchase_document.submitted` → notify the **workflow step assignee(s)/approver(s)** for the created instances ("درخواست X منتظر تأیید شماست") and/or the **liaison** (`liaisonUserId`). *Recipient must be a Core user id.*
- workflow **approval / rejection / cancellation** (currently event-less) → notify the **requester** (`requesterId`). These need a new emit point but **no** new platform contract.
- Do **not** invent notifications for payment/receiving/return/completion without a documented recipient rule.

**Recipient source:** Commerce's own predicates — workflow step assignee (`WorkflowExecutionRepository`), `requesterId`, `liaisonUserId`, commercial approver. The actor is always excluded. **The event→recipient mapping must be written down in the implementation contract** (it is not defined today).

**Tenant boundary:** unchanged — `createForUser` snapshots the recipient's own tenant; Commerce passes no tenant into creation (the optional tenant field is only an assertion). No new isolation logic.

**Persistence / read-unread expectations:** reuse the existing `Notification` table and `readAt` semantics. **No new table, no new column, no migration.**

**API/UI implications:** **none.** The four `/notifications` routes and the bell/view already serve any Center row generically. No new endpoint; no frontend change required to close GAP-9 (a per-type icon/label would be a separate, optional UX phase).

**Tests required (implementation phase):**
- gateway unit: `createForUser` is called with the resolved recipient and correct tenant snapshot, the actor is **never** the recipient, and a `createForUser` failure never fails the business operation;
- e2e: a submitted purchase yields an unread notification for the approver and **not** for the submitter; a decision yields one for the requester; tenant isolation (approver in another tenant sees nothing);
- keep/refresh gate I9 so the "one surface" invariant still holds with the added method.

**Whether a Platform contract phase is required first:** **No** for the minimal closure — the in-process `createForUser` path is already DI-available and boundary-legal.

**Whether Commerce-only work is sufficient:** **Yes** for the minimal closure.
### A. Platform work
- **Not required** for the minimal closure.
- **Optional / separate** (file as its own platform item, do **not** fold into GAP-9): (a) build the missing `domain_events` consumer that maps `commerce.*` / `mission.*` → `createForUser`, **if** the async idiom is elected; (b) introduce a `platform.notification@v1` port (mirroring `AUDIT_PORT`/`SEARCH_SOURCE_PORT`) so bounded contexts have one sanctioned seam; (c) correct the HR/Commerce gateway headers that assert a consumer that does not exist. Any consumer must live in **Core/Platform** — gate I19 forbids async work inside Commerce.

### B. Commerce backend work
- Extend `CommerceNotificationGateway` (hold `NotificationService`; add `notifyUser`), update gate I9, and call it from the submit + decision points with the recipients named above. This is the entire GAP-9 closure.

### C. Frontend work
- **None required.** Do not build UI ahead of the backend capability — the bell/view already render the Center.

---

## 15. Explicit non-goals

- No new notification subsystem, port, table, column, migration, endpoint, queue, consumer, worker or scheduler.
- No change to `NotificationService`, `NotificationController`, `NotificationPublisher`, the Core schema/migration, or the `/notifications` contract.
- No change to `CommerceNotificationGateway`, `CommerceModule`, or the two existing `commerce.*` emissions in this phase.
- No event→notification consumer built here; no `platform.notification@v1` port invented here.
- No recipient rule invented (the event→recipient mapping is deferred to the implementation contract, sourced from existing Commerce concepts only).
- No frontend change; no seed/fixture change; no test run; no runtime change.
---

## 16. STOP/BLOCKED reason

**Not stopped. Not blocked.** Every STOP condition is affirmatively cleared by source:

- **Authoritative owner established:** Core `src/notifications/` (§4).
- **No incompatible contracts:** there is exactly one user-notification contract; the AMQP side is transport-only, not a competing contract (§3, §5).
- **Recipient semantics defined:** explicit Core `userId`; the Center does not resolve audiences, and Commerce's candidate recipient sources already exist (§7). *The Commerce event→recipient mapping is unset — that is the implementation contract's job, not an ambiguity to work around.*
- **Tenant isolation defined and tested** (§8).
- **No new cross-platform architecture required:** the minimal closure reuses the existing in-process `createForUser` path (§14).

The only ambiguity recorded is the **two-idiom** situation (in-process vs. event-with-no-consumer). It is resolved in favour of the **authoritative in-process contract**, which does not require inventing anything.

---

## FINAL RESPONSE (preflight summary)

- **GAP-9 classification:** `PLATFORM-CONTRACT-EXISTS-COMMERCE-WIRING-MISSING`.
- **Real user-notification contract exists?** **Yes** — the Phase 49E Notification Center (Core).
- **Authoritative owner:** Core — `src/notifications/` (`NotificationService`, `Notification` table, `/notifications` API).
- **Exact Commerce capability currently missing:** Commerce never creates a user-facing notification (it emits two transport-only `commerce.*` events and never calls `createForUser`).
- **Recipient model:** explicit Core `userId` supplied by the caller; the Center resolves no audience. Commerce's candidate sources: workflow step assignee/approver, `requesterId`, `liaisonUserId`, commercial approver; actor excluded.
- **Tenant isolation model:** `Notification.tenantId` snapshotted from the recipient; every read/update keyed on `{ userId, tenantId }` from the request context; tested (e2e).
- **Platform work required?** **No** for the minimal closure (in-process `createForUser` is already reachable and boundary-legal). *Optional* platform items exist (missing event→notification consumer; no notification port).
- **Exact next implementation phase:** a **Commerce-only** wiring phase that extends `CommerceNotificationGateway` to call `NotificationService.createForUser` at the submit/decision points with resolved recipients, plus tests.
- **Files changed (this phase):** `docs/PHASE-COMMERCE-GAP-9-PREFLIGHT.md` (this report) — **only**. No source, schema, migration, DTO, seed, frontend or routing file touched.
- **Checks performed:** read-only searches/reads over `apps/api/{src,prisma,test}`, `apps/web/src`, `docs/**`; `git status`. No build, test, migration or DB write.
- **Blockers:** none.