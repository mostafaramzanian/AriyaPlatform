# PHASE PRODUCTION-BOM-CHANGE — IMPLEMENTATION REPORT

**Module:** Production / «تولید»  **Capability:** Change BOM / «ثبت درخواست تغییر BOM»
**Base checkpoint:** `aba9337` (BOM header, BOM item, lifecycle, audit timeline — frozen)
**Authoritative source:** the SharePoint form «ثبت درخواست تغییر BOM», read from
`E:\Very Mohem\BomEdit.txt` (the file the brief names `Pasted text(2).txt`; `docs/PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md` §2.1 lists it under its on-disk name) together with its
approval task form `kartable bomEdit.txt`.

**Classification tags used below:** `[SOURCE]` — read directly out of `BomEdit.txt` /
`kartable bomEdit.txt`; `[ARIYA]` — an architecture or domain decision this repository makes,
not something the source states; `[OPEN]` — the source does not answer it and this phase did
not invent an answer.

---

## 1. Preflight

### 1.1 Source inventory (evidence)

| # | Rule | Where it is in the source |
| --- | --- | --- |
| S1 | change types are exactly `تغییر موجودی` and `غیر فعال سازی` | `c_NoeaTaghir` `Lookup_StaticValues="تغییر موجودی;غیر فعال سازی"` |
| S2 | for `تغییر موجودی`, at least one of the two deltas must be non-empty | `c_add` script: `check == 0` → «حداقل یکی از فیلدهای … باید مقداردهی گردد» |
| S3 | a second detail for the same item in the same request is refused | `c_add` callback: `e.ListItems.length > 0` → «شما قبلا جزئیات این قطعه را تغییر و ثبت نموده اید» |
| S4 | submit needs ≥ 1 selected row | `c_Control1`: `«اقلامی جهت تغییر ثبت نشده است!»` |
| S5 | submit writes `status 0 → 1` | `c_Control1` script |
| S6 | the detail stores BOTH originals AND both deltas | `MizanAvaliyeZaribMasrafInMap/Yadaki ← c_Control13/c_Control14`, `MizanAfzayesh… ← c_Control7/c_Control10` |
| S7 | `> 0` / `isNaN` numeric checks are **commented out** | `/* … */` block inside `c_add` |
| S8 | `total = original + delta` is display-only; the `< 0` branch has `//error = true` | `c_ZaribMasrafInMap` / `c_zaribMasrafYadaki` `ValueChangeScript`; `kartable bomEdit` warning block |
| S9 | statuses `0 / 1 / 50 / 100`, «نیاز به اصلاح» returns to `0` | `c_status`, `LoadCompletedScript`, `kartable bomEdit` |
| S10 | every mutating control is guarded by `c_status == "0"` | `c_add`, `btn_delete`, `DataGridsResult`, `c_Control7`, `c_Control10`, `c_NoeaTaghir`, `c_Control1` |
| S11 | title is CALCULATED as `'تغییر اقلام پروژه - ' + project name`, required | `c_Title` `CalculationFormula`, `IsCalculated`, `IsRequired` |
| S12 | requester = current user; approver is chosen; both required | `c_Control9` validation chain |
| S13 | search = project + product tree + title-contains + `NazarModir = تایید` | `ListQuery1` criteria |
| S14 | display fields of a part | `DataGridsResult.Fields` + the `c_*` `Value_ListQueryField` bindings |
| S15 | «حذف» deletes only the detail row | `btn_delete` → `form.DeleteRecord(url, "جزئیات تغییر Bom", id)` |

### 1.2 Existing contracts reused (nothing invented)

| Need | Contract | Status |
| --- | --- | --- |
| actor / tenant | `resolveProductionActor(req)` → fails closed 403 | `EXISTS` |
| tenant membership | `USER_DIRECTORY.findTenantMember` | `EXISTS` (already injected in `bom.service`) |
| audit write / read | `ProductionAuditGateway.record` / `.read` → `AUDIT_PORT` | `EXISTS` |
| entitlement | `@RequiresModule('production')` + `@RequiresFeature(…, 'bom')` + `ModuleEntitlementGuard` | `EXISTS` |
| permissions | `production.bom.read` / `.manage` / `.approve` — **exactly three exist and were seeded** | `EXISTS` |
| lifecycle | `BOM_STATUSES`, `bomStatusAfter`, `isBomHeaderEditable` | `EXISTS` (reused, not re-declared) |
| target BOM reader | `BomHeaderRepository.findById(tenantId, id)` | `EXISTS` |
| BOM item reader | `BomItemRepository.findById(tenantId, bomId, itemId)` | `EXISTS` |
| item search | `GET /production/boms/:bomId/items?search=` | `EXISTS` (reused, no new route) |
| pagination pair | `PRODUCTION_MAX_PAGE_SIZE` 100 / `PRODUCTION_DEFAULT_PAGE_SIZE` 20 | `EXISTS` |
| timeline query | `BomTimelineQueryDto` + `resolveProductionTimelineWindow` | `EXISTS` |
| wire helpers | `coreGet` / `corePost` / `corePatch` / `coreDelete` | `EXISTS` |
| UI blocks | `ProductionCard`, `ProductionBadge`, `CoreForbidden`, … | `EXISTS` |

### 1.3 Findings

* **Existing contracts for Change Request / BOM Change / BOM Revision / Apply Change / BOM
  Detail Change: none.** A repo-wide search returned only prose in
  `docs/PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md`, which had recorded the capability as
  **DEFERRED** (§5.4, §23). Nothing was reused because nothing existed.
* **New entities:** `BomChangeRequest`, `BomChangeRequestItem`, enum `BomChangeType`.
* **New routes:** 12, under `production/bom-change-requests`.
* **New permissions:** **NONE** — see §7.
* **Reusable pieces:** everything in §1.2; the BOM Header slice is the direct template.
* **Risks / blockers:** three guard specs pin *exact counts* (controllers, client importers,
  identity consumers, relation declarations). Adding the aggregate required deliberate edits
  to them — recorded in §11.4 as **strengthened**, not weakened, assertions.

### 1.4 Source-unknown rules (deliberately not invented)

