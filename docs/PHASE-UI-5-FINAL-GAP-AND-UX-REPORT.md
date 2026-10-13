# PHASE UI-5 — FINAL COMMERCE GAP AND UX REPORT

**Phase:** UI-5 (final Commerce frontend phase) · **Repository:** `E:\ERP` · **Authoritative UX
contract:** `docs/PHASE-UI-0-COMMERCE-UX-CONTRACT.md`

UI-5 built no new screen. It re-verified every backend gap against the *current* source,
integrated the one capability that is genuinely available (the Core directory search), ran a
final consistency / hierarchy / navigation audit over the whole Commerce surface, and proved
the complete journey in a real browser. This file is the evidence record.

---

## A. PRE-IMPLEMENTATION FINDINGS

| Finding | Evidence |
|---|---|
| Baseline green before any UI-5 edit | `npx jest --silent` → **87 suites / 1589 tests** (`.tmp/ui5-jest-baseline.log`); `npx tsc --noEmit` → clean (`.tmp/ui5-tsc-baseline.log`). |
| The backend did **not** change since UI-4 | HEAD `c0fab92`; `apps/api/**` untouched by this phase (§X). |
| The running API exposes exactly **44 Commerce routes** in 6 controllers | `commerce.module.ts` registers `PurchaseController`, `WorkflowConfigurationController`, `CommercialController`, `PaymentHistoryController`, `ReceivingHistoryController`, `ReturnHistoryController`; full route table enumerated below. |
| The seeded administrator's identity is **not a UUID** | JWT `sub = "super-admin-user"` while `CreatePurchaseDocumentDto.requesterId` is `@IsUUID('4')` — the historical **GAP-8 seed mismatch**, reproduced live. |
| The seeded **QA Decider** (`ui3-qa-decider@example.com`, UUID v4) holds every commerce permission plus `admin.users.read` and is the liaison of the PUBLISHED commercial configuration | `/rbac`, `/commerce/commercial-configurations` (`UI3-QA`, `approvalActivation=PURCHASE_SUBMITTED`, `approvalApprover=LINE_COMMERCIAL_LIAISON`). |
| The Docker web image is **stale** (built 2026-09-13) while the API image was rebuilt today | `docker inspect aria-erp-web` / `aria-erp-api`. Browser QA therefore targets a dev server running from the **current source tree** — the only honest way to test uncommitted UI work. |

---

## B. BACKEND GAP RE-VERIFICATION (zero-guess, from source)

Classification key: **STILL OPEN · CLOSED · PARTIALLY CLOSED · UNKNOWN**.

