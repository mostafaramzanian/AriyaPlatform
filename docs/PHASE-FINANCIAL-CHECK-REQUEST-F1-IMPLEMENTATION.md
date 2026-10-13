# PHASE F1 — FINANCIAL FOUNDATION + CHECK REQUEST LIFECYCLE — IMPLEMENTATION REPORT

**Status:** `IMPLEMENTED — verified. Code commit: see §19.`
**Basis:** `docs/PHASE-FINANCIAL-CHECK-REQUEST-PREFLIGHT.md` (final preflight) + the two
legacy sources `E:\Very Mohem\sooderCheck.txt` (request form) and
`E:\Very Mohem\kartabl SoderCheck.txt` (workflow task form).
**Scope executed:** states `0 / 1 / 2 / 50` (+ the approve landing at `3`, downstream
deferred). States 3–7 workflows are NOT implemented, per the brief's §0/§12/§32.

---

## 1. Preflight Confirmation

| Preflight claim | Confirmed at implementation time |
| --- | --- |
| §5 issue type `خرید;تنخواه;حقوق` | `CheckIssueType` = PURCHASE / PETTY_CASH / SALARY, labels verbatim |
| §5 purchase type `پروژه ای;غیر پروژه ای` | `CheckPurchaseType`, labels verbatim; NULLABLE (salary clears it) |
| §6.1 validations V1–V7 | `check-request.service.ts` — `assertBusinessRules` + `withConditionalClearing`, in the source's own evaluation order |
| §7 stage ordinals 0/1/2/3/50 (+4..7 deferred) | `status Int` closed set {0,1,2,3,50}; 4..7 have no member, no transition, no route |
| §7.2 `st=0 submit: c_status := 1 ; StateNext := 2`, `st=1 forward → 2` | `CheckRequestRepository.submit` performs 0→1→2 (or 1→2) as ONE transactional unit |
| §7.4 correction is a RETURN TO STATE 1; requester re-owns header+attachments | `request-correction` → 1; `isCheckRequestEditable` = {0,1}; attachments editable in both |
| §8.2 `بله;خیر;نیازمند اصلاح است` | `ManagerDecision`; UI renders the source words verbatim |
| §8.2 `تایید و ادامه;لغو کامل گردش درخواست` | `RequesterOpinion`; the CANCEL action is U12 — recordable, no route |
| §9.1–9.3 attachments section-scoped; 11 document types; NOT blocking | `CheckAttachment` `section=2`; `CheckDocumentType` (11, source order); nothing requires a document to exist |
| §10 no cheque-identity data | No bank/iban/sayad/chequeNumber/dueDate column, DTO field or UI control; asserted by `financial-isolation.spec.ts` §F |
| §14 `financial.check.read/manage/approve` | Catalogue + seeded to SUPER_ADMIN/ADMIN; no other permission invented |
| §18 Purchase = Future Contract | `orderReference` opaque; `PurchaseOrderReferencePort` declared with NO adapter, NO binding, NO caller |
| §20 unknowns | Recorded in §16 as `NOT ESTABLISHED / DEFERRED`; none became behavior |

---

## 2. Financial Module Structure

```text
apps/api/src/modules/financial/
├── financial.constants.ts            # module id, feature, audit resource, page ceiling
├── financial-actor.ts                # resolveFinancialActor (mirror of production-actor)
├── financial-audit.gateway.ts        # THE one audit seam (record + timeline read)
├── financial.module.ts               # composition root (AppModule only, never Core)
├── financial-isolation.spec.ts       # architecture promises re-read from the file system
├── purchase-order-reference.port.ts  # FUTURE contract — interface only, deliberately unbound
├── database/
│   ├── financial-prisma.module.ts    # binds FINANCE_PRISMA_CLIENT
│   └── financial-prisma.service.ts   # the ONLY handle on finance_db
└── check-request/
    ├── check-request-status.ts       # pure lifecycle: statuses, transitions, vocabularies
    ├── check-request.ts              # title builder, error codes, audit actions, doc types
    ├── check-request.dto.ts          # the wire contract (whitelist; forbidden → refusal)
    ├── check-request.repository.ts   # conditional persistence, tenant-first
    ├── check-request.service.ts      # V1–V7, clearing, title, guards, audit, timeline
    ├── check-request.controller.ts   # 14 routes, all gated
    ├── check-attachment.repository.ts
    ├── check-attachment.service.ts   # section-02 documents over IStorageProvider
    └── specs (6 suites)
```