`[OPEN]` What «غیر فعال سازی» changes on `BomItem` after approval → **DEFERRED / CONTRACT NOT
ESTABLISHED** (§12). `[OPEN]` Whether a detail may be edited after being added (the source only
adds and deletes) → provided because the brief's contract list asks for `PATCH`, gated by the
same `status == 'DRAFT'` guard. `[OPEN]` Whether a decided request may be reopened → not in the
source, not implemented. `[OPEN]` `NazarModir = تایید` as an item filter → not used: Production
stores it on the item as `legacyManagerOpinion`, documented as *"Preserved, never a decision
input"*, so the brief's restated criterion (items of this request's BOM) is what applies.

---

## 2. Domain Model

### 2.1 Status — a deliberate REUSE, not a new enum `[SOURCE] + [ARIYA]`

The source's `c_status` integers are `0 / 1 / 50 / 100`, the approval task moves the document
through `2` while the manager decides, and «نیاز به اصلاح» writes `0` again. Those are
*exactly* the four facts Production's `BomStatus` already names (`DRAFT / SUBMITTED /
APPROVED / REJECTED`) with *exactly* the header's correction-to-draft rule.

**Decision:** `BomChangeRequest.status` uses the SAME `BomStatus` enum, and `managerOpinion`
uses the SAME `ManagerOpinion` enum. `bom-change.ts` therefore does **not** re-declare the
lifecycle: it re-exports `isBomHeaderEditable` as `isBomChangeRequestEditable` and
`bomStatusAfter` as `bomChangeRequestStatusAfter`. A second four-value vocabulary would have
been the same words written twice, free to drift the moment one of them gained a state. The
schema now states `BomStatus` / `ManagerOpinion` **once**, in one place
(`production-schema.spec.ts` J re-asserts the member lists).

**Why `2` is not a state:** the workflow engine that moves `StateNext → State` is not in the
supplied material (the preflight §11.2 records this), so `SUBMITTED` covers "routed, awaiting
the decision" — the same call the BOM header already took.

### 2.2 `BomChangeRequest` (header)

| Column | Source field | Notes |
| --- | --- | --- |
| `id` | — | UUID v4, the repository's convention `[ARIYA]` |
| `tenantId` | — | isolation key, first on every index `[ARIYA]` |
| `bomId` | `c_bomId` | **composite FK** → `BomHeader(tenant_id, id)`, `RESTRICT` |
| `title` | `c_Title` / `Title` | required, `VARCHAR(200)`, **stored** — see §2.5 |
| `projectRef` | `NameProje` | opaque copy of the target BOM's value, no FK |
| `productTreeRef` | `c_ProductTreeRef` | opaque copy of the target BOM's value, no FK |
| `requesterUserId` | `c_DarkhastKonnade` | **`actor.userId`**, never on the wire `[SOURCE intent + ARIYA]` |
| `approverUserId` | `c_ModirTaeadKonande` | snapshot; `NULL` while DRAFT; frozen at submit |
| `status` | `c_status` | `BomStatus` (§2.1) |
| `managerOpinion` | `c_NazarModirTaeadKonande` | `ManagerOpinion`, `NULL` until decided |
| `notes` | `c_Tozihat` / `cr_Tozihat` | one column, exactly as the source writes both |
| `requestDate` | `c_TarikhDarkhast` | defaults to creation, as the source's `DatePicker` |
| `submittedAt` / `decidedAt` / `decidedByUserId` | `TarikhTaead…` | audit evidence `[ARIYA]` |
| `createdAt` / `updatedAt` | — | `[ARIYA]` |

### 2.3 `BomChangeRequestItem` (detail — «جزئیات تغییر Bom»)

| Column | Source field | Notes |
| --- | --- | --- |
| `id` | — | UUID v4 |
| `tenantId` | — | isolation key |
| `changeRequestId` | `IdBomChangeStack` **and** `idBomChange` | the source wrote **both** with the same value; modelled **once** |
| `bomItemId` | `IdBomFehresteAghlameProje` | composite FK → `BomItem(tenant_id, id)`, `RESTRICT` |
| `changeType` | `NoeaTaghir` | `BomChangeType { QUANTITY_CHANGE, DEACTIVATE }` |
| `originalDrawingCoefficient` | `MizanAvaliyeZaribMasrafInMap` | snapshot, `NOT NULL` |
| `originalSpareCoefficient` | `MizanAvaliyeZaribMasrafYadaki` | snapshot, `NOT NULL` |
| `drawingCoefficientDelta` | `MizanAfzayeshZaribMasrafInMap` | `Int?`, signed |
| `spareCoefficientDelta` | `MizanAfzayeshZaribMasrafYadaki` | `Int?`, signed |
| `createdAt` / `updatedAt` | — | `[ARIYA]` |

**Not modelled:** the source's detail `Title`, which it set to the *change request's* title —
a SharePoint mandatory-title artefact, not a fact. The part name is **read** through the FK at
display time rather than copied, so it can never go stale.

### 2.4 The two change types `[SOURCE]`

`BomChangeType { QUANTITY_CHANGE, DEACTIVATE }` mirrors `Lookup_StaticValues` member for
member. Persian labels live in `BOM_CHANGE_TYPE_LABELS` (`تغییر موجودی` / `غیر فعال سازی`).

`DEACTIVATE` is modelled as a **recorded intent** and nothing else. The source proves the
value exists (the radio, and the `NoeaTaghir` column) and proves nothing about what approval
would then write: no script sets a flag, no state column moves, nothing is deleted. The
schema, the repository, the service and the UI therefore contain **no** `inactive` column, no
`BomItem` state, no deletion and no `apply()` — see §12.

### 2.5 Title `[SOURCE] + [ARIYA]`

The source computed `'تغییر اقلام پروژه - ' + <project name>` from a lookup Ariya has no
contract for. Deriving a title from an opaque `projectRef` would be a fabricated name, so —
exactly as decision **M-1** took for the BOM header — the title is a **stored, required**
value the caller states. This is a deliberate, documented divergence.

### 2.6 The derived total `[SOURCE]`

`original + delta` is computed **only for display**, in `productionBomChangeTotal`
(`apps/web/src/lib/production-labels.ts`). It is not a column, not a DTO field and never sent:
the source's `ValueChangeScript` also computed it on screen and never wrote it anywhere.


---

## 3. Database / Migration

**Migration:** `apps/api/prisma/production/migrations/20261003132500_production_bom_change_request/migration.sql`
(created with `prisma migrate dev --create-only`, then given a prose header and one
hand-written statement; applied with `prisma migrate deploy`).

* **Schema:** `apps/api/prisma/production/schema.prisma` — `enum BomChangeType`,
  `model BomChangeRequest`, `model BomChangeRequestItem`, plus two additive back-relations
  (`BomHeader.changeRequests`, `BomItem.changeRequestItems`) that give the composite foreign
  keys a target.
* **Independent database preserved:** the change request lives in `production_db`, reached
  only through `PRODUCTION_DATABASE_URL`. **NO cross-database FK** — `projectRef`,
  `productTreeRef` and the three user-id columns are opaque `STRING` columns.
* **Three same-database composite FKs**, each over a tenant-first UNIQUE pair, each
  `ON DELETE RESTRICT ON UPDATE CASCADE`:
  `(tenant_id, bom_id)` → `BomHeader`, `(tenant_id, change_request_id)` →
  `BomChangeRequest`, `(tenant_id, bom_item_id)` → `BomItem`.
* **Indexes (tenant-first, every one leading with `tenant_id`):**
  `BomChangeRequest_tenantId_id_key` (unique), `…_tenantId_bomId_idx`, `…_tenantId_status_idx`;
  `BomChangeRequestItem_tenantId_id_key` (unique), `…_tenantId_changeRequestId_idx`, and the
  duplicate rule `BomChangeRequestItem_tenantId_changeRequestId_bomItemId_key` (unique).
* **Timestamps** on both tables; **actor references remain opaque** (`requesterUserId`,
  `approverUserId`, `decidedByUserId`).
* **One hand-written statement:** `BomChangeRequest_submitted_requires_approver` — the same
  CHECK the header carries, because "SUBMITTED and nobody was asked" is not a state either
  document permits. Prisma cannot express a CHECK, so it is declared in the migration.
* **Purely additive:** no `DROP`, no `TRUNCATE`, no `DELETE`, no `UPDATE`, no trigger, no
  function, no `total` column, no `inactive`/`deactivated` column — all asserted by
  `production-schema.spec.ts` J and K.
* **Cross-tenant behaviour:** every repository read carries `tenantId`, so another tenant's
  row is a **404** indistinguishable from "does not exist" — no existence leak.

---

## 4. API Contracts

Namespace `production/bom-change-requests` under the global `api/v1` prefix. Twelve routes —
the brief's list plus the timeline read, which reuses the header's existing route shape.

| Method | Path | Permission | Status |
| --- | --- | --- | --- |
| `GET` | `/production/bom-change-requests` | `production.bom.read` | 200 |
| `GET` | `/production/bom-change-requests/:id` | `production.bom.read` | 200 / 404 |
| `GET` | `/production/bom-change-requests/:id/timeline` | `production.bom.read` | 200 / 404 / 503 |
| `POST` | `/production/bom-change-requests` | `production.bom.manage` | 201 / 400 / 404 |
| `PATCH` | `/production/bom-change-requests/:id` | `production.bom.manage` | 200 / 409 |
| `POST` | `/production/bom-change-requests/:id/items` | `production.bom.manage` | 201 / 400 / 404 / 409 |
| `PATCH` | `/production/bom-change-requests/:id/items/:itemId` | `production.bom.manage` | 200 / 400 / 404 / 409 |
| `DELETE` | `/production/bom-change-requests/:id/items/:itemId` | `production.bom.manage` | 200 / 404 / 409 |
| `POST` | `/production/bom-change-requests/:id/submit` | `production.bom.manage` | 200 / 400 / 409 |
| `POST` | `/production/bom-change-requests/:id/approve` | `production.bom.approve` | 200 / 403 / 409 |
| `POST` | `/production/bom-change-requests/:id/reject` | `production.bom.approve` | 200 / 403 / 409 |
| `POST` | `/production/bom-change-requests/:id/request-correction` | `production.bom.approve` | 200 / 403 / 409 |

**Register filters** (all server-side, all whitelisted): `page`, `pageSize`, `bomId`,
`projectRef`, `status`, `search` (title contains). `pageSize` is a 400 above 100 at the edge
and `Math.min`-clamped in the service.

**Detail response** is the header **plus all of its detail rows** in one read — the source's
«اقلام انتخاب شده» grid was `PageSize=0`, and a second endpoint for a list the caller must
fetch whole anyway would only add a race between "what the header says" and "what the items
say".

**Deliberately absent from the wire:** `tenantId`, `requesterUserId`, `status`,
`managerOpinion`, `decidedAt`, `decidedByUserId`, `projectRef`, `productTreeRef`,
`originalDrawingCoefficient`, `originalSpareCoefficient`, `total`, `changeRequestId`. The
global pipe's `whitelist` + `forbidNonWhitelisted` makes each of them a **400 naming the
field** rather than a silent drop — asserted field by field in `bom-change.dto.spec.ts`.

**Item search is NOT a new route** `[ARIYA]`: it is the existing
`GET /production/boms/:bomId/items?search=`, which is already server-side, tenant-scoped and
gated by `production.bom.read`. The change-request screen calls it with the request's own
`bomId`, so the scope cannot be pointed elsewhere.


---

## 5. Lifecycle

```
   DRAFT ──submit──▶ SUBMITTED ──approve──▶ APPROVED
     ▲                   │
     │                   ├──reject──▶ REJECTED
     └───────────────────┘
        (request-correction → back to DRAFT)