| Gap | State | Evidence (current source) |
|---|---|---|
| **GAP-1** workflow execution HTTP surface | **STILL OPEN** | No controller for `commerce/workflow-instances`. `WorkflowExecutionService` exposes `approveStep` (approve-path only) and is reachable **only from e2e probe controllers** (`commerce-integration.e2e-spec.ts`, `commerce-lifecycle.e2e-spec.ts`). The N-contract §11 routes (`GET …/workflow-instances[/:id]`, `POST …/steps/:stepInstanceId/decision`, `POST …/cancel`) do not exist. |
| **GAP-1b** tenant-wide "pending decisions for me" | **STILL OPEN** | `GET commerce/commercial-approvals` requires `documentId` (`CommercialDocumentQueryDto`); no `approvals/pending` route in the 44. |
| **GAP-2** line-routing configuration HTTP surface | **STILL OPEN** | `WorkflowLineRoutingConfigurationService` is referenced by **specs and e2e tests only** — no controller, no route prefix. |
| **GAP-3** `PurchaseDocument → CLOSED` | **STILL OPEN** | `purchase-status.ts`: `PURCHASE_DOCUMENT_TRANSITIONS.CLOSED = Object.freeze([])` with the comment «`→ CLOSED` IS DELIBERATELY ABSENT (§11)». No close route on `purchase.controller.ts`. |
| **GAP-4** Commerce KPI/summary endpoint | **STILL OPEN** | No `…/summary` route among the 44. |
| **GAP-5** Commerce-wide search | **STILL OPEN** | `GET /search` exists, but its `SearchSourceType` is `TICKET · TICKET_COMMENT · SURVEY · MESSAGE · CONVERSATION · NOTIFICATION · REMINDER · USER` — no commerce source, no indexer entry. |
| **GAP-6** quotation / confirmation surfaces | **STILL OPEN (by design)** | `commerce.commercial.manage` is catalogued and seeded but referenced by **zero routes**; C1 §9 defers quotation entry. |
| **GAP-7** document audit / timeline endpoint | **STILL OPEN** | Audit rows are written through `CommerceAuditGateway` into platform `AuditLog`; no commerce read route exposes them. |
| **GAP-8** requester/member search + **seed UUID mismatch** | **PARTIALLY CLOSED** | Directory search exists (`GET /users/directory?q=`, gated by `admin.users.read`). The mismatch is real: `super-admin-user` is a tenant member whose id **no** commerce DTO accepts (`@IsUUID('4')` on `requesterId`, `liaisonUserId`, `approverUserId`, `actorUserId`). |
| **GAP-9** per-user Commerce notification contract | **STILL OPEN** | Only two platform events exist (`commerce.purchase_document.submitted`, `commerce.workflow.line.routed`) through `CommerceNotificationGateway`; no user-addressed commerce notifications. |
| **GAP-ENV** environment / deployment entry point | **NOTED (operator action)** | Docker `aria-erp-web` predates every UI phase; a Next dev server refuses a second instance per directory, so UI-5 reused the live `:3003` server running from the current tree. |

### B.1 — Frontend impact and the honest UX that remains

- **GAP-1 / GAP-1b.** No workflow tab, stepper, actor or approver exists anywhere in the UI.
  Purchase Detail discloses the gap in words («جزئیات گردش کار از طریق سرویس‌های فعلی در دسترس
  نیست») and My Tasks keeps UI-0 §8.1's **Option A**: it scans the latest page of SUBMITTED
  documents, states its bound («ممکن است موارد خارج از این بازه در آن نباشند» + the cap note)
  and never claims «همه کارهای شما». Both statements are pinned by
  `CommerceFinalHonesty.spec.tsx`.
- **GAP-2.** Settings offers no line-routing configuration and nothing in the UI implies it
  exists; the deferred-needle scan fails the build if `line-routing` ever appears as a call.
- **GAP-3.** The `CLOSED` word exists in the status vocabulary, but no screen renders a control
  that could produce it (scan: no `close-document`, «بستن سند», «بستن درخواست»).
- **GAP-4.** Home counters come from **list totals only** (one-row window), so they are server
  facts; there is no spend/average/KPI figure anywhere and no multi-page aggregation.
- **GAP-5.** The only search in Commerce is the register's server-supported `search` param
  (document number) plus its status/requester filters, with the Persian empty state. No fake
  global search, no client-side scan of the corpus.
- **GAP-6.** No quotation/confirmation/correction UI exists or is implied.
- **GAP-7.** The detail's «رویدادها» tab lists only read-derived milestones and discloses its
  own provenance («تاریخچهٔ کامل ممیزی از طریق Commerce در دسترس نیست»). Observability is never
  queried as a substitute; nothing is reconstructed from unrelated tables.
- **GAP-8 (the integrated gap).** See §C — the directory search is now the requester's real
  input, and the seed mismatch is handled explicitly in both grant branches.
- **GAP-9.** No Commerce notification centre; the platform bell is untouched. The "needs me"
  surfaces are My Tasks and the new Purchase Detail callout, both driven by the document-scoped
  approvals read the backend already answers.
- **GAP-ENV.** `phaseui5-visual-qa.mjs` documents `QA_BASE` / `QA_API` / `QA_EMAIL` /
  `QA_PASSWORD` / `QA_CHROME`, exactly like the UI-3/UI-4 harnesses. Rebuilding `aria-erp-web`
  from the current source is the deployment-side follow-up once the UI work is committed.

