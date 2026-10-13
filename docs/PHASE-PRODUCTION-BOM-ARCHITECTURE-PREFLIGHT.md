# PHASE PRODUCTION-BOM — ARCHITECTURE PREFLIGHT / CONTRACT DISCOVERY

**Status:** `PREFLIGHT ONLY — NO IMPLEMENTATION. No schema, no migration, no route, no UI, no
Commerce touch, no Purchase coupling.`

**Module:** Production / «تولید»
**Initial capability:** BOM / «فهرست مواد و قطعات»

**Classification tags used throughout:** `[CONFIRMED]` (read directly in source), `[DERIVED]`
(logically follows from confirmed source), `[OPEN]` (a business decision the source does not
answer), `[DECISION REQUIRED]` (an architecture choice Ariya must make before implementation).

**Git baseline:** HEAD `840226b8a00e960098e7e868740adbc64710d6d7`, branch `master`. Nothing was
committed, reset, cleaned, checked out or reverted by this phase.

**THE ONLY NEW ARTIFACT OF THIS PHASE IS THIS DOCUMENT.** No file under `apps/api/**`,
`apps/web/**`, `apps/api/prisma/**`, `docs/` (other files) or any Commerce file was modified.
The SharePoint source was read from outside the repository and the extraction scratch files were
written to `.tmp/` (git-ignored, `*.tmp`) and were **deleted at the end of the phase**.

---

## 1. SCOPE

This document reverse-engineers the **existing SharePoint BOM behaviour** that the user supplied
as the authoritative source of truth, and maps it onto the ERP's existing platform contracts. It
answers, with evidence:

- which module owns BOM and why;
- which fields exist in the source, with their Persian labels and SharePoint names;
- which of those fields belong to a **BOM header** and which to a **BOM item**;
- what the source's validations, lifecycle, approval and duplicate rules actually are;
- what already exists in the ERP as a reusable contract (tenant, entitlement, RBAC, audit, search,
  notification, ordering/paging, identity) and what does not;
- what the smallest honest V1 is;
- what must be decided by Ariya before any implementation begins.

It does **not** design a UI, does **not** write a schema, does **not** decide the Purchase
integration, and does **not** copy the SharePoint implementation architecture.

### 1.1 Source of truth, restated

The SharePoint forms are the source of truth for **business fields and behaviour**. Where the
source does not define something (a formula, an item-level state writer, a supplier model), this
document says so explicitly rather than inventing it (§26, §27).

---

## 2. SOURCE INVENTORY

### 2.1 Supplied SharePoint artifacts `[CONFIRMED]`

Eight form-definition files (the SharePoint form-builder's XML, `*Script` blocks embedded in the
XML). They were read as text and parsed; every `Control`, `ValueChangeScript`, `LoadCompletedScript`,
`ListQuery`, and action-script was extracted mechanically.

| File | Role in the source | Read for |
| --- | --- | --- |
| `BomAdd.txt` | **BOM request (add)** — the primary header form + item grid + approval-status tab + a cleanup tab + a "check standard part code" tool | this phase (primary) |
| `BomEdit.txt` | **BOM change request (edit)** — a SECOND form: coefficients change against already-approved items | this phase (inventory only, §23 DEFERRED) |
| `Kartable Bomadd.txt` | **Manager approval task form** for `BomAdd` (SharePoint workflow task) | this phase (approval, §12) |
| `kartable bomEdit.txt` | **Manager approval task form** for the change request | this phase (approval, §12) |
| `kharid.txt` | Purchase request («درخواست کالا») — consumes BOM items | boundary only (§20) |
| `kartabl karid.txt` | Purchase approval task form | boundary only (§20) |
| `sooderCheck.txt` | Cheque/order issue request | not used (out of scope) |
| `kartabl SoderCheck.txt` | Cheque/order approval task form | not used (out of scope) |

### 2.2 SharePoint lists discovered `[CONFIRMED]`

Every list is referenced by **display name and GUID** in `Lookup_*` / `ListQuery` attributes, so
the relationships are readable from source rather than inferred.

| SharePoint list | GUID | Fields observed | Relationship to BOM |
| --- | --- | --- | --- |
| `BomAdd` | `{A0C8161A-307A-4CFC-983A-36DC32DE0441}` | header fields (§5.2) | **the BOM header list** |
| `BOM_فهرست اقلام پروژه` | `{14BC644C-8F2F-4AC6-A1D7-3B7AE024200D}` | item fields (§5.3) | **the BOM items list** — linked to the header by `BomAddRelated` |
| `تغییر Bom` | (own list; written by `kartable bomEdit.txt`) | change-request header | BOM change request |
| `جزئیات تغییر Bom` | `{BF7909C8-B52C-4D70-9AB8-5F970B6DA19D}` | change-request details | links to an item by `IdBomFehresteAghlameProje` |
| `لیست پروژه ها` | `{BD9B53B8-AA77-4300-B367-4F02B30AD55C}` | `Title`, `ProjectCode`, `ProjectState` | **project source** (external to BOM) |
| `ProductTree` | `{24C41644-1165-4A73-87B0-6CA9556A388B}` | `Title`, `code` | **product-tree source** (external to BOM) |
| `لیست کارکنان` | `{42494FBF-81CD-4E37-9F21-98D802088485}` | `Title`, `PersonUser`, `ID` | requester / manager approval identity |
| `درخواست کالا` | `{0566A7E2-1D68-4CEF-BBC8-DAA13843F397}` | purchase request | Purchase (**future boundary**) |
| `ردیابی خریدها` | `{1BF7A6A2-0A1A-4B36-897F-03AED408AF14}` | `ID_BOM`, quantities, statuses | Purchase consumption of BOM items |
| `پیوست های بازرگانی` / `پیوست های لیست اقلام خرید` | `{D12E5396-…}` / `{5375E16A-…}` | attachments | Purchase only |

### 2.3 The single most important structural finding `[CONFIRMED]`

The source does **not** store BOM and its items in one record. `BomAdd` is the header list and
`BOM_فهرست اقلام پروژه` is a **separate list**; every item carries `BomAddRelated`, a lookup to the
header. The form merely *renders* the item grid inside the header form. §6 formalises this.

---

## 3. PRODUCTION OWNERSHIP

### 3.1 Decision `[DECISION REQUIRED — RECOMMENDED]`

```
Module   : production   (Persian: تولید)
Owner of : the BOM aggregate — header, items, its own lifecycle, its own validation
Capability #1 : bom   («فهرست مواد و قطعات»)
```

`production` is the module id; `bom` is the first **feature** slug. Both are *declared* by the
module exactly as `commerce` + `purchase` are declared today (`apps/api/src/modules/commerce/
commerce.constants.ts`) — the platform registry (`ModuleRegistration` / `ModuleFeature`) decides
entitlement, the module never reads it.

### 3.2 Why Production owns BOM `[DERIVED]`

1. **The subject is a production artefact, not a purchase.** A BOM answers "what is this product
   made of, and in what quantity" — it exists before, and independently of, any purchase. The
   source proves this: `BomAdd` is reachable with no purchase record, and a purchase record
   (`ردیابی خریدها`) *points at* BOM items (`ID_BOM`) rather than the reverse. `[CONFIRMED]`
2. **The lifecycle is a production/engineering approval, not a procurement one.** The approver in
   the source is the **requester's manager** (`ModirTaeedKonandeh`, «مدیر درخواست کننده»), resolved
   from the employee list — an organisation approval, not a procurement decision on price or
   vendor. `[CONFIRMED]`
3. **Owning BOM inside Procurement would invert the dependency.** Purchase is a *consumer* of an
   approved BOM (§20). If Procurement owned the BOM table, every future production capability
   (planning, orders, costing) would have to depend on the procurement module's schema, which the
   module brief forbids.
4. **BOM must be usable when Procurement is not entitled.** A tenant may run production planning
   without the procurement capability. Independent entitlement is only possible if the BOM tables
   are not in the procurement module. `[DERIVED]`

### 3.3 Future capabilities that must not be blocked (not implemented now)

BOM · Product Tree · Production Planning · Production Orders · Production Operations ·
Manufacturing Execution · Production Costing · Quality integration.

**Consequence for V1 design (a constraint, not a task):** the BOM tables must not acquire a foreign
key into a Purchase table, and the BOM module must not import Commerce. §20 and §25 record how the
future Purchase contract reaches an approved BOM without that coupling.

---

## 4. BOM DOMAIN BOUNDARY

### 4.1 The boundary, stated exactly

```
Production / production
└── bom (feature)
    ├── BOM            (aggregate root: header)
    ├── BOM Item       (child rows of exactly one BOM)
    ├── BOM Status     (the lifecycle value on the header)          ← V1: enum + guarded transitions
    └── BOM Approval   (the manager's recorded decision)            ← V1: fields on the header + audit
```

**Inside the boundary (Production owns, writes and validates):** the BOM header, its items, the
item-level part attributes the source records, the standard-part-code generation and uniqueness
rule, the state machine and its guards, the manager decision as recorded on the BOM.

**Outside the boundary (Production only REFERENCES):** Project, Product Tree, the user/employee
identity, supplier data, price data, the procurement document, the audit trail, the search index,
notifications, the tenant/entitlement registry.

### 4.2 Explicitly NOT owned by BOM `[DECISION REQUIRED]`

| Candidate entity | Verdict | Reason |
| --- | --- | --- |
| `Part` (catalogue) | **NOT created in V1** | The source has no part catalogue list; part data lives on the item row (§9). Creating a catalogue is a new authoritative model with its own lifecycle, deduplication and tenancy — `[OPEN]`. |
| `Material` | **NOT created in V1** | `Jense_Ghatae` is a free-text field on the item in the source; a material master is invented, not discovered. `[OPEN]` |
| `Project` | **NOT owned** | §7 — the source references a separate project list; whether the ERP has an authoritative project domain is `[DECISION REQUIRED]`. |
| `Product Tree` | **NOT owned in V1** | §8 — referenced only. |
| `Supplier` | **NOT owned** | §15 — the source stores a suggested supplier as an item attribute; no supplier master is visible. |
| `BOM Version` | **NOT created in V1** | §21 — the source has state + approval, not versions. |
| `Consumption Rule` | **NOT created in V1** | §14 — the coefficients are item attributes; no rule model exists in source. |

---


## 5. SHAREPOINT FIELD INVENTORY (authoritative)

Every name below is the **exact** `TargetFieldName` / `ListQuery` attribute read out of the
supplied XML. Nothing is renamed in this table; the "proposed Ariya field" column is a
**proposal** and §5.5 states the rule that governs it.

Legend — **Owner**: `P` = Production (BOM), `REF` = an external reference, `SYS` = SharePoint
platform column (not migrated). **Type** is the Ariya proposal, not a SharePoint type.

### 5.1 Identity / system columns (NOT migrated) `[CONFIRMED]`

`ID`, `ContentType`, `FileRef`, `FileLeafRef`, `GUID`, `WorkflowLink`, `OffsiteParticipant`,
`OffsiteParticipantReason`, `WorkflowOutcome`, `TaskType`, `FormURN`, `FormData`, `EmailBody`,
`HasCustomEmailBody`, `SendEmailNotification`, `PendingModTime`, `Completed`, `WorkflowListId`,
`WorkflowItemId`, `ExtendedProperties`, `ApprovalOutcome`, `Decision`, `HumanWorkflowID`,
`ApproverTaskID`, `MultiOutcomeTaskInfo`.

These are the SharePoint runtime's own columns. They are evidence of **how** the source ran
(SharePoint 2010-style approval workflow tasks carry `WorkflowOutcome` / `Decision`) — they are
**not** BOM business fields and must not be re-created in the ERP. The business facts they encode
are recorded in §11/§12.

### 5.2 BOM HEADER — list `BomAdd` `[CONFIRMED]`