Independence: own datasource (`FINANCE_DATABASE_URL` → **`finance_db`**), own Prisma
project (`prisma/financial/`), own client (`src/generated/financial-client`), own
migrations, own permission domain (`FINANCIAL`), registered in `AppModule` and
deliberately NOT in `CoreAppModule`.

**Naming decision:** the brief fixes the logical database as `finance_db` (DoD §35) while
the repo convention pairs `<owner>_DATABASE_URL` with the database concept. F1 uses
**db = `finance_db`**, **env = `FINANCE_DATABASE_URL`**, **owner/prisma project/module dir
= `financial`** — the last is required so `architecture-boundaries.spec.ts`'s
`discoverIndependentModules` pairs `prisma/financial` with `src/modules/financial`.

---

## 3. Database / Prisma

* `apps/api/prisma/financial/schema.prisma` — two models, five enums:
  * `CheckRequest`: id, tenantId, title (server-built), checkIssueType, purchaseType?,
    orderReference?, projectReference?, projectManagerUserId?, requesterUserId,
    requestDate (server default now), requesterOpinion (default CONTINUE), status Int
    (default 0), managerDecision?, managerComment?, submittedAt?, decidedAt?,
    decidedByUserId?, createdAt/updatedAt. Tenant-first `@@unique([tenantId, id])` plus
    two tenant-first indexes.
  * `CheckAttachment`: id, tenantId, checkRequestId, **composite same-database FK**
    `→ CheckRequest(tenantId, id)` (onDelete Restrict), section (default 2),
    documentType, description?, storageKey, fileName, mimeType, size, createdBy,
    timestamps, tenant-first key + index.
* `status` is an INT because the source's stage ordinal IS a number and the brief names
  every state by ordinal; the closed set is enforced in `check-request-status.ts`
  (Prisma v5 cannot express a CHECK, and a hand-written CHECK would be `migrate diff`
  drift). The column is never a wire input — the DTO refuses it.
* NO cross-database FK; NO cheque-instrument column; NO uniqueness rule beyond the
  tenant-first key (the source has none — Preflight §6.2). `prisma validate` passes.

## 4. Migration

* `prisma/financial/migrations/20261003150000_financial_baseline` — produced with
  `prisma migrate diff --from-empty --to-schema-datamodel … --script`.
* Four Core migrations, each standalone because of SQLSTATE 55P04, mirroring
  Production's quartet: permission domain `FINANCIAL`; the three permission grants
  (SUPER_ADMIN + ADMIN); module registration + per-tenant membership + stop-guard;
  feature `check-request` + per-tenant grants + stop-guard.
* **Applied to the live dev cluster**: `finance_db` created through the idempotent
  `01-create-databases.sql` (now including `finance_db`); `migrate deploy` green for both
  schemas; `migrate status` reports **“Database schema is up to date!”** for
  `prisma/financial` (1 migration) and `prisma/core` (55 migrations).
* Seeds verified live: 3 `financial.*` permissions, `financial/check-request` enabled,
  172 feature grants and 172 memberships (= every existing tenant; stop-guards passed).
* `package.json` gained `prisma:generate:financial` / `prisma:migrate:financial`; both
  aggregates include Financial. `docker-compose.yml`, `Dockerfile.backend`,
  `apps/api/.env` and `apps/api/.env.local` carry `FINANCE_DATABASE_URL`.