---

## C. CAPABILITIES NEWLY AVAILABLE, IF ANY

| Capability | State | What UI-5 did |
|---|---|---|
| `GET /users/directory?q=` member search | **Available (GAP-8 partial)** | Integrated as the requester's real input on Purchase Create/Edit, reusing the UI-4 `CommerceMemberPicker` (§20 of the phase prompt: "IF yes → improve requester/liaison selection"). Gated on the route's own `admin.users.read`. |
| Everything else (GAP-1, 1b, 2, 3, 4, 5, 6, 7, 9) | **Not available** | Nothing was integrated, nothing was emulated; each stays documented as deferred. |

No backend file was created or modified in UI-5 (§X proves it).

---

## D. FILES CREATED

| File | Purpose |
|---|---|
| `apps/web/src/components/commerce/__tests__/CommerceFinalHonesty.spec.tsx` | Executable final gate: no `tenantId`, no Prisma/backend import, no browser-side rule/workflow evaluation, only real route prefixes, no deferred-gap call, no Close control, one vocabulary, logical CSS only, link-to-route coherence, the gap disclosures themselves. |
| `apps/web/src/components/commerce/__tests__/CommerceMemberPicker.spec.tsx` | The picker's UI-5 guarantees: non-UUID members are never offered, the "found but unusable" wording, `allowClear={false}`, and the no-grant limitation branch issuing no request. |
| `apps/web/phaseui5-visual-qa.mjs` | Final browser QA over the whole journey (scenarios 1–7 + settings + responsive matrix). |
| `docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md` | This report (§38 of the phase). |

## E. FILES MODIFIED

| File | Change |
|---|---|
| `CommercePurchaseCreateView.tsx` | Requester = directory picker **or** read-only statement (never a raw UUID field); non-UUID session ids start *unselected* with a Persian reason; two human validation messages; unified «بازگشت به فهرست درخواست‌ها»; doc header records the UI-5 decision. |
| `CommercePurchaseCreateView.spec.tsx` | Requester assertions moved to the picker/panel; new tests: real directory search selects the requester (payload carries the chosen id), no directory call without the grant, and the non-UUID-seed case. |
| `CommercePurchaseDetailView.tsx` | **Pending-decision callout** in the header (document-scoped approvals read + `pendingApprovalsForUser`), opening the Commercial tab; **targeted invalidation** of assignments/approvals after submit (the server just created them); unified back-link label; doc header records the UI-5 decision. |
| `CommercePurchaseDetailView.spec.tsx` | New: the callout appears for the *right* user, opens the Commercial tab, and never appears for someone else's decision or without `commerce.approve`; submit now asserts exactly two sections refetch. |
| `CommercePurchaseListView.tsx` | CTA «درخواست جدید» → **«درخواست خرید جدید»** (same words as Home and the form title). |
| `settings/CommerceMemberPicker.tsx` | `allowClear` prop (requester cannot be cleared into an invalid state); results filtered to UUID-v4 ids; «اعضای یافت‌شده برای این فیلد شناسهٔ قابل استفاده ندارند.» wording. |
| `purchase/CommerceCommercialDecisionPanel.tsx`, `purchase/CommerceReturnsSection.tsx`, `settings/CommerceCommercialConfigurationSettings.tsx` | Terminology normalization: «سند خرید» → «سند درخواست خرید» (8 sentences). |
| `__tests__/CommerceCommercialDecision.spec.tsx`, `__tests__/CommerceDetailSections.spec.tsx` | The two confirmation assertions updated to the canonical term. |

**Deliberately NOT modified:** any `apps/api/**` file, any dependency manifest, navigation
mirrors (`core-nav.ts`, `nav-catalogue.ts` — their modifications in `git status` predate UI-5
and belong to UI-1…UI-4), and every Core/HR surface.

---

## F. UX CONSISTENCY CHANGES (only real inconsistencies)