| SharePoint field | Persian display name | Proposed Ariya field | Owner | Type | Req. | Source / reference | Validation (from source) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Title` | عنوان درخواست | `title` | P | text | required | user / `BomEdit` composes `تغییر اقلام - <project>` | none in source | §11 |
| `NameProje` | عنوان پروژه | `projectRef` | REF | opaque ref | required | `لیست پروژه ها` lookup | `c_Control4`: «عنوان پروژه انتخاب گردد!» | §7 |
| `NameProje_x003A_ProjectCode` | کد پروژه | `projectCodeSnapshot` | P (derived) | text | read-only | derived in `ValueChangeScript` from `ProjectCode` | — | snapshot copied at selection time |
| `ProductTreeRef` | درخت محصول مرتبط | `productTreeRef` | REF | opaque ref | required | `ProductTree` lookup | `c_Control4`: «درخت محصول انتخاب گردد!» | §8 |
| `ProductTreeRef_x003A_code` | کد درخت محصول مرتبط | `productTreeCodeSnapshot` | P (derived) | text | read-only | derived from `ProductTree.code` | — | the **base** of standard-code generation (§13.3) |
| `DarkhastKonandeh` | درخواست کننده | `requesterUserId` | P | user ref | required | `لیست کارکنان` lookup; defaulted to the current user | `c_Control4`: «درخواست کننده انتخاب گردد!» | §2.2 |
| `ModirTaeedKonandeh` | مدیر درخواست کننده | `requesterManagerUserId` | P | user ref | required | `لیست کارکنان` lookup | `c_Control4`: «مدیر درخواست کننده انتخاب گردد!» | **the approver** (§12) |
| `TaeedKonandeh` | تایید کننده | `approverUserId` | P | user ref | optional→set on submit | PeoplePicker, filled from the manager record's `PersonUser` | submit refuses if `PersonUser` is empty: «یوزر مدیر پروژه در سامانه ست نشده است» | identity of the **workflow approver** |
| `Tarikh` | تاریخ | `requestDate` | P | date | required | `DatePicker`, default `new Date()` | — | also named `TarikhDarkhast` («تاریخ درخواست») in `BomEdit` |
| `NazarModir` | نظر مدیر | `managerOpinion` | P | enum | set by approver | `RadioButtons`, static values `تایید;رد;نیاز به اصلاح` | required at the manager step (§12) | the approval **decision** |
| `Tozihat` | توضیحات | `comments` | P | text | optional | user / approver | — | approver's comment is written here too |
| `State` | وضعیت | `status` | P | enum/integer | required (default `0`) | lifecycle | guards on transitions (§11) | `0`…`100` per §11 |
| `StateNext` | مرحله بعد | `nextStatus` | P | integer | hidden | lifecycle | — | written together with `State` on transition |
| `TarikhTaedModir` | تاریخ تایید مدیر | `managerDecidedAt` | P | date | set on decision | approval task form `cr_date` | — | `c_date` in `BomAdd`, `c_TarikhTaead` in `BomEdit` |

---

### 5.3 BOM ITEM — list `BOM_فهرست اقلام پروژه` `[CONFIRMED]`

The complete attribute list was read from the `ListQuery` projections, which enumerate **every
field the source reads**, plus the write site in `btn_Save` and the approval task's `btn_Save`.

| SharePoint field | Persian display name | Proposed Ariya field | Owner | Type | Req. | Written by | Validation | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `BomAddRelated` | (ارتباط با درخواست) | `bomId` | P | ref | required | `listitem.BomAddRelated = idAddbom` | — | **the header→item link** |
| `NameProje_MortabetBaBOM` | پروژه | `projectRef` | REF (denormalised) | opaque ref | required | `listitem.NameProje_MortabetBaBOM` | — | duplicated onto the item |
| `JazeDerakhteMahsol` | جزء درخت محصول | `productTreeRef` | REF (denormalised) | opaque ref | required | `listitem.JazeDerakhteMahsol` | — | `BomEdit` / Purchase filter on it |
| `Title` | نام قطعه | `partName` | P | text | **required** | `listitem.Title` | empty refused: «نام قطعه نمی تواند خالی باشد!»; **duplicate name within project refused** (§13.1) | the part's name |
| `NameGhataeDarSanat` | نام قطعه در صنعت | `partNameInIndustry` | P | text | optional | `listitem.NameGhataeDarSanat` | none | the industry-standard name |
| `Code_Ghatae` | کد قطعه | `partCode` | P | text | optional (read-only in the grid) | — | — | distinct from the standard code; **no writer found in the supplied forms** `[OPEN]` |
| `CodeStandardDarSanat` | کد استاندارد قطعه | `standardPartCode` | P | text | **required, unique in scope** | `listitem.CodeStandardDarSanat` (generated in `btn_Save`) | empty refused; duplicate refused (§13) | the authoritative business code |
| `Noe_Ghatae` | نوع قطعه در پروژه | `partTypeInProject` | P | enum | **required** | `listitem.Noe_Ghatae` | «نوع قطعه در پروژه نمی تواند خالی باشد!» | static values `ساختی;استاندارد` |
| `Moshakhasate_Ghatae` | مشخصات قطعه | `partSpecifications` | P | text | optional | `listitem.Moshakhasate_Ghatae` | none | |
| `Sazande_Ghatae` | سازنده قطعه | `manufacturer` | P | text | optional | `listitem.Sazande_Ghatae` | none | free text in source |
| `Jense_Ghatae` | جنس قطعه | `material` | P | text | **required** | `listitem.Jense_Ghatae` | «جنس قطعه نمی تواند خالی باشد!» | free text in source |
| `Vahade_Andazegiri` | واحد اندازه گیری قطعه/مواد در پروژه | `unitOfMeasure` | P | text | **required** | `listitem.Vahade_Andazegiri` | «واحد اندازه گیری نمی تواند خالی باشد!» | free text in source `[OPEN]` |
| `ZaribMasraf_DarNaghshe` | ضریب مصرف (در نقشه) | `consumptionCoefficientInDrawing` | P | numeric | **required** | `listitem.ZaribMasraf_DarNaghshe` | empty refused | §14 |
| `ZaribMasraf_YadakiDorriz` | ضریب مصرف (یدکی/تست) | `consumptionCoefficientSpareTest` | P | numeric | **required** | `listitem.ZaribMasraf_YadakiDorriz` | empty refused | §14 |
| `ZaribMasraf_KoleGhatae` | ضریب مصرف کل قطعه | `totalConsumptionCoefficient` | P | numeric | optional | **no writer in the supplied forms** | — | read-only projection `[OPEN]` §14 |
| `ZaribMasraf_DarNaghshe_DarHalSef` | ضریب مصرف (در نقشه) در حال سفارش | `consumptionInDrawingOnOrder` | P | numeric | optional | **no writer in the supplied forms** | — | `[OPEN]` §14 |
| `ZaribMasraf_YadakiDorriz_DarHalS` | ضریب مصرف (یدکی/تست) در حال سفارش | `consumptionSpareTestOnOrder` | P | numeric | optional | **no writer** | — | `[OPEN]` §14 |
| `ZaribMasraf_DarNaghshe_Kharidsho` | ضریب مصرف (در نقشه) خریداری شده | `consumptionInDrawingPurchased` | P | numeric | optional | **no writer** | — | Purchase-side projection `[OPEN]` §14/§20 |
| `ZaribMasraf_YadakiDorriz_KharidS` | ضریب مصرف (یدکی/تست) خریداری شده | `consumptionSpareTestPurchased` | P | numeric | optional | **no writer** | — | Purchase-side projection `[OPEN]` |
| `TaminKonandePishnahadi_BOM` | تامین کننده پیشنهادی | `suggestedSupplier` | P | text | optional | **no writer** | — | §15 `[OPEN]` |
| `Tozihat_Ghatae_DarBOM` | توضیحات قطعه در BOM | `itemComments` | P | text | optional | **no writer** | — | §15 `[OPEN]` |
| `GheimatTaminKonandePishnahadi_BO` | قیمت تامین کننده پیشنهادی | `suggestedSupplierPrice` | P | numeric | optional | **no writer** | — | §15 `[OPEN]` |
| `CP_Ghatae` | طرح کنترل دارد؟ | `hasControlPlan` | P | enum | optional | `listitem.CP_Ghatae` | none | static values `دارد;ندارد` §16 |
| `NazarModir` | نظر مدیر | `managerOpinionSnapshot` | P | enum | optional | **no writer found on the item list** | — | present in the item projection; written on the header in source `[OPEN]` §12.4 |
| `state` | وضعیت قلم | `itemStatus` | P | integer | optional | **no writer in the supplied forms** | filtered by `state;100;Equals` in `BomEdit` | semantics not defined by source `[OPEN]` §11.4 |

---

### 5.4 BOM CHANGE REQUEST (`BomEdit`) — inventoried, DEFERRED

This is a **second capability** the source implements: after items are approved, coefficients may
be changed through a separate request that its own manager approves. It is fully inventoried here
so nothing is lost, and classified **DEFERRED** in §23 — V1 ships the BOM, not the change request.

Header list `تغییر Bom`:

| SharePoint field | Persian | Proposed | Type | Notes |
| --- | --- | --- | --- | --- |
| `Title` | عنوان درخواست | `title` | text | composed as `تغییر اقلام - <project>` `[CONFIRMED]` |
| `NameProje` | پروژه | `projectRef` | ref | same project list |
| `ProductTreeRef` | درخت محصول مرتبط | `productTreeRef` | ref | |
| `DarkhastKonnade` | درخواست کننده | `requesterUserId` | ref | the source's own spelling differs from `BomAdd`'s `DarkhastKonandeh` `[CONFIRMED]` |
| `ModirTaeadKonande` | مدیر تایید کننده | `approverManagerUserId` | ref | the approver |
| `TaeadKonnade` | تایید کننده | `approverUserId` | ref | PeoplePicker, from `PersonUser` |
| `TarikhDarkhast` | تاریخ درخواست | `requestDate` | date | default today |
| `NazarModirTaeadKonande` | نظر مدیر | `managerOpinion` | enum | required at the manager step |
| `Tozihat` | توضیحات | `comments` | text | |
| `TarikhTaead` | تاریخ تایید مدیر | `managerDecidedAt` | date | |
| `status` | وضعیت | `status` | enum | `0` draft, `1` submitted, `2` manager step, `50`, `100` per §11.3 |
| `KeyWordSearch` | — | `searchKeyword` | text (hidden) | search plumbing, not a business field |
| `IdFromUrl` / `IdSelect` / `IdBomChangeStack` / `idBomChange` / `selectBomId` / `IDBomChangeDetail` | (شناسه) | `*Id` refs | refs | navigation / plumbing ids |

Detail list `جزئیات تغییر Bom` — the actual change lines:

| SharePoint field | Persian | Proposed | Type | Meaning (from source) |
| --- | --- | --- | --- | --- |
| `IdBomFehresteAghlameProje` | (قلم BOM) | `bomItemId` | ref | which item is being changed |
| `IdBomChangeStack` | (درخواست تغییر) | `bomChangeRequestId` | ref | which request this line belongs to |
| `idBomChange` | (درخواست تغییر) | `bomChangeRequestId` (legacy duplicate) | ref | the source writes **both** fields with the same value `[CONFIRMED]` |
| `NoeaTaghir` | نوع تغییر | `changeType` | enum | default `تغییر موجودی` («change of stock/quantity») — the only member the source writes `[OPEN]`: are there others? |
| `MizanAfzayeshZaribMasrafInMap` | افزایش/کاهش ضریب مصرف (در نقشه) | `deltaConsumptionInDrawing` | numeric (signed) | added to the item's coefficient on approval |
| `MizanAfzayeshZaribMasrafYadaki` | افزایش/کاهش ضریب مصرف (یدکی/تست) | `deltaConsumptionSpareTest` | numeric (signed) | same |
| `MizanAvaliyeZaribMasrafInMap` | میزان اولیه ضریب مصرف (در نقشه) | `previousConsumptionInDrawing` | numeric | the value **before** the change (snapshot) |
| `MizanAvaliyeZaribMasrafYadaki` | میزان اولیه ضریب مصرف (یدکی/تست) | `previousConsumptionSpareTest` | numeric | snapshot |
| `Title` | (نام قطعه) | `partNameSnapshot` | text | carried for display |

### 5.5 The rename rule `[DECISION REQUIRED]`

**Nothing is renamed by this document.** The "proposed Ariya field" column exists so the migration
has a target vocabulary; every proposal must be approved by Ariya before it is used, and the
SharePoint name must be preserved in the migration's field-mapping table (§22) precisely because
`CodeStandardDarSanat` is **not** assumed to mean `sku`:

- `CodeStandardDarSanat` («کد استاندارد قطعه») is a *domain* code whose generation rule is derived
  from the product tree's code (§13.3). A generic `sku` would erase both the scope rule and the
  generation rule. **The proposal keeps the domain meaning and does not claim SKU equivalence.**
- `Code_Ghatae` («کد قطعه») and `CodeStandardDarSanat` («کد استاندارد قطعه») are two different
  fields in the source and stay two different fields until Ariya states what distinguishes them
  `[OPEN]`.
- `Title` means «نام قطعه» on the item list and «عنوان درخواست» on the header list. Reusing one
  name for both would destroy that distinction; the proposal names them `partName` and `title`.
- `Noe_Ghatae` («نوع قطعه در پروژه») is scoped **to the project** by its own label. It is not
  silently reinterpreted as a global part-type taxonomy.

---


## 6. BOM HEADER vs ITEM MODEL

### 6.1 The evidence `[CONFIRMED]`

1. Two SharePoint lists, not one: `BomAdd` (`{A0C8161A-…}`) and `BOM_فهرست اقلام پروژه`
   (`{14BC644C-…}`).
2. Items reach the header through the lookup `BomAddRelated`; the form's item grid is populated by
   `ListQueryBom` with the single criterion `BomAddRelated = {c_ID}`.
3. A BOM may exist with zero items: the **submit** action refuses exactly that case —
   `«اقلامی ثبت نشده است!»` (`c_Control2`, and identically in the approval task at `st == 0`).
4. The approval task form treats the item grid as the object of review (`cr_GridBOM`,
   `cr_GridsBOM`) while approving the **header** row (`form.SaveRecord(… "BomAdd" …)`).

### 6.2 The consequence

```
BOM                      1 ──── n  BOM Item
 ├─ projectRef (REF)              ├─ bomId (FK → BOM)
 ├─ productTreeRef (REF)          ├─ projectRef / productTreeRef   (denormalised, §6.3)
 ├─ requester / manager (REF)     ├─ partName, partNameInIndustry
 ├─ requestDate                   ├─ partCode (Code_Ghatae)  [OPEN]
 ├─ status / nextStatus           ├─ standardPartCode (CodeStandardDarSanat)
 ├─ managerOpinion                ├─ partTypeInProject, partSpecifications, manufacturer, material
 ├─ managerDecidedAt              ├─ unitOfMeasure
 ├─ comments                      ├─ consumptionCoefficientInDrawing / …SpareTest   (required)
 └─ title                         ├─ totalConsumptionCoefficient and 4 projections [OPEN]
                                  ├─ suggestedSupplier / suggestedSupplierPrice / itemComments [OPEN]
                                  └─ hasControlPlan