```

* Transitions are **explicit and guarded**: `SUBMIT` only from `DRAFT`; `APPROVE`, `REJECT`
  and `REQUEST_CORRECTION` only from `SUBMITTED`. Every other pair returns `null`, so no
  route can reach a state the table does not name.
* **Correction is not a fifth state.** It moves the row back to the editable state and
  records the decision, so "returned for correction" stays distinguishable from "never
  submitted" — exactly what the source's «نیاز به اصلاح» branch did (`State = 0`).
* **APPROVED and REJECTED are terminal.** Nothing in the source re-opens a decided request,
  and no route implements one.
* **Editability is one predicate, asked once:** `isBomChangeRequestEditable(status)` — which
  *is* the header's `isBomHeaderEditable`. A corrected row becomes editable again with **no
  separate unfreeze step**, because the only thing consulted is the status.
* **Concurrency is the database's:** `submit` and `decide` carry the expected `from` status
  inside the `UPDATE`, and every detail mutation carries the parent's `DRAFT` predicate
  inside its own statement, so two concurrent acts cannot both win.
* **The submit gate is atomic:** `items: { some: {} }` travels in the SAME conditional
  `UPDATE` as `status`, so an empty request cannot be submitted and a concurrent `DELETE`
  cannot invalidate the check.

---

## 6. Validation Rules

| Rule | Source | Where enforced | Refusal |
| --- | --- | --- | --- |
| change type ∈ {`QUANTITY_CHANGE`,`DEACTIVATE`} | S1 `[SOURCE]` | DTO `@IsIn` + service | 400 `BOM_CHANGE_ITEM_TYPE_INVALID` |
| `QUANTITY_CHANGE` ⇒ at least one delta stated | S2 `[SOURCE]` | service (DTO cannot see the pair) | 400 `BOM_CHANGE_ITEM_DELTA_REQUIRED` |
| `DEACTIVATE` ⇒ **no** delta rule | S1/S10 `[SOURCE]` | nothing — deliberately | — |
| a delta is an integer | S6/S7 `[SOURCE]` | DTO `@IsInt` + `isValidCoefficientDelta` | 400 `BOM_CHANGE_ITEM_DELTA_INVALID` |
| **NO** `> 0`, **NO** max, **NO** precision | S7 — the checks are commented out `[SOURCE]` | nothing — deliberately | — |
| duplicate `(request, item)` refused | S3 `[SOURCE]` | UNIQUE index + service pre-check | 409 `BOM_CHANGE_ITEM_DUPLICATE` |
| ≥ 1 detail before submit | S4 `[SOURCE]` | atomic repository predicate | 400 `BOM_CHANGE_REQUEST_ITEMS_REQUIRED` |
| title non-blank, ≤ 200 | S11 `[SOURCE]` | DTO `@IsNotEmpty` + service `trim()` | 400 `BOM_CHANGE_REQUEST_FIELD_REQUIRED` |
| approver is a tenant member | S12 `[SOURCE intent]` | `USER_DIRECTORY.findTenantMember` | 400 naming the field |
| requester ≠ approver | not in source `[ARIYA]` | service, at create and at patch | 400 naming the rule |
| a detail may change only while `DRAFT` | S10 `[SOURCE]` | `isBomChangeRequestEditable` + relation filter | 409 `BOM_CHANGE_REQUEST_NOT_EDITABLE` |
| an empty PATCH is refused | not in source `[ARIYA]` | service | 400 `BOM_CHANGE_REQUEST_PATCH_EMPTY` |

**The pair rule is evaluated over the EFFECTIVE values on a PATCH**, not over the incoming
object: clearing the last stated delta of a `QUANTITY_CHANGE` is refused for the same reason
as never having stated one.

**D-1 — the delta's type** `[ARIYA decision, from SOURCE evidence]`:
`Int`, **signed**, `Number.isSafeInteger` only. Evidence: the source `parseInt`s every delta;
`BomItem`'s coefficients are `Int` in `production_db`; every `> 0` / `isNaN` guard is inside a
commented-out block; and a decrease is the point of «افزایش/کاهش». A separate predicate
(`isValidCoefficientDelta`) exists because the item's `isValidConsumptionCoefficient` requires
`>= 0` — reusing it would have silently changed the ITEM's rule, and adding `>= 0` here would
have invented one. `bom-change.spec.ts` asserts both halves of that distinction.


---

## 7. Authorization

**NO NEW PERMISSION STRING WAS ADDED** `[ARIYA]`. The Core seed migration
`20261002100100_seed_production_permission_grants` provisioned exactly three `production.*`
strings (`read` / `manage` / `approve`) and granted them to `SUPER_ADMIN` and `ADMIN`; a
`production.bom.change.*` row nobody has been provisioned would be a **guaranteed 403 for
every caller, including SUPER_ADMIN** — the warning `bom-item.controller.ts` and the seed
migration itself already record. The three remits map cleanly:

| Permission | Gates | Why separate |
| --- | --- | --- |
| `production.bom.read` | register, detail, timeline | Reading a document is not authoring it |
| `production.bom.manage` | create, header patch, the three detail mutations, submit | The authorship remit |
| `production.bom.approve` | approve, reject, request-correction | **Deciding** is a different remit from authoring |

Layered on top, per request:

1. **Authentication** — `@UseGuards(JwtAuthGuard)` declared last, so it is the innermost check.
2. **Entitlement** — `@RequiresModule('production')` + `@RequiresFeature('production','bom')`,
   decided by the platform's `ModuleEntitlementGuard`. The FEATURE is `bom`, the same one the
   BOM itself declares: a change request without its BOM is meaningless.
3. **Tenant** — `resolveProductionActor(req)` is the ONLY source of `tenantId`; a request that
   never resolved to a tenant is a **403**, never an unscoped read.

Identity beyond the token:

* the **requester** is `actor.userId`, and a machine caller (`userId === null`) is **403** —
  a document whose requester nobody can name would have no one to hold accountable;
* the **approver** must be a member of THIS tenant (`USER_DIRECTORY.findTenantMember`), and is
  re-verified at submit, so a row is never routed to somebody who has left;
* **self-approval is refused** at create and at patch (the source has no such rule; this is
  the decision `bom.service.ts` already took for the header);
* **only the snapshotted approver may decide** — `actor.userId === row.approverUserId`, an
  equality against the STORED value, so a `null` actor is refused by construction;
* the **approver snapshot is frozen** at submit by the repository's `status: 'DRAFT'`
  predicate on the header patch.

---

## 8. UI

Persian-first, RTL, reuse of the module's own building blocks
(`ProductionCard`, `ProductionBomStatusBadge`, `ProductionEmptyState`, `ProductionPagination`,
`CoreLoading` / `CoreError` / `CoreForbidden`). Every interactive element carries a
`data-testid`.

| Route | Component | What it is |
| --- | --- | --- |
| `/admin/production/changes` | `ProductionBomChangeListView` | the register: title search, project, BOM id, status; paged with the server envelope |
| `/admin/production/changes/new` | `ProductionBomChangeFormView` | «ثبت درخواست تغییر BOM» — BOM id, title, approver, notes |
| `/admin/production/changes/[id]` | `ProductionBomChangeDetailView` + `ProductionBomChangeTimeline` | the document and its history |

The detail screen follows the source's own section order:

1. **§1 «ثبت درخواست»** — title, project, product tree, BOM (linked), requester, approver,
   request date, status, opinion, notes. **All read-only**, because the backend accepts a
   PATCH of title / approver / notes only while DRAFT and the source let no operator rewrite
   a routed header.
2. **§2–§3 «جست و جو بر اساس» / «نتایج جست و جو»** — keyword search **scoped to this
   request's BOM**, showing part name, industry name, standard code, part type,
   specifications, maker, material, unit and both coefficients. Rendered only while the row is
   a DRAFT and only to a `production.bom.manage` holder.
3. **§4 «اقلام انتخاب شده»** — the grid: part, change type, both ORIGINAL values, both deltas
   and both DERIVED totals (`original + delta`, computed on screen, not clamped).
   `standardPartCode` renders as stored — `—` for a row this API created — and is never an
   input.
4. **The add/edit form** — the «نوع تغییر» radio (the source's two values) and the two delta
   inputs (`type="number"` `step="1"`, mirroring `Decimals=0 Step=1`). Both are **disabled**
   for «غیر فعال سازی», exactly as the source's `EnabledFormula` disabled them.
5. **§5 «وضعیت تایید مافوق»** — the stored status and opinion, read-only, plus the three
   decision buttons shown ONLY to a `production.bom.approve` holder on a SUBMITTED row.
6. **Timeline** — the read-only audit history.

**What the UI does NOT offer, deliberately:** a status field, a requester field, a
standard-code field, any control for an original coefficient or a total, a per-item approval
button, and any "apply" action. Each is either read-only, server-derived or deferred.

`productionBomChangeTypeLabel` falls back to the raw token for a value nobody defined, and
`productionBomChangeTotal` is a pure function of the two stored numbers — so two screens can
never disagree about either.


---

## 9. Audit

**One resource: `production.bom.change`** (`PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST`).
All nine action families are recorded with `resourceId = <change request id>`:

| # | Action | When |
| --- | --- | --- |
| 1 | `create` | the request is created |
| 2 | `update` | title / approver / notes patched while DRAFT |
| 3 | `add_item` | a detail row is added |
| 4 | `update_item` | a detail row is changed |
| 5 | `remove_item` | a detail row is deleted (carries the removed values) |
| 6 | `submit` | DRAFT → SUBMITTED |
| 7 | `approve` | the approver's positive decision |
| 8 | `reject` | the approver's negative decision |
| 9 | `request_correction` | SUBMITTED → DRAFT, decision recorded |

**WHY ONE RESOURCE AND NOT TWO** `[ARIYA]`: the BOM header splits `production.bom` from
`production.bom.item` because an ITEM is its own aggregate with its own identity and lifetime.
A change request's detail rows are a bounded part of the request — no status of their own,
unable to exist outside one — and the brief requires the request's timeline to carry the
detail acts. Correlating those would otherwise need a `resourceId` the platform read contract
cannot filter on (the structural wall
`docs/PHASE-PRODUCTION-BOM-AUDIT-TIMELINE-IMPLEMENTATION.md` records). One resource removes it.

The trail is written **only through `ProductionAuditGateway`** — never by a direct Prisma call,
and never reconstructed from `BomChangeRequest` rows. `production-isolation.spec.ts` still
asserts `AUDIT_PORT` appears in the gateway and nowhere else. Events are recorded only AFTER a
write succeeded, and they carry the row the repository RETURNED.

`GET /production/bom-change-requests/:id/timeline` reads through the same gateway with the
platform's own pagination contract. A **404** precedes the audit boundary for a row this tenant
does not own, `EMPTY` is not `FAILED` (a rejected read is a **503 `AUDIT_READ_FAILED`**, never a
quiet empty page), and the projection is an explicit whitelist of the same seven fields the
header's timeline exposes.

Web-side, the three new verbs have Persian labels in the ONE shared
`PRODUCTION_BOM_AUDIT_ACTION_LABELS` map, and an unknown verb still falls back to its raw token.


---

## 10. Tests

**155 new tests, all green** — 97 API + 58 web.

### 10.1 API — `apps/api/src/modules/production/bom-change/`

| Suite | Tests | What it pins |
| --- | --- | --- |
| `bom-change.spec.ts` | 14 | the two-value change type (and the SCHEMA enum agreeing with it), the 11 typed error codes and their separation from the header's namespace, `isValidCoefficientDelta` (signed integers, and **not** the item's `>= 0` rule), the S2 pair rule (`null`/`null` refused, `0` accepted, `DEACTIVATE` unconstrained), editability **by identity** with `isBomHeaderEditable`, and the whole transition table |
| `bom-change.repository.spec.ts` | 14 | tenant in EVERY `where`; `findUnique` never used (fake AND source); the list counting with the page's own predicate; `submit` carrying `items: { some: {} }` + `from`; `submit` writing NO decision column; `decide` guarded by `from`; the transaction guard before an INSERT and no insert when it fails; the parent `DRAFT` relation filter on update/delete; **source-level proof that this repository never writes `BomHeader` or `BomItem`** |
| `bom-change.service.spec.ts` | 39 | requester from the actor (machine caller refused); snapshot from the ITEM; 404 for a foreign BOM / foreign item / other tenant; duplicate refusal; delta pair and integrality; the EFFECTIVE-pair rule on PATCH; DRAFT-only mutations (all four refused on SUBMITTED); the empty-submit gate mapped to its typed code and **not** to a generic conflict; correction returning to DRAFT and re-enabling edits; the approver-only decision with 403 for everyone else; **APPROVING WRITES NOTHING ON THE BOM**; the timeline's scope, 404 and 503; and the two projections |
| `bom-change.controller.spec.ts` | 11 | no route ungated; exactly the three existing permission strings (3 read / 6 manage / 3 approve); module + feature declared once from the constants; the **twelve-route table** compared as tuples of (verb, path, permission); UUID v4 on both path params; no tenant/user-id on the wire; the actor resolved on every route and each decision routed to its own opinion |
| `bom-change.dto.spec.ts` | 19 | column-width bounds; the blank-check split between the edge and the service; `bomId` must be a UUID v4; the change type as a closed set; a delta accepted as `5 / -5 / 0` and refused as `1.5 / 'three'`; **no `@Min`/`@Max` on either delta** (read from the file, because decorators are not part of the class body); `null` clearing a delta; every domain-owned field refused by name on every DTO; the page ceiling and the clamped window |


### 10.2 Web — `apps/web/src`

| Suite | Tests | What it pins |
| --- | --- | --- |
| `lib/__tests__/production-change-api.spec.ts` | 18 | exact paths for all twelve routes; stable query serialization with Persian encoding and the `pageSize` cap; no tenant / resource / action on any read; create sending ONLY the four caller-owned fields; add-item sending NO original and NO total; `null` clearing a delta; submit with **no body**; each decision on its own path; the timeline rejecting on outage |
| `lib/__tests__/production-change-labels.spec.ts` | 6 | the two change types and their source labels; `original + delta` with a null delta as `0`; **no clamp at zero**; every new code mapped to a Persian sentence; the three legacy sentences verbatim; unknown-code fallback to the server message |
| `components/…/ProductionBomChangeListView.spec.tsx` | 7 | read gate issuing NO request; rows, badge and detail link; create CTA only with `manage`; the four server-side filters; the empty state |
| `components/…/ProductionBomChangeFormView.spec.tsx` | 5 | manage gate; exactly four inputs and **no** requester/date control; create payload trimmed and free of server-owned fields; `notes` omitted when blank; a refusal rendered from its typed code |
| `components/…/ProductionBomChangeDetailView.spec.tsx` | 22 | read gate issuing NO request; every header field read-only; a 404 rendered from its code; both coefficient pairs and the derived (unclamped) total; the empty state; **submitted is read-only** (no search, no form, no mutations, no submit); search scoped to the request's own `bomId`; add / edit / delete of a detail; the `DEACTIVATE` deltas disabled; the duplicate and delta-required refusals in the source's own words; the empty-submit refusal; correction re-enabling edits; the three decision buttons gated on `approve` + SUBMITTED and routed individually; the deferred-apply notice; the timeline read |

### 10.3 Deliberate edits to pre-existing guard specs

Four guard specs pinned counts that this phase legitimately changes. Each was edited to state
the **new** count with a comment naming this phase — the assertions were made stricter, never
weaker, and **no test was skipped, deleted or loosened**:

| Spec | Edit |
| --- | --- |
| `production-schema.spec.ts` | relation declarations 1 → 4 (each asserted to reference the tenant-first pair with `Restrict`); two new tests **J** and **K** for the change-request migration — tables, enum, signed-nullable deltas, NOT NULL originals, no `total`, no `inactive` column, no trigger, six tenant-first indexes, three same-database FKs, the approver CHECK, purely additive |
| `production-isolation.spec.ts` | controllers 2 → 3; client type-importers 3 → 4; identity consumers 1 → 2 (`bom.service` + `bom-change.service`); the two non-vacuity floors raised (25 / 15) |
| `production-entitlement.spec.ts` | the entitled-file list gains `bom-change.controller.ts` |
| `src/lib/__tests__/production-labels.spec.ts` (web) | the audit-label map 7 → 10 verbs, with the reason the shared map grew |


---

## 11. Verification

Executed after implementation. Nothing was skipped, and no failure was resolved by weakening an
assertion or deleting a test.

| # | Gate | Result |
| --- | --- | --- |
| 1 | **typecheck (API)** `npx tsc --noEmit -p tsconfig.json` | **0 errors** |
| 2 | **typecheck (web)** `npx tsc --noEmit` | **0 errors** |
| 3 | **lint (API)** `npx eslint "src/**/*.ts"` | **0 problems in `src/modules/production/**`** — including every new `bom-change/*` file, which was also linted on its own (`exit 0`). The run reports 4255 pre-existing errors in 110 OTHER files (mostly `src/generated/**` and untouched modules); none of them is in this phase's diff. |
| 4 | **lint (web)** `npx eslint "src/**/*.{ts,tsx}"` / `npm run lint` | **BLOCKED — pre-existing, unrelated to this change.** `.eslintrc.js` cannot be loaded at all (`TypeError: Converting circular structure to JSON` while resolving `next/core-web-vitals`), and `next lint` is not a command in Next 16 (the CLI treats `lint` as a directory). Both failures reproduce on files this phase never touched — e.g. `npx eslint src/lib/production-labels.ts` fails identically. Recorded in §12; not "fixed" here because repairing the shared lint configuration is a separate change. |
| 5 | **unit tests (API)** `npx jest` | **229 suites / 3786 tests passed, 0 failed** |
| 6 | **unit tests (web)** `npx jest` | **99 suites / 1727 tests passed, 0 failed** |
| 7 | **architecture + policy** `src/architecture-boundaries.spec.ts`, `src/runtime-policy.spec.ts` | **2 suites / 56 tests passed** |
| 8 | **full Production suite** `npx jest src/modules/production` | **18 suites / 272 tests passed** |
| 9 | **Prisma validation** `prisma validate --schema=prisma/production/schema.prisma` | **"The schema is valid"** |
| 10 | **migration validation** `prisma migrate deploy` then `migrate status` | **"3 migrations found … All migrations have been successfully applied … Database schema is up to date!"** |
| 11 | **build** `npx nest build` | **succeeded**; `dist/modules/production/bom-change/{controller,service,repository,dto,bom-change}.js` present |
| 12 | **readiness / liveness** on the freshly built API | `GET /api/v1/live` → **200** `alive`; `GET /api/v1/ready` → **200** `ready` with `"productionDatabase": "ok"`, `"statuses":{"productionDatabase":"ok",…}`, `"blocking":[]`; `GET /api/v1/health` → **200** `ok` |
| 13 | **smoke test of the new endpoints** | the boot log maps **all twelve** routes; every one answers **401** without a token (registered AND guarded) — list, detail, timeline, create, header patch, add-item, edit-item, delete-item, submit, approve, reject, request-correction. A control path `GET /api/v1/production/bogus` answers **404**, which is what makes the 401s meaningful rather than a catch-all. |

