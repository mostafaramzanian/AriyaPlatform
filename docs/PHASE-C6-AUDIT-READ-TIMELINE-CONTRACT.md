# PHASE C6 — GAP-7: AUDIT READ / PURCHASE TIMELINE CONTRACT

**Status:** `COMMERCE BACKEND PARTIALLY COMPLETE — GAP-7 BLOCKED BY AUDIT READ CONTRACT`

**Scope:** GAP-7 only. No Reporting (GAP-4), no Search (GAP-5), no Quotation (GAP-6),
no Identity/Seed (GAP-8), no Notifications (GAP-9), no GAP-ENV. No new Audit subsystem.
No frontend changes. No migration. No code changes of any kind in this phase — the
discovery below proves that a safe Commerce audit read surface cannot be built from the
contracts that exist today.

Classification tags used throughout: `[CONFIRMED]` (read directly in source),
`[DERIVED]` (logically follows from confirmed source), `[PROPOSED]` (a suggestion that
is NOT implemented and requires platform approval), `[UNKNOWN]`, `[DECISION REQUIRED]`.

---

## 0. OUTCOME OF THE DECISION GATE (§3)

The phase prompt defines four outcomes. The measured answer is **B — PARTIAL**:

| Question | Answer | Class |
|---|---|---|
| Does `AUDIT_PORT` support a read/query operation? | **NO.** `AuditPort` declares exactly one method: `record(event): Promise<AuditRecordResult>` (`apps/api/src/platform/audit/audit.contract.ts:148-150`). | `[CONFIRMED]` |
| Does the port binding (`PlatformAuditService`) expose a read? | **NO.** Only `record` + an internal `findUnique` used for idempotency (`platform-audit.service.ts:83`), never a query surface. | `[CONFIRMED]` |
| Does the legacy `AuditService` expose a read? | **NO.** Only `log(...)` (`apps/api/src/common/audit.service.ts:52`). | `[CONFIRMED]` |
| Does any other production endpoint read `core_db."AuditLog"`? | **One:** `GET /users/me/login-history` — self-scoped (`where: { userId, action: { in: ['login','login_failed'] } }`, `take: 25`, fixed `select`) (`apps/api/src/users/users.service.ts:74-92`). Not a resource-scoped query and not a reusable contract. | `[CONFIRMED]` |
| Does `GET /admin/observability/audit-events` read the trail Commerce writes? | **NO.** It reads `observability_db` — "Audit events from observability_db. `core_db.\"AuditLog\"` is read by its own endpoints." (`observability-read.service.ts:148`). Different database, different table, admin-only audience. | `[CONFIRMED]` |
| Is there an audit read method anywhere in Commerce? | **NO.** `CommerceAuditGateway` declares only `record(...)` (`commerce-audit.gateway.ts:115`). No Commerce controller, service or web client (`apps/web/src/lib/commerce-api.ts`) references audit/timeline reads. | `[CONFIRMED]` |

Therefore, per §3-B and §36: **GAP-7 is blocked until a platform Audit read contract is
defined.** Per §36 the agent stops here instead of: querying `core_db."AuditLog"`
directly from Commerce, touching Core/Observability Prisma, creating a Commerce audit
mirror, inventing correlation fields, or inventing audit events.

Evidence for "one read only": a recursive scan of `apps/api/src` (excluding
`generated/`) for `auditLog.` returns exactly five production call-site families —
`audit-dispatcher.service.ts:32` (internal retry ledger), `audit.service.ts:81,128`
(writer + P2002 replay), `platform-audit.service.ts:83,91,118` (writer + idempotency),
and `users.service.ts:75` (the login-history read). Corroborated by the platform's own
migration comment enumerating `core_db."AuditLog"`'s "three consumers — AuditService.log
(writer), AuditDispatcherService (RabbitMQ redelivery) and UsersService.getLoginHistory"
(`apps/api/prisma/observability/migrations/20260905140000_add_observability_platform/migration.sql:16-19`).

---

## A. AUDIT OWNERSHIP

- **`core_db."AuditLog"` is owned by Core/platform.** `[CONFIRMED]`
  `PlatformAuditModule` is registered in `core-app.module.ts:164` explicitly "because the
  trail is `core_db.\"AuditLog\"`: a process with no Core database can host neither the
  writer nor the consumer".
- **`observability_db` is owned by the Observability platform** and "reads nothing from
  core_db" (`core-app.module.ts:189-192`). `[CONFIRMED]`