```

### 6.3 On the duplicated project / product-tree fields on the item

The source stores `NameProje_MortabetBaBOM` and `JazeDerakhteMahsol` **on every item** as well as
on the header. `[CONFIRMED]`

The reason is SharePoint's own: `ListQuery` criteria cannot join, so storing the project/tree on
the item is what makes `ListQuery2` / `ListQuery3` (uniqueness, latest-code) and the Purchase
form's BOM filter possible. `[DERIVED]`

The ERP model must not lose the fact that the uniqueness rule is expressed over this scope (§13),
so the V1 proposal is: the item **carries** the scope values it is validated against, while
**the header remains the authority** for the BOM's project and product tree. Whether the ERP needs
a physical copy at all (it can join) is `[DECISION REQUIRED]` — a copy is an immutability /
performance decision, not a correctness one.

### 6.4 What must NOT be done

Do **not** flatten the two levels into "one giant record" (a BOM with N item columns), and do
**not** keep the item's project/tree copy as an independently editable field — the source never
edits it on an item. `[DERIVED]`

---


## 7. PROJECT RELATIONSHIP

### 7.1 What the source does `[CONFIRMED]`

- The header looks up `لیست پروژه ها` (`{BD9B53B8-…}`) via `NameProje`; the item looks it up via
  `NameProje_MortabetBaBOM`.
- Selecting a project triggers a `LoadRecords` on that list and reads back **two** fields:
  `ProjectState` → a read-only display control `c_Vazeyat` («وضعیت پروژه»), and `ProjectCode` →
  `c_Cod` / `NameProje_x003A_ProjectCode` («کد پروژه»).
- The project list therefore has at least: `Title`, `ProjectCode`, `ProjectState`.
- The Purchase form (`kharid.txt`) looks up the same list and **hides the project field entirely
  when `NoeDarkhastKala = 'غیر پروژه ای'`** — i.e. "non-project purchase request" is a real
  business case. `[CONFIRMED]`

### 7.2 What exists in the ERP today `[CONFIRMED]`

**Nothing.** A search of every Prisma schema in the repository
(`core`, `commerce`, `hr`, `correspondence`, `cms`, `observability`) for `Project`, `Product`,
`Part`, `Bom`, `Material`, `Supplier`, `Vendor`, `Warehouse` or `Item` models returns **zero
models**. The ERP has **no authoritative Project domain and no authoritative Product-Tree domain**
today.

### 7.3 The resulting decision `[DECISION REQUIRED]`

```
Production / BOM  ──references──▶  Project (does not exist yet)
```

- Production **owns only a Project reference** — an opaque, tenant-scoped project id plus the
  snapshot(s) the source copies (`projectCode`) and the project state the source reads.
- Production **must not create a Project subsystem** inside the Production module: a project is not
  a production artefact, and the source treats it as an external list.
- Whether an **authoritative Project contract** should be created, and by which module (a future
  Project Management capability, or Core), is a **contract gate** (§25 → `BLOCKED`).
- **Tenant isolation is NOT inherited from a referenced project.** Because no project domain
  exists, the BOM's own `tenantId` is the isolation key (§17); a project reference cannot be
  trusted to carry it. `[DERIVED]`

### 7.4 V1 workaround, stated as a limitation (not a design)

For V1 the project may be carried as `projectRef` + `projectCodeSnapshot` + `projectStateSnapshot`,
**validated only against the caller's own tenant** — with the honest limitation that the ERP
**cannot verify** that the referenced project belongs to the tenant, because no project table
exists. This is a known weakness (§24, T-5) and is exactly why the Project contract is a gate.

---

## 8. PRODUCT TREE RELATIONSHIP

### 8.1 What the source does `[CONFIRMED]`

- Header lookup `ProductTreeRef` → list `ProductTree` (`{24C41644-1165-4A73-87B0-6CA9556A388B}`),
  display field `Title`, value field `ID`.
- The tree's **`code`** is read back into `ProductTreeRef_x003A_code` («کد درخت محصول مرتبط») and
  is used as the **prefix of the standard part code** (§13.3).
- Item lookup `JazeDerakhteMahsol` («جزء درخت محصول») points at the same list.
- There is a **dedicated tree-picker popup** — `SitePages/Test_WP.aspx?ProdID=<project>` — opened
  by `c_Control1`, `c_Control16` and `c_Control40`; on close it writes the chosen tree into a
  window global (`window['dataitem']`) which the form reads. `[CONFIRMED]`
- The **Purchase** forms also filter BOM items by `JazeDerakhteMahsol` (`c_B_ProductTreeRef`),
  against the same list. `[CONFIRMED]`

### 8.2 What exists in the ERP today `[CONFIRMED]`

Nothing (§7.2). No product-tree model, no product-tree route, no product-tree service.

### 8.3 The resulting decision `[DECISION REQUIRED]`

- Product Tree is **not** implemented by BOM in V1 and is **not** invented inside the BOM table.
- In V1, BOM carries `productTreeRef` (opaque) + `productTreeCodeSnapshot`, exactly like the
  project reference, with the same tenant-validation limitation (§7.4).
- Whether Product Tree becomes a **Production-owned future capability** (the module brief lists it
  as one) or an independent bounded context is `[DECISION REQUIRED]`; the BOM design must not force
  either answer.
- Because the tree's code **drives standard-code generation**, that decision is on the critical
  path of §13 — see §25 → `BLOCKED`.
- Do **not** create a second product-tree implementation: when the authoritative tree arrives, BOM
  must be re-pointed to it, and the snapshot column retained as migration evidence only.

---


## 9. PART / MATERIAL SEMANTICS

### 9.1 What is KNOWN from SharePoint `[CONFIRMED]`

All part data is stored **on the BOM item row**. There is no part list, no material list and no
manufacturer list referenced anywhere in the supplied forms:

| Concept | Where it lives in the source | Evidence |
| --- | --- | --- |
| Part name | item field `Title` | `c_part` label «*نام قطعه»; `listitem.Title` |
| Part name in industry | item field `NameGhataeDarSanat` | `listitem.NameGhataeDarSanat` |
| Part code | item field `Code_Ghatae` | read-only column in the grid; **no writer in source** |
| Standard part code | item field `CodeStandardDarSanat` | generated in `btn_Save`, uniqueness-checked |
| Part type in project | item field `Noe_Ghatae`, static values `ساختی;استاندارد` | `Lookup_StaticValues` on `c_PartInProject` |
| Specifications | item field `Moshakhasate_Ghatae` | free text |
| Manufacturer | item field `Sazande_Ghatae` | free text |
| Material | item field `Jense_Ghatae` | free text |
| Unit of measure | item field `Vahade_Andazegiri` | free text |

**Every one of these is free text or a static choice list.** None is a lookup. `[CONFIRMED]`

### 9.2 What is an ARCHITECTURAL QUESTION for Ariya `[DECISION REQUIRED]`

The words **Part**, **Material**, **Component** and **Item** are *not* four domain entities in the
source — the source has one row type and calls it «قطعه» (part). Therefore:

- **V1 does not create** a `Part` entity, a `Material` master, a `Component` model or a generic
  `Item` model. Doing so would invent an authoritative model the source does not have, and would
  immediately raise questions the source never answers (who owns a part? is a part tenant-scoped?
  what happens when the same part appears on two BOMs?).
- **The architectural question, stated plainly for Ariya:**
  1. Is a part a **first-class, tenant-owned catalogue entity** (one row reused across BOMs), or is
     it **an attribute of a BOM line** (the same physical part appearing on two BOMs is two rows)?
  2. Is `CodeStandardDarSanat` the **identity of the part** (two items with the same standard code
     are the same part), or is it only **unique within a project + product tree** (§13)?
  3. Must `Jense_Ghatae` (material), `Sazande_Ghatae` (manufacturer) and `Vahade_Andazegiri` (unit)
     become **catalogues** (with codes), or do they stay free text?
- Until Ariya answers, V1 stores them as item attributes and **adds no unique constraint that would
  prevent a future catalogue** (§25: Part/Material contract = `NOT REQUIRED FOR V1`).

### 9.3 Explicit warning

Collapsing `Code_Ghatae` and `CodeStandardDarSanat` into one "part code", or treating
`NameGhataeDarSanat` as identical to `Title`, would each be an invention. §5.5 forbids it.

---


## 10. VALIDATION RULES

Every rule below is traced to a **specific script in the supplied XML**. Rules are classified as
**BUSINESS RULE**, **UI RULE**, **DATA VALIDATION**, **AUTHORIZATION RULE** or
**LEGACY IMPLEMENTATION DETAIL**, per the phase brief.

### 10.1 Header — write/submit (`c_Control4`, «ثبت و درج اقلام») `[CONFIRMED]`

| # | Source text | Class | Ariya treatment |
| --- | --- | --- | --- |
| V1 | `درخواست کننده انتخاب گردد!` | DATA VALIDATION | keep: requester required |
| V2 | `عنوان پروژه انتخاب گردد!` | DATA VALIDATION | keep: project reference required |
| V3 | `درخت محصول انتخاب گردد!` | DATA VALIDATION | keep: product-tree reference required |
| V4 | `مدیر درخواست کننده انتخاب گردد!` | DATA VALIDATION | keep: approving manager required |
| V5 | The whole block is guarded by `myState == 0` | BUSINESS RULE | validation applies on the draft/submit path only |
| V6 | On success the action resolves the manager's employee record and reads `PersonUser`; if empty → `یوزر مدیر پروژه در سامانه ست نشده است`, and the write is refused | BUSINESS RULE | the approver's system identity must resolve — in the ERP this is the user-directory contract (§18.5) |
| V7 | Then sets `TaeedKonandeh = PersonUser`, `StateNext = 2`, `State = 1` and saves | BUSINESS RULE | the submit transition (§11) |

### 10.2 Header — approval (`c_Control2`, «تایید و انتقال به مرحله بعد») `[CONFIRMED]`

| # | Source text | Class | Ariya treatment |
| --- | --- | --- | --- |
| V8 | `اقلامی ثبت نشده است!` when `myState == 0` and the item grid is empty | BUSINESS RULE | **the "a BOM must have items" rule** — keep |
| V9 | `confirm('آیا از ثبت اطلاعات مطمئن هستید؟')` | UI RULE | a confirmation, not a business rule |
| V10 | The same `PersonUser` resolution as V6 | BUSINESS RULE | §18.5 |

### 10.3 Item — save (`btn_Save`) `[CONFIRMED]`, in the exact order the source evaluates them

| # | Source text | Class | Field |
| --- | --- | --- | --- |
| V11 | `نام قطعه نمی تواند خالی باشد!` | DATA VALIDATION | `Title` / `partName` |
| V12 | `این قطعه قبلا ثبت شده است!` | BUSINESS RULE | **duplicate part name within the project** (§13.1) |
| V13 | `نوع قطعه در پروژه نمی تواند خالی باشد!` | DATA VALIDATION | `Noe_Ghatae` |
| V14 | `جنس قطعه نمی تواند خالی باشد!` | DATA VALIDATION | `Jense_Ghatae` |
| V15 | ` واحد اندازه گیری نمی تواند خالی باشد!` | DATA VALIDATION | `Vahade_Andazegiri` |
| V16 | `ضریب مصرف (درنقشه) نمی تواند خالی باشد!` | DATA VALIDATION | `ZaribMasraf_DarNaghshe` |
| V17 | `ضریب مصرف (یدکی/تست) نمی تواند خالی باشد!` | DATA VALIDATION | `ZaribMasraf_YadakiDorriz` |
| V18 | `کد استاندارد قطعه نمی تواند خالی باشد!` | DATA VALIDATION | `CodeStandardDarSanat` |
| V19 | `کد استاندارد قطعه نمیتواند تکراری باشد!` | BUSINESS RULE | **duplicate standard code in scope** (§13.2) |
| V20 | The item is written to `BOM_فهرست اقلام پروژه` with `BomAddRelated`, project, tree, part fields, both required coefficients, `CP_Ghatae` and (when editing) `ID` | BUSINESS RULE | the create/update payload |

**Precise source behaviour:** code generation runs first, then the empty-field checks, and the
empty-code / duplicate-code checks come **after** them within the same action. `[CONFIRMED]`

---

### 10.4 Item — the duplicate-name probe (`#c_part` keyup) `[CONFIRMED]`

| # | Source | Class | Meaning |
| --- | --- | --- | --- |
| V21 | On each keystroke in `c_part`, `LoadRecords` on `BOM_فهرست اقلام پروژه` with `NameProje_MortabetBaBOM = <selected project>` AND `Title Contains <typed text>` | BUSINESS RULE | the probe that feeds V12 |
| V22 | If **any** returned `Title` equals the typed name exactly → `check_save = 1` | BUSINESS RULE | **exact-match** duplicate detection, scoped to the project |
| V23 | The same callback writes a display string `Title (نظر مدیر: X)` list into `c_rep` («اقلام از قبل ثبت شده») | UI RULE | an information panel, not a rule |
| V24 | A hidden counter `c_Control32` toggles between `-1` and `-2` on each keystroke | LEGACY IMPLEMENTATION DETAIL | a SharePoint change-detection trick; **must not be re-created** |

### 10.5 Authorization-flavoured rules — and why they are legacy `[CONFIRMED]`

| # | Source | Class | Ariya treatment |
| --- | --- | --- | --- |
| V25 | `if (!form.UserInGroup("مالکان پژوهشکده هوا خورشید")) { form.HideTab(0); }` | **LEGACY IMPLEMENTATION DETAIL** | a hard-coded SharePoint group hides a tab. **Not** an Ariya authorization rule. |
| V26 | `if (name != "مولودی فیروزه" && name != "نورافشان مجتبی" && name != "رمضانیان مصطفی") { form.HideTab(2); }` | **LEGACY IMPLEMENTATION DETAIL** | three hard-coded person names gate the «حذف موارد اضافی» tab |
| V27 | `btn_del` («حذف»): only for those three names; loads `BomAdd` where `NazarModir = "رد"` and **hard-deletes every rejected BOM** after one confirm; otherwise `alert("کاربر گرامی شما اجازه حذف موارد اضافی را ندارید.")` | **LEGACY IMPLEMENTATION DETAIL** | a **bulk hard-delete of all rejected records by three named individuals**. It must **NOT** become an Ariya authorization rule; rejection/retirement must be a lifecycle transition with audit (§11, §24 T-4). |
| V28 | `form.HideButton("Cancel")` / `form.HideButton("Design")` outside SharePoint `Lists` URLs | UI RULE | SharePoint chrome; not a business rule |
| V29 | `c_checkUser = 1` is set when the requester **is** one of the three names, and `btn_del` is enabled only then | **LEGACY IMPLEMENTATION DETAIL** | identity-by-name again |

The phase brief is followed exactly: **no hard-coded SharePoint username or group is carried into
the Ariya authorization model.** Ariya authorization is permission-based (§17).

### 10.6 Required-field marking in the UI `[CONFIRMED]`

Labels carry a literal `*` in their Persian text (`*نام قطعه`, `*نوع قطعه در پروژه`, `*جنس قطعه`,
`*واحد اندازه گیری …`, `*ضریب مصرف (درنقشه)`, `*ضریب مصرف (یدکی/تست)`) — matching V11–V17 exactly.
This is corroborating evidence for the required set. `Sazande_Ghatae` («سازنده قطعه») is **not**
marked required and is **not** validated → optional. `Moshakhasate_Ghatae` and
`NameGhataeDarSanat` are likewise optional. `[CONFIRMED]`

### 10.7 The «بررسی کد استاندارد قطعه» bulk tool (`c_Control41`) `[CONFIRMED]`

This is a maintenance action hidden on the third tab. It:

1. reads the chosen tree from `c_nametree` and loads **all** items where
   `JazeDerakhteMahsol = <that tree>`;
2. for every item, computes `<tree code>-<zero-padded sequence index>` in list order and, **when the
   item's current `CodeStandardDarSanat` differs**, overwrites it;
3. reports `کاربر گرامی تعداد.<n>کد استاندارد قطعه مربوطه به درخت محصول انتخابی اصلاح گردید.` or
   `… هیچگونه مغایرتی … یافت نشد.`

