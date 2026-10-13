# PHASE FINANCIAL — «درخواست صدور چک» PREFLIGHT / CONTRACT DISCOVERY

**Status:** `PREFLIGHT ONLY — NO IMPLEMENTATION. No schema, no migration, no route, no UI, no
permission, no Purchase integration.`

**Module (candidate):** `financial` / «مالی»
**Initial capability (candidate):** `check-request` / «درخواست صدور چک»

**Classification tags used throughout:** `[CONFIRMED]` (read directly in source),
`[DERIVED]` (logically follows from confirmed source), `[OPEN]` (a business decision the
source does not answer), `[DECISION REQUIRED]` (an architecture choice Ariya must make
before implementation), `[NOT ESTABLISHED]` (proven absent from source).

**Git baseline:** HEAD `5f896f1beba07dd313bd5819ce2317c73ecd3896`, branch `master`
(2026-10-03). Nothing was committed, reset, cleaned, checked out or reverted by this phase.

**THE ONLY NEW ARTIFACT OF THIS PHASE IS THIS DOCUMENT.** No file under `apps/api/**`,
`apps/web/**`, `apps/api/prisma/**` or any other `docs/` file was modified. The SharePoint
sources were read from outside the repository (`E:\Very Mohem\`), extraction scratch files
were written to `.tmp/fin-preflight/` (git-ignored) and were **deleted at the end of the
phase**.

---

## 1. Executive Summary

1. **No Financial bounded context exists.** There is no `financial` / `finance` module,
   datasource, schema, migration, client, route, permission catalogue entry or UI anywhere
   in the repository. `[CONFIRMED — §2]`
2. **The authoritative source is the legacy SharePoint pair** «درخواست صدور چک»:
   `E:\Very Mohem\sooderCheck.txt` (request form) and
   `E:\Very Mohem\kartabl SoderCheck.txt` (workflow task form). The brief names the source
   `Pasted text(3).txt`; no such file exists on the machine or in the repo — the mapping
   follows `PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md` §2.1, which already identifies
   exactly these two files as the cheque/order forms. `[CONFIRMED — §3]`
3. **The source is a 10-value stage ordinal workflow** (`state` = `0,1,2,3,4,5,6,7`, plus
   `50` termination and a terminal ≥8), driven by two forms — **not** a generic workflow
   engine. Commerce's `WorkflowInstance` engine is closed to `PURCHASE_DOCUMENT` /
   `PURCHASE_LINE` subjects and must not be stretched to host it. `[CONFIRMED — §7]`
4. **Six approval stages** exist: تایید مدیر → صدور فرم تخصیص → بررسی اسناد → تایید ریاست →
   صدور چک کارشناس مالی → دریافت رسید تحویل, with fixed source vocabularies
   (`بله/خیر/نیازمند اصلاح است`, `تایید/اصلاح`, `تایید/رد/نیازمند اصلاح`). `[CONFIRMED — §8]`
5. **The source has NO cheque-identity data.** No cheque number, bank, account, صیادی id,
   series, signer, issue date, due date or beneficiary field exists in either file. The
   only issuance facts are *an image attachment* and *a confirmation checkbox*. §10 lists
   all of it as `NOT ESTABLISHED`. `[CONFIRMED — §10]`
6. **Attachments are section-scoped to the request** through the SharePoint list
   «پیوست ها» keyed by `IdSodoorCheck` + `Section`: `2` = request-stage documents,
   `6` = cheque image, `7` = delivery receipt. Ariya has **no generic attachment table**;
   Financial must own its rows over the existing `IStorageProvider` port. `[CONFIRMED — §9]`
7. **Purchase connection is a read-only lookup at request creation**: the form loads the
   purchase order by id, reads `NameProjeKala` (project) and snapshots the project name
   into the title. §18 records this as a **Future Contract Requirement** only. `[CONFIRMED — §18]`
8. **Legacy person names are hard-coded in the workflow** (`آقای جلیلی`, `آقای مرتضوی`,
   `آقای دکتر انفرادی`, `خانم نداف` as `ArjaBe`). Evidence of role separation, **not**
   something to port. `[CONFIRMED — §8, §17]`
9. **First implementation increment (§23):** Financial bounded-context foundation plus the
   request lifecycle `0 → 1 → 2` (draft, submit, manager decision with the three source
   opinions, correction return, termination `50`) with request-stage attachments —
   deliberately without allocation, issuance, delivery and without Purchase integration.

---

## 2. Repository Preflight

Every claim below is a repository read; nothing is inferred from a file name.

### 2.1 Bounded contexts that exist today

| Context | Module dir | Prisma project | Datasource | Migrations | Client |
| --- | --- | --- | --- | --- | --- |
| Core | `src/platform/**`, `src/auth/**` | `prisma/core/schema.prisma` | `CORE_DATABASE_URL` | `prisma/core/migrations` | `core-client` |
| CMS | `src/modules/cms` | `prisma/cms/schema.prisma` | `CMS_DATABASE_URL` | own | `cms-client` |
| Correspondence | `src/modules/correspondence` | `prisma/correspondence/schema.prisma` | `CORRESPONDENCE_DATABASE_URL` | own | own |
| HR | `src/modules/hr` | `prisma/hr/schema.prisma` | `HR_DATABASE_URL` | own | `hr-client` |
| Commerce | `src/modules/commerce/{purchase,workflow,commercial,payment,receiving,returns,pending,search,completion}` | `prisma/commerce/schema.prisma` | `COMMERCE_DATABASE_URL` | `prisma/commerce/migrations` (13, through `20261001000000_purchase_completion_policy`) | `commerce-client` |
| Production | `src/modules/production/{bom,bom-change}` | `prisma/production/schema.prisma` | `PRODUCTION_DATABASE_URL` | `prisma/production/migrations` | `production-client` |
| Observability | `src/observability` | `prisma/observability/schema.prisma` | `OBSERVABILITY_DATABASE_URL` | own | own |

**Financial: absent.** `runtime-datasources.ts:43-51` declares exactly seven datasources
(`CORE, CMS, OBSERVABILITY, CORRESPONDENCE, HR, COMMERCE, PRODUCTION`); `apps/api/prisma`
contains exactly `cms, commerce, core, correspondence, hr, migrations, observability,
production`. No `financial` directory, module, schema, client, route or migration exists.
`[CONFIRMED]`

### 2.2 Cheque / Check / Treasury / Payment-request precedents

| Sweep | Result |
| --- | --- |
| `model (Project\|Supplier\|Bank\|Account\|Cheque\|Check)` across **all 8** `schema.prisma` files | **0 hits** `[CONFIRMED]` |
| `NoeaSodoorCheck \| IdShomareSefaresh \| B_NazarModir \| Riyast \| KhatemeSodoorCheck` across the repo | **0 hits** `[CONFIRMED]` |
| Cheque UI in `apps/web/src` (`صدور چک`, `چک صادر`) | **0 hits** `[CONFIRMED]` |
| Cheque-adjacent data that DOES exist | `PaymentMethod = CASH \| PETTY_CASH \| CHECK` in `commerce_db` (payment *method* on an append-only `PaymentRecord`, not a cheque instrument); Persian labels `نقد/تنخواه/چک` in `apps/web/src/lib/commerce-labels.ts:205-207` `[CONFIRMED]` |
| Existing contracts that explicitly REFUSE cheque/bank models | `docs/PHASE-C1-S-RETURN-FOUNDATION-CONTRACT.md:519`; `docs/PHASE-C1-Q-PAYMENT-HISTORY-CONTRACT.md:30,99,294,353` `[CONFIRMED]` |
| Docs that pre-name this phase | `PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md:65-66` records both cheque source files as "not used (out of scope)" `[CONFIRMED]` |

**Conclusion:** cheque issuance is greenfield; the two source files are the only
specification that exists. `[DERIVED]`

### 2.3 Reusable platform contracts (verified to exist)

| Need | Contract in repo | Evidence |
| --- | --- | --- |
| Module entitlement | `@RequiresModule(...)` + `ModuleEntitlementGuard`, module ids declared in `*.constants.ts` (`COMMERCE_MODULE_ID`, `PRODUCTION_MODULE_ID`); registry rows seeded by Core migrations | `modules/commerce/commerce.constants.ts:35`, `modules/production/production.constants.ts:29`, `prisma/core/migrations/20260926100100_seed_commerce_permission_grants`, `20261002100100_seed_production_permission_grants` |
| RBAC / permissions | `Permissions` catalogue (`auth/rbac/constants/permissions.ts`), per-module strings seeded `commerce.read/manage/approve`; Production's `production.bom.{read,manage,approve}` pattern | `permissions.ts:7+`, both seed migrations |
| Audit | `platform.audit@v1` port (`AUDIT_PORT`), single trail `core_db."AuditLog"` (`resourceType/resourceId/action/oldValue/newValue/changedFields/tenantId/userId`), `PlatformAuditService` read side, per-module audit resource constants + gateway (`CommerceAuditGateway`, Production's equivalent) | `platform/audit/audit.contract.ts:29-35`, `prisma/core/schema.prisma` `model AuditLog`, `modules/commerce/commerce.constants.ts` (audit resource map) |
| Identity | `platform/user-directory` contract (opaque user resolution, no cross-db join) | `platform/user-directory/user-directory.contract.ts` |
| Cross-context references | ADR-0005 + ADR-0006: no cross-database FK; opaque string refs (`tenantId`, `userId`, `projectRef`, `requesterId`, `approverId`) | `docs/ADR/ADR-0005…`, `docs/ADR/ADR-0006…`, commerce/production schema headers |
| Object storage (files) | `IStorageProvider` (`upload/getUrl/delete`, signed short-lived URLs) over MinIO; per-module tables own their attachment rows (`MessageAttachment`, `TicketAttachment`, `LetterAttachment` live in `core_db`) | `src/storage/i-storage.provider.ts`, `prisma/core/schema.prisma` models |
| Concurrency | Conditional transitions via `updateMany({ where: { id, tenantId, status: 'DRAFT' } })` — the predicate travels WITH the write | `modules/production/bom/bom.repository.ts:145-235` |
| Workflow engine | **Commerce-only.** `WorkflowSubjectType = PURCHASE_DOCUMENT \| PURCHASE_LINE` (closed), engine tables in `commerce_db` | `prisma/commerce/schema.prisma` enums `WorkflowSubjectType` etc.; `docs/PHASE-C1-N-WORKFLOW-EXECUTION-CONTRACT.md` |
| Pending inbox | Commerce `pending` module — an approval inbox bound to Commerce workflow instances | `src/modules/commerce/pending/**`, `docs/PHASE-C2-…PENDING-INBOX-CONTRACT.md` |

### 2.4 What Financial must NOT reuse

* Commerce's workflow engine (closed subject enum; lives in `commerce_db`). `[CONFIRMED]`
* Commerce's `PendingInbox` (bound to `WorkflowInstance`). `[CONFIRMED]`
* Any Core/CMS/HR/Commerce/Production Prisma client (ADR-0005/0006). `[CONFIRMED]`
* `PaymentRecord` as a cheque model — its contract refuses instrument fields. `[CONFIRMED]`

---

## 3. Source Inventory

### 3.1 Supplied artifacts `[CONFIRMED]`

Both were read as text end-to-end (835 and 781 lines; every `Control`, `ValueChangeScript`,
`LoadCompletedScript`, `ListQuery`, `Section`, `Tab` and action-script was parsed).

| File | Role | Read for |
| --- | --- | --- |
| `E:\Very Mohem\sooderCheck.txt` (835 lines) | **«درخواست صدور چک»** — the request form: header, attachments, requester opinion, approval sections (read-only mirror), stage-info, history | §4–§16 |
| `E:\Very Mohem\kartabl SoderCheck.txt` (781 lines) | **«کارتابل درخواست صدور چک»** — the workflow TASK form: same sections, but each stage's controls become editable for the assignee; **contains the whole state machine** | §7–§12 |

The brief names the source `Pasted text(3).txt`. **No such file exists** (searched the
repository, `.tmp/`, Downloads and the source folders). The mapping to
`sooderCheck.txt` / `kartabl SoderCheck.txt` follows the same convention
`PHASE-PRODUCTION-BOM-ARCHITECTURE-PREFLIGHT.md` §2.1 established (its `Pasted text(2).txt`
= `BomEdit.txt`), and its §2.1 already lists these two files as "Cheque/order issue
request" and "Cheque/order approval task form". `[CONFIRMED]`

### 3.2 SharePoint lists discovered `[CONFIRMED]`

| List | GUID | Role | Evidence |
| --- | --- | --- | --- |
| `درخواست صدور چک` | `{4B64998D-6C5A-4038-9267-496B09327DFE}` | **the request aggregate** (header fields of §4) | task form `ListQuery1` line 715 |
| `پیوست ها` | `{867EF6A7-FA59-49B0-9C10-A6701BF476C4}` | **attachments**, keyed `IdSodoorCheck` + `Section` | lines 770-772 / 716-718 |
| `CheckHistory` | `{5792CC29-872B-46F2-9BD3-93E867FC3740}` | **stage history rows** (`State, Title, Created, LastUser, MasterListID, ID`) | line 773 / 719 |
| `لیست کارکنان` | `{42494FBF-81CD-4E37-9F21-98D802088485}` | requester + project-manager identity (`Title`, `PersonUser`, `ID`) | lines 163-164, 311, 315 |
| `لیست پروژه ها` | `{BD9B53B8-AA77-4300-B367-4F02B30AD55C}` | project source (`Title`, `ProjectCode`, `ProjectState`) | lines 422, 481-482 |
| `درخواست کالا` | (lookup by `ID`) | **purchase order** — the `IdShomareSefaresh` source; `NameProjeKala` is read | lines 295-304 |
| `کارتابل صدور چک` | `{AF8D2267-3EBB-4CEB-B8FB-DE32A918C56D}` | referenced once as the task form's `cr_Code` lookup entity — purpose [OPEN] | line 432 |

### 3.3 Tabs & sections of the request form `[CONFIRMED]`

Tabs: `ثبت درخواست` + `سابقه گردش فرآیند`. Sections (Key → header):

| Key | Section header | Role |
| --- | --- | --- |
| 01 | درخواست صدور چک | header fields (requester, type, project, order id, manager) |
| 11 | افزودن اسناد پیوست | attachment upload/manage area |
| 08 | نظر درخواست کننده | `تایید و ادامه` / `لغو کامل گردش درخواست` |
| 02 | تایید مدیر | manager opinion + comment |
| 03 | صدور فرم تخصیص | allocation: محل تخصیص، مانده، تاریخ چک، شرح، مبلغ، در وجه |
| 04 | بررسی اسناد | document review opinion + comment |
| 05 | تایید ریاست | presidency opinion + comment |
| 06 | صدور چک کارشناس مالی | cheque image grid + «تایید چک صادر شده» checkbox |
| 07 | دریافت رسید تحویل | receipt grid + «خاتمه صدور چک» checkbox |
| — | اطلاعات مرحله | شماره فرم، شماره مرحله، وضعیت فرم، StateNext, ArjaBe, تاریخ (hidden) |
| — | (buttons) | `تایید و انتقال به مرحله بعد` / `انصراف` |
| — | سابقه فرآیند (tab 2) | history grid |

The task form has the same set with its own keys (`01` request, `02` پیوست, `09` نظر
درخواست کننده, `03` تایید مدیر, `04` تخصیص, `05` بررسی اسناد, `06` ریاست, `07` صدور چک,
`08` رسید, `اطلاعات مرحله`, buttons, `سابقه فرآیند`). `[CONFIRMED — lines 243-265]`

### 3.4 What the sources do NOT contain `[NOT ESTABLISHED]`

Searched both files: **no** `شماره چک`, `بانک`, `حساب`, `صیاد`, `سریال`, `سررسید`,
`سفته`, `شبا/IBAN` — zero hits. No cheque identity data exists in the source. §10 records
this formally.

---

## 4. Fields & Controls

Source field names are the SharePoint `TargetFieldName`/`Value_ListQueryField` values; they
are the contract for §15. `req` = request form; `task` = task form. Only `Title` carries
`IsRequired="True"` in either form (lines 205 / 271) — **every other requiredness is
script-enforced** (blocking validations in §6/§7), never a control flag. `[CONFIRMED]`

| Source field | Persian label | Control | req flags | task flags | Values / notes |
| --- | --- | --- | --- | --- | --- |
| `Title` | عنوان | TextBox | disabled, calculated, required | read-only | built by script (§5) `[205 / 271]` |
| `NoeaSodoorCheck` | نوع صدور چک | Radio | default `خرید`; disabled on edit; enabled only while `IdShomareSefaresh` empty | enabled only at state 1 for assignee | `خرید;تنخواه;حقوق` `[209 / 283]` |
| `NoeaKharid` | نوع خرید | Radio | default `پروژه ای`; visible only when type ≠ حقوق | enabled at state 1 | `پروژه ای;غیر پروژه ای` `[385 / 327]` |
| `IdShomareSefaresh` | شناسه شماره سفارش | NumberTextBox | hidden for `حقوق`/`تنخواه`; disabled; min 1, integer; enabled only when `c_id` empty | textbox at state 1 | purchase-order id; triggers the purchase lookup `[254-256, 292-304]` |
| `Project` (`c_Control4`/`cr_Control4`) | عنوان پروژه | Lookup → `لیست پروژه ها` | visible only when خرید+پروژه ای; enabled while order id empty | enabled at state 1 | auto-filled from the purchase record's `NameProjeKala` `[420-433]` |
| `CodeProject` (`c_Code`) | کد پروژه | TextBox (req) / LookupPicker (task) | read-only | read-only | from project's `ProjectCode` `[452-461, 701-705 / 430-432]` |
| `VazeyatProject` (`c_Vazeyat`) | وضعیت پروژه | TextBox (req) / LookupPicker (task) | read-only | read-only | from project's `ProjectState`; task static values `(1) بالا;(2) عادی;(3) پایین` `[444-447 / 436]` |
| `DarkhastKonande` | درخواست کننده | ComboBox → `لیست کارکنان` | auto-set to current user (`PersonUser = form.UserID()`); disabled on edit | read-only | `[122-166, 311 / 275]` |
| `TarikhDarkhast` | تاریخ درخواست | DatePicker | default `new Date()` yyyy-MM-dd; disabled | read-only | `[307 / 279]` |
| `ModireProject` | مدیر پروژه | ComboBox → `لیست کارکنان` | visible/enabled only خرید+پروژه ای | visible when non-empty | the approver identity source `[313-315 / 671]` |
| `UserModirProject` | (hidden) | PeoplePicker | hidden | hidden | the manager's **system account** (`PersonUser`), resolved at submit `[317 / 677]` |
| `NazarDarkhastKonande` | نظر درخواست کننده | Radio | default `تایید و ادامه`; disabled | enabled at state 1 | `تایید و ادامه;لغو کامل گردش درخواست` `[742 / 689]` |
| `B_NazarModir` | آیا چک صادر شود؟ | Radio | view-only (req) | enabled at state 2 | `بله;خیر;نیازمند اصلاح است` `[717 / 663]` |
| `TozihatModir` | توضیحات مدیر | TextBox multiline | view-only | enabled at state 2 | `[724 / 667]` |
| `MahaleTakhsis` | محل تخصیص | TextBox | read-only | enabled at state 3 | `[321 / 466]` |
| `MandeMojoodi` | مانده موجودی (ریال) | NumberTextBox | read-only, min 0, integer | **enabled at state 3** | user-entered at allocation — not computed `[325 / 697]` |
| `TarikhCheck` | تاریخ چک | DatePicker | read-only | enabled at state 3 | no default — user-entered `[329 / 468]` |
| `SharhCheck` | شرح چک | TextBox multiline | read-only | enabled at state 3 | `[333 / 470]` |
| `MablagheCheck` | مبلغ چک | NumberTextBox | read-only, min 0, integer | enabled at state 3 | integer, no decimals `[337 / 699]` |
| `DarVaghe` | در وجه | TextBox | read-only | enabled at state 3 | beneficiary as FREE TEXT `[341 / 472]` |
| `Takhsis` (task only) | — | TextBox | — | written by script = `تایید` | `[691]` |
| `BarasiAsnad` | نظر (بررسی اسناد) | Radio | view-only | enabled at state 4 | `تایید;اصلاح` `[345 / 478]` |
| `Tozihat` | توضیحات | TextBox multiline | view-only | enabled at state 4 | `[349 / 480]` |
| `Riyast` | نظر ریاست در خصوص صدور چک | Radio | view-only | enabled at state 5 | `تایید;رد;نیازمند اصلاح` `[353 / 486]` |
| `Tozihat0` | توضیحات ریاست | TextBox multiline | view-only | enabled at state 5 | field name is `Tozihat0` `[357 / 488]` |
| `TaedCheckSaderShode` | تایید چک صادر شده | CheckBox (`Text=تایید`) | view-only | enabled at state 6 | required before 6→7 `[361 / 496]` |
| `KhatemeSodoorCheck` | خاتمه صدور چک | CheckBox (`Text=تایید`) | view-only | enabled at state 7 | task label: «خاتمه صدور چک و بسته شدن فرآیند» `[365 / 504]` |
| `state` (`c_status`/`cr_status`) | شماره مرحله | TextBox | default `0`, disabled | read-only, drives all visibility | the stage ordinal §7 `[488 / 512]` |
| `StateNext` | (hidden) | TextBox | hidden | hidden, script-written | the transition target §7 `[757 / 707]` |
| `ArjaBe` | (hidden) | TextBox `c_NameAerja`/`cr_NameAerja` | hidden, script-set | hidden, script-set | next assignee; legacy person NAMES `[764 / 709]` |
| `Tarikh` | (hidden) | DatePicker `c_LastDate`/`cr_LastDate` | hidden, script-set today | hidden, script-set today | "last action date" `[766 / 711]` |
| `Msg` | وضعیت فرم | TextBox | script-set | — | e.g. «در حال تکمیل اطلاعات جهت ارجاع به مدیر» `[736, 484]` |
| `WorkflowItemId` (task) | — | NumberTextBox | — | hidden | links the task to the request row `[659, 715]` |
| attachments | عنوان سند / نوع سند / توضیحات | DocumentGrid columns | — | — | `ID;LinkFilename;Section;NoeaSanad;IdSodoorCheck;Tozihat` §9 |

Hidden technical controls in both forms: `ContentType`, `FileRef`, `FileLeafRef`
(lines 367-378), `c_DocID`/`cr_DocID` (attachment metadata edit target), `c_check`
(watchdog for a requester change), `c_id` (purchase-order id injected from the URL `oid=`),
`c_name`, `c_lbMode`, `c_WorkflowItemId`, `c_AssignedTo` (task assignee), `cr_Control6`
("this task is mine" flag), `cr_nextstate`. `[CONFIRMED]`

---

## 5. Check Types

### 5.1 The three issuance types and their conditional behaviour `[CONFIRMED]`

`NoeaSodoorCheck ∈ {خرید, تنخواه, حقوق}` (line 209), `NoeaKharid ∈ {پروژه ای, غیر پروژه ای}`
(line 385, default `پروژه ای`, visible only when type ≠ `حقوق`).

| Field | خرید | تنخواه | حقوق |
| --- | --- | --- | --- |
| `IdShomareSefaresh` | **visible + required** («شناسه شماره سفارش ثبت گردد!») | **hidden**, cleared on submit (`SetValue("")`) | **hidden**, cleared |
| `NoeaKharid` | visible, required | visible; `پروژه ای` requires a project | **hidden — cleared on submit** |
| `Project` | visible when `پروژه ای`; required («عنوان پروژه را انتخاب کنید!») | visible when `پروژه ای` | **cleared on submit** |
| `ModireProject` | visible when `پروژه ای`; required («مدیر پروژه انتخاب گردد!») | visible when `پروژه ای` | hidden |
| `CodeProject`, `VazeyatProject` | visible when `پروژه ای` (read-only mirrors) | same | hidden |
| title | «صدور چک برای خرید پروژه ای - {project}» / «صدور چک برای خرید غیر پروژه ای» | «صدور چک برای تنخواه {نوع خرید}[- {project}]» | «صدور چک برای حقوق» |

Evidence: visibility formulas 254, 256, 416, 420, 422, 701, 703; clearing-on-submit 58-71 of
line 484; title construction 226-253, 386-415, 423-433; task form 299-324, 337-357.
`[CONFIRMED]`

### 5.2 Title generation — exact source logic `[CONFIRMED]`

```
type == "خرید"     → "صدور چک برای خرید پروژه ای - " + projectTitle   (default)
                     "صدور چک برای خرید غیر پروژه ای"                  (when غیر پروژه ای)
type == "تنخواه"   → "صدور چک برای تنخواه پروژه ای - " + projectTitle
                     "صدور چک برای تنخواه غیر پروژه ای"
type == "حقوق"     → "صدور چک برای حقوق"
```

The project name is appended **when the purchase-order lookup returns**
(line 274: `SetValue(title + ss)` where `ss = NameProjeKala`) and again when the project
picker changes (line 429). The task form rebuilds the title only at state 1
(`if(status=="1")`, line 299). `[CONFIRMED]`

**Ariya consequence:** the title is a *stored snapshot* built from a project **name** Ariya
has no contract for. Until a Project contract exists the name must be a stored snapshot
supplied by the caller — the BOM precedent (`title` is STORED, never derived:
`prisma/production/schema.prisma:67-73`). `[DERIVED]`

### 5.3 Requester / manager resolution `[CONFIRMED]`

* `DarkhastKonande` is set from the **current user**: `form.UserID()` → employee row by
  `PersonUser` → `ID;#Title` written into the control; the plain name also lands in hidden
  `c_name` (lines 120-166, 638-654).
* `ModireProject` is picked from `لیست کارکنان` (line 315). At submit, the employee row's
  **`PersonUser`** is resolved into `UserModirProject`; empty `PersonUser` refuses with
  «یوزر مدیر پروژه در سامانه ست نشده است» (484; task form `callbackEmpID`).
* The task form verifies "this task is mine": `c_AssignedTo` vs `form.UserFullName()`; only
  then `cr_Control6 = "1"`, the flag every editable control and the action button require
  (513-540). `[CONFIRMED]`
* **No self-approval guard exists in either file.** `[CONFIRMED — absence; §20]`

### 5.4 The `c_check` watchdog `[CONFIRMED]`

`c_check` starts `"0"`; if the requester control's plain name differs from hidden `c_name`,
the change script sets `c_check = "1"` (744-756). While `c_check == "1"` the attachment grid,
metadata-save, `سند جدید` and the main action button are all disabled (383, 730, 734, 697).
Ariya equivalent: the requester is frozen after creation.

---

## 6. Initial Validation

All validations live in the two action-button scripts (request form `ثبت و ادامه` line 484;
task form `btn_True` line 655). Messages are verbatim.

### 6.1 Source-confirmed (blocking) `[CONFIRMED]`

| # | Condition | Message (verbatim) | Evidence |
| --- | --- | --- | --- |
| V1 | `NoeaSodoorCheck == ''` | «نوع صدور چک انتخاب کنید!» | 484 / 655 |
| V2 | `خرید` and `NoeaKharid == ''` | «نوع خرید را انتخاب کنید!» | 484 / 655 |
| V3 | `NoeaKharid == 'پروژه ای'` and `Project == ''` | «عنوان پروژه را انتخاب کنید!» | 484 / 655 |
| V4 | `خرید` and `IdShomareSefaresh == ''` | «شناسه شماره سفارش ثبت گردد!» | 484 / 655 |
| V5 | `پروژه ای` and `ModireProject == ''` | «مدیر پروژه انتخاب گردد!» | 484 / 655 |
| V6 | `DarkhastKonande == ''` | «درخواست کننده انتخاب گردد!» | 484 / 655 |
| V7 | manager employee record has empty `PersonUser` | «یوزر مدیر پروژه در سامانه ست نشده است» | 484 / task 22 |
| V8 | upload attempted with empty `NoeaSanad` | «نوع سند انتخاب گردد.» (upload cancelled) | 102-116 / 158-172 |
| V9 | state 3 `MahaleTakhsis == ''` | «محل تخصیص نمی تواند خالی باشد.» | 697 / 141-143 |
| V10 | state 3 `MablagheCheck == ''` | «مبلغ چک نمی تواند خالی باشد.» | 697 / 144-146 |
| V11 | state 3 `MablagheCheck > MandeMojoodi` | «مبلغ چک از مانده موجودی نمی تواند بیشتر باشد.» | **task form only** — 147-149 |
| V12 | state 4 `BarasiAsnad == ''` | «نظر اسناد مشخص نشده است» | 166-169 |
| V13 | state 5 `Riyast == ''` | «نظر ریاست مشخص نشده است» | 184-187 |
| V14 | state 6 cheque-image grid empty (`bb == 0`) | «تصویر چک صادر شده بارگذاری نشده است!» | 206-209 |
| V15 | state 6 `TaedCheckSaderShode != '1'` | «گزینه تایید چک صادر شده انتخاب نشده است!» | 210-213 |
| V16 | state 7 receipt grid empty (`cc == 0`) | «تصویر رسید تحویل بارگذاری نشده است!» | 221-225 |
| V17 | state 7 `KhatemeSodoorCheck != '1'` | «گزینه خاتمه صدور چک انتخاب نشده است!» | 226-231 |
| V18 | state 2 `B_NazarModir == ''` | «نظر مدیر مشخص نشده است» | 104-107 |

**Asymmetry:** V11 is enforced only in the task form; the request form's state-3 branch
checks V9/V10 without the amount-vs-balance rule (line 697). `[CONFIRMED]`

### 6.2 Source-suggested (warn-only) `[CONFIRMED]`

* W1 — zero attachments at st=1 submit: «کاربر گرامی سندی بارگذاری نشده است، آیا از ثبت
  اطلاعات مطمئن هستید؟» — user may proceed (task 25-29; request 697).
* W2 — zero attachments elsewhere: «آیا از ثبت اطلاعات مطمئن هستید؟».
* W3 — the `hasErr = true` branches for zero attachments are **commented out** (task 36-40,
  66-69): the source considered requiring documents and did not.

### 6.3 Not established `[NOT ESTABLISHED]`

No uniqueness rule (no one-open-request-per-order); no `amount > 0` rule (control allows
`0`); no date rule; no self-approval / separation-of-duties rule; no tenant scoping.

---

## 7. State Machine

The stage ordinal is the field **`state`** (`c_status` / `cr_status`, default `0`); every
transition writes **`StateNext`** (the target stage). `[CONFIRMED — 488/512, 757/707]`

### 7.1 The stage table

| State | Meaning (source-derived) | Entry condition | Allowed actor | Editable fields | Required at exit | Next state(s) | Terminal? | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **0** | DRAFT — requester composing the request | record created (`DefaultValue=0`) | requester | type، نوع خرید، order id، project، manager، requester opinion، attachments (section 02) | V1–V7; attachments warn | → 1; `StateNext`=2, or 3 + `B_NazarModir=بله` when no manager | no | 488-500; 484; 697 |
| **1** | POST-SUBMIT / RETURNED-FOR-CORRECTION — in the manager's hands; also the correction landing state | from 0 (submit), from 2 (manager correction), from 4 (doc-review correction) | task assignee (`ArjaBe` = project manager's name) | request header + attachments + requester opinion | V1–V7 | → 2; or → 3 when no manager | no | task 47-100, 244-246, 263-284; visibility 559-583 |
| **2** | MANAGER APPROVAL — «آیا چک صادر شود؟» | from 1 | the manager (assignee) | `B_NazarModir`, `TozihatModir` | V18 | `بله`→3; `نیازمند اصلاح است`→1; `خیر`→50 | no | task 103-128; request 516-524 |
| **3** | ALLOCATION — «صدور فرم تخصیص» | from 2 (`بله`) or 1 (no manager) | legacy assignee «آقای جلیلی» (hard-coded; Ariya: permission-gated role) | `MahaleTakhsis`, `MandeMojoodi`, `TarikhCheck`, `SharhCheck`, `MablagheCheck`, `DarVaghe` | V9, V10, V11; writes `Takhsis=تایید` | → 4 | no | task 140-163, 466-472, 697-699; request 525-532 |
| **4** | DOCUMENT REVIEW — «بررسی اسناد» | from 3 | legacy assignee «آقای مرتضوی» | `BarasiAsnad`, `Tozihat` | V12 | `تایید`→5; `اصلاح`→1 | no | task 165-181; request 533-539 |
| **5** | EXECUTIVE APPROVAL — «تایید ریاست» | from 4 | legacy assignee «آقای دکتر انفرادی» | `Riyast`, `Tozihat0` | V13 | `تایید`→6; `رد`→50; `نیازمند اصلاح`→ script `StateNext=6` / display rules imply 3 (**contradiction — §20**) | no | task 183-203; request 540-545, 585-591 |
| **6** | CHEQUE ISSUANCE — «صدور چک کارشناس مالی» | from 5 | legacy assignee «خانم نداف» | cheque-image grid (section 06), `TaedCheckSaderShode` | V14, V15 | → 7 | no | task 205-218; request 546-550; grid 711/494 |
| **7** | DELIVERY RECEIPT — «دریافت رسید تحویل» | from 6 | legacy assignee «خانم نداف» | receipt grid (section 07), `KhatemeSodoorCheck` | V16, V17 | → 8 (end) | no | task 220-236; request 551-554; grid 379/502 |
| **8** | COMPLETED (implied) | from 7 | — | — | — | — | **yes (implied)** | button disabled for `cr_status >= 8`; `StateNext = st + 1`; commented `//item.state = "100"` — exact terminal value `[OPEN]` |
| **50** | TERMINATED — three reasons | manager `خیر`; presidency `رد`; requester «لغو کامل گردش درخواست» | — | — | — | — | **yes** | task 121-124, 198-200; visibility 594-618 / 627-653 |

### 7.2 Transition rules, exactly as the source writes them `[CONFIRMED]`

```
default approve  : item.StateNext = st + 1
st=0 submit      : c_status := 1 ; StateNext := 2  (or 3 + B_NazarModir := "بله" if no manager)
st=1 forward     : StateNext := 2                  (or 3 if no manager; B_NazarModir := "بله")
st=2 manager     : "تایید" → 3 (default) | "نیازمند اصلاح است" → StateNext := 1 | "خیر" → StateNext := 50
st=3 allocation  : → 4 (default); sets Takhsis := "تایید"
st=4 doc review  : "تایید" → 5 (default) | "اصلاح" → StateNext := 1
st=5 presidency  : "تایید" → 6 (default) | "نیازمند اصلاح" → StateNext := 6 (script) | "رد" → StateNext := 50
st=6 issuance    : → 7 (default); requires cheque image + TaedCheckSaderShode
st=7 delivery    : → 8 (default); requires receipt image + KhatemeSodoorCheck
```

`StateNext` is the ONLY lever the forms hold; the actual `state` write happens in the
SharePoint workflow outside both files (`item.state` assignments exist only commented out —
lines 174/193/215/233). **Ariya must own this transition itself**: stage, guard and audit
event in one unit of work. `[DERIVED]`

### 7.3 Visibility per state (request form) `[CONFIRMED — 489-620]`

* `0` + new → only section 01 highlighted; every approval section hidden.
* `0` + saved → section 11 (attachments) highlighted; approval sections hidden.
* `2…7` → the current stage's section highlighted; all later sections hidden.
* state `1` + `B_NazarModir=نیازمند اصلاح است` → 01/11/08 highlighted, section 02 ORANGE.
* state `1` + `BarasiAsnad=اصلاح` → 01/11/08 highlighted, section 04 ORANGE.
* state `3` + `Riyast=نیازمند اصلاح` → section 03 highlighted, section 05 ORANGE.
* state `50` → the terminated stage's section (or 08 for requester cancellation) painted RED
  (`#FFCCCB`), later sections hidden.

### 7.4 Correction is a RETURN TO STATE 1 `[CONFIRMED]`

Manager and document-review corrections set `StateNext := 1`; the requester re-owns the
record (header + attachments + opinion editable) and it re-enters at 1→2. The BOM flow's
equivalent move was `SUBMITTED → DRAFT` because **its** source wrote `State = 0`; here the
source writes `1`, so Financial keeps a distinct RETURNED stage. A real divergence from the
BOM precedent, modelled as the source states it. `[CONFIRMED — 116-120, 175-177]`

---

## 8. Approval Matrix

### 8.1 Stage-by-stage

| # | Stage (source header) | Actor (source) | Actor (Ariya candidate) | Input | Output written | Reject value | Correction value | State before → after | Required docs / comments | Audit event (candidate) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | تایید مدیر | `ModireProject` employee → `PersonUser` | stored manager user id + permission (candidate `financial.check.approve`) | `B_NazarModir`, `TozihatModir` | `B_NazarModir`, `TozihatModir` | `خیر` → 50 | `نیازمند اصلاح است` → 1 | 2 → 3 \| 1 \| 50 | comment not enforced in source; attachments warned at st=1 | `manager_approve / manager_reject / manager_request_correction` |
| B | صدور فرم تخصیص | legacy «آقای جلیلی» | candidate permission `financial.check.allocate` | محل تخصیص، مانده موجودی، تاریخ چک، شرح چک، مبلغ چک، در وجه | those six fields + `Takhsis=تایید` | — (no reject in source) | — | 3 → 4 | V9/V10/V11 | `allocate` |
| C | بررسی اسناد | legacy «آقای مرتضوی» | candidate permission `financial.check.review` | `BarasiAsnad`, `Tozihat` | those two | — (only `اصلاح`) | `اصلاح` → 1 | 4 → 5 \| 1 | V12 (opinion); comment not enforced | `document_review / document_review_correction` |
| D | تایید ریاست | legacy «آقای دکتر انفرادی» | candidate permission `financial.check.approve.executive` | `Riyast`, `Tozihat0` | those two | `رد` → 50 | `نیازمند اصلاح` → script `6` / display implies `3` (§20) | 5 → 6 \| 50 \| ? | V13 | `executive_approve / executive_reject / executive_request_correction` |
| E | صدور چک کارشناس مالی | legacy «خانم نداف» | candidate permission `financial.check.issue` | cheque image (section 06), `TaedCheckSaderShode` | checkbox; image is an attachment row | — | — | 6 → 7 | V14, V15 | `issue / confirm_issued` |
| F | دریافت رسید تحویل | legacy «خانم نداف» | candidate permission `financial.check.deliver` | receipt image (section 07), `KhatemeSodoorCheck` | checkbox; image is an attachment row | — | — | 7 → 8 | V16, V17 | `deliver / complete` |

### 8.2 Source decision vocabularies — preserved verbatim `[CONFIRMED]`

* Manager `B_NazarModir ∈ {بله, خیر, نیازمند اصلاح است}` — `[717 / 663]`.
  The task script compares `"تایید"` for the positive branch (line 112) although the control
  offers `بله`; the negative/correction branches compare the control's own values, and the
  auto-approve path stores `بله` (lines 264-272; request 484). The `تایید` comparison is a
  legacy inconsistency — **the control's value list is the contract**.
* Document review `BarasiAsnad ∈ {تایید, اصلاح}` — `[345 / 478]`.
* Presidency `Riyast ∈ {تایید, رد, نیازمند اصلاح}` — `[353 / 486]`.
* Requester `NazarDarkhastKonande ∈ {تایید و ادامه, لغو کامل گردش درخواست}` — `[742 / 689]`.
* Allocation marker `Takhsis = تایید` (single static value) — `[691]`.

### 8.3 Approver assignment and the "my task" gate `[CONFIRMED]`

* Assignment is the free-text hidden field `ArjaBe`, written with **hard-coded legacy person
  names**: st=3 → «آقای جلیلی»; st=4 → «آقای مرتضوی»; st=5 → «آقای دکتر انفرادی»; st=6 and
  st=7 → «خانم نداف»; the requester's submit writes the manager's *name*.
  `[task 162, 180, 202, 217, 235; request 484]`
* The user→task link is only `c_AssignedTo` vs `form.UserFullName()` → `cr_Control6 = "1"`
  (lines 513-540). No role model beyond that.
* **Ariya:** actors must resolve from stored identity references + permissions; the legacy
  names must NOT appear in code or data. `[DECISION REQUIRED — §17]`
* Self-approval: the manager is chosen freely and may be the requester; the source neither
  blocks nor mentions it. `[NOT ESTABLISHED]`

---

## 9. Documents / Attachments

### 9.1 The attachment model of the source `[CONFIRMED]`

One SharePoint list «پیوست ها» `{867EF6A7-…}` with fields
`ID, LinkFilename, Section, NoeaSanad, IdSodoorCheck, Tozihat` (+ `ProjectDocID` written by
the metadata-save action). The request relation is `IdSodoorCheck = {c_ID|cr_ID}`; the stage
relation is `Section`.

| ListQuery | Filter | Meaning |
| --- | --- | --- |
| `ListQuery1` (request form, line 770) | `IdSodoorCheck = c_ID` AND `Section = 2` | request-stage documents |
| `ListQuery2` (request form, 771) | `… Section = 7` | delivery-receipt images |
| `ListQuery3` (request form, 772) | `… Section = 6` | issued-cheque images |
| `ListQuery2/3/4` (task form, 716-718) | the same three filters keyed on `c_WorkflowItemId` | the same |

Upload grids stamp their own `Section`:

| Grid | Section on upload | Extra values written |
| --- | --- | --- |
| `c_Peyvastha` / `cr_Peyvastha` (افزودن اسناد پیوست) | `02` | `NoeaSanad`, `Tozihat`, `IdSodoorCheck` |
| `c_Control5` / `cr_Control5` (صدور چک) | `06` | `IdSodoorCheck` only — **no document type** |
| `c_Control1` / `cr_Control1` (دریافت رسید) | `07` | `Tozihat`, `IdSodoorCheck` |

### 9.2 Document types `[CONFIRMED]`

`NoeaSanad` static values (line 689 / 448), verbatim:
`دستور پرداخت; پیش فاکتور; گواهی ارزش افزوده; کارت ملی تامین کننده; صورتجلسه;
صورتجلسه کمیسیون معاملات; صورتجلسه فاز بندی قرارداد; قرارداد; فاکتور مهردار;
ترجمه فاکتور انگلیسی; سایر`

### 9.3 Attachment behaviour per stage `[CONFIRMED]`

| Capability | Who / when | Evidence |
| --- | --- | --- |
| Upload | assignee at state 0 (request form) / state 1 (task form); `AllowUpload=True`, `AllowDelete=True`; a missing `NoeaSanad` cancels the upload | 383, 452, 730, 102-116 |
| Select → edit metadata | selection loads the row's `NoeaSanad`/`Tozihat` into the fields and hides the uploader («حالت ویرایش») | 383 / 452 `SelectionChangedScript` |
| Save metadata | `ذخیره مشخصات سند` writes `NoeaSanad`, `Tozihat`, `ProjectDocID` back to «پیوست ها»; enabled only when a row is selected | 734 / 681 |
| New | `سند جدید` clears metadata fields and re-shows the uploader | 730 / 679 |
| Delete | grid `AllowDelete=True` | 383 |
| Stage 6/7 uploads | the grids are declared `IsEnabled=False` and become usable only through the state+assignee gates | 711, 379 / 494, 502 |
| Requiredness | **no document type is ever required**; only "grid non-empty" at states 6 and 7 (V14/V16), plus warn-only W1 | §6 |

### 9.4 Fit with Ariya's infrastructure `[CONFIRMED — §2.3]`

* There is **no generic attachment service**. `IStorageProvider` (`upload/getUrl/delete`,
  signed short-lived URLs) is the only shared piece; every consumer owns its rows
  (`MessageAttachment`, `TicketAttachment`, `LetterAttachment` in `core_db`), and Commerce's
  contract explicitly refuses an attachment table.
* **Conclusion:** Financial owns its attachment rows in `financial_db` over the storage port,
  with `Section` as a stage-scoping column and `NoeaSanad` mapped to a closed
  `attachmentType` candidate. No storage-platform change is required. `[DERIVED]`

---

## 10. Check Issuance Data

### 10.1 What the source actually captures at issuance `[CONFIRMED]`

The stage «صدور چک کارشناس مالی» (section 06) contains exactly **two** things:

1. an image attachment — «بارگذاری تصویر چک صادر شده», grid `c_Control5`/`cr_Control5`,
   `Section = 06` (lines 709-711 / 492-494);
2. the checkbox `TaedCheckSaderShode` = «تایید چک صادر شده», text `تایید`
   (lines 359-361 / 490, 496).

Nothing else. No field of the cheque instrument itself exists.

### 10.2 Required fields — explicit `NOT ESTABLISHED` list

| Cheque attribute | Present? | Evidence |
| --- | --- | --- |
| شماره چک (cheque number) | **NOT ESTABLISHED** | zero hits for `شماره چک` in both files |
| شناسه صیادی / شبا | **NOT ESTABLISHED** | zero hits for `صیاد`, `شبا`, `IBAN` |
| بانک (bank) | **NOT ESTABLISHED** | zero hits for `بانک` |
| حساب بانکی (account) | **NOT ESTABLISHED** | zero hits for `حساب` |
| سریال چک (series) | **NOT ESTABLISHED** | zero hits for `سریال` |
| امضاکننده (signer) | **NOT ESTABLISHED** | no such control |
| تاریخ صدور (issue date) | **NOT ESTABLISHED** | no such control (`TarikhDarkhast`/`TarikhCheck` are different facts) |
| تاریخ سررسید (due date) | **NOT ESTABLISHED** | zero hits for `سررسید` |
| مبلغ نهایی at issuance | **NOT ESTABLISHED as a separate field** — the only amount is `MablagheCheck`, entered at allocation (stage 3) |
| beneficiary | only the stage-3 free-text `DarVaghe` («در وجه»); no beneficiary entity, no payee id |
| endorsement / clearing | **NOT ESTABLISHED** |

**No cheque-identity column may be invented** in the Financial schema. If Ariya later needs
them, that is a separately-evidenced phase. `[CONFIRMED — absence]`

### 10.3 Amount / allocation / balance — what IS established `[CONFIRMED]`

| Question | Answer | Evidence |
| --- | --- | --- |
| Unit of `MablagheCheck` | label «مبلغ چک» has **no unit**; the neighbouring «مانده موجودی (ریال)» explicitly says ریال — implying rial-scale integers, but the amount's own unit is `[OPEN]` | 335 / 456 vs 323 / 456 |
| Integer or decimal? | integer: `Decimals=0`, `Step=1` | 337 / 699 |
| May it be 0? | control allows it (`MinimumValue=0`); only "non-empty" is validated; `0 > 0` is false — **0 passes both rules** | 337, 699, V10/V11 |
| Must it be positive? | **not established** — no `> 0` check exists | §6.3 |
| Must it not exceed the balance? | **yes**, `MablagheCheck > MandeMojoodi` is refused — but only in the task form's state-3 branch | task 147-149 |
| Where does `MandeMojoodi` come from? | **user-entered at allocation**: the control is editable at state 3 with `MinimumValue=0`; no calculation or lookup exists anywhere | 697, 466-region |
| Is `MandeMojoodi` display-only? | **no** — read-only at creation, editable at stage 3 | 325 vs task 697 |
| Is `DarVaghe` a beneficiary entity? | **no** — free-text `TextBox` | 341 / 472 |
| Is `TarikhCheck` system-generated? | **no** — no default; a plain DatePicker, editable only at stage 3 | 329, 468 |
| Who sets the amount? | the allocation stage's actor, not the requester | §8-B |

**No financial rule beyond V9–V11 exists in the source.** No running balance, no budget, no
fund account, no multi- cheque splitting. `[NOT ESTABLISHED]`

---

## 11. Delivery / Completion

### 11.1 What «دریافت رسید تحویل» contains `[CONFIRMED]`

* label «بارگذاری رسید تحویل» + grid `c_Control1`/`cr_Control1`, `Section = 07`
  (lines 418, 379 / 498, 502);
* checkbox `KhatemeSodoorCheck`, task-form label «خاتمه صدور چک و بسته شدن فرآیند»,
  text `تایید` (363-365 / 500, 504).

### 11.2 Answers to the §11 questions

| Question | Answer |
| --- | --- |
| what is the receipt? | **an attachment image** (V16 counts the grid) `[CONFIRMED — 221-225]` |
| is it a confirmation? | yes — plus the `KhatemeSodoorCheck` checkbox (V17, 226-231) |
| delivered-to person? | **NOT ESTABLISHED** — no field |
| delivery date? | **NOT ESTABLISHED** — no field (only hidden `Tarikh` = "today", written at every action) |
| end by checkbox or transition? | **transition**: the checkbox is a *prerequisite*; completion happens when `StateNext = st + 1` lands the record beyond state 7 (`btn_True` disabled at `cr_status >= 8`) |
| is a successful end defined? | **implied, not proven**: state ≥8 is where the action button disappears; the commented-out code says `//item.state = "100"`. The exact terminal value is `[OPEN]` |

Nothing beyond this may be added: no delivery acknowledgement, no counter-signature, no
return-of-cheque flow. `[NOT ESTABLISHED]`

---

## 12. History / Audit

### 12.1 What the source shows `[CONFIRMED]`

The tab «سابقه گردش فرآیند» renders a `DataGrid` over the list **`CheckHistory`**
`{5792CC29-872B-46F2-9BD3-93E867FC3740}`, filtered by `MasterListID = {c_ID|cr_ID}`:

| Column (source) | Header | Meaning |
| --- | --- | --- |
| `State` | مرحله | the stage ordinal |
| `Title` | وضعیت مرحله | a stage-status label |
| `Created` | تاریخ ایجاد | row creation |
| `LastUser` | نام فرد | the person who acted |

Evidence: `c_Control6` grid line 726 (request) / `c_Control5` line 701 (task); queries line
773 / 719 (`Criteria="MasterListID;…;Equals;Text"`).

### 12.2 What is NOT established `[OPEN]`

* **Neither form writes `CheckHistory`.** The writer is the SharePoint workflow, which is
  outside the two source files — its exact payload rules are unknown.
* No `MasterListID` write, no dedupe rule, no ordering rule is visible.
* It is therefore impossible to claim per-stage history semantics beyond the four columns.

### 12.3 Is the platform audit enough? `[DECISION REQUIRED — recommendation]`

* The platform trail (`platform.audit@v1` → `core_db."AuditLog"`) carries
  `resourceType/resourceId/action/oldValue/newValue/changedFields/userId/tenantId/createdAt`
  and is already read through `PlatformAuditService`; Commerce and Production both build
  their **timeline** endpoints on it (PHASE-C6 / PHASE-C7 / BOM audit-timeline
  implementations) while keeping **no module audit table**.
* The four visible history columns map cleanly onto audit rows: `State` ≈ stage encoded in
  `resourceId`+`action`, `Title` ≈ action label, `Created` ≈ `createdAt`, `LastUser` ≈
  `userId`. `[DERIVED]`
* **Recommendation:** Financial timeline = platform-audit read (same pattern as Production's
  `GET :id/timeline`), **not** a `CheckHistory` clone table, and **never** reconstruction
  from mutable business rows — the audit rows are append-only, written in the same unit of
  work as each transition. A separate `CheckStageHistory` table is only justified if the
  product needs stage rows that are NOT audited acts (e.g. displayed "مرحله" labels with
  their own ordering) — deferred as `[OPEN]`.

---

## 13. Financial Domain Boundary

### 13.1 Ownership decision `[DECISION REQUIRED — RECOMMENDED]`

```
Module id (candidate) : financial        (Persian: مالی)
Feature id (candidate): check-request    (Persian: درخواست صدور چک)
Database              : financial_db     via FINANCICAL_DATABASE_URL / FINANCE_DATABASE_URL  [DECISION REQUIRED on the name]
Owns                 : the CheckRequest aggregate — its fields, its stage lifecycle,
                       its approvals, its attachments, its audit events, its title
Does NOT own         : purchase orders, projects, identity, employees, bank accounts,
                       payment records, budgets
```

### 13.2 Why Financial owns it `[DERIVED, source-grounded]`

1. **The subject is money commitment, not procurement.** The record can exist with no
   purchase order at all (`تنخواه`, `حقوق` types never touch `IdShomareSefaresh` —
   visibility formulas 254, cleared at submit) — so Purchase cannot own it.
2. **The lifecycle is a financial approval chain** (allocation by a finance person, cheque
   issuance by «کارشناس مالی», receipt by finance) — not a commercial workflow.
3. **The money fact (`MablagheCheck`) is created inside this flow** at the allocation stage;
   Finance is therefore its source of truth (§18).
4. **Owning it inside Commerce would repeat the C1 refusal** — Commerce's contracts
   explicitly exclude cheque/bank entities (PHASE-C1-Q/S).

### 13.3 Candidate aggregate map `[CANDIDATE]`

```
Financial
├── CheckRequest                (aggregate root: header fields + stage state)
│   ├── CheckAttachment         (child rows, section-scoped, storage-keyed)
│   ├── CheckApprovalDecision   (one row per decided stage — append-only decisions)
│   └── CheckStageHistory?      (only if §12.3 decides a native timeline is needed)
└── (FinancialAudit = the PLATFORM audit trail with resource 'financial.check_request')
```

Each candidate: ownership/lifecycle/evidence/dependencies below.

| Candidate | Owner | Lifecycle | Source evidence | Dependencies (future) |
| --- | --- | --- | --- | --- |
| `CheckRequest` | Financial, aggregate root | 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 \| 50 (§7) | `state`/`StateNext` fields, both forms | Identity (requester/manager refs), optional Purchase contract (order ref), optional Project contract (title snapshot) |
| `CheckAttachment` | Financial child of `CheckRequest` | created/edited only in states 0/1; counted at 6/7 | «پیوست ها» + `Section` (§9) | `IStorageProvider` (storage port) |
| `CheckApprovalDecision` | Financial | append-only per stage decision | `B_NazarModir`, `BarasiAsnad`, `Riyast`, `Takhsis`, `TaedCheckSaderShode`, `KhatemeSodoorCheck` (§8) | none |
| `CheckStageHistory` | Financial (optional) | one row per stage entry | `CheckHistory` columns (§12) | none — prefer platform audit |
| `FinancialAudit` | Platform (`core_db`) | append-only | `platform.audit@v1` | `AUDIT_PORT` |

---

## 14. Candidate Entities

Explicit per-entity contract (candidate — nothing is implemented).

### 14.1 `CheckRequest` (aggregate root)

| Concern | Candidate contract |
| --- | --- |
| Identity | opaque UUID; tenant-scoped (`tenantId` first in every predicate) |
| Stage state | closed ordinal (source `state`) + `stateNext` written only by transitions |
| Type | `issuanceType` = PURCHASE / PETTY_CASH / SALARY (`خرید/تنخواه/حقوق`) |
| Purchase kind | `purchaseKind` = PROJECT / NON_PROJECT (`پروژه ای/غیر پروژه ای`), null for SALARY |
| Requester | `requesterUserId` opaque (Identity); frozen after creation (`IsEnabledOnEdit=False`) |
| Manager | `managerUserId` opaque + `managerEmployeeRef` opaque; resolved to a system user at submit (V7) |
| Order | `purchaseOrderRef` opaque, null unless PURCHASE (cleared otherwise) |
| Project | `projectRef` opaque + `projectNameSnapshot` (+ optional code/status snapshots) |
| Title | `title` STORED snapshot (§5.2) |
| Decisions | `managerOpinion`, `documentReview`, `executiveOpinion`, `requesterOpinion`, comments — closed enums of §8.2 |
| Allocation | `allocationPlace`, `balanceAmount`, `chequeDate`, `chequeDescription`, `amount`, `payeeText` — stage 3 only |
| Issuance/delivery | `issuedConfirmed`, `deliveryCompleted` booleans (source checkboxes) |
| Termination | `terminationReason` = MANAGER_REJECTED / EXECUTIVE_REJECTED / REQUESTER_CANCELLED (the three state-50 causes) |
| Clocks | `createdAt`; `lastActionDate` (source hidden `Tarikh`) |
| NOT here | any cheque number / bank / account / صیاد field (§10.2); any FK to another context |

### 14.2 `CheckAttachment`

`id, tenantId, checkRequestId` (same-db FK), `section (2|6|7)`, `attachmentType` (closed
enum of `NoeaSanad` + OTHER), `description, storageKey, fileName, mimeType, sizeBytes,
uploadedByUserId, createdAt` (+ `updatedAt` for metadata edits). Metadata edit = update of
`attachmentType`/`description` only (source `ذخیره مشخصات سند`).

### 14.3 `CheckApprovalDecision`

One append-only row per decided stage: `id, tenantId, checkRequestId, stage, decision,
comment, actorUserId, decidedAt, sourceState, targetState` — "who decided what, when, and
where it went next" as one row (the same reasoning Commerce documents for
`CommercialApproval`). `[CANDIDATE]`

---

## 15. Candidate DB Schema (proposal only — NOT implemented)

Rules enforced in this sketch: **same-DB FK only**; every cross-context reference an opaque
`String (@db.Text)`; no client import from another context; tenant-first indexes.

```prisma
// prisma/financial/schema.prisma  — CANDIDATE, NOT WRITTEN
generator client { provider = "prisma-client-js", output = "../../src/generated/financial-client" }
datasource db   { provider = "postgresql", url = env("FINANCE_DATABASE_URL") }

enum CheckIssuanceType { PURCHASE PETTY_CASH SALARY }   // خرید / تنخواه / حقوق
enum CheckPurchaseKind { PROJECT NON_PROJECT }          // پروژه ای / غیر پروژه ای
enum CheckStage { DRAFT RETURNED MANAGER ALLOCATION DOCUMENT_REVIEW EXECUTIVE
                  ISSUANCE DELIVERY COMPLETED TERMINATED }
// 0=DRAFT 1=RETURNED 2=MANAGER 3=ALLOCATION 4=DOCUMENT_REVIEW 5=EXECUTIVE
// 6=ISSUANCE 7=DELIVERY 8=COMPLETED 50=TERMINATED   (§7)
enum ManagerOpinion   { APPROVED REJECTED NEEDS_CORRECTION }   // بله / خیر / نیازمند اصلاح است
enum DocumentReview   { APPROVED NEEDS_CORRECTION }            // تایید / اصلاح
enum ExecutiveOpinion { APPROVED REJECTED NEEDS_CORRECTION }   // تایید / رد / نیازمند اصلاح
enum RequesterOpinion { PROCEED CANCEL }                       // تایید و ادامه / لغو کامل گردش درخواست
enum TerminationReason { MANAGER_REJECTED EXECUTIVE_REJECTED REQUESTER_CANCELLED }
enum AttachmentSection { REQUEST CHEQUE_IMAGE DELIVERY_RECEIPT }   // 2 / 6 / 7
enum AttachmentType { PAYMENT_ORDER PROFORMA VAT_CERTIFICATE SUPPLIER_IDCARD MINUTES
                      COMMISSION_MINUTES CONTRACT_PHASE_MINUTES CONTRACT STAMPED_INVOICE
                      ENGLISH_INVOICE_TRANSLATION OTHER }      // §9.2 vocabulary

model CheckRequest {
  id                     String  @id @default(uuid()) @db.Uuid
  tenantId               String  @map("tenant_id") @db.Text
  title                  String  @db.Text                      // STORED snapshot (§5.2)
  stage                  CheckStage @map("stage")
  issuanceType           CheckIssuanceType @map("issuance_type")
  purchaseKind           CheckPurchaseKind? @map("purchase_kind")
  requesterUserId        String  @map("requester_user_id") @db.Text        // OPAQUE — Identity
  requesterEmployeeRef   String? @map("requester_employee_ref") @db.Text
  managerUserId          String? @map("manager_user_id") @db.Text          // OPAQUE — resolved at submit
  managerEmployeeRef     String? @map("manager_employee_ref") @db.Text
  purchaseOrderRef       String? @map("purchase_order_ref") @db.Text        // OPAQUE — §18
  projectRef             String? @map("project_ref") @db.Text               // OPAQUE — no Project domain
  projectNameSnapshot    String? @map("project_name_snapshot") @db.Text
  projectCodeSnapshot    String? @map("project_code_snapshot") @db.Text
  projectStatusSnapshot  String? @map("project_status_snapshot") @db.Text
  requestDate            DateTime @map("request_date") @db.Date             // TarikhDarkhast
  requesterOpinion       RequesterOpinion @default(PROCEED) @map("requester_opinion")
  managerOpinion         ManagerOpinion?   @map("manager_opinion")
  managerComment         String?  @map("manager_comment") @db.Text
  documentReview         DocumentReview?   @map("document_review")
  documentReviewComment  String?  @map("document_review_comment") @db.Text
  executiveOpinion       ExecutiveOpinion? @map("executive_opinion")
  executiveComment       String?  @map("executive_comment") @db.Text
  allocationPlace        String?  @map("allocation_place") @db.Text          // MahaleTakhsis
  balanceAmount          Decimal? @map("balance_amount") @db.Decimal(18,0)   // MandeMojoodi (ریال)
  chequeDate             DateTime? @map("cheque_date") @db.Date
  chequeDescription      String?  @map("cheque_description") @db.Text
  amount                 Decimal? @db.Decimal(18,0)                          // MablagheCheck
  payeeText              String?  @map("payee_text") @db.Text                // DarVaghe (free text)
  issuedConfirmed        Boolean @default(false) @map("issued_confirmed")
  deliveryCompleted      Boolean @default(false) @map("delivery_completed")
  terminationReason      TerminationReason? @map("termination_reason")
  lastActionDate         DateTime? @map("last_action_date") @db.Date
  createdById            String  @map("created_by") @db.Text
  createdAt              DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt              DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  attachments            CheckAttachment[]
  decisions              CheckApprovalDecision[]

  @@unique([tenantId, id])
  @@index([tenantId, stage, createdAt])            // register read
  @@index([tenantId, requesterUserId, createdAt])
  @@index([tenantId, purchaseOrderRef])            // §18 lookup — non-unique on purpose
  @@map("CheckRequest")
}

model CheckAttachment { /* §14.2 — same-db FK, onDelete: Restrict */ }
model CheckApprovalDecision { /* §14.3 — append-only, no updatedAt */ }
```

Explicit refusals: no `chequeNumber`/`bankId`/`accountId`/`sheba` column; no FK to
`PurchaseDocument`, `Project`, `User` or `Employee`; no `PaymentRecord` link; no status
column outside `stage`. `[§10.2, §19, ADR-0005]`

---

## 16. Candidate API Contract (design only — routes NOT implemented)

**Approved only after the state machine in §7 is signed off.** Shape follows the Production
BOM controller (`@RequiresModule` + per-route permission string + service) and Commerce's
DTO/clamp conventions. Prefix candidate: `api/v1/financial/check-requests`.

| Capability | Method / route (candidate) | Request DTO | Response DTO | Authorization | State precondition | Validation | Audit (candidate action) | Idempotency / concurrency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| create | `POST /` | issuanceType, purchaseKind?, purchaseOrderRef?, projectRef?, projectNameSnapshot?, manager refs, requestDate | `CheckRequestSummary` | `financial.check.manage` | — (creates at stage 0) | V1-V6 on submit; create only requires type | `create` | standard unique id; no idempotency key needed |
| get | `GET /:id` | — | `CheckRequestDetail` (+ stage, decisions, attachments) | `financial.check.read` | any | tenant predicate | — | — |
| list | `GET /?stage=&issuanceType=&pageSize=&cursor=` | query | paged `CheckRequestSummary[]` | `financial.check.read` | any | DTO ceiling 100 (pattern `*_MAX_PAGE_SIZE`) | — | — |
| update draft | `PATCH /:id` | partial header fields | detail | `financial.check.manage` | stage = 0 or 1 | V1-V7; requester frozen; type frozen once submitted | `update` | conditional `updateMany` on stage |
| submit / re-submit | `POST /:id/submit` | — | detail | `financial.check.manage` | 0 → 1 (or 1 → 2) | V1-V7, V7 user resolution; attachments warn | `submit` | conditional on stage, `StateNext` computed here |
| manager decision | `POST /:id/manager-decision` | opinion, comment? | detail | `financial.check.approve` + stored manager check | stage = 2 | V18; opinion in closed set | `manager_approve/reject/request_correction` | conditional stage=2; 0→1 row already decided |
| allocate | `POST /:id/allocation` | allocationPlace, balanceAmount, chequeDate?, chequeDescription?, amount, payeeText | detail | `financial.check.allocate` | stage = 3 | V9-V11 (all three, incl. amount ≤ balance) | `allocate` | conditional stage=3 |
| document review | `POST /:id/document-review` | decision, comment? | detail | `financial.check.review` | stage = 4 | V12 | `document_review` / `_correction` | conditional stage=4 |
| executive approval | `POST /:id/executive-approval` | opinion, comment? | detail | `financial.check.approve.executive` | stage = 5 | V13 | `executive_*` | conditional stage=5 |
| confirm issued | `POST /:id/confirm-issued` | confirmed=true | detail | `financial.check.issue` | stage = 6 | V14 (≥1 image), V15 | `issue` + `confirm_issue` | conditional stage=6 |
| confirm delivery | `POST /:id/confirm-delivery` | completed=true | detail | `financial.check.deliver` | stage = 7 | V16, V17 | `deliver` + `complete` | conditional stage=7 |
| cancel / terminate | `POST /:id/terminate` | reason ∈ 3 causes | detail | `financial.check.approve` (manager) / requester for cancel | from 2 (خیر), 5 (رد), 1 (cancel) | reason required | `cancel` | conditional |
| upload document | `POST /:id/attachments` (multipart) | section, attachmentType, description, file | attachment DTO | `financial.check.manage` (0/1) or stage permission (6/7) | stage matches section | V8 (type required); section↔stage match | `document_added` | — |
| update document metadata | `PATCH /:id/attachments/:attachmentId` | attachmentType?, description? | attachment DTO | `financial.check.manage` | stage 0/1 | V8 | `document_updated` | row id + tenant |
| delete document | `DELETE /:id/attachments/:attachmentId` | — | 204 | `financial.check.manage` | stage 0/1 | — | `document_deleted` | — |
| read timeline/history | `GET /:id/timeline` | — | audit-timeline DTO | `financial.check.read` | any | — | — (read) | — |

Cross-cutting: every mutating route performs **stage-conditional `updateMany`** (the
Production `bom.repository.ts` pattern), writes exactly one `platform.audit@v1` event, and
returns the fresh row. `[CANDIDATE]`

---

## 17. Candidate Permissions (NOT registered yet)

**Nothing below may be created before the permission catalogue and naming conventions are
approved.** Candidates only — following `production.bom.{read,manage,approve}` shape:

```text
financial.check.read                — list/detail/timeline
financial.check.manage              — create/update-draft/submit/cancel (authorship remit)
financial.check.approve             — manager decision (stage 2)
financial.check.allocate            — allocation (stage 3)
financial.check.review              — document review (stage 4)
financial.check.approve.executive   — presidency (stage 5)
financial.check.issue               — issuance + confirmation (stage 6)
financial.check.deliver             — delivery + completion (stage 7)
```

Open design questions `[DECISION REQUIRED]`:

1. **Two-tier or three-tier?** Commerce uses three (`read/manage/approve`); the cheque flow
   has six *distinct* acting roles — collapsing them into one `approve` would let a single
   permission act at six stages.
2. Stage-specific permissions imply **per-stage entitlement**; the repo today grants
   permissions per role row (Core migrations) — the seed strategy must be decided with the
   permission catalogue owner.
3. Module id (`financial`), feature id (`check-request`) and the `FINANCE_DATABASE_URL` name
   must be fixed before any `ModuleRegistration` / `ModuleFeature` row is seeded.
4. **No role and no permission string is added in this phase.** `[CONFIRMED — §23 scope]`

---

## 18. Future Purchase Integration Contract

**No integration, FK or API is created now.** This section records what a future contract
must satisfy, derived only from what the source actually consumes.

### 18.1 What the source consumes from Purchase `[CONFIRMED]`

```js
// sooderCheck.txt 292-304 — the ONLY Purchase read in the whole form
ss.FieldName = "ID";  ss.FieldValue = <IdShomareSefaresh>;  ss.Operator = "Equals";
form.LoadRecords(url, "درخواست کالا", "", criteria, …, callback);
// callback (257-289):
projectRefString = e.ListItems[0].NameProjeKala;      // → c_Control4 (Project)
alert(e.ListItems[0].Author);                          // debug only — not stored
form.GetControl("c_Title").SetValue(title + ss);       // → Title snapshot
```

So the source needs exactly: **the order id → (project reference, project display name)**.
It reads NO amount, NO supplier, NO line data.

### 18.2 Future Contract Requirement `[DECISION REQUIRED — proposal]`

```text
Contract : purchase.check-request-context@v1        (name TBD by the Purchase owner)
Port     : CHECK_REQUEST_ORDER_PORT (token) in Financial; adapter implemented on the
           Purchase side (or an anti-corruption read service), never a DB join
