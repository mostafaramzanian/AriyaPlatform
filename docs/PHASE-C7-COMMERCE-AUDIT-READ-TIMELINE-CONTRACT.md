# PHASE C7 — COMMERCE AUDIT READ / PURCHASE DOCUMENT TIMELINE

**Status:** `COMMERCE BACKEND GAP CLOSURE COMPLETE — GAP-7 AUDIT READ / TIMELINE`
(per-family coverage classification in §G; validation evidence in §VALIDATION)

**Scope:** close GAP-7 by consuming the platform's `AUDIT_PORT.read(...)` through the ONE
Commerce audit surface. No new audit storage, no audit mirror, no backfill, no Reporting,
no Search, no Notifications, no Quotation, no frontend change, no migration.

Classification tags: `[CONFIRMED]` (read directly in source), `[DERIVED]` (logically follows
from confirmed source), `[PROPOSED]` (suggestion, not implemented), `[UNKNOWN]`,
`[DECISION REQUIRED]`.

**Git baseline (§41):** HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`,
with the pre-existing uncommitted C1–C5/UI/P-AUDIT-READ work recorded at phase start (§FILES).
No commit, reset, checkout, clean, revert, rebase or squash was performed.

---

## A. OBJECTIVE

Close `GAP-7 — Audit Read / Purchase Document Timeline` by exposing **exactly** the audit
history the platform contract can authoritatively associate with one `PurchaseDocument` —
no more, no less — over a real Commerce HTTP endpoint, backend only.

## B. PLATFORM PREREQUISITE — `P-AUDIT-READ` COMPLETE `[CONFIRMED]`

- `docs/PHASE-P-AUDIT-READ-CONTRACT.md` — the authoritative contract consumed here, not
  redesigned.
- `AuditPort.read(query: AuditReadQuery): Promise<AuditReadResult>` exists on the SAME
  port (`audit.contract.ts`), satisfied by the SAME Core binding (`PlatformAuditService.read`),
  validated by the SAME pure `validateAuditReadQuery`.
- Request: `{ tenantId, resource, resourceId, action?, from?, to?, page?, pageSize? }`;
  `tenantId/resource/resourceId` required and fail-closed; `page` default 1; `pageSize`
  default 20, ceiling `AUDIT_READ_MAX_PAGE_SIZE` = 100.
- Response: `{ status: 'ok', page: { items, page, pageSize, total } }` or
  `{ status: 'rejected', code }` with the closed code set (`AUDIT_READ_QUERY_INVALID`,
  `AUDIT_READ_TENANT_MISSING`, `AUDIT_READ_RESOURCE_MISSING`,
  `AUDIT_READ_RESOURCE_ID_MISSING`, `AUDIT_READ_PAGE_INVALID`, `AUDIT_READ_RANGE_INVALID`,
  `AUDIT_READ_FAILED`). The port NEVER THROWS.
- Ordering: `createdAt ASC, id ASC` (total, stable under appends).
- Projection: least-privilege `AuditReadItem` — no `ip`, `userAgent`, `sessionId`,
  `requestId`, `correlationId`, `tenantId`, `oldValue`, `newValue`, `changes`.
- Test fake: `test/fixtures/fake-audit-port.ts` — contract-driven for BOTH methods;
  reused, not re-implemented.

## C. COMMERCE AUDIT OWNERSHIP — UNCHANGED `[CONFIRMED]`

- Core/platform owns `core_db."AuditLog"`; Commerce owns NO audit storage.
- `COMMERCE_AUDIT_RESOURCE` (`commerce.constants.ts`) remains the closed resource
  vocabulary; no member was added by C7.
- Commerce reaches audit data only through `CommerceAuditGateway`. `commerce-gateways.spec.ts`
  pins that ONLY that file may mention `AUDIT_PORT` / `platform/audit/audit.contract`
  (`AUDIT_TOKENS` scan) — C7 adds no second surface.
- Existing audit WRITES are untouched: all `this.audit.record(` call sites in the ten
  auditing services are byte-identical after C7 (writer regression: full suite green).

## D. `CommerceAuditGateway` — THE SINGLE SURFACE, EXTENDED `[CONFIRMED — implemented]`

New method, the smallest source-consistent extension (`commerce-audit.gateway.ts`):

```ts
async read(query: AuditReadQuery): Promise<AuditReadResult>
```


## E. EXACT TIMELINE RESOURCE `[CONFIRMED]`

```
resource = 'commerce.purchase_document'   // COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT
```

Bound SERVER-SIDE by the service from the closed vocabulary constant — never from a
request field.

## F. EXACT CORRELATION `[CONFIRMED]`

```
resourceId = PurchaseDocument.id   (the route's :id, resolved tenant-scoped first)
tenantId   = actor.tenantId        (resolveCommerceActor → RequestContextService)
```

One bounded read: `resource + resourceId + page/pageSize` (one-query preference — no
multi-resource merge). The document is loaded via
`PurchaseRepository.findDocumentById(tenantId, id)` BEFORE the audit query, so
`resourceId` can never name a resource this tenant does not own. No JSON payload parsing,
no cross-resource correlation, no snapshot inspection, no backfill.

## G. EVENT COVERAGE MATRIX — source-backed `[CONFIRMED]`

Evidence: writer call sites carrying `resource: COMMERCE_AUDIT_RESOURCE.PURCHASE_DOCUMENT`;
correlation column re-verified against current source (C6 §H re-confirmed).

| Event family | Audited | Correlated | Safe to show | Included | Classification |
|---|---|---|---|---|---|
| PurchaseDocument `create` | yes (`purchase.service.ts`) | direct `resourceId` = doc id | yes | yes | **CLOSED** |
| PurchaseDocument `update` | yes (`purchase.service.ts`) | direct | yes | yes | **CLOSED** |
| Submission `submit` | yes (`purchase.service.ts`) | direct | yes | yes | **CLOSED** |
| Completion `close` | yes (`purchase-completion.service.ts`) | direct | yes | yes | **CLOSED** |
| Line routing `line_routing_{routed,no_route_unrouted,no_route_rejected,ambiguous}` | yes (`workflow-line-routing.service.ts`) | direct (`resourceId` = documentId) | yes | yes | **CLOSED** |
| Workflow execution decisions | **NOT AUDITED** (`workflow-execution.service.ts`, the documented exclusion) | — | — | no | **NOT AUDITED** |
| Commercial assignment | yes (`commerce.commercial_assignment` = assignment row id) | `newValue.purchaseLineId` only; line→document lives in `commerce_db`, not in the audit row | no | no | **NOT CORRELATED** |
| Commercial approval | yes (`commerce.commercial_approval` = approval row id) | neither line nor document id in the audit row | no | no | **NOT CORRELATED** |
| Payment / compensation | yes (`commerce.payment_record`) | `purchaseDocumentId` inside JSON payload only — not a contract field, not indexed | no | no | **NOT CORRELATED** |
| Receiving | yes (`commerce.receipt`) | payload only (as above) | no | no | **NOT CORRELATED** |
| Return | yes (`commerce.return_document`) | NO document id in the audit row at all | no | no | **NOT CORRELATED** |
| Configuration events (workflow def+version, completion policy version, commercial group/config version) | yes | tenant-scoped configuration, deliberately not document-scoped | no | no | **NOT CORRELATED** |

Verdict `[DERIVED]`: GAP-7 ships a **truthful PARTIAL timeline** — the whole
`commerce.purchase_document` family and nothing else. No correlation was invented, no
event backfilled. Per-family status: **CLOSED** (document family), **NOT AUDITED**
(workflow decisions), **NOT CORRELATED** (everything else). No family is UNKNOWN.

## H. EXACT ENDPOINT `[CONFIRMED — implemented]`

```
GET /api/v1/commerce/purchase-documents/:id/timeline
```

- Route lives on the EXISTING `PurchaseController` (prefix `commerce/purchase-documents`
  under the global `api/v1`) — the collection that owns `:id` answers for it; no new
  controller, no new prefix, the smallest source-consistent choice
  (`@Get(':id/timeline')`).
- Pinned in `commerce-isolation.spec.ts`: `CONTROLLER_SURFACE` gains
  `'Get|:id/timeline|COMMERCE_READ'`, the purchase route count 6 → 7, the module surface
  64 → 65.
- Path param: `id` — `ParseUUIDPipe({ version: '4' })` → 400 for a non-UUID segment
  `[CONFIRMED convention]`.
- Handler: transport only → `resolveCommerceActor(req)` → `PurchaseTimelineService`.

## I. AUTH `[CONFIRMED]`

- 401 unauthenticated — global `JwtAuthGuard` + controller-level `@UseGuards(JwtAuthGuard)`.
- 403 no resolvable tenant — `resolveCommerceActor` fails closed with the established
  message ("Commerce requires a tenant context…"), never an unscoped read.
- Entitlement: class-level `@RequiresModule('commerce')` + `@RequiresFeature('commerce','purchase')`
  + `ModuleEntitlementGuard` — the same chain as every sibling route.

## J. PERMISSION `[CONFIRMED — source-backed, not pre-approved]`

`@Roles(Permissions.COMMERCE_READ)` (`commerce.read`). Evidence: every READ on this
collection (`GET ''`, `GET ':id'`) already uses `commerce.read`, §10 of the C1 contract
splits reading from changing procurement, and no audit-read permission exists in Core's
five-member Commerce catalogue. A new `commerce.audit.read` was NOT created. `commerce.approve`
/ `commerce.manage` are deliberately absent: this route decides and writes nothing.
Sufficiency AND necessity are e2e-proven (C7-E: read-only member 200, no-permission member 403).

## K. ACTOR `[CONFIRMED]`

`resolveCommerceActor(req)` only — tenant and user from the request context/session, never
from body/query/params/headers. The timeline applies NO narrower "own history" rule:
existing Commerce document reads are tenant-wide for authorized readers, and the timeline
preserves that behavior `[DERIVED from getOne]`. `AuditReadItem.actorId` is the plain user
id the platform stores — returned as-is; NO User-Directory lookups (no N+1), no enrichment
contract invented `[CONFIRMED — P-AUDIT-READ's response carries only the id]`.

## L. TENANT `[CONFIRMED]`

- `tenantId` = `actor.tenantId`, stamped into the query by the service; never accepted
  from any client position (the DTO refuses `tenantId`/`resource`/`resourceId` outright —
  422 via `whitelist` + `forbidNonWhitelisted`).
- The purchase is loaded tenant-scoped FIRST; a foreign/unknown id → 404
  `Purchase document not found` (identical to `getOne`, indistinguishable from
  non-existence), and the audit query is never issued — no count or event leakage, no
  existence oracle (C7-H). The platform read additionally carries `tenantId` in every
  predicate (fail-closed `AUDIT_READ_TENANT_MISSING`).

## M. QUERY PARAMETERS `[CONFIRMED — implemented]`

| Param | Type | Bounds | Notes |
|---|---|---|---|
| `page` | integer | ≥ 1 | forwarded to the platform verbatim; default is the PLATFORM's (1) |
| `pageSize` | integer | 1 … `COMMERCE_MAX_PAGE_SIZE` (100) = `AUDIT_READ_MAX_PAGE_SIZE` | forwarded verbatim; default the PLATFORM's (20) |

No `action`, no `from`/`to`: P-AUDIT-READ supports both, but no confirmed UI need
justifies widening the surface yet. No `resourceType`/`resourceId`/`tenantId`:
server-bound, inexpressible on the wire (DTO + service, tested C7-E).
DTO: `PurchaseTimelineQueryDto` (`purchase.dto.ts`) — its own class rather than
`CommercePageQueryDto`, because the shared base's `search` field would be accepted and
silently ignored by a timeline (an honest refusal beats a dishonest parameter).

## N. PAGINATION `[CONFIRMED]`

Exactly the platform contract: `{ items, page, pageSize, total }`, echoed from the
platform's normalized page (defaults resolved there, not re-derived in Commerce). The DTO
bounds the ceiling; the platform validates fail-closed (`AUDIT_READ_PAGE_INVALID` etc. →
422 — defensive, unreachable through the DTO). No Commerce pagination convention, no
client-side merge. E2E C7-F proves pages partition the recorded set: no duplicate, no
loss, correct `total`/`page`/`pageSize`.

## O. ORDERING `[CONFIRMED]`

`createdAt ASC, id ASC`, exactly as P-AUDIT-READ defines it — passed through untouched.
The API does NOT reverse the order because "timelines usually show newest first"; any
presentation reversal is an explicit future UI decision (frontend untouched in C7).
E2E C7-B asserts the returned instants are non-decreasing.

## P. RESPONSE `[CONFIRMED — implemented]`

```json
{
  "items": [
    {
      "id": "…",
      "action": "create",
      "actorId": "…",
      "success": true,
      "reason": null,
      "changedFields": [],
      "createdAt": "2026-10-01T00:00:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1
}
```

The page envelope is the platform's own shape (which matches the Commerce/HR module-list
convention), so "reuse it" resolves to exactly this object. The item is the Commerce
projection (§Q). Raw `AuditReadItem`s are NOT passed through.

## Q. SAFE PROJECTION `[CONFIRMED — implemented]`

`PurchaseTimelineService.project` is an EXPLICIT WHITELIST of seven fields — `id`,
`action`, `actorId`, `success`, `reason`, `changedFields`, `createdAt`. A whitelist (not a
deny-list) because the platform projection is a contract, not a ceiling: a future platform
field must require an explicit Commerce decision before it appears here. `resource`/
`resourceId` are omitted too — every item shares the one server-bound pair the request
already established. The unit test proves at RUNTIME that planted extra fields
(`ipAddress`, `userAgent`, `sessionId`, `tenantId`, `oldValue`, `newValue`, `changes`)
never appear.

## R. SENSITIVE FIELD POLICY `[CONFIRMED]`

Never exposed: IP, userAgent, sessionId, requestId, correlationId, tenantId, raw
`oldValue`/`newValue`, `changes` arrays, snapshots, credentials, authentication artifacts.
This matches — and does not exceed — P-AUDIT-READ's own exclusion list: no ad-hoc redaction
layer was invented; Commerce simply re-selects from the already-safe platform item.
`action` is returned RAW (the audit vocabulary is never rewritten server-side); Persian
labels are presentation and belong to `commerce-labels.ts` / `commerce-ui.tsx` — no label
mapping was added because no frontend change ships in C7. The timeline is factual:
"document updated" is reported as `update` with `changedFields`, never rewritten into a
business story the audit row does not contain.

## S. ERROR TAXONOMY `[CONFIRMED — implemented]`

| Case | Status | Body |
|---|---|---|
| No principal | 401 | global JWT refusal |
| No resolvable tenant | 403 | established Commerce tenant message |
| No `commerce.read` | 403 | RolesGuard refusal |
| Foreign / unknown purchase | 404 | `Purchase document not found` (identical for both) |
| Non-UUID `:id` | 400 | `ParseUUIDPipe` |
| Invalid / out-of-range / unknown query param | 422 | `VALIDATION_FAILED` (production pipe) |
| Platform rejects the built query (defensive) | 422 | platform code, e.g. `AUDIT_READ_PAGE_INVALID` |
| **Audit storage refused — `AUDIT_READ_FAILED`** | **503** | `{ code: 'AUDIT_READ_FAILED', message: 'Audit history is temporarily unavailable.' }` |

409 is deliberately absent (no conflict semantics for a read). The 503 maps P-AUDIT-READ
§R's documented "500/503" range to **503** `[DECISION]`: the fault is downstream
availability, and 503 is the status a client can act on by retrying. Internal error text
is never returned — only the closed code, logged once at the service boundary with its
diagnostic classification preserved.

## T. EMPTY-STATE SEMANTICS `[CONFIRMED]`

- **Successful read, zero events** → `200 { items: [], page, pageSize, total: 0 }` (or
  `total: N` for a page past the end). Truthful meaning for a client: "no audit events are
  currently recorded under this document's resource correlation" — NOT "this document has
  no history" and NOT an error. For an EXISTING document a totally empty timeline is
  impossible today because creation itself is audited; the unit test pins the empty-page
  shape, the e2e pins the out-of-range page (C7-A).
- **Failed read** → 503 (§S), body WITHOUT `items`/`total` — so `No events` and
  `Audit temporarily unavailable` are structurally distinguishable (C7-G).
- The response never claims completeness: payments, receipts, returns, commercial and
  workflow decisions are outside this correlation by construction (§G).

## U. CONSISTENCY `[CONFIRMED]`

- One query, one resource, one deterministic order — no second source of truth, no merge.
- The audit write path (`record`) is untouched; the read path observes the same trail the
  writers produce (the single `AuditLog` in `core_db`).
- The e2e harness fake remains the shared contract-driven fixture: while the failure
  switch is OFF, every read executes the SAME `validateAuditReadQuery`, tenant/resource
  filtering, insertion order and projection the production binding uses.

## V. PERFORMANCE `[CONFIRMED]`

- Bounded by `tenantId + resourceType + resourceId + page/pageSize` — one index-backed
  range scan (`@@index([resourceType, resourceId])`) plus a `COUNT(*)` over the same
  predicate, both scoped to ONE resource (platform-side, P-AUDIT-READ §Q).
- No tenant-wide or module-wide audit fetch, no in-memory filtering, no User-Directory
  calls per event (none at all), no second audit query, no multi-query merge.
- Existence check is one tenant-scoped read on the purchase (existing indexed path).
- No new index and no migration: nothing changed on either database (§MIGRATION).

## W. FRONTEND COMPATIBILITY `[CONFIRMED] — NO FRONTEND CHANGE`

- The Purchase Detail «رویدادها» tab still states honestly: "تاریخچهٔ کامل مممیزی از طریق
  Commerce در دسترس نیست" (`CommercePurchaseDetailView.tsx`, «رویدادهای ثبت‌شده» card) —
  that claim remains TRUE after C7, because the timeline is partial by construction (§G).
  No placeholder is broken and no UI is required for GAP-7 to close backend-first.
- `commerce-api.ts` was NOT extended (frontend scope; §31 default is no change). If a later
  UI phase wires the tab to the endpoint it must: use `commerce-api.ts`, reuse
  `commerce-labels.ts` for action labels, distinguish empty (200 + `items: []`) from failure
  (503 + `AUDIT_READ_FAILED`), keep RTL/tabs/loading/error patterns, and design any
  newest-first presentation explicitly (§O).

## X. LIMITATIONS `[CONFIRMED]`

- The timeline covers ONLY the `commerce.purchase_document` family (§G) and must never be
  presented as "everything that happened to this purchase": payments, receipts, returns,
  commercial decisions and workflow decisions are NOT in it (NOT CORRELATED / NOT AUDITED).
- Only `resource+resourceId` correlation is used; `action`/date filters are not exposed.
- Actor display is the raw user id; no directory enrichment exists or was invented.
- No labels, no aggregation, no chronology rewriting at the API layer.

## Y. UNKNOWN `[NONE — every stop-condition resolved]`

1. Platform contract consumable through `CommerceAuditGateway` — implemented and unit-proven.
2. PurchaseDocument resource vocabulary authoritative — `commerce.purchase_document` is a
   declared member of `COMMERCE_AUDIT_RESOURCE` `[CONFIRMED]`.
3. resourceId correlation authoritative — writers pass the document id (§G) `[CONFIRMED]`.
4. Tenant-safe query — actor-stamped tenant + tenant-scoped existence check + platform
   fail-closed validation (§L) `[CONFIRMED]`.
5. Permission — `commerce.read`, source-backed (§J) `[CONFIRMED]`.
6. Safe projection — explicit whitelist (§Q) `[CONFIRMED]`.
7. Foreign-resource behavior — 404 before the audit query (§L) `[CONFIRMED]`.
8. Audit failure vs empty — 503-without-items vs 200-with-items (§S/§T) `[CONFIRMED]`.
9. Pagination/ordering — platform contract passed through (§N/§O) `[CONFIRMED]`.
10. No included timeline event needs invented correlation (§G) `[CONFIRMED]`.

## Z. DECISION REQUIRED `[ONE — recorded, not blocking]`

- **503 vs 500 for `AUDIT_READ_FAILED`** — this phase's single judgment call (`[DECISION]`,
  §S). P-AUDIT-READ documents "500/503" for a future HTTP mapping; C7 chose **503**
  because the fault is downstream availability. Revisit only if the platform later
  publishes its own HTTP mapping for the port.

## AA. REJECTED ASSUMPTIONS `[EXPLICIT]`

1. ~~"Show all Commerce activity"~~ — rejected: only authoritatively correlated events
   ship; a partial truthful timeline beats a fabricated complete one.
2. ~~Parse payment/receipt/return JSON payloads for `purchaseDocumentId`~~ — rejected:
   not a contract field, not indexed (C6 §H).
3. ~~Cross-resource timeline merge (payments + receipts + returns + approvals)~~ —
   rejected: no authoritative correlation, no defined global ordering, false totals risk.
4. ~~Backfill workflow-decision events~~ — rejected: workflow decisions are NOT AUDITED;
   no historical fabrication.
5. ~~`commerce.audit.read` permission~~ — rejected: not in Core's catalogue; `commerce.read`
   is the source-backed read remit.
6. ~~Reordering newest-first at the API~~ — rejected: platform chronology is authoritative;
   presentation order is a UI decision.
7. ~~Returning raw `AuditReadItem`s / spreading the platform item~~ — rejected: explicit
   whitelist instead (§Q).
8. ~~Commerce audit table, audit mirror, second Audit system, direct `AuditLog`/Core
   Prisma access~~ — rejected by construction; the isolation/gateway gates prove absence.
9. ~~409 for reads / audit counts in a 404 body / empty page on failure~~ — rejected:
   reads have no conflict semantics; failures are 503 without page fields.
10. ~~Per-event User-Directory enrichment~~ — rejected: N+1, and no batch contract exists.
11. ~~Exposing `action`/`from`/`to` filters now~~ — rejected: no confirmed consumer;
    additive later if a UI need is proven.
12. ~~Frontend timeline UI in this phase~~ — rejected by the brief's default; the existing
    honest placeholder remains valid (§W).

---

## FILES

**Created by C7:**

- `apps/api/src/modules/commerce/purchase/purchase-timeline.service.ts` — the read service
  (existence → gateway read → whitelist projection → page envelope).
- `apps/api/src/modules/commerce/purchase/purchase-timeline.service.spec.ts` (8 tests).
- `apps/api/src/modules/commerce/commerce-audit.gateway.spec.ts` (4 tests — the gateway's
  read half).
- `docs/PHASE-C7-COMMERCE-AUDIT-READ-TIMELINE-CONTRACT.md` (this document).

**Modified by C7:**

- `apps/api/src/modules/commerce/commerce-audit.gateway.ts` — the `read(...)` passthrough
  (writes untouched).
- `apps/api/src/modules/commerce/purchase/purchase.controller.ts` — `GET ':id/timeline'`
  route + `PurchaseTimelineService` injection.
- `apps/api/src/modules/commerce/purchase/purchase.dto.ts` — `PurchaseTimelineQueryDto`.
- `apps/api/src/modules/commerce/purchase/purchase.dto.spec.ts` — 5 timeline-DTO tests.
- `apps/api/src/modules/commerce/commerce.module.ts` — provider registration (no new
  import/export surface).
- `apps/api/src/modules/commerce/commerce-isolation.spec.ts` — route surface 64 → 65
  (purchase 6 → 7), `UNAUDITED_SERVICES` + the timeline service with its measured reason,
  D7 prose counts, and a new D7 measurement (the timeline service records nothing and
  writes no delegate).
- `apps/api/src/modules/commerce/commerce-gateways.spec.ts` — pins the gateway's read
  method and its `AUDIT_READ_FAILED` classification.
- `apps/api/test/commerce-lifecycle.e2e-spec.ts` — provider registration, the C7-A…C7-H
  block, the no-permission principal (`userA4`), and the audit-read failure switch around
  the SAME contract-driven fake.
- `apps/api/test/commerce-integration.e2e-spec.ts` / `commerce-tenant.e2e-spec.ts` —
  provider registration only (the controller now requires the service).

**Pre-existing files NOT touched by C7** (modified/untracked from earlier phases, verified
by diffing `git status` before/after): everything else — the P-AUDIT-READ platform files
(`audit.contract.ts`, `platform-audit.service.ts`, `audit-read.contract.spec.ts`,
`platform-audit-read.spec.ts`, `test/fixtures/fake-audit-port.ts`), all audit writers
(`purchase.service.ts`, `purchase-completion.service.ts`, `workflow-line-routing.service.ts`,
…), Prisma schemas and migrations, all web files, all other docs, `.tmp/` run logs.

## MIGRATION `[CONFIRMED — none]`

No schema change on either database: no Commerce audit table, no `AuditLog` change, no new
index (the platform's existing `@@index([resourceType, resourceId])` serves every read —
C6 §Y7's optional index remains declined per P-AUDIT-READ §Q). `prisma validate` green for
`commerce` and `core`; `prisma migrate deploy` not required and not run.

## ARCHITECTURE / ISOLATION `[CONFIRMED]`

```
PurchaseController (GET :id/timeline)
  → resolveCommerceActor(req)
  → PurchaseTimelineService
  → PurchaseRepository.findDocumentById(tenantId, id)        (commerce_db, tenant-scoped)
  → CommerceAuditGateway.read(...)                           (the ONE audit surface)
  → AUDIT_PORT.read(...)                                     (platform port)
  → PlatformAuditService.read → core_db."AuditLog"
```

- No direct Audit/Core Prisma anywhere in Commerce (isolation suite D6 green).
- No Commerce audit mirror (gateway gate: schema contains no `model Audit…`).
- Single `AUDIT_PORT` holder unchanged (`offenderFiles(AUDIT_TOKENS) == [gateway]`).
- Tenant isolation, permission model and repository boundary unchanged and re-proven
  (isolation suite green with the new route).
- No controller added: controller set stays ten; only the route surface grew by one.

## VALIDATION — measured `[CONFIRMED]`

| # | Check | Command (from `apps/api`) | Result |
|---|---|---|---|
| 1 | C7 targeted — service/gateway/DTO/gates | `jest --runInBand purchase-timeline.service.spec.ts commerce-audit.gateway.spec.ts purchase.dto.spec.ts commerce-gateways.spec.ts commerce-isolation.spec.ts` | **green** — service spec 8/8, gateway spec 4/4, DTO +5, isolation + gateways pass |
| 2 | Full API unit + architecture + policy + isolation | `jest --runInBand --silent` | **204/204 suites, 3337/3337 tests, 0 failed** — `architecture-boundaries.spec.ts` PASS, `runtime-policy.spec.ts` PASS, `commerce-isolation.spec.ts` PASS, `commerce-gateways.spec.ts` PASS |
| 3 | E2E lifecycle (real HTTP + live commerce_db) | `jest --config jest-e2e.json --forceExit test/commerce-lifecycle.e2e-spec.ts` | **41/41 passed, exit 0** — the 33 pre-existing tests plus C7-A…C7-H |
| 4 | E2E integration + tenant | `jest --config jest-e2e.json --forceExit test/commerce-integration.e2e-spec.ts test/commerce-tenant.e2e-spec.ts` | **33/33 passed, exit 0** — no regression from the provider edit |
| 5 | TypeScript (src) | `tsc --noEmit -p tsconfig.json` | **exit 0** |
| 6 | Prisma validate | `prisma validate` for `commerce` + `core` | **both valid** |
| 7 | Frontend | — | **not run, not touched** (§W / the brief's default) |

Baseline comparison: P-AUDIT-READ reported 202 suites / 3320 tests. C7 adds exactly
+2 suites (`purchase-timeline.service.spec.ts`, `commerce-audit.gateway.spec.ts`) and
+17 tests (8 + 4 + 5) → 204 / 3337. **No baseline failure exists and no C7 failure
exists.** The only environment artifact observed: Jest prints its "did not exit one
second after the test run" open-handle notice at the end of the full unit run — a
pre-existing harness characteristic (present in earlier phases' logs), unrelated to C7;
the summary above was already written before it, and the process was terminated after
capture.

C7-E2E proof mapping: C7-A honest single-event timeline + out-of-range empty page;
C7-B create/update/submit chronology + seam correlation; C7-C completion `close` event;
C7-D two-tenant non-crossing with per-item seam verification; C7-E 401/403(no-perm)/
403(no-tenant)/200(reader)/422(scope params)/400(bad uuid); C7-F partition without
duplicate or loss; C7-G 503 `AUDIT_READ_FAILED` ≠ empty + recovery; C7-H foreign 404
identical to non-existent, no leakage.

## ACCEPTANCE CRITERIA — GAP-7 `[ALL MET]`

- [x] Platform P-AUDIT-READ contract consumed (§B/D/V)
- [x] `CommerceAuditGateway` supports read (§D)
- [x] No direct Audit DB access (§C/ARCHITECTURE; isolation + gateway gates green)
- [x] No Commerce audit mirror (§C/MIGRATION)
- [x] PurchaseDocument resource correlation confirmed (§E/F/G)
- [x] Tenant isolation structural (§L; C7-D/H; platform fail-closed)
- [x] Actor/permission semantics confirmed (§J/K; C7-E)
- [x] Real Commerce HTTP timeline endpoint exists (§H; C7-A…H over real HTTP)
- [x] Server binds resourceType/resourceId (§E/F; unit + C7-B/D seam assertions)
- [x] Pagination preserved (§N; C7-F)
- [x] Deterministic ordering preserved (§O; C7-B/F)
- [x] Safe projection implemented (§Q; unit runtime whitelist test)
- [x] Sensitive fields excluded (§Q/R)
- [x] Raw snapshots excluded (§R)
- [x] Empty vs failure semantics distinct (§T; C7-A vs C7-G)
- [x] Audit read failure propagated safely (§S; C7-G + unit)
- [x] Foreign tenant returns safe 404 (§L; C7-H)
- [x] Event coverage matrix completed (§G)
- [x] No invented audit event / no backfill (§G/AA)
- [x] Existing audit writers unchanged (full suite green; writers' specs pass)
- [x] Existing Commerce lifecycle unchanged (lifecycle e2e 41/41)
- [x] E2E real HTTP tests pass; tenant isolation passes; authorization passes (§VALIDATION)
- [x] Architecture/isolation passes; full Commerce tests pass; full API tests pass
- [x] TypeScript passes; Prisma valid; no migration (§MIGRATION)
- [x] Documentation complete (§A–AA + this section); C6 and P-AUDIT-READ untouched
- [x] No Reporting/Search/Notification/Quotation work (§AA; nothing else changed)

## GIT STATUS `[CONFIRMED]`

- HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`, **no commit made**.
- C7's new/modified files are listed in §FILES; every other modified/untracked entry in
  `git status` is the pre-existing C1–C6/UI/P-AUDIT-READ work, unchanged by C7 (the one
  further delta — the `commerce-lifecycle`/`integration`/`tenant` e2e files — already
  carried earlier uncommitted work and received only the C7 hunks described there).
- No `reset`, `clean`, `checkout`, `revert`, `rebase` or `squash` was executed. Nothing
  was committed.

---

**FINAL STATUS:** `COMMERCE BACKEND GAP CLOSURE COMPLETE — GAP-7 AUDIT READ / TIMELINE`

**END OF DOCUMENT**

- Pure passthrough: the query built by the service reaches the port verbatim; the gateway
  decides no filter, default, projection or fallback.
- Rejections pass through UNCHANGED (so the service can map them), never converted to an
  empty page.
- The `catch` classifies a port that THROWS (violating the never-throw promise) as
  `{ status: 'rejected', code: 'AUDIT_READ_FAILED' }` and logs it — never an empty result,
  never an unclassified escape.
- No Prisma, no `AuditLog`, no `PlatformAuditService`, no raw row crosses the gateway;
  `record(...)` behavior untouched.
- Gate pins extended: `commerce-gateways.spec.ts` asserts `async read(`,
  `this.audit.read(` and the `AUDIT_READ_FAILED` classification exist on the gateway.