**Classification:** LEGACY IMPLEMENTATION DETAIL encoding a real BUSINESS NEED — *a project's
standard part codes must be renumbered consistently against the product tree's code*. In the source
it is an unchecked mass update with **no audit and no per-row confirmation**. In Ariya it must
become an **explicit, permission-gated, audited Production action**, or not exist in V1 (§23). It
is also direct evidence that **the standard-part-code scheme derives from the product tree's
code**, which is why §13.3 and §25 treat the Product Tree contract as a gate.

---


## 11. LIFECYCLE / STATE MODEL

### 11.1 The states the source actually uses `[CONFIRMED]`

`c_State` — the BOM header's `State` — is compared against these literals across `BomAdd.txt` and
`Kartable Bomadd.txt`:

| Value | Where observed | Meaning evidenced by the source |
| --- | --- | --- |
| `0` | default value; all edit guards (`… .GetValue()=="0"`); section colouring for a new record | **draft** — the BOM and its items are editable |
| `1` | written by the submit action together with `StateNext = 2` | **submitted / awaiting the manager** |
| `2` | manager step: `st == 2` in the approval task; section 04 highlighted green | **at the manager's decision** |
| `50` | section 04 coloured `#FFCCCB` (red) | **rejected / refused** |
| `100` | section 04 coloured green alongside `2` | **approved / closed** |
| `5` | `EnabledFormula` on the project combo: `state <= 1 \|\| state == 5` | **unknown special case — `[OPEN]`** (11.4) |

### 11.2 The transitions the source actually performs `[CONFIRMED]`

| From | Action | Effect | Actor in source |
| --- | --- | --- | --- |
| — | create record | `State = 0` | requester |
| `0` | `c_Control4` «ثبت و درج اقلام» | validates V1–V4; resolves `PersonUser`; writes `TaeedKonandeh`, `StateNext = 2`, keeps `State = 0` so items can still be added | requester |
| `0` | `c_Control2` «تایید و انتقال به مرحله بعد» | requires ≥1 item (V8); resolves `PersonUser`; writes `TaeedKonandeh`, `StateNext = 2`, **`State = 1`**; `SaveAndExit()` | requester |
| `1` → `2` | SharePoint approval workflow start | the task form `Kartable Bomadd` is created; it loads the header via `ID = c_WorkflowItemId` | SharePoint workflow engine |
| `2` | task `btn_true` with `cr_NazarModir = "تایید"` | writes `NazarModir`, `Tozihat`, `TarikhTaedModir`; task marked `Completed` | **the manager** |
| `2` | task `btn_true` with `"نیاز به اصلاح"` | writes `NazarModir`, `Tozihat`; **`State = 0`** → back to the requester | the manager |
| `2` | task `btn_true` with `"رد"` | writes `NazarModir`, `Tozihat`; warns `«… کلیه اقلام درخواستی حذف می گردند …»` | the manager |
| `2` | task `btn_false` «انصراف و لغو درخواست» | `form.CancelRecord()` — the task is cancelled | the manager |
| `0` | `btn_Delete` on the item grid | deletes one item row | requester |
| any | `btn_del` cleanup | bulk hard-delete of all `NazarModir = "رد"` headers | three named people (LEGACY, V27) |

**The forms write `State` + `StateNext`; the engine that moves `StateNext` into `State` is the
SharePoint approval workflow — and its definition is NOT in the supplied material.** `[OPEN]`

### 11.3 Read-only / editable by state `[CONFIRMED]`

| Section | Guard in source |
| --- | --- |
| 01 «ثبت درخواست» | editable when `IsNewRecord()`; highlighted when `State == 0` |
| 02 «فهرست مواد و قطعات» (`c_GridBOM`) | `EnabledFormula = State == 0` |
| 03 «جزئیات» (all item input controls) | `EnabledFormula = State == 0` |
| 04 «وضعیت تایید مافوق» (`NazarModir`, `Tozihat`) | `IsEnabled = False` on the BOM form — **writeable only from the approval task form** |
| item buttons `btn_Save` / `btn_Ref` / `btn_New` / `btn_Delete` | `EnabledFormula = State == 0` |
| submit button `c_Control2` | `EnabledFormula = State == 0` |
| «ثبت و درج اقلام» `c_Control4` | `VisibilityFormula = IsNewRecord()` |

**Conclusion:** in the source, `State == 0` means "the requester may edit the BOM and its items";
every other state is read-only for the requester. That is the business fact to preserve. `[DERIVED]`

### 11.4 Honest gaps in the source `[OPEN]`

1. **Who writes `State = 2`, `50`, `100`?** The supplied forms write only `0` and `1` (plus
   `StateNext = 2`). The workflow definition that consumes `StateNext` is external to the supplied
   material; the *meaning* of `2`/`50`/`100` is evidenced only by the colouring and the `st == 2`
   branch.
2. **`State == 5`** appears once in an `EnabledFormula`, with no writer and no explanation.
   `[OPEN]` — Ariya must state whether it is a real state.
3. **Item-level `state`.** The items list has its own `state`, and `BomEdit` filters on
   `state = 100`, but **no supplied form ever writes it**. `[OPEN]` — the item lifecycle is not
   defined by the source and **must not be invented**. V1 therefore models only the **header**
   lifecycle and treats an item as carrying no independent status.
4. **The rejection warning promises item deletion** (`کلیه اقلام درخواستی حذف می گردند`) but the
   supplied `btn_true` performs none. `[OPEN]`.

### 11.5 Can the existing ERP Workflow support this? `[DECISION REQUIRED]`

**The Commerce workflow engine cannot be reused by Production in V1 without a contract change.**
Evidence: `WorkflowInstance` / `WorkflowDefinitionVersion` live in **`commerce_db`**
(`apps/api/prisma/commerce/schema.prisma`), the subject vocabulary is a **closed enum**

```prisma
enum WorkflowSubjectType { PURCHASE_DOCUMENT  PURCHASE_LINE }
```

and those tables are owned by the Commerce module. The repository has **no platform-level workflow
engine**: `apps/api/src/platform/**` contains audit, auth, entitlement, identity, search-source and
user-directory ports — and no workflow port. `[CONFIRMED]`

The options are therefore **(A)** a Production-owned lifecycle in V1 (§12.3 — recommended),
**(B)** a later platform Workflow extraction (§25 → `NEW CONTRACT`), or **(C)** Commerce exposing
its engine through a port — rejected because it inverts the dependency and couples Production to
Procurement. **V1 takes (A).** `[DECISION REQUIRED — RECOMMENDED]`

---


## 12. APPROVAL MODEL

### 12.1 What the source's approval actually is `[CONFIRMED]`

The approval is a **single-step, named-person approval by the requester's manager**:

1. The requester selects «مدیر درخواست کننده» (`ModirTaeedKonandeh`) from the employee list.
2. On submit, the form loads that employee record, reads `PersonUser` — the manager's system
   account — and stores it in `TaeedKonandeh`. If `PersonUser` is empty, submission is
   **refused** (V6).
3. SharePoint routes a task to that account. The task form (`Kartable Bomadd`) shows the BOM read
   from `BomAdd` by `ID = c_WorkflowItemId`, plus the item grid.
4. The manager chooses exactly one of three static values — `تایید` / `نیاز به اصلاح` / `رد` —
   optionally fills `Tozihat`, and confirms:
   - `تایید` → `NazarModir` + `Tozihat` recorded, approval evidence written (`TarikhTaedModir`);
   - `نیاز به اصلاح` → recorded and **`State` reset to `0`** (back to the requester);
   - `رد` → recorded, with a warning that the requested items will be deleted;
   - no opinion chosen → the task refuses: `نظر مدیر مشخص نشده`.
5. `cr_date` (approval date) is auto-filled on the task form.

**There is exactly ONE approval step and ONE approver.** `[CONFIRMED]`

### 12.2 What exists in the ERP to build on `[CONFIRMED]`

| Candidate | Exists? | Evidence |
| --- | --- | --- |
| A platform-generic workflow engine | **NO** | no workflow port under `apps/api/src/platform/**` |
| The Commerce workflow engine | **YES, but Commerce-owned** | `commerce_db` tables + closed `WorkflowSubjectType` enum (§11.5) |
| HR leave/mission approval engines | **YES, but HR-owned and HR-specific** | `LeaveApprovalDefinition`/`StepInstance`, `MissionApprovalDefinition`/`StepInstance` in `hr_db`, both FK-bound to `LeaveRequest`/`MissionRequest` |
| A platform approval contract | **NO** | — |
| The platform **rule engine** (`src/rules`) | YES | pure evaluator — evaluates *rules*, it is not a state machine or an inbox |
| Approval inbox / pending decisions | YES, **Commerce-scoped** | `CommercePendingDecisionsService`, `pending-decisions.controller.ts` |
| Audit (`AUDIT_PORT`), Entitlement (`ENTITLEMENT_PORT`), User directory (`USER_DIRECTORY`) | YES, platform | §18 |

**There are already TWO approval engines in the repository** (Commerce workflow, HR
leave/mission). Building a THIRD, Production-specific engine is explicitly forbidden by the phase
brief ("Do not create an independent approval engine"). `[DERIVED]`

### 12.3 The V1 decision `[DECISION REQUIRED — RECOMMENDED]`

```
V1: Production owns the BOM lifecycle as a GUARDED STATE MACHINE
    DRAFT → SUBMITTED → MANAGER_REVIEW → APPROVED | REJECTED | CORRECTION_REQUESTED
    + the manager decision recorded ON the BOM (opinion, comment, decidedAt, decidedBy)
    + every transition permission-gated and audited through AUDIT_PORT
    + no second engine, no per-step definition table, no generic task table
```

Why this is the smallest honest V1:

- It reproduces **exactly** the source's behaviour (one step, one approver, three outcomes) without
  inventing a configurable engine the source does not have.
- It keeps Production independent of Procurement (§3.2/§3.3).
- It does **not** claim to be the final answer: §25 records the Workflow/approval contract as
  `NEEDS EXTENSION` (platform Workflow extraction), and §21 records the consequence (a BOM that
  Purchase later consumes must be immutable at the moment it is consumed).

### 12.4 Honest gaps `[OPEN]`

1. **How the item's `NazarModir` is populated.** Items carry `NazarModir` in their projection, and
   `BomEdit` and the Purchase form filter on it (`NazarModir = تایید`), yet the supplied forms
   write `NazarModir` only on the **header**. Either a SharePoint column default/copy or an external
   process fills it. `[OPEN]` — **V1 must not invent an item-level approval**; a consumer that needs
   "approved items" must read the header's decision, not a copied column.
2. **Does approving the header approve every item?** The source's item queries assume yes
   (`state = 100`, `NazarModir = تایید`). V1 records this as the intended invariant but does not
   bake it into an item column.

---


## 13. DUPLICATE / UNIQUENESS CONTRACT

Two **different** duplicate rules exist in the source, with different scopes. They must not be
merged.

### 13.1 Rule 1 — duplicate PART NAME within the project `[CONFIRMED]`

- **Probe** (V21): items where `NameProje_MortabetBaBOM = <project>` and `Title Contains <typed>`.
- **Decision** (V22): refuse when **any** result's `Title` **equals** the typed name.
- **Scope:** **project only** — the product tree is **not** part of this criterion. `[CONFIRMED]`
- **Enforcement point:** on the client, at `btn_Save` (`check_save == 1`) — a UI gate that the ERP
  server must re-implement as a real rule.

### 13.2 Rule 2 — duplicate STANDARD PART CODE `[CONFIRMED]`

- **Probe:** `ListQuery3` —

  ```
  Entity   = BOM_فهرست اقلام پروژه
  Criteria = NameProje_MortabetBaBOM = {c_NameProje}
             AND JazeDerakhteMahsol   = {c_ProductTreeRef}
             AND CodeStandardDarSanat = {c_code_part}
  ```

  bound to the hidden control `c_Control27` (`Value_ListQueryField = CodeStandardDarSanat`).
- **Decision** (V19): if `c_Control27 != ""` at save → `کد استاندارد قطعه نمیتواند تکراری باشد!`
- **Scope:** **project + product tree + standard part code** — the tree **is** part of this
  criterion.

### 13.3 The "excluding the current record / author" question — traced exactly `[CONFIRMED]`

The source has a **third** query that involves the author:

```
ListQuery2: MaxRows=1, SortField=CodeStandardDarSanat, SortAsc=False
Criteria = NameProje_MortabetBaBOM = {c_NameProje}
           AND JazeDerakhteMahsol   = {c_ProductTreeRef}
           AND Author               = {c_Control32}   [Operator: NotEquals]
```

`c_Control32` is the **hidden `Author`-toggling counter** (V24). This query therefore means "the
highest `CodeStandardDarSanat` **not authored by me**", and it is bound to `c_Control31`, which is
used for **code generation** — **not** for the duplicate verdict.

**The duplicate verdict (`ListQuery3`) has NO `Author` and NO `ID` exclusion at all**: it compares
the candidate code against **every** item in the scope, which is why the save refuses on any hit.

**Answer to the brief's question:** the author-based exclusion is a **LEGACY IMPLEMENTATION DETAIL
of code generation**, not part of the uniqueness contract. On **edit** the source does not exclude
the current row either — it re-saves the item under its own `ID`, and a new code is only generated
for a new row. `[CONFIRMED]`

### 13.4 Code generation, which the uniqueness rule interacts with `[CONFIRMED]`

Inside `btn_Save`, before the empty/duplicate checks:

```
codeTree = c_Control31                      // ← ListQuery2: the max CodeStandardDarSanat NOT
                                            //   authored by me, in <project + tree> (§13.3)
base     = ProductTreeRef_x003A_code        // the product tree's `code`
n        = codeTree != "" ? parseInt(lastSegment(codeTree)) + 1 : 1
newCode  = <base> + "-" + zeroPad3(n)       // e.g. TREECODE-001
```

The approval task form re-implements the same generation but from the **last element of the full
item list** (`e.ListItems[len-1].CodeStandardDarSanat`) using `padStart(3,'0')`, and
`base + "-001"` when the list is empty. `[CONFIRMED]`

**Two implementations of one rule, disagreeing about where "the last code" comes from** — a real
defect in the source. Ariya must implement **one** rule; which one (max-in-scope vs last-in-list) is
`[DECISION REQUIRED]`. §25 marks the Product Tree contract as a gate because `base` comes from it.

### 13.5 The intended Ariya invariant `[DECISION REQUIRED — RECOMMENDED]`

```
UNIQUE ( tenantId, projectRef, productTreeRef, standardPartCode )   ON BOM ITEM
UNIQUE ( tenantId, projectRef, partName )                            ON BOM ITEM
```