**13 / 13 gates passed; gate 4 is a pre-existing repository/environment blocker reproduced on
untouched files.**

*On test stability:* one run of the full web suite was executed while three other jobs shared
the machine, and two suites this phase never touched (`components/admin/__tests__/BlogCreateForm.spec.tsx`,
`components/hr/__tests__/MissionPolicyVersionPanel.spec.tsx`) failed on their 20s/45s timers.
Re-run in isolation they pass (**41/41**), and the final uncontended full run is **99 suites /
1727 tests, 0 failures**. No assertion was changed; the numbers above are from the clean run.

Smoke evidence, verbatim from the boot log:

```
Mapped {/api/v1/production/bom-change-requests, GET}
Mapped {/api/v1/production/bom-change-requests/:id, GET}
Mapped {/api/v1/production/bom-change-requests/:id/timeline, GET}
Mapped {/api/v1/production/bom-change-requests, POST}
Mapped {/api/v1/production/bom-change-requests/:id, PATCH}
Mapped {/api/v1/production/bom-change-requests/:id/items, POST}
Mapped {/api/v1/production/bom-change-requests/:id/items/:itemId, PATCH}
Mapped {/api/v1/production/bom-change-requests/:id/items/:itemId, DELETE}
Mapped {/api/v1/production/bom-change-requests/:id/submit, POST}
Mapped {/api/v1/production/bom-change-requests/:id/approve, POST}
Mapped {/api/v1/production/bom-change-requests/:id/reject, POST}
Mapped {/api/v1/production/bom-change-requests/:id/request-correction, POST}
```