1. **One term for the document.** «سند خرید» appeared in 8 confirmation/consequence sentences
   beside the canonical «سند درخواست خرید» of the detail header — a third synonym for the same
   thing. All 8 now read «سند درخواست خرید» (decision panel ×3, returns ×4, commercial
   configuration ×1), and `CommerceFinalHonesty.spec.tsx` fails if it ever returns.
2. **One create action.** Home said «درخواست خرید جدید», the form title said it, and the
   register's CTA said «درخواست جدید». Now identical on all three, pinned by a test.
3. **One back action.** Detail said «فهرست درخواست‌ها», Create said «بازگشت به فهرست» → both
   now «بازگشت به فهرست درخواست‌ها».
4. **No raw-UUID field.** (see §C) — the single worst comprehension defect in the journey.
5. **Nothing else was redesigned.** Spacing, cards, empty states, dialogs, tables, pagination
   and focus behaviour were audited and left alone where already consistent.

## G. HOME / TASKS — FINAL STATE

- **Home** is task-first: three server-total counters, the register/task shortcuts, the five
  latest documents. No KPI, no spend figure (GAP-4), server totals only.
- **My Tasks** keeps Option A with its disclosure and cap note; never «همه کارهای شما»; every
  actionable row answers *what / why / state / what can I do* (document number, line label,
  document + approval badges, «مشاهده و تصمیم‌گیری»).

## H. PURCHASE JOURNEY — FINAL STATE

Home → register → create (3 steps) → save draft → edit → review → submit → detail →
commercial decision → payments → receiving → return, all exercised **in the browser**
(`PR-1405-00005` in run 4). The user is never stranded: every successful mutation answers with
a Persian sentence and the refreshed state. Workflow execution is *not* claimed as part of the
journey (GAP-1) and the detail says so in words.

## I. PURCHASE DETAIL — FINAL STATE

Header = identity + status + hint + **primary action**. The UI-5 callout answers «چه کاری
می‌توانم انجام دهم؟» for a pending decision assigned to *this* user, from data the page
already reads — no new request, no invented assignee — and opens the Commercial tab. Seven
tabs, each with its own loading/error/empty state; independent lifecycle cells never collapse
into one status; submit now refreshes exactly the two sections it changed.

## J. COMMERCIAL DECISION — FINAL STATE

Identical experience from My Tasks (deep link) and from the detail (callout → tab): one panel,
focus on open, consequence-first confirmation, comment preserved on refusal, success shown from
the server response, stale 409 explained in Persian with the typed comment preserved and the
record refreshed.

## K. PAYMENT / RECEIVING / RETURN — FINAL STATE

- **Payments:** append-only; compensation is a separate dialog (focus trap + Escape + focus
  restoration) that **appends** a row — proven in the browser (2 → 3 rows).
- **Receiving:** event semantics hold; partial receipt reflected in the progress; over-receipt
  refused with the server's own quantities in Persian («این دریافت از مقدار سفارش‌داده‌شده بیشتر
  است (سفارش: ۲، دریافت‌شده: ۱، درخواستی: ۹۹۹٫۰۰۰۰)»); compensation is its own event.
- **Returns:** child lifecycle proven end-to-end in the browser
  REQUESTED → APPROVED → RECEIVED_BACK → REFUNDED, with the refund consuming the real payment
  history and «سند درخواست خرید تغییری نمی‌کند» stated in every confirmation.

## L. SETTINGS — FINAL STATE

`تنظیمات → تدارکات و فرآیند خرید` renders as a product area with three named sections (فرآیندها /
بازرگانی / گروه‌ها), no engine row names as primary UX, published = immutable sentence, draft =
editable sentence, save gated until dirty. No line-routing panel (GAP-2) and no raw developer
console.

## M. WORKFLOW FINAL STATE

Configuration-only, exactly as UI-4 built it; UI-5 re-verified there is **no runtime surface**
and pinned that absence in tests. No workflow decision UI exists or is implied.

## N. SEARCH / NOTIFICATION / AUDIT — FINAL STATE