**But this phase does NOT create either constraint.** Reasons, all evidenced:

1. **Scope ownership is unresolved.** `projectRef`/`productTreeRef` point at domains that do not
   exist in the ERP (§7.2, §8.2). If those domains later define revision/identity semantics, the
   uniqueness scope must be re-derived.
2. **The part-identity question is open.** If Ariya decides a part is a catalogue entity (§9.2),
   the invariant moves from "unique per BOM item" to "unique per part catalogue".
3. **Soft-delete / archival policy is unstated.** The source hard-deletes (V27); Ariya will not
   (§24). Whether a retired item still occupies its code is unanswered by the source.
4. **Case/whitespace normalization is unstated.** The source compares raw strings (`Contains` +
   exact `===`); whether `TREECODE-001` and `treecode-001` collide is `[OPEN]`.

**Therefore: do NOT create a database unique constraint in V1.** V1 enforces the rule in the service
layer (deterministic, auditable, reversible) and promotes it to a DB constraint only once the four
points above are answered. §25 records this as a gate.

### 13.6 Is the standard code immutable once assigned? `[OPEN]`

The source allows an existing item's `CodeStandardDarSanat` to be overwritten by the maintenance
tool (§10.7) and by the approval task's save path — so "the code is immutable" is **not** a rule the
source holds. Whether Ariya makes it immutable is `[DECISION REQUIRED]`.

---


## 14. CONSUMPTION COEFFICIENT SEMANTICS

### 14.1 What the field names say `[CONFIRMED]`

The Persian labels are the strongest evidence available and are replicated exactly:

| SharePoint field | Persian label (exact) | Literal meaning |
| --- | --- | --- |
| `ZaribMasraf_DarNaghshe` | ضریب مصرف (درنقشه) | consumption coefficient *in the drawing/map* |
| `ZaribMasraf_YadakiDorriz` | ضریب مصرف (یدکی/تست) | consumption coefficient *spare / test* |
| `ZaribMasraf_KoleGhatae` | ضریب مصرف کل قطعه | *total* consumption coefficient of the part |
| `ZaribMasraf_DarNaghshe_DarHalSef` | ضریب مصرف (در نقشه) در حال سفارش | drawing coefficient **while an order is in progress** |
| `ZaribMasraf_YadakiDorriz_DarHalS` | ضریب مصرف (یدکی/تست) در حال سفارش | spare/test coefficient **while an order is in progress** |
| `ZaribMasraf_DarNaghshe_Kharidsho` | ضریب مصرف (در نقشه) خریداری شده | drawing coefficient **already purchased** |
| `ZaribMasraf_YadakiDorriz_KharidS` | ضریب مصرف (یدکی/تست) خریداری شده | spare/test coefficient **already purchased** |

### 14.2 What is KNOWN, field by field `[CONFIRMED]`

| Field | Type evidence | Written by source? | Negative allowed? | Rounding |
| --- | --- | --- | --- | --- |
| `ZaribMasraf_DarNaghshe` | plain `TextBox`; copied verbatim; **integer-parsed** in all arithmetic below | **YES** (item save) | the item save constrains only *non-empty*; arithmetic elsewhere floors at 0 | no rule visible |
| `ZaribMasraf_YadakiDorriz` | same | **YES** (item save) | same | — |
| `ZaribMasraf_KoleGhatae` | numeric projection | **NO** writer in the supplied forms | unknown | unknown |
| `…_DarHalSef` / `…_DarHalS` | numeric projection | **NO** | unknown | unknown |
| `…_Kharidsho` / `…_KharidS` | numeric projection | **NO** | unknown | unknown |

The strong reading is that `ZaribMasraf_KoleGhatae` (**total**) and the four `DarHalSef` /
`Kharidsho` fields are **derived** quantities maintained by the wider SharePoint solution — but
**the source does not define the formula**. `[OPEN]`

### 14.3 The only arithmetic the source performs `[CONFIRMED]`

**In `BomEdit` (change request) — display plus a soft warning:**

```js
total  = parseInt(c_Control13 /* previous drawing coeff */) + parseInt(c_Control7 /* delta */)
if (total < 0) alert("هشدار: ... مجموع ضریب مصرف (درنقشه) نمی تواند کمتر از 0 شود.")
// note: `error` is NOT set — the source shows the guard was deliberately disabled
total1 = parseInt(c_Control14) + parseInt(c_Control10)
if (total1 < 0) alert("هشدار: ... مجموع ضریب مصرف (یدکی / تست) نمی تواند کمتر از 0 شود.")
```

**In the change-request approval task (`kartable bomEdit`) — a hard refusal at approval:**

```js
total  = parseInt(delta.Drawing)   + parseInt(item.ZaribMasraf_DarNaghshe)
total1 = parseInt(delta.SpareTest) + parseInt(item.ZaribMasraf_YadakiDorriz)
if (total  < 0) → "میزان کل ضریب مصرف (در نقشه) برای قطعه <name> نمی تواند کمتر از 0 شود."
if (total1 < 0) → "میزان کل ضریب مصرف (یدکی / تست) برای قطعه <name> نمی تواند کمتر از 0 شود."
```

### 14.4 What this establishes, and what it does not `[DERIVED]` / `[OPEN]`

**Established:**
- The **unit is an integer** in every arithmetic use (`parseInt` throughout, no decimals).
- **Negative results are refused** — but only at the *change-request approval* step, and only for the
  two base coefficients. The item-creation path refuses only *empty* values, never negatives.
- `ZaribMasraf_KoleGhatae`, `DarHalSef` and `Kharidsho` are **never arithmetic operands** in the
  supplied forms → they are read-only outputs of an external process.

**Open — to be answered by Ariya, not invented here:**
1. **The exact definition of "total"** — is it `drawing + spare/test`, or something else? The source
   never computes `ZaribMasraf_KoleGhatae` itself.
2. **Data type** — integer or decimal? Only integers appear in arithmetic.
3. **Is zero permitted?** The item save forbids *empty*; the change path forbids *negative*; a stored
   `0` is never explicitly forbidden. `[OPEN]`
4. **Rounding** — no rounding is visible anywhere. `[OPEN]`
5. **The semantics of the four on-order/purchased fields and who maintains them** — almost certainly
   written by the Purchase solution, which is out of scope here and **must not be guessed** (§20).
6. **Are there per-project unit/precision conventions for the coefficients?** `[OPEN]`

**V1 rule:** store both required coefficients with the source's validation (non-empty), refuse a
negative *stored* value (`>= 0`, because the only floor the source ever states is 0), and treat every
derived/projection field as **read-only and outside the V1 write contract** until Ariya defines it.

---


## 15. SUPPLIER / PRICE SEMANTICS

### 15.1 What the source says `[CONFIRMED]`

| Field | Persian | Appears in | Writer in the supplied source |
| --- | --- | --- | --- |
| `TaminKonandePishnahadi_BOM` | تامین کننده پیشنهادی | BOM item projection; read by the Purchase forms | **NONE** |
| `GheimatTaminKonandePishnahadi_BO` | قیمت تامین کننده پیشنهادی | BOM item projection; read by the Purchase forms | **NONE** |
| `Tozihat_Ghatae_DarBOM` | توضیحات قطعه در BOM | BOM item projection | **NONE** |

The names say what they are: a **suggested** supplier (تامین کننده **پیشنهادی**) and that
supplier's **suggested** price (قیمت … **پیشنهادی**). The Purchase form reads all three (they are in
its `ListQuery_BOMProje` attribute list), so the source's purchase flow **pre-fills from the BOM's
suggestion**, and the purchase side then owns the real commercial decision.

### 15.2 Classification `[DECISION REQUIRED — RECOMMENDED]`

```
suggestedSupplier        →  INFORMATIONAL BOM METADATA (a proposal, not a commitment)
suggestedSupplierPrice   →  INFORMATIONAL BOM METADATA (a proposal, not a purchase price)
itemComments             →  INFORMATIONAL BOM METADATA
```

Rationale, from the source: they are **never written** by any BOM form, they are **read** by the
Purchase forms, and they are named "suggested". None of those three facts supports treating them as
authoritative procurement data. `[DERIVED]`

### 15.3 What must NOT happen `[CONFIRMED]`

- **No `Supplier` table is created in V1** and **no FK to Commerce.** The repository has no supplier
  model (§7.2), and Commerce's procurement model is `PurchaseDocument` / `PurchaseLine`, reached only
  through its own contracts.
- The BOM must **not** link to Commerce/Purchase in this phase (§20, §27).
- The values are stored as **BOM metadata**, with their external raw values preserved for a later
  mapping.

**Open:** whether `TaminKonandePishnahadi_BOM` in SharePoint holds a **lookup id** (to a supplier
list that was not supplied) or free text. The projection alone proves neither `[OPEN]` — a migration
must therefore preserve the raw value verbatim (§22).

---

## 16. QUALITY / CONTROL-PLAN BOUNDARY

### 16.1 What the field means in the source `[CONFIRMED]`

- The control is a `ComboBox` with **exactly two static values**: `دارد;ندارد` — i.e.
  «طرح کنترل دارد؟» ("does it have a control plan?") → **has / has not**.
- Its Persian label is `c_Control15` = «طرح کنترل دارد؟» and it sits in the item-details section,
  beside the part fields — so it is a fact about the **item**, not about the BOM.
- The field is `CP_Ghatae` on the item list and is **written** by the item-save action
  (`listitem.CP_Ghatae = CP_Ghatae`) in `BomAdd`, in the approval task and in the **Purchase** form
  (which re-reads it).
- It is **not** marked required and **not** validated.

### 16.2 Classification `[DERIVED]`

```
hasControlPlan : ENUMERATED INDICATOR (دارد / ندارد)  — NOT a reference to a control-plan document
```

**Why it is an indicator and not a reference, from the source:** the control is a two-value combo
box; it holds no lookup, no id and no attachment; and the Purchase form re-reads the same two-value
field when deciding whether a quality-control step applies (`ViziyatCP`, `c_C_Quality_Control` with
`بله;خیر`). A boolean-equivalent flag travels further than any control-plan document in this source.

### 16.3 What this phase does NOT do `[CONFIRMED]`

- **No Quality module is created.** No control-plan entity, no inspection, no checklist, no quality
  status table.
- The field is modelled as a **two-value enumerated indicator** on the item and nothing more.

### 16.4 The future integration boundary `[DERIVED]`

Quality is a genuine future bounded context, and this field is where it will attach:

```
Production / BOM Item ── hasControlPlan (دارد | ندارد)   ← today: a flag
Quality  (future)     ── the actual control plan, revisions, inspections, results
```

The BOM's design must therefore keep `hasControlPlan` a **self-contained enumerated value**. If
Quality later needs "which control plan", it must arrive as a reference that Quality owns — the BOM
must not have to change its own identity, and **BOM must not depend on Quality to be created or
approved**. §25 records Quality as `NOT REQUIRED FOR V1`.

---


## 17. TENANT / AUTHORIZATION MODEL

### 17.1 Tenant ownership `[CONFIRMED — platform evidence]`

| Concern | Owner today | Evidence |
| --- | --- | --- |
| Tenant record | **Core** | `prisma/core/schema.prisma` → `model Tenant` |
| Tenant resolution per request | **Core / platform** | `RequestContextService` + `platform/auth/tenant-resolver.contract.ts`, `claims-tenant-resolver.ts` |
| Scope enforcement | **the module, using `actor.tenantId`** | `resolveCommerceActor()` throws `ForbiddenException` when no tenant is resolved — **fail closed** |
| Module/feature entitlement | **platform** | `ENTITLEMENT_PORT` (`entitlement.contract.ts`), `RequiresModule` / `RequiresFeature`, `PlatformEntitlementService` |
| Permission catalogue & roles | **Core (RBAC)** | `Permission` / `Role` / `RolePermission` / `UserRole`; `PermissionDomain` enum |
| A person's identity | **platform** | `USER_DIRECTORY` port, `CoreUserDirectoryAdapter` |

**Production inherits this model unchanged.** It declares its own module id, feature slug and
permission strings; it never reads `ModuleRegistration` / `ModuleFeature` itself.

### 17.2 What Production must add `[DECISION REQUIRED — RECOMMENDED, NOT IMPLEMENTED]`

| Item | Kind | Note |
| --- | --- | --- |
| `production` module registration | Core migration (like `20260926100200`) | `moduleType = BUSINESS`, `tenantScope = RESTRICTED_MEMBERS`, membership per tenant |
| `bom` feature + per-tenant grants | Core migration (like `20260926100300`) | fail-closed for tenants created later |
| `PRODUCTION` member on `PermissionDomain` | its own migration | the `55P04` lesson: the enum must be added in a **separate, earlier** transaction than its use — evidence `20260926100000_add_commerce_permission_domain` |
| Permission strings | Core migration granting to `SUPER_ADMIN` / `ADMIN` | see §17.3 |
| `PRODUCTION_MODULE_ID`, `PRODUCTION_FEATURE`, audit-resource constants | module constants file | mirrors `commerce.constants.ts` |

### 17.3 Proposed permission namespace `[DECISION REQUIRED — PROPOSED, NOT CREATED]`

The brief forbids inventing permissions, so these are **proposals derived from operations actually
found in the source**, to be approved before any migration writes them:

| Proposed permission | Justified by which source operation |
| --- | --- |
| `production.bom.read` | viewing/listing BOMs and their items (the read-only states) |
| `production.bom.manage` | create/edit header, add/edit/delete **draft** items (`btn_Save`, `btn_New`, `btn_Delete`) |
| `production.bom.submit` | `c_Control4` / `c_Control2` — moving a draft to the manager |
| `production.bom.approve` | the approval task's `btn_true` / `btn_false` (the manager's decision) |

The shape deliberately mirrors `commerce.*` (`read` / `manage` / `approve`, plus a
configuration-level permission where configuration exists): two bounded contexts that answer "what
may this caller do?" with different shapes make the answer depend on which module a client happens
to call. `[DERIVED]`

**Deliberately not proposed:** a per-project or per-product-tree permission, a per-part permission,
or anything derived from the legacy hard-coded names (V25–V27, §10.5).

### 17.4 The three absolute rules from the brief, and how each is satisfied `[DERIVED]`

