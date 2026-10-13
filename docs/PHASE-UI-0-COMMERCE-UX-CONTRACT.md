# PHASE UI-0 — COMMERCE / PROCUREMENT: FRONTEND UX CONTRACT + INFORMATION ARCHITECTURE

> **Status:** Architecture/UX contract only. **No production UI was implemented in this phase.**
> **Authoritative backend:** Phase C1 (steps L–S) in `apps/api/src/modules/commerce/**`.
> **Authoritative web shell:** `apps/web` (Next.js 16 App Router, RTL-native, Aria Core shell).

## 0. CLASSIFICATION LEGEND (used on every important item in this document)

| Tag | Meaning |
|---|---|
| **[CONFIRMED]** | Directly evidenced by the repository (backend contract, web code, tests, migrations). |
| **[UX DECISION]** | A product/UX decision adopted for this phase; not forced by the backend. |
| **[UNKNOWN]** | Insufficient evidence; requires later clarification (product owner / platform team). |
| **[BACKEND GAP]** | The UX requires a capability the current backend does **not** expose over HTTP. |

Nothing in this document turns an UNKNOWN into a CONFIRMED. Where a statement rests on a
specific file, the file is named.

---

## 1. EXECUTIVE UX PRINCIPLES

North star (§2 of the phase prompt): **the business process may be complex, but the user
experience must feel simple.** The UI exists to let a person answer, within seconds:
Where am I? What is this purchase? What is its status? What has happened? Who is
responsible now? What action is expected of me? What happens after I act?

Adopted principles (all **[UX DECISION]** as product-level choices; each is compatible
with the C1 contract):

1. **Task-oriented home.** "What do I need to do" outranks "how much data exists". The
   Commerce landing experience is a work overview, not a chart wall. *Constraint:* the
   attention surfaces it can render today are limited by the workflow HTTP gap (§26).
2. **My Work.** A dedicated, permission-gated workspace for decisions waiting on the
   current user. *Constraint:* see §26-GAP-1 (no workflow-instance read route yet);
   commercial approvals are the one decision inbox that exists today.
3. **Next action is explicit.** Every operational screen shows current state, the acting
   party where the contract states one, and the single primary action the current user
   may take *now*, gated by the exact permission the route enforces.
4. **Progressive disclosure in three levels.** L1 = operational summary (status, next
   action); L2 = operational detail (lines, money, history); L3 = expert/admin detail
   (workflow configuration, rule conditions, actor sources). Workflow-engine vocabulary
   never appears at L1/L2.
5. **Human language.** Backend codes are never printed raw. `PURCHASE_DOCUMENT_STATUSES`,
   `PAYMENT_STATUSES`, `RECEIVING_STATUSES`, `RETURN_STATES`, `COMMERCIAL_*` and
   `WORKFLOW_*` all get Persian product labels in one client-side label module per feature
   (the `hr-mission-labels.ts` / `corr-labels.ts` precedent).
6. **Low cognitive load.** No giant CRUD form (see §9), one competing primary action per
   screen, restrained badges/colors, no modal chains.
7. **Safe interaction.** Preserve input on recoverable errors; distinguish
   high-consequence actions (submit, decision, compensation, refund, publish) with
   consequence-first confirmations; prevent double submission; never present an
   irreversible backend act as a casual click.
8. **Accessibility and RTL are structural, not retrofits** (§17, §18).
9. **Consistency with Aria.** Commerce is a native module of the existing shell — same
   cards, badges, density tokens, sidebar behavior, favorites/recents, header. No parallel
   design system.
10. **Modern enterprise tone.** Calm, premium, restrained; clarity and hierarchy over
    decoration; motion only to explain (drawers, disclosures), never to decorate.

---

## 2. CURRENT FRONTEND ARCHITECTURE FINDINGS (preflight)

All items in this section are **[CONFIRMED]** from `apps/web` unless marked otherwise.

### 2.1 Stack and shell

- **Framework:** Next.js `^16.0.0` App Router, TypeScript, React 18.3
  (`apps/web/package.json`).
- **Backend-of-record for UI:** one API (`apps/api`) mounted at `API_ENDPOINT` +
  `/api/v1` (global prefix), consumed through `apps/web/src/lib/core-http.ts`.
- **RTL-native root:** `apps/web/src/app/layout.tsx` renders
  `<html lang="fa" dir="rtl">` with the Vazirmatn variable font
  (`@fontsource-variable/vazirmatn`) and a skip link (`پرش به محتوا`). There is **no
  LTR mode to flip later**; the product is Persian-first by construction.
- **Providers (nesting order is load-bearing):**
  `ThemeProvider` → `AuthProvider` → `PreferenceProvider`
  (`apps/web/src/app/layout.tsx`). `PreferenceProvider` calls `useAuth`/`useTheme`,
  which is why it sits inside both.
- **Admin shell:** every `/admin/*` route renders inside `CoreShell`
  (`apps/web/src/components/admin/AdminShell.tsx` delegates to `CoreShell`).
  Layout = right-anchored sidebar rail (desktop `lg:` ≥1024px) + header (global search,
  notification bell, date chip, user menu) + `<main id="content">` capped at
  `max-w-[1600px]`.
- **Mobile navigation:** an overlay drawer (`CoreShell`, focus-trapped: focus in on open,
  restore on close, Escape closes, Tab confined) that re-renders the same `CoreSidebar`.
- **Route tree:** `app/admin/**` hosts the product surface; there is **no
  `/admin/commerce` route today** — the Commerce UI starts from zero (this phase).

### 2.2 Data access pattern

- **No query/state library.** No react-query/SWR/Redux. The established pattern is
  bespoke `useEffect` + `useState` + `reloadToken` hooks per screen, with
  `CoreLoading` / `CoreError` / `CoreForbidden` / `CoreEmpty` for the four states
  (`HrDashboardView.tsx`, `HrMissionApprovalView.tsx` are canonical).
- **One HTTP seam:** `coreGet/corePost/corePatch/coreDelete` (`lib/core-http.ts`) —
  unwraps the backend `{ data }` envelope, maps 401/403 to fixed Persian sentences, and
  raises `CoreApiError` with `.status`. Module API clients (e.g. `lib/hr-api.ts`,
  `lib/hr-mission-api.ts`) mirror backend DTOs type-for-type and add Persian label/tone
  helpers; components never call `fetch` directly.
- **Permission enforcement in UI is presentation-only:** `useCorePermissions(enabled)`
  (`components/core/useCorePermissions.ts`) reads `GET /rbac` and returns
  `{ permissions, roles, highestRole, isLoading, error, status, reload }`. The backend
  remains the authorization authority; hiding a control never replaces a 403.

### 2.3 Navigation architecture (the seam Commerce must join)

- **Client catalogue:** `components/core/core-nav.ts` defines `CORE_NAV`
  (groups → items with `label`, `href`, `icon`, optional `permission`, `children`,
  `sidebarHidden`, `favoriteable`, `defaultOpen`), plus `visibleNavGroups()` (permission
  filter), `railNavGroups()`, `activeNavHref()` (most-specific "you are here"),
  `pageTitleFor()`, `isNavTarget()`.
- **Server allowlist:** `apps/api/src/preferences/nav-catalogue.ts` mirrors the tree as
  `NAV_TARGETS` (exact href + optional permission). Favorites/recent writes are refused
  for hrefs outside it. A drift test (`core-nav.spec.ts` — the "49K" test) asserts the
  client catalogue and the server allowlist match **entry for entry**. Therefore:
  **any Commerce route added to the rail in UI-1 needs entries in BOTH files in the same
  change** [CONFIRMED constraint].
- **Personalization that already exists (do not rebuild in Commerce):** favorites
  (star on rows; `navFavorites`), recent pages (`navRecent`, rail shows 5), sidebar
  collapse, density (comfortable/compact via `data-density` tokens), dashboard widget
  order/visibility (`dashboardLayout`; client registry `core-widgets.ts` mirrors server
  `widget-catalogue.ts`). All persisted per user via `GET/PATCH /me/preferences`.
- **Global search:** `CoreGlobalSearch` (header) backed by `lib/search-api.ts`; server
  `apps/api/src/search/**` indexes the entities listed in `search-routes.ts`
  (support, surveys, messages, notifications, calendar, directory). **Commerce entities
  are not indexed** (§26-GAP-5).
- **Page titles:** resolved by `pageTitleFor()` from the nav catalogue; a route that is
  not a nav item may have a `PAGE_TITLE_ALIASES` entry (precedent: `/admin/settings`).

---

### 2.4 Module precedent inside the shell (HR & Correspondence)

- **HR** (`components/hr/*`): module home = counters + area cards + latest rows
  (`HrDashboardView`); register pages with inline `<table>` and per-row actions; an
  **approval queue screen** (`HrMissionApprovalView`) whose queue comes from a
  server-resolved "pending for this actor" read under `hr.mission.approve`; shared
  primitives in `hr-ui.tsx` (`HrBadge`, `HrPageHeading`, `HrCard`, `HrField`,
  `HrNotice`); every interactive element carries a `data-testid` (the E2E contract);
  Persian labels/tone helpers live in `lib/hr-*-labels.ts`.
- **Correspondence** (`components/correspondence/*`): hand-rolled
  `role="dialog" aria-modal="true"` dialogs (`CorrReferralDialog`), inline
  `role="tablist"` tabs, label module `corr-labels.ts`.
- **What this means for Commerce:** the module's screens should look and behave like
  these siblings — same heading/card rhythm, same inline table pattern, same
  testability contract — and only extract shared primitives where justified (§20).

### 2.5 Shared primitives that exist today

- `components/ui/`: **only five files** — `alert.tsx`, `button.tsx`, `input.tsx`,
  `select.tsx`, `textarea.tsx`. **There is no shared Dialog, Tabs, Table, Badge, Card,
  Drawer, Toast or Tooltip primitive** — modules build these inline as above
  [CONFIRMED].
- `components/core/CoreStates.tsx`: `CoreLoading` (skeletons, `role="status"`
  `aria-live="polite"`), `CoreError` (message + retry), `CoreForbidden` (403 sentence),
  `CoreEmpty` (dashed card).
- Dashboard widget frame: `CoreWidgetCard.tsx` (`CoreWidgetBoundary`); no chart or
  toast primitives exist.
- Jalali: `CoreJalaliDatePicker.tsx` + `lib/calendar-api.ts` helpers
  (`toPersianDigits`, `toLatinDigits`, `JALALI_MONTHS`, `formatJalaliLabel`,
  `formatJalaliLongLabel`, `parseDateKey`, `formatDateKey`).
- Motion: `lib/animations.ts` (framing variants) + `tailwindcss-animate`; motion is
  restrained in the shell (drawer slide, hover transitions).

### 2.6 i18n reality

- `src/messages/fa.json` (+ smaller `en.json`) exist and are used by the marketing
  surface; `next-intl` is a dependency. **Module screens (HR, Correspondence) use inline
  Persian strings and dedicated label modules rather than `next-intl` message keys**
  [CONFIRMED]. Commerce follows the module precedent **[UX DECISION]** pending a future
  global i18n initiative [UNKNOWN — no repo-wide plan evidenced].

---

## 3. CURRENT SHARED UI / DESIGN-SYSTEM FINDINGS

- **Tokens** (`src/styles/globals.css` + `tailwind.config.ts`): oklch channel-triplet
  variables mapped in Tailwind (`primary`, `secondary`, `muted`, `accent`, `destructive`,
  `success`, `warning`, `info`, `card`, `popover`, `sidebar`, …). Dark mode via `.dark`
  class; sidebar is an always-dark surface in both themes.
- **Radius/elevation:** `--radius: 0.75rem`; shadows `soft/card/elevated/glow`;
  gradients `--gradient-primary/sidebar/hero` (used sparingly — dashboard hero only).
- **Density system:** `data-density='compact'` re-declares `--core-row-h`,
  `--core-card-pad`, `--core-gap`, … Commerce must use the density tokens
  (`h-core-row`, `p-core-card`, `gap-core-gap`) rather than literals so the user's
  density choice applies automatically [CONFIRMED mechanism / UX DECISION to use it].
- **Typography:** Vazirmatn; screen headings use `text-xl/2xl font-semibold`
  (`HrPageHeading`), section titles `text-base font-semibold`, meta text
  `text-xs text-muted-foreground`.
- **Focus states:** `focus-visible:ring-2 focus-visible:ring-primary-glow` /
  `ring-ring` in shell controls; module buttons extend this.
- **Status color convention:** tone badges, never bare dots; `ok` = emerald,
  `danger` = destructive, `muted` = neutral (`hr-ui.tsx` `TONE_CLASSES`). Color is a
  redundant channel; the word is primary.
- **Testability convention:** interactive elements expose `data-testid`
  (`core-layout-toggle`, `hr-employee-status-ACTIVE`, `mission-approval-toggle-<id>` …),
  used by jsdom specs and the browser QA scripts (`phase*-visual-qa.mjs`).

---

## 4. COMMERCE INFORMATION ARCHITECTURE

### 4.1 The authoritative backend surface (everything the frontend may consume)

**[CONFIRMED]** The Commerce HTTP surface is *pinned* at **47 handlers across 6
controllers** by `apps/api/src/modules/commerce/commerce-isolation.spec.ts`
(`CONTROLLER_SURFACE`), asserted route-by-route. The prefix `/api/v1` is global; the
controllers register:

| # | Controller | Prefix | Routes |
|---|---|---|---|
| 1 | `purchase.controller.ts` | `commerce/purchase-documents` | `GET /` (list) · `GET /:id` · `POST /` (create) · `PATCH /:id` (draft edit) · `POST /:id/submit` |
| 2 | `payment-history.controller.ts` | `commerce/purchase-documents` | `GET /:id/payments` · `POST /:id/payments` · `POST /:id/payments/:paymentId/compensate` |
| 3 | `receiving-history.controller.ts` | `commerce/purchase-documents` | `GET /:id/receipts` · `POST /:id/receipts` · `POST /:id/receipts/:receiptLineId/compensate` |
| 4 | `return-history.controller.ts` | `commerce/purchase-documents` | `GET /:id/returns` · `POST /:id/returns` · `POST /:id/returns/:returnId/approve` · `…/reject` · `…/receive-back` · `…/refund` |
| 5 | `commercial.controller.ts` | `commerce` | 15 routes over `commercial-groups`, `commercial-configurations` (+`/validate`, `/publish`, `/archive`), `commercial-assignments`, `commercial-approvals/:id/decision` |
| 6 | `workflow-configuration.controller.ts` | `commerce` | 15 routes over `workflow-definitions` (+versions) and `workflow-versions` (+steps, +`/steps/order`, `/validate`, `/publish`, `/archive`) |

