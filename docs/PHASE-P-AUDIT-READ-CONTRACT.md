# PHASE P-AUDIT-READ — PLATFORM AUDIT READ CONTRACT

**Status:** `PLATFORM AUDIT READ CONTRACT COMPLETE — PORT READ ONLY (no HTTP, no migration, no Commerce work)`

**Scope:** the platform read capability required to unblock future bounded contexts (Commerce
GAP-7 first among them). No Commerce Timeline, no Reporting, no Search, no Notifications, no
event backfill, no Commerce/HR/observability changes, no frontend changes, no schema change, no
migration, no new permission.

Classification tags used throughout: `[CONFIRMED]` (read directly in source), `[DERIVED]`
(logically follows from confirmed source), `[PROPOSED]` (suggestion, not implemented),
`[UNKNOWN]`, `[DECISION REQUIRED]`.

**Git baseline (§34):** HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`, with
substantial pre-existing uncommitted work from phases C1–C5 + UI (Commerce code, docs, web
components — recorded in §FILES). No commits, resets, checkouts, cleans or reverts were
performed in this phase.

---

## A. EXISTING AUDIT OWNERSHIP

- **`core_db."AuditLog"` is owned by Core/platform.** `[CONFIRMED]`
  `prisma/core/schema.prisma:445-481`; `PlatformAuditModule` binds `AUDIT_PORT` →
  `PlatformAuditService` via `useExisting` and exports ONLY the token
  (`platform-audit.module.ts:36-42`).
- **`observability_db` is a separate trail** — `ObservabilityAuditService` never touches
  `core_db."AuditLog"` (`observability-audit.service.ts:41-42`). `[CONFIRMED]`
- **Commerce owns no audit storage.** `CommerceAuditGateway` "must never write a Commerce audit
  table" (`commerce-audit.gateway.ts:77-79`). `[CONFIRMED]`
- **This phase moves nothing.** No `commerce_db` audit table, no `observability_db` mirror, no
  `reporting_db` mirror was created; the single authoritative audit source remains Platform
  Audit. `[CONFIRMED by diff — see §FILES]`

## B. EXISTING WRITE CONTRACT (UNCHANGED)

- `AuditPort.record(event: AuditEventInput): Promise<AuditRecordResult>` — `auditId` required and
  producer-owned, `tenantId` required, closed rejection codes, never throws, discriminated
  result (`audit.contract.ts`). `[CONFIRMED]`
- One enforcement point: `validateAuditEvent` shared by the in-process binding and the queue
  consumer. `[CONFIRMED]`
- Redaction happens at WRITE time through `redactPayload`
  (`platform-audit.service.ts`, `common/audit.service.ts`). `[CONFIRMED]`
- Writers catalog: `PlatformAuditService` (the binding), `AuditIngestConsumer`, Commerce's and
  HR's gateways, plus the legacy `AuditService`. **`record()` behavior is untouched by this
  phase** — only the interface gained a second method. `[CONFIRMED]` (existing writer specs pass
  unchanged; see §VALIDATION)

## C. NEW READ CONTRACT

- `read(...)` was added to the SAME port, satisfied by the SAME Core binding, because the
  prompt's required flow is `Bounded Context → Gateway → AUDIT_PORT.read → PlatformAuditService →
  core_db.AuditLog` (§17). `[CONFIRMED — implemented]`
- The read is **additive**: no writer, no consumer and no module import changed. Bounded contexts
  reach audit data only through the port; no Commerce/Core Prisma access was added anywhere.
  `[CONFIRMED]`

## D. PORT SIGNATURE

```ts
// apps/api/src/platform/audit/audit.contract.ts
export interface AuditPort {
  record(event: AuditEventInput): Promise<AuditRecordResult>;
  read(query: AuditReadQuery): Promise<AuditReadResult>;
}
```

- Typed end to end; no Prisma model crosses the port; no `query(sql)`, no `query(where)`, no
  `findMany(options: any)` abstraction exists anywhere in the contract (§5 prohibition satisfied
  structurally). `[CONFIRMED]`

## E. REQUEST TYPE

```ts
export interface AuditReadQuery {
  tenantId: string;      // REQUIRED — trusted caller context, never client input
  resource: string;      // REQUIRED — AuditLog.resourceType (e.g. commerce.purchase_document)
  resourceId: string;    // REQUIRED — the bounded resource instance
  action?: string;       // optional exact match on AuditLog.action
  from?: string;         // optional inclusive lower bound on createdAt (ISO-8601)
  to?: string;           // optional exclusive upper bound on createdAt (ISO-8601)
  page?: number;         // 1-based, default 1
  pageSize?: number;     // 1..AUDIT_READ_MAX_PAGE_SIZE, default 20
}
```

- Validated by the pure `validateAuditReadQuery` — THE one place the contract is enforced,
  called by the binding and by every contract-driven test fake. `[CONFIRMED — implemented]`
- Why `resource`+`resourceId` are REQUIRED (§8): the confirmed use case is "the events of a
  known bounded resource"; requiring the pair guarantees every query leads with the existing
  `@@index([resourceType, resourceId])`, bounds the result and its COUNT to one resource, and
  makes "resourceId without resourceType" inexpressible (§23). `[DERIVED]`

## F. RESPONSE TYPE

```ts
export interface AuditReadItem {
  id: string;              // AuditLog.id (row identity, the write result's auditLogId)
  resource: string;        // AuditLog.resourceType, in the port's own vocabulary
  resourceId: string;
  action: string;
  actorId: string | null;  // AuditLog.userId — a safe id, no directory enrichment
  success: boolean;
  reason: string | null;
  changedFields: string[]; // field NAMES only
  createdAt: string;       // ISO-8601 of AuditLog.createdAt (write instant, NOT event time)
}