| Rule | Mechanism |
| --- | --- |
| No user may **see** another tenant's BOM | every read is scoped by `actor.tenantId`, taken from the request context — never from a request field. The caller's identity is never a BOM field. |
| No user may **modify** another tenant's BOM | every write resolves the row by `(tenantId, id)`; a row of another tenant is a **404/403**, never a silent edit. |
| No user may **approve** another tenant's BOM | the approval transition is gated by `production.bom.approve`, the row must resolve inside the caller's tenant, and the caller must be the resolved approver (or hold the permission, per §26 D-4). |

**Tenant isolation is NOT inherited from `projectRef`** (§7.3): a referenced project cannot be used
to derive the tenant.

### 17.5 Legacy identity rules — explicitly rejected `[CONFIRMED]`

The three hard-coded person names and the SharePoint group of V25–V27 **must not** become Ariya
authorization. They are legacy behaviour; if the operations they gate are still needed (bulk
retirement of rejected BOMs), they must be re-expressed as a permission-gated, audited lifecycle
action (§24 T-4).

---


## 18. SEARCH / AUDIT / NOTIFICATION BOUNDARIES

### 18.1 Global Search `[CONFIRMED — platform contract exists]`

A bounded context can contribute searchable projections through the **platform Search Source
contract** (`src/platform/search-source/search-source.contract.ts`, introduced by P-SEARCH-SOURCE):

- `SEARCH_SOURCE_PORT` is the only seam; `sourceType = EXTERNAL` plus a **`sourceKey`** matching the
  grammar `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$` — the shipped example is `commerce.purchase-document`;
- the source supplies a **route template** the platform validates (`/…/:id`) and a **weight class**
  (`PRIMARY`/`SUPPORTING`; the numeric value is a platform constant);
- the platform owns retrieval, normalization (`buildSearchText`), ranking, paging and the envelope;
- the index is **not** an authorization boundary — the platform re-asks the owning source whether the
  caller may see a candidate id, in one batch.

**Verdict for BOM:** the Search Source contract `EXISTS`; Production would register a key such as
`production.bom` and answer authorization from its own tenant-scoped read. **Not implemented in
V1**; §25 records it as `EXISTS (reusable)`.

### 18.2 Audit `[CONFIRMED — platform contract exists]`

- One authoritative trail: `core_db."AuditLog"`, reached through `AUDIT_PORT`.
- `record(...)`: producer-owned `auditId` (UUID, never derived from `requestId`), required
  `tenantId`, closed rejection codes, **never throws**, discriminated result.
- The read half (`read(query)`) was added by P-AUDIT-READ with a bounded page size and a closed safe
  projection.
- A bounded context writes through its own **gateway** (the `CommerceAuditGateway` pattern) which
  owns envelope construction (`tenantId` from the **actor**) and passes the caller's `act` through; a
  failure is logged and never fails the business operation.

**Verdict for BOM:** the Audit contract `EXISTS`; BOM must add a `ProductionAuditGateway` plus a
`PRODUCTION_AUDIT_RESOURCE` vocabulary, one resource per audited row. **Every mutating BOM operation
must be audited — including the approval decision and any replacement for the legacy "bulk cleanup"
(V27).**

### 18.3 Notifications `[CONFIRMED — platform contract exists]`

`NotificationPublisher.publish` (transport) and `NotificationService.createForUser` (the in-app
Notification Center) are platform capabilities. Commerce reaches them only through
`CommerceNotificationGateway`, with the closed four-member `NotificationType` vocabulary
(`SYSTEM`, `SECURITY`, `ANNOUNCEMENT`, `INFORMATION`).

**Verdict for BOM:** the contract exists and is reusable; the natural V1 notification is "a BOM is
waiting for your decision" addressed to the resolved approver. §25 records it as `EXISTS`; §23
classifies the V1 use as **OPTIONAL**, because the source's notification is whatever SharePoint's own
workflow task created, which the supplied material does not specify. `[OPEN]`

### 18.4 Ordering, paging, totals `[CONFIRMED]`

Commerce and HR established a module-level `*_MAX_PAGE_SIZE` / `*_DEFAULT_PAGE_SIZE` pair, with the
ceiling enforced **twice** (DTO as a contract → 400; service `Math.min` as the guarantee).
Production should adopt the identical pair rather than a third convention.

### 18.5 Identity resolution for requester / approver `[CONFIRMED]`

The source resolves the manager's system account through the employee list's `PersonUser` (V6). In
the ERP the equivalent is the **`USER_DIRECTORY`** port (`USER_DIRECTORY` token,
`CoreUserDirectoryAdapter`), which returns an allowlisted person projection and can answer "is this
id a member of my tenant?". **No BOM table may hold a name, an email or a role** — only an opaque
user id plus a directory projection at read time.

### 18.6 Summary table

| Capability | Contract status | Reused by BOM as |
| --- | --- | --- |
| Tenant resolution | `EXISTS` | `resolveProductionActor(req)` (a copy of the proven shape) |
| Entitlement (module / feature) | `EXISTS` | `RequiresModule('production')` + `RequiresFeature('production','bom')` |
| RBAC permissions | `EXISTS` (needs the `PRODUCTION` domain + new strings) | `@Roles(...)` at the controller boundary |
| Audit | `EXISTS` | a Production audit gateway through `AUDIT_PORT` |
| Search | `EXISTS` | a Production search source through `SEARCH_SOURCE_PORT` |
| Notification | `EXISTS` | a Production notification gateway |
| Identity | `EXISTS` | `USER_DIRECTORY` for requester/approver projections |
| Ordering / paging | `EXISTS` (convention) | Production's own two page-size constants |
| Workflow / approval | **does not exist as a platform contract** | §12.3 — a Production-owned guarded state machine in V1 |

---


## 19. FRONTEND ARCHITECTURE

### 19.1 What exists `[CONFIRMED]`

| Concern | Established pattern | Evidence |
| --- | --- | --- |
| Route ownership | one folder per module under `/admin/<module>/…` | `apps/web/src/app/admin/commerce/**`, `/admin/hr/**`, `/admin/correspondence/**` |
| API access | one `<module>-api.ts` client over a shared HTTP core | `src/lib/core-http.ts` + `commerce-api.ts`, `hr-api.ts`, … |
| Persian labels | a `<module>-labels.ts` module with `…Label()` / `…Tone()` helpers | `src/lib/commerce-labels.ts` |
| i18n | `src/messages/fa.json` + `en.json` (Persian-first) with `src/lib/i18n.ts` | present |
| Lists | a `<Module><Entity>ListView.tsx` with paging/filters | `CommercePurchaseListView.tsx` |
| Create / detail | `<Module><Entity>CreateView.tsx` + `…DetailView.tsx` | `CommercePurchaseCreateView.tsx`, `CommercePurchaseDetailView.tsx` |
| Grids / line editing | dedicated table + editor components | `CommercePurchaseLinesTable.tsx`, `CommercePurchaseLinesEditor.tsx` |
| Approval UX | a decision panel + a tasks inbox | `CommerceCommercialDecisionPanel.tsx`, `CommerceTasksView.tsx` |
| Confirmation dialogs | a shared dialog component | `CommerceConfirmDialog.tsx` |
| Module guard | a settings/feature guard component | `CommerceSettingsGuard.tsx` |
| Navigation | server-side nav catalogue with per-route RBAC gating | `apps/api/src/preferences/nav-catalogue.ts` (`href` + optional `permission`) |

### 19.2 What V1 will therefore need (design intent only — NOT built) `[DERIVED]`

```
apps/web/src/app/admin/production/boms/page.tsx           list  (+ search / filter / paging)
apps/web/src/app/admin/production/boms/new/page.tsx       create
apps/web/src/app/admin/production/boms/[id]/page.tsx      detail + items grid + approval state
apps/web/src/lib/production-api.ts                        typed client
apps/web/src/lib/production-labels.ts                     Persian status/opinion/type labels
```

plus a nav entry (`/admin/production/boms`) gated on `production.bom.read`, and Persian labels for
the enums the source uses **verbatim** (`تایید`, `نیاز به اصلاح`, `رد`, `دارد`, `ندارد`, `ساختی`,
`استاندارد`).

**The Persian-first requirement is satisfied by preserving those exact strings** — the ERP must not
translate them into English and back.

### 19.3 Constraints the UI must respect (derived from §10–§13) `[DERIVED]`

- **A BOM cannot be submitted without items** (V8) — the UI must explain why, but the **server** is
  the enforcement point.
- **Draft-only editing** (`State == 0`, §11.3) — awaiting-review and decided BOMs are read-only.
- **The standard code is generated, not typed** (§13.4) — shown read-only, its value comes from the
  server, never from the client.
- **Duplicate feedback must be server-driven** — the source's client-side probes (V21–V22) are a UX
  affordance; the ERP must not treat a client probe as the rule.
- **No free-text identity fields** — requester/approver are directory-backed pickers.

**THIS PHASE BUILDS NONE OF THIS.**

---


## 20. PROCUREMENT INTEGRATION BOUNDARY

### 20.1 The future direction, from the evidence `[CONFIRMED]`

The source already shows the intended shape, and it is **not** an integration the BOM initiates:

```
Purchase form (kharid.txt)
  ├─ picks a project            (c_NameProjeKala  → «لیست پروژه ها»)
  ├─ picks a product tree       (c_B_ProductTreeRef → ProductTree)
  ├─ filters BOM items          (ListQuery_BOMProje: NameProje_MortabetBaBOM = project
  │                              AND JazeDerakhteMahsol = tree AND Title Contains …)
  ├─ selects a BOM item         (c_C_Select_Bom_Id)
  ├─ reads its coefficients / part data / suggested supplier / price from the BOM item
  └─ writes a purchase-tracking row referencing that BOM item
     (ردیابی خریدها: ID_BOM = selectbomId, plus requested quantities and CP status)
```

Evidence: `kharid.txt`, action `c_C_AfzoodanBe_List_Kahrid`, which writes
`listitem.ID_BOM = selectbomId` into `ردیابی خریدها`.

**Therefore: Procurement consumes an approved BOM. The BOM does not create purchase requests.**

### 20.2 What V1 must NOT decide `[DECISION REQUIRED — DEFERRED]`

All of the following are **explicitly deferred** to a separate integration contract, not guessed here:

| Deferred question | Why the source cannot answer it |
| --- | --- |
| automatic line creation from BOM items | the source creates lines on an explicit user action, not on approval |
| snapshot vs live BOM | the source reads live item rows at purchase time; whether Ariya pins a snapshot is unstated |
| version pinning | the source pins nothing (there is no version model, §21) |
| quantity derivation | the source takes a user-entered quantity, validated for plausibility — not a computed one |
| supplier selection | the source only *suggests* a supplier (§15) |
| pricing source | the source's price is a *suggested* price (§15) |
| which BOM state is consumable | the source's queries filter on `state = 100` / `NazarModir = تایید`, but **no supplied form writes those** (§11.4, §12.4) |

### 20.3 The contract the future phase will need `[DECISION REQUIRED]`

```
Production / BOM  ──reads──▶  (a Production-owned, tenant-scoped "approved BOM items" read)
                              └─ consumed by Procurement through ITS OWN contract
```

Two hard rules this phase fixes:

1. **The dependency must point from Procurement to Production, never the reverse.** Production must
   not import Commerce and must not hold a Purchase foreign key. `[DERIVED]`
2. **The consumed BOM state must be immutable at the moment of consumption** (§21.4). A purchase
   request that references a BOM item whose coefficients can still change is a request whose meaning
   changes after the fact — the source's live-read behaviour is a defect to fix, not to copy.

### 20.4 What this phase does `[CONFIRMED]`

Nothing. **BOM is not connected to Purchase in this phase.**

---

## 21. VERSIONING

### 21.1 What the source has `[CONFIRMED]`

- `State` + `StateNext` + `NazarModir` + `TarikhTaedModir` — a **status**, not a version.
- The change-request flow (`BomEdit`) modifies an item's coefficients **in place** after approval,
  keeping only `MizanAvaliye…` (initial value) and `MizanAfzayesh…` (delta) on the *change line*, plus
  a `NoeaTaghir` («change type») — **not** a new revision of the BOM.
- There is **no** version number, no effective date and no revision column anywhere in the source.
  `[CONFIRMED]`

### 21.2 The three options evaluated `[DERIVED]`

| Option | Fit to the source | Verdict |
| --- | --- | --- |
| **A. Mutable BOM** | exactly what the source is: edit until approved, then change via a separate request that mutates items | **V1 = A** |
| **B. Revision / versioned BOM** | the source has no version identity; introducing one adds tables, rules and a UI the business has not asked for | `[DECISION REQUIRED]` — not V1 |
| **C. Effective-dated BOM** | the source has no temporal model at all | `[DECISION REQUIRED]` — not V1 |

The brief is followed: a versioning system is **not** introduced merely because it is architecturally
attractive.

### 21.3 Why V1 none the less needs an immutability point `[DERIVED]`

Even with a mutable BOM, the **decision** must be immutable evidence:

- the approval record (opinion, comment, decided-by, decided-at) must never be rewritten;
- the state transitions must be append-only in the audit trail (§18.2);
- a decided BOM must be read-only for the requester (`State == 0` is the only editable window,
  §11.3).

This reproduces the source's *de facto* behaviour (the requester cannot edit after submit) without
inventing a version model.

### 21.4 The flagged impact on future Purchase consumption `[DECISION REQUIRED]`

> A purchase request should eventually reference an **immutable / known BOM state**.

Consequence, recorded here and **not solved**: when Procurement consumes BOM items, Production must
be able to answer "what exactly did this BOM say at the moment it was consumed?". The options are a
purchase-side snapshot, a Production-side revision, or a content hash on the item row — **all future
work**. The V1 design must therefore (a) keep item rows addressable by a stable id, and (b) keep the
audit trail complete enough to reconstruct an item's history — which §18.2 requires anyway.

---


## 22. MIGRATION CONSIDERATIONS

**No data is migrated by this phase and no migration code is written.** This section records what a
future migration would have to preserve, traced to the source.

### 22.1 The mapping dimensions `[DERIVED]`