- **Commerce owns no audit storage.** "Commerce keeps NO audit table of its own" and
  `CommerceAuditGateway` "must never write a Commerce audit table"
  (`commerce.constants.ts:64`, `commerce-audit.gateway.ts:77-79`). `[CONFIRMED]`
- Commerce is and remains a **consumer** of audit capabilities through `AUDIT_PORT` only.
  `[CONFIRMED]`

## B. EXISTING AUDIT PORT CAPABILITY

```ts
// apps/api/src/platform/audit/audit.contract.ts:148-150
export interface AuditPort {
  record(event: AuditEventInput): Promise<AuditRecordResult>;
}
```

- Token: `AUDIT_PORT = 'AuditPort'`; descriptor `platform.audit@v1`;
  binding `AUDIT_PORT → PlatformAuditService` via `useExisting`
  (`platform-audit.module.ts:36`). `[CONFIRMED]`
- The interface doc is explicit that a module may "hand the platform ONE event" —
  the port is a **write seam by design**, not a facade over the table. `[CONFIRMED]`
- **There is no read method, no query DTO, no audit read contract, no audit read HTTP
  route and no audit read capability in the port.** `[CONFIRMED]`
- The `platform/audit` directory contains only `audit.contract.ts`,
  `platform-audit.service.ts`, `audit-ingest.consumer.ts`, `platform-audit.module.ts`
  and their specs — **no controller**. `[CONFIRMED]`

## C. EXISTING AUDIT WRITE CONTRACT (what a future read must mirror)

- `AuditEventInput` fields: `auditId` (required, producer UUID), `tenantId` (required),
  `requestId?`, `correlationId?`, `actorId?`, `action`, `resource`, `resourceId`,
  `occurredAt?`, `success?`, `reason?`, `ip?`, `userAgent?`, `sessionId?`, `durationMs?`,
  `changedFields?`, `oldValue?`, `newValue?` (`audit.contract.ts:92-116`). `[CONFIRMED]`
- Rejection codes are a closed set (`AUDIT_ENVELOPE_INVALID`, `AUDIT_CONTRACT_MISMATCH`,
  `AUDIT_ID_MISSING`, `AUDIT_ID_INVALID`, `AUDIT_TENANT_MISSING`, `AUDIT_ACTION_MISSING`,
  `AUDIT_RESOURCE_MISSING`, `AUDIT_RESOURCE_ID_MISSING`, `AUDIT_WRITE_FAILED`).
  `[CONFIRMED]`
- `record` never throws; result is `recorded | duplicate | conflict | rejected`.
  `[CONFIRMED]`
- Table: `core_db."AuditLog"` (`prisma/core/schema.prisma:445-481`) — columns
  `id, auditId, requestId, tenantId, correlationId, userId, ipAddress, userAgent,
  sessionId, action, resourceType, resourceId, oldValue, newValue, changedFields,
  success, reason, durationMs, changes, createdAt`; indexes `userId`, `createdAt`,
  `(resourceType, resourceId)`, `requestId`. `[CONFIRMED]`
- Writes redact payloads through `redactPayload` (`platform-audit.service.ts:3`,
  `common/audit.service.ts:58-73`). `[CONFIRMED]`

## D. EXISTING COMMERCE AUDIT RESOURCES

`COMMERCE_AUDIT_RESOURCE` (`commerce.constants.ts:72-164`) — the closed vocabulary,
each value the `resourceType` column of `core_db."AuditLog"` `[CONFIRMED]`:

| Constant | Value | Row it names |
|---|---|---|
| `PURCHASE_DOCUMENT` | `commerce.purchase_document` | the purchase document itself |
| `WORKFLOW_DEFINITION` | `commerce.workflow_definition` | workflow container |
| `WORKFLOW_DEFINITION_VERSION` | `commerce.workflow_definition_version` | one version |
| `PAYMENT_RECORD` | `commerce.payment_record` | one payment event |
| `RECEIPT` | `commerce.receipt` | one receiving event |
| `RETURN_DOCUMENT` | `commerce.return_document` | one return document |
| `COMMERCIAL_GROUP` | `commerce.commercial_group` | one commercial group |
| `COMMERCIAL_CONFIGURATION_VERSION` | `commerce.commercial_configuration_version` | one config version |
| `COMMERCIAL_ASSIGNMENT` | `commerce.commercial_assignment` | current assignment row of one line |
| `COMMERCIAL_APPROVAL` | `commerce.commercial_approval` | one approval decision |
| `PURCHASE_COMPLETION_POLICY_VERSION` | `commerce.purchase_completion_policy_version` | one completion policy version |