**Structurally absent — asserted, not assumed:** `commerce-isolation.spec.ts` (test A1,
lines 860–866) fails if a `workflow-execution.controller.ts` or
`workflow-line-routing.controller.ts` ever appears: *"N (workflow execution) and O (line
routing) are application services with no HTTP surface in this shell: that absence is
asserted here, not assumed."* → **[BACKEND GAP]** §26-GAP-1 and §26-GAP-2.

**Every route** additionally carries `@RequiresModule('commerce')` +
`@RequiresFeature('commerce','purchase')` + entitlement guard + `JwtAuthGuard`, and a
`@Roles(commerce.*)` declaration **[CONFIRMED]** — meaning a tenant without the
`purchase` feature grant cannot use any of it, whatever the user holds.

### 4.2 Vocabulary the UI must speak (verbatim backend enums)

- **Document status** `[CONFIRMED]` (`purchase-status.ts`): `DRAFT`, `SUBMITTED`,
  `APPROVED`, `REJECTED`, `CANCELLED`, `CLOSED`. Editable = `DRAFT` only
  (`editable` flag is computed from the same function the write guard uses).
  Legal transitions implemented today: `DRAFT→SUBMITTED` (submit route),
  `SUBMITTED→APPROVED|REJECTED` (commercial projection writer). **`CLOSED` has no
  writer in C1** — no screen may offer a "close" action (§26-GAP-3).
- **Document kind** `[CONFIRMED]`: `PURCHASE_REQUEST` (one member).
- **Line types** `[CONFIRMED]` (`purchase-status.ts`): `STANDARD`, `NON_STANDARD`,
  `SERVICE` — all three may coexist in one document.
- **Money** `[CONFIRMED]`: `Decimal(18,4)`; wire format is the **exact decimal string**
  (`"1250.0000"`), `null` when unstated; totals derived server-side from lines.
- **Currency** `[CONFIRMED]`: optional 3-letter ISO-4217 (`IRR`, `USD`, …); a document
  may be unpriced and unpriced ≠ zero.
- **Document number** `[CONFIRMED]`: server-minted per (`tenantId`, `kind`,
  **Jalali year**) inside the creating transaction (`purchase-number.ts`); never
  client-stated.
- **Payment status** `[CONFIRMED]` (`payment-status.ts`): `UNPAID`, `PARTIAL`, `PAID`,
  `OVERPAID`, or `null` ("no total stated"). Projection over ALL rows.
- **Payment methods** `[CONFIRMED]`: `CASH`, `PETTY_CASH`, `CHECK`.
- **Receiving status (per line)** `[CONFIRMED]` (`receiving-status.ts`):
  `NOT_RECEIVED`, `PARTIALLY_RECEIVED`, `FULLY_RECEIVED`. Over-receipt is impossible in
  valid history (projection throws; the write refuses with 409).
- **Return states** `[CONFIRMED]` (`return-lifecycle.ts`): `REQUESTED` → `APPROVED` →
  `RECEIVED_BACK` → `REFUNDED`, or `REQUESTED` → `REJECTED`; `REJECTED`/`REFUNDED`
  terminal; no correction model.
- **Commercial assignment states** `[CONFIRMED]`: `ASSIGNED`, `UNASSIGNED`;
  sources `PURCHASE_SUBMITTED`, `AFTER_DOCUMENT_WORKFLOW_APPROVED`, `MANUAL`.
- **Commercial configuration lifecycle** = the Aria version lifecycle
  `DRAFT→VALIDATED→PUBLISHED→ARCHIVED` (re-used, not re-declared).
- **Commercial approval** `[CONFIRMED]`: `PENDING` → `APPROVED|REJECTED`, decided ONLY
  by the exact user stored as approver at activation.
- **Workflow version lifecycle** `[CONFIRMED]` (`workflow-status.ts`):
  `DRAFT→VALIDATED→PUBLISHED→ARCHIVED`, one-way; PUBLISHED is immutable; re-editing a
  published version is impossible by design (a NEW version is authored).
- **Workflow step configuration** `[CONFIRMED]`: `executionMode` ∈
  {`SEQUENTIAL`,`PARALLEL`,`CONDITIONAL`}; `actorSource` ∈ 6 values but only
  `CONFIGURED_USER` is publishable (runtime capability list
  `WORKFLOW_EXECUTABLE_ACTOR_SOURCES`); `onConditionFalse` ∈
  {`SKIPPED`,`BLOCKED`,`TERMINATED`} where `BLOCKED` is **refused at publish**;
  `parallelJoinPolicy` ∈ {`ALL`,`ANY`} required iff any PARALLEL step; `triggerEvent` ∈
  {`PURCHASE_SUBMITTED`,`AFTER_DOCUMENT_WORKFLOW_APPROVED`}.
- **Workflow runtime statuses** `[CONFIRMED]` (`workflow-run-status.ts`): instance ∈
  {`RUNNING`,`APPROVED`,`REJECTED`,`CANCELLED`,`EXPIRED`}; step ∈
  {`PENDING`,`APPROVED`,`REJECTED`,`SKIPPED`,`DELEGATED`}; decisions ∈
  {`APPROVED`,`REJECTED`}. *(These are NOT reachable over HTTP today — see gaps.)*
- **Pagination** `[CONFIRMED]`: all Commerce lists accept `page` (≥1), `pageSize`
  (1–100, default 20) and free-text `search` (document list: matches `documentNumber`
  only); document list also filters `status`, `requesterId`.

---

### 4.3 Proposed information architecture (evaluated against 4.1)

The conceptual map from §4 of the phase prompt is evaluated against *actual* backend
capabilities. The result — **[UX DECISION]** — is this shape:

```
Commerce (group «تدارکات» in the rail)
├── خانهٔ تدارکات        /admin/commerce                  module home (overview + my work)
├── نیازمند اقدام من    /admin/commerce/tasks            task workspace (permission-gated)
├── درخواستهای خرید     /admin/commerce/purchases        register (list/search/filter)
│   ├── جدید             /admin/commerce/purchases/new    create (leaf, not in rail)
│   └── [id]             /admin/commerce/purchases/[id]   detail (leaf, not in rail)
├── بازرگانی (پیکربندی) /admin/commerce/commercial       groups + configuration versions
│   └── [id]             /admin/commerce/commercial/configurations/[id]
└── گردش کار (پیکربندی) /admin/commerce/workflows        definitions + versions
    ├── [definitionId]   /admin/commerce/workflows/[definitionId]
    └── نسخه              /admin/commerce/workflows/versions/[versionId]
```

Per-node documentation:

| Node | Purpose | Primary user | Key action | Level | Visibility | Relationships |
|---|---|---|---|---|---|---|
| `/admin/commerce` home | Overview of procurement + what needs me | Anyone with `commerce.read` | Jump to request / decision | Top-level | Gated `commerce.read` | Module landing page in the rail |
| `/admin/commerce/tasks` | "چه کاری از من میخواهد؟" — actionable queue | Approvers / commerce officers | Decide / open context | Top-level | Gated (exact permission per tab, §8) | Reads the same decisions surfaces as detail screens |
| `/admin/commerce/purchases` | The register of purchase documents | Requesters, officers, admins | Create / open | Top-level | `commerce.read` | Detail pages are leaves under it |
| `purchases/new` | Progressive creation | Holders of `commerce.manage` | Submit (or leave as draft) | Contextual | Not in rail | Returns to detail on success |
| `purchases/[id]` | THE central experience (§10) | Anyone with `commerce.read` | The single next action | Contextual | Not in rail (id = data) | Hosts lines, workflow progress*, commercial, payments, receipts, returns |
| `/admin/commerce/commercial` | Commercial groups + policy versions | `commerce.read` to view; `commerce.configure` to change | Author/publish policy | Top-level (admin area) | `commerce.read` entry; actions gated | Feeds assignments visible on detail screens |
| `/admin/commerce/workflows` | Workflow definitions + versions | `commerce.read` to view; `commerce.workflow.manage` to author | Author/validate/publish version | Top-level (admin area) | `commerce.read` entry; actions gated | Configuration only; no runtime instances (gap) |

`*` = the workflow *progress* area of the detail screen depends on §26-GAP-1; until it
closes, that area renders the facts that DO exist (status, `editable`, and — where
granted — commercial/payment/receiving/return sections).

**Why two "configuration" areas rather than one:** the backend exposes them as two
independent versioned lifecycles (`commercial-configurations` and `workflow-versions`)
with different permission pairs (`commerce.configure` vs `commerce.workflow.manage`)
**[CONFIRMED]**; merging them would invent a relationship the backend does not have.

**Why "Returns" and "Payments" are NOT top-level:** the backend deliberately gives them
no collection of their own — every route hangs off `/purchase-documents/:id/…`
**[CONFIRMED]**. A separate top-level register would be a frontend-invented surface with
no read to back it (there is no tenant-wide payments/receipts/returns list route).

**Why "My Tasks" is one screen with sections, not four:** one workspace whose sections
are (a) my commercial approvals, (b) my workflow-approval queue (gap-gated), (c) my
drafts. Each section renders only when its read exists and its permission is held (§8).

---

### 4.4 IA non-goals (explicit)

- No tenant-wide "Payments"/"Receiving"/"Returns" registers (no backend route)
  [CONFIRMED-by-absence].
- No "Suppliers" directory (supplierId is an opaque string; there is no supplier model,
  C1 §13) [CONFIRMED].
- No "Reports/Analytics" in UI-0 scope: no aggregate endpoint exists for Commerce
  (§26-GAP-6).
- No quote/confirmation/correction surface: `commerce.commercial.manage` exists in the
  catalogue/seed but **no route uses it**, and C1 §9 defers quotation entry
  [CONFIRMED; §26-GAP-7].

---

## 5. USER ROLES / PERSONAS (as evidenced by the backend)

### 5.1 Permission-based personas [CONFIRMED]

`20260926100100_seed_commerce_permission_grants/migration.sql` seeds exactly six
permissions and grants them to exactly two roles:

| Role | Commerce permissions | Evidence |
|---|---|---|
| `SUPER_ADMIN` | all six | CROSS JOIN over the catalogue; migration text |
| `ADMIN` | all six | explicit `IN` list; migration text |
| `OPERATIONS_ADMIN`, `SECURITY_ADMIN`, `PARTNER`, `CUSTOMER`, `EMPLOYEE`, `VISITOR` | none | "the absence … is the decision, not an omission" |

The six permissions and what each REALLY gates (from controller `@Roles`):

| Permission | Gates (routes) |
|---|---|
| `commerce.read` | every read: lists, details, payments/receipts/returns reads, commercial reads, workflow configuration reads |
| `commerce.manage` | purchase create/update/submit; payment append/compensate; receipt append/compensate; ALL five return commands; manual commercial assignment |
| `commerce.approve` | ONE route today: `POST commerce/commercial-approvals/:id/decision`. (The workflow decision route the N contract defines does not exist — §26-GAP-1.) |
| `commerce.configure` | commercial group create/update; commercial configuration create/update/validate/publish/archive; workflow definition create/rename |
| `commerce.workflow.manage` | workflow version create/update/validate/publish/archive; steps create/update/delete/reorder |
| `commerce.commercial.manage` | **no route today** — catalogue-only |

### 5.2 Functional personas (how the UI composes those grants) [UX DECISION]

1. **درخواستکننده (Requester)** — `commerce.manage` (+`commerce.read`): creates, edits,
   submits, tracks; no decision controls.
2. **کارشناس بازرگانی (Commercial officer)** — `commerce.read`+`commerce.manage`
   (+`commerce.approve` when named): watches assignments/approvals; records
   payments/receipts/returns operations; manual reassignment.
3. **تصمیمگیرنده (Decider)** — `commerce.approve`: sees "My Tasks"; acts only where the
   backend made *them* the actor (commercial: stored `approverUserId`; workflow:
   not verifiable over HTTP today).
4. **مدیر پیکربندی (Configuration administrator)** — `commerce.configure` and/or
   `commerce.workflow.manage`: authors versions; never a business-data actor.
5. **ناظر (Read-only auditor)** — `commerce.read` only: sees everything, changes
   nothing; action affordances degrade to information.

**What the UI must NEVER infer:** that ADMIN/SUPER_ADMIN are "current approver" of any
record. Approver rights are **per-user facts stored from configuration**, not role facts
[CONFIRMED] — decision controls appear only when the relationship is verifiable
(commercial: `approverUserId` on the row vs. the current user; workflow: not verifiable
over HTTP today). The current user id is available client-side via `AuthProvider`
(`user.userId ?? user.sub`) — the same source `CoreDashboard` uses **[CONFIRMED]**.

### 5.3 Two-layer access the UI must respect [CONFIRMED]

1. **Tenant entitlement** (module `commerce` + feature `purchase`): if the tenant is not
   entitled, EVERY Commerce route answers the platform's frozen refusal code — the UI
   must render a module-level unavailable state, not a per-screen error loop.
2. **User permission**: within an entitled tenant, each route checks the
   `commerce.*` string above. UI visibility mirrors the strings; the backend decides.

---

## 6. MAIN USER JOURNEYS

Each journey: intent → entry → info needed → primary action → secondary actions →
result → feedback → loading → recoverable error → empty → permissions → navigation
after → confusion points → prevention. Backend steps are [CONFIRMED]; UX mechanisms are
[UX DECISION]. Journeys whose required route does not exist are marked **[BACKEND GAP]**
and are designed as-if, but gated behind §26.