| Dimension | Why it is needed | Evidence |
| --- | --- | --- |
| **SharePoint ID mapping** | every source row is identified by an integer `ID`; the ERP uses UUIDs. Without a persisted `legacySharePointId`, no row can be re-associated with its SharePoint origin. | `listitem.ID`, `c_bomID`, `IdBomChangeStack` |
| **Header ↔ item re-linking** | items relate to the header only by the lookup value `BomAddRelated`. A migration must preserve that integer pair. | `ListQueryBom` criterion `BomAddRelated;{c_ID};Equals;Lookup` |
| **Project mapping** | `NameProje` / `NameProje_MortabetBaBOM` hold `لیست پروژه ها` ids. Until a Project domain exists the id must be stored **verbatim** as an opaque reference. | §7 |
| **Product-tree mapping** | `ProductTreeRef` / `JazeDerakhteMahsol` hold `ProductTree` ids; the tree's `code` is captured in `ProductTreeRef_x003A_code`. | §8 |
| **User mapping** | `DarkhastKonandeh`, `ModirTaeedKonandeh`, `TaeedKonandeh` hold identities from `لیست کارکنان` (with `PersonUser` as the system account). Deleted or unlinked users must not break a BOM. | V6, §18.5 |
| **Supplier mapping** | `TaminKonandePishnahadi_BOM` may be an id or free text — `[OPEN]`. Preserve the raw value. | §15.3 |
| **Part-code preservation** | `CodeStandardDarSanat` is the business code and must **never** be regenerated by a migration. Regenerating it would silently renumber a production BOM. | §13.3, §10.7 |
| **State mapping** | `State ∈ {0,1,2,50,100,5?}` maps onto the V1 lifecycle; `NazarModir ∈ {تایید, رد, نیاز به اصلاح}` maps onto the V1 decision. Unmapped values must fail loudly, not default. | §11, §12 |
| **Approval-evidence preservation** | `TarikhTaedModir` (approval date) and the approver identity must be carried onto the migrated BOM's decision fields. | §12.1 |
| **Item-level `state` / `NazarModir`** | present on items but with **no writer in the source** — a migration must decide whether to copy them or treat them as unknown, and must **record the choice**. | §11.4, §12.4 |

### 22.2 Rules the future migration must follow `[DERIVED]`

1. **Preserve original identifiers.** Never derive a new business code; never normalise
   `CodeStandardDarSanat`.
2. **Preserve unknown values verbatim**, in a dedicated raw column, rather than dropping them — the
   source has fields with no known writer (§11.4, §14.2), and their values are the only evidence of
   what the business meant.
3. **Never invent a header for an orphan item.** An item whose `BomAddRelated` does not resolve is a
   data-quality finding to report, not a row to guess about.
4. **Do not migrate SharePoint's own columns** (§5.1), except as evidence in the mapping table.
5. **A migration is not an implementation phase**: the ERP tables must exist and be understood before
   a single row is written.

### 22.3 What cannot be migrated at all `[OPEN]`

- The **SharePoint approval workflow definition** — not supplied. Its absence is why §11.4 lists "who
  writes `State = 2 / 50 / 100`" as an open question: a migration can carry the *observed* states, it
  cannot reconstruct the *machine* that produced them.
- The **tree-picker popup** (`SitePages/Test_WP.aspx`) and the overlay / tab-hiding behaviour — UI
  plumbing, replaced by an ERP selector.

---


## 23. V1 SCOPE

**Classification:** `REQUIRED` · `OPTIONAL` · `DEFERRED` · `BLOCKED BY CONTRACT`.

### 23.1 BOM header