## E. EXISTING COMMERCE AUDIT ACTIONS (write inventory)

Ten services record audit history; pinned by `commerce-isolation.spec.ts:1352-1365`
(`AUDITED_SERVICES`) `[CONFIRMED]`:

1. `commercial/commercial-configuration.service.ts`
2. `commercial/commercial-lifecycle.service.ts`
3. `completion/purchase-completion-policy.service.ts`
4. `completion/purchase-completion.service.ts`
5. `payment/payment-history.service.ts`
6. `purchase/purchase.service.ts`
7. `receiving/receiving-history.service.ts`
8. `returns/return-history.service.ts`
9. `workflow/workflow-configuration.service.ts`
10. `workflow/workflow-line-routing.service.ts`

Action vocabularies (all `[CONFIRMED]`, declared beside their record calls):

| Source | Actions |
|---|---|
| `PURCHASE_AUDIT_ACTION` (`purchase.service.ts:94`) | `create`, `update`, `submit` |
| `PURCHASE_COMPLETION_AUDIT_ACTION` (`completion.constants.ts:68`) | policy: `created`, `updated`, `validated`, `published`, `archived`; document: `close` |
| `PAYMENT_AUDIT_ACTION` (`payment-history.service.ts:52`) | `append`, `compensate` |
| `RECEIVING_AUDIT_ACTION` (`receiving-history.service.ts:59`) | `append`, `compensate` |
| `RETURN_AUDIT_ACTION` (`return-history.service.ts:75`) | `create`, `approve`, `reject`, `receive_back`, `refund` |
| `COMMERCIAL_AUDIT_ACTION` (`commercial.constants.ts:39`) | `created`, `updated`, `liaison_changed`, `validated`, `published`, `archived`, `assigned`, `reassigned`, `unassigned`, `decided` |
| `WORKFLOW_AUDIT_ACTION` (`workflow-configuration.service.ts:111`) | `create`, `update_version`, `rename`, `validate`, `publish`, `archive`, `add_step`, `update_step`, `delete_step`, `reorder_steps` |
| line routing (`workflow-line-routing.service.ts:369`) | dynamic `` `line_routing_${action}` `` on `PURCHASE_DOCUMENT` |

Measurement of call sites: 35 `this.audit.record(` occurrences across the ten services
(recursive scan of `*.service.ts`). Repositories never audit. `[CONFIRMED]`

Explicitly NON-audited (pinned `UNAUDITED_SERVICES`, `commerce-isolation.spec.ts:1368-1385`)
`[CONFIRMED]`:

- `workflow/workflow-execution.service.ts` — **the decision pipeline (`approveStep` /
  `applyDecision`) settles a workflow instance and records NO audit event** — the one
  documented exclusion (D7 keeps it a measured fact).
- `pending/pending-decisions.service.ts` — read-only projection, no command to audit.
- `workflow/workflow-line-routing-configuration.service.ts` — rule resolution, no delegate write.
- `database/commerce-prisma.service.ts` — infrastructure.

## F. EXISTING AUDIT READ CONTRACT

**There is no platform Audit read contract.** `[CONFIRMED]` Everything that exists:

1. `GET /users/me/login-history` (`users.controller.ts:51`) — reads
   `core_db."AuditLog"` with `where: { userId: sessionUser, action: { in: ['login',
   'login_failed'] } }`, `orderBy: { createdAt: 'desc' }`, `take: 25`, fixed `select`
   (`users.service.ts:74-92`). Self-scoped, action-locked, hard-capped, no parameters.
   It is a login-history screen endpoint, **not a query contract** any module can reuse.
2. `PlatformAuditService.record`'s internal `findUnique({ where: { auditId } })` —
   idempotency, not a read surface.
3. `AuditDispatcherService.findUnique({ where: { id } })` — the legacy retry ledger.
4. `GET /admin/observability/audit-events` (`observability.controller.ts:105`) — a real
   paginated read contract (`AuditEventQueryDto`, `action`/`resourceType` filters, time
   range, page/pageSize), gated by `admin.observability.read` — **but it answers from
   `observability_db`, a different trail** (`observability-read.service.ts:148`), and
   Commerce audit rows are not there. Not reusable for GAP-7. `[CONFIRMED]`
5. HR — the reference bounded context for the port idiom — also has **no** audit read
  route; its specs read `prisma.auditLog` test-side only. `[CONFIRMED]`

## G. TIMELINE CONTRACT

