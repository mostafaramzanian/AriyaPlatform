# PHASE CHECK-ISSUANCE — CONFIGURABLE CHECK ISSUANCE WIZARD — IMPLEMENTATION REPORT

**Status:** `IMPLEMENTED — verified. Runs in §24; feature commit in §30.`
**Basis:** `docs/PHASE-FINANCIAL-CHECK-REQUEST-PREFLIGHT.md` (final preflight, §10–§17 on the
full workflow) + the two legacy sources `E:\Very Mohem\sooderCheck.txt` (request form) and
`E:\Very Mohem\kartabl SoderCheck.txt` (the workflow task screens for stages 3–7).
**Scope executed:** the COMPLETE configurable workflow — states `0 → 1 → 2 → 3 → 4 → 5 → 6
→ 7 → 8` plus the terminal `50`, driven by a PUBLISHED, FROZEN process definition
(`financial.check-issuance` v1) and a wire that reports available actions per row. The
executive «نیازمند اصلاح» value (state 5 → correction) is **DEFERRED / SOURCE-CONFLICT**
(§21) — deliberately no enum member, no transition, no route.

---

## 1. Preflight Confirmation

| Preflight / source evidence | Confirmed at implementation time |
| --- | --- |
| `c_status` vocabulary of the task screens: 3 تخصیص, 4 بررسی اسناد, 5 تایید ریاست, 6 صدور چک, 7 تحویل, 8 پایان | `CHECK_REQUEST_STATUS` = DRAFT 0, SUBMITTED 1, MANAGER_REVIEW 2, APPROVED 3, DOCUMENT_REVIEW 4, EXECUTIVE_APPROVAL 5, ISSUANCE 6, DELIVERY 7, COMPLETED 8, TERMINATED 50 — one closed set, one closed transition table |
| Allocation form fields (محل تخصیص / مانده / تاریخ چک / شرح / مبلغ چک / در وجه) | `CheckAllocation` — EXACTLY six writable columns + server-owned audit columns; NO field invented |
| Allocation V9/V10/V11 sentences | `CHECK_REQUEST_ALLOCATION_PLACE_REQUIRED`, `..._AMOUNT_REQUIRED`, `..._AMOUNT_EXCEEDS_BALANCE` — the source's own words, mapped in the web by code, never by sentence |
| Review screen words `تایید;اصلاح` (no reject exists) | `DocumentReviewDecision` = APPROVE / CORRECTION — two values, two buttons |
| Presidency screen `تایید;رد` (+ a third value that CONTRADICTS itself in the scripts) | `ExecutiveDecision` = APPROVE / REJECT; the third value is DEFERRED (§21) |
| Issue gate: «تصویر چک صادر شده بارگذاری نشده است!» + «گزینه تایید چک صادر شده انتخاب نشده است!» | Section 6 required-for `issue`; typed refusal codes with those exact sentences |
| Delivery gate: «تصویر رسید تحویل بارگذاری نشده است!» + «گزینه خاتمه صدور چک انتخاب نشده است!» | Section 7 required-for `deliver`; typed refusal codes with those exact sentences |
| NO cheque identity anywhere in the sources' forms | No bank / IBAN / cheque number / Sayad / dueDate / deliveredTo column, DTO field, route or control — §22 |
| Attachments never block the earlier transitions (Preflight §9.3) | Sections carry `requiredForActions` — empty for section 2, `['issue']` for 6, `['deliver']` for 7; the enforcement is data-driven, not special-cased |

## 2. The Configuration Platform (`src/platform/process/`)

The workflow is DATA, not code paths — so the platform that defines and validates such data
is generic, lives under `src/platform/`, and knows NOTHING about checks:

```text
apps/api/src/platform/process/
├── process-definition.model.ts         # the frozen shapes: ProcessDefinition, ProcessStep,
│                                       #   ProcessAction, ProcessActorPolicy, ProcessTransition,
│                                       #   ProcessDocumentSection, ProcessState
├── process-definition.ts               # pure helpers (stepForState, actionsForState,
│                                       #   documentSectionsForState, ...) + deepFreeze
├── process-configuration.validator.ts  # validateProcessDefinition + assertProcessPublishable
└── process-configuration.validator.spec.ts   # 13 tests — the platform's own contract
```