---

## 5. CheckRequest Domain

* Aggregate root `CheckRequest`; child `CheckAttachment` (bounded part of the request,
  same tenant by composite FK).
* Field provenance: every field of the brief's §4 list exists; the twelve
  cheque-instrument candidates (chequeNumber, serialNumber, bankAccount, bank, IBAN,
  SayadId, dueDate, signatory, issuedAt, deliveredAt, …) do NOT exist anywhere.
* **V1–V6** are service refusals with typed codes whose web mirror renders the source's
  own Persian sentence. **V7** conditional clearing runs BEFORE validation and title:
  salary clears orderReference+purchaseType+projectReference; petty cash clears
  orderReference only — exactly the source's save script (which does NOT clear
  `projectManagerUserId`, so F1 does not either; V5 is keyed on `PROJECT`, which the
  clearing already removed).
* **Title** is server-generated (`buildCheckRequestTitle`); **Requester** =
  `actor.userId` (machine context = 403); **requestDate** = server clock, never an input.
* **Purchase port**: `purchase-order-reference.port.ts` declares ONE method with NO
  implementation, NO provider binding and NO importer — an unbound token cannot be
  injected, so nothing can depend on a resolution that does not exist.

---

## 6. State Machine

```text
0 DRAFT ──submit──→ (staged through 1, atomically) ──→ 2 MANAGER_REVIEW
1 SUBMITTED/RETURNED ──submit──→ 2
2 MANAGER_REVIEW ──approve──→ 3 APPROVED   (terminal for F1; no downstream logic runs)
                  ──reject──→ 50 TERMINATED (terminal)
                  ──request-correction──→ 1 (requester re-owns; editable + attachments)
```

* **The 1→2 routing decision (the one real design fork):** the source's submit writes
  `c_status := 1; StateNext := 2` and a SharePoint workflow (outside both files) applied
  `StateNext`. F1 has no workflow engine and the brief fixes the capability set (§18) —
  there is no “forward” endpoint. `submit` therefore performs the source's two-step as
  ONE transactional unit (0→1→2, or 1→2 on a re-submit), each hop carrying its own
  conditional status predicate; a lost second hop rolls the whole transition back. State
  1 remains a real, observable state as the correction-landing where the requester
  re-owns the row (Preflight §7.4), fully editable with attachments, and it re-enters
  review through `submit`. After a fresh submit the row rests at 2, so every brief §19
  guard holds literally (decisions only from MANAGER_REVIEW).
* **State 3 executes NOTHING downstream** — `approve` writes status 3 + the decision +
  the audit event and stops (brief §12; asserted by `check-request.service.spec.ts`:
  “exactly ONE repository write … no allocation, no issuance”).
* **Concurrency**: every transition is a conditional UPDATE with the expected `from`
  status in its WHERE clause; rowcount 0 → the service re-reads and answers a typed 409
  (`CHECK_REQUEST_STATE_CONFLICT`) naming the current state. Double-submit and
  double-decision cannot both win, and the losing request records no audit event.
* Deferred states 4,5,6,7 and 8 are not members of the status set: no column value, no
  transition, no route, no UI branch can reach them.

## 7. Validation

| Rule | Source sentence (rendered by code) | Where enforced |
| --- | --- | --- |
| V1 issue type required | «نوع صدور چک انتخاب کنید!» | DTO `@IsIn` + service |
| V2 خرید requires purchase type | «نوع خرید را انتخاب کنید!» | service (source's else-if chain) |
| V3 PROJECT requires project | «عنوان پروژه را انتخاب کنید!» | service |
| V4 خرید requires order ref | «شناسه شماره سفارش ثبت گردد!» | service |
| V5 PROJECT requires manager | «مدیر پروژه انتخاب گردد!» | service |
| V6 requester from actor | «درخواست کننده انتخاب گردد!» | service (403 for a machine context) |
| V7 conditional clearing | — (rewrites the row, not an error) | service, BEFORE validation + title |

The else-if chain is the source's own (one blocking message per save, nested inside
`issueType !== SALARY`). Submit re-validates the STORED row — the source validated on
the state-1 forward too. No financial rule beyond these exists (Preflight §6.2: no
uniqueness, no amount, no date, no budget rule) and none was invented.