- **No timeline contract can be stated authoritatively today, and none was built.**
  Per §16/§36, adding `GET /commerce/purchase-documents/:id/timeline` without a port read
  would require bypassing the port (direct Core DB access) or inventing a contract —
  both forbidden. `[CONFIRMED]`
- The product concept remains `[PROPOSED]` for whenever the platform defines a read:
  route shape would follow existing Commerce REST conventions (`purchase.controller.ts`
  resource style), served `Controller → resolveCommerceActor → read service →
  CommerceAuditGateway → AUDIT_PORT`.
- **Frontend compatibility (§29): no change needed.** The Purchase Detail «رویدادها»
  tab already states honestly: "تاریخچهٔ کامل مممیزی از طریق Commerce در دسترس نیست"
  (`CommercePurchaseDetailView.tsx:811-816`), built only from reads the page performs.
  UI-0: "no Commerce activity/timeline read exists (audit lives in the platform trail,
  not exposed through Commerce routes)" and the events tab is "clearly not an audit log"
  (`PHASE-UI-0-COMMERCE-UX-CONTRACT.md:818-822`). UI-5 pins GAP-7 as STILL OPEN. No
  placeholder is broken by this phase. `[CONFIRMED]`

## H. RESOURCE CORRELATION (can a PurchaseDocument timeline be sourced?)

| Audit family | `resourceId` | Document relation in the audit row | Authoritative for a timeline? |
|---|---|---|---|
| `commerce.purchase_document` (`create`/`update`/`submit`/`close`/`line_routing_*`) | **the document id** | direct, indexed by `@@index([resourceType, resourceId])` | **YES** `[CONFIRMED]` |
| `commerce.payment_record` | payment row id | `purchaseDocumentId` **inside `newValue` JSON only** (`payment-history.service.ts:146`) — no column, no index, not a contract field | NO `[CONFIRMED]` |
| `commerce.receipt` | receipt row id | `purchaseDocumentId` inside `newValue` JSON only (`receiving-history.service.ts:289`) | NO `[CONFIRMED]` |
| `commerce.return_document` | return doc id | **no document id in the audit row at all** (`return-history.service.ts:386-389`) | NO `[CONFIRMED]` |
| `commerce.commercial_assignment` | assignment row id | `newValue.purchaseLineId` only — line→document lives in `commerce_db` | NO `[CONFIRMED]` |
| `commerce.commercial_approval` | approval row id | neither line nor document id in the audit row (`commercial-lifecycle.service.ts:1026-1037`) | NO `[CONFIRMED]` |
| configuration resources (group / config version / workflow def+version / completion policy version) | config row id | none — tenant-scoped configuration, not document-scoped by design | NO `[CONFIRMED]` |
| workflow execution decisions | — | **not audited at all** (§E) | NO — NOT AUDITED `[CONFIRMED]` |

Consequence `[DERIVED]`: even with a port read contract, an honest initial timeline can
contain **only `resourceType = 'commerce.purchase_document' AND resourceId = <docId>`**
events (index-backed, tenant-scoped). Recovering payment/receipt/return/assignment rows
for a document would need either JSON-payload filtering (not a contract field, unindexed)
or a `commerce_db` join from Core-side code (cross-database, forbidden). §19 permits
exposing only authoritatively correlated events — that is exactly this one family.

## I. TENANT SEMANTICS

- **Write side** `[CONFIRMED]`: the gateway stamps `tenantId: actor.tenantId` from the
  actor, "never a caller-supplied field or a default" (`commerce-audit.gateway.ts:60-63,132`);
  the platform contract makes `tenantId` mandatory (`audit.contract.ts:209-215`), so
  tenant-less rows are only the provably historical legacy ones.
- **Read side: undefined — no read contract exists to scope.** `[CONFIRMED]` Any future
  read MUST take the tenant from `resolveCommerceActor(req)` → request context →
  audit read boundary; `req.body/query/params.tenantId` and client headers are never
  consulted (`commerce-actor.ts:18-30`), and a request with no resolved tenant fails
  closed with 403 (`commerce-actor.ts:73-77`). `[CONFIRMED as the established rule]`
- Timeline tenant-isolation tests (C6-E): **not written — blocked** (no endpoint).
  `[BLOCKED BY CONTRACT]`

## J. ACTOR / VISIBILITY

- No audit-read visibility model exists anywhere to reuse: no tenant-wide, owner-scoped,
  role- or permission-based audit read has ever been defined for `core_db."AuditLog"`
  beyond "your own login rows". `[CONFIRMED]`