The validator is the PUBLISH GATE: it proves every transition's `fromState`/`toState`
exists, every step's and section's state belongs to the closed set, every action key
referenced by steps/sections is declared, every `permission` is well-formed
(`INVALID_PERMISSION`), a section's `allowedDocumentTypes` is either `null` (no vocabulary)
or non-empty (`INVALID_DOCUMENT_POLICY`), and terminals have no outgoing move.
`assertProcessPublishable` is what the definition module calls AT IMPORT — a malformed
definition fails the first test run, not a requester's afternoon.

## 3. Architecture Cleanup (prerequisite, same commit series)

* **`RbacModule` deleted from the domain modules** — `financial.module.ts` and
  `production.module.ts` no longer import or instantiate the RBAC composition module; the
  auth layer reaches them only through the platform guard seam. Both isolation specs now
  ASSERT the absence (`no RbacModule`), so a future re-import fails a test, not review.
* **`architecture-boundaries.spec.ts` now DERIVES ownership** from `DATASOURCE_OWNERS`
  (the single registry) instead of a hand-kept list — production and financial are covered,
  and a new tripwire fails on an "unowned schema" (an OWNED schema no module claims).
* **Root tooling completed**: `npm run db:migrate:production` and
  `npm run db:migrate:financial` now exist beside the other database commands;
  `infrastructure/docker/Dockerfile.backend`'s header documents the financial migration
  step the image runs.

## 4. The State Machine (`check-request-status.ts`)

The F1 module had three states and one landing; the phase EXTENDED the same pure module —
no parallel table, no second source of truth:

* **Closed set** `{0,1,2,3,4,5,6,7,8,50}`; **terminals** `{8, 50}`; **11 transitions**:

| action | from | to |
| --- | --- | --- |
| submit | 0 (DRAFT) | 2 |
| submit | 1 (SUBMITTED) | 2 |
| approve | 2 | 3 |
| reject | 2 | 50 |
| request-correction | 2 | 1 |
| allocate | 3 | 4 |
| document-review | 4 | 5 |
| document-review-correction | 4 | 1 |
| executive-approve | 5 | 6 |
| executive-reject | 5 | 50 |
| issue | 6 | 7 |
| deliver | 7 | 8 |

* **No `EXECUTIVE_REQUEST_CORRECTION` row** — the scripts contradict themselves on it
  (§21); a guessed transition would fabricate law.
* New vocabularies `DOCUMENT_REVIEW_DECISIONS = {APPROVE, CORRECTION}` and
  `EXECUTIVE_DECISIONS = {APPROVE, REJECT}` — the source's words, nothing else.

## 5. Permissions

* Four capabilities added to the catalogue: `financial.check.allocate`,
  `financial.check.review`, `financial.check.issue`, `financial.check.deliver` (beside F1's
  `read` / `manage` / `approve`). No other permission was invented, and none was widened.
* `permissions.ts` + `roles.ts` (SUPER_ADMIN, ADMIN) updated together so the catalogue,
  the role composition and the seed agree — and the core seed migration
  `20261004160000_seed_financial_check_stage_permission_grants` grants exactly those four
  to exactly those two roles.

## 6. The Published Definition (`check-issuance.definition.ts`)

`financial.check-issuance` **v1** — `status: 'published'`, frozen at import
(`assertProcessPublishable` + `Object.freeze`), resolved by `resolveCheckIssuanceDefinition`
(unknown version → the TOKEN refusal, never a silent fallback):