Query    : resolveOrderByRef(tenantId, orderRef) ->
             { orderRef, projectRef?, projectNameSnapshot?, projectCodeSnapshot?,
               projectNameAtSnapshot?, requesterRef?, exists: boolean }
Rules    : tenant-scoped; opaque refs only; errors are explicit (NOT_FOUND/ FORBIDDEN);
           Financial stores SNAPSHOTS at creation and never re-reads for title/label
           display (the BOM title decision, production/schema.prisma:67-73)
```

### 18.3 Snapshot vs live `[DERIVED]`

| Data | Live or snapshot | Why |
| --- | --- | --- |
| order reference | stored opaque ref (never validated against Purchase at read time) | no FK; §19 |
| project ref + name + code + status | **snapshot at creation** (source writes them into Title/Code/Vazeyat once) | Ariya has no Project contract; title must be stable |
| cheque amount | **Financial is the source of truth** — created at allocation inside Financial | §10.3 |
| order itself (its amount, supplier, lines) | **Purchase remains source of truth** — Financial never stores them | source never reads them |
| manager / requester | Identity is source of truth; Financial stores opaque ids + a resolved user id | §19 |

### 18.4 Standing prohibitions until the contract exists `[CONFIRMED]`

* no FK to `PurchaseDocument`; no import of `commerce-client`; no REST call hard-coded into
  Financial's domain layer; no duplicated purchase fields beyond the snapshots above;
* until `resolveOrderByRef` exists, `purchaseOrderRef` and `projectRef` are **stored opaque
  and unvalidated** — the same posture the BOM phase took for `projectRef` before a Project
  domain exists.

---

## 19. Cross-Context References

| Reference | Storage in `financial_db` | Resolution at runtime | Forbidden form |
| --- | --- | --- | --- |
| tenant | `tenantId String @db.Text` (first column of every index/predicate) | session | any FK |
| requester / actor | `requesterUserId`, `managerUserId`, `createdById`, `actorUserId` — plain strings | `platform/user-directory` contract | FK to `core_db."User"` |
| employee | `requesterEmployeeRef`, `managerEmployeeRef` — opaque legacy ids preserved verbatim | HR contract (future) | FK to `hr_db."Employee"` |
| project | `projectRef` + snapshots | no domain exists — **unvalidated** | FK to a `Project` table (does not exist: 0 models) |
| purchase order | `purchaseOrderRef` | future §18 port | FK to `commerce_db."PurchaseDocument"`; importing `commerce-client` |
| supplier / bank / account | — | — | inventing such tables (no evidence, §10.2) |
| audit | events to `AUDIT_PORT` with `resource = 'financial.check_request'` | platform audit | a module-local audit table |
| history view | audit read (`GET :id/timeline`) | `PlatformAuditService` | reconstruction from mutable business rows |

Sweep results backing the table: `model (Project|Supplier|Bank|Account|Cheque|Check)` = 0
hits across all 8 schemas; `RequesterId`/`approverId` opaque-reference pattern verified in
commerce + production schema headers (§2.3). `[CONFIRMED]`

---

## 20. Unknown / Not Established

Nothing in this section may be designed away by assumption; each item blocks or shapes a
later decision.

| # | Item | Status | Note |
| --- | --- | --- | --- |
| U1 | Terminal stage value (`8` vs `100`) | `[OPEN]` | button gate proves ≥8 ends the flow; `//item.state = "100"` is commented (task 233) |
| U2 | Presidency «نیازمند اصلاح» target — script writes `StateNext=6`, but **both** forms' display rules render state-3 + `Riyast=نیازمند اصلاح` as "allocation highlighted, presidency orange" (req 585-591 / task 616-621) | `[OPEN — contradiction]` | must be resolved by the business owner before §7 sign-off |
| U3 | Who acts at state 1 vs state 2 | `[OPEN]` | state 1 is entered by the requester's submit AND by corrections; its task block edits header fields; state 2 is the manager's opinion. Two manager touchpoints OR state 1 = manager's "review" step — source cannot decide |
| U4 | Who writes `CheckHistory` and with what payload | `[OPEN]` | outside both files (SharePoint workflow) |
| U5 | Self-approval rule | `[NOT ESTABLISHED]` | no guard in source; Ariya policy must decide (fail-closed default recommended) |
| U6 | Unit/currency of `MablagheCheck` | `[OPEN]` | only the neighbouring «(ریال)» label suggests rial |
| U7 | Whether `amount` may be `0` | `[OPEN]` | control + validations both permit it |
| U8 | Uniqueness (one open request per order?) | `[NOT ESTABLISHED]` | |
| U9 | Assignment of stages 3-7 in Ariya | `[DECISION REQUIRED]` | legacy hard-codes four person names; Ariya has no such roster evidence |
| U10 | Business document number («شماره فرم» is the SharePoint row ID) | `[NOT ESTABLISHED]` | no numbering scheme exists; minting one is a new decision |
| U11 | Meaning of list `کارتابل صدور چک` in `cr_Code`'s lookup | `[OPEN]` | single reference, inconsistent with the label «کد پروژه» (task 432) |
| U12 | Whether requester cancellation («لغو کامل گردش درخواست») has a trigger | `[OPEN]` | the value exists and state 50 renders it, but no script in either file performs that transition |
| U13 | Concurrency expectations of the legacy workflow (last-writer-wins?) | `[NOT ESTABLISHED]` | Ariya will apply conditional updates regardless (§22) |