- The established Commerce read anatomy is: `JwtAuthGuard` → `@Roles(...)` →
  `resolveCommerceActor` → service scopes by `actor.tenantId`
  (`CommerceActor = { tenantId, userId, requestId, correlationId?, ip, userAgent }`).
  `[CONFIRMED]` A future timeline read would follow it unchanged. `[DERIVED]`

## K. PERMISSION

- **Candidate for a future timeline read: `Permissions.COMMERCE_READ` (`commerce.read`)** —
  the permission every existing Commerce GET route declares (`commercial.controller.ts:91,98,132,139,243`;
  `purchase-completion-policy.controller.ts:92,99`), plus the module's entitlement gate.
  `[CONFIRMED as convention; DERIVED as candidate — no new permission created]`
- `admin.observability.read` governs ONLY the observability_db admin surface (holders:
  SUPER_ADMIN, ADMIN, OPERATIONS_ADMIN — `roles.ts:72,202,217,248`). It is not a
  Commerce permission and was not reused or widened. `[CONFIRMED]`

## L. PAGINATION

- **No pagination concept exists on `AUDIT_PORT`** — there is nothing to page.
  `[CONFIRMED]`
- Conventions a future contract should align with (all `[CONFIRMED]`):
  Commerce lists use `resolveCommercePageWindow` — `page`/`pageSize`,
  `COMMERCE_DEFAULT_PAGE_SIZE = 20`, `COMMERCE_MAX_PAGE_SIZE = 100`
  (`commerce.constants.ts:189-192`, `dto/commerce-query.dto.ts`), DTO-enforced ceiling
  plus service clamp. The observability reader uses `page/pageSize`,
  `DEFAULT_PAGE_SIZE = 50`, `MAX_PAGE_SIZE = 100` — different trail, same ceiling shape.
- No timeline endpoint and no pagination was implemented. `[CONFIRMED]`

## M. ORDERING

- **No audit-read ordering contract exists.** `[CONFIRMED]` Source precedents only:
  login-history orders `createdAt desc`; `AuditLog` carries `@@index([createdAt])`;
  Commerce's deterministic list convention is `(createdAt, id)` (returns §4-A);
  observability orders `occurredAt desc, id` tie-break.
- For a future timeline, a technical deterministic order (`createdAt` + `id` tie-break)
  is the only justifiable default until the platform contract states one; no business
  priority may be invented. `[PROPOSED]`

## N. FILTERS

- No filter is available through the port. `[CONFIRMED]` The observability DTO shows the
  filter shape a platform reader could mirror (`action`, `resourceType`, `from`/`to`,
  paging) — but for a different database. `[CONFIRMED]`
- Any future filter must be applied server-side inside the tenant/permission boundary and
  must never weaken it. `[PROPOSED]`

## O. RESPONSE SCHEMA