---

## 8. Authorization

* Routes: `@RequiresModule('financial')` + `@RequiresFeature('financial',
  'check-request')` + `ModuleEntitlementGuard` + `JwtAuthGuard`, declared exactly like
  Production's controllers.
* Remits: `financial.check.read` (list/detail/timeline/attachment reads),
  `financial.check.manage` (create/patch/submit/attachment writes),
  `financial.check.approve` (the three decision routes). One permission per route — an
  author can never reach a decision route through a permission they hold.
* Catalogue compatibility: the three names are the Preflight §14 candidates, checked
  against the catalogue's convention and registered + seeded in the same four-migration
  shape Production used. No other permission was added; SUPER_ADMIN receives them only
  through the standard `RolePermission` seed — no manual bypass exists anywhere.
* **Self-approval (brief §15)**: fail-closed — `actor.userId === row.requesterUserId` is
  a typed 400 (`CHECK_REQUEST_SELF_APPROVAL`); a machine actor (null user) cannot decide
  at all (403 `CHECK_REQUEST_DECIDER_REQUIRED`). The project manager id is
  membership-checked through `USER_DIRECTORY` before it is STORED. No hard-coded person,
  name or employee id appears anywhere in the module (U3 respected: no invented
  snapshot-approver rule — see §16).
* **Tenant isolation**: every repository call is `tenantId`-first; foreign ids are 404
  (indistinguishable from missing); the actor's tenant comes only from
  `RequestContextService` (403 when unresolved).

## 9. API Contracts

All under the global `api/v1` prefix; controller path `financial/check-requests`:

| Route | Permission | Guard notes |
| --- | --- | --- |
| `GET /financial/check-requests` | read | page/pageSize (≤100), status ∈ {0,1,2,3,50}, search on title |
| `GET /financial/check-requests/:id` | read | UUID v4 at the edge; 404 cross-tenant |
| `GET /financial/check-requests/:id/timeline` | read | scope bound server-side; 503 on `AUDIT_READ_FAILED`, never an empty page |
| `POST /financial/check-requests` | manage | 201; requester FORCED; forbidden fields refused |
| `PATCH /financial/check-requests/:id` | manage | states 0/1 only; empty patch = 400; 409 otherwise |
| `POST /:id/submit` | manage | {0,1} → 2, once; re-validates the stored row |
| `POST /:id/approve` | approve | 2 → 3 (deferred downstream) |
| `POST /:id/reject` | approve | 2 → 50 |
| `POST /:id/request-correction` | approve | 2 → 1 |
| `GET /:id/attachments`, `GET /:id/attachments/:aid/url` | read | reads work in every state |
| `POST /:id/attachments` (multipart) | manage | states 0/1; documentType required; 10 MiB + MIME allowlist |
| `PATCH /:id/attachments/:aid`, `DELETE …` | manage | states 0/1; bound to (tenant, request, attachment) |

**Forbidden wire fields (brief §17)** — `tenantId`, `requesterUserId`, `status`,
`nextState`, `managerDecision`, `managerComment`, `decidedAt/decidedByUserId`,
`requestDate`, `title`, `id`, `createdAt`, `updatedAt`, `actorId` and every
cheque-instrument name — are refused by the global `whitelist` +
`forbidNonWhitelisted` pipe (the Change-BOM pattern: a typed refusal naming the field)
and asserted field-by-field in `check-request.dto.spec.ts`.

---

## 10. Attachments

