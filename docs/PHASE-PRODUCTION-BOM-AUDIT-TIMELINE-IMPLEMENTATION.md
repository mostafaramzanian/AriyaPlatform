# PHASE PRODUCTION-BOM-AUDIT-TIMELINE — IMPLEMENTATION REPORT

**Module:** Production / «تولید»  **Capability:** BOM / «فهرست مواد و قطعات» · surface: audit timeline
**Base checkpoint:** `62fc680` (BOM frozen — header, item, lifecycle, approval, CRUD, audit, frontend)

---

## 1. What this phase is, in one paragraph

`GET /production/boms/:id/timeline` — a **read-only** projection of the events Production has
already written to the platform audit trail, surfaced as a «تاریخچه رویدادها» section on
`/admin/production/[id]`. The phase adds **no** schema, **no** migration, **no** business rule and
**no** new permission: the BOM data model, its lifecycle, its item rules and its approval
behaviour are byte-identical to the base checkpoint (`bom.service.ts`: **211 insertions, 0
deletions** — the method below was appended, nothing above it was touched). It reads through the
read half of `ProductionAuditGateway`, which existed at the base checkpoint with the comment
*"NO ROUTE CALLS THIS IN THIS PHASE"*; this phase is the route that calls it.

Not touched, per the brief: Product Tree Code, `CodeStandardDarSanat`, BOM lifecycle, BOM Item
business rules, Procurement, Notifications, Search, migration, BOM versioning, BomEdit.

---

## 2. Preflight — the contracts this phase reuses (nothing invented)

| Need | Contract | Status |
| --- | --- | --- |
| audit read | `AuditPort.read(query)` → `AuditReadResult` (`platform/audit/audit.contract.ts`) | `EXISTS` |
| audit seam | `ProductionAuditGateway.read()` — passthrough, returns rejections verbatim | `EXISTS` (was uncalled) |
| existence + tenant scope | `BomHeaderRepository.findById(tenantId, id)` → `requireRow` → 404 | `EXISTS` |
| permission | `Permissions.PRODUCTION_BOM_READ` (`production.bom.read`) | `EXISTS` — **no new string** |
| page-size pair | `PRODUCTION_MAX_PAGE_SIZE` 100 / `PRODUCTION_DEFAULT_PAGE_SIZE` 20 | `EXISTS` |
| route convention | `@Controller('production/boms')` + `@Get(':id/timeline')` + `ParseUUIDPipe v4` | `EXISTS` (C7 precedent) |
| response envelope | `{ items, page, pageSize, total }` | `EXISTS` (every Production list) |
| composition | `ProductionModule` providers unchanged — no new file, no new provider | `EXISTS` |

**No contract was missing for the delivered scope, so the phase is not BLOCKED.**

---

## 3. The one design finding: how an event is correlated to a BOM

The brief asks for both `production.bom` **and** `production.bom.item` events. The read contract
cannot deliver the second family, and the reason is structural rather than a gap:

* `AuditReadQuery` requires `resource` **and** `resourceId`, and the platform contract states
  plainly: *"no metadata or JSON predicate, no ORDER BY parameter, no projection parameter"*.
* `production.bom.item` events are recorded with the **item's** id as `resourceId`
  (`bom-item.service.ts`: `resourceId: row.id` / `updated.id` / `current.id`); the parent
  `bomId` travels **only** inside `oldValue` / `newValue` JSON — exactly the field the read
  contract refuses to filter on.
* An item **DELETE is a HARD delete** (`prisma.bomItem.deleteMany`). A removed item's id is
  therefore unrecoverable from `production_db`, so enumerating this BOM's item ids could never
  reach the `delete` event — nor any earlier history of a deleted row. The timeline would
  *falsely assert* that the item never existed.
* One read per item also cannot produce a single honest `{ page, pageSize, total }`: the
  contract bounds **each** read, not the union, so a merged page would have to materialise every
  row and invent a count.