| Element | Class | Note |
| --- | --- | --- |
| `title` («عنوان درخواست») | REQUIRED | source has it; `BomEdit` composes it |
| `projectRef` + `projectCodeSnapshot` | **BLOCKED BY CONTRACT** | the Project domain does not exist (§7.2, §25) |
| `productTreeRef` + `productTreeCodeSnapshot` | **BLOCKED BY CONTRACT** | the Product Tree domain does not exist (§8.2, §25) |
| `requesterUserId` | REQUIRED | via `USER_DIRECTORY` |
| `requesterManagerUserId` (the approver) | REQUIRED | via `USER_DIRECTORY` |
| `requestDate` | REQUIRED | source defaults to today |
| `status` + `nextStatus` | REQUIRED | the V1 guarded state machine (§12.3, §11) |
| `managerOpinion` / `comments` / `managerDecidedAt` / `decidedByUserId` | REQUIRED | the approval decision (§12) |
| `projectStateSnapshot` (the source's `c_Vazeyat`) | OPTIONAL | a read-through display value the source never stores on the BOM |

### 23.2 BOM items

| Element | Class | Note |
| --- | --- | --- |
| `partName`, `partNameInIndustry` | REQUIRED | §5.3 |
| `standardPartCode` (generated + uniqueness-checked) | REQUIRED | §13 |
| `partTypeInProject` (`ساختی`/`استاندارد`) | REQUIRED | source requires it |
| `partSpecifications`, `manufacturer` | OPTIONAL | source does not require them |
| `material`, `unitOfMeasure` | REQUIRED | V14 / V15 |
| `consumptionCoefficientInDrawing`, `consumptionCoefficientSpareTest` | REQUIRED | V16 / V17, §14 |
| `hasControlPlan` (`دارد`/`ندارد`) | REQUIRED | source writes it; §16 |
| `partCode` (`Code_Ghatae`) | **BLOCKED BY CONTRACT** | no writer in the source; semantics unknown (§5.3, §26 D-2) |
| `totalConsumptionCoefficient` + the four on-order/purchased projections | DEFERRED | derived by an external process (§14.2) |
| `suggestedSupplier` / `suggestedSupplierPrice` / `itemComments` | DEFERRED | no writer in the source; §15 |
| item-level `state` / `NazarModir` | DEFERRED | no writer in the source (§11.4, §12.4) |

### 23.3 Behaviour

| Element | Class | Note |
| --- | --- | --- |
| validation V1–V19 (server-side) | REQUIRED | §10 |
| "submit requires ≥ 1 item" (V8) | REQUIRED | §10.2 |
| duplicate part-name-in-project rule (V12/V21/V22) | REQUIRED | §13.1 |
| duplicate standard-code rule (V19) | REQUIRED | §13.2 — service layer only, no DB constraint (§13.5) |
| standard-code generation | REQUIRED, **BLOCKED BY CONTRACT** for its base value | the base is the product tree's code (§13.4) |
| manager approval (single step, three outcomes) | REQUIRED | §12.3 — Production-owned state machine |
| lifecycle visibility rules (§11.3) | REQUIRED | the API must be read-only outside draft |
| tenant authorization → 404/403 across tenants | REQUIRED | §17.4 |
| audit of every mutation + the decision | REQUIRED | §18.2 |
| list + search / filter / paging | REQUIRED | the module's own page-size pair (§18.4) |
| notification "awaiting your decision" | OPTIONAL | §18.3 |
| Global Search participation | OPTIONAL (contract EXISTS) | §18.1 |
| the «بررسی کد استاندارد قطعه» bulk renumber tool (§10.7) | DEFERRED | must be re-designed as an audited action, not copied |
| the legacy bulk hard-delete (V27) | **REJECTED** | replaced by a lifecycle transition + audit (§24 T-4) |
| BOM change request (`BomEdit`) | DEFERRED | a second capability (§5.4) |
| versioning (options B / C of §21.2) | DEFERRED | §21 |
| Purchase integration | DEFERRED | §20 |
| Part / Material catalogue | DEFERRED | §9.2 |
| Quality module | DEFERRED | §16 |

### 23.4 The smallest usable V1, in one sentence

> A tenant can create a BOM against a project and a product tree, add items carrying the source's
> required part fields and the two consumption coefficients, be refused a duplicate name or a
> duplicate standard code, submit it, and have the chosen manager approve, return it for correction
> or reject it — with every step audited and every read tenant-scoped.

### 23.5 Where V1 lands (design intent only — NOT built)

- `apps/api/src/modules/production/**` — controller(s), service(s), repository(ies), DTOs, a
  `production.constants.ts`, a `production-actor.ts`, a `production-audit.gateway.ts`.
- `apps/api/prisma/production/schema.prisma` + `migrations/**` — a **separate database boundary**, as
  Commerce and HR have. This is a design intent, `[DECISION REQUIRED]` (§26 D-5).
- Core migrations: module registration, feature + grants, the `PRODUCTION` permission domain and the
  permission strings (§17.2, §17.3).
- Web: the routes in §19.2.

**None of this is created by this phase.**

---


## 24. SECURITY / THREAT MODEL

Each threat is paired with a mitigation and the **layer that owns it**. The layer names are the ones
this repository already uses: `platform`, `module (Production)`, `database`, `frontend`.

| # | Threat | Why it is real here | Mitigation | Owning layer |
| --- | --- | --- | --- | --- |
| **T-1** | **Cross-tenant BOM access (read)** | the source is a single SharePoint site with no tenant concept; the ERP is multi-tenant | every read is scoped by `actor.tenantId` resolved from the request context (never from a request field); a foreign id resolves to **404**, not to "found but forbidden" and never to a row | module + platform (tenant resolver) |
| **T-2** | **Unauthorized edit** | the source gates editing by `State == 0` plus hard-coded names (V25–V27) | editing requires `production.bom.manage` **and** `status = DRAFT` **and** a `(tenantId, id)` resolve; the state guard is a server rule, not a UI guard | module + platform (RBAC) |
| **T-3** | **Unauthorized approval** | the source relies on a SharePoint task assigned to a person | approval requires `production.bom.approve`, a same-tenant row, and (per Ariya's choice, §26 D-4) either the resolved approver identity or the permission | module + platform (RBAC) |
| **T-4** | **Destructive bulk delete** | the source lets three named users hard-delete *every* rejected BOM with one confirm (V27) | **rejected**: retirement becomes an explicit, permission-gated, audited transition; no bulk destructive endpoint is created; the ERPs' audit trail is the record | module (design decision) |
| **T-5** | **Project-access leakage / stale project reference** | no Project domain exists, so a `projectRef` cannot be validated against the tenant (§7.4) | V1 treats the reference as opaque and tenant-validated **only**; the requirement is recorded as a blocking contract (§25). Until then, a BOM may reference a project id whose tenant cannot be proven — a **known limitation** | platform (missing contract) |
| **T-6** | **Product-tree leakage** | same as T-5 for `productTreeRef`; additionally the tree's `code` is copied into the BOM | identical mitigation and identical limitation; the snapshot is stored only for display/generation evidence | platform (missing contract) |
| **T-7** | **Supplier / price data leakage** | `suggestedSupplier` / `suggestedSupplierPrice` are commercial data reaching a Production screen through `USER_DIRECTORY`-independent reads | they are BOM metadata read only through the BOM's own tenant-scoped read; no cross-module reach; §15 keeps them out of Procurement's authority | module |
| **T-8** | **Duplicate-code collision** | the source's uniqueness check is scope-dependent and has no DB constraint (§13) | V1 enforces the rule in the service inside a transaction and records the intended invariant (§13.5); a DB constraint is deferred until the scope questions are answered | module, then database |
| **T-9** | **Stale reference handling** | project / tree / user references can point at rows that no longer exist | references are opaque ids; a read that cannot resolve a person degrades to the port's "unknown person" projection rather than failing; a missing project/tree is surfaced as such | module (+ platform ports) |
| **T-10** | **Deleted-user handling** | the source's employee list can lose a row while a BOM still names it | the BOM stores only an id; the `USER_DIRECTORY` port answers "not a member / unknown" without breaking the BOM; the approval record's `decidedByUserId` is immutable evidence | platform (`USER_DIRECTORY`) |
| **T-11** | **An outdated BOM exposed to a future Purchase integration** | the source reads live BOM item rows at purchase time (§20.1), so a purchase can be created against data that then changes (§21.4) | Procurement→Production dependency direction fixed (§20.3); immutability-at-consumption flagged as a mandatory future decision (§21.4); the audit trail is kept complete so history is reconstructable | both (flagged, unsolved) |
| **T-12** | **Client-side validation trusted as the rule** | the source's duplicate and required checks live in the browser (V11–V22) | the ERP re-implements every business rule server-side; the client is an affordance only (§19.3) | module |
| **T-13** | **Identity-by-name authorization** | the source gates actions on three literal Persian names and a SharePoint group (V25–V27) | explicitly rejected; Ariya authorizes by permission (§17.5) | module + platform |
| **T-14** | **Un-audited mass renumbering** | the source's §10.7 tool rewrites standard codes with no audit | the equivalent action, if built, is permission-gated and audited per row; deferred from V1 | module + platform (audit) |

### 24.1 The one asymmetry worth stating

`T-5` and `T-6` are **structural**, not incidental: they exist because the ERP has neither a Project
nor a Product-Tree domain. They cannot be mitigated by clever code; they can only be mitigated by
creating those contracts (§25). V1 ships with them **documented and visible** rather than hidden.

---


## 25. CONTRACT GATES

Classification: `EXISTS` · `NEEDS EXTENSION` · `NEW CONTRACT` · `NOT REQUIRED FOR V1` · `BLOCKED`.

| # | Gate | Class | Evidence / reasoning | What must happen before implementation |
| --- | --- | --- | --- | --- |
| G-1 | **Production module boundary** | `NEW CONTRACT` (declaration only) | a module id + feature slug + constants file, mirroring `commerce.constants.ts`; the platform registry already supports it | declare `PRODUCTION_MODULE_ID = 'production'`, `PRODUCTION_FEATURE = { BOM: 'bom' }`, and the audit-resource vocabulary |
| G-2 | **BOM domain contract** | `NEW CONTRACT` | this document *is* the discovery half; §5–§14 fix the fields, rules and lifecycle | Ariya signs off on §5 (names), §6 (header/item split), §11/§12 (lifecycle + approval), §13 (uniqueness) |
| G-3 | **Project reference contract** | **`BLOCKED`** | no Project model exists in any schema (§7.2) | either an authoritative Project domain is created, or Ariya explicitly accepts an **unvalidated opaque reference** for V1 (§7.4, T-5) |
| G-4 | **Product Tree contract** | **`BLOCKED`** | no Product Tree model exists (§8.2), and the tree's `code` is the **base of the standard part code** (§13.4) | same decision as G-3; additionally Ariya must state the code-generation rule (§13.4) |
| G-5 | **Part / Material contract** | `NOT REQUIRED FOR V1` | the source keeps part data on the item and defines no catalogue (§9) | V1 must avoid constraints that would block a later catalogue (§13.5) |
| G-6 | **Workflow / approval contract** | `NEEDS EXTENSION` | no platform workflow exists; Commerce's engine is Commerce-owned with a closed subject enum; HR has two bespoke engines (§12.2) | V1 uses a Production-owned guarded state machine (§12.3); a platform Workflow extraction is a later, separate phase |
| G-7 | **Permission contract** | `NEEDS EXTENSION` | RBAC, `PermissionDomain` and the grant-migration pattern exist; `PRODUCTION` and the strings do not (§17.2/§17.3) | add the `PRODUCTION` domain member in its **own** migration, then the permission rows (the `55P04` lesson) |
| G-8 | **Tenant scope contract** | `EXISTS` | `Tenant` + `RequestContextService` + `tenant-resolver.contract.ts` + the actor pattern (§17.1) | reuse verbatim; fail closed when no tenant resolves |
| G-9 | **Entitlement contract** | `EXISTS` | `ENTITLEMENT_PORT`, `RequiresModule` / `RequiresFeature`, `PlatformEntitlementService` | add the registration + feature + grant seed migrations |
| G-10 | **Search contract** | `EXISTS` | `SEARCH_SOURCE_PORT`, `EXTERNAL` + the `sourceKey` grammar (§18.1) | only if/when global-search participation is wanted (OPTIONAL in V1) |
| G-11 | **Audit contract** | `EXISTS` | `AUDIT_PORT.record` / `.read`, envelope construction in a gateway (§18.2) | add the Production audit gateway + resource vocabulary |
| G-12 | **Notification contract** | `EXISTS` | `NotificationPublisher` + `NotificationService.createForUser` (§18.3) | OPTIONAL in V1 |
| G-13 | **Identity / directory contract** | `EXISTS` | `USER_DIRECTORY` + `CoreUserDirectoryAdapter` (§18.5) | reuse for requester/approver projections |
| G-14 | **Ordering / paging contract** | `EXISTS` (convention) | the Commerce/HR page-size pairs (§18.4) | declare Production's own two constants |
| G-15 | **Future Purchase consumption contract** | `NOT REQUIRED FOR V1` | §20 — deliberately deferred | a later phase must fix snapshot/pinning/quantity/supplier/pricing and immutability-at-consumption (§21.4) |
| G-16 | **Quality / control-plan contract** | `NOT REQUIRED FOR V1` | §16 — a two-value indicator today | a future Quality context must be able to attach without changing the BOM's identity |
| G-17 | **Database boundary for Production** | `DECISION REQUIRED` | Commerce and HR each own a separate Prisma schema/database; Core owns the rest | Ariya must decide whether `production_db` is a separate boundary or part of an existing one (§26 D-5) |

### 25.1 The three gates that actually block V1

`G-3` (Project), `G-4` (Product Tree) and, behind them, `G-2` (the signed-off BOM contract).
Everything else either already exists or is a declaration the Production module makes itself.

---


## 26. OPEN DECISIONS

Each item is a question the **source does not answer**, so this document does not answer it either.
Owner = who must decide.

| # | Question | Why it is open (evidence) | Owner | Impact |
| --- | --- | --- | --- | --- |
| **D-1** | What is «کد استاندارد قطعه» the identity **of**? | the uniqueness rule is scoped to project + product tree (§13.2), yet the label says "standard code" | Ariya (business) + architecture | decides whether a Part catalogue exists (§9.2) and the final unique key (§13.5) |
| **D-2** | What distinguishes `Code_Ghatae` («کد قطعه») from `CodeStandardDarSanat` («کد استاندارد قطعه»)? | both exist; only the latter has a writer in the source | Ariya (business) | whether `partCode` is a V1 field at all (§23.2) |
| **D-3** | What is `State == 5`? | appears once in an `EnabledFormula`, never written (§11.4) | Ariya (business) | whether the lifecycle has a fifth state |
| **D-4** | Who may approve — only the resolved manager, or anyone holding `production.bom.approve`? | the source allows the assigned manager only; the ERP's permission model is role-based (§17.3) | Ariya (security/product) | the approval guard (§17.4, T-3) |
| **D-5** | Is Production a separate database boundary (`production_db`) or part of an existing one? | Commerce and HR are separate; Core holds the rest | architecture | schema, migrations and the cross-context story (§23.5, G-17) |
| **D-6** | Is the standard part code immutable once assigned? | the source overwrites codes in two places (§13.6) | Ariya (business) | code generation, the maintenance tool, migration rules |
| **D-7** | Code generation: **max-in-scope** or **last-in-list**? | the two source implementations disagree (§13.4) | Ariya (business) + architecture | the single rule to implement |
| **D-8** | Exact meaning and formula of `ZaribMasraf_KoleGhatae` (total) and of the four on-order / purchased coefficients | never written or computed in the supplied forms (§14.2) | Ariya (business) | whether the field is derived, stored, or absent in V1 |
| **D-9** | Coefficient data type and precision; is `0` allowed? | only integers appear; the source forbids empty and (later) negative (§14.4) | Ariya (business) | column type, validation, rounding |
| **D-10** | Are the item's `state` and `NazarModir` real fields with a writer outside the supplied forms? | present in projections, never written by the supplied forms (§11.4, §12.4) | Ariya (business) + SharePoint owner | whether V1 models an item lifecycle at all |
| **D-11** | Is the BOM change request (`BomEdit`) in V1 scope, and are there change types other than `تغییر موجودی`? | only one change type is written in source (§5.4) | Ariya (business) | V1 scope (§23.3) |
| **D-12** | Does `TaminKonandePishnahadi_BOM` hold a supplier-list id or free text? | a projection cannot distinguish them (§15.3) | Ariya (business) | migration mapping and any future supplier contract |
| **D-13** | Is SharePoint→ERP migration in scope, and when? | this phase migrates nothing (§22) | Ariya (product) | sequencing; the mapping table in §22.1 must exist before any row moves |
| **D-14** | Does a BOM need per-item approval, or is the header's decision sufficient? | the source's item queries assume the header's decision applies to items (§12.4) | Ariya (business) | the approval model and any future Purchase consumption |
| **D-15** | Should the "renumber standard codes for a tree" maintenance action exist in Ariya at all? | it exists in the source as an unaudited mass update (§10.7) | Ariya (product) + architecture | whether a guarded, audited equivalent is built (§23.3) |

**No decision above is made by this document.** Where a recommendation appears (always marked
`RECOMMENDED`), it is a proposal for Ariya to accept, reject or amend.

---


## 27. NON-GOALS

This phase did **not** — and V1's first implementation must **not**:

1. **Create any database table, Prisma model or migration.** No `production` schema, no BOM tables —
   this document is prose only. `[CONFIRMED — git status]`
2. **Create any API route, controller, DTO or service.**
3. **Build any frontend screen, route, component or label file.**
4. **Connect BOM to Purchase** in any direction (§20.4).
5. **Write, read or modify anything in Commerce** — no Commerce controller, service, workflow engine,
   `WorkflowSubjectType` or migration was touched. `[CONFIRMED]`
6. **Copy SharePoint code or its architecture.** Every mechanism the source uses to work *inside*
   SharePoint (client-side duplicate probes, hidden `Author`-toggling counters, `LoadRecords` filter
   queries, tab hiding, the overlay/popup tree picker, `SaveAndExit` choreography) is classified as a
   **LEGACY IMPLEMENTATION DETAIL** and is **not** reproduced (§10.4, §10.5, §10.7, §22.3).
7. **Migrate any data** (§22).
8. **Create an approval engine** — no third engine, no reuse of Commerce's engine, no changes to HR's
   engines (§12.2/§12.3).
9. **Invent** a Project model, a Product Tree model, a Part/Material catalogue, a Supplier model, a
   versioning scheme, a formula, a permission name, an authorization rule or a Purchase integration
   (§26 lists what is open instead).
10. **Preserve any SharePoint username or group** as an Ariya authorization rule (V25–V27, §17.5).
11. **Reintroduce the destructive bulk delete** (V27, §24 T-4).

---

## 28. FINAL RECOMMENDATION

### 28.1 The recommendation, in six statements

1. **Own BOM in `production` (`تولید`), as the `bom` feature.** The subject is a production artefact,
   its approval is an organisational (manager) approval, and keeping it out of Procurement is what
   allows production capabilities to exist without procurement being entitled (§3).
2. **Model BOM as header + items.** The source stores them in two lists joined by `BomAddRelated`;
   the ERP must not flatten them (§6).
3. **Keep Project and Product Tree as opaque references, and treat their absence as a blocked
   contract — not as an opportunity to invent a subsystem** (§7, §8, §25 G-3/G-4).
4. **Reproduce the source's behaviour exactly, and nothing more:** the required fields and validations
   it enforces (V1–V19), the "no items → no submit" rule (V8), the two duplicate rules with their
   **different** scopes (§13.1/§13.2), the generated standard code (§13.4), and the single-manager
   approval with three outcomes (`تایید`, `نیاز به اصلاح`, `رد`) (§12).
5. **Reuse every existing platform contract** — tenant resolution, entitlement, RBAC, audit,
   notification, search, identity, paging — and **add none** beyond the module declaration, the
   permission strings and the audit vocabulary (§17, §18, §25).
6. **Ship a Production-owned guarded lifecycle in V1, and leave the platform Workflow question
   open** (§11.5, §12.3, §25 G-6). Do not build a third approval engine; do not reach into
   Commerce's.

### 28.2 The recommended first implementation step (not this phase)

```
Step V1-0 (preflight sign-off):
  D-1 … D-9, D-11, D-14 answered                    → G-2 signed off
  G-3 / G-4 resolved (a Project and Product Tree contract, or an explicitly accepted limitation)
Step V1-1 onward:
  module declaration → Core migrations (permission domain, permissions, registration, feature)
  → Production schema + migration → service-level validation/lifecycle → HTTP surface → UI
```

### 28.3 The risk this recommendation accepts, stated plainly

V1 cannot verify that a referenced project or product tree belongs to the caller's tenant, because
neither domain exists (§7.4, §24 T-5). The recommendation is to **accept this explicitly and
visibly** for V1 — with the reference opaque and tenant-scoped — rather than to stall, or to invent a
Project subsystem inside Production. This is the smallest honest risk, and it is reversible: when the
authoritative contracts arrive, the reference is re-pointed and the snapshots become migration
evidence.

### 28.4 What would make this recommendation wrong

- If Ariya decides that a **part** is a first-class catalogue entity (§26 D-1) owned by a *different*
  module, then the BOM item becomes a reference and the V1 item model narrows.
- If Ariya decides BOM **must** be versioned from day one (§21.2 B/C), then the item model changes
  before it is written.
- If the Project / Product-Tree domains are themselves owned by **Production**, then §8's
  "reference only" stance must be revisited and BOM would reference a Production-owned aggregate
  instead of an opaque id.

Each of these is a business decision this document deliberately leaves open.

---


## FILES CHANGED BY THIS PHASE

**Created (the only new artifact):**

- `docs/PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md` — this document.

**Modified:** none. No `apps/api/**`, `apps/web/**`, `apps/api/prisma/**`, Commerce, HR,
Correspondence, CMS or observability file was touched. No migration was created. No route, permission
or schema was added.

**Scratch (git-ignored via `*.tmp`, and deleted at the end of the phase):** the extraction scripts and
intermediate text dumps under `.tmp/`.

## SOURCE FILES READ (outside the repository)

`E:\Very Mohem\BomAdd.txt`, `BomEdit.txt`, `Kartable Bomadd.txt`, `kartable bomEdit.txt` (read in
full); `kharid.txt` and `kartabl karid.txt` (read for the Purchase boundary only);
`sooderCheck.txt`, `kartabl SoderCheck.txt` (inventoried, out of scope).

**Repository files inspected (read-only):**
`apps/api/prisma/{core,commerce,hr,correspondence,cms,observability}/schema.prisma`;
the Core permission / registration / feature seed migrations for Commerce and HR;
`apps/api/src/platform/{audit,auth,entitlement,search-source,user-directory}/**`;
`apps/api/src/modules/commerce/{commerce.constants.ts, commerce-actor.ts, commerce-audit.gateway.ts,
commerce-notification.gateway.ts, commerce.module.ts}`; `apps/api/src/modules/hr/**` (approval
engines); `apps/api/src/rules/**`; `apps/api/src/preferences/nav-catalogue.ts`;
`apps/web/src/{app,lib,components}/**`; `docs/PHASE-P-SEARCH-SOURCE-CONTRACT.md`,
`docs/PHASE-P-AUDIT-READ-CONTRACT.md`, `docs/PHASE-C1-COMMERCE-BOUNDED-CONTEXT-PROMPT.md`.

## CHECKS PERFORMED

| Check | Result |
| --- | --- |
| `git status --short` (before and after) | **identical**: only the pre-existing untracked `apps/web/*` QA artifacts and `backups/` |
| `git log --oneline` | HEAD `840226b` — unchanged, no commit made |
| Every Prisma schema searched for `Project` / `Product` / `Part` / `Bom` / `Material` / `Supplier` / `Vendor` / `Warehouse` / `Item` models | **zero models** — the finding behind §7.2 / §8.2 |
| SharePoint XML parsed mechanically (every `Control`, `ValueChangeScript`, `LoadCompletedScript`, `ListQuery` and action script) | 133 controls in `BomAdd`, 87 in `BomEdit`, 136 in the approval task, 107 in the change-approval task |
| All `SaveRecord` / `DeleteRecord` call sites enumerated | used to build §2.2 and §20.1 |
| Field-name write sites searched for every "no writer" claim in §5.3 / §14.2 / §15.1 | confirmed: those fields appear **only** in read projections (`Attributes=…`) |
| `AUDIT_PORT` / `SearchSourcePort` / `EntitlementPort` / `WorkflowSubjectType` inspected | contracts confirmed; the closed workflow subject enum confirmed (§11.5) |
| `.tmp/` scratch confirmed git-ignored (`check-ignore`) | ignored via `*.tmp` |

## BLOCKERS

1. **`G-3` — no authoritative Project domain.** BOM cannot validate a project reference against a
   tenant. **Blocks the project reference contract.**
2. **`G-4` — no authoritative Product Tree domain.** The tree's `code` is the base of the standard
   part code, so code generation is blocked too. **Blocks the tree reference and §13.4.**
3. **The SharePoint approval workflow definition was not supplied.** `State = 2 / 50 / 100` and the
   item-level `state` have no writer in the supplied material (§11.4). This **blocks an exact state
   migration**, not the V1 lifecycle model (§12.3), which the forms' own behaviour fully supports.
4. **`D-1` / `D-2` unanswered** — whether a Part catalogue exists, and what separates `Code_Ghatae`
   from `CodeStandardDarSanat`. **Blocks the final uniqueness key** (§13.5) and one V1 field.

---

**END OF DOCUMENT —** `PREFLIGHT COMPLETE — NO IMPLEMENTATION PERFORMED`
