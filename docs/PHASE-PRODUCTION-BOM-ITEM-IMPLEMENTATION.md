# PHASE PRODUCTION-BOM-ITEM — IMPLEMENTATION REPORT

**Module:** Production (bounded context) · **Base checkpoint:** `5854745`
· **Phase:** PRODUCTION-BOM-ITEM (the BOM Item child aggregate, the empty-BOM submit gate,
its API, audit, tests and UI)

---

## 1. What this phase is, in one paragraph

The BOM HEADER shipped in the previous phase as an aggregate root that could be authored,
routed, decided and audited — but that could hold **nothing**. This phase adds the **BOM
ITEM**, the child the source is explicit about (two SharePoint lists joined by
`BomAddRelated`), and with it the one header rule that was deliberately *deferred* rather
than faked: **a BOM with no items cannot be submitted** (the source's V8,
`اقلامی ثبت نشده است!`). It also adds the item CRUD API, its audit family, its tenant/BOM
scoping, the owner-reviewable tests, and the Persian-first UI (register, create/edit,
detail with the items grid and the lifecycle actions).

**The single hard dependency that remains is Product Tree Code.** Nothing in this phase
generates, formats, prefixes or renumbers `CodeStandardDarSanat`: the column is modelled,
**nullable and reserved**, and no route, service, DTO or screen may write it. That is what
let the item aggregate ship at all — the previous decision document classified *item
persistence* as `BLOCKED` **because** `standardPartCode` was assumed to be **required**;
this phase keeps the aggregate and defers only the code, which is the exception the brief
authorises.

---

## 2. Preflight — the contracts this phase reuses (nothing invented)

| Concern | Contract in the repository | How this phase uses it |
| --- | --- | --- |
| actor / tenant | `resolveProductionActor(req)` (`production-actor.ts`) | The only source of `tenantId`/`userId`; no DTO and no route accepts either |
| authorization | `Permissions.PRODUCTION_BOM_READ` / `_MANAGE` / `_APPROVE` + `@Roles` | Items reuse the HEADER's two permissions; **no** `production.bom.item.*` is invented |
| entitlement | `@RequiresModule` / `@RequiresFeature` + `ModuleEntitlementGuard` | The item controller declares the SAME `PRODUCTION_FEATURE.BOM` |
| audit | `ProductionAuditGateway` → `AUDIT_PORT` → `core_db."AuditLog"` | A new resource member; the gateway is unchanged |
| identity | `USER_DIRECTORY` | **Not needed** for items (no identity field on an item) — and none is added |
| errors | `StandardExceptionFilter` passes an object payload through as `error.code` | New refusals are typed: `PRODUCTION_BOM_ERROR_CODES` |
| paging | the Commerce/HR page-size convention | Two Production constants, enforced in the DTO **and** the service |
| search | `SEARCH_SOURCE_PORT` (`platform/search-source`) | **DEFERRED** — see §8 |
| notification | Core Notification Center (`NotificationService.createForUser`) | **NOT WIRED** — audit ≠ notification; see §8 |
| purchase/procurement | *no BOM-consumption contract exists* | **BLOCKED** — see §10 |

---

## 3. Database (Production's own Prisma project, its own migration)

### 3.1 The model

`prisma/production/schema.prisma` gains two enums and one model:

* `enum BomPartType { STRUCTURAL STANDARD }` — the source's `Noe_Ghatae` «ساختی;استاندارد».
* `enum BomControlPlan { PRESENT ABSENT }` — the source's `CP_Ghatae` «دارد;ندارد» (optional).
* `model BomItem` — the child, with the source's **domain** fields and, separately, the
  **legacy / migration-preservation** fields.

### 3.2 The relation is SAME-DATABASE and `RESTRICT`

```
bom BomHeader @relation(fields: [tenantId, bomId], references: [tenantId, id],
                        onDelete: Restrict, onUpdate: Cascade)
```

* It references the **composite tenant-first unique pair** the baseline already declared —
  so "an item belongs to a header of the SAME tenant" is a **database fact**, not a service
  promise. An INSERT naming another tenant's `bom_id` fails in Postgres even if a predicate
  were ever missing.