Search = the register's server-supported `search` param only. Notifications = untouched platform
bell; no Commerce notification centre. Audit = read-derived «رویدادها» with an explicit
disclosure; never Observability, never reconstructed.

## O. RTL / ACCESSIBILITY — FINAL STATE

`dir="rtl"` + `lang="fa"` asserted per screen in the browser; **logical CSS only** (no `ml-/mr-/
pl-/pr-`, no `text-left/right`, no `border-l/r`, no physical `left-/right-`) enforced by source
scan; WAI-ARIA tablists with roving tabindex and RTL-aware arrow keys (jsdom) and native
buttons/dialogs with focus restoration (browser).

## P. RESPONSIVE — FINAL STATE

Overflow measured on home / register / detail / create / settings at **390, 768, 1024, 1280,
1440, 1920** — `scrollWidth − innerWidth ≤ 1` everywhere, plus RTL+`fa` at the mobile and tablet
widths (§S).

## Q. ERROR / CONFLICT — FINAL STATE

One ladder (`commerceActionErrorMessage`): known refusals → their Persian sentence with the
server's quantities, then HTTP class (400/403/404/409/5xx), then the caller's neutral fallback.
409 always reads «وضعیت … تغییر کرده است؛ وضعیت را بازخوانی کنید»-shaped copy; network failure
keeps the form; technical detail is never the primary message (browser-proven in §S).

## R. PERFORMANCE — FINAL STATE

Source scan over all Commerce UI + lib files: **zero** `setInterval`, `setTimeout`, hard
reloads, recursive fetch or unbounded scans; **zero** polling anywhere (§34). Every screen
issues its reads once per activation with the `active`-flag cancellation pattern the codebase
already uses; refetches are token-driven and section-scoped (a mutation re-reads only what it
changed — and, from UI-5, submit re-reads exactly assignments + approvals). Home uses four
one-row reads (server totals) instead of aggregating pages.

## S. BROWSER QA RESULTS

`node phaseui5-visual-qa.mjs` (dev server from current source, `QA_BASE=:3003`,
`QA_API=:3001/api/v1`, session = `ui3-qa-decider@example.com`):

> **SUMMARY :: 113 passed, 0 failed, 113 total** — `.tmp/ui5-qa5.log`, 23 screenshots in
> `apps/web/phaseui5-shots/`.

Coverage: home (4) · register (5, incl. server search, Persian empty state, clear filters) ·
create (5, incl. directory search selection and *no raw UUID on the form*) · edit (4) ·
submit/detail (3 + callout + workflow disclosure + 7-tab walk) · tasks (4) · decision (3,
incl. focus entry) · stale 409 (3, incl. preserved comment) · payments (7, incl. dialog focus,
Escape, focus restoration, append-not-delete) · receiving (5, incl. the over-receipt refusal
with server quantities) · returns (5, REQUESTED → APPROVED → RECEIVED_BACK → REFUNDED + receipt
compensation) · settings (3 + workflows 3 + versions + editor + commercial) · responsive matrix
(5 routes × 6 widths = 30 overflow checks + 10 RTL/`fa` checks at 390/768).

## T. END-TO-END USER SCENARIOS

| Scenario | Result | Evidence |
|---|---|---|
| 1 — Requester: home → create → 2 lines → draft → edit → submit → detail | **PASS** | `PR-1405-00006` (run 5), `create-*` / `detail-*` screenshots; the requester was chosen from the directory («QA Decider»), never typed. |
| 2 — Commercial user: tasks → pending decision → deep link → decision → confirm → success → task gone | **PASS** | `tasks-pending-desktop.png`, `decision-panel-desktop.png`, `decision-success-desktop.png`; the approvals re-read shows 0 pending afterwards. |
| 3 — Payment: append → verify → compensate → append-only history (1 → 2 → 3 rows) | **PASS** | `payments-history-desktop.png`. |
| 4 — Receiving: partial → over-receipt refused in Persian → compensate | **PASS** | `receipts-partial-desktop.png`, `receipts-over-receipt-desktop.png`, `receipts-compensated-desktop.png`. |
| 5 — Return: create → approve → receive-back → refund | **PASS** | `returns-refunded-desktop.png` (`commerce-return-state-REFUNDED`). |
| 6 — Administrator: settings → تدارکات و فرآیند خرید → workflows → versions → draft editor → commercial | **PASS** | `settings-*.png`. |
| 7 — Stale state: page open → API decides → UI acts → 409 → Persian explanation + preserved comment | **PASS** | `decision-stale-409-desktop.png`. |