export interface AuditReadPage {
  items: AuditReadItem[];
  page: number;
  pageSize: number;
  total: number;
}

export type AuditReadResult =
  | { status: 'ok'; page: AuditReadPage }
  | { status: 'rejected'; code: AuditReadRejectionCode };
```

- `{ items, page, pageSize, total }` matches the module-list shape the platform already uses
  (Commerce/HR). `[CONFIRMED convention]`

## G. TENANT CONTEXT

- **Decision: Option A of §6 — `tenantId` is an explicit field of the request, supplied by the
  caller's TRUSTED backend context.** `[DECISION — implemented]` Rationale:
  - It is byte-identical to the write side, where `AuditEventInput.tenantId` is stamped by the
    gateway from `actor.tenantId` and "never a caller-supplied field or a default"
    (`commerce-audit.gateway.ts:60-63,132`). `[CONFIRMED]`
  - The entitlement port's ambient-context alternative (`RequestContextService` read *inside* the
    implementation, `platform-entitlement.service.ts:76-78`) exists because entitlement has ONE
    request path; the audit port is also written from remote/queue contexts where no ambient
    request exists, so a read contract that could not name its tenant would be unusable outside
    an HTTP frame. `[DERIVED]`
- The platform cannot enforce where a FUTURE HTTP boundary gets its tenant; it enforces what it
  owns: the field is required, validation fails closed (`AUDIT_READ_TENANT_MISSING`), and every
  query predicate carries `tenantId`. At the HTTP boundary the established rule stands: tenant
  from `resolveCommerceActor(req)`/`RequestContextService`, never from `body/query/params/headers`
  (`commerce-actor.ts:18-30,69-77`). `[CONFIRMED as the established rule]`
- **Legacy tenant-less rows are unreachable by construction** (`tenantId = <string>` never matches
  NULL), which is the correct outcome: they are `LEGACY-HISTORICAL`, not any tenant's data
  (schema comment `prisma/core/schema.prisma:434-439`). `[CONFIRMED — asserted by test]`

## H. AUTHORIZATION

- **PLATFORM AUDIT READ PERMISSION REQUIRED: NONE NEW.** `admin.audit.read` already exists
  (`permissions.ts:50`), is domain ADMIN, is granted to SUPER_ADMIN, ADMIN and SECURITY_ADMIN
  (`roles.ts:53,137,210`), and is seeded idempotently (`prisma/core/migrations/
  20260828093000_seed_admin_permission_grants/migration.sql:34,62,76`). Its own catalogue comment
  states it "gates `core_db."AuditLog"`". `[CONFIRMED]` No permission was invented, widened or
  renamed (§7 stop condition avoided).
- **Port level:** the read is an in-process seam. Authorization is structural — only modules that
  import `PlatformAuditModule` hold the token, and every read is tenant-scoped by a required,
  trusted `tenantId`. The port deliberately carries NO permission parameter, matching `record`,
  `ENTITLEMENT_PORT` and `USER_DIRECTORY`, none of which do RBAC (RBAC is an HTTP-boundary
  concern: `RolesGuard` + `@Roles(...)`). `[CONFIRMED as the platform port idiom]`
- **Consumer level (future):** Commerce's own timeline route must gate with `commerce.read` +
  the module entitlement gate, exactly as every existing Commerce GET does (C6 §K).
  `[CONFIRMED convention; DERIVED for the future route]`

## I. ALLOWED FILTERS

| Filter | Field | Required | Semantics |
|---|---|---|---|
| tenant | `tenantId` | yes | equality on `AuditLog.tenantId` |
| resource type | `resource` | yes | equality on `AuditLog.resourceType` |
| resource id | `resourceId` | yes | equality on `AuditLog.resourceId` |
| action | `action` | no | exact match on `AuditLog.action` |
| time window | `from` / `to` | no | `gte from` (inclusive) / `lt to` (exclusive) on `createdAt` |
| paging | `page` / `pageSize` | no | see §K |

- **Nothing else exists**: no free text, no `ILIKE`, no metadata/JSON predicate, no payload
  search, no actor filter, no correlation filter, no ORDER BY parameter, no projection parameter,
  no SQL (§8/§18 prohibitions satisfied by construction). `[CONFIRMED — implemented]`
- `action` was adopted in the single-string form rather than C6's sketched "action set": no
  confirmed consumer needs a multi-action filter, and a set is an additive extension later.
  `[DECISION]`
- `actorId` filtering was EVALUATED and EXCLUDED: no current consumer needs "events by person",
  and it is a privacy-heavier query shape than the confirmed use case (§8: include only what the
  contract needs). `[DECISION]`

## J. ORDERING

- **Fixed: `createdAt ASC, id ASC`.** `[DECISION — implemented]` Not a parameter (§11: no
  business chronology invented; a direction knob is surface with no consumer).
- `createdAt` is the ONLY chronology the trail persists; `occurredAt` is a producer clock that
  has no column (`AuditDigestSubject` comment, `audit.contract.ts:232-238`). The item doc says
  "write instant, not event time" so no caller can read it as business time. `[CONFIRMED]`
- `id` (unique) makes the order TOTAL — two events in the same millisecond cannot make a page
  duplicate or lose a row (§11 requirement, asserted by test). `[CONFIRMED — tested]`
- Ascending was chosen because it is chronological for a bounded resource timeline, is the
  candidate C6 recorded (§Y4), and keeps EARLIER PAGES STABLE while the append-only trail grows
  — new rows land after the pages already read. `[DERIVED]`

## K. PAGINATION

- `page` (default 1) + `pageSize` (default **20**, ceiling **100**) — the platform's business-list
  convention (Commerce/HR `DEFAULT_PAGE_SIZE=20`, `MAX_PAGE_SIZE=100`; C6 §Y2 asked for
  "ceiling ≤ 100 per platform convention"). `[CONFIRMED convention]`
- `pageSize > 100` is REJECTED (`AUDIT_READ_PAGE_INVALID`), not silently clamped, because the
  port has no DTO layer in front of it and a caller bug should be visible. `[DECISION]`
- `page` has no artificial ceiling: the row predicate (one resource) is what bounds the scan.
  `[DECISION]`
- The result set is always bounded (`take ≤ 100`), `total` is a COUNT under the SAME predicate
  read in the SAME array-form transaction as the page (page and total cannot disagree),
  and there is **no unbounded export mode** (§10 satisfied). `[CONFIRMED — implemented]`
- No cursor: offset paging matches the platform's list convention; the deterministic order
  (§J) is what protects page integrity. A future cursor would be an upgrade, not a correction.
  `[PROPOSED for the future]`

## L. PROJECTION

- `AuditReadItem` (§F) is the ONLY shape that crosses the port. Prisma models never leave the
  service; the mapping is one function (`toReadItem`) that translates table names into port
  vocabulary (`resourceType→resource`, `userId→actorId`, `Date→ISO string`). `[CONFIRMED —
  implemented]`
- The enforcement is a **SQL-level whitelist**: `SAFE_AUDIT_SELECT` names the nine readable
  columns, so a column ADDED TO `AuditLog` IN THE FUTURE is not readable until the contract names
  it — the default for new columns is "not exposed". `[CONFIRMED — implemented]`
- **Actor enrichment: NOT performed.** The item returns the stored actor id (`userId`); no
  `USER_DIRECTORY` call, no batch lookup, no N+1 (§13/§29). Batch display-name enrichment, if a
  consumer ever needs it, is a future platform capability. `[DECISION]`

## M. SENSITIVE FIELDS

Excluded from BOTH the SELECT and the projection, asserted by name in tests:

| Field | Why excluded |
|---|---|
| `tenantId` | the scope, never data; the caller already knows its tenant (C6 §O rule) |
| `ipAddress` | request-identifying metadata (§13) |
| `userAgent` | request-identifying metadata (§13) |
| `sessionId` | authentication-adjacent (§13) |
| `oldValue` / `newValue` / `changes` | raw snapshots — see §N |
| `requestId` / `correlationId` | correlation ids, "not exposed by default" (C6 §P) |
| `durationMs` | not justified by any read-contract need |
| `auditId` | producer idempotency identity; no consumer needs it to render a timeline |

`[CONFIRMED — implemented + tested]`

## N. SNAPSHOT POLICY

- **No existing contract authorizes ANY reader of `core_db."AuditLog"` to see snapshots** (§15).
  The only existing projection — `/users/me/login-history` — selects `ipAddress`/`userAgent` for
  the CALLER'S OWN login rows only and never snapshots (`users.service.ts:74-92`). `[CONFIRMED]`
- Therefore `oldValue`/`newValue`/`changes` are **not exposed**, and the read applies
  least-privilege by EXCLUSION rather than by re-running `redactPayload`: "redacted on write" is
  never trusted to make a payload safe for all readers (§14), and no second, incompatible
  redaction engine was introduced. `[DECISION — implemented]`
- A future before/after display is a separate contract decision (§15), not a flag. `[PROPOSED]`

## O. CONSISTENCY

- **`[CONFIRMED]` in-process read-after-write is immediate**: `record()` awaits
  `prisma.auditLog.create` before returning (`platform-audit.service.ts`), and the read queries
  the same database — a row is committed before the caller's HTTP response returns, so a
  subsequent read observes it. No queue sits on this path.
- **`[CONFIRMED]` the remote ingest path is eventually consistent BUT INACTIVE**: no code
  publishes `platform.audit@v1` envelopes to `audit.#`, and with `RABBITMQ_URL` unset the
  consumer declines to start (`audit-ingest.consumer.ts`, PHASE_51 closure report §E8). If it
  ever activates, remote rows would be eventually consistent — this contract does not claim
  otherwise and no "real-time" wording appears anywhere in it.