* `onDelete: Restrict` deliberately does **not** cascade: the header has no delete route, and
  if one were added the database would refuse to orphan a reviewed BOM's items.
* There is still **NO cross-database reference**. `projectRef`, `productTreeRef` and the
  supplier suggestion remain opaque `VARCHAR` columns. The only reference in the schema is
  this one, asserted by `production-schema.spec.ts`.

### 3.3 Indexes (tenant-first)

| Index | Why |
| --- | --- |
| `(tenant_id, id)` UNIQUE | the tenant-first key pair, and the composite FK target |
| `(tenant_id, bom_id)` | "this BOM's items" — the list read and the submit gate's scope |
| `(tenant_id, bom_id, created_at)` | "…in the order they were added" — the grid read, matched by the query's `ORDER BY` |

Every index leads with `tenant_id`, so a cross-tenant scan is not expressible as a query plan.

### 3.4 The migration

`prisma/production/migrations/20261003120000_production_bom_item/migration.sql` — a **new**
migration generated with `prisma migrate diff` and applied with `prisma migrate deploy`
(the baseline is applied history and was **not** rewritten). It creates two enums, the
table, the three indexes and the one FK; it drops/truncates/deletes nothing. `prisma
validate` is clean, and `prisma migrate status` reports **2 migrations found, none pending**.

`production-schema.spec.ts` reads both the baseline and this migration back as text and pins
the FK, the tenant-first indexes, and the nullability of every deferred/legacy column.

---

## 4. The item's fields — what is a DOMAIN rule and what is only preserved

### 4.1 Domain (validated, written, returned)

| SharePoint source | Domain field | Required by the source |
| --- | --- | --- |
| `BomAddRelated` | `bomId` (+ FK) | yes |
| `NameProje_MortabetBaBOM` | `projectRef` (snapshot from the HEADER) | yes |
| `JazeDerakhteMahsol` | `productTreeRef` (snapshot from the HEADER) | yes |
| item `Title` | `partName` | **yes** (V11) |
| `NameGhataeDarSanat` | `industryPartName` | no |
| `Noe_Ghatae` | `partType` | **yes** (V13) |
| `Moshakhasate_Ghatae` | `specifications` | no |
| `Sazande_Ghatae` | `manufacturer` | no |
| `Jense_Ghatae` | `material` | **yes** (V14) |
| `Vahade_Andazegiri` | `measurementUnit` | **yes** (V15) |
| `ZaribMasraf_DarNaghshe` | `drawingConsumptionCoefficient` | **yes** (V16) |
| `ZaribMasraf_YadakiDorriz` | `spareConsumptionCoefficient` | **yes** (V17) |
| `TaminKonandePishnahadi_BOM` | `suggestedSupplier` | no |
| `GheimatTaminKonandePishnahadi_BO` | `suggestedSupplierPrice` (`Decimal`, returned as a string) | no |
| `CP_Ghatae` | `controlPlan` | no |
| `Tozihat_Ghatae_DarBOM` | `notes` | no |

### 4.2 Deferred (stored, nullable, READ-ONLY — the Product Tree dependency)

| SharePoint source | Column | Status |
| --- | --- | --- |
| `CodeStandardDarSanat` | `standardPartCode` | **DEFERRED.** Nullable, reserved, **never written** by any route/screen. Product Tree Code generation remains deferred and is not required for current BOM Item CRUD/lifecycle. |