* **9 steps** — `request` (states 0/1), `manager-review` (2), `allocation` (3),
  `document-review` (4), `executive-approval` (5), `issue` (6), `delivery` (7),
  `completed` (8), `terminated` (50). Fields per step carry `states` + `editableStates`
  (e.g. the six allocation controls editable exactly at 3; section 2's window is 0/1).
* **11 actions** — submit, approve, reject, request-correction, allocate, document-review,
  document-review-correction, executive-approve, executive-reject, issue, deliver — each
  with its Persian label from the source and its permission.
* **Actor policies** — the six declared policies: `approver`, `executive`, `allocator`,
  `reviewer`, `issuer`, `deliverer`. Approver / executive / reviewer fail closed on
  self-acts (`forbidSelfApproval: true`); the recording acts (allocate/issue/deliver) carry
  capability + state + tenant only, because the source attaches no self-rule to them — none
  is invented (§21 records the deferral). The submit/manager act is expressed through the
  action's own `actorPolicy` reference.
* **Document sections** with `CHECK_ISSUANCE_SECTION` keys: section 2 `request-documents`
  (eleven source types, required for NOTHING), section 6 `cheque-image` (no vocabulary —
  `null`, not `[]`; required for `issue`), section 7 `delivery-receipt` (no vocabulary;
  required for `deliver`).
* **`extension.deferred`** — the machine-readable record of the executive-correction
  deferral (§21), so the omission is DOCUMENTED configuration rather than an accident.

## 7. Data Model (`prisma/financial/schema.prisma`)

* **`CheckRequest`** gains the process PIN: `processKey` (default `'financial.check-issuance'`)
  and `processVersion` (default `1`) — a row records WHICH definition governed it, so a v2
  can coexist with v1 rows without rewriting history.
* **`CheckAttachment.documentType` becomes NULLABLE** — sections 6/7 declare no vocabulary
  (the source's grids never asked for «نوع سند»), and `null` is the honest representation;
  an empty-string sentinel would have been an invented value.
* **Five stage tables**, each 1:1 with the request via a composite same-database FK
  `(tenantId, id)` — `CheckAllocation` (the source's six fields; money as digit strings),
  `CheckDocumentReview` (decision + comment), `CheckExecutiveApproval` (decision + comment),
  `CheckIssue` (`issuedCheckConfirmed`), `CheckDelivery` (`deliveryCompleted`). Two enums:
  `DocumentReviewDecision`, `ExecutiveDecision` — mirroring the closed vocabularies.
* **Migration** `20261004150000_check_issuance_stages` (6,530 bytes of SQL): alters
  `CheckRequest`/`CheckAttachment`, creates the five tables + FKs + indexes and the two
  enums. `npx prisma validate` is green for the financial schema AND for core.

## 8. Repository (`check-request.repository.ts`)

* `findByIdWithStages` — the detail read: the row PLUS its five stage records in one
  tenant-first query set; the wire's `stages` object is fed from here, never assembled by
  scattered reads.
* **`runStageTransition`** — the single atomic writer for every stage act: it performs the
  state `UPDATE … WHERE status = fromState` (rowcount 0 → `CHECK_REQUEST_STATE_CONFLICT`),
  inserts/updates the stage row, and returns the fresh aggregate — inside one transaction,
  so a concurrent double-submit can never write two stage rows.
* `countByRequestSection` — the evidence count behind section `requiredForActions` gating.

## 9. Service (`check-request.service.ts`)

* The five stage verbs, each mapped to its transition: `allocate`, `reviewDocuments`,
  `executiveDecision`, `issue`, `deliver` — plus `availableActions`, which answers from the
  PINNED definition + the row's state + the actor's permissions.
* **Shared guards** (no duplicated law): `requireSectionEvidence` (a section's
  `requiredForActions` is satisfied by ≥1 row in that section —
  `CHECK_REQUEST_ISSUE_IMAGE_REQUIRED` / `..._DELIVERY_RECEIPT_REQUIRED`),
  `ensureHumanDecision` (a decision needs a real actor —
  `CHECK_REQUEST_DECIDER_REQUIRED`), `ensureNotSelfActor` (the fail-closed policies —
  `CHECK_REQUEST_SELF_APPROVAL`).
* **`toDetailView`** — the read projection: row + `process` pin (with the step the definition
  resolves for the row's status) + `stages`; the per-request facts on the wire are exactly
  the columns, nothing derived.
* **Allocation V11** is enforced with **BigInt** comparison (`checkAmount <= balance` in
  ریال, 18 digits) — not floats; an ABSENT balance SKIPS V11, faithfully to the source's
  `parseInt('') → NaN` behaviour (the legacy script let an empty balance pass).

## 10. Controller (`check-request.controller.ts` + `check-process.controller.ts`)

* Six stage routes — `POST …/:id/allocate`, `…/document-review`, `…/executive-approval`,
  `…/issue`, `…/delivery` — plus `GET …/:id/available-actions` and the section-6/7
  upload/delete routes (`…/cheque-image`, `…/delivery-receipt`). Every route is gated by
  its OWN permission; the stage DTOs whitelist exactly the source's fields
  (`forbidNonWhitelisted` refuses anything else with a 400 naming the field).
* `CheckProcessController` — `GET /financial/check-process` returns the published definition
  (the wizard's single configuration source), read-gated like every Financial surface.
* **A real bug fixed during implementation**: `CHECK_ATTACHMENT_UPLOAD_OPTIONS` was declared
  BEFORE the imports that use it — a TDZ crash only visible at runtime; it now sits after
  the imports, with the ordering recorded beside it.

## 11. Attachment Service (`check-attachment.service.ts`)

Rewritten around CONFIGURATION, not ordinals: `requireManageableSection` (a section is
writable exactly while the definition's `states` window contains the row's state —
`CHECK_REQUEST_SECTION_UNAVAILABLE` otherwise), `parseSectionDocumentType` (typed sections
validate against their `allowedDocumentTypes`; untyped sections refuse a supplied type —
`CHECK_REQUEST_DOCUMENT_TYPE_NOT_ALLOWED` / `..._NOT_IN_SECTION`), and
`sectionRouteMismatch` (`CHECK_REQUEST_SECTION_ROUTE_MISMATCH` when a section-2 row is
addressed through a stage route). Sections 6/7 never ask for «نوع سند» — because the
configuration says they have no vocabulary.

## 12. DTOs

Five new payloads, each EXACTLY the source's controls and nothing more:
`AllocateCheckRequestDto` (allocationPlace required, checkAmount required, balance /
checkDate / checkDescription / payableTo optional), `DecideDocumentReviewDto`
(`decision: APPROVE|CORRECTION`, optional comment), `DecideExecutiveApprovalDto`
(`decision: APPROVE|REJECT`, optional comment — the third source value is
unrepresentable), `ConfirmCheckIssueDto` (`confirmed: true` — the source's checkbox),
`ConfirmCheckDeliveryDto` (`completed: true`). Numbers travel as digit STRINGS; no float
ever touches money.

## 13. API Tests (what changed, and what now fails on purpose)

* `check-issuance.service.spec.ts` (NEW, 21+ tests) — every stage verb: its transition, its
  guards (V9/V10/V11 including the BigInt boundary, evidence gates, self-actor refusals,
  state-conflict on the second submit), and `availableActions` per state and permission.
* `check-request-status.spec.ts` — the closed set, terminals, the 11 rows, and the
  ABSENCE of any executive-correction row.
* `check-request.spec.ts` / `check-request.dto.spec.ts` — new vocabularies and DTO
  whitelists (unknown fields refused by name).
* `check-request.service.spec.ts` — detail projection (pin + stages), section evidence,
  human-actor rule.
* `check-attachment.service.spec.ts` — sections 6/7: no-vocabulary refusal, window
  enforcement, route mismatch, evidence counting.
* `check-request.controller.spec.ts` — 21 handlers asserted route-by-route (method, path,
  guards), including `CheckProcessController`.
* `financial-isolation.spec.ts` — now counts TWO controllers and keeps the workflow ban
  (`no WorkflowModule / RbacModule`), plus no invented cheque-identity columns.
* `check-issuance.definition.spec.ts` (NEW, 21 tests) — the definition's own contract:
  9 steps / 11 actions / 6 policies / 3 sections / 11 transitions, frozen, resolvable.

## 14. Web API Client (`financial-api.ts`)

* `FinancialCheckRequestStatus` widens to `0|1|2|3|4|5|6|7|8|50`;
  `FinancialCheckRequest` gains DETAIL-ONLY `process` and `stages`;
  new types `FinancialCheckProcessView`, `FinancialCheckStages`,
  `FinancialCheckAvailableAction(s)`, `FinancialCheckProcessDefinition`,
  `AllocateFinancialCheckInput`, `FinancialDocumentReviewDecision`,
  `FinancialExecutiveDecision`; `FinancialCheckAttachment.documentType` becomes nullable.
* New functions: `fetchFinancialCheckProcess`, `fetchFinancialCheckAvailableActions`,
  `allocateFinancialCheckRequest`, `reviewFinancialCheckDocuments`,
  `decideFinancialExecutiveApproval`, `issueFinancialCheck`,
  `completeFinancialCheckDelivery`, `uploadFinancialCheckChequeImage`,
  `uploadFinancialCheckDeliveryReceipt`, `deleteFinancialCheckChequeImage`,
  `deleteFinancialCheckDeliveryReceipt` — one function per route, nothing generic.

## 15. Web Labels (`financial-labels.ts`)

* Full stage vocabulary: labels for 0–8 + 50 (state 3 is now «صدور فرم تخصیص» — the F1
  deferral sentence is GONE because the step exists), tones for every state,
  review/executive decision labels, the seven new audit-action labels
  (allocate/document_review/document_review_correction/executive_approve/
  executive_reject/issue/deliver).
* New refusal sentences — the SOURCE'S OWN WORDS, keyed by code: the three allocation
  validations, the two issue gates, the two delivery gates and the section refusals.
  Error mapping stays BY CODE, never by sentence.

## 16. The Configuration-Driven Wizard (`CheckRequestWizard.tsx`)

The detail screen is now a wizard that renders FROM configuration:

* **Zero status literals.** The current step is `definition.steps.find(s =>
  s.states.includes(request.status))`; panels switch on the resolved step KEY (a
  configuration value). The edit link keys off section 2's own `states` window; the
  document sections open/close by their configured windows; the stepper is
  `definition.steps.filter(visible)` with done/current/upcoming marking and `aria-current`.
* **Buttons come from the wire**: `GET …/available-actions` (labels, permission, and the
  actor-policy `enabled`/`reason`) filtered by the viewer's RBAC and rendered ONLY for the
  current step's actions — a disabled action shows its machine reason, a filtered one
  renders nothing.
* **Completed steps open READ-ONLY** (`financial-check-step-summary`) with the recorded
  stage data; a live form exists only on the current step.
* **Stage panels**: allocation (the six controls + the source's V9/V10 pre-checks),
  document-review (تایید/اصلاح), executive-approval (تایید/رد — the panel's button count is
  asserted to be EXACTLY two), issue (section 6 + the checkbox), delivery (section 7 +
  the checkbox), completed and terminated messages. Self-approval stays visible and reads
  the server's typed refusal.
* `CheckRequestDetailView.tsx` remains the exported route component — now a thin wrapper
  over the wizard, so every existing import stays valid.

## 17. Web Attachments (`CheckRequestAttachments.tsx`)

One component per CONFIGURED section: a `section` filter (rows of other sections never
leak into the grid), a `title` from the definition, and pluggable `uploader`/`remover` —
sections 6/7 pass their STAGE routes and, as the configuration declares no vocabulary, the
«نوع سند» picker is absent there while section 2 keeps the eleven source types and the
metadata edit flow.

## 18. Web Tests

* `CheckRequestWizard.spec.tsx` (NEW, 9 tests) — enforces the phase's promises: V9/V10
  pre-checks fire with the SOURCE sentences and never reach the wire; each stage act calls
  its OWN route with its own payload; the executive panel has EXACTLY two decisions; the
  issue/delivery checkboxes gate with their source sentences; a completed step opens
  read-only (live form gone) and the back control restores it; an `enabled: false` action
  renders disabled with its reason and cannot fire; section 6 renders WITHOUT the «نوع سند»
  picker; a missing configuration shows the error state and NO stepper.
* `CheckRequestDetailView.spec.tsx` — retargeted to the new contract: the process and
  available-actions endpoints are mocked; state 3 now asserts the ALLOCATION panel (and
  the OLD deferral message's absence — the phase implemented what F1 deferred); state 0/1
  edit link + attachments; state 2 decision routes; state 50 read-only; self-approval
  refusal text.
* `CheckRequestFormView.spec.tsx` / `CheckRequestListView.spec.tsx` /
  `CheckRequestTimeline.spec.tsx` — green unchanged where behaviour is unchanged.

## 19. Migrations & Seed

* `prisma/financial/migrations/20261004150000_check_issuance_stages/migration.sql` —
  the five stage tables, the two enums, the pin columns, the nullable `documentType`, FKs
  and indexes.
* `prisma/core/migrations/20261004160000_seed_financial_check_stage_permission_grants/` —
  seeds the four new stage permissions to SUPER_ADMIN + ADMIN.
* Both schemas validate (`npx prisma validate`), the financial client is regenerated, and
  the operational commands are the repo's own: `npm run db:migrate:financial`,
  `npm run db:migrate:core`.

## 20. Isolation & Boundary Guarantees

* Financial still owns `finance_db` exclusively (only `FinancialPrismaService` touches it);
  the stage tables live in the SAME project and database — no cross-schema join anywhere.
* The financial module imports NO workflow engine and NO RBAC composition module; the
  isolation spec asserts both absences as text, not as intent.
* Controllers are the only HTTP surface; the process definition read is a CONTROLLER route,
  so the wizard never reaches into a service private to the module.

## 21. Deferred / Source-Conflict Items (recorded, not guessed)

* **Executive «نیازمند اصلاح» (state 5 → correction)** — the raw scripts CONTRADICT each
  other (one sets `StateNext = 6` while the display state column says 3). There is NO enum
  member, NO transition row, NO route, NO button; the deferral is recorded in the
  definition's `extension.deferred` (`executive-request-correction = SOURCE-CONFLICT …`)
  and asserted by the status/definition specs. This is the phase's only
  knowingly-unimplemented source value.
* **Requester cancellation (F1's U12)** — still recordable ("لغو کامل گردش درخواست") with
  no route, exactly as F1 left it.

## 22. Field Fidelity — Nothing Invented

There is no bank, IBAN, Sayad code, cheque serial, due date, «تحویل‌دهنده», signature or
tracking field anywhere: not in the five stage tables, not in a DTO, not on a route, not in
the wizard. The isolation spec greps the schema for the forbidden names; the wizard's own
spec asserts the deceased F1 control ids stay absent from stages that never had them
(`financial-check-sayad`).

## 23. Operational Notes

* Money is DIGIT STRINGS end-to-end (DTO → BigInt comparison → String column → Persian
  rendering); the web renders with `toPersianDigits` only at display time.
* The process pin (`processKey` + `processVersion` per row) is what makes a future v2 a
  DATA migration, not a code rewrite: the wizard renders whatever the PINNED version says.
* `availableActions` is the single source of truth for what a screen may offer — the UI
  does not re-derive legality from the ordinal.

## 24. Verification — Exact Runs

| Gate | Command | Result |
| --- | --- | --- |
| API full regression | `npx jest --runInBand` (apps/api) | **239 suites / 3,945 tests — all passed** |
| API targeted (financial + platform/process + architecture-boundaries + runtime-policy) | `npx jest financial process architecture-boundaries runtime-policy` | 214 tests passed |
| API typecheck | `npx tsc --noEmit` (apps/api) | clean |
| Web typecheck | `npx tsc --noEmit` (apps/web) | clean |
| Web full regression | `npx jest` (apps/web) | **104 suites / 1,760 tests — all passed** |
| Prisma schemas | `npx prisma validate` (financial, core) | both valid |

Note: one earlier web run reported five failing suites. Three were unrelated HR/Core
suites that fail only under full-parallel CPU contention (they pass in isolation: 74/74);
the two financial failures were real and were fixed in this phase (the edit link must key
off the REQUEST section's window, not "any editable field"; the load-error branch now
carries the standard error test id).

## 25. Change Inventory (feature commit)

**API — modified:** `financial/schema.prisma`, `architecture-boundaries.spec.ts`,
`permissions.ts`, `roles.ts`, the check-request module's
status/entity/dto/repository/service/controller + their specs,
`check-attachment.repository.ts`, `check-attachment.service.ts` + spec,
`financial-isolation.spec.ts`, `financial.module.ts`, `production-isolation.spec.ts`,
`production.module.ts`; root `package.json`; `infrastructure/docker/Dockerfile.backend`.
**API — new:** `src/platform/process/*` (4 files),
`src/modules/financial/process/check-issuance.definition.ts` + spec,
`check-request/check-process.controller.ts`, `check-request/check-issuance.service.spec.ts`,
`prisma/financial/migrations/20261004150000_check_issuance_stages/`,
`prisma/core/migrations/20261004160000_seed_financial_check_stage_permission_grants/`.
**Web — modified:** `financial-api.ts`, `financial-labels.ts`,
`CheckRequestAttachments.tsx`, `CheckRequestDetailView.tsx`,
`__tests__/CheckRequestDetailView.spec.tsx`, `__tests__/CheckRequestFormView.spec.tsx`.
**Web — new:** `CheckRequestWizard.tsx`, `__tests__/CheckRequestWizard.spec.tsx`.

## 26. Sequence — How the Phase Was Built (and verified at each step)

1. Architecture cleanup (RbacModule out, boundaries derived, root scripts) — arch suite green.
2. Process platform + validator — 13 tests green.
3. State machine extension + permissions + seed — status/permission specs green.
4. The published definition — its 21-test contract green.
5. Data model + migration + client regeneration — `prisma validate` green.
6. Repository/service/controller/attachment rewrite — targeted API suites green;
   typecheck clean.
7. Full API regression — 239/3,945 green.
8. Web client + labels + wizard + component specs — web typecheck clean; targeted web
   suites green.
9. Full web regression — 104/1,760 green.
10. This report; then the feature commit; then the documentation commit that carries this
    file (the F1 report's own convention).

## 27. What the Wizard Deliberately Does NOT Do

* It never WRITES a status: every mutation is a route whose service owns the transition.
* It never DERIVES a button from an ordinal: buttons are wire-declared actions.
* It never invents a control for a deferred value (§21) — the executive panel renders
  exactly the two decisions the machine can serve.
* It never hides a self-approval button: the refusal is read from the server.

## 28. Reviewer Checklist (how to falsify this report quickly)

1. `grep -n "status ===" apps/web/src/components/financial/CheckRequestWizard.tsx` → the
   ONLY hit is the header comment that documents the absence; there is no status-ordinal
   branch (configuration lookups only).
2. `grep -rn "chequeNumber\\|iban\\|sayad\\|deliveredTo" apps/api/prisma/financial` → the
   ONLY hits are comments recording the ABSENCE (Preflight §10 note; «No deliveredTo /
   deliveryDate / signature»); no column exists.
3. `grep -n "executive-request-correction" check-issuance.definition.ts` → the deferral
   NOTE in `extension.deferred` and the "NO transition" comment; no enum member, no row.
4. `npm run test:architecture --workspace=apps/api` → 57 boundary tests green.
5. `npx prisma validate` in `apps/api` for both schemas.
6. `npx jest CheckRequestWizard --silent` in `apps/web` → 9 tests green.

## 29. Known Limitations

* Three unrelated web suites (HR policy panel, two Core screens) are CPU-contention-flaky
  under a full-parallel run; each passes in isolation and none touches Financial (§24).
* The seed migration adds grants to SUPER_ADMIN/ADMIN only — role design beyond that is
  the tenant's own configuration surface, not this phase's decision.
* The wizard treats the configuration as READ-ONLY: editing/versioning definitions is a
  separate administrative phase.

## 30. Commit

* **Feature commit: `2a7753abf50344173ec2340fe1598a990c40981f`**
  — `feat(financial): add configurable check issuance wizard` (42 files, +6,739/−634).
* This report is committed in the follow-up documentation commit; `git log` shows both
  immediately after the F1 checkpoint `ef2a8cfe` / `e205f7e`.