- **`[CONFIRMED]` page/total atomicity**: one array-form `$transaction([findMany, count])`, the
  same shape the module list repositories use.

## P. PERFORMANCE

- The predicate ALWAYS leads with `resourceType` + `resourceId`, which is exactly the existing
  composite index; the tenant equality narrows WITHIN one resource's rows (typically tens of
  rows), and `createdAt` ordering sorts that small set. `[DERIVED from schema + query]`
- `total` is a COUNT under the same predicate — same bound, no trail-wide scan.
  `[DERIVED]`
- No free-text/`ILIKE` (cannot use an index), no JSON-path predicate, no cross-module join, no
  per-row directory lookup. One request = one bounded query pair (page + count). `[CONFIRMED —
  implemented]`

## Q. INDEX USAGE / MIGRATION

- **NO MIGRATION (§31 default honored).** `[CONFIRMED — no schema file touched]`
- Analysis of the actual query: `WHERE tenantId = ? AND resourceType = ? AND resourceId = ? [AND
  action = ?] [AND createdAt range] ORDER BY createdAt ASC, id ASC LIMIT/OFFSET` + `COUNT(*)`
  over the same predicate.
  - `@@index([resourceType, resourceId])` (schema line 475) serves the REQUIRED leading equality
    pair — every read is an index range scan over ONE resource. `[DERIVED]`
  - The optional `action`/window narrowers are post-filters over that small set; `@@index([createdAt])`
    exists but is not required for ordering a per-resource result. `[DERIVED]`
  - `tenantId` has no index (the schema deliberately declares none — "an index nobody queries is a
    write cost with no reader", `prisma/core/schema.prisma:441-444`). Within a resource-scoped
    range the tenant filter is cheap, so NO index was added. `[DERIVED — DECISION]`
- C6 §Y7's optional `@@index([tenantId, resourceType, resourceId])` was EVALUATED and DECLINED:
  the confirmed contract cannot issue the tenant-leading, resource-less scan it would serve.
  Re-evaluate only if a resource-less read is ever contracted (it is not). `[DECISION]`
- Not run: `prisma migrate deploy` — genuinely not required (no schema/migration/client change);
  `prisma validate` is the correct check for an unchanged schema.

## R. ERROR SEMANTICS

- **Port (implemented):** `read` NEVER THROWS (the port's established idiom, shared with
  `record`); it returns `{ status: 'ok', page } | { status: 'rejected', code }` with a closed code
  set: `AUDIT_READ_QUERY_INVALID`, `AUDIT_READ_TENANT_MISSING`, `AUDIT_READ_RESOURCE_MISSING`,
  `AUDIT_READ_RESOURCE_ID_MISSING`, `AUDIT_READ_PAGE_INVALID`, `AUDIT_READ_RANGE_INVALID`,
  `AUDIT_READ_FAILED`. `[CONFIRMED — implemented + tested]`
- **HTTP (NOT implemented — future mapping, documented so a consumer cannot invent it):**
  - **401** unauthenticated (`JwtAuthGuard`, global) `[CONFIRMED convention]`
  - **403** unauthorized (`RolesGuard` + the permission the surface chooses) and the fail-closed
    403 when no tenant context resolved `[CONFIRMED convention — commerce-actor.ts:73-77]`
  - **422** invalid query parameters (the platform's ValidationPipe answers 422)
    `[CONFIRMED convention]`
  - **500/503** `AUDIT_READ_FAILED` (storage refused) `[DERIVED]`
  - **404 — deliberately absent:** an unknown `resourceId` answers an EMPTY page, so the contract
    is not a resource-existence oracle and nothing leaks whether a foreign resource exists
    (§23, asserted by test). `[CONFIRMED — tested]`
  - **409 — not applicable:** no conflict semantics exist for a read (§22).

## S. FAKE / TEST CONTRACT

- **One shared, contract-driven fixture:** `test/fixtures/fake-audit-port.ts` exports
  `createFakeAuditPort(events)`. Its `read` validates through the SAME `validateAuditReadQuery`
  the production binding uses, applies the same tenant/resource/action/window rule, the same
  insertion-order (= `createdAt ASC, id ASC`) and the same projection — so a harness cannot pass
  while production would fail (§24: "contract-driven, not invented per test"). `[CONFIRMED —
  implemented]`
- The three Commerce e2e harnesses (`commerce-lifecycle`, `commerce-integration`,
  `commerce-tenant`) now bind that fixture; their `record` behaviour is byte-identical to what
  they had (append + `recorded`), so every pre-existing assertion keeps its meaning.
  `[CONFIRMED — all 66 e2e tests pass]`
- `audit-ingest.consumer.spec.ts` builds its port via `as unknown as AuditPort` and is unaffected.
  `[CONFIRMED]`
- New platform tests: `audit-read.contract.spec.ts` (the validator, §A/E/I/K) and
  `platform-audit-read.spec.ts` (the service: P-A…P-E, tenant isolation, filters, ordering,
  pagination, invalid query, storage failure, §27 compatibility, writer regression).

## T. COMMERCE COMPATIBILITY (§27)

- The confirmed future consumer query — `resource = 'commerce.purchase_document'`,
  `resourceId = <purchase id>` — is representable and executable exactly as specified, with:
  - NO Commerce Prisma, NO Core Prisma from Commerce, NO JSON payload parsing, NO mirrored audit
    data. `[CONFIRMED — asserted in both new specs]`
- The read result is already in the module-list envelope Commerce's HTTP layers produce
  (`{items, page, pageSize, total}`), so a future gateway can pass it through without reshaping.
  `[DERIVED]`
- **Commerce GAP-7 / Timeline was NOT implemented** (§27/§35): no Commerce service, gateway
  method, controller, DTO, frontend component or route was added or modified in this phase.
  `[CONFIRMED by diff]`
- The known Commerce event-coverage gaps (workflow decisions, pending-inbox operations) remain
  un-audited and untouched — inventing events is not this phase's job (§28). `[CONFIRMED]`

## U. FUTURE HTTP POSSIBILITY

- **No HTTP surface was added.** `[DECISION]` Reasons, from source:
  1. §16/§17: the PORT contract is the primary and required deliverable; Commerce consumes
     audit data in-process through `CommerceAuditGateway`, and §17 forbids making Commerce call
     Core HTTP just to get audit data.
  2. `platform/audit` has no controller and the platform has no audit-HTTP convention
     (`platform/audit` = contract + service + consumer + module only). `[CONFIRMED]`
  3. A platform admin surface would need a cross-tenant question ("which tenants may ADMIN
     read?") that no source answers — inventing it would violate §7/§6.
- **IF a platform audit HTTP surface is later added**, it MUST: reuse `admin.audit.read` (§H —
  no new permission), derive tenant from the trusted server context (never the query string),
  keep the same projection and bounds, and be a separate contract decision.
  `[PROPOSED / DECISION REQUIRED]`
- The forward-looking nav entries `/admin/audit` are still not routes today
  (`preferences/nav-catalogue.ts:196-208`). `[CONFIRMED]`

## V. EXPLICIT LIMITATIONS

1. **`createdAt` is the write instant, not business event time.** The trail persists no
   `occurredAt`; a delayed write is therefore timestamped when it landed. `[CONFIRMED]`
2. **Legacy tenant-less rows are unreachable** through this read (§G). They remain legacy
   history; no backfill or tenant inference was performed (§31 no-schema-change, §28 no-backfill).
   `[CONFIRMED]`
3. **No cross-resource correlation.** The only supported correlation is `resourceType` +
   `resourceId` on the row itself (§9). Payment/receipt/return events for one purchase document
   are NOT authoritatively correlated (C6 §H) and this contract does not fake it — no snapshot
   JSON is parsed for joins. `[CONFIRMED]`
4. **Single-action filter only**; no action sets, no actor filter, no date presets, no sorting
   parameter, no projection parameter (§I).
5. **Actor ids only** — no display names, no directory calls (§L).
6. **No export, no bulk read**: `pageSize ≤ 100` per request.
7. **No HTTP** in this phase (§U).
8. **`total` is a COUNT** — correct under the same predicate, but it is not cached or
   approximated.

## W. UNKNOWN

- Whether `USER_DIRECTORY` supports batched by-id profile lookup — never verified, because the
  contract deliberately needs no enrichment (C6 §X raised this; §29 answer: not needed).
  `[UNKNOWN — unused]`
- Whether Observability will ever mirror `core_db."AuditLog"` — its own migration comment forbids
  it today; not consulted further. `[UNKNOWN as intent; CONFIRMED as current rule]`
- Whether a future consumer will want newest-first ordering or multi-action filters — no consumer
  exists to ask; both are contract amendments, not flags (§X). `[UNKNOWN]`

## X. DECISION REQUIRED (none of these are implemented)

1. **Platform admin HTTP audit surface** (§U): whether Core should expose one at all, and which
   tenants an ADMIN may read across — requires an explicit platform decision; `admin.audit.read`
   is ready when it happens.
2. **Ordering direction parameter** if/when a confirmed consumer needs newest-first pages.
3. **Action-set / actor-id filters** if/when a confirmed consumer needs them (both additive).
4. **Batch actor display-name enrichment** as a platform capability (§29) — only if a consumer
   needs names, batched, never per-row.

## Y. EXPLICITLY REJECTED ASSUMPTIONS

1. **"The observability `audit-events` endpoint can serve this."** Rejected — wrong database and
   trail (`observability-read.service.ts:148`). `[CONFIRMED]`
2. **"Commerce may read `AuditLog` via Core Prisma directly."** Rejected — bounded-context rule;
   the gateway's own doc forbids importing a Core generated client, and the isolation suites
   enforce it. `[CONFIRMED]`
3. **"Correlate events by parsing `newValue.purchaseDocumentId`."** Rejected — JSON payload is
   not a contract field, is unindexed, and is invented correlation (§9). `[CONFIRMED]`
4. **"Create a Commerce/observability/reporting audit mirror."** Rejected — two trails that
   disagree about what "recorded" means (§4). `[CONFIRMED]`
5. **"Reuse `login-history` as a generic audit read."** Rejected — self-scoped, action-locked,
   parameterless; not a contract (§2/C6 §Z7). `[CONFIRMED]`
6. **"Add `query(sql)` / `findMany(options: any)`-style port surface."** Rejected — §5 forbids a
   generic query language; the closed `AuditReadQuery` is the whole surface. `[CONFIRMED]`
7. **"Let the caller pass a tenantId as its authorization."** Rejected — tenant is a REQUIRED
   scope, never an authorization source; the HTTP boundary derives it from the authenticated
   principal (§G), and absence fails closed.
8. **"Invent a new `platform.audit.read` permission."** Rejected — `admin.audit.read` already
   exists for exactly this table (§H). `[CONFIRMED]`
9. **"Expose snapshots / IP / user agent because they are persisted (and redacted)."** Rejected —
   §13/§14/§15; exclusion, not re-redaction. `[CONFIRMED]`
10. **"Add a tenant-leading composite index now."** Rejected — no contracted query needs it; an
    index with no reader is a write cost (§Q). `[CONFIRMED]`
11. **"A read port implies a public HTTP endpoint."** Rejected for this phase (§U, §16).
12. **"Free-text search over audit payloads."** Rejected — §18 (no search engine) and the
    observability DTO's own documented DoS reasoning. `[CONFIRMED]`

## VALIDATION EXECUTED (§38)

All commands run from `apps/api` through `node node_modules/<tool>` (PowerShell execution policy
blocks `npx` on this machine — environment detail, not a phase failure).

| # | Check | Result |
|---|---|---|
| 1 | Targeted platform/audit tests (`jest src/platform/audit`) | **5 suites / 107 tests passed**, exit 0 |
| 2 | All AuditPort tests (contract + binding + consumer + new read specs, all in 1) | **107 passed** |
| 3 | Full API unit suite (`jest`) | **202 suites / 3320 tests passed, 0 failed** |
| 4 | Architecture tests (`test:architecture`) | **24 / 24 passed**, exit 0 |
| 5 | Policy tests (`test:policy`) | **32 / 32 passed**, exit 0 |
| 6 | TypeScript `tsc -p tsconfig.json --noEmit` | **exit 0, zero diagnostics** |
| 7 | `prisma validate` — `prisma/core/schema.prisma` | **valid** |
| 8 | `prisma validate` — `prisma/commerce/schema.prisma` | **valid** (pre-existing uncommitted schema, validated for safety) |
| 9 | E2E, live DB: `commerce-lifecycle` + `commerce-integration` + `commerce-tenant` | **3 suites / 66 tests passed**, exit 0 |
| 10 | `prisma generate` | **NOT RUN — genuinely not required** (no schema/migration/client change) |
| 11 | `migrate deploy` | **NOT RUN — no migration exists** (§Q/§31: none was justified) |
| 12 | HTTP e2e | **N/A — no HTTP endpoint was added** (§U) |
| 13 | Frontend tests / web build | **NOT RUN — no frontend file touched** |

**Counts, classified:**
- **Baseline (C6 record):** 200 unit suites / 3284 tests, 24 architecture, 32 policy, 3 e2e
  suites / 66 tests — 0 failures.
- **This phase:** 202 / 3320, 24, 32, 66 — **0 failures**. The +2 suites / +36 tests are exactly
  the two new spec files (21 contract tests + 15 service tests). Baseline suites — including
  every existing audit writer, `audit.contract.spec`, `platform-audit.service.spec`,
  `audit-ingest.consumer.spec`, `commerce-gateways.spec`, `commerce-isolation.spec`, HR
  boundaries and both policy suites — all pass UNCHANGED (§P-F, §Q).
- **Environment:** 0 failures. One pre-existing Jest worker-teardown WARNING (non-failing,
  unrelated to audit) appears in the full-suite log under `.tmp/p-audit-read-unit.err.log`.

**§26 platform proof paths (executable):** P-A record→read (service spec, one binding, one
table) · P-B resource filtering · P-C tenant isolation (A vs B, items AND totals) · P-D
pagination determinism/no-dup/no-loss · P-E sensitive-field projection (select + item shape) ·
P-F writer regression (all three live-DB harnesses + full suite). A live-DB platform e2e was
deliberately NOT added: there is no HTTP surface to exercise, the binding's behaviour is proven
by the service specs against the Postgres-emulating table, and writing throwaway rows into the
append-only live audit trail from a test would pollute the very table this contract protects.
`[DECISION]`

## FILES CHANGED BY THIS PHASE

**Modified:**
- `apps/api/src/platform/audit/audit.contract.ts` (+227/−1) — read contract types, constants,
  `validateAuditReadQuery`, `AuditPort.read`. The −1 is the old one-method interface doc.
- `apps/api/src/platform/audit/platform-audit.service.ts` (+165/−0) — `read()`, safe select,
  range/mapping helpers. `record()` untouched.
- `apps/api/test/commerce-lifecycle.e2e-spec.ts`, `apps/api/test/commerce-integration.e2e-spec.ts`,
  `apps/api/test/commerce-tenant.e2e-spec.ts` — exactly two hunks each: the audit-contract import
  and the `createFakeAuditPort` binding. **These three files already carried pre-existing
  uncommitted C1–C5 work; those hunks were NOT authored or reverted by this phase.**

**Created:**
- `apps/api/src/platform/audit/audit-read.contract.spec.ts` (21 tests)
- `apps/api/src/platform/audit/platform-audit-read.spec.ts` (15 tests)
- `apps/api/test/fixtures/fake-audit-port.ts` (shared contract-driven fake)
- `docs/PHASE-P-AUDIT-READ-CONTRACT.md` (this document)

**NOT touched:** `docs/PHASE-C6-AUDIT-READ-TIMELINE-CONTRACT.md` (remains the record of why
Commerce was blocked), any Prisma schema, any migration, any Commerce business file, any
observability file, any web file, any permission/role/seed file, `.tmp/` run logs (git-ignored).

## GIT STATUS (§34)

- HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`, **no commits made**.
- Baseline pre-existing modified/untracked files (Commerce C1–C5, UI phases, web components,
  backups, secrets, docs) remain exactly as recorded at phase start — verified by comparing
  `git status` before/after: the only NEW entries are the four created files above and the five
  modified files listed above (three of which were already modified at baseline).
- No `reset`, `clean`, `checkout`, `revert`, `rebase` or `squash` was executed.

## ACCEPTANCE CRITERIA (§37)

- [x] Audit ownership confirmed / storage ownership unchanged (§A)
- [x] Existing `record()` contract remains compatible (§B, tests green)
- [x] `AUDIT_PORT` read capability exists, typed, no arbitrary SQL (§C–§F)
- [x] Tenant context trusted; tenant isolation verified (§G, tests)
- [x] Authorization verified — existing `admin.audit.read`, no new permission (§H)
- [x] Resource/resourceId filtering verified; resourceId-without-type refused (§I, §23)
- [x] Safe projection exists; sensitive metadata excluded; snapshots excluded (§L–§N, tests)
- [x] Pagination bounded; ordering deterministic (§J/§K, tests)
- [x] Query uses justified indexes; **no migration** (§Q)
- [x] No Commerce/Core DB bypass; no Commerce audit mirror (§A, architecture tests 24/24)
- [x] Test fake updated (contract-driven, shared) (§S)
- [x] Platform unit tests green (202/3320); integration/e2e green (66); writers regress green
- [x] Architecture/policy tests green (24/24, 32/32)
- [x] TypeScript green; Prisma valid
- [x] Documentation complete (this file; C6 untouched)
- [x] Commerce compatibility verified (§T, tests)
- [x] No Commerce Timeline, no Reporting/Search/Notification work (§T/§35)

---

**END OF DOCUMENT —** `PLATFORM AUDIT READ CONTRACT COMPLETE`