`standardPartCode` is **read** on an item (a migrated value may exist) and is always `null`
for a row this API created. It is **not** in `CreateBomItemDto` or `UpdateBomItemDto`, so
the global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`) answers **400** if a
client sends one — the "no fake generation" rule is enforced by the transport, not by a UI
promise. The item dialog shows the field **disabled** with a note, so the deferral is
visible rather than hidden.

### 4.3 Legacy / migration-preservation (nullable, no rule, no formula)

| SharePoint source | Column |
| --- | --- |
| `Code_Ghatae` | `legacyPartCode` |
| item `state` | `legacyItemState` |
| item `NazarModir` | `legacyManagerOpinion` |
| `ZaribMasraf_KoleGhatae` | `legacyConsumptionTotalCoefficient` |
| `ZaribMasraf_DarNaghshe_DarHalSef` | `legacyConsumptionInDrawingOnOrder` |
| `ZaribMasraf_YadakiDorriz_DarHalS` | `legacyConsumptionSpareTestOnOrder` |
| `ZaribMasraf_DarNaghshe_Kharidsho` | `legacyConsumptionInDrawingPurchased` |
| `ZaribMasraf_YadakiDorriz_KharidS` | `legacyConsumptionSpareTestPurchased` |

None is accepted on the wire, none is returned, and **none is an operand of any formula**:
the source defines no writer for them and no total, so §14's open questions stay open rather
than being answered by invention.

### 4.4 One deliberate collapse

The brief's domain list names both `title` and `partName`. The source's item `Title` **is**
«نام قطعه», confirmed in §9.1 of the preflight, so the domain carries **one** field,
`partName`. No second `title` column is invented to satisfy a name in a list.

---

## 5. Business rules — as implemented

| # | Rule | Where it lives | How it is enforced |
| --- | --- | --- | --- |
| 1 | every item belongs to exactly one BOM | DB FK + repository | composite FK `(tenant_id, bom_id)` → `BomHeader(tenant_id, id)` |
| 2 | an item may change only while its BOM is editable | `BomItemService.assertEditable` | `isBomHeaderEditable(header.status)` — the HEADER's own predicate |
| 3 | submit freezes every item | same predicate | a non-DRAFT header refuses create/update/delete **before any write** |
| 4 | approval is on the HEADER, never on an item | controller surface | there is **no** item decision route |
| 5/6 | reject / need-correction follow the header state machine; correction returns it to DRAFT, and items thaw | `bom-status.ts` (unchanged) | `assertEditable` is the only thing asked — there is no separate item state to un-freeze |
| 7 | item delete only in a permitted state | repository `deleteDraft` | `deleteMany({ where: { …, bom: { status: 'DRAFT' } } })` |
| 8 | no BOM-header delete | no route exists | — (and the FK is `Restrict`) |
| 9 | `CodeStandardDarSanat`: no generation, no renumbering | DTO + schema | absent from every write DTO; nullable column; no sequence |
| 10 | no total-consumption formula | domain + DTO | only the two confirmed coefficients exist as domain fields |

### 5.1 The coefficients (the one confirmed rule)

Both confirmed coefficients are `@IsInt() @Min(0)`: **integer, ≥ 0, no decimal scale, no
artificial maximum, no unit and no formula**. The service re-asserts the same rule through
`isValidConsumptionCoefficient` (the DTO is a wire bound; this is the domain fact), refusing
with the typed code `BOM_ITEM_COEFFICIENT_INVALID`. No `total` is ever computed from them.

### 5.2 The empty-BOM submit gate — atomic, not a read-then-write

`BomHeaderRepository.submit` carries `items: { some: {} }` **inside the same conditional
UPDATE** that performs DRAFT → SUBMITTED:

```ts
updateMany({ where: { id, tenantId, status: 'DRAFT', items: { some: {} } }, data: { … } })
```

so "an empty BOM cannot be submitted" and the transition are ONE statement. When that write
matches nothing and a re-read still shows DRAFT, the only predicate left is "no items", and
`BomHeaderService.submit` throws a `BadRequestException` whose code is
`BOM_SUBMIT_ITEMS_REQUIRED` — the typed form of the source's `اقلامی ثبت نشده است!`, which
the UI maps by identifier.

### 5.3 Prototype-scope rules deliberately NOT implemented

* **Duplicate part name within a project** (V12). The source's scope is "within the
  *project*", which needs a cross-BOM query across every BOM of that project. No contract for
  that scope exists, so it is not invented.
* **Duplicate standard code** (V19) — depends on the BLOCKED Product Tree prefix.
* **`c_Control41` bulk renumbering** — an unchecked mass update in the source; it must not be
  re-created absent an explicit, permission-gated, audited contract.

---

## 6. API

Namespace `production/…` under the global `api/v1` prefix. Both controllers carry the full
chain declared once on the class: `@RequiresModule(PRODUCTION_MODULE_ID)`,
`@RequiresFeature(PRODUCTION_MODULE_ID, PRODUCTION_FEATURE.BOM)`,
`@UseGuards(ModuleEntitlementGuard)`, `@UseGuards(JwtAuthGuard)`.

### 6.1 Header (same routes; the submit rule tightened)

| Method | Route | Permission |
| --- | --- | --- |
| GET | `/production/boms` | `production.bom.read` |
| GET | `/production/boms/:id` | `production.bom.read` |
| POST | `/production/boms` (201) | `production.bom.manage` |
| PATCH | `/production/boms/:id` | `production.bom.manage` |
| POST | `/production/boms/:id/submit` (200) | `production.bom.manage` — now also requires ≥ 1 item |
| POST | `/production/boms/:id/approve` \| `/reject` \| `/request-correction` | `production.bom.approve` |

### 6.2 Item (new — `bom-item.controller.ts`, `@Controller('production/boms/:bomId/items')`)

| Method | Route | Permission |
| --- | --- | --- |
| GET | `/production/boms/:bomId/items` | `production.bom.read` |
| GET | `/production/boms/:bomId/items/:itemId` | `production.bom.read` |
| POST | `/production/boms/:bomId/items` (201) | `production.bom.manage` |
| PATCH | `/production/boms/:bomId/items/:itemId` (200) | `production.bom.manage` |
| DELETE | `/production/boms/:bomId/items/:itemId` (200, `{ id }`) | `production.bom.manage` |

**Both** path params are `ParseUUIDPipe({ version: '4' })` (owned row ids are UUIDs). **No**
`tenantId` and **no** `bomId` are accepted in any body: the tenant comes from the actor and
the BOM from the path. `standardPartCode` is not accepted on create or update (400 if sent).
Items reuse the HEADER's two permissions — **no** `production.bom.item.*` string is invented.

### 6.3 Typed refusals

`PRODUCTION_BOM_ERROR_CODES` (in `bom-item.ts`): `BOM_SUBMIT_ITEMS_REQUIRED`,
`BOM_HEADER_NOT_EDITABLE`, `BOM_ITEM_NOT_FOUND`, `BOM_ITEM_FIELD_REQUIRED`,
`BOM_ITEM_COEFFICIENT_INVALID`, `BOM_ITEM_PATCH_EMPTY`. They are raised as
`new XException({ code, message })`, which `StandardExceptionFilter` surfaces as
`error.code` — the UI maps them to Persian **by code**, never by sentence.

---

## 7. Audit

One trail, `core_db."AuditLog"`, through the existing `ProductionAuditGateway`. The item
slice writes on the resource `production.bom.item` (a new member of
`PRODUCTION_AUDIT_RESOURCE`), and every item act carries the parent `bomId` in its
before/after payload, so an item's history can be joined to its header's.

| Entity | Events |
| --- | --- |
| BOM header | `create`, `update`, `submit`, `approve`, `reject`, `request_correction` |
| BOM item | `create`, `update`, `delete` |

Every row is tenant-scoped from the actor, uses the canonical entity id, and writes a safe
payload (part name, `bomId`, `partType`) — never a secret and never unnecessary identity.
The trail records what the repository **returned**, so a refused conditional write produces
no success row; a deletion is read **before** it is removed so the trail says what existed.

---

## 8. Search and Notification — status

**SEARCH — DEFERRED.** The platform contract exists (`SEARCH_SOURCE_PORT`,
`platform/search-source`), and the preflight marks global-search participation `OPTIONAL in
V1`. This phase does **not** register a source: no new search source is created merely to add
a feature, an item search source would need a justification this phase does not have, and the
header's only free-text field (`title`) is **not** the authoritative business number the
search contract's own examples use — the BOM code that would be is BLOCKED. Recorded as a
deferred surface, not an omission.

**NOTIFICATION — NOT WIRED.** An authoritative user-facing notification contract exists
(Core's Notification Center), but nothing in this phase's item mutations is a decision the
contract names a recipient for. Audit ≠ notification; the actor is **not** auto-notified, and
no notification is invented for an item change.

---

## 9. Frontend (Persian-first)

| Route | Screen |
| --- | --- |
| `/admin/production` | BOM register: server paging, title search, status filter, rows → detail, create CTA |
| `/admin/production/new` | BOM create (`?edit=<id>` opens the same form as PATCH) |
| `/admin/production/[id]` | BOM detail: header summary, lifecycle actions, **items grid**, item dialog |
| `/admin/production/[id]/edit` | BOM edit while DRAFT |

Components: `ProductionBomListView`, `ProductionBomFormView`, `ProductionBomDetailView`,
`ProductionBomItemDialog`, and the shared `production-ui` primitives (badge, card, heading,
empty, pager). Labels and the typed-error → Persian map live in `production-labels.ts`; the
wire client is `production-api.ts`.

**Terminology** follows the brief exactly: تولید · فهرست مواد و قطعات · BOM · پروژه · درخت
محصول · قطعه · مشخصات · سازنده · جنس · واحد اندازه‌گیری · ضریب مصرف در نقشه · ضریب مصرف یدکی ·
تأمین‌کننده پیشنهادی · توضیحات.

**Gating is cosmetic; the backend is the source of truth.** `submit`/edit appear only on a
DRAFT to a `manage` holder; the three decisions only on a SUBMITTED BOM to an `approve`
holder; item mutations only while DRAFT. A refusal is rendered from its **typed code** (e.g.
`BOM_SUBMIT_ITEMS_REQUIRED` → «اقلامی ثبت نشده است!»). `standardPartCode` is shown
**disabled** with a "به‌زودی" note — visible, never generated, never auto-filled.

---

## 10. Procurement integration — **BLOCKED**

```
PRODUCTION-BOM → PROCUREMENT INTEGRATION CONTRACT MISSING
```

The repository was searched for a Purchase/Procurement contract that consumes a BOM. None
exists: Commerce owns `commerce_db` with its own document/workflow slices and **no** port,
service, API or DTO mentions a BOM, a BOM item, a part, or a Production resource. The
preflight's §20 independently records this as `NOT REQUIRED FOR V1` and `DEFERRED`.

Therefore **no integration was built**: no Commerce import from Production, no cross-database
read, no duplicated BOM data in Procurement, and no invented API shape. The dependency
direction the source shows — *Procurement consumes an approved BOM* — is recorded, not
guessed. When a real contract lands it must be a read through a **service/API/port**, never a
DB coupling, and Production must not gain a foreign key toward Commerce.

---

## 11. Tests

| Suite | What it proves |
| --- | --- |
| `bom-item.service.spec.ts` | tenant+BOM scoping, scope snapshot from the header, state guard on all three mutations (submit freezes, correction thaws), coefficient rule (+ no total/sum/counter export), deferred `standardPartCode`, empty-patch refusal, audit before/after, delete reads-then-audits, list clamping, view projection |
| `bom-item.repository.spec.ts` | every `where` carries tenant+BOM, `findUnique` absent from source, parent-DRAFT relation predicate on update/delete, transaction guard on create, no write of the deferred code or a legacy column, no cross-database client |
| `bom-item.controller.spec.ts` | no ungated route, exactly one permission per route, header's two remits only, entitlement from constants, both path params UUID v4, no `tenantId`/`userId`/`standardPartCode` accepted, actor resolved from context on every route |
| `bom.service.spec.ts` (+1) | submit with **zero items** → `BOM_SUBMIT_ITEMS_REQUIRED`, nothing audited, row stays DRAFT |
| `bom.repository.spec.ts` | submit's `where` now includes `items: { some: {} }` |
| `production-schema.spec.ts` (+2) | the item migration: one table + two enums, tenant-first indexes, same-database RESTRICT FK, purely additive; every deferred/legacy column NULLABLE with no sequence/trigger/total |
| `production-isolation.spec.ts` | two controllers each carrying the full chain; three client importers; `BomHeader` delegate in exactly two files, `BomItem` in exactly one; the FORBIDDEN list updated (item is no longer deferred; code **generation** still forbidden) |
| `production-entitlement.spec.ts` | the second controller joins the "entitled files" list |
| web `production-api.spec.ts` | exact paths, query encoding/capping, `tenantId`-free shape, decision routes each with their own opinion, item verbs |
| web `production-labels.spec.ts` | every error code has a Persian sentence, mapping is by code, unknown code falls back |
| web `ProductionBomListView.spec.tsx` | permission gate issues no request, status badge, detail link, manage-gated CTA, server-side filters, empty state |

**Totals (this phase's suites):** API production module **13 suites / 156 tests** (baseline
was 10/102 → **+54**); web production **3 suites / 27 tests**.

### 11.1 Coverage of the brief's required matrix

* **Unit** — item create/update/delete/retrieval, tenant isolation, BOM ownership, state
  guard, submit with zero items, coefficient validation, deferred standard code, approval
  authority invariants (the existing header suite).
* **Repository/integration** — tenant filtering, parent/child relationship, transaction
  consistency on the conditional writes, and duplicate/collision behaviour *only where a rule
  exists* (none does — asserted as absent rather than invented).
* **Contract/API** — status codes and DTO whitelist, auth, permissions, opaque ids,
  cross-tenant → 404.
* **Frontend** — list, permission gating, item CRUD surface, state-based controls, error
  rendering by code.

---

## 12. No-regression

| Check | Result |
| --- | --- |
| API `tsc --noEmit` | **clean** |
| Web `tsc --noEmit` | **clean** |
| Production module jest | **13 / 13 suites, 156 / 156 tests** |
| Web production jest | **3 / 3 suites, 27 / 27 tests** |
| Full API + full Web jest, lint | see the final report's TESTS / lint row |
| `prisma validate` (production schema) | **valid** |
| `prisma migrate status` (production) | **2 found, 0 pending** |
| Commerce | no Commerce file changed by this diff |

### 12.1 BLOCKED (an e2e the repository cannot honestly provide yet)

```
PRODUCTION E2E (HTTP + production_db) BLOCKED — no Production e2e harness exists
```

Every existing e2e suite bootstraps a module against its own datasource fixture; there is no
Production equivalent, and inventing one would mean guessing the fixture/teardown contract the
e2e layer has not established for `production_db`. The behaviour it would assert is covered by
the unit + repository + controller + web suites above, and the runtime smoke test exercises
the real route shape.

---

## 13. Known deferred dependency

**Product Tree Code generation remains deferred and is not required for current BOM Item
CRUD/lifecycle implementation.**

No prefix, no format, no counter, no sequence, no migration, no mock and no seed for a
Product Tree code exists anywhere in this diff. `standardPartCode` is stored as a nullable,
opaque, read-only column; validation of its requiredness is **not** applied; and no route
produces a value for it.

---

## 14. Files changed

**API**

* `apps/api/prisma/production/schema.prisma` — two enums, `BomItem`, the relation on `BomHeader`
* `apps/api/prisma/production/migrations/20261003120000_production_bom_item/migration.sql` — **new**
* `apps/api/src/generated/production-client/**` — regenerated (Prisma output)
* `apps/api/src/modules/production/bom/bom-item.ts` · `bom-item.dto.ts` ·
  `bom-item.repository.ts` · `bom-item.service.ts` · `bom-item.controller.ts` — **new**
* `apps/api/src/modules/production/bom/bom.repository.ts` — the submit item predicate
* `apps/api/src/modules/production/bom/bom.service.ts` — the empty-BOM refusal
* `apps/api/src/modules/production/production.constants.ts` — `PRODUCTION_AUDIT_RESOURCE.BOM_ITEM`
* `apps/api/src/modules/production/production.module.ts` — registers the child slice
* specs: `bom-item.{repository,service,controller}.spec.ts` (**new**); `bom.service.spec.ts`,
  `bom.repository.spec.ts`, `production-schema.spec.ts`, `production-isolation.spec.ts`,
  `production-entitlement.spec.ts` (updated)

**Web**

* `apps/web/src/lib/production-api.ts`, `apps/web/src/lib/production-labels.ts` — **new**
* `apps/web/src/lib/__tests__/production-api.spec.ts`, `production-labels.spec.ts` — **new**
* `apps/web/src/components/production/` — `production-ui.tsx`, `ProductionBomListView.tsx`,
  `ProductionBomFormView.tsx`, `ProductionBomDetailView.tsx`, `ProductionBomItemDialog.tsx` — **new**
* `apps/web/src/components/production/__tests__/ProductionBomListView.spec.tsx` — **new**
* `apps/web/src/app/admin/production/` — four routes — **new**

**Docs**

* `docs/PHASE-PRODUCTION-BOM-ITEM-IMPLEMENTATION.md` — **new** (this file)