**Commerce C7 met the identical situation** (payment, receipt, return and assignment events carry
the document id only in payload) and documented the answer: *"A truthful PARTIAL timeline is
therefore the honest deliverable: this service returns exactly the `commerce.purchase_document`
family and implies nothing more."*

**Decision:** the timeline returns the `production.bom` family — the complete history of the
aggregate root — and does not fabricate correlation it cannot authoritatively make. Making
`AuditReadQuery` filter on a correlation field is a **platform contract decision**, recorded here
as a blocked surface rather than invented.

---

## 4. API

```
GET /api/v1/production/boms/:id/timeline?page=&pageSize=
```

* `JwtAuthGuard` (innermost) + `@RequiresModule('production')` + `@RequiresFeature('production','bom')`
  + `@UseGuards(ModuleEntitlementGuard)` — the same chain as every other route on this controller.
* `@Roles(Permissions.PRODUCTION_BOM_READ)` — the read remit, exactly as `list` and `getOne`.
* `:id` parsed as `ParseUUIDPipe({ version: '4' })` (the 7th UUID pipe on this controller).
* DTO (`BomTimelineQueryDto`) carries **only** `page` / `pageSize`; `tenantId`, `resource`,
  `resourceId` and `action` are rejected by the whitelist rather than ignored.

**Query bound server-side — four fields:**

```ts
{ tenantId: actor.tenantId,                 // resolveProductionActor — never a request field
  resource: PRODUCTION_AUDIT_RESOURCE.BOM,  // 'production.bom' — closed vocabulary constant
  resourceId: row.id,                       // resolved tenant-scoped by requireRow
  page, pageSize }                          // resolveProductionTimelineWindow
```

**Ordering** is the platform's, unchanged: `createdAt ASC, id ASC` — chronological, total (the id
breaks ties) and stable under appends. The API does not reverse it; newest-first is a view's
explicit decision. **Pagination** is the contract's (default 20, ceiling 100), with the module's
own pair resolved in `resolveProductionTimelineWindow`: the DTO enforces the ceiling as the
CONTRACT (a 400 naming the field) and `Math.min` enforces it as the GUARANTEE.

**Response** — `BomTimelineItem`, an explicit seven-field whitelist copied from `AuditReadItem`:
`id`, `action`, `actorId`, `success`, `reason`, `changedFields`, `createdAt`. `resource` /
`resourceId` are not echoed (they are the one server-bound pair the request already established).
Absent **by construction** on the platform item: `tenantId`, `ip`, `userAgent`, `sessionId`,
`requestId`, `correlationId`, `oldValue`, `newValue`, `changes` — the read implementation never
SELECTs them.

**Errors** — existence is checked first and a foreign id is a **404** (indistinguishable from
absent) *before* the port is reached. A rejected read maps `AUDIT_READ_FAILED` → **503**, any
other closed code → **422**, per P-AUDIT-READ — never a quiet `items: []`.

**Event families** are exactly the six this slice already records — `create`, `update`, `submit`,
`approve`, `reject`, `request_correction` — plus the three item verbs shared by the same
vocabulary. **No event is produced, simulated or relabelled.**

---

## 5. Security

The projection never sees a raw payload (the platform projection carries none), so there is no
`oldValue` / `newValue` / `changes` to leak. Raw SQL: none — the only path is `AUDIT_PORT.read`.
`resource` is a server-side constant, so no request shape can pivot this route into a reader of
another resource type, and no request shape can point it at another tenant's trail.

---

## 6. Frontend

Route `/admin/production/[id]` gains a fifth, read-only section — `ProductionBomTimeline`
(`testId: production-bom-timeline`), rendered **only** to a `production.bom.read` holder; an
unentitled caller issues **no** timeline request.

States: **loading** (`CoreLoading`, `role="status"`) · **populated**
(`production-timeline-entry`, chronological in server order) · **empty**
(`production-bom-timeline-empty`) · **error** (`production-bom-timeline-error`, showing the typed
`AUDIT_READ_FAILED` sentence — «تاریخچه رویدادها موقتاً در دسترس نیست.», never the empty-state
text) · **pagination** (`ProductionPagination`, re-reads only the timeline).