---

## 21. Deferred Items

Explicitly out of scope for the first increment (each already evidenced above):

* stages 3-7 (allocation, document review, executive approval, issuance, delivery) — §8;
* attachments for sections 6/7 (cheque image, receipt) until the issuing stage exists — §9;
* any cheque instrument fields (§10.2) — permanently refused without new evidence;
* Purchase integration / `resolveOrderByRef` port — §18;
* Project-name resolution for title building — §5.2 (snapshot-only until a Project contract);
* the `CheckHistory` clone / native stage-history table — §12.3 (audit timeline first);
* search indexing (`platform/search-source`) — no phase has ordered it for Financial;
* notification/task inbox for stage assignment — depends on the actor model (U9);
* a standalone `future-financial` runtime image — `runtime-datasources.ts` shows HR itself
  is still `status: 'target'`; Financial should initially ride the combined runtime like
  Commerce and Production do;
* permissions seeding (§17) — only with catalogue approval.

---

## 22. Risks / Blockers

| # | Risk / blocker | Impact | Mitigation |
| --- | --- | --- | --- |
| R1 | **U2 contradiction** (presidency correction target) | wrong state machine | resolve with the business owner before implementation; encode as a test table |
| R2 | **U3 two-touchpoint manager flow** | double work or a missing approval | decide: keep 1+2 as separate transitions (source-faithful) or collapse; default = source-faithful |
| R3 | Legacy hard-coded actors (U9) | accidental person hard-coding — explicitly forbidden | role/permission model only; no names in code or seeds |
| R4 | Amount rule asymmetry (V11 task-only) | requests approved without the balance check | enforce V9-V11 in one domain method used by both entry points |
| R5 | No cheque-identity fields | later product demand cannot be met without a new evidenced phase | record now; do not pre-add columns |
| R6 | Title needs a project name with no Project contract | title cannot be derived | stored snapshot (BOM precedent); client supplies it until §18/Project contract |
| R7 | Commerce workflow engine is subject-closed | misuse would couple Financial to `commerce_db` | own guarded state machine on the row (BOM M-5 Option A pattern) |
| R8 | Requester-cancel (U12) has no writer | a dead branch if ported blindly | either implement `terminate(reason=REQUESTER_CANCELLED)` explicitly or omit the value from V1 — decision required |
| R9 | `ArjaBe`-style assignment leaks | free-text names reach data | `assignedToUserId` opaque + permission gates |
| R10 | Amount may be 0 / unit unknown | malformed money data | decide `> 0` and the unit with the owner; both are new rules, flagged as such |