## U. TEST RESULTS

| Gate | Baseline (UI-4) | UI-5 final |
|---|---|---|
| Full web Jest | 87 suites / 1589 tests | **89 suites / 1613 tests — all passing** (`.tmp/ui5-jest-final.log`) |
| Commerce subset (targeted + commerce + lib) | — | 16 suites / **237 tests** passing (`.tmp/ui5-jest-r3.log`) |
| New specs | — | `CommerceFinalHonesty.spec.tsx` (15 tests: security scan, route allow-list, deferred-gap needles, vocabulary, logical CSS, navigation, gap disclosures) · `CommerceMemberPicker.spec.tsx` (4 tests) · +5 tests added to create/detail specs |

## V. TYPECHECK

`npx tsc --noEmit` → **clean** (only npm `.npmrc` warnings; `.tmp/ui5-tsc-final.log`).

## W. BUILD

`npx next build` → **✓ Compiled successfully in 7.0s**, 58/58 static pages, all five Commerce
routes emitted (`/admin/commerce`, `/purchases`, `/purchases/[id]`, `/purchases/new`, `/tasks`) —
`.tmp/ui5-build.log`.

## X. GIT STATUS

- **Tracked files modified (6):** `apps/api/src/preferences/nav-catalogue.ts`,
  `apps/web/src/components/core/{core-nav.ts, CoreSettingsCenter.tsx, core-http.ts}` + 2 specs —
  **identical to the preflight snapshot taken before UI-5 began**; they are UI-1…UI-4 artifacts
  awaiting commit. **UI-5 modified no tracked file and no backend file.**
- **Created:** `apps/web/phaseui5-visual-qa.mjs`, `docs/PHASE-UI-5-FINAL-GAP-AND-UX-REPORT.md`,
  plus (inside the untracked UI-1…UI-4 tree) the two new specs and `phaseui5-shots/` (23 PNGs).
- **Dependency manifests:** unchanged (`package.json` / lockfile not touched → no new
  dependencies). Settings architecture unchanged. No unrelated formatting churn.
- **Prettier:** `npx prettier --check` is **not a gate in this repository** — it already failed
  on 47 files at the end of UI-4 (`.tmp/ui4-prettier.log`, including untouched Core files) and
  still fails on untouched files today (control run: `CoreStates.tsx`, `admin/commerce/page.tsx`).
  UI-5 therefore matched the repository's existing style rather than mass-reformatting it; no
  file was rewritten for style alone.
- Pre-existing untracked items (`backups/`, `secrets/`, `.tmp/`, old `phaseui3/4-*`, logs) were
  left exactly as found (§40).

## Y. REMAINING BACKEND GAPS

**STILL OPEN (deferred, nothing faked):** GAP-1 (workflow execution HTTP) · GAP-1b (tenant-wide
pending queue) · GAP-2 (line-routing configuration HTTP) · GAP-3 (CLOSED transition) ·
GAP-4 (KPI/summary) · GAP-5 (commerce in global search) · GAP-6 (quotation surfaces) ·
GAP-7 (document activity/audit read) · GAP-9 (per-user commerce notifications).
**PARTIALLY CLOSED:** GAP-8 — directory search now powers the requester picker; still missing a
Commerce-scoped member read and a UUID-safe seed. **NOTED:** GAP-ENV — rebuild `aria-erp-web`
from current source when the UI work is committed.