### J1 — Create a purchase request

- **Intent:** raise a procurement need. **Entry:** home CTA «درخواست خرید جدید» (when
  `commerce.manage`), register page button, empty-state CTA.
- **Info needed:** requester (default = current user; backend verifies tenant
  membership), optional supplier reference (opaque, ≤128 chars), optional currency
  (ISO-4217), ≥1 line (≤200): lineType ∈ {STANDARD, NON_STANDARD, SERVICE}, quantity
  (decimal ≤4dp), unit (≤32), optional unitPrice, optional tax, optional
  externalRef / itemReference / technicalDescription.
- **Primary action:** «ثبت نهایی و ارسال برای تصمیم» = create (`POST`) then submit
  (`POST :id/submit`) as two explicit calls. **Secondary:** «ذخیرهٔ پیشنویس» (create
  only), «انصراف».
- **Result/feedback:** navigate to the detail with a success alert naming the minted
  `documentNumber`. **Loading:** busy state on the submitting button; inputs stay
  visible; double-click guarded (in-flight flag).
- **Errors:** 400 validation → inline per-field messages, input preserved;
  403 → permission sentence, no request loops; 409 on submit → explain the document
  already moved.
- **Permissions:** page reachable only with `commerce.manage` (otherwise
  `CoreForbidden` and zero requests fired — the `HrMissionApprovalView` pattern).
- **After:** detail screen (J4). **Confusion points:** user expects to type a document
  number (server-minted per tenant+kind+Jalali year) or edit totals (derived from
  lines). **Prevention:** read-only number field showing «شماره پس از ثبت تعیین
  می‌شود»; totals panel labelled «محاسبه‌شده از ردیف‌ها»; unpriced shown as «—» not ۰.

### J2 — Save / edit a draft

- **Entry:** detail while `editable === true` (DRAFT) — the `editable` flag is the same
  function the server guard uses, so the button can never disagree with the PATCH.
- **Primary:** «ذخیرهٔ تغییرات» (`PATCH :id`) sending ONLY stated fields (`undefined` =
  untouched, `null` = clear — the UI preserves that distinction). Lines, when edited,
  are sent as a whole replacement array (safe only while DRAFT and unrouted).
- **Result:** success notice; totals may change (derived). **Error:** 409 «وضعیت سند
  تغییر کرده است» → offer «بررسی دوباره» (reload) while preserving unsaved input in
  the form state. **After:** stays on detail (no navigation on save).
  **Confusion:** user tries to edit after submit. **Prevention:** all edit controls
  rendered from `editable`; read-only presentation with an explanatory caption
  «سند ارسال شده و قابل ویرایش نیست» once `editable === false`.

### J3 — Submit for decision

- **Primary:** «ارسال برای تصمیم» only while `status === 'DRAFT'`; confirmation dialog
  states consequences: «پس از ارسال، سند قابل ویرایش نیست و وارد گردش تصمیم
  می‌شود.» — derived from the real transition table (DRAFT→SUBMITTED is the only edge).
- **Backend effect [CONFIRMED]:** status moves, audit row written, event
  `commerce.purchase_document.submitted` published, line-level workflow instances
  created via line routing (pinned routing version); unrouted lines reported
  `unroutedLineIds`.
- **Feedback:** success + refreshed status badge; a note if some lines were left
  unrouted (configuration issue, not user error) **[UX DECISION]** wording:
  «برخی ردیف‌ها مسیر تصمیم ندارند — پیکربندی گردش کار را بررسی کنید.»
- **Error:** 409 with the actual status in the message (server text shown verbatim
  after a Persian wrapper). **Confusion:** user expects undo. **Prevention:**
  confirmation is explicit that no un-submit route exists (no such route
  [CONFIRMED-by-absence]).

### J4 — Track a purchase request (detail)

- **Entry:** register row click, "my requests" filter, search by documentNumber,
  notification link, favorites/recents.
- **Info needed, all from `GET :id` + siblings [CONFIRMED]:** document identity/status/
  editable/requester+profile/supplierId/currency/totals/lines/timestamps (§21 API
  matrix); plus — for the SAME document — payments, receipts, returns, commercial
  assignments+history, commercial approvals (five parallel reads).
- **Primary action:** the single next action derived from status + permission (edit or
  submit while DRAFT; nothing while SUBMITTED without the missing runtime read;
  operations sections below). **Secondary:** back to register, copy document number.
- **Feedback/states:** L1 header always visible; each secondary section owns its own
  loading (skeleton) and empty state so one failing section never blanks the page.
- **Permissions:** `commerce.read` to view; sub-sections render affordances per
  §20/§21. **After:** none (stays). **Confusion:** status says SUBMITTED but no
  approver/timeline is visible. **Prevention:** until §26-GAP-1 closes, the workflow
  section shows «گردش کار در حال اجراست» + last-known facts — never a fake timeline
  [UX DECISION].

### J5 — Approve / reject / decide

- **Two DIFFERENT decision systems exist — never blended:**
  1. **Commercial approval** [CONFIRMED route]: `POST commerce/commercial-approvals/:id/decision`
     with `{decision: APPROVED|REJECTED, comment?}` under `commerce.approve`; the acting
     user must EQUAL the stored approver (else `COMMERCIAL_APPROVAL_ACTOR_MISMATCH`),
     and the record must be PENDING (else 409 `COMMERCIAL_APPROVAL_NOT_PENDING`).
  2. **Workflow step decision** [BACKEND GAP — §26-GAP-1]: the N contract defines
     `POST /commerce/workflow-instances/:id/steps/:stepInstanceId/decision` and cancel;
     the runtime service exists (`approveStep`, approve-path only) but **no HTTP route
     exists** and no reject path is wired in the service.
- **Commercial decision UX:** focused decision panel per line: why it is here
  (document + line context), what is requested (line + money), who decided nothing yet
  (PENDING, approver identity), what happens after (projection recompute in the same
  transaction). Rationale/comment optional (backend optional) — **[UX DECISION]**
  encourage but never require; preserve typed comment on 409.
- **Feedback:** deterministic success (record leaves the queue; status word changes);
  409 surfaced with the server message. **Never** show a workflow-decision button that
  would 404 (absent route).

### J6 — Commercial review / decision (line assignment view)

- **Entry:** detail screen «بازرگانی» section; task workspace commercial tab.
- **Reads [CONFIRMED]:** `GET commercial-assignments?documentId=` → current assignment
  per line + append-only history; `GET commercial-approvals?documentId=` → approval
  records.
- **Primary action for officers:** manual assign/reassign
  (`POST commercial-assignments` with `lineId`, `groupId`, optional `reason` ≤500) —
  refused on terminal documents (`COMMERCIAL_ASSIGNMENT_IMPOSSIBLE`) and for identical
  re-assignment (409 `COMMERCIAL_INVALID_REASSIGNMENT`).
- **Info shown:** line → group → resolved liaison user id, matched rule label,
  source (PURCHASE_SUBMITTED / AFTER_DOCUMENT_WORKFLOW_APPROVED / MANUAL), reason,
  changedAt — history stays visible after reassignment (append-only).
- **Confusion points:** "who owns this line now" vs "who used to" (history vs current)
  and UNASSIGNED rows. **Prevention:** current row highlighted, history collapsed
  under «تاریخچهٔ واگذاری» with reasons; UNASSIGNED has its own neutral badge and an
  explicit note that no approver exists for that line (§3-K: no fallback user).

### J7 — Payment activity

- **Entry:** detail screen «پرداخت‌ها» section only (no tenant-wide list exists).
- **Reads [CONFIRMED]:** `GET :id/payments?page&pageSize&method` → one page (oldest
  first) of payment rows + `paymentStatus` computed over the WHOLE history
  (`status` may be `null` = «جمع کل اعلام نشده»).
- **Primary:** «ثبت پرداخت» (`POST`) — amount (>0, ≤Decimal(18,4)), method ∈
  {CASH, PETTY_CASH, CHECK}, optional paymentDate, optional payerRef/payeeRef/
  invoiceRef/externalReference (opaque ≤128). Currency/snapshot is server-owned —
  never asked.
- **Secondary:** «ابطال (جبران)» per row → `POST :id/payments/:paymentId/compensate`
  with optional paymentDate/externalReference/reason (≤500; rides audit, not a column).
  Compensation is FULL negation of the target row — **no partial amount input exists**
  (DTO takes none) [CONFIRMED].
- **Consequence-first confirm:** «این پرداخت با یک ردیف جبرانیِ کامل معکوس می‌شود؛
  قابل بازگشت نیست.» Empty body compensate is legal — reason encouraged.
- **Confusion:** negative amounts; OVERPAID. **Prevention:** compensating rows
  rendered as reversal (linked via `reversesPaymentId`, struck-through + «جبران‌شده»),
  status legend explains OVERPAID; `null` total never renders as «پرداخت‌نشده».

### J8 — Receiving activity

- **Reads [CONFIRMED]:** `GET :id/receipts` → ALL receipts (unpaged) + per-line
  projection `{purchaseLineId, orderedQuantity, receivedQuantity, receivingStatus}`
  covering EVERY line (a line with no events = NOT_RECEIVED).
- **Primary:** «ثبت رسید» (`POST`) → lines[] of `{purchaseLineId, quantity>0}`,
  optional receivedAt; duplicate line entries allowed (summed). Over-receipt →
  409 naming line number + all three quantities; message surfaced verbatim
  (never clamped client-side or server-side).
- **Secondary:** «ابطال رسید (پاره‌ای)» per receipt line →
  `POST :id/receipts/:receiptLineId/compensate` with POSITIVE magnitude (partial
  compensation is legal here, unlike payments) + optional reason ≤500.
- **Confusion:** "received" quantity vs remaining. **Prevention:** per-line progress
  «۴۰ از ۱۰۰» with word status; before posting, UI shows remaining-receivable computed
  from the same projection (display-only; server re-validates under lock).

### J9 — Return lifecycle

- **Reads [CONFIRMED]:** `GET :id/returns` → all returns with lines + transitions
  (oldest first), state = projection of the chain.