---

## 23. Recommended Next Implementation Phase

**Phase FINANCIAL-F1 — "bounded context foundation + request lifecycle 0→1→2"** (no other
stage, no integration):

1. **Foundation (mirror Production exactly):**
   * declare `FINANCE_DATABASE_URL` in `runtime-datasources.ts` (`status: 'implemented'`,
     combined runtime) + regenerate `runtime-policy.json`;
   * `prisma/financial/schema.prisma` with §15's `CheckRequest` (+ attachment/decision tables
     if the §9 scope is included), own migrations, own generated client;
   * `src/modules/financial/{financial.constants.ts, financial.module.ts, database/,
     check-request/}` with `FINANCIAL_MODULE_ID = 'financial'` and
     `FINANCIAL_FEATURE = { CHECK_REQUEST: 'check-request' }`;
   * Core provisioning migration seeding `ModuleRegistration` + `ModuleFeature`
     (the `20261002100100_seed_production_permission_grants` pattern) — only with catalogue
     approval (§17);
   * `FinancialAuditGateway` over `AUDIT_PORT`, resource `financial.check_request`.
2. **Domain slice:** create / update-draft / submit / manager-decision /
   terminate-with-reason — i.e. stages `0`, `1`, `2` (+ `50`), with V1-V7, V18, the three
   manager opinions, correction return to `RETURNED`, and stage-conditional transitions.