Labels come from `productionBomAuditActionLabel`, a conservative mapping of the audit verb that
**falls back to the raw token** for an unknown action — no English token is converted into an
invented business meaning.

---

## 7. Tests

| Suite | Result |
| --- | --- |
| API `modules/production` (13 suites) | **173 / 173 passed** (baseline 156 → **+17**) |
| API full (`npm test`) | **224 suites, 3687 / 3687 passed** |
| Web production (4 suites) | **44 / 44 passed** (baseline 27 → **+17**) |
| Web full (`jest`) | **94 suites, 1669 / 1669 passed** |

**API, new coverage.** `bom.service.spec.ts` (+300) pins: the query is **exactly** the five bound
keys (`Object.keys(query).sort()` — no added `action`, `from`, `to` or `orderBy`); the resource is
always `production.bom` and **never** `production.bom.item`; the window resolves to the module's
pair (default 1/20, ceiling 100, floor 1); a foreign BOM is a 404 **with the audit port never
reached**; empty → `items: []` with the platform `total`; multiple events stay in the platform
order (unreversed); the pagination envelope is echoed; the projection is the seven-field whitelist
**and** the serialised entry contains none of `tenant-OTHER`, `10.0.0.1`, `leak`, `hunter2`,
`before`, `after`, `production.bom`, the BOM id; `action` is never relabelled; `AUDIT_READ_FAILED`
→ 503 and a caller-fault code → 422, **never** an empty page.
`bom.controller.spec.ts` (+41): the timeline is in the READ remit and carries one role; seven UUID
v4 pipes; the scope is never read off `req.query`.
`bom.dto.spec.ts` (+64): `tenantId` / `resource` / `resourceId` / `action` are **refused** as query
parameters; page/size bounds; the clamping pair.

**Web, new coverage.** `ProductionBomTimeline.spec.tsx` (new, 9 tests): loading / populated /
empty / error are **four distinct states**; server order is not re-sorted; an unknown verb shows
its **raw token**; the reason, the failed marker and the changed field NAMES render; paging
re-reads only the timeline and sends `{ page: 2, pageSize: 20 }`; and the **parent** issues no
timeline request without `production.bom.read`.

**Nothing pre-existing failed.** The two API and six web suites that failed during the *first*
full run were re-run in isolation and **all pass** (9/9 and 120/120): the initial failures were
machine contention from three concurrent suites (jest timeouts, e.g. *"Exceeded timeout of 5000 ms"*
in `CoreSurveyEditorView`), and none of the six files references production at all.

## 8. Database

| Check | Result |
| --- | --- |
| Migration created | **no** |
| `schema.prisma` changed | **no** (`prisma/production/schema.prisma` untouched) |
| `prisma validate` (production) | **valid** |
| `prisma migrate status` (production) | **2 found, 0 pending — "Database schema is up to date!"** |
| `prisma migrate diff` (live `production_db` → schema) | **No difference detected.** |

This phase is deliberately schema-free: the audit trail lives in `core_db."AuditLog"`, reached
only through `AUDIT_PORT`, and Production keeps no audit table of its own.

## 9. Typecheck and lint

| Check | Result |
| --- | --- |
| API `tsc --noEmit` | **clean** (exit 0) |
| Web `tsc --noEmit` | **clean** (exit 0) |
| API `eslint src/modules/production` | **clean** (exit 0) |
| API `eslint src` (repo-wide) | **4291 pre-existing errors** — untouched files, e.g. `users.service.ts`; not introduced here |
| Web lint | **toolchain broken, pre-existing** — the package's `next lint` script resolves `E:\ERP\apps\web\lint` as a directory (Next 16 + the eslint-8 `.eslintrc.js` in this repo), and a bare `eslint` cannot load `next/core-web-vitals` (circular-config error). It fails **identically on untouched files** such as `src/lib/core-http.ts`, so no verdict about this change can be obtained from it; `tsc --noEmit` and the 1669 web tests stand in. |