- **No response schema exists — no endpoint exists.** `[CONFIRMED]`
- If (and only if) the platform defines a read, the Commerce wire projection would be a
  whitelist DTO `[PROPOSED, not implemented]`, roughly:
  `{ items: [{ action, resource, resourceId, success, reason?, changedFields?,
  actorUserId, createdAt }], page, pageSize, total }` — with `tenantId` NEVER echoed
  (the module's rule: a row is scoped by a tenant; the scope never reaches the body),
  and presentation labels kept separate from raw audit actions (§7).

## P. SENSITIVE-FIELD HANDLING

- `AuditLog` stores `ipAddress`, `userAgent`, `sessionId` and before/after snapshots;
  both writers pass payloads through `redactPayload` at write time
  (`platform-audit.service.ts:3`, `common/audit.service.ts:58-73`). `[CONFIRMED]`
- The one existing projection (`login-history`) exposes `ipAddress`/`userAgent` **only
  for the caller's own login rows**. `[CONFIRMED]`
- Rule for any future read: reuse only an authoritative platform presentation
  projection; **if the platform has none, that is itself a second blocker.** Raw
  `oldValue`/`newValue`, IP, user agent, session id and correlation/request ids must not
  be exposed by default, and no Commerce-side ad-hoc redaction layer may be invented —
  redaction stays platform-owned. `[PROPOSED]`

## Q. CONSISTENCY MODEL

- **In-process path is strongly consistent:** `CommerceAuditGateway.record` awaits
  `AUDIT_PORT.record`, which awaits the `prisma.auditLog.create` insert
  (`platform-audit.service.ts:91`) — the row is committed before the business HTTP
  response returns. `[DERIVED from confirmed source]`
- The remote path (`audit.#` on `domain_events` → `AuditIngestConsumer`) would be
  eventually consistent, but **no code publishes platform audit envelopes yet**
  (`docs/reports/PHASE_51-HR-ARCH-3B_CLOSURE.md:104`), and with `RABBITMQ_URL` unset
  the consumer declines to start. `[CONFIRMED]`
- A future UI must not imply stronger or weaker consistency than the platform contract
  states. `[PROPOSED]`

## R. ERROR TAXONOMY (conventions a future endpoint would inherit)

- **401** — `JwtAuthGuard` (global). `[CONFIRMED]`
- **403** — `RolesGuard` (`@Roles(commerce.read)`), or the fail-closed 403 when no
  tenant context resolved (`commerce-actor.ts:73-77`). `[CONFIRMED]`
- **404** — tenant-scoped resource lookup, foreign and unknown indistinguishable
  (e.g. `NotFoundException('Purchase document not found')`,
  `payment-history.service.ts:81-82`) — no existence leak across tenants. `[CONFIRMED]`
- **422** — production `ValidationPipe` (422 + `VALIDATION_FAILED`) for invalid query
  parameters. `[CONFIRMED]`
- **409** — only where a genuine conflict exists today (e.g. completion
  `WRITE_CONFLICT`). No 409 is invented for audit reads; no audit read exists.
  `[CONFIRMED]`

## S. PERFORMANCE (requirements a future query must meet)

- Index-backed scoping: `@@index([resourceType, resourceId])` supports the only honest
  timeline filter (§H), plus pagination bounds (§L). **Note: `AuditLog` has NO
  `tenantId` index** (`schema.prisma:473-480`) — a tenant+resource query would filter
  the tenant as a residual predicate. Adding an index is a **platform-owned migration**
  and was explicitly NOT taken here (§34). `[CONFIRMED]`
- Actor display names: no batch directory enrichment exists for audit rows; whether
  `USER_DIRECTORY` supports batch by-id lookup is `[UNKNOWN]`. Until confirmed, the only
  safe representation is the stored actor id — **no per-row directory call**. `[PROPOSED]`
- No polling, no background jobs, no N+1 — none exist today and none were added.
  `[CONFIRMED]`

## T. SECURITY

- Tenant restriction is server-side and structural (`resolveCommerceActor`); client
  tenant input in any position is never consulted. `[CONFIRMED]`
- Single audit surface enforcement: `CommerceAuditGateway` documents that the Step-H
  guard "scans the module for a second reference [to `AUDIT_PORT`] and fails", and
  `commerce-isolation.spec.ts` pins the audited/unaudited service lists and the
  one-gateway rule. `[CONFIRMED]`
- This phase added **zero** database access: Commerce still references no Core or
  Observability generated client (verified by the unchanged isolation/architecture
  suites below). `[CONFIRMED]`

## U. EXISTING AUDIT COVERAGE (write side) — classification per family

| Family | Classification | Evidence `[CONFIRMED]` |
|---|---|---|
| document `create`/`update`/`submit` | **CLOSED** (written) | `purchase.service.ts:187,303,389` |
| document `close` (completion) | **CLOSED** | `purchase-completion.service.ts:143` |
| line-routing acts on the document | **CLOSED** | `workflow-line-routing.service.ts:368` |
| payments `append`/`compensate` | **CLOSED** | `payment-history.service.ts:141,243` |
| receiving `append`/`compensate` | **CLOSED** | `receiving-history.service.ts:284,394` |
| returns `create`/`approve`/`reject`/`receive_back`/`refund` | **CLOSED** | `return-history.service.ts:382,478` |
| commercial group + configuration lifecycle (10 actions) | **CLOSED** | `commercial-configuration.service.ts` (7 calls) |
| commercial assignment + approval decision | **CLOSED** | `commercial-lifecycle.service.ts:555,923,1026` |
| completion policy lifecycle (5 actions) | **CLOSED** | `purchase-completion-policy.service.ts` (5 calls) |
| workflow definition/version lifecycle (10 actions) | **CLOSED** | `workflow-configuration.service.ts` (9 calls) |
| workflow **execution decisions** (`approveStep`/`applyDecision`) | **NOT AUDITED** | `commerce-isolation.spec.ts:1345-1350,1378-1380` (measured exclusion) |
| pending-decision inbox | **NOT AUDITED** (read-only projection) | `commerce-isolation.spec.ts:1381-1384` |
| **read** of any of the above through an API | **BLOCKED BY CONTRACT** | §0, §F |
| PurchaseDocument timeline endpoint | **BLOCKED BY CONTRACT** | §G |

## V. MISSING / PARTIAL COVERAGE

- Audit read surface: **BLOCKED BY CONTRACT** (this phase's stop condition).
  `[CONFIRMED]`
- Document lineage columns for payment/receipt/return/assignment/approval audit rows:
  **PARTIAL** — present only inside `newValue` JSON or only in `commerce_db` rows; never
  as a queryable audit column. `[CONFIRMED]`
- Workflow decision events: **NOT AUDITED** — adding them would be a Commerce write-side
  change, a separate decision (§33 forbids it here); regardless, no read exists today.
  `[CONFIRMED]`
- Configuration events inside a document timeline: **NOT IN DOMAIN as document events** —
  those resources are tenant-scoped configuration by their own declared design.
  `[DERIVED]`

## W. LIMITATIONS (what a future timeline can honestly promise)

- The only honest completeness statement is: **"Timeline contains the audit events
  covered by the current Audit contract."** `[PROPOSED wording]`
- Even with a read contract, the initial timeline could contain ONLY the
  `commerce.purchase_document` family (§H): document create/update/submit/close and
  line-routing acts. Payment, receiving, return, assignment and approval events would
  be absent (no authoritative correlation), configuration events out of scope, and
  workflow decisions invisible forever (never audited). `[DERIVED]`
- No backfill is possible or permitted: missing events stay missing (§20). `[CONFIRMED]`
- Test harness note: all three Commerce e2e harnesses bind `AUDIT_PORT` to an in-memory
  fake implementing `record` only (`commerce-lifecycle.e2e-spec.ts:524`,
  `commerce-integration.e2e-spec.ts:504`, `commerce-tenant.e2e-spec.ts:476`). A future
  read contract would have to be implemented by that fake too — further evidence that
  the contract must come first. `[CONFIRMED fact; consequence DERIVED]`

## X. UNKNOWN

- Whether the platform intends the read capability to land as a method on `AuditPort`
  v1, a second read port, or a Core-owned HTTP surface — **no ADR or doc in this tree
  defines one**. `[UNKNOWN]`
- Whether `USER_DIRECTORY` supports batch by-id lookup for actor display names.
  `[UNKNOWN]`
- Whether Observability will ever mirror `core_db."AuditLog"` — today it is explicitly
  forbidden by its own migration comment ("Nothing here reads it, copies it, mirrors it").
  `[UNKNOWN as intent; CONFIRMED as current rule]`
- Whether the eventual contract will expose `occurredAt` (the producer clock, not
  persisted) or only `createdAt` (the column) — `AuditDigestSubject` confirms the trail
  has no `occurredAt` column. `[CONFIRMED absent; contract choice UNKNOWN]`

## Y. DECISION REQUIRED — the platform Audit read contract that unblocks GAP-7

**Entirely `[PROPOSED]`; owned by Core/platform (or an ADR), NOT implemented here.**
Minimum contents for the contract:

1. **Read capability location:** either `AuditPort.query(...)` satisfied by
   `PlatformAuditService`, or a Core-owned HTTP/RPC surface over `core_db."AuditLog"`.
2. **Request parameters:** server-supplied `tenantId` (never client-supplied),
   `resource`, `resourceId`, optional `action` set, optional `from`/`to`,
   `page`/`pageSize` (ceiling ≤ 100 per platform convention).
3. **Response:** `{ items, page, pageSize, total }` with an authoritative projection
   whitelist — no `ipAddress`, `userAgent`, `sessionId`, raw `oldValue`/`newValue` by
   default; actor as stored id unless the contract provides display resolution.
4. **Ordering:** deterministic and stated by the contract (candidate for a timeline:
   `createdAt` ascending with `id` tie-break).
5. **Authorization & isolation:** the platform defines who may query the trail; tenant
   isolation is enforced inside the read implementation; Commerce would additionally
   gate its route with `commerce.read` + the entitlement gate.
6. **Consistency statement:** strong for the in-process writer (§Q) must be confirmed
   as part of the read contract.
7. **Optional, platform-owned:** `@@index([tenantId, resourceType, resourceId])` on
   `AuditLog` — a Core migration, explicitly not taken here (§34).
8. **Harness:** the in-memory fake `AuditPort` in the three Commerce e2e harnesses must
   implement the read (contract-driven, not invented per test).

With items 1–6 in place, closing GAP-7 becomes a small Commerce phase: a read method on
`CommerceAuditGateway`, a read service, one `GET` route following existing REST
conventions, and tests C6-A…C6-G as specified in the phase prompt.

## Z. EXPLICITLY REJECTED ASSUMPTIONS

1. **"The observability `audit-events` endpoint can serve the purchase timeline."**
   Rejected — wrong database and trail (`observability-read.service.ts:148`), admin-only
   audience, Commerce rows are not there. `[CONFIRMED]`
2. **"Commerce may read `AuditLog` via the Core Prisma client because the process is
   shared."** Rejected — bounded-context rule; the gateway's own doc forbids importing
   a Core generated client (`commerce-audit.gateway.ts:79-81`), and the isolation suite
   enforces it. `[CONFIRMED]`
3. **"Payment/receipt/return events can join the timeline by parsing
   `newValue.purchaseDocumentId`."** Rejected — JSON payload is not a contract field,
   is unindexed, and would be invented correlation (§19). `[CONFIRMED]`
4. **"Add a read method to `AuditPort` in this phase."** Rejected — a platform-owned
   contract change requiring an explicit decision (§Y), not unilateral Commerce work.
5. **"Create a `commerce_audit` table / mirror."** Rejected — two trails that disagree
   about what "recorded" means; explicitly forbidden (§1). `[CONFIRMED]`
6. **"Backfill or synthesize events so the timeline looks complete."** Rejected (§20). 
7. **"Reuse the `login-history` hard-coded query as a generic audit read."** Rejected —
   self-scoped, action-locked, parameterless; not a contract. `[CONFIRMED]`
8. **"Workflow decisions belong in the timeline because the product concept implies
   them."** Rejected — they are NOT AUDITED (§E); the read must not invent them.
   `[CONFIRMED]`
9. **"Expose raw audit payloads because the data is available."** Rejected (§12) —
   same security philosophy as C2's avoidance of raw condition snapshots.

## AA. VALIDATION EXECUTED (§38) — this phase changed no code

| # | Check | Result |
|---|---|---|
| 1 | TypeScript `tsc -p tsconfig.json --noEmit` | **exit 0**, zero diagnostics |
| 2 | Targeted: `jest src/platform/audit src/modules/commerce` | **43 suites / 711 tests passed**, exit 0 |
| 3 | Full API unit suite `jest` | **200 suites / 3284 tests passed**, exit 0 |
| 4 | Architecture tests (`test:architecture`) | **24 / 24 passed**, exit 0 |
| 5 | Policy tests (`test:policy`) | **32 / 32 passed**, exit 0 |
| 6 | `prisma validate` — `prisma/core/schema.prisma` | **valid**, exit 0 |
| 7 | `prisma validate` — `prisma/commerce/schema.prisma` | **valid**, exit 0 |
| 8 | `prisma generate` / `migrate deploy` | **NOT RUN — genuinely not required**: this phase touched no schema, no migration and no generated client (§34); `validate` is the correct check for an unchanged schema. |
| 9 | E2E, real HTTP: `commerce-lifecycle` + `commerce-integration` + `commerce-tenant` | **3 suites / 66 tests passed**, exit 0 |
| 10 | Frontend tests | **NOT RUN — no frontend file touched** (§29) |
| 11 | Timeline E2E C6-A…C6-G | **NOT WRITTEN — blocked by contract** (§G, §W) |

Failure accounting: **baseline failures 0 · C6 failures 0 · environment failures 0.**
The audit writers of §21 (completion, workflow configuration, line routing, commercial,
payment/receiving/return, purchase lifecycle) are all covered by suites 2/3/9 and
regress green — unchanged, because nothing was changed.

## BB. FILES / GIT

- **Created:** `docs/PHASE-C6-AUDIT-READ-TIMELINE-CONTRACT.md` (this document) — the
  only phase artifact.
- **Code changes: NONE.** No file under `apps/api/src`, `apps/api/prisma`,
  `apps/api/test` or `apps/web/src` was created, modified or deleted by this phase.
- Run logs and runner scripts live under `.tmp/` (git-ignored), consistent with prior
  phases.
- **Git:** HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`. No commits,
  resets, checkouts, cleans or discards were performed. The pre-existing modified /
  untracked files from phases C1–C5 remain exactly as recorded at phase start; the only
  new entry in `git status` is this document (plus the ignored `.tmp/` artifacts).

---

**END OF DOCUMENT —** `COMMERCE BACKEND PARTIALLY COMPLETE — GAP-7 BLOCKED BY AUDIT READ CONTRACT`