* Entity `CheckAttachment` — exactly the brief's §23 candidate fields, plus
  `fileName/mimeType/size` (the server-held values a signed URL needs) and
  `section = 2`.
* **Section scope**: only the request stage (source `Section = 02`). Sections 06/07 are
  deferred with their states; the `column` keeps the source's vocabulary so they arrive
  without re-keying.
* **Document types**: the eleven `c_NoeaSanad` values verbatim (source order),
  `documentType` REQUIRED on upload — the source's own gate («نوع سند انتخاب گردد.») —
  and NEVER required for any lifecycle transition (Preflight §9.3: not blocking).
* **Infrastructure**: the existing `IStorageProvider` port (MinIO); store-then-cleanup —
  object first, row second, object deleted if the row fails; row first on delete (a
  failed object delete leaves an inert orphan, logged — the correspondence contract).
  Metadata lives ONLY in `finance_db`; no cross-context storage record exists. The
  `storageKey` never leaves the server (downloads resolve to a short-lived URL with
  server-held name/type).
* **States**: managed only in 0/1 (typed 409 `CHECK_REQUEST_NOT_EDITABLE` otherwise);
  READS (list + download URL) work in every state — evidence stays visible to the
  manager at state 2 and after.
* Nothing is required to exist: the empty state is a legitimate answer.

## 11. Audit / Timeline

* ONE seam: `FinancialAuditGateway` → `AUDIT_PORT` → `core_db."AuditLog"`. No Financial
  audit table, no Prisma-side reconstruction — asserted by `financial-isolation.spec.ts`
  (§C: `AUDIT_PORT` in the gateway and nowhere else; no `auditLog.find*` anywhere).