3. **Attachments (request stage only):** upload / metadata / delete for section `2` over
   `IStorageProvider` (V8 + warn-only W1 semantics).
4. **Reads:** list/detail with tenant-first predicates; `GET :id/timeline` from platform
   audit (no history table).
5. **Tests:** the §7.2 transition table as executable cases; V1-V7/V18 message assertions;
   the isolation suite (no cross-context imports/clients); audit-once-per-transition.
6. **Deliberately NOT in F1:** stages 3-7, cheque/receipt attachments, the Purchase port,
   permissions beyond what gates F1 routes, and any UI beyond what the routes require
   (UI can follow as F1-W).

**Pre-conditions to settle before F1 coding starts:** U1 (terminal value), U2 (presidency
correction target), U3 (state-1 actor), U9 (actor model for stages ≥3 — if F1 must predeclare
their permissions), R10 (amount positivity/unit), and the module/feature/datasource names
(§17.3).

---

## 24. Exact Source Evidence

Line references are to `E:\Very Mohem\sooderCheck.txt` (REQ) and
`E:\Very Mohem\kartabl SoderCheck.txt` (TASK). Long single-line scripts were extracted and
read unescaped in full; nothing was sampled.

| # | Rule | Evidence |
| --- | --- | --- |
| E1 | Stage field is `state`, default `0`; label «شماره مرحله» | REQ 486-488 (`TargetFieldName="state" DefaultValue="0"`) |
| E2 | `StateNext` is the transition target; hidden | REQ 757; TASK 707, 715 (`ListQuery1 … StateNext`) |
| E3 | Requester submit `0 → 1`; `StateNext := 2` or `3` + `B_NazarModir := "بله"` when no manager | REQ 697 script (`state()`, `if (myState == 0 && userModir == '')`) |
| E4 | Manager opinions `بله;خیر;نیازمند اصلاح است` | REQ 717; TASK 663 (`Lookup_StaticValues`) |
| E5 | Manager branches: correction `→1`, `خیر` `→50`, approve default `→3` | TASK 103-128 |
| E6 | Allocation validations V9/V10/V11 + `Takhsis="تایید"` | TASK 140-163 |
| E7 | Document review `تایید;اصلاح`, correction `→1` | REQ 345; TASK 165-181 |
| E8 | Presidency `تایید;رد;نیازمند اصلاح`; `رد →50`, `نیازمند اصلاح → StateNext=6` | REQ 353; TASK 183-203 |
| E9 | Issuance: cheque image required + `TaedCheckSaderShode` required; `ArjaBe="خانم نداف"` | TASK 205-218 |
| E10 | Delivery: receipt image required + `KhatemeSodoorCheck` required | TASK 220-236 |
| E11 | Button disabled at `cr_status >= 8` (terminal gate) | TASK 655 `EnabledFormula` |
| E12 | Termination rendering for state 50 × {cancel, `خیر`, `رد`} | REQ 594-618; TASK 627-653 |
| E13 | Initial validations V1-V7 + attachment warns (verbatim messages) | REQ 484 (submit script); TASK 655 |
| E14 | Type vocabulary `خرید;تنخواه;حقوق`, default `خرید` | REQ 209 |
| E15 | Purchase kind `پروژه ای;غیر پروژه ای`, default `پروژه ای`, hidden for `حقوق` | REQ 385, 416 |
| E16 | Type-conditional visibility (order id / project / manager) | REQ 254, 256, 313, 315, 420, 422, 701, 703 |
| E17 | Clearing order id / kind / project on submit for `حقوق` and `تنخواه` | REQ 484 lines 58-71 |
| E18 | Title templates (all five branches) | REQ 226-253, 386-415, 423-433; TASK 299-324, 337-357 |
| E19 | Purchase lookup `درخواست کالا` by `ID` → `NameProjeKala` → project + title append | REQ 257-304 |
| E20 | Requester from current user via `لیست کارکنان` `PersonUser` | REQ 150-166, 638-654 |
| E21 | Manager `PersonUser` resolution refusal message | REQ 484 `callbackEmpID`; TASK 15-26 |
| E22 | "my task" gate `c_AssignedTo` vs `form.UserFullName()` → `cr_Control6=1` | TASK 513-540 |
| E23 | Attachment upload requires `NoeaSanad` | REQ 91-117; TASK 147-173 |
| E24 | Document type vocabulary (11 values) | REQ 689; TASK 448 |
| E25 | Attachments `Section` scoping 2 / 6 / 7 + ListQuery filters | REQ 379, 383, 711, 770-772; TASK 452, 494, 502, 716-718 |
| E26 | Metadata save writes `NoeaSanad/Tozihat/ProjectDocID` to «پیوست ها» | REQ 734; TASK 681 |
| E27 | Stage editing gates (enabled exactly at own stage + assignee + `nextstate==status`) | TASK 283, 327, 360, 466-472, 478, 486, 494, 496, 502, 504, 663, 667, 697-699 |
| E28 | Request-form stage visibility chain (current section highlighted, later hidden) | REQ 489-554 |
| E29 | Correction rendering (state 1 orange 02/04; state 3 + `Riyast` orange 05) | REQ 556-591; TASK 589-621 |
| E30 | `CheckHistory` list + columns + `MasterListID` filter | REQ 726, 773; TASK 701, 719 |
| E31 | List GUIDs: request, attachments, history, employees, projects, purchase | REQ 770-773; TASK 715-719; REQ 163, 303, 422 |
| E32 | `ArjaBe` hard-coded names جلیلی / مرتضوی / دکتر انفرادی / نداف | TASK 162, 180, 202, 217, 235; REQ 484 (manager name) |
| E33 | `Tarikh` (hidden `c_LastDate`) = today at every action | REQ 766; TASK 711; scripts |
| E34 | No cheque-identity fields at all | negative sweep: `شماره چک\|بانک\|حساب\|صیاد\|سریال\|سررسید\|سفته\|IBAN` = 0 hits in both files |
| E35 | `IsRequired="True"` appears only on `Title` | REQ 205; TASK 271 |
| E36 | Only two tabs: `ثبت درخواست` + `سابقه گردش فرآیند` | REQ 167-175; TASK 232-241 |
| E37 | URL-injected purchase id (`oid=`) fills `c_id` → `IdShomareSefaresh` | REQ 663-671, 759-763 |
| E38 | `c_check` watchdog freezes editing when the requester changes | REQ 744-756 + EnabledFormulas 383/697/730/734 |

---

**END OF PREFLIGHT.** No implementation resulted from this phase: no migration, no schema
file, no route, no UI, no permission, no integration and no connector was created.