These are **backend follow-up work**, not UI-6 material.

## Z. FINAL UX RISKS

| Risk | Severity | Honest state |
|---|---|---|
| Option A caps at the latest 20 SUBMITTED documents, so an approver can miss older decisions | Known, documented | Disclosure + cap note rendered and browser-verified; disappears the day GAP-1b lands. |
| A session without `admin.users.read` cannot choose another requester | Known, documented | Read-only panel states the missing grant; no typed-UUID workaround exists (by design). |
| The submit journey depends on a PUBLISHED commercial configuration to create decisions | Backend-owned | Without one, submit still succeeds and no approval appears — the UI claims nothing about it. |
| Browser QA mutates real data (one document per run) | Accepted | QA-named rows (`supplierId=qa-ui5`, «QA» comments/reasons); idempotent-by-new-document. |
| Docker web image is stale | Deployment | Dev server from current source used for QA; image rebuild required at deploy. |

## AA. UI-5 ACCEPTANCE MATRIX

- [x] All current backend gaps re-verified from source (§B, 11 gaps classified).
- [x] Newly closed capabilities integrated safely (directory search → requester picker, §C).
- [x] No unsupported capability fabricated (`CommerceFinalHonesty.spec.tsx` + route allow-list).
- [x] Commerce feels like one product (§F vocabulary/CTA/back-action unification).
- [x] Home is task-first (§G).
- [x] My Tasks is honest about its coverage (§G, browser-verified).
- [x] Purchase Create is simple and understandable (no raw UUID; directory picker; §S).
- [x] Purchase Detail is the central workspace (§I + callout).
- [x] Commercial Decision is focused and safe (§J).
- [x] Payment UX preserves append-only semantics (§K, 1→2→3 rows in browser).
- [x] Receiving UX preserves event semantics (§K, refusal with server quantities).
- [x] Return UX preserves child-lifecycle semantics (§K, full lifecycle in browser).
- [x] Settings is clearly integrated into Platform Settings (§L).
- [x] Workflow configuration is understandable; published = immutable (§L, browser-verified).
- [x] Configuration UX does not resemble a developer console (§L).
- [x] Navigation coherent (link-to-route scan + browser walk).
- [x] Persian terminology consistent (§F, scan-pinned).
- [x] RTL correct (browser `dir=rtl`/`lang=fa` + logical-CSS scan).
- [x] Keyboard navigation works (focus entry/restoration/Escape in browser; ARIA tabs in jsdom).
- [x] Accessibility works (landmarks/labels/status-not-color-only across specs + browser).
- [x] Responsive layout works (30 overflow checks at 390→1920).
- [x] Loading / empty / error states work (per-section states, browser + jsdom).
- [x] 409 stale-state behaviour works (scenario 7, browser).
- [x] Form preservation works (jsdom: values kept on 400/409; comment kept on stale 409).
- [x] Double-submission prevention works (jsdom: disabled-while-pending on every mutation).
- [x] No `tenantId` in frontend requests (scan-pinned).
- [x] No Prisma imports in browser code (scan-pinned).
- [x] No business rules duplicated in frontend (scan-pinned: no evaluation functions).
- [x] Full browser QA passes (**113/113**).
- [x] End-to-end supported user journeys pass (scenarios 1–7).
- [x] Full web Jest passes (**89 suites / 1613 tests**).
- [x] TypeScript passes.
- [x] Production build passes.
- [x] No unrelated files changed (§X).
- [x] Final gap report exists (this file).
- [x] UX contract amendment exists, appended (UI-5-A/B/C).

## AB. FINAL COMMERCE FRONTEND STATUS

# COMMERCE FRONTEND COMPLETE — UI/UX HARDENED

with the backend follow-ups of §Y recorded explicitly as **backend work** (GAP-1, 1b, 2, 3, 4,
5, 6, 7, 9 still open; GAP-8 partial). **STOP** — no further Commerce UI phase starts
automatically; anything remaining is backend follow-up or an independently-gated new phase.