## 10. Runtime

| Check | Result |
| --- | --- |
| `/api/v1/health` | **200** `{"status":"ok","version":"1.0.0"}` |
| `/api/v1/live` | **200** `{"runtime":"combined","status":"alive"}` |
| `/api/v1/ready` | **200** `status: ready`, `blocking: []`; `productionDatabase: ok` |
| Route registration (after refresh) | `GET /api/v1/production/boms/:id/timeline` is **mapped** |
| Smoke, **no JWT** | **401** — auth behaviour correct |
| Smoke, malformed id | **400** — `ParseUUIDPipe` v4 at the edge, no database round-trip |
| Database reset | **none** |

**Before the refresh** the same route returned **404** on the running container (built before this
phase), which is what proves the route is genuinely new rather than already present;
`/api/v1/production/boms` returned **401** both before and after, so the auth chain is unchanged.

Route registration, from the refreshed container's own startup log:

```
Mapped {/api/v1/production/boms, GET} route
Mapped {/api/v1/production/boms/:id, GET} route
Mapped {/api/v1/production/boms/:id/timeline, GET} route     ← this phase
Mapped {/api/v1/production/boms/:id/submit, POST} route
...
```

`401` precedes `400` for a malformed id, which is the documented guard order — authentication is
the innermost check, so an anonymous request is refused before anything parses an id. The
`ParseUUIDPipe` 400 itself is asserted in `bom.controller.spec.ts`.

---

## 11. Files changed

```
apps/api/src/modules/production/bom/bom.controller.ts             +30  -0   (route)
apps/api/src/modules/production/bom/bom.dto.ts                    +66  -0   (query DTO + window)
apps/api/src/modules/production/bom/bom.service.ts               +211  -0   (getTimeline + projection)
apps/api/src/modules/production/bom/bom.controller.spec.ts        +41  -8   (read remit, 7 UUID pipes)
apps/api/src/modules/production/bom/bom.dto.spec.ts               +64  -0
apps/api/src/modules/production/bom/bom.service.spec.ts          +300  -0
apps/web/src/lib/production-api.ts                                +84  -0   (client)
apps/web/src/lib/production-labels.ts                             +72  -0   (verb labels, timestamp)
apps/web/src/components/production/ProductionBomDetailView.tsx    +14  -0   (mount the section)
apps/web/src/components/production/ProductionBomTimeline.tsx     (new)
apps/web/src/components/production/__tests__/ProductionBomTimeline.spec.tsx (new)
apps/web/src/lib/__tests__/production-api.spec.ts                 +53  -0
apps/web/src/lib/__tests__/production-labels.spec.ts              +57  -0
docs/PHASE-PRODUCTION-BOM-AUDIT-TIMELINE-IMPLEMENTATION.md        (new)
```

**Production code is purely additive: `bom.service.ts` 211/0, `bom.dto.ts` 66/0, `bom.controller.ts`
30/0** — zero deletions in any runtime file, so nothing in the frozen BOM could have changed
behaviour. The only deletions in the whole diff are 8 lines in `bom.controller.spec.ts`, all of
them test assertions updated for the seventh route.

Secret scan over the diff: no credential, token, key or `.env` value. The only matches for
`password` / `secret` are the deliberate adversarial fixtures in the projection test
(`password: 'hunter2'`, `secret: 'before'`), which exist precisely to prove the projection drops
them.

---

## 12. Explicit non-goals (untouched, as briefed)

Product Tree Code · `CodeStandardDarSanat` generation · BOM lifecycle · BOM Item business rules ·
Procurement integration · Notifications · Search source · Migration · BOM versioning ·
Change Request / BomEdit · the `production.bom.item` event family (§3, a platform contract
decision rather than an omission).

**Tests:** production API 13 suites / **173**; production web 4 suites / **44**; API full **224 / 3687**;
web full **94 / 1669**. **Database:** no migration, no schema change, migrate status clean, diff empty.