- **Commands (all append-only, all `commerce.manage`):**
  `POST :id/returns` create (reason 1…500 non-empty, `replacementRequired`, lines of
  `{purchaseLineId, receiptLineId, quantity>0}`) → state REQUESTED;
  `…/:returnId/approve` / `…/reject` (optional reason ≤500);
  `…/receive-back` (**empty body is complete** — UI sends no body;
  the backend's anchor-field DTO rejects any stated field with 400);
  `…/refund` requires `paymentId` (Q's compensation target) + optional reason.
- **409 codes to render as product messages [CONFIRMED]:** `over_return` (names all
  three quantities), `invalid_transition` (names legal sources),
  `line_reference_mismatch`, `refund_compensation_failed` (no REFUNDED row written).
  `invalid_origin` unreachable in practice.
- **Confusion:** returns are their OWN lifecycle and never change the parent
  document's status; refund targets a specific payment. **Prevention:** state chain
  shown as four steps REQUESTED→APPROVED→RECEIVED_BACK→REFUNDED (or →REJECTED) with
  the current step marked; refund dialog lists candidate payments (from the payments
  read) so the user picks a real `paymentId` — never a free-text id field.

### J10 — Administrator configuring workflow

- **Entry:** `/admin/commerce/workflows` (L3 expert surface). Reads: definitions
  list/detail, versions list (status filter), version detail with ordered steps
  [CONFIRMED]. Writes: definition create/rename (`commerce.configure`); version
  create/patch/validate/publish/archive and step create/patch/delete/reorder
  (`commerce.workflow.manage`).
- **Core UX rule [CONFIRMED + UX DECISION]:** PUBLISHED versions are immutable —
  the UI renders them fully read-only with «نسخهٔ منتشرشده قابل ویرایش نیست» and
  offers «ایجاد نسخهٔ جدید» (create version) as the only path forward; DRAFT alone is
  editable; VALIDATED offers only publish; ARCHIVED offers nothing (terminal).
- **Steps editor:** ordering via full-permutation `PUT …/steps/order` (drag or
  up/down controls that build the complete id list); validate returns issues
  (max 64 reported) shown as a blocking checklist before publish; publish disabled
  until validate passes (backend enforces too).
- **Conditional fields** (condition, onConditionFalse, actorSource, thresholds,
  lineFilters) are JSON-object columns validated server-side — the UI shows a raw
  JSON editor with schema hints **[UX DECISION — a visual rule-builder is out of
  scope for UI-1]**; `BLOCKED` behavior and the five non-executable actor sources
  must be marked «در انتشار پذیرفته نمی‌شود» because publish will refuse them
  [CONFIRMED §18 of N].
- **Confusion:** editing "the live workflow". **Prevention:** version status is the
  first thing shown; in-place edit of a published version is impossible in UI and API.

---

## 7. DASHBOARD UX (module home `/admin/commerce`)

**[UX DECISION]** grounded in [CONFIRMED] reads. Follows the `HrDashboardView` precedent
(one page = one round of parallel reads + counters + area cards + latest rows).

### 7.1 What it answers

«تدارکات امروز چه وضعیتی دارد و چه چیزی به من مربوط است؟» — never a generic chart wall.

### 7.2 Composition (top → bottom)

1. **Header** `HrPageHeading`-style: «خانهٔ تدارکات» + description + primary CTA
   «درخواست خرید جدید» (only with `commerce.manage`).
2. **Attention strip (My-work summary):** three counters fed ONLY by routes that
   exist:
   - «در انتظار تصمیم بازرگانی من» ← derived from the commercial-approvals reads
     [CONFIRMED available per document; see GAP-1 for the tenant-wide variant].
   - «پیش‌نویس‌های من» ← `GET commerce/purchase-documents?requesterId=<me>&status=DRAFT`
     (total) [CONFIRMED].
   - «درخواست‌های در جریان» ← `GET …?status=SUBMITTED` (total) [CONFIRMED].
   **No invented KPIs** — no spend charts (no aggregate endpoint [BACKEND GAP-6]).
3. **Area cards** (link rows like HR's AREAS): درخواست‌های خرید / نیازمند اقدام من /
   پیکربندی بازرگانی (gated `commerce.configure`) / پیکربندی گردش کار (gated
   `commerce.workflow.manage`).
4. **«آخرین درخواست‌های خرید»** — last 5 rows from `GET purchase-documents`
   (documentNumber, requester display name, status badge, updatedAt) with link to
   detail; `CoreEmpty` when zero: «هنوز درخواست خریدی ثبت نشده است.»

### 7.3 What it deliberately does NOT do

- Does not add itself to the Core widget registry (`core-widgets.ts` /
  `widget-catalogue.ts` are Core's personal dashboard; a Commerce widget would be a
  cross-boundary change) **[UX DECISION + UNKNOWN]** whether product later wants a
  personal "my Commerce tasks" widget on the Core home — needs a registry decision
  touching BOTH mirrors.
- No auto-refresh/polling (none exists anywhere in the app) **[UX DECISION]** —
  explicit refresh button + reload on route focus.

### 7.4 States

Loading = 2 skeleton blocks (counter row + list); 403 = `CoreForbidden` (module not
entitled / no read); section-level errors are non-blocking (one failed read shows a
retry inline, the rest of the page renders).

---

## 8. "MY TASKS" UX (`/admin/commerce/tasks`)

### 8.1 The honest constraint

A task inbox needs "pending work items for THIS actor". The backend pieces:

- **Commercial approvals:** `GET commerce/commercial-approvals?documentId=` exists but
  is **document-scoped** — there is no tenant-wide "my pending commercial approvals"
  list route **[BACKEND GAP-1b]**. Two workable designs follow; the chosen one is
  **[BACKEND GAP-4]**-free but requires the list route, OR a scoped workaround:
  - **Option A (no backend change):** the Tasks screen composes from the register:
    `GET purchase-documents?status=SUBMITTED` (recent N) → for each, read
    `commercial-approvals` → filter `status===PENDING && approverUserId===me`.
    **Chosen as the UI-1 fallback** [UX DECISION] — bounded (one extra read per open
    document, max the first page), correct, and honest. Cap: latest 20 SUBMITTED
    documents; note in UI when the cap is hit.
  - **Option B (backend gap):** a proper queue route
    `GET commerce/commercial-approvals/pending` mirroring HR's
    `/hr/missions/approvals/pending` — reported as GAP-1b for backend decision.
- **Workflow step approvals:** repository supports `approverId`-filtered instance
  paging (`listInstancePage`) but NO HTTP route exists **[BACKEND GAP-1]**. Section
  renders as a placeholder card «صف تأیید گردش کار به‌زودی فعال می‌شود» **only while
  the gap is open** — and the tab is hidden entirely if the backend never exposes it
  [UX DECISION: hidden > fake].

### 8.2 Sections (each permission-gated, each independently loaded)

| Tab | Source | Gate | Rows show |
|---|---|---|---|
| «تصمیم‌های بازرگانی من» | Option A composition (or GAP-1b route) | `commerce.approve` | document number, line count, my line's group + reason for attention, age (createdAt), primary «بررسی و تصمیم» → expands decision panel in place (the `MissionApprovalQueueRow` pattern: expand-in-row, fetch detail on demand) |
| «تأیید گردش کار» | GAP-1 route | `commerce.approve` | hidden/placeholder until GAP-1 closes |
| «پیش‌نویس‌های من» | `GET …?requesterId=me&status=DRAFT` | `commerce.manage` | number, updatedAt, lines count, primary «ادامهٔ ویرایش» → detail |

### 8.3 Task row anatomy (all fields the contract actually supports)

title (document number + «درخواست خرید»), context (requester display name / line
summary), state word (PENDING→«در انتظار تصمیم شما»), age (createdAt → «۳ روز پیش»
with exact date on hover/title), responsible (me — that is why the row exists),
primary action, whole row clickable to detail. **Age is client-derived from
createdAt** (server does not provide SLA fields) [CONFIRMED-absence of SLA data →
SLA/overdue semantics are **[UNKNOWN]**, deliberately not shown].

### 8.4 Empty / loading / error / permission

- Loading: 4 row skeletons. Empty: «کاری در نوبت شما نیست.» + link to register.
- Error: `CoreError` with retry; 403 → `CoreForbidden` naming `commerce.approve` (or
  `commerce.manage` for drafts tab).
- **No request is issued for a tab whose permission is not held** (the
  `HrMissionApprovalView` "absent call" assertion pattern).

---

## 9. PURCHASE CREATION UX (progressive form, not a CRUD wall)

**[UX DECISION]** — a one-page progressive form with staged sections, NOT a wizard
(cross-page back-navigation risks losing draft input; the backend draft only exists
AFTER create, so a multi-page wizard has nothing to persist to on page 1).

### 9.1 Structure (`/admin/commerce/purchases/new`)

- **Stage 1 — چه کسی و برای چه:** requester (combobox of directory members via the
  existing `GET users/directory` under `admin.users.read` — Commerce has NO
  member-search endpoint of its own [CONFIRMED]; fallback: if the directory permission
  is absent, requester defaults to self only [UX DECISION, see GAP-8]), supplier ref
  (free text, optional), currency (empty + common ISO codes, free 3-letter pattern).
- **Stage 2 — ردیف‌ها:** the line editor (below). Visible immediately — a request
  without lines cannot exist (server refuses <1 line).
- **Stage 3 — جمع‌بندی (review):** totals readout (derived), line count, then the two
  exit actions.

### 9.2 Line editing experience

- Inline table rows (desktop) → stacked field groups under 768px (§18).
- Columns: lineType (segmented select: استاندارد/غیراستاندارد/خدمات — with a one-line
  helper from the C1 vocabulary meaning), quantity, unit, unitPrice, tax (optional),
  lineTotal (computed client-side for preview ONLY; server recomputes and its numbers
  win), expandable «جزئیات فنی» (externalRef, itemReference, technicalDescription).
- Add/remove row buttons; ≤200 rows (server bound shown when approaching).
- **Line-routing visibility:** the frontend knows NOTHING about which line routes
  where — line routing is evaluated server-side at submit against a configuration the
  frontend cannot read (GAP-2). Therefore **no routing badges on lines** during
  creation [CONFIRMED-by-absence; UX DECISION: do not tease what cannot be shown].

### 9.3 Conditional fields

Backend semantics currently expose NO conditional document fields (all create fields
apply to all documents; conditional behavior exists only in workflow/routing config).
So: **no conditional fields at creation** [CONFIRMED]. Future conditional display must
be driven by backend configuration reads, not frontend rules.

### 9.4 Validation

- Zod + React Hook Form (both already dependencies) with messages mirroring the DTO
  bounds (max 200 lines, quantity >0 ≤4dp, unit ≤32, refs ≤128, itemRef ≤200,
  techDesc ≤1000 — verified against `purchase.dto.ts`).
- Surfaced per-field on blur/submit, with a summary alert on submit failure; entered
  data is NEVER cleared by a server 400 (field errors map onto the same fields).
- Decimal input accepts Latin digits, displays Persian digits (converted for display
  only; payload stays numeric) [convention: `toPersianDigits`].

### 9.5 Draft behavior & review-before-submit

- «ذخیرهٔ پیشنویس» before create performs create + redirect to the editable detail —
  the form never claims "auto-save" (no autosave exists [CONFIRMED-by-absence]).
- «پیش‌نمایش پیش از ارسال» = in-page review panel (Stage 3), not a modal — a final
  chance to read exactly what will be submitted; then «ارسال برای تصمیم» (J3).

---

## 10. PURCHASE DETAIL — CENTRAL EXPERIENCE (`/admin/commerce/purchases/[id]`)

### 10.1 Layout model

One page, always in context; **no navigation away from the purchase** to act.
**[UX DECISION]**

```
┌ Header ──────────────────────────────────────────────┐
│ [شماره سند + نوع]  [وضعیت badge]  [requester]        │
│ توضیح وضعیت / مسئول بعدی*                             │
│ [primary action]  [secondary actions]  [بازگشت]      │
├ Summary strip ───────────────────────────────────────┤
│ تامین‌کننده | ارز | جمع کل | تعداد ردیف | تاریخ ثبت   │
├ Lifecycle overview (6 cells) ────────────────────────┤
│ گردش کار* | بازرگانی | ردیف‌ها | پرداخت | رسید | مرجوعی │
├ Tabs (contextual detail) ────────────────────────────┤
│ خلاصه | ردیف‌ها | گردش کار* | بازرگانی | پرداخت‌ها |   │
│ رسیدها | مرجوعی‌ها | فعالیت‌ها*                        │
└──────────────────────────────────────────────────────┘
* = GAP-dependent, see below
```

### 10.2 Above the fold (always visible, no tabs needed)

identity (`documentNumber`, kind label «درخواست خرید»), status badge + human status
hint (SUBMITTED → «در حال تصمیم‌گیری»), requester name+profile, `editable` signal,
primary next action, summary strip. **Everything else is progressive.**

### 10.3 The six lifecycle cells (overview strip)

Each cell = domain word + tone + one-line state, computed ONLY from its own read:

| Cell | Source | States shown |
|---|---|---|
| گردش کار | GAP-1 read; until then document `status` only | «در جریان / تکمیل‌شده / —» + note «جزئیات در دسترس نیست» [BACKEND GAP-1] |
| بازرگانی | `commercial-approvals` read | «نیازمند تصمیم / تصمیم‌گرفته‌شده / ندارد» |
| ردیف‌ها | document lines | count + worst-line receiving state (display-only aggregation) [UX DECISION] |
| پرداخت | `paymentStatus` | UNPAID/PARTIAL/PAID/OVERPAID/null (null → «جمع کل اعلام نشده») |
| رسید | `receipts.lines[]` | NOT/PARTIALLY/FULLY_RECEIVED (worst-of-lines; display-only) |
| مرجوعی | `returns.returns[]` | counts by state + latest state |

### 10.4 Tabs: what lives where and why

- **خلاصه (Overview):** money blocks, requester/supplier, timestamps, the six cells
  expanded. Never duplicates the full lists.
- **ردیف‌ها:** full line table with per-line receiving status column (receipts read)
  and per-line commercial group (assignments read) — line-centric joins are display
  joins over three reads of the SAME document [CONFIRMED shapes]; no client-side
  business verdicts (never "is this line complete").
- **گردش کار:** progress presentation (§10.5) [GAP-1-gated].
- **بازرگانی:** assignments + history + approvals (J6) with decision panel (J5).
- **پرداخت‌ها / رسیدها / مرجوعی‌ها:** J7/J8/J9 screens in place (tables + actions).
- **فعالیت‌ها (Timeline):** **[BACKEND GAP-9]** — no Commerce activity/timeline read
  exists (audit lives in the platform trail, not exposed through Commerce routes).
  Until a route exists, this tab shows ONLY facts of reads already present
  (createdAt, updatedAt, return transitions, receipt/payment dates) labelled
  «رویدادهای ثبت‌شده» — clearly not an audit log [UX DECISION].

### 10.5 Workflow progress (GAP-1-gated design)

When `GET /commerce/workflow-instances?subjectId=` + detail exist: horizontal step
progress (completed / current / upcoming / skipped) from persisted step rows
(`status`, `resolvedApproverId`, `displayName`), plus per-step decidedAt/decision —
**read-only for ordinary users; decision controls only where the runtime says this
user is the resolved approver**. Per the N contract ("a read NEVER evaluates"), the UI
never pre-computes legality; it renders server-returned states only. Until then:
status + «گردش کار در حال اجراست» (never a fabricated stepper).

### 10.6 Drawers vs tabs (rules)

- **Tabs** for bulk domains (payments, receipts, returns) — they carry tables.
- **Drawer (side sheet)** for quick previews from other screens (e.g. opening a task's
  document without leaving Tasks) **[UX DECISION]** — must reuse the CoreShell
  drawer's focus-management conventions (§19); no shared Drawer primitive exists
  (§20).
- **Dialogs** only for consequence-bearing confirmations (submit, compensate, refund,
  publish) and small one-shot inputs (manual assignment reason).
- **Never** requires leaving the purchase for: status, acting on any of the six
  domains, or understanding history.

---

## 11. APPROVAL / DECISION UX

**Design principle [UX DECISION]:** the decider never has to learn the workflow engine.
The screen is a decision workspace, not a config view.

### 11.1 The focused decision panel (commercial, ship-capable today)

Context blocks, in order:
1. **چرا اینجاست؟** — «تصمیم بازرگانی برای ردیف N درخواست شماره X» + why it exists
   (commercial configuration activated approval for this line — resolved from record
   presence, not from engine internals).
2. **چه چیزی درخواست شده؟** — line summary (description/type/qty/unit) + document
   totals + group + configured liaison.
3. **چه تاکنون رخ داده؟** — compact history: document status, assignment history
   entries, receipts/payments summary lines (read-only chips).
4. **تصمیم شما** — two explicit actions: «تأیید» / «رد» + optional comment textarea
   («توضیح (اختیاری)», ≤1000 chars — backend bound), then a consequence line before
   confirmation: «ردِ این تصمیم روی وضعیت سند اثر نمی‌گذارد [CONFIRMED: commercial
   rejection never writes document REJECTED] و پروژکشن مجدداً محاسبه می‌شود.»
5. **بعد از تصمیم** — deterministic success notice; panel flips to decided state with
   decidedAt + decidedBy; document's commercial cell updates on reload.

### 11.2 Rules binding this UX (all [CONFIRMED])

- Only `commerce.approve` holders see decision controls; others see read-only state.
- Actor check is server-side; UI additionally hides the button when
  `approverUserId !== currentUserId` (defense in depth; server message still handled
  if mismatch happens anyway — e.g. stale panel).
- 409 `COMMERCIAL_APPROVAL_NOT_PENDING` (duplicate decision / already decided) →
  refresh row with explanation; typed comment preserved until refresh succeeds.
- 404 (unknown/foreign) indistinguishable — generic «این مورد یافت نشد.» no id probing.
- **Workflow decisions:** designed as the same panel over step rows, but **disabled
  behind GAP-1** — no decision button may render against a route that does not exist.

### 11.3 What the decision UX must never do

Never invent decision types (only APPROVED/REJECTED exist), never pre-select an
answer, never show rationale as required when the DTO marks it optional, never offer
bulk decisions (no bulk route exists).

---

## 12. COMMERCIAL UX

### 12.1 Document-scoped commercial view (inside detail)

Tabs-section «بازرگانی»:
- **Current assignments table:** line → group → status(ASSIGNED/UNASSIGNED) →
  matched rule label → resolved liaison (id; profile lookup only if the directory
  read is held — otherwise id shown muted [UNKNOWN: commercial rows carry no profile
  resolution]) → source → updatedAt.
- **«واگذاری دستی»** dialog (`commerce.manage`): group select (from
  `GET commercial-groups`), optional reason; consequence note for reassignment
  («تاریخچه حفظ می‌شود»); handles 409 `COMMERCIAL_INVALID_REASSIGNMENT` and
  `COMMERCIAL_ASSIGNMENT_IMPOSSIBLE`.
- **History (append-only):** collapsed «تاریخچهٔ واگذاری» ordered by `changedAt` with
  reason text.
- **Approvals list:** PENDING/APPROVED/REJECTED records per line with the decision
  panel (§11).

### 12.2 Commercial configuration area (`/admin/commerce/commercial`)

- **Groups CRUD** (code, name, optional liaisonUserId): `commerce.configure`;
  validation mirrors DTO bounds (code ≤64, name ≤128); 409 on duplicate code/label.
- **Configuration versions:** lifecycle `DRAFT→VALIDATED→PUBLISHED→ARCHIVED` with the
  SAME immutability UX as workflows (§16): published = read-only; the editing surface
  covers the real DTO fields — versionLabel, assignmentTrigger (PURCHASE_SUBMITTED /
  AFTER_DOCUMENT_WORKFLOW_APPROVED — MANUAL is deliberately NOT selectable: it is not a
  trigger [CONFIRMED]), noAssignmentBehavior (REJECT_OPERATION / LEAVE_UNASSIGNED),
  matchBehavior (HIGHEST_PRIORITY / AMBIGUOUS_ERROR), assignmentRules[] (priority +
  condition + group), approvalActivation, approvalApprover
  (LINE_COMMERCIAL_LIAISON / CONFIGURED_USER) + approverUserId, applicabilityCondition
  (JSON), projectionPolicy (4 values).
- **Projection policy explainer (L3):** a plain-Persian helper listing what each
  DOCUMENT_WORKFLOW / ALL_LINES / …_AND_COMMERCIAL combination waits for
  [CONFIRMED semantics from `commercial-projection.ts`] — because this policy is what
  eventually writes SUBMITTED→APPROVED/REJECTED.
- **Config screen emptiness:** with no groups/config, every section has a guided
  empty state; automatic assignment simply never produces rows (documents show
  UNASSIGNED), which the UI explains rather than alarms.

---

## 13. PAYMENT UX (detail tab «پرداخت‌ها»)

**[CONFIRMED contract, UX DECISION presentation]**

- **Header row:** status word from `paymentStatus.status` + paid/total readout:
  «پرداخت‌شده: X از Y» — when `totalAmount` is null the block reads «جمع کل اعلام
  نشده است» and NO status word is shown (status `null` ≠ UNPAID).
- **Table:** date (Jalali display, exact Gregorian ISO in `title`), amount (Persian
  digits, currency code, sign-colored only via word «+ پرداخت» / «− جبران»), method
  word (نقد/تنخوره/چک), refs (payerRef/payeeRef/invoiceRef/externalReference) as
  muted single-line cells with full-text on hover, recordedBy, actions.
- **Compensation row linking:** a row with `reversesPaymentId` renders as reversal of
  its target (both rows visually linked; target marked «جبران‌شده»). Never allow
  compensating a row that already has one (server 409 message quoted).
- **Add payment dialog:** amount + method + date + refs; busy state; on success the
  table reloads (no optimistic insert — money must never render before the server
  confirms) **[UX DECISION]**.
- **Filters:** method select (3 values) — server-side filter; note that `paymentStatus`
  beside the page stays whole-history (backend rule), so filtering never changes the
  status block (avoiding the "status changes while typing" confusion).
- **States:** empty «هنوز پرداختی ثبت نشده است.»; loading skeleton rows; section error
  independent of the page.

## 14. RECEIVING UX (detail tab «رسیدها»)

**[CONFIRMED contract, UX DECISION presentation]**

- **Per-line progress table first** (the projection), receipts list second: line label
  + ordered/received + word status + progress bar (bar is redundant decoration; the
  words are primary).
- **Add receipt dialog:** pick lines with remaining receivable (>0 remaining shown as
  «قابل دریافت: R»), quantity per line, optional receivedAt (Jalali picker); client
  blocks quantities > remaining ONLY as a pre-validation hint with an inline warning —
  server remains the authority (409 quoted verbatim with line number and quantities).
- **Compensation:** per receipt-line action «ابطال پاره‌ای» with POSITIVE magnitude
  input ≤ remaining compensable, optional reason ≤500; dialog states that the original
  receipt row is never modified — a new compensating event is appended («ردیف اصلی
  دست‌نخورده می‌ماند»).
- **Confusion guards:** receiving is an INDEPENDENT lifecycle — the tab never claims
  «تحویل کامل» changes the document status; FULLY_RECEIVED is a line-level fact.

## 15. RETURN UX (detail tab «مرجوعی‌ها»)

**[CONFIRMED contract, UX DECISION presentation]**

- **Create return dialog:** line picker restricted to RECEIPTED quantity (from the
  receipts projection: remaining returnable = netReceived − alreadyReturned; shown as
  «قابل مرجوعی: R» — display-only), per-line receipt-line origin selection (each
  purchase line's receipt lines are listed from the receipts read so the user cannot
  guess an id), reason (required, 1…500), replacementRequired checkbox
  («نیاز به جایگزینی دارد» — a FLAG only; no linked replacement document exists).
- **Return card:** state chain rendered as 4-step progress (or 3-step when REJECTED),
  lines with quantities, transitions list (state word, actor, reason, exact datetime).
- **Actions by state (exactly the backend matrix):** REQUESTED → «تأیید»/«رد»;
  APPROVED → «دریافت مرجوعی» (empty-body command — confirmation dialog with NO inputs,
  just consequence text); RECEIVED_BACK → «استرداد وجه» (payment picker from the
  payments read + reason).
- **409 handling:** `over_return` shows the three quantities from the server message
  and refreshes the projections; `invalid_transition` explains the legal source state;
  `refund_compensation_failed` explains the refund did NOT happen and leaves the return
  in RECEIVED_BACK (state shown after refresh).
- **Never:** edit/delete a return (no routes), cancel via UI (no cancel route),
  show stock/warehouse implications (explicitly out of C1 scope).

---

## 16. WORKFLOW CONFIGURATION UX (two documented levels)

### 16.A Process CONSUMPTION UX (ordinary users)

Covered by §10.5: understandable progress only — completed / current / upcoming, the
current step's display name (from configuration), who it waits on (resolved approver
where the runtime exposes it), and the decisions already recorded. Terms like
`executionMode`, `parallelJoinPolicy`, `onConditionFalse`, rule sets and fact
catalogues NEVER appear at this level **[UX DECISION]**. States like SKIPPED/DELEGATED
appear only as words when the runtime read returns them (GAP-1).
**Blocked/EXPIRED:** N's §18 says `BLOCKED` cannot be published and `EXPIRED` has no
writer — so the consumption UX never renders them until a real read shows them.

### 16.B Process CONFIGURATION UX (administrators, L3)

Screen map (all reads/writes [CONFIRMED]):

1. **Definitions list** — code, name, versionCount, createdAt; create/rename dialogs
   (`commerce.configure`).
2. **Versions list (per definition)** — versionLabel, status, triggerEvent,
   parallelJoinPolicy, selectionPriority/selectionCondition, publishedAt, step count;
   status filter; create version (`commerce.workflow.manage`).
3. **Version detail / step editor** — step table: stepKey, displayName, ordering,
   executionMode, parallelGroup, mandatory, actorSource (+actorUserId/actorRoleCode),
   condition/onConditionFalse, thresholds, lineFilters, configuration (JSON); add/edit/
   delete while DRAFT; reorder via full-id permutation.
4. **Lifecycle bar:** validate → publish → archive as gated state actions with issue
   checklist from validate (max 64 issues; refusal codes shown verbatim with Persian
   explanation, e.g. WORKFLOW_ACTOR_SOURCE_UNSUPPORTED = «فقط CONFIGURED_USER در انتشار
   پشتیبانی می‌شود»).
5. **Immutability notice:** PUBLISHED/ARCHIVED = full read-only + «ایجاد نسخهٔ جدید».

**Honest limitations to bake into copy [CONFIRMED from N §18]:** five actor sources are
modelled but unexecutable (publish refuses); `BLOCKED` refused; line-level `lineFilters`
are O's territory (publish refuses `WORKFLOW_LINE_SCOPE_UNSUPPORTED`); selection
condition validated against the frozen v1 fact catalogue. The editor may ALLOW drafting
these (DRAFT write accepts them) but must pre-warn that publish will refuse **[UX
DECISION: warn early rather than at publish]**.

**Out of scope:** visual rule-builder, drag-anywhere canvas, auto-publish, in-place
edit of published versions — none is supported by the backend contract.

---

## 17. RTL / PERSIAN UX CONTRACT

All [CONFIRMED] from existing shell + [UX DECISION] for Commerce specifics:

1. **html:** `lang="fa" dir="rtl"` is global (root layout) — Commerce pages inherit;
   never set dir on a subtree (would break logical properties).
2. **Typography:** Vazirmatn via `font-vazirmatn`; headings per §3 scale; Persian body
   text 14–16px, line-height ≥1.7 for readability.
3. **Numerals:** all user-facing numbers render with `toPersianDigits` (۰–۹);
   percentages/dates same. Payloads and `data-testid`s stay Latin.
4. **Money:** exact backend decimal strings are parsed for display formatting only;
   Persian digit grouping; currency code shown as suffix («۱۲۵٬۰۰۰ ریال» style with
   the document's `currency`, or «—» when null). Never re-round (4dp preserved).
5. **Dates:** Jalali presentation via existing helpers (`formatJalaliLabel`/
   `formatJalaliLongLabel`) with exact ISO in `title`/`datetime` attributes; backend
   timestamps are UTC ISO strings; **whether the product standardizes Jalali-only or
   dual display is [UNKNOWN] — calendar module is Jalali-first, so Commerce follows
   Jalali-first [UX DECISION]**.
6. **Mixed LTR content (identifiers):** document numbers, UUIDs, refs, codes (e.g.
   `DRAFT` fallback) render inside `dir="ltr"` spans with `unicode-bidi: isolate`;
   placed at logical END of sentences in RTL flow; copy buttons for document number.
7. **Tables:** text columns `text-start` (logical!), numeric columns `text-end`
   (`text-nowrap`); no hardcoded left/right utilities — always logical (`start/end`,
   `ms/me`, `ps/pe`).
8. **Icons:** Lucide icons are mirrored by layout, not by flipping glyphs — arrows
   (chevrons) explicitly mirrored (`scale-x-[-1]` only where the glyph implies
   direction, e.g. `ChevronLeft` used for "forward" in RTL); decorative icons
   `aria-hidden`.
9. **Sidebar rail:** right-anchored (already handled by shell); Commerce entries only
   add nav rows.
10. **Tooltips/popovers:** must anchor with RTL-aware positioning; precedent:
    shell's `CoreDateChip`/`CoreNotificationBell` patterns — no shared tooltip
    primitive exists, so any Commerce popover reuses those conventions.
11. **Long Persian text:** truncate with ellipsis only when a title/full text is
    available on hover/focus; line descriptions wrap (never truncate silently);
    200-char `technicalDescription` gets multi-line cells.
12. **Keyboard order:** follows DOM order which follows visual RTL order; logical
    properties keep focus flow right-to-left automatically.

---

## 18. RESPONSIVE CONTRACT

Desktop-first for enterprise operations **[UX DECISION]**, but not desktop-only.
Breakpoints reuse Tailwind defaults; the shell's rail/drawer switch is exactly
`lg:` (1024px) [CONFIRMED].

| Band | Navigation | Tables (lines, payments, receipts, returns, register) | Detail lifecycle strip | Create form |
|---|---|---|---|---|
| ≥1440 large | expanded rail | full tables, generous columns | 6 cells in one row | 3 columns |
| 1024–1439 | expanded rail | full tables, compact | 6 cells wrap to one row / 3+3 | 2 columns |
| 768–1023 tablet | rail auto → drawer | full table with horizontal scroll + sticky first column (documentNumber) | wrap 3×2 | 2 columns |
| <768 mobile | drawer | **stacked row cards** (definition rows: label + value pairs) — never a shrunken table | vertical list | single column, sections separated |

Rules:
- **Tables never shrink below readability** — the switch to stacked cards happens at
  <768px by component choice, not by CSS alone [UX DECISION].
- **Contextual panels become drawers** on small screens (decision panel opens as a
  bottom-anchored sheet with the same focus trap).
- **Priority of information on small screens** (first → later): status + primary
  action → summary strip → lifecycle cells → first tab content → tables.
- **Primary action stays discoverable:** sticky bottom action bar on mobile for the
  single primary action (create/detail screens); never two competing sticky buttons.
- Dense admin screens (workflow step editor) allow horizontal scroll of their own
  table rather than reflowing configuration fields.

## 19. ACCESSIBILITY CONTRACT

Follow existing Aria conventions where established (skip link, `role=status`
skeletons, focus traps, `focus-visible` rings) — [CONFIRMED] + [UX DECISION] for
Commerce specifics:

1. **Landmarks:** each screen = one `<main>` (shell provides) + page `<h1>`
   (`HrPageHeading` pattern) → `<h2>` per card/section → `<h3>` per tab panel head.
   No heading jumps.
2. **Buttons vs links:** navigation = `<Link>`/`<a>`; actions = `<button type="button">`;
   row-click navigation implemented as a real link inside the row (never a div
   onClick).
3. **Accessible names:** every icon-only control has `aria-label` (copy number,
   expand row, close dialog); tables use `<caption class="sr-only">` or
   `aria-labelledby` pointing at the section heading.
4. **Tabs:** `role="tablist"/"tab"/"tabpanel"`, `aria-selected`, roving tabindex with
   Left/Right (RTL: arrows reversed visually but follow focus order), `aria-controls`.
   Precedent: `CorrReferralDialog` / `CoreSettingsCenter`.
5. **Dialogs:** `role="dialog" aria-modal="true" aria-labelledby`; focus moves to the
   dialog on open, is trapped while open, restored to the opener on close; Escape
   closes non-destructive dialogs; backdrop click never discards typed form data
   (explicit «انصراف») **[UX DECISION]**.
6. **Live regions:** mutation outcomes announce via `role="status"` (success) /
   `role="alert"` (error) — `HrNotice` pattern; busy submits set `aria-busy`.
7. **Forms:** every input has a `<label>` (or `aria-label`), errors wired with
   `aria-invalid` + `aria-describedby`, required marked in text AND visually; error
   summary gets focus on submit failure.
8. **Color-independence:** every status = word first (§3 tone convention); progress
   bars have `role="progressbar"` with `aria-valuenow/min/max` + textual value.
9. **Reduced motion:** honor `prefers-reduced-motion` (drawer/accordion transitions
   become instant) — shell already uses CSS transitions that respect it; framer-motion
   variants in Commerce must add reduced-motion guards if used at all.
10. **Touch targets:** ≥40×40px for icon buttons on mobile (shell precedent `h-10 w-10`).
11. **Screen-reader clarity for mixed content:** announce document number as a whole
    (isolate span), money amounts include currency in the accessible name
    («۱۲۵٬۰۰۰ ریال»), status badges include the state word only once.

---

## 20. COMPONENT REUSE / CREATE MATRIX

Classification: **R** = reuse existing as-is · **E** = extend existing (small, shared
change) · **C** = Commerce-specific new component · **S** = new shared component
(justified beyond Commerce — candidate for `components/ui/`). All entries
[CONFIRMED existence claims + UX DECISION classifications].

| Candidate primitive | Class | Basis / notes |
|---|---|---|
| Page header | **E** | Copy the `HrPageHeading` pattern; justify promoting to `components/ui/page-heading.tsx` **S** only if a second module asks (HR owns it today) [UX DECISION: start Commerce-local `commerce-ui.tsx` mirror] |
| Status badge | **C** → **S** candidate | `HrBadge` tone machinery is HR-typed; Commerce needs its own label/tone table (`commerce-labels.ts`) but the visual classes should be byte-identical. Do NOT import `hr-ui` into Commerce (module boundary). Re-evaluate a shared `Badge` after UI-2 |
| Action bar / buttons | **R/E** | `components/ui/button.tsx` variants + busy state via `aria-busy` |
| Summary card | **R** | `core-card` + `HrCard`-style section markup (Commerce-local copy) |
| Timeline | **C** | no existing timeline; used only for milestones (§10.4) |
| Workflow progress | **C** | GAP-1-gated; must not exist before a runtime read exists |
| Task card/list row | **C** | queue row = HR precedent shape (expand-in-row) |
| Line editor / data table | **C** | inline `<table>` convention; stacked-card variant for mobile |
| Responsive data table wrapper | **C → S candidate** | if a `TableStack` wrapper proves out, propose promoting (needs decision; do not pre-create) |
| Empty / loading / error / forbidden | **R** | `CoreStates` exactly |
| Confirmation dialog | **C → S candidate** | no shared dialog; follow `CorrReferralDialog` conventions (`role=dialog`, focus trap) inside Commerce first |
| Drawer / side sheet | **C** | follow `CoreShell` drawer focus-management; no shared primitive |
| Decision panel | **C** | Commerce-only concept |
| Money display | **C** | `commerce-money.ts` display helper (parse exact decimal string, Persian digits, 4dp rule, null ≠ 0) — pure module, unit-tested |
| Date display | **R/E** | `calendar-api` Jalali helpers; Commerce wrapper adds title=ISO |
| Status label/tone tables | **C** | `commerce-labels.ts` — the single home for every enum→Persian mapping |
| Toast | **R (pattern)** | no toast library — use inline `HrNotice`-style banners (persisted per section), never invent a toast system |
| Tabs | **E/C** | shell precedent is inline `role=tablist`; a shared `ui/tabs.tsx` is **S** but requires an explicit promotion decision — UI-1 keeps it Commerce-local unless signalled otherwise |
| JSON config editor | **C** | monospace textarea + JSON parse validation (config screens only) |
| Progress bar | **C** | tiny, `role=progressbar`; candidate for `ui/` later |

**Rules:** (1) never duplicate an equivalent — check this table first; (2) no new
dependencies (RHF/Zod/framer-motion/lucide all pre-installed) [CONFIRMED package.json];
(3) Commerce-local file naming: `components/commerce/commerce-ui.tsx`,
`commerce-labels.ts` etc. (the `hr-*`/`corr-*` precedent); (4) every interactive
component exposes `data-testid`.

---

## 21. API INTEGRATION MATRIX

Every row verified against the repository (controller + DTO + service sources). Global
prefix `/api/v1`. All responses are consumed through `core-http` (envelope-unwrapped).
Permission = `@Roles` string. [CONFIRMED] unless tagged **GAP**.

### 21.1 Purchase documents

| UI Screen | API | Method | Request | Response shape (key fields) | Permission |
|---|---|---|---|---|---|
| Register `/purchases` | `/commerce/purchase-documents` | GET | `page?pageSize?search?status?requesterId?` | `{items:[document],page,pageSize,total}` | `commerce.read` |
| Detail `/purchases/[id]` | `/commerce/purchase-documents/:id` | GET | path uuid v4 | `{id,documentNumber,kind,status,editable,requester:{id,profile|null},supplierId,currency,subtotalAmount,taxAmount,totalAmount,lines[],createdAt,updatedAt}` | `commerce.read` |
| Create `/purchases/new` | `/commerce/purchase-documents` | POST | `{requesterId,supplierId?,currency?,lines:[{lineType,quantity,unit,unitPrice?,tax?,externalRef?,itemReference?,technicalDescription?}]}` (1…200 lines) | document (as above) + 201 | `commerce.manage` |
| Detail edit (DRAFT) | `/commerce/purchase-documents/:id` | PATCH | partial `{requesterId?,supplierId?,currency?,lines?}` (`undefined`=keep, `null`=clear) | document | `commerce.manage` |
| Submit | `/commerce/purchase-documents/:id/submit` | POST | — | document (200) | `commerce.manage` |

Mutation/cache notes: no query library — every mutation ends with an explicit re-read
of the affected screens (detail sections + register + dashboard counters). 409 =
state moved; 400 = field errors. `search` matches `documentNumber` only.

### 21.2 Commercial

| UI Screen | API | Method | Request | Response | Permission |
|---|---|---|---|---|---|
| Detail → بازرگانی | `/commerce/commercial-assignments?documentId=` | GET | required uuid | `{documentId, assignments:[CommercialAssignment rows], history:[…]}` | `commerce.read` |
| Assign dialog | `/commerce/commercial-assignments` | POST | `{lineId,groupId,reason?}` | created row + 201 | `commerce.manage` |
| Detail → approvals | `/commerce/commercial-approvals?documentId=` | GET | required uuid | `{documentId, approvals:[rows incl. approverUserId,status,decidedAt,decidedByUserId,comment]}` | `commerce.read` |
| Decision panel | `/commerce/commercial-approvals/:id/decision` | POST | `{decision:'APPROVED'|'REJECTED', comment?}` | decided row (200) | `commerce.approve` |
| Tasks (Option A) | compose register GET + approvals GET per document | GET×n | — | filtered client-side by `PENDING && approverUserId===me` | `commerce.read` (+`commerce.approve` semantics) |
| Commercial config list | `/commerce/commercial-configurations` | GET | page params | `{items,page,pageSize,total}` | `commerce.read` |
| Config detail/create/update/validate/publish/archive | `/commerce/commercial-configurations[/:id][/validate|/publish|/archive]` | GET/POST/PATCH | DTO per §12.2 | version row | `commerce.configure` |
| Groups list/CRUD | `/commerce/commercial-groups[/:id]` | GET/POST/PATCH | `{code,name,liaisonUserId?}` | group rows | `commerce.read` / `commerce.configure` |

### 21.3 Operations (detail tabs)

| UI Screen | API | Method | Request | Response | Permission |
|---|---|---|---|---|---|
| Payments | `/commerce/purchase-documents/:id/payments` | GET | `page?pageSize?method?` | `{items:[row],page,pageSize,total, paymentStatus:{status, paidAmount, totalAmount, …}}` (status over WHOLE history) | `commerce.read` |
| Add payment | same | POST | `{amount>0,method,paymentDate?,payerRef?,payeeRef?,invoiceRef?,externalReference?}` | row + 201 | `commerce.manage` |
| Compensate payment | `…/payments/:paymentId/compensate` | POST | `{paymentDate?,externalReference?,reason?}` (body optional) | row + 201 | `commerce.manage` |
| Receipts | `…/:id/receipts` | GET | — | `{receipts:[…], lines:[{purchaseLineId,orderedQuantity,receivedQuantity,receivingStatus}]}` (unpaged) | `commerce.read` |
| Add receipt | `…/:id/receipts` | POST | `{receivedAt?, lines:[{purchaseLineId,quantity>0}]}` | receipt + 201 | `commerce.manage` |
| Compensate receipt line | `…/receipts/:receiptLineId/compensate` | POST | `{quantity>0, receivedAt?, reason?}` | receipt + 201 | `commerce.manage` |
| Returns | `…/:id/returns` | GET | — | `{returns:[{id,reason,replacementRequired,requestedByUserId,createdAt,state,lines[],transitions[]}]}` | `commerce.read` |
| Create return | `…/:id/returns` | POST | `{reason, replacementRequired, lines:[{purchaseLineId,receiptLineId,quantity>0}]}` | return + 201 | `commerce.manage` |
| Approve/Reject return | `…/returns/:returnId/approve|reject` | POST | `{reason?}` | return + 201 | `commerce.manage` |
| Receive back | `…/returns/:returnId/receive-back` | POST | **no body** (any field = 400) | return + 201 | `commerce.manage` |
| Refund | `…/returns/:returnId/refund` | POST | `{paymentId, reason?}` | return + 201 | `commerce.manage` |

**Not touched:** audit (platform trail, no Commerce read route) · notifications (2
AMQP events exist; no user-facing Commerce notification API) · search (not indexed).

### 21.4 Workflow configuration

| UI Screen | API | Method | Request | Response | Permission |
|---|---|---|---|---|---|
| Definitions list | `/commerce/workflow-definitions` | GET | page params | `{items:[{id,code,name,versionCount,createdAt,updatedAt}],page,pageSize,total}` | `commerce.read` |
| Definition detail | `/commerce/workflow-definitions/:id` | GET | — | definition (+versionCount) | `commerce.read` |
| Create / rename definition | `…/workflow-definitions[/:id]` | POST/PATCH | `{code,name}` / `{name}` | definition | `commerce.configure` |
| Versions list | `/commerce/workflow-definitions/:id/versions` | GET | `status?` + page | version summaries | `commerce.read` |
| Create version | `…/definitions/:id/versions` | POST | `{versionLabel,…}` | version (DRAFT) | `commerce.workflow.manage` |
| Version detail (with steps) | `/commerce/workflow-versions/:versionId` | GET | — | version + `steps[]` (ordered) | `commerce.read` |
| Version routing fields edit | `/commerce/workflow-versions/:versionId` | PATCH | trigger/join/selection (omitted=keep, null=clear) | version | `commerce.workflow.manage` |
| Validate / Publish / Archive | `…/workflow-versions/:versionId/{validate|publish|archive}` | POST | — | version (+issues for validate) | `commerce.workflow.manage` |
| Step CRUD | `…/workflow-versions/:versionId/steps[/:stepId]` | POST/PATCH/DELETE | step DTO per §16.B | step / removed id | `commerce.workflow.manage` |
| Reorder | `…/workflow-versions/:versionId/steps/order` | PUT | `{order:[uuid,…]}` full permutation | version | `commerce.workflow.manage` |

### 21.5 Rows that do NOT exist (explicit — never fabricate)

| UI need | Status |
|---|---|
| Workflow instance list/detail (progress, current step, approver) | **BACKEND GAP-1** (N contract defines it; zero production route; isolation spec asserts absence) |
| Workflow step decision / instance cancel | **BACKEND GAP-1** (same; plus service wires approve-path only) |
| Tenant-wide pending approvals queue (commercial or workflow) | **BACKEND GAP-1b** (Option A composition used instead — §8.1) |
| Line-routing configuration read/write | **BACKEND GAP-2** (O has no HTTP surface; test probe only) |
| Document close/complete action (`→CLOSED`) | **BACKEND GAP-3** (edge deliberately absent in C1 §11) |
| Commerce aggregate/KPI endpoint (dashboards/reports) | **BACKEND GAP-6** |
| Commerce items in global search | **BACKEND GAP-5** (not in `search-routes.ts`/indexer) |
| Activity/audit timeline for a document | **BACKEND GAP-9** (audit not exposed via Commerce) |
| Notification-per-user contract («X را تأیید کنید» bell) | **GAP/UNKNOWN** — only 2 AMQP events exist (`commerce.purchase_document.submitted`, `commerce.workflow.line.routed`); no delivery-to-user semantics evidenced in Commerce |

---

## 22. ROUTE MAP

Proposed `apps/web/src/app/admin/commerce/**` structure (App Router), following the
existing conventions (HR/Correspondence shapes) [UX DECISION]:

| Route | Page component shell | Loads | Rail entry |
|---|---|---|---|
| `/admin/commerce` | `CommerceHomeView` | counters + latest + areas | ✅ group «تدارکات», leaf, gated `commerce.read` |
| `/admin/commerce/tasks` | `CommerceTasksView` | tabs per §8 | ✅ gated `commerce.approve`/shown with drafts for `commerce.manage` |
| `/admin/commerce/purchases` | `CommercePurchaseListView` | register | ✅ gated `commerce.read` |
| `/admin/commerce/purchases/new` | `CommercePurchaseCreateView` | form | ❌ (leaf; register/empty-state CTAs) |
| `/admin/commerce/purchases/[id]` | `CommercePurchaseDetailView` | document + 5 sibling reads | ❌ (id = data, never a nav target) |
| `/admin/commerce/commercial` | `CommerceCommercialConfigView` | groups + versions | ✅ gated `commerce.read` (actions gated `commerce.configure`) |
| `/admin/commerce/commercial/configurations/[id]` | `CommerceCommercialVersionView` | one version | ❌ (leaf) |
| `/admin/commerce/workflows` | `CommerceWorkflowDefinitionsView` | definitions | ✅ gated `commerce.read` (actions gated `commerce.workflow.manage`) |
| `/admin/commerce/workflows/[definitionId]` | `CommerceWorkflowVersionsView` | versions | ❌ (leaf) |
| `/admin/commerce/workflows/versions/[versionId]` | `CommerceWorkflowVersionView` | version + steps | ❌ (leaf) |

**Rules:** (1) each rail entry requires a `CORE_NAV` item **and** a `NAV_TARGETS`
entry (permissions mirrored exactly: `commerce.read` for the read-visible entries;
tasks needs its own gate) in the SAME change — the 49K drift test enforces parity
[CONFIRMED constraint]. (2) Leaf routes are NOT nav targets (precedent: `/admin/hr/
employees/:id` absent) and thus not favouritable/recents-recordable.
(3) `pageTitleFor` resolves titles via nav labels; leaf pages set `metadata.title`
client-side conventions as other modules do. (4) Layout: all under the existing
`AdminLayout` — no new layout route is needed **[UX DECISION]** (a nested
`app/admin/commerce/layout.tsx` is introduced only if Commerce needs a shared
module-level sub-nav; deferred to UI-1 with evidence of the need).

---

## 23. LOADING / EMPTY / ERROR / SUCCESS / DENIED / CONFLICT STATES

Applies to every major screen (register, detail, tasks, create, config screens).
The four primitives are `CoreLoading`, `CoreEmpty`, `CoreError`, `CoreForbidden`
[CONFIRMED] + Commerce rules [UX DECISION]:

### INITIAL LOADING
- Skeletons, never spinners-with-blank-page: page-level skeleton (heading block + 4
  rows) until the primary read resolves; secondary sections render their own row
  skeletons in parallel — **the header (identity/status) appears the moment the
  document read lands**, even if sibling reads are pending.
- Minimum blocking surface: only a screen with NO data shows the full skeleton; a
  re-fetch (refresh action) shows an inline busy indicator instead of blanking.

### EMPTY
- Always: what is empty (Persian noun) + why it might be + next useful action.
  Examples: «هنوز درخواست خریدی ثبت نشده است» + CTA (when `commerce.manage`);
  «پرداختی ثبت نشده — اگر پرداختی انجام شده، آن را ثبت کنید.»;
  «کاری در نوبت شما نیست.»
- Empty ≠ zero-valued totals: unpriced documents show «—», not ۰ (§1 rule 5).

### ERROR
- Human sentence first (Persian), technical detail available but secondary; **server
  messages with `{code,message}` bodies are shown with their code in a muted
  monospace line** for support (return 409s, commercial failure codes) [UX DECISION].
- Retry button always available for reads (`CoreError.onRetry` pattern).
- Distinguish: **validation** (inline fields, no banner spam) · **permission** (403 →
  `CoreForbidden`, no retry — retrying cannot succeed) · **conflict** (409 → see
  below) · **server failure** (5xx/other → `CoreError` + retry) · **not found** (404 →
  «این مورد یافت نشد.» + link back to register) · **entitlement** (module-level frozen
  code → module unavailable page, no per-screen retries).

### SUCCESS
- Deterministic, local, immediate: mutation result renders its success banner
  (`role=status`) in the section that acted; state word visibly changes after re-read;
  navigation only happens when the flow says so (create → detail), never on save.
- No optimistic updates for money/receipts/returns/decisions [UX DECISION]; simple
  navigations (favourite toggle-like UI-only state) may be optimistic.

### PERMISSION DENIED
- 403 never renders data; screen explains which grant is missing when the frontend
  knows the string («برای این بخش به مجوز commerce.approve نیاز دارید.» — exact
  permission strings are already shown by HR precedent `CoreForbidden message=…`);
  safe navigation links (register/home) offered; **no leak of ids/details** (a 404 for
  foreign resources is rendered as 404-equivalent, never as "forbidden" — matching the
  backend's no-probe rule).

### CONFLICT / STALE DATA
- 409 messages are shown as the server phrased them + a refresh path:
  «وضعیت سند تغییر کرده است — داده‌ها به‌روزرسانی شوند؟» with «بروزرسانی» that
  re-reads; **user-entered form data is preserved** across the refresh where the
  conflict doesn't invalidate it (create form, decision comment); if it does
  invalidate (e.g. lines replaced by another editor), the conflict is stated
  explicitly and the user chooses discard/keep — never a silent overwrite.

---

## 24. NAVIGATION STRATEGY

### 24.1 How Commerce joins the existing global navigation model [CONFIRMED + UX DECISION]

- One new rail **group** «تدارکات» in `CORE_NAV` with FOUR visible items (home, tasks,
  purchases, and one combined configuration entry? — **decision:** keep بازرگانی and
  گردش کار as two items for permission clarity; five items total) + matching
  `NAV_TARGETS` entries. Group is visible when the user holds ANY commerce grant is
  **not expressible** — nav items gate on ONE permission each:
  home/purchases/commercial/workflows entries → `commerce.read`;
  tasks entry → `commerce.approve` (drafts live inside home/purchases for
  `commerce.manage` users without approve) [UX DECISION].
- Sub-tree: none required at first (flat group, like HR's) — purchases/{new,[id]} are
  not rail rows. Re-evaluate an expandable «درخواست‌های خرید» tree only if register
  sub-views (e.g. «پیش‌نویس‌های من») become standalone routes later.

### 24.2 Participation in existing mechanisms (do not duplicate)

- **Favorites:** rail stars work automatically for Commerce nav entries (they are
  `favoriteable` by default) — no in-module favourite UI.
- **Recents:** visits to Commerce nav targets are recorded automatically via
  `isRecordableVisit`; leaf routes are excluded by exact-match `isNavTarget` rule.
- **Global search:** Commerce does NOT appear (GAP-5); in-module search on the
  register uses the server `search` param of the list route — the ONLY search Commerce
  offers. No parallel command palette.
- **Header:** no Commerce-specific header additions; the bell remains the platform
  notification centre (Commerce has no per-user notifications — GAP/UNKNOWN above).
- **Dashboard widgets:** Core home stays untouched (§7.3).
- **Breadcrumbs:** the app has no breadcrumb system [CONFIRMED absence] — detail pages
  use an explicit «بازگشت به فهرست درخواست‌ها» link instead of inventing a second
  navigation pattern [UX DECISION].
- **Contextual navigation INSIDE detail:** tabs (§10.4) carry `role=tablist` and
  preserve scroll position on switch (client state, no URL change) — deep-linking a
  tab (`?tab=`) is **deferred [UX DECISION]**: URL-stable tabs would make every tab a
  nav target question; revisit if shareability is requested.

---

## 25. UX RISKS / AMBIGUITIES

| # | Risk / ambiguity | Class | Mitigation |
|---|---|---|---|
| R1 | Document stuck in SUBMITTED with NO user-visible workflow detail (GAP-1) — users will ask «چرا گیر کرده؟» | **BACKEND GAP** → UX risk | Honest copy («در حال تصمیم‌گیری»), no fake timeline; escalate GAP-1 |
| R2 | Tasks Option A composition caps at latest 20 SUBMITTED docs — an approver may miss older items | **[UX DECISION]** with known bound | Show «نمایش N مورد اخیر» caveat; push GAP-1b |
| R3 | Commercial rows expose raw `tenantId` and unresolved user ids (repository rows returned verbatim) | **[CONFIRMED observation]** | Frontend must NOT render or depend on `tenantId`; render ids muted; report for backend hygiene |
| R4 | `commerce.commercial.manage` seeded but unused; quotation/confirmation UIs impossible | **CONFIRMED absence** | IA non-goal (§4.4); document to product |
| R5 | No supplier directory — supplierId is opaque; users may expect a real supplier picker | **CONFIRMED design** | Label field «شناسهٔ تأمین‌کننده (متن آزاد)» honestly |
| R6 | Digits/dates conventions: Jalali-first assumed; product hasn't ratified dual display | **[UNKNOWN]** | §17 Jalali-first decision flagged for sign-off |
| R7 | Requester picker depends on directory permission (`admin.users.read`) which is NOT seeded for all | **[CONFIRMED risk]** | Self-default fallback (§9.1); GAP-8 note |
| R8 | Six lifecycle cells may over-promise (six cards) on thin data | **[UX DECISION]** risk | Cells collapse to one-line chips when section empty; never show meaningless zero states |
| R9 | Two parallel decision systems (workflow vs commercial) confuse users | **[CONFIRMED]** architecture | Single "decision" vocabulary in UI, separated only inside config screens; never both shown as "approval" on one panel without labels |
| R10 | No poll/refresh — stale queues after another approver acts | **[UX DECISION]** | 409 handling + manual refresh + re-read on focus; revisit if GAP-1b lands |
| R11 | `metadata.title`/headings for leaf routes not handled by `pageTitleFor` | **[CONFIRMED]** mechanism | Follow existing per-page `metadata` conventions; dynamic leaves may use `CoreShellProps.title` override if needed |
| R12 | Workflow config editor allows drafting values publish will refuse | **[CONFIRMED from N §18]** | Pre-warn in editor (§16.B) |
| R13 | Payments list is paged while receipts/returns are not — inconsistent UX patterns | **[CONFIRMED]** contract | Payment tab gets pager; others state «تمام رویدادها»; never invent pagination for unpaged reads |

---

## 26. BACKEND GAPS (explicit; UI must not fake these)

### §26-GAP-1 — Workflow execution HTTP surface (CRITICAL)

- **Evidence:** `commerce-isolation.spec.ts` test A1 asserts NO
  `workflow-execution.controller.ts` may exist ("N … with no HTTP surface in this
  shell"); `commerce.module.ts` registers exactly 6 controllers; the N contract
  (`PHASE-C1-N-WORKFLOW-EXECUTION-CONTRACT.md` §11) specifies
  `GET /commerce/workflow-instances[/:id]` + `POST …/steps/:stepInstanceId/decision`
  + `POST …/cancel` — none exists. The service layer
  (`WorkflowExecutionService.approveStep`, `WorkflowExecutionRepository.listInstancePage`
  with `approverId` filter) already implements the logic; only the HTTP layer is
  absent.
- **Blocks:** workflow progress on Purchase Detail (§10.5), workflow approvals in
  My Tasks (§8.1), "who is responsible now" for SUBMITTED documents, instance cancel.
- **Additional sub-gap:** `approveStep` wires the APPROVED path only — the decision
  route's REJECTED value (planner-supported, `planWorkflowStepDecision`) has no
  service method; confirm intent when the controller is added.
- **Required shape (as specified by N §11, not invented here):** reads with
  `commerce.read`, decisions/cancel with `commerce.approve`.

### §26-GAP-1b — Tenant-wide pending-decision queue

- **Evidence:** commercial approvals are document-scoped only
  (`CommercialDocumentQueryDto.documentId` REQUIRED); no
  `/commercial-approvals/pending` exists (HR has the precedent
  `/hr/missions/approvals/pending`).
- **Workaround (UI-1):** Option A composition (§8.1), bounded and honest.
- **Ideal fix:** a server-resolved queue route.

### §26-GAP-2 — Line-routing configuration surface

- **Evidence:** no `workflow-line-routing.controller.ts` (asserted by the isolation
  spec); O's config (routes, priorities, conditions, aggregation policy,
  noRouteBehavior/multipleMatchBehavior) is exercised by an e2e test probe only.
- **Blocks:** any UI showing WHY a line routed where it did, and routing config
  administration. Until then routing remains admin-only via backend/data work.

### §26-GAP-3 — Document `CLOSED` transition

- **Evidence:** `PURCHASE_DOCUMENT_TRANSITIONS` has no `→CLOSED` edge; C1 §11 records
  this deliberately (precondition/permission/owner unspecified).
- **UX impact:** no "close/complete purchase" action may be designed; APPROVED is the
  practical terminal until product defines closure.

### §26-GAP-4 — Reports/aggregates for the Commerce dashboard

- No `GET …/summary` analog exists (HR has `/hr/organization/summary`).
- Dashboard counters must come from list totals (§7.2); richer analytics need a new
  endpoint family (product decision first).

### §26-GAP-5 — Global search participation

- `search-routes.ts` + indexer contain no Commerce entities. Purchase document search
  exists only as the register's `search` param. Adding Commerce to global search =
  backend indexer work + route constants + web search-ui types.

### §26-GAP-6 — Quotation / confirmation / correction surfaces

- `commerce.commercial.manage` is catalogued+seeded but referenced by ZERO routes;
  C1 §9 explicitly defers quotation entry. No UI may be designed for it (§4.4).

### §26-GAP-7 — Document-level activity/audit timeline

- Audit rows live in platform `AuditLog` (resource `commerce.*`) but no Commerce read
  route exposes them; observability UI is admin-scoped and separate.
- Detail «فعالیت‌ها» tab therefore shows read-derived milestones only (§10.4).

### §26-GAP-8 — Requester/member picker within Commerce

- No Commerce member-search endpoint; the Core directory route requires
  `admin.users.read` (seeded per Core policy, not guaranteed for every requester).
- Fallback: self-default requester. A Commerce-scoped "verify member" read would be
  cleaner but does not exist (`assertMember` is internal-only).

### §26-GAP-9 — Per-user notification contract

- Only two AMQP events exist
  (`commerce.purchase_document.submitted`, `commerce.workflow.line.routed`); no
  evidence of user-addressed Commerce notifications in the notification centre.
  The bell cannot honestly show «درخواست X منتظر شماست».
- Needs a platform/product decision (who receives what, dedupe, read state).

---

## 27. FUTURE UI IMPLEMENTATION PHASES

Proposed breakdown [UX DECISION] — each phase is a separate prompt/gate; **nothing
below starts without its gate being passed**:

### UI-1 — Design Foundation + Shell Integration + Home/Tasks/Register
Files that WOULD be created/modified (exact, per current conventions):
- **Create:** `apps/web/src/lib/commerce-api.ts` (typed client, mirrors §21 — no
  `tenantId` anywhere), `apps/web/src/lib/commerce-labels.ts` (all enum→Persian +
  tones), `apps/web/src/components/commerce/commerce-ui.tsx` (page heading, badge,
  card, notice — §20), `CommerceHomeView`, `CommerceTasksView`,
  `CommercePurchaseListView` (+ rows), route pages under
  `apps/web/src/app/admin/commerce/{page.tsx,tasks/page.tsx,purchases/page.tsx}`,
  tests: `commerce-api` spec, `commerce-labels` spec, list/home/tasks jsdom specs.
- **Modify:** `apps/web/src/components/core/core-nav.ts` (new group + items),
  `apps/api/src/preferences/nav-catalogue.ts` (matching `NAV_TARGETS`),
  `apps/web/src/components/core/__tests__/core-nav.spec.ts` (+hrefs — the drift test).
- **Explicitly NOT:** no backend changes, no Core visual changes, no new deps.

### UI-2 — Purchase Create + Detail (documents, lines, lifecycle cells, tabs without workflow)
- **Create:** `CommercePurchaseCreateView` (+line editor component + Zod schema
  module), `CommercePurchaseDetailView` (header/summary/cells/tabs), detail section
  components for commercial (J6 panel), payments (J7), receipts (J8), returns (J9),
  money/date display helpers, tests per §28 list.

### UI-3 — Decisions & Tasks deepening
- Commercial decision panel end-to-end, Tasks Option A composition + caps, conflict
  handling (409 matrix), optimistic-free mutation flows.

### UI-4 — Configuration surfaces
- Commercial groups/versions screens; workflow definitions/versions/steps editor
  (lifecycle gating, validate/publish flows, JSON condition fields).

### UI-5 — GAP-gated polish (only when backend gaps close)
- Workflow progress + step decisions (GAP-1), pending-queue route adoption
  (GAP-1b), activity timeline if exposed (GAP-7), global search (GAP-5),
  notifications (GAP-9).

### Test strategy for UI phases (defined BEFORE implementation) [UX DECISION]
- **Level:** jsdom component/integration specs (jest + RTL + user-event — all
  installed) + the repo's puppeteer visual-QA script convention for RTL/layout passes.
- **Queries:** semantic (`getByRole('button', {name})`, headings, `getByText` for
  Persian copy), NEVER class/testid-first; `data-testid` reserved for E2E hooks.
- **Coverage expectations per phase:** (a) permission visibility — absent grant ⇒
  no request issued AND no control rendered; (b) RTL — `dir` inherited, no
  left/right-locked utilities, Persian digits in numbers; (c) states — loading
  skeleton, empty copy, 403/404/409/500 rendering; (d) forms — Zod messages mirror
  DTO bounds, input preserved after server 400, no double submit; (e) navigation —
  nav visibility, drift-test parity for new hrefs, most-specific active row;
  (f) purchase lifecycle presentation — status words from vocabulary only;
  (g) decision interactions — mismatch/not-pending error paths with preserved
  comment; (h) keyboard — dialog focus trap/restore, tab arrow keys, skip-link;
  (i) responsive — stacked-table switch and sticky action bar at <768px (visual QA
  script).
- **Anti-patterns (explicitly banned):** asserting on internal state, snapshot-only
  tests, tests that pass while the request never fires, English-only copy tests.

---

## 28. EXPLICIT ACCEPTANCE CRITERIA (for UI-0)

UI-0 is DONE when:

1. ✅ This document exists at `docs/PHASE-UI-0-COMMERCE-UX-CONTRACT.md` with all 28
   required sections (1–28 as mandated by §22 of the phase prompt).
2. ✅ Every route/field/enum/permission stated here is traceable to a repository file
   (naming convention used inline), and every non-factual item carries
   **[UX DECISION]** / **[UNKNOWN]** / **[BACKEND GAP]**.
3. ✅ The API matrix (§21) covers every screen in the IA (§4) and explicitly lists
   non-existent endpoints (§21.5) — no fabricated API remains anywhere.
4. ✅ BACKEND GAPS are enumerated (§26) with evidence and the screens they block.
5. ✅ Component strategy (§20) references only primitives verified to exist or
   explicitly marked as new Commerce-specific work.
6. ✅ Navigation contract accounts for BOTH `core-nav.ts` and `NAV_TARGETS` (49K
   drift test) — a hard prerequisite for UI-1.
7. ✅ NO production pages/components/routes/API clients were created in UI-0; no
   backend, Core, token, or dependency changes were made (verified by git status in
   the UI-0 closeout).
8. ✅ The proposed UI phase breakdown (§27) exists with exact file lists for UI-1.
9. ⛔ **STOP:** do not proceed to UI-1 automatically — await the next prompt.

---

*End of PHASE UI-0 contract.*

---

# APPENDIX — PHASE UI-5 AMENDMENTS (appended, never overwriting UI-0)

Material UX decisions made in UI-5 that CHANGE or REFINE a decision recorded above. Each states
the previous decision, the new one, the reason and the affected screens. Everything not amended
here still stands exactly as written above.

## UI-5-A — The requester is chosen, never typed (amends §9 / §26-GAP-8)

- **Previous decision (UI-2):** Purchase Create's requester was a free-text field seeded with
  the session user's id and validated client-side as UUID v4 («شناسهٔ درخواست‌کننده باید یک UUID
  معتبر باشد»).
- **New decision (UI-5):** the requester is SELECTED through the Core directory
  (`GET /users/directory?q=`) via the shared `CommerceMemberPicker` when the session holds
  `admin.users.read` — the route's own gate — and shown as a read-only statement («خود شما», or
  the loaded requester's name) with the missing grant named when it does not. A session whose
  own id is not a legal `requesterId` (the GAP-8 seed mismatch, e.g. `super-admin-user`) starts
  UNSELECTED with «درخواست‌کننده انتخاب نشده است» instead of a value the server would refuse. The
  picker never offers a non-UUID member, and the requester cannot be cleared.
- **Reason:** no normal business user can produce a UUID; §26-GAP-8 already names self-default
  as the *fallback*, and the directory search is the only read that can produce a legal id.
  Verified live against the seed identity.
- **Affected screens:** Purchase Create, Purchase Edit, and the shared Commerce member picker
  (groups / step actor / approver keep their behaviour, now filtered to storable ids).

## UI-5-B — The detail header answers «چه کاری می‌توانم انجام دهم؟» (refines §10.3 / §17)

- **Previous decision:** Purchase Detail's header showed identity, status and the draft-only
  actions; a pending commercial decision was discoverable only inside the Commercial tab (or
  through My Tasks).
- **New decision (UI-5):** when the page's OWN document-scoped approvals read reports a PENDING
  record whose `approverUserId` is the session user and the session holds `commerce.approve`,
  the identity card renders one callout — «N تصمیم بازرگانی در انتظار شماست» + «بررسی و
  تصمیم‌گیری» — that opens the Commercial tab. Submit now refetches exactly assignments and
  approvals, because the server creates them inside the submit.
- **Reason:** §11's low-click, obvious-next-action principle. The data was already on the page:
  no new request, no GAP-1b dependency, no invented assignee.
- **Affected screens:** Purchase Detail.

## UI-5-C — One term for the document (refines the §33 vocabulary)

- **Previous:** «سند درخواست خرید» (headings) beside «سند خرید» (8 consequence sentences) and
  «درخواست جدید» (register CTA).
- **New:** the document is «سند درخواست خرید» in full and «سند» when context is unambiguous; the
  create action is «درخواست خرید جدید» on Home, in the register and on the form; both back
  actions read «بازگشت به فهرست درخواست‌ها».
- **Reason:** §7/§10 fix «درخواست خرید» as the kind label; the third variant was drift, not a
  distinction.
- **Affected screens:** Commercial Decision panel, Returns, Commercial Configuration,
  Purchase List, Purchase Create, Purchase Detail.

---

## UI-C2 — Backend inbox and execution routes available (amends the §26 "Tasks (Option A)" note and the §11 route table)

- **Previous (still the UI's live behavior):** the Home/Tasks pending list composes the
  register GET + per-document approvals GET and filters client-side
  (`PENDING && approverUserId === me`) — the bounded Option A. Workflow pending steps were
  not representable at all client-side.
- **New (backend only, PHASE C2):** the server now answers the whole question in one paged,
  session-scoped read, and exposes the execution actions it implies:

  | Surface | Route | Notes |
  |---|---|---|
  | Tasks inbox | `GET /api/v1/commerce/pending-decisions?page&pageSize` | `commerce.read`; `{items, page, pageSize, total}`; items are `{kind: 'WORKFLOW_STEP' \| 'COMMERCIAL_APPROVAL', id, status: 'PENDING', createdAt, purchaseDocumentId, documentNumber, purchaseLineId, workflowInstanceId, stepKey, stepName}` — opaque ids, never `tenantId`; ordering `createdAt` desc / `id` asc |
  | My runs | `GET /api/v1/commerce/workflow-instances?status&subjectId&page&pageSize` | `commerce.read`; same page envelope; steps as persisted |
  | Run detail | `GET /api/v1/commerce/workflow-instances/:id` | `commerce.read`; steps + persisted outcomes (no condition input snapshot) |
  | Decide step | `POST /api/v1/commerce/workflow-instances/:id/steps/:stepInstanceId/decision` | `commerce.approve`; `{decision: 'APPROVED'\|'REJECTED', comment? ≤500}` → `200 {instanceId, status}`; stale → 409 with `WORKFLOW_*` code |
  | Cancel run | `POST /api/v1/commerce/workflow-instances/:id/cancel` | `commerce.approve`; → `200 {instanceId, status:'CANCELLED'}`; nothing else moves |

- **Reason:** §26's option D (server-authoritative eligibility) and the standing rule that a
  client must not be the place where actionability is decided. Option A stays documented as
  the UI's CURRENT implementation so no reader assumes the screens already call these
  routes; the table above is the adoption contract for the next UI phase.
- **Affected screens (when adopted, not now):** Home/Tasks, Purchase Detail (workflow tab),
  and any future «نیازمند اقدام من» surface. No UI file changed in C2.

---

## UI-C3 — Line-routing configuration routes available (amends the §26-GAP-2 row and the §4.1 "structurally absent" sentence for line routing)

- **Previous (still the UI's live behavior):** line-routing configuration had NO HTTP surface.
  UI-4's `CommerceSettingsOverview.tsx` documents the «مسیردهی اقلام» branch as **absent, not
  disabled**, because a card would have promised a save that could not exist, and no client or
  type in `commerce-api.ts` models routing.
- **New (backend only, PHASE C3 / GAP-2):** the capability step O built is now reachable:

  | Surface | Route | Notes |
  |---|---|---|
  | Routing versions list | `GET /api/v1/commerce/routing-versions?page&pageSize&search` | `commerce.read`; `{items, page, pageSize, total}`; ordering `createdAt` desc / `id` asc; `search` matches `versionLabel`; items never carry `tenantId` |
  | Routing version detail | `GET /api/v1/commerce/routing-versions/:id` | `commerce.read`; the stored `routeRules` are part of the read |
  | Open a DRAFT | `POST /api/v1/commerce/routing-versions` | `commerce.workflow.manage`; `{versionLabel ≤64, trigger ∈ {PURCHASE_SUBMITTED, AFTER_DOCUMENT_WORKFLOW_APPROVED}, noRouteBehavior ∈ {REJECT_OPERATION, LEAVE_UNROUTED}, multipleMatchBehavior ∈ {HIGHEST_PRIORITY, AMBIGUOUS_ERROR}, aggregationPolicy ∈ {ALL_APPROVED, INDEPENDENT}, routeRules[≥1] of {priority, targetWorkflowDefinitionVersionId, condition?, description?}}` → `201` + view (`status: 'DRAFT'`) |
  | Publish | `POST /api/v1/commerce/routing-versions/:id/publish` | `commerce.workflow.manage`; the existing validated transition → `200` + view (`status: 'PUBLISHED'`); republish → 409 `WORKFLOW_LINE_ROUTING_VERSION_ALREADY_PUBLISHED` |
  | Duplicate label | (any create) | 409 `WORKFLOW_LINE_ROUTING_VERSION_LABEL_TAKEN` — one label per tenant |

- **NOT available (and therefore not to be rendered):** no update/draft-edit route, no
  `/validate`, no `/archive`, no `DELETE`, and no per-line routing badge: routing is evaluated
  server-side and only published configuration is readable. A «مسیردهی اقلام» settings branch may
  be built against the table above; it must not imply those missing operations.
- **Reason:** the UI-0 §4.1 sentence ("`workflow-line-routing.controller.ts` … structurally
  absent") and the §26-GAP-2 row are now superseded by the surface above; the O contract's own
  status note records the same change. Nothing else in this contract moved.
- **Affected screens (when adopted, not now):** Settings → تدارکات و فرآیند خرید (a new
  «مسیردهی اقلام» branch) only. **No UI file changed in C3.**

---

*End of PHASE UI-0 contract (with UI-5, UI-C2 and UI-C3 amendments).*