---

## 12. Known Limitations / Deferred Items

### `DEFERRED / CONTRACT NOT ESTABLISHED` — Apply Change and the effect of «غیر فعال سازی» on `BomItem`

**This is the phase's central deliberate omission, stated as such.**

What the source establishes: the change TYPE `غیر فعال سازی` exists (`c_NoeaTaghir`'s radio and
the detail's `NoeaTaghir` column), that a detail of that type can be recorded, displayed and
routed, and that it needs no delta.

What the source does **NOT** establish: anything about what approval would then change on the
BOM item. `BomEdit.txt`'s approval task writes `NazarModirTaeadKonande`, `Tozihat` and
`TarikhTaead` back to the request list and nothing else; no script sets a flag, no state column
moves, nothing is deleted.

Therefore this phase **does not**:

* create an `inactive` / `deactivated_at` column on `BomItem`;
* create a state or status on `BomItem`;
* delete, archive or deactivate a `BomItem`;
* renumber the BOM;
* write **any** column of `BomHeader` or `BomItem` during `approve`.

That last one is asserted, not promised: `bom-change.repository.spec.ts` and
`bom-change.service.spec.ts` both re-read their sources and fail if a
`headers.*`/`items.*` write or an `applyChange` identifier ever appears, and
`production-schema.spec.ts` J fails if the migration ever grows a trigger, a function or an
`UPDATE`/`DELETE` statement. Approving records a **decision** and returns.

**Next step is a contract, not a code change**: whoever supplies the Apply semantics must state
which field of which row is written for each change type, and only then may an `apply` method,
its guards, its idempotency and its own audit action be added.

### Other limitations

| # | Item | Why it is open |
| --- | --- | --- |
| L1 | **`NazarModir = تایید` is NOT an item-search criterion.** The source filters eligible items by it (`ListQuery1`), but Production stores that value on the item as `legacyManagerOpinion`, documented as *"Preserved, never a decision input"*. The brief restates the criterion as "items of this request's BOM", which is what the screen implements. | using a documented non-authority as a filter would make it one |
| L2 | **Title is typed, not derived.** The source composes `'تغییر اقلام پروژه - ' + <project name>`; Ariya has no project-name contract, so deriving from an opaque `projectRef` would fabricate a name. Same decision as M-1 for the BOM header. | no project-name contract exists |
| L3 | **`requestDate` is `TIMESTAMPTZ(6)`, not `DATE`.** The source's `DatePicker` was date-only; a timestamp is a superset, and the UI renders a date. | storage choice, not a behaviour; recorded rather than hidden |
| L4 | **`PATCH /production/bom-change-requests/:id`** is beyond the brief's minimum list. It exists because the sibling aggregate's header has one, and without it a wrong approver could never be corrected before submit. It is DRAFT-only, re-validates the approver and re-runs the self-approval rule, and is refused with `BOM_CHANGE_REQUEST_PATCH_EMPTY` when it changes nothing. | repo convention; the source only proves header editability for a brand-new record |
| L5 | **Detail `PATCH` is not in the source** (the source only adds and deletes). It is provided because the brief's contract asks for it, and it is gated by the SAME `status == 'DRAFT'` predicate as the add/delete, so it cannot reach a state the source could not. | brief requirement, not source behaviour |
| L6 | **Decided requests are terminal.** Nothing re-opens `APPROVED` / `REJECTED`. | not in the source |
| L7 | **Web lint is blocked** by a pre-existing `.eslintrc.js` / `eslint-config-next` incompatibility (and `next lint` not existing in Next 16). It reproduces on files this phase never touched. | environment/config, out of scope for this change |
| L8 | **No dedicated HTTP e2e suite for the new routes.** The brief's API matrix is covered by the controller's route/permission matrix (11 tests), the DTO's payload matrix (19) and the service's lifecycle/authority matrix (39), plus the live boot smoke in §11. A token-bearing supertest flow would need seeded tenant membership and credentials the repository has no fixture for. | no test harness for a seeded authenticated session |

### Explicitly NOT done (the brief's prohibitions, confirmed)

No Project Management · no Reporting · no Product Tree domain · no Procurement integration ·
no Apply Change · no `inactive` state on `BomItem` · no live mutation of `BomItem` on approve ·
no BOM renumbering · no Standard Code generation · no legacy person hard-coded into
authorization · no cross-database FK · no direct Prisma access to the Audit platform · no
business rule that neither the source nor an existing contract establishes.


---

## 13. Files Changed

### New (20)

```
apps/api/prisma/production/migrations/20261003132500_production_bom_change_request/migration.sql
apps/api/src/modules/production/bom-change/bom-change.ts                  — vocabulary, the pair rule, the delta type
apps/api/src/modules/production/bom-change/bom-change.dto.ts              — the wire contract + the view types
apps/api/src/modules/production/bom-change/bom-change.repository.ts       — the persistence boundary
apps/api/src/modules/production/bom-change/bom-change.service.ts          — the application surface
apps/api/src/modules/production/bom-change/bom-change.controller.ts       — the twelve routes
apps/api/src/modules/production/bom-change/bom-change.spec.ts             — 14 tests
apps/api/src/modules/production/bom-change/bom-change.repository.spec.ts  — 14 tests
apps/api/src/modules/production/bom-change/bom-change.service.spec.ts     — 39 tests
apps/api/src/modules/production/bom-change/bom-change.controller.spec.ts  — 11 tests
apps/api/src/modules/production/bom-change/bom-change.dto.spec.ts         — 19 tests
apps/web/src/app/admin/production/changes/page.tsx                        — register route
apps/web/src/app/admin/production/changes/new/page.tsx                    — create route
apps/web/src/app/admin/production/changes/[id]/page.tsx                   — detail route
apps/web/src/components/production/ProductionBomChangeListView.tsx
apps/web/src/components/production/ProductionBomChangeFormView.tsx
apps/web/src/components/production/ProductionBomChangeDetailView.tsx
apps/web/src/components/production/ProductionBomChangeTimeline.tsx
apps/web/src/components/production/__tests__/ProductionBomChangeListView.spec.tsx      — 7 tests
apps/web/src/components/production/__tests__/ProductionBomChangeFormView.spec.tsx      — 5 tests
apps/web/src/components/production/__tests__/ProductionBomChangeDetailView.spec.tsx    — 22 tests
apps/web/src/lib/__tests__/production-change-api.spec.ts                              — 18 tests
apps/web/src/lib/__tests__/production-change-labels.spec.ts                            — 6 tests
```

### Modified (9)

| File | Why |
| --- | --- |
| `apps/api/prisma/production/schema.prisma` | `enum BomChangeType`, two models, two additive back-relations |
| `apps/api/src/modules/production/production.constants.ts` | `PRODUCTION_AUDIT_RESOURCE.BOM_CHANGE_REQUEST` + the reason this aggregate is ONE resource |
| `apps/api/src/modules/production/production.module.ts` | register the controller, repository and service |
| `apps/api/src/modules/production/production-schema.spec.ts` | relations 1 → 4; tests J and K for the new migration |
| `apps/api/src/modules/production/production-isolation.spec.ts` | controllers 2 → 3, client importers 3 → 4, identity consumers 1 → 2, floors raised |
| `apps/api/src/modules/production/production-entitlement.spec.ts` | the entitled-file list gains the new controller |
| `apps/web/src/lib/production-api.ts` | types, query builder and the twelve client functions |
| `apps/web/src/lib/production-labels.ts` | change-type labels, `productionBomChangeTotal`, three audit verbs, eleven error messages |
| `apps/web/src/lib/__tests__/production-labels.spec.ts` | the shared audit-label map grew from 7 to 10 verbs |

Plus this report: `docs/PHASE-PRODUCTION-BOM-CHANGE-IMPLEMENTATION.md`.

**Untouched:** every file of the BOM header and BOM item slices other than the four guard
specs and the composition root listed above; `permissions.ts`; every Core migration; and the
pre-existing untracked artefacts (`apps/web/next-env.d.ts`, `phaseui*-qa*`, `backups/`), which
were **not** added to the commit.

### Which behaviours come from the source, and which from Ariya's architecture

| Behaviour | Origin |
| --- | --- |
| two change types and their Persian labels (S1) | `[SOURCE]` |
| the delta pair rule for `QUANTITY_CHANGE` (S2) | `[SOURCE]` |
| the duplicate-detail refusal and its sentence (S3) | `[SOURCE]` |
| the empty-request submit gate and its sentence (S4) | `[SOURCE]` |
| storing BOTH originals with BOTH deltas (S6) | `[SOURCE]` |
| integer-only deltas; no `> 0`, no max, no precision (S7) | `[SOURCE]` |
| `original + delta` as display-only, never clamped (S8) | `[SOURCE]` |
| four states + correction-to-draft (S9) | `[SOURCE]`, mapped onto the EXISTING `BomStatus` |
| `DRAFT`-only editing of details (S10) | `[SOURCE]` |
| title required; search + select + add + delete while DRAFT | `[SOURCE]` |
| the part fields shown in search results (S14) | `[SOURCE]` |
| detail-only deletion (S15) | `[SOURCE]` |
| requester = current user (S12) | `[SOURCE intent]`, implemented as `actor.userId` |
| tenant-first keys, opaque references, composite FKs | `[ARIYA]` |
| `DRAFT → SUBMITTED → APPROVED/REJECTED` enum reuse | `[ARIYA]` (a decision about where to put S9) |
| self-approval refused; approver-only decision; fail-closed 403 | `[ARIYA]` |
| one audit resource for all nine families | `[ARIYA]` |
| typed error codes instead of message strings | `[ARIYA]` |
| stored title instead of a derived one (S11 diverges) | `[ARIYA]` |
| reuse of `GET /boms/:bomId/items` for the item search (S13) | `[ARIYA]` |
| reusing the three existing permissions | `[ARIYA]` |
| Apply Change | **`DEFERRED / CONTRACT NOT ESTABLISHED`** |


---

## 14. Commit Hash

> **Implementation commit — `81dfe2668dbe1b29d94c2adab2f5098b66d97f5f`** (`81dfe26`)
> `feat(production): add bom change request`

It contains the whole phase: 33 files changed, **9,087 insertions, 40 deletions** — the
migration, the schema, the five API source files, the five API specs, the three web routes, the
four UI components, the five web specs, the four deliberate guard-spec edits and sections 1–13
of this report. **All 13 verification gates in §11 passed against exactly that tree, and nothing
was committed until every relevant test was green.**

This section was appended afterwards and is carried by the follow-up docs commit, because a
commit cannot contain its own hash. That follow-up changes **no** code, migration, test or
configuration; the verified state of the repository remains the implementation commit above.