* Actions (lowercase verbs, Production's convention): `create`, `update`, `submit`,
  `approve`, `reject`, `request_correction`, plus `attachment_upload/update/delete` —
  all with `resource = 'financial.check-request'` (one resource: the attachments are a
  bounded part of the request and correlate through `resourceId`).
* Payload covers: request id, actor (from the envelope), state transition
  (oldValue/newValue `status`), `success` (platform default true), `reason` where the
  platform carries one. Audit writes are best-effort (never fail a mutation).
* Timeline: `GET /:id/timeline` reads ONLY the port with
  `{tenantId, resource='financial.check-request', resourceId=row.id, page, pageSize}`;
  ordering is the platform's own (`createdAt ASC, id ASC`); pagination mirrors the BOM
  timeline (module page pair, ceiling enforced twice). Empty = `items: []`;
  `AUDIT_READ_FAILED` = 503; any other rejection = 422 — never a quiet empty page.

## 12. UI

Routes (thin wrappers, Production's shape):

```text
/admin/financial/check-requests            → CheckRequestListView
/admin/financial/check-requests/new        → CheckRequestFormView (create)
/admin/financial/check-requests/[id]       → CheckRequestDetailView
/admin/financial/check-requests/[id]/edit  → CheckRequestFormView (patch)
```

* Persian, RTL (app-wide layout), enterprise, `data-testid`-driven, state-aware; every
  read-only behaviour mirrors the backend (`editable = status ∈ {0,1}`, decisions only at
  2, state 3 shows exactly «تأیید شده — مرحله بعد در نسخه بعدی فعال می‌شود.», state 50
  terminal).
* The form's conditional fields mirror the source's VisibilityFormula: purchase type
  hidden for حقوق; order reference visible ONLY for خرید; project + manager visible only
  for «پروژه ای»; درخواست‌کننده/تاریخ/عنوان are read-only SERVER facts.
* Manager panel at state 2: the three source words (بله / خیر / نیازمند اصلاح است) as
  three ROUTES plus an optional comment.
* Attachments section: eleven-type select, upload, list, metadata edit, delete, download;
  empty state «هیچ سندی پیوست نشده است.»; frozen read-only outside states 0/1.
* Timeline section renders the audit verbs in Persian; an outage renders an error with
  retry, never an empty list.
* Navigation: NO sidebar entry was added — matching the Production precedent (its routes
  are also reachable by URL/direct links without a nav row); adding one is a platform-
  navigation decision outside F1.

---

## 13. Tests

**API — 7 new suites, 103 tests** (all green inside the full run):

| Suite | Pins |
| --- | --- |
| `check-request-status.spec.ts` | closed set {0,1,2,3,50}; no deferred member/name; editable = {0,1}; the full transition table incl. every refused pair; the source vocabularies with Persian labels |
| `check-request.spec.ts` | title shapes (exact + the documented PARTIAL project branch); 11 document types in source order; 9 audit actions; 18 typed refusal codes |
| `check-request.dto.spec.ts` | the §17 forbidden list field-by-field on create/update/decide/list/timeline/attachment payloads; V1 requiredness; column-width bounds; the decision DTO carries NO decision field |
| `check-request.service.spec.ts` | requester FORCED (forged/machine refused); V1–V5 chain in source order; V7 clearing for salary/petty cash; membership check; update guards + empty patch + race 409; submit routing + re-validation + double-submit; approve/reject/correction landings; self-approval; no-human-actor; invalid transitions; double-decision; tenant 404; list clamping; timeline binding + 503/422 + whitelist projection |
| `check-request.controller.spec.ts` | no route ungated (14 discovered); exactly one permission each; READ/MANAGE/APPROVE split; gates drawn from `Permissions`; entitlement from constants; actor resolved in every handler |
| `check-attachment.service.spec.ts` | object-before-row order; document-type gate; MIME/size refusals before storage; state freeze 409; foreign-request 404; storage-failure 500 with no row; row-insert failure cleans the object; machine uploader refused; reads in every state; cross-request attachment id 404; row-before-object delete; object-delete failure tolerated |
| `financial-isolation.spec.ts` | controller registration + full guard chain; one database (only `financial-client`); `AUDIT_PORT` in gateway only; `USER_DIRECTORY` in service only; no `AuditLog` reads; `AppModule` composes, `CoreAppModule` does not; NO Commerce/Production/HR import; the Purchase port has no adapter/binding/caller; no workflow/allocation/issuance surface; no cheque-instrument vocabulary |

**Web — 4 new suites, 24 tests** (all green inside the full run):
list (server filters, permission gate, empty/error states, row links), form (conditional
fields per source visibility, create payload contains only writable fields, V4 rendered
as the source sentence, save-before-route ordering, state-2 freeze, read-only requester),
detail (state 0 editable + attachments manageable; state 2 three routes each posting to
its own endpoint; state 2 without approve-permission = waiting note; state 3 deferral
message with NO allocation/issuance control; state 50 terminal; self-approval refusal
rendered; attachments+timeline endpoints), timeline (verbs, empty vs outage-vs-loading).

## 14. Verification

| # | Check | Result |
| --- | --- | --- |
| 1 | `prisma validate` (prisma/financial) | PASS — “The schema is valid” |
| 2 | `prisma generate` (financial client) | PASS — `src/generated/financial-client` |
| 3 | `migrate deploy` finance_db + core_db | PASS — all 5 migrations applied |
| 4 | `migrate status` (both schemas) | PASS — **Database schema is up to date!** (1 + 55 migrations) |
| 5 | API `tsc --noEmit` | PASS (exit 0) |
| 6 | Web `tsc --noEmit` | PASS (exit 0) |
| 7 | ESLint `src/modules/financial` | PASS (exit 0) |
| 7b | Web lint (`npm run lint` → `next lint`) | **PRE-EXISTING BLOCKER — reproduced, not F1's** — `next lint` answers “Invalid project directory provided, no such directory: E:\ERP\apps\web\lint” (the installed Next 16 no longer parses the subcommand this script uses), and running ESLint directly against `.eslintrc.js` fails in config load with “Converting circular structure to JSON” (`eslint-config-next` flat config under ESLint 8 eslintrc). Both reproduce with zero F1 files involved; F1's web code is gated by `tsc --noEmit` (strict) + jest instead — see §15.6 |
| 8 | API unit/contract suites (full) | PASS — **236 suites / 3883 tests** (incl. 7 new) |
| 9 | Architecture + policy + health suites | PASS — 8 suites / 127 tests |
| 10 | Web jest (financial) | PASS — 4 suites / 24 tests |
| 11 | Web jest (full) | PASS — **103 suites / 1751 tests** (one parallel run showed 3
pre-existing suites time out under CPU contention; each passes standalone — see §15) |
| 12 | Prettier check (all F1 files) | PASS |
| 13 | `runtime-policy.json` regenerated (`arch:policy`) | PASS — drift-free vs the matrix |
| 14 | Readiness / liveness / smoke (locally built `dist`, combined runtime on :4000 against the live dev cluster) | PASS — `GET /api/v1/live` **200** `{"runtime":"combined","status":"alive"}`; `GET /api/v1/ready` **200** with `"financeDatabase":"ok"` / `"financeDatabase":"required"` and `"blocking":[]` (rabbitmq/storage/observability are optional-degraded in the host environment, pre-existing); every financial route answers **401** unauthenticated — `GET/POST /api/v1/financial/check-requests`, `GET /:id`, `POST /:id/submit`, and a malformed `:id` alike, proving the routes are mapped and `JwtAuthGuard` is innermost |
| 15 | Migration state = up to date | PASS |

No test was skipped, no assertion weakened, no contract changed to go green.

---

## 15. Known Limitations

1. **The title's project branch is PARTIAL.** Source: `صدور چک برای {نوع} پروژه ای - {name}`
   where `{name}` is the project's NAME from SharePoint's «لیست پروژه ها». Ariya has no
   Project-name contract (Preflight §18), so F1 emits `صدور چک برای {نوع} پروژه ای` with
   the suffix OMITTED rather than faked with an opaque id. The unit test
   (`check-request.spec.ts`) asserts the partial shape on purpose so the test fails the
   day a contract arrives. **This is the case the brief asked to be called out: the exact
   source title is NOT fully reconstructible for PROJECT purchases only.** Salary and
   non-project titles are byte-exact.
2. **No sidebar/nav entry** for Financial (Production has none either) — routes are
   reachable directly; a nav row is a platform-navigation decision.
3. **The `docker-compose` API image does not yet contain F1** until an operator rebuilds
   `aria-erp-api`; verification was executed against a locally built `dist` (§14 row 14).
4. **One parallel web run** showed 3 pre-existing suites (HR mission ×2, blog create)
   exceeding jest timeouts while another suite ran concurrently; each passes standalone
   (66/66) and none touches Financial. The first full run (alone) was 103/103 green.
5. **`managerComment` from a previous decision** is overwritten by the next decision's
   comment (`null` clears it): F1 keeps exactly one decision record per row, mirroring
   BOM's single `comments` column rather than a decision history (the timeline is the
   history).
6. **The web lint pipeline is broken in this repository independent of F1** (reproduced
   before touching anything, see §14 row 7b): `next lint` mis-parses its subcommand under
   the installed Next 16, and direct ESLint cannot load `eslint-config-next`. Fixing the
   web lint toolchain is a platform task outside F1's scope; it is NOT counted as an F1
   failure and no F1 file was reformatted or silenced to work around it.
7. **`npm run build` on Windows fails at its `prebuild` step when a running process holds
   the Prisma engine DLL** (`EPERM … query_engine-windows.dll.node`): `rimraf dist
   src/generated` partially deletes the generated clients before failing. This is
   pre-existing repo behavior, not F1's. For the §14 row-14 verification the build was
   therefore run as `prisma generate (all eight) + nest build + the postbuild
   copy` — which is exactly what `npm run build` composes — and all eight generated
   clients were regenerated afterwards, so `tsc`, jest and the runtime all ran against
   complete clients. `npm run build` itself remains green once the holder process is
   stopped.

## 16. Deferred / Not Established

Every item below is recorded as **NOT ESTABLISHED / DEFERRED** and became NO behavior:

| Item | Status |
| --- | --- |
| U1 terminal semantics beyond F1's 50 | NOT ESTABLISHED — 50 is terminal here; nothing else is inferred |
| U2 state 5/3 correction discrepancy downstream | DEFERRED — states 5/3 have no workflow in F1 |
| U3 exact state-1 actor semantics | NOT ESTABLISHED — state 1 is guarded by the standard `financial.check.manage` remit, not by an invented actor rule |
| U4 `CheckHistory` writer/payload | NOT ESTABLISHED — the timeline reads the platform Audit Port only; no local history table |
| U5 self-approval | NOT ESTABLISHED in source → brief §15's fail-closed default applied |
| U12 cancellation actor semantics | DEFERRED — `RequesterOpinion.CANCEL` is recordable; NO cancel route exists |
| Purchase resolution contract | DEFERRED — interface only, no adapter/binding/caller |
| Project-name contract | NOT ESTABLISHED — drives only the §15.1 title limitation |
| Financial identity of the cheque instrument | NOT ESTABLISHED — no field, column, DTO or UI exists |
| Allocation / document review / executive approval / issuance / confirmation / delivery / Apply-complete | DEFERRED — states 3–7 unimplemented; state 3 is a marker only |
| Accounting journal / ledger | OUT OF SCOPE (brief §32) |

## 17. Purchase Integration Boundary

* `orderReference` is an opaque `VARCHAR(128)` on `CheckRequest` — never resolved.
* `purchase-order-reference.port.ts` declares `PURCHASE_ORDER_REFERENCE_PORT` +
  `PurchaseOrderReferencePort.resolve()` with NO adapter, NO provider binding and NO
  importer. `financial-isolation.spec.ts` §E asserts all three (an adapter file would
  fail the scan; an importer would fail the scan; the module source must not contain the
  binding token).
* No Commerce Prisma client, no Commerce HTTP call, no mock presented as a production
  dependency, and no query to `commerce_db` exists anywhere under
  `src/modules/financial/**` (§B of the isolation suite).

## 18. Files Changed

**API** — new: `prisma/financial/**` (schema + baseline migration); `src/modules/financial/**`
(14 source files + 7 spec files); 4 core migrations under
`prisma/core/migrations/202610031600{00..3}_…`.
Modified: `package.json` (scripts), `src/config/env.validation.ts`,
`src/runtime-datasources.ts`, `src/runtime-policy.json` (regenerated),
`src/health/health-tokens.ts`, `src/health/datasource-probe.registry.ts`,
`src/health/health.contract.ts`, `src/health/combined-health.module.ts`,
`src/health/health.service.spec.ts`, `src/health/readiness.evaluator.spec.ts`,
`src/app.module.ts`, `src/architecture-boundaries.spec.ts`,
`src/auth/rbac/constants/permissions.ts`, `apps/api/.env`, `apps/api/.env.local`.

**Infra** — `docker-compose.yml`, `infrastructure/docker/Dockerfile.backend`,
`infrastructure/postgres/initdb/01-create-databases.sql`.

**Web** — new: `src/lib/financial-api.ts`, `src/lib/financial-labels.ts`,
`src/components/financial/**` (5 components + shared ui + 4 spec files),
`src/app/admin/financial/check-requests/**` (4 route pages).

**Docs** — this report.

## 19. Commit Hash

* **Feature commit: `ef2a8cfe9be9f075d1c55d3ed1f8b4a59af1d8f0`**
  — `feat(financial): add check request foundation` (63 files, +10,381/−22).
* This report is committed in the follow-up documentation commit; `git log` shows both
  immediately after `ef2a8cf`.








