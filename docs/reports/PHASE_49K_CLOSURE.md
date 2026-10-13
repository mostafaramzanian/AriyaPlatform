# Phase 49K — Core Experience Platform: Closure & Capability Matrix

**Status: CLOSED — GREEN. Section 3 (Experience Audit) closed; sections 4.1–4.11
delivered and browser-validated; sections 5–19 completed with evidence. Final gate
in Section 19.**

This is the durable record for Phase 49K. It is written incrementally, starting
with the Section 3 capability matrix, so the audit conclusion survives a context
loss and no later step has to re-derive it.

Scope: a permission-aware widget-registry Core Dashboard plus unified
personalization (theme, density, text scale, reduced motion, favorites/recent,
navigation preferences) with accessibility and responsive baselines. **No
redesign. No business-logic change.**

Baseline: `master` @ `ad82604` ("Phase 49J: Core global search (lexical and
semantic)"), which itself sits on `9d31e5b` (49J-0) and `e0e3cca` (49J-A).

## Working-tree note (pre-existing, NOT 49K)

`git status` at the start of this phase already reported one modified tracked
file:

- `apps/web/src/app/layout.tsx` — the favicon link changed from
  `/favicon.ico` to `/icon.svg` + `type="image/svg+xml"` in an earlier session.
  Untouched and uncommitted here.

The untracked artifacts recorded in the 49J closure (`ERP_Structure_v12.xml`,
`api-mounts.json`, `apps/api/.rid`, `apps/api/.tok`, `apps/api/tmp-jest.txt`,
`apps/web/srv-out.txt`, `apps/web/srv-err.txt`, `ws-install2.txt`,
`ws-install3.txt`) are all still present, plus the `phase49*-shots/` screenshot
directories and `phase49i-validate.mjs`. None are modified by this phase.

## Section 3 — Experience Audit: capability matrix

Legend for **State**:

| State | Meaning |
| --- | --- |
| EXISTING | Implemented and adequate; 49K does not touch it |
| PARTIAL | Implemented but incomplete, unpersisted, or scoped to the wrong surface |
| MISSING | No implementation at all |
| BROKEN | Implemented but does not work as a user would expect |
| DEFERRED | Deliberately out of scope with a recorded justification |

### 3.1 Appearance

| # | Capability | State | Current implementation | Usability issue | A11y issue | Effort | Value | Proposed action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Light/dark theme | PARTIAL | `ThemeProvider.tsx` + `ThemeScript` in `app/layout.tsx`; `.dark` / `[data-theme]` token blocks in `src/styles/globals.css`; `ThemeToggle` in `CoreHeader` | Preference lives only in `localStorage` under `aria-theme`, so it does not follow the user to another browser or device, and a cleared cache silently resets it | None — pre-paint script prevents a flash, `color-scheme` is set, contrast tokens exist for both themes | S | High | Keep the pre-paint script and the token blocks unchanged. Extend the provider to read/write the server preference, treating `localStorage` as a cache for the pre-paint path only |
| A2 | Explicit "follow system" theme | MISSING | `ThemeScript` falls back to `prefers-color-scheme` only while no value is stored; the first toggle makes the choice permanently sticky | A user who wants the OS to keep deciding has no way back after one toggle | None | S | Medium | Add `SYSTEM` as a third stored value. `SYSTEM` resolves through `matchMedia` at paint time and follows later OS changes |
| A3 | UI density (Comfortable / Compact) | MISSING | Nothing. Spacing is hardcoded per component (`h-11 px-3` nav rows, `p-6 md:p-8` cards, `h-[72px]` header) | On a 1366×768 laptop the Core shell shows very few rows per screen and there is no way to tighten it | None | M | High | Add density tokens to `src/styles/globals.css`, driven by a `data-density` attribute on `<html>`, consumed through Tailwind theme extensions. No per-component overrides |
| A4 | Text scale (100 / 110 / 125 / 140) | MISSING | Nothing. Font sizes are fixed Tailwind classes | Users who need larger text must zoom the whole browser, which also scales layout and causes horizontal scrolling in the RTL shell | Significant: no in-app path to larger text, which is the single most requested low-vision accommodation | M | High | Add a root `--text-scale` token applied to `html { font-size }`, with `rem`-based type. Verify no fixed-height container clips at 140% |
| A5 | Reduced motion | PARTIAL | `usePrefersReducedMotion()` exists in `apps/web/src/hooks/useMediaQuery.ts` but is used by **no** Core component; the only consumer of the media query is the marketing `AriaHeroAnimator.tsx`. Core animates unconditionally (`transition-[width] duration-300` sidebar, `duration-300` drawer slide, `animate-pulse` skeletons, `hover:-translate-y-0.5` cards) | A motion-sensitive user gets the full animation set in the Core shell even with the OS switch on | Real WCAG 2.3.3 gap: the OS preference is ignored where it matters most | S | High | Add a global `@media (prefers-reduced-motion: reduce)` block plus a `data-reduced-motion` override token so the user can force it independently of the OS |
| A6 | RTL layout | EXISTING | `<html lang="fa" dir="rtl">`; logical properties used throughout (`start-*`/`end-*`, `border-e`, `rounded-e-full`), with the RTL direction traps documented in `CoreSidebar` and `CoreShell` | None found | None found | — | — | No change. Any new widget must use logical properties, never `left`/`right` |
| A7 | Language switching | **DEFERRED** | `apps/web/src/lib/i18n.ts` exposes a `t()` helper with `fa.json`/`en.json`, consumed by exactly **one** file — `src/components/sections/PageSections.tsx` (marketing). There is no locale provider, no locale routing, no locale in the URL or in storage, and every Core string is hardcoded Persian in the component that renders it | — | — | XL | — | **Do not ship a language toggle in 49K.** A switch over a single marketing file would change nothing in the Core UI while telling the user the product is bilingual. Real switching needs Core string extraction, a locale provider, locale-aware routing, and a `dir` that follows the locale — a phase of its own. Recorded here as the justification |

### 3.2 Dashboard

| # | Capability | State | Current implementation | Usability issue | A11y issue | Effort | Value | Proposed action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | Core dashboard | PARTIAL | `CoreDashboard.tsx` — three hardcoded sections: a hero with the user's email, an identity card, and a role/permission summary from `GET /rbac` | Static for every user and every role. Nothing is actionable: it shows who you are, not what needs your attention | Reasonable: `aria-labelledby` on each section, `dl/dt/dd` for pairs, `CoreStates` for loading/empty | L | High | Rebuild as a registry-driven grid. Keep the honest-data rule that made this file safe: no fabricated metric survives into 49K |
| D2 | Widget registry | MISSING | Nothing. The dashboard is JSX, not data | A new widget means editing the dashboard component; nothing can be reordered or hidden | — | M | High | Introduce `WidgetDefinition` (id, title, category, default order, required capability, responsive size, render source, optional config), decoupled from the database, modelled on how `core-nav.ts` already describes navigation |
| D3 | Reorder / hide / show / reset | MISSING | Nothing | The dashboard cannot be adapted to a role that only cares about two of the panels | — | M | High | Reorder + visibility + reset, persisted as a layout JSON. RBAC stays authoritative: a saved layout can never resurrect a widget the caller lacks the capability for |
| D4 | Layout persistence | MISSING | Nothing to persist | — | — | M | High | Store the layout in the new user-scoped preference row |
| D5 | Per-widget error isolation | MISSING | A throw inside any dashboard section takes the whole page down; only the RBAC card handles its own failure (`error` branch) | One failing data source blanks the entire landing page | — | S | High | An error boundary per widget, degrading to a single failed card while its neighbours render |
| D6 | Notifications widget | MISSING | Backend and client both EXIST: `GET /notifications`, `GET /notifications/unread-count` (49E), surfaced today only in the header bell | The landing page does not show what is waiting for you | — | S | High | Widget over the existing 49E contract. No new endpoint, no change to the 49E backend (frozen zone) |
| D7 | Calendar/reminder widget | MISSING | Backend and client both EXIST: `GET /calendar/today`, `GET /calendar/reminders` (49I), surfaced today only in the sidebar date chip and the calendar page | Upcoming reminders are invisible from the dashboard | — | S | High | Widget over the existing 49I contract. 49I logic is a frozen zone — read-only consumption |
| D8 | Quick actions | PARTIAL | One hardcoded link to `/admin/blog`, not permission-gated | Shown to every user including those without `blog.read`, so it can point at a page the caller will be refused | — | S | Medium | Derive from `core-nav.ts` + the caller's permissions so the list is always reachable |
| D9 | Available modules | MISSING | `CORE_NAV` + `visibleNavGroups()` already compute exactly this for the sidebar | A new user has no overview of what they may open | — | S | Medium | Widget reusing `visibleNavGroups`, no second source of truth |
| D10 | Aggregated dashboard read | MISSING | Today each surface fetches independently (bell, date chip, RBAC card) | A registry of N widgets each fetching on mount would fan out into N requests on every dashboard load | — | M | High | One aggregated request per dashboard load. No per-widget fan-out and no N+1 |

### 3.3 Navigation & productivity

| # | Capability | State | Current implementation | Usability issue | A11y issue | Effort | Value | Proposed action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | Sidebar collapse | BROKEN (as a preference) | `const [collapsed, setCollapsed] = React.useState(false)` in `CoreShell.tsx` | The collapse works, but the state is component-local: it resets on every reload and on any route change that remounts the shell. A user who prefers the narrow rail must re-collapse it constantly | None | S | High | Persist through the preference layer, with the same SSR-safe hydration approach as the theme |
| N2 | Favorites | MISSING | Nothing — no favorite/pin concept anywhere in the repo | Frequently used pages are always the same number of clicks away | — | M | High | User-scoped favorites over `core-nav` hrefs, re-filtered by RBAC on every read |
| N3 | Recent items | MISSING | Nothing | No way back to what you just had open | — | M | Medium | Bounded recent list, RBAC-filtered on read. **Excludes security events and login history** — those are audit surfaces, not navigation history |
| N4 | Nav group expand/collapse memory | PARTIAL | `expanded` state in `CoreSidebar` is local and starts empty every mount | Sub-menus re-collapse on every navigation | None | S | Low | Fold into the navigation preference if it costs nothing; not a phase goal on its own |
| N5 | Stale/unauthorized preference entries | MISSING | No persisted nav state exists yet, so nothing can go stale — but the risk arrives with N2/N3 | A favorite kept after a permission is revoked would show a link that 403s | — | S | High | Re-apply the RBAC filter on every read, never only on write. A revoked entry disappears rather than erroring |

### 3.4 Accessibility & responsive baseline

| # | Capability | State | Current implementation | Usability issue | A11y issue | Effort | Value | Proposed action |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| X1 | Skip link | EXISTING | `.skip-link` in `app/layout.tsx` → `#content` | None | `focus:top-4 focus:left-4` is a physical offset in an RTL document, so the revealed link appears on the visually trailing side | XS | Low | Note only. Not changed unless the density/text-scale work touches that rule |
| X2 | Focus visibility | EXISTING | Global `:focus-visible` outline using `--ring`, plus explicit `focus-visible:ring-2` on interactive Core elements | None | None | — | — | No change. New widget controls must keep a visible focus ring |
| X3 | Loading / empty / error states | EXISTING | `CoreStates.tsx` — `role="status"` + `aria-live="polite"` + `aria-busy` for loading, `Alert` for errors, message-only empties (never placeholder rows) | None | None | — | — | Reuse as-is for every widget. Do not invent a second state vocabulary |
| X4 | Nav sub-menu toggle | BROKEN (a11y) | In `CoreSidebar.NavRow` the chevron is a `<span role="button" tabIndex={0}>` nested **inside** the `<Link>` | Works with mouse and with Enter/Space | Interactive control nested inside another interactive control — invalid ARIA, and screen readers announce an ambiguous target | S | Medium | UX-only fix if it can be done without disturbing the visual language: move the toggle out of the anchor. Deferred rather than forced if it would require restructuring the rail |
| X5 | Mobile drawer | EXISTING | `CoreShell` keeps it mounted for the slide, `aria-hidden` while closed, `tabIndex={-1}` on the overlay when closed, `pointer-events-none` so it cannot intercept clicks, and the `lg:` seam at exactly 1024px is documented | None | Correct while closed | — | — | No change |
| X6 | Focus trap / restore in the drawer | MISSING | Opening the drawer does not move focus into it; Escape is not bound at the drawer level (only in the header user menu) | Keyboard users must tab through the page to reach the drawer they just opened | Real gap for keyboard-only navigation | S | Medium | Add focus-in on open, focus-restore on close, Escape to close |
| X7 | Responsive layout | EXISTING | `lg:` rail vs. drawer, `md:grid-cols-2` dashboard, `max-w-[1600px]` main, `sm:`/`lg:` padding steps | None found at 390 / 768 / 1024 / 1440 in prior phases | — | — | — | Extend, do not redesign: the widget grid must be responsive per widget size |
| X8 | Preference model / API | MISSING | `apps/api/prisma/core/schema.prisma` holds 31 models and **none** is a user preference or dashboard-layout table. Nothing user-scoped exists beyond the feature tables (`Notification`, `Reminder`, …) | Every personalization above therefore has nowhere to live server-side | — | M | High | One user-scoped preference model (appearance / accessibility / navigation / dashboard / productivity), unique per user, JSON for the dashboard layout, plus a non-destructive migration in the `20260831120000_add_calendar_reminders` style |

## Audit conclusion

Of the 30 audited capabilities: **6 EXISTING**, **5 PARTIAL**, **16 MISSING**,
**2 BROKEN** (N1 sidebar collapse as a preference, X4 nested nav toggle), **1
DEFERRED** (A7 language switching).

The single structural blocker is **X8**: there is no user-scoped preference
storage in the Core schema (31 models, 13 enums, none of them a preference or
layout table), so every personalization capability in 3.1–3.3 is unimplementable
server-side until it exists. It is therefore the first implementation step, and
it is additive — one new table, one new inbound foreign key on `User`, no column
change to any existing table, no enum removal.

The two capabilities with the highest accessibility value are **A4** (text scale)
and **A5** (reduced motion), because both are currently unreachable from inside
the product: A4 has no in-app path at all, and A5 has a hook
(`usePrefersReducedMotion`) that no Core component calls.

The highest-value dashboard work is **D6/D7** rather than new data: the
notification (49E) and reminder (49I) contracts already exist and are already
consumed by the web client, so surfacing them as widgets adds no backend and no
fabricated metric.

## Frozen zones honoured by this phase

Read-only consumption only; no semantics changed in any of these:

- **49J search** — stays YELLOW per its own closure register; UX-only edits
- **49I calendar** — reminder logic, the Jalali date contract, the dispatcher
- **49J-0** — AI provider architecture and credential handling
- **49E** — notification backend, including the server-only creation path

## Implementation order (derived from the matrix)

1. **X8** — preference model + non-destructive migration against `:5433`
2. Preferences API — `GET`/`PATCH /me/preferences`, current-user pattern from
   `users.controller.ts`, whitelist DTOs with `forbidNonWhitelisted`, no `userId`
   parameter, defaults returned when no row exists
3. Frontend preference layer — one provider as the source of truth; `ThemeProvider`
   extended for SSR-safe hydration; density / text-scale / reduced-motion tokens in
   `src/styles/globals.css` + `tailwind.config.ts`
4. Widget registry + `CoreDashboard` rebuild (D1–D5)
5. Real-data widgets (D6–D9) behind one aggregated read (D10)
6. Navigation personalization (N1–N3, N5)
7. A11y follow-ups (X6, and X4 if it stays UX-only)
8. Tests: API specs, web Jest, E2E isolation, extended `phase49i-validate.mjs`

## Section 4 — Delivery status: dashboard rebuild and navigation personalization

Covers implementation steps 4–6 of the order above. Steps 1–3 (X8 schema,
preferences API, frontend preference layer) landed earlier in the phase and are
consumed here rather than re-described.

### 4.1 Dashboard (D1–D10)

| ID | Status | Delivered as |
| --- | --- | --- |
| D1 | DONE | `CoreDashboard.tsx` rewritten. The three hardcoded sections are gone; the page now maps a stored layout over the registry. One `useCorePermissions()` read is shared through `CoreWidgetContext` instead of each card fetching `/rbac` |
| D2 | DONE | `core-widgets.ts` — `WIDGET_IDS`, `WIDGET_LABELS`, `WIDGET_SPAN`/`isWideWidget()`, plus `WIDGET_COMPONENTS: Record<WidgetId, CoreWidgetComponent>` in `CoreDashboardWidgets.tsx`. The `Record` is the drift guard: a registry id with no component is a compile error, so the catalogue and the renderable set cannot diverge |
| D3 | DONE | `CoreDashboardLayoutEditor.tsx` — up/down reorder, per-widget visibility, reset. Fully props-driven, so it is testable without a provider. The editor lists **hidden widgets too**; a control that only listed visible ones would make hiding a card irreversible |
| D4 | DONE | `dashboardLayout` on `PATCH /me/preferences`. Reset sends `{ resetDashboardLayout: true }` and never a layout body, because only SQL `NULL` is the server's "never customised" state |
| D5 | DONE | `CoreWidgetBoundary` in `CoreWidgetCard.tsx` — the repo's first error boundary, deliberately widget-scoped. Logs to the console, renders a Persian fallback naming the failed card (`data-testid="core-widget-error"`), offers no retry |
| D6 | DONE | `NotificationsWidget` over the existing 49E contract. No backend change |
| D7 | DONE | `RemindersWidget` over the existing 49I contract. Read-only consumption |
| D8 | DONE | `QuickActionsWidget` built from the user's favourites when there are any, falling back to the reachable navigation. Every pill is intersected with `visibleNavGroups()`, so a favourite whose permission was revoked disappears instead of becoming a link to a 403 |
| D9 | DONE | `ModulesWidget` reusing `visibleNavGroups()`. No second source of truth |
| D10 | **DECIDED — deliberately NOT built.** | No aggregated `/dashboard` endpoint. See 4.3 |

Two mechanisms in `CoreDashboard.tsx` are load-bearing rather than cosmetic:

- **The `layoutPending` gate.** The page renders `CoreLoading` until the stored
  layout arrives. Rendering registry defaults first would mount hidden widgets
  and fire their requests before the user's layout was known — the fan-out D10
  is meant to avoid, caused by the fix for it.
- **The all-hidden empty state.** Hiding every widget is reachable, so the page
  names the editor by which to recover instead of rendering blank.

### 4.2 Navigation personalization (N1–N5)

| ID | Status | Delivered as |
| --- | --- | --- |
| N1 | DONE (step 3) | `sidebarCollapsed` through the preference layer; consumed by `CoreShell.tsx` |
| N2 | DONE | `PinnedGroup` in `CoreSidebar.tsx` renders favourites above the static groups, expanded rail only. Star toggle inside `NavRow`: `role="button"`, `aria-pressed`, `aria-disabled` at `MAX_NAV_FAVORITES`, Enter/Space, and `stopPropagation` + `preventDefault` so pinning a row never navigates away from the page |
| N3 | DONE | A bounded recents group (`RECENT_RAIL_LIMIT = 5`) that excludes the current path and anything already favourited — the present page is not a way back, and a favourite is already pinned one group above. Recording is gated by `isNavTarget()` in `core-nav.ts`, mirroring the server's `NAV_TARGETS` allowlist, so `/admin/blog/42` produces no write the server would discard |
| N4 | NOT DONE | Nav group expand/collapse memory. Matrix-scored Low and explicitly not a phase goal; it would have meant a new preference field for no capability |
| N5 | DONE | Both lists are re-intersected against the locally visible navigation on **every render**, not only on write — the server filters on read as well, so a revoked permission removes the entry at both layers |

### 4.3 D10 — decision record: no aggregated dashboard endpoint

The matrix proposed "one aggregated request per dashboard load". That is **not**
what was built, and the reversal is deliberate.

What the rebuilt page actually issues on load: `GET /me/preferences` (already
required by the shell, not a dashboard cost), one `GET /rbac`, one
`GET /notifications`, one `GET /calendar/reminders`. Four requests, of which two
are dashboard-specific.

Why no composed endpoint:

- **The feared N+1 was in the RBAC read, and that is fixed without an endpoint.**
  Six widgets each calling `useCorePermissions()` would have meant six `/rbac`
  reads. The page performs one and passes it down as `CoreWidgetContext` — a
  client-side fix for a client-side problem. A test asserts the count is exactly
  one.
- **Only two widgets fetch at all.** Identity, access, quick-actions and modules
  are pure functions of the session, the shared RBAC read, and `core-nav.ts`. An
  aggregate would have wrapped two calls.
- **An aggregate would re-implement two frozen contracts.** 49E notifications and
  49I calendar are frozen zones. A `/dashboard` route returning their payloads
  would become a second reader of both, with its own shape to keep in sync — the
  duplication D9 avoids in the navigation, reintroduced on the server.
- **Hidden widgets must cost nothing.** A user who hides notifications should
  issue no notification request. Per-widget fetching gives that for free; an
  aggregate would have to be told which widgets are visible, making the layout an
  input to a server read.
- **Failure isolation is weaker in an aggregate.** Today a failed reminder read
  degrades one card. One endpoint means one status code for the whole page unless
  it returns per-section errors, which is the fan-out again with extra encoding.

Revisit only if a future widget count makes the fan-out measurable; the registry
is the natural place to add a batched loader if so. `WIDGET_SPAN` and
`isWideWidget()` stay client-only for the same reason: layout is presentation,
and mirroring them in the API catalogue would give the server an opinion about
CSS.

### 4.4 Verification evidence (this step)

Run from `apps/web`:

| Check | Command | Result |
| --- | --- | --- |
| Types | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | exit 0, no diagnostics |
| Web unit suite | `node ../../node_modules/jest/bin/jest.js --silent` | exit 0 — **40 suites / 662 tests passed** |

Baseline before this step was 38 suites / 628 tests, so the step adds 2 suites
and 34 tests:

- `__tests__/CoreDashboard.spec.tsx` (new, 18 tests) — registry order default,
  stored order wins, a hidden widget neither renders nor requests, all-hidden
  recovery, a single `/rbac` read, the editor (move up/down asserted through the
  outgoing patch, disabled edge moves, hide, reset via `resetDashboardLayout`,
  unauthenticated `persisted=false` path), boundary isolation, RBAC-filtered
  pills, and the no-provider default render.
- `__tests__/CoreSidebarPersonalization.spec.tsx` (new, 11 tests) — mounted over
  the **real** `PreferenceProvider` and the **real** `CORE_NAV` with only HTTP
  mocked: favourites pinned above the static groups in stored order, a revoked
  favourite dropped, add/remove through the star, visible refusal at the cap,
  no star on the collapsed rail, recents excluding the current page and pinned
  entries, the `RECENT_RAIL_LIMIT` bound, and the pre-49K rail without a provider.
- `__tests__/core-nav.spec.ts` (extended, +5 tests) — `isNavTarget()` accepts
  every server-allowlisted href, matches exactly rather than by prefix, rejects
  near-misses, ignores permissions (recording is not authorization), and fails if
  `CORE_NAV` and the server's `NAV_TARGETS` ever drift apart.

`CoreSidebar.spec.tsx` and `CoreShell.spec.tsx` pass unchanged despite the two
new `core-nav-group` nodes and the star inside every expanded row.

**One pre-existing flake, recorded rather than hidden.** Across three full runs
of the web suite, two were green (40/40, 662/662) and one reported a single
failure in `CoreSurveyDetailView.spec.tsx` — a 49H suite this step does not
touch. It passes in isolation (20/20, repeatedly). The suite drives every
assertion through `findBy*` / `waitFor` on their default 1 s budget, which is
what lapses when parallel workers contend for CPU. Not a regression from this
step, and not fixed here either: raising those budgets belongs to whoever owns
49H.

**Not run in this step:** the API Jest suite, E2E, and
`phase49i-validate.mjs`. No API file was touched here, but the closure sign-off
still owes those runs.

### 4.5 Accessibility deltas (X1, X4, X6) — audit findings closed

Section 3 above is the audit as it was taken and is left unedited; this is what
changed since.

| ID | Audit state | Now | Delivered as |
| --- | --- | --- | --- |
| X1 | EXISTING, with an RTL note | **DONE** | `.skip-link` used `focus:top-4 focus:left-4` — a physical offset in a `dir="rtl"` document, so the revealed link appeared on the visually **trailing** side, away from where focus starts. Now `focus:start-4` (logical), `focus:fixed` rather than `focus:absolute` so it cannot be scrolled away with the page, `z-[60]` so it clears the `z-40` sticky header, and themed tokens instead of `bg-white`, which was invisible-on-invisible in dark mode |
| X4 | BROKEN (a11y) | **DONE** | `CoreSidebar.NavRow` restructured: the row is a `<div data-testid="core-nav-item">` holding the `<Link>` plus real sibling `<button>`s (favourite star, expand chevron), so no interactive control is nested inside an anchor and activation/focus/announcement come from the platform instead of hand-written key handlers. The active indicator moved to the row for the same reason. The visual language is unchanged — the row keeps `data-active`/`data-expandable` and the whole hover treatment |
| X6 | MISSING | **DONE** | `CoreShell.tsx`: `drawerPanelRef`, an open effect that moves focus to the panel's first focusable element, `handleDrawerKeyDown` cycling Tab/Shift+Tab inside the panel, Escape to close, and focus restored to the trigger on close. The drawer stays **mounted** so it can slide, which is precisely why focus must be managed by hand — nothing about mounting tells the browser that a layer just covered the page |

Two more accessibility items were closed by the appearance work itself rather
than by a targeted fix: **A4** text scale is now reachable in-product (100 / 110
/ 125 / 140 through `html { font-size: calc(100% * var(--text-scale)) }`, which
multiplies the user's own browser base instead of overriding it), and **A5**
reduced motion now has three real states where the OS switch was previously
ignored by every Core component.

### 4.6 Browser validation harness (`phase49k-validate.mjs`)

`apps/web/phase49k-validate.mjs` drives real Chrome against the running dev
stack (`:3000` web, `:3001` API, `aria-erp-postgres`) and asserts **rendered
effects**, not `data-*` attributes: a `data-density="compact"` that changed no
row height would pass an attribute check and fail a user. Every appearance check
is therefore paired with a measurement, and every persistence check is paired
with a direct `psql` read of the stored row, because the pre-paint
`localStorage` cache would otherwise reproduce the same appearance after a
reload whether or not anything was saved.

Result: **38/38 checks passed**, screenshots in
`apps/web/phase49k-shots/01`–`09`.

| Area | Checks | What is actually asserted |
| --- | --- | --- |
| X1 skip link | 3–4 | First Tab reveals `.skip-link`, and it lands on the RTL **leading** (right) side: `right=1424` of a 1440 viewport. This is the X1 audit finding fixed, not just noted |
| Appearance | 6–9 | COMPACT shrinks the nav row 44px → 36px; 140% moves the root font 16px → 22.4px (×1.4 ±0.02); REDUCED collapses the rail transition 0.3s → 1e-05s. Density is measured **before** the text scale changes, since row height is a rem token and 140% text would mask the compact shrink |
| Persistence | 10–12 | After a full reload the appearance holds, the DB row reads `DARK\|COMPACT\|140\|REDUCED`, and `aria-pref-owner` is the signed-in user id |
| Text-scale layout | 13–14 | No horizontal overflow (0px) on settings and on the dashboard at COMPACT + 140%, with 6 widgets rendered — the A4 risk of a fixed-height container clipping at 140% |
| N2 favourites | 15–18 | Star a real nav row → reload → `favorites` is the **first** nav group → the same entry is listed in settings → `favorite-remove` unpins it from the rail |
| N1 collapse | 19 | A collapsed rail survives a reload (`data-collapsed="true"`, width 78px). This is the BROKEN-to-DONE proof for N1 |
| X2 focus | 20 | A focused `core-nav-link` resolves to a 3px outline |
| A5 motion | 21–22 | With `prefers-reduced-motion: reduce` emulated, `motion=SYSTEM` honours the OS (1e-05s) and `motion=FULL` overrides it (0.3s). Emulating the media feature is the only honest way to test the SYSTEM half |
| Responsive / X6 | 23–29 | 390px and 768px with no overflow; the mobile trigger measures 56×56; opening the drawer moves focus **inside** the panel; 25 Tabs stay inside; Escape closes it and restores focus to the trigger |
| Cross-account isolation | 30–35 | Sign out clears the cached appearance and its owner; a second real account gets defaults (`comfortable/100/system`), a re-attributed owner id, and no `favorites` group; a favourite planted directly into its row for a page it lacks `admin.users.read` for is filtered out of the read without breaking the shell |
| Console hygiene | 36–37 | No `pageerror`/`console.error` and no hydration mismatch — the specific risk of a pre-paint script that writes to `<html>` before React renders |
| State restore | 38 | The admin row is put back to its captured pre-run values, and the planted favourite is deleted, so a validated environment is not left carrying the harness's settings |

Screenshot map: `01` skip link revealed, `02` dark + compact + 140% settings,
`03` dashboard at compact + 140%, `04` the navigation-favourites card, `05`
collapsed rail after reload, `06` mobile drawer open at 390px, `07` mobile
settings, `08` tablet dashboard at 768px, `09` the second account rendering
defaults.

**One real defect the browser caught that jsdom could not.** Check 24 failed on
the first green-everything-else run: the mobile nav trigger measured **28×56**.
`h-10 w-10` is a rem box, so at a 140% text scale it grew to 56px tall, but as a
*shrinkable* flex item beside the page title it was squeezed to 28px wide —
below the 44px WCAG 2.5.8 minimum in exactly the large-text, narrow-viewport
case that needs the target most. Fixed by adding `shrink-0` in `CoreHeader.tsx`
(the adjacent `<h1>` already carries `min-w-0 truncate`, so it is the element
that should absorb the squeeze) and locked in by a new `CoreShell.spec.tsx`
test, since jsdom cannot measure layout.


### 4.7 Verification evidence (harness step)

Re-run after the `shrink-0` fix, from `apps/web`:

| Check | Command | Result |
| --- | --- | --- |
| Web types | `node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | exit 0, no diagnostics |
| Web unit suite | `node ../../node_modules/jest/bin/jest.js --silent` | **40 suites / 674 tests passed** |
| Web production build | `next build` | exit 0, compiled successfully, all routes emitted |
| Browser harness | `node phase49k-validate.mjs` | **38/38 checks passed** |
| API unit suite | `node ../../node_modules/jest/bin/jest.js --silent` (in `apps/api`) | **43 suites / 775 tests passed** |
| API types / build | `tsc --noEmit`, `nest build` | exit 0, no diagnostics |

The two API rows were run earlier in the phase, because this step changed only
`CoreHeader.tsx`, a `CoreShell.spec.tsx` test, the harness and this document — no
API input changed. Both were nevertheless **re-run at closure** and are confirmed
in 14.1 with the same numbers.

The web suite is 674 tests. 4.4 recorded 662 at the dashboard/navigation step;
the 12 tests added since are the appearance-settings, preference-provider and
sidebar-personalization additions from the appearance work, plus one added here:
the mobile-trigger touch-target guard in `CoreShell.spec.tsx`.

The `CoreSurveyDetailView` / `CoreDirectoryView` / `CoreGlobalSearch` /
`BlogCreateForm` timeouts noted in 4.4 reappeared once in an intermediate run and
passed on an isolated re-run of exactly those four suites (4 suites / 56 tests).
Same pre-existing 1 s `findBy*` budget under parallel-worker CPU contention as
recorded there; unchanged by this step and still owned by 49H.

### 4.8 Cross-account isolation model (validated end to end)

The pre-paint script is what makes appearance instant, and it is also the only
place a preference could leak between accounts: it reads `localStorage` before
React, before the session, and before any `/me/preferences` response. Without an
owner check, signing in on a shared machine would show the previous user's dark
COMPACT 140% shell until the new user's read landed — and an account that never
signs in would keep looking at them.

`aria-pref-owner` (`APPEARANCE_OWNER_STORAGE_KEY` in `ThemeProvider.tsx`) is the
answer: the cache is stamped with the opaque user id from the token, never the
e-mail, since a plain `localStorage` entry does not need PII to answer "same
user?". On a mismatch the cache is discarded rather than trusted.

Harness checks 30–35 prove the whole path with two real accounts:
sign-out clears both the appearance and the owner stamp; the second account
renders `comfortable/100/system` with a re-attributed owner and no `favorites`
group; and a `/admin/directory` favourite planted straight into that account's
`navFavorites` never renders, because the server re-filters stored hrefs against
live RBAC on every read (`preferences/nav-catalogue.ts`) and the shell
re-intersects them again on every render (N5). Two layers, and the planted row
is removed by the harness afterwards either way.

### 4.9 N1 — sidebar collapse, BROKEN to DONE

The audit scored N1 BROKEN because collapse was React state in `CoreShell`, so it
reset on every reload — a preference in name only. It now round-trips through
`sidebarCollapsed` on `UserPreference`, and the harness proves it in the browser
rather than in jsdom: collapse the rail, full reload, `data-collapsed="true"` with
a measured width of 78px (check 19). The harness expands it again afterwards, so
a validated environment is not left with a collapsed rail.

### 4.10 The favourites surface (N2), and why there are two of them

A favourite can be created **only** from the rail star and managed from **either**
the rail or `/admin/profile`. That asymmetry is deliberate:

- Adding needs a nav target to point at, which is what the rail already provides.
  A free-text field in settings would be a way to store an arbitrary URL, which
  the server refuses anyway (`NAV_TARGETS` allowlist).
- Removing needs a second home, because until 49K the star was the *only* place
  a favourite could be managed — and one whose row had scrolled out of the rail,
  or that was pinned by mistake, had no exit. `CoreAppearanceSettings` lists them
  with a per-entry remove control for exactly that case.
- The settings list is permission-filtered by the same server read as the rail, so
  a revoked target never reaches either render.

Both surfaces write the same preference, and the harness walks the full loop
across both (checks 15–18): star in the rail → reload → pinned first → listed in
settings → removed from settings → gone from the rail.

### 4.11 Harness reuse notes (for the next phase)

Five constraints were rediscovered the hard way and are recorded so they are not
rediscovered again:

- **Never `waitUntil: 'networkidle0'`/`networkidle2` in this app.** The 49F
  messaging WebSocket keeps a connection open forever, so the page is never idle
  and the wait always times out. Use `domcontentloaded` plus fixed sleeps.
- **Assert rendered effects, not `data-*` attributes.** `data-density="compact"`
  proves the attribute was written, not that anything got denser. Row height,
  root font px and `transitionDuration` are what a user experiences.
- **Pair every reload check with a direct DB read.** The pre-paint `localStorage`
  cache reproduces the same appearance after a reload whether or not the PATCH
  ever reached the server, so the browser alone cannot distinguish "persisted"
  from "cached".
- **Measure one variable at a time.** Density and text scale both resolve through
  the same rem row-height token, so setting COMPACT and 140% together makes the
  row *grow*; the density check has to be taken before the scale changes or it
  passes for the wrong reason.
- **A boolean read through string concatenation is not `t`/`f`.** The pre-run
  snapshot builds one pipe-delimited line with `||`, so `sidebarCollapsed` arrives
  as `true`/`false`, not the `t`/`f` a bare boolean column returns. The restore
  originally compared `=== 't'` and passed only because the captured value happened
  to be `false`; a pre-run collapsed rail would have been silently reset. Now both
  spellings are accepted.

`setInput()` writes through the native `value` setter
(`Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set`) and
then dispatches `input` + `change`, because React's controlled `<select>` ignores
a plain `el.value = x`.

`psql` is invoked as `docker exec -i aria-erp-postgres psql -U aria_user -d
core_db -t -A` with the SQL written to **stdin**, which avoids both a temporary
`.sql` file and the `CHR(124)` quoting contortions an inline `-c` needs under
PowerShell.

## Section 5 — Final scope

### 5.1 Completed

| Area | Delivered |
| --- | --- |
| Preference model | `UserPreference` (one row per user) + migration `20260903130000_add_user_preferences` |
| Preference API | `GET` / `PATCH /me/preferences` (`apps/api/src/preferences/`) |
| Appearance | Theme incl. a real `SYSTEM` state (A1, A2), density (A3), text scale (A4), reduced motion (A5) |
| Frontend layer | `PreferenceProvider` + extended `ThemeProvider` with a pre-paint script and an owner-stamped cache |
| Settings surface | `CoreAppearanceSettings` on `/admin/profile` |
| Dashboard | Widget registry, reorder, hide/show, reset, per-widget error boundary, permission filtering, quick actions (D1–D9) |
| Navigation | Persisted rail collapse (N1), favourites (N2), bounded recents (N3), permission re-filtering on both layers (N5) |
| Accessibility | X1 skip link under RTL, X4 nested-control removal, X6 drawer focus management, plus the 140% touch-target fix |
| Validation | `phase49k-validate.mjs`, 38/38 in real Chrome |

### 5.2 Deferred, with reasons

| Item | Reason |
| --- | --- |
| **D10** aggregated `/dashboard` endpoint | Reversed on evidence, not skipped. The N+1 it targeted was the RBAC read, fixed client-side with one shared `CoreWidgetContext`. See 4.3 |
| **N4** nav group expand/collapse memory | Matrix-scored Low. A new preference column for no new capability |
| **Locale / language preference** | No `locale` column exists, deliberately. Core has no locale provider, no locale routing, and every Core string is hardcoded Persian; `<html lang="fa" dir="rtl">` is static in `layout.tsx`. A stored locale would be a value nothing reads — a column that changes and an interface that does not. Added when real localization is |
| Admin-side view of another user's preferences | No route, no DTO field, no operational need. Adding one would turn a personal settings table into a surface for inspecting individuals |
| Role- or tenant-level default preferences | Not in the approved contract; would require a resolution order (tenant → role → user) that nothing asks for yet |
| Per-widget refresh intervals, dashboard sharing, notification channel preferences | Explicitly absent from the schema. 49E has no channel model to point at |
| Raising the 49H `findBy*` timeout budgets | Pre-existing flake, owned by 49H. Recorded in 4.4 and 14.2, not silently patched here |

### 5.3 Blocked

Nothing in 49K is blocked. The two 49J blockers (semantic retrieval, semantic
relevance) are **outside this phase** and untouched: they need a real embedding
credential and a real corpus. 49J stays YELLOW on its own register, and no 49K
change touches search ranking, the search API, the search projection, embedding
code, the vector schema, or search authorization.

## Section 6 — Dashboard closure (Step 4 preserved)

Step 4 was already GREEN. Nothing was redesigned here; the checks below are
evidence for what already exists.

| Concern | State | Evidence |
| --- | --- | --- |
| Widget registry | PASS | `core-widgets.ts` — `WIDGET_IDS` = `identity`, `access`, `notifications`, `reminders`, `quick-actions`, `modules`. `WIDGET_COMPONENTS: Record<WidgetId, …>` makes a registry id with no component a **compile** error |
| Authorization | PASS | Widgets read one shared `useCorePermissions()` result; `ModulesWidget` and `QuickActionsWidget` intersect with `visibleNavGroups()`. Tests: "does not offer a module the caller cannot open", "offers it once RBAC reports the permission" |
| Reorder | PASS | `CoreDashboardLayoutEditor` up/down; "moves a widget up, on the page and in the request" |
| Move boundary | PASS | "disables the move that does not exist" — the first widget has no up, the last no down |
| Hide / show | PASS | "does not render — or request for — a hidden widget"; the editor lists hidden widgets too, so hiding is reversible |
| Reset | PASS | "resets with `resetDashboardLayout`, never a layout body" — only SQL `NULL` is the server's "never customised" state |
| Persistence | PASS | `dashboardLayout` JSONB; `resolveLayout()` keeps stored order, drops unknown ids, appends unmentioned widgets as visible |
| Unauthenticated | PASS | "stays usable but honest with no session to persist to" and "renders the default layout, read-only". `GET` creates no row |
| Failure isolation | PASS | "keeps the neighbouring widgets alive when one request fails" and "isolates a widget that throws while rendering" (`CoreWidgetBoundary`) |
| All-hidden state | PASS | "offers a way back when every widget is hidden" — names the editor instead of rendering blank |
| One RBAC read | PASS | "reads RBAC once for the whole page" asserts the count is exactly 1 |
| Quick actions | PASS | Built from favourites when present, else reachable navigation; "drops a favourite that is no longer a reachable target" |
| Responsive | PASS | Harness checks 13–14, 23, 29: no horizontal overflow at 1440 (COMPACT + 140%, 6 widgets), 768 or 390 |

No metric on the dashboard is computed by 49K. Notifications come from the 49E
contract and reminders from the 49I contract, both read-only. There is no
fabricated count anywhere on the page.

## Section 7 — Personalization closure

| Capability | State | Evidence |
| --- | --- | --- |
| Theme (light / dark / **system**) | IMPLEMENTED | `ThemePreference` enum; `SYSTEM` is a stored value, not the absence of one, which is the whole A2 fix. Harness checks 6, 10–11: DARK survives a reload and the DB row reads `DARK`. `ThemeToggle.spec.tsx` (5 tests) |
| Density (comfortable / compact) | IMPLEMENTED | `UIDensity` enum + `data-density` tokens. Measured, not asserted by attribute: nav row 44px → 36px (check 7) |
| Text scale (100 / 110 / 125 / 140) | IMPLEMENTED | `html { font-size: calc(100% * var(--text-scale)) }` — multiplies the user's own browser base rather than overriding it. Root font 16px → 22.4px at 140% (check 8) |
| Reduced motion (system / reduced / full) | IMPLEMENTED | `MotionPreference`. Rail transition 0.3s → 1e-05s under REDUCED (check 9); with `prefers-reduced-motion: reduce` emulated, `SYSTEM` honours the OS and `FULL` overrides it (checks 21–22) |
| Favourites | IMPLEMENTED | `navFavorites String[]`, capped at 12 in the DTO **and** by the `UserPreference_navFavorites_bounded` CHECK. Rail star + settings list; harness checks 15–18 |
| Recent items | IMPLEMENTED | `navRecent String[]`, capped at 10 server-side and rendered at `RECENT_RAIL_LIMIT = 5`. Excludes the current path, anything favourited, and the audit-surface prefixes in `RECENT_EXCLUDED_PREFIXES` |
| Sidebar collapse | IMPLEMENTED | `sidebarCollapsed Boolean`. Was BROKEN (React state, reset on reload); now round-trips. Check 19: `data-collapsed="true"`, measured 78px after a full reload |
| Dashboard layout | IMPLEMENTED | `dashboardLayout Json?`; see Section 6 |
| Locale / language | **DEFERRED** | No column, by decision. See 5.2 — there is no locale provider, no locale routing, and `<html lang="fa" dir="rtl">` is static. Nothing here claims language support |

Every setting is optimistically applied and then PATCHed, and a failed write is
rolled back on both the state and the document: `PreferenceProvider.spec.tsx`
"rolls the value and the document back when the write fails", plus "rolls a
failed collapse back without an error banner" — a rail that snaps back does not
need a banner, a lost theme does.

Unauthenticated users get defaults, may change them locally, and nothing is
sent: "serves defaults without reading or writing", "still applies a change
locally but sends nothing".

### 7.1 Density and text scale do not cancel each other out

Worth stating because the first version of the harness got this wrong. Row
height is a **rem** token, so at 140% text a COMPACT row is taller in absolute
pixels than a COMFORTABLE row at 100%. That is correct behaviour — density is a
ratio, not a fixed pixel budget — but it means a density check taken *after* a
scale change measures the wrong thing.

Verified separately: COMPACT is genuinely more compact at a fixed scale (44px →
36px, check 7); text stays readable at 140% because the scale multiplies rather
than clamps; and at COMPACT + 140% together there is still no horizontal
overflow on either the settings page or the 6-widget dashboard (checks 13–14).

## Section 8 — Accessibility closure

Validated against **the project-defined accessibility target**, not a claim of
full WCAG conformance. What the harness proves is that its own matrix passed.

| Concern | State | Evidence |
| --- | --- | --- |
| Keyboard | PASS | First Tab reveals the skip link (check 3); 25 consecutive Tabs stay inside the open drawer (check 26); Enter/Space toggle the rail and the favourite star (`CoreShell.spec.tsx`, `CoreSidebarPersonalization.spec.tsx`) |
| Focus visibility | PASS | A focused `core-nav-link` resolves to a measured 3px outline (check 20) |
| Focus management | PASS | X6: opening the drawer moves focus **inside** the panel, Escape closes it and restores focus to the trigger (checks 25, 27) |
| Screen-reader semantics | PASS (structural) | X4: the nav row is a `<div>` holding a `<Link>` plus **sibling** `<button>`s, so no interactive control is nested in an anchor — "exposes the star as a real button beside the link, not inside it". `aria-pressed` on the star, `aria-disabled` at the cap, `role="status"` + `aria-live` in `CoreStates`. No assistive-technology run was performed; this is asserted structurally |
| Contrast | NOT RE-MEASURED | Token pairs for both themes pre-date 49K (audit X-row: no issue). The skip link moved from `bg-white` to themed tokens, removing an invisible-in-dark-mode case. No contrast-ratio measurement was taken in this phase, and none is claimed |
| Touch target | PASS | The one real defect this phase found and fixed. See 8.1 |
| RTL | PASS | `dir="rtl"` confirmed in the browser (check 2), and the skip link lands on the **leading** (right) side: `right=1424` of a 1440 viewport (check 4) |
| Text scale | PASS | Reachable in-product, four steps, measured (check 8), no layout break at 140% (checks 13–14) |
| Reduced motion | PASS | Three real states where the OS switch was previously ignored by every Core component (checks 9, 21–22) |

### 8.1 The touch-target defect (found in the browser, invisible to jsdom)

Check 24 failed on the first otherwise-green run.

- **Before:** the mobile nav trigger measured **28 × 56** at a 390px viewport
  with a 140% text scale.
- **Root cause:** `h-10 w-10` is a rem box, so it grew to 56px tall — but as a
  *shrinkable* flex item beside the page title it was squeezed to 28px wide.
  Below the 44px objective in exactly the large-text, narrow-viewport case that
  needs the target most.
- **Fix:** `shrink-0` on the trigger in `CoreHeader.tsx`. The adjacent `<h1>`
  already carries `min-w-0 truncate`, so it is the element that should absorb the
  squeeze.
- **Re-verified in the browser:** check 24 now reports **56 × 56**.
- **Guard:** `CoreShell.spec.tsx` — "never lets the mobile nav trigger be
  squeezed below its touch target". It asserts the class contract rather than
  geometry, because jsdom computes no layout; the geometry assertion lives in the
  harness, which is why the harness existed.

This is a 44px-objective fix, verified at one viewport and one scale. It is not
evidence of full WCAG 2.5.8 conformance across the product.



## Section 9 — Responsive validation

Three viewports, driven in real Chrome, with the appearance settings deliberately
left at their hardest combination (COMPACT + 140% text) for the wide checks.

| Viewport | Surfaces exercised | Result |
| --- | --- | --- |
| Desktop 1440 | Settings (`/admin/profile`), dashboard with 6 widgets, expanded rail, collapsed rail, skip link | No horizontal overflow (0px) on either page at COMPACT + 140% (checks 13–14). Collapsed rail measures 78px and survives a reload (check 19). Screenshots `01`–`05` |
| Tablet 768 | Dashboard | No horizontal overflow (check 29). Screenshot `08` |
| Mobile 390 | Header, drawer, settings | No horizontal overflow on the dashboard (check 23) and on settings (check 28); trigger 56×56 (check 24); drawer focus in/Tab-confined/Escape-restore (checks 25–27). Screenshots `06`–`07` |

- **No relevant overflow** at any of the three widths, measured as
  `scrollWidth − clientWidth` on `documentElement`, not judged by eye.
- **Controls remain usable:** the one case where they did not — the squeezed
  mobile trigger — is 8.1, and it was fixed rather than documented as acceptable.
- **Text scaling does not destroy layout:** the 140% checks are run at the
  *narrowest* and the *widest* viewport, which are the two failure modes (clipping
  and reflow).
- **Critical drawer:** the mobile drawer is the only modal-like layer in the Core
  shell, and all four of its behaviours (focus in, trap, Escape, restore) are
  asserted in the browser as well as in jsdom.

The `lg:` seam at exactly 1024px (rail vs. drawer) is unchanged from the audit.
1024 itself was not re-measured this phase; 390 / 768 / 1440 were.


## Section 10 — Security and isolation

| Concern | State | Evidence |
| --- | --- | --- |
| User isolation (transport) | PASS | `@Controller('me/preferences')` with `JwtAuthGuard`. The subject is always `req.user.sub`. There is **no** `/users/:id/preferences`, no `userId` path param, no `userId` query param |
| Authority injection (body) | PASS | `UpdatePreferenceDto` carries no `userId`, no `tenantId`, no `id`, no timestamps. The global pipe runs `whitelist` + `forbidNonWhitelisted`, so an injected `userId` is **rejected**, not silently dropped — a typo'd field that vanished under a success response would look exactly like a broken toggle |
| Cross-user leakage (server) | PASS | Single-row lookup keyed on the authenticated subject; `UserPreference_userId_key` makes a second row per user impossible |
| Cross-account leakage (client cache) | PASS | `aria-pref-owner` — see 4.8 and 10.1 |
| Permission filtering | PASS | Stored hrefs are re-filtered against **live** RBAC on every read (`isNavTargetAllowed` in `nav-catalogue.ts`) and re-intersected against the locally visible navigation on every render (N5). Two layers |
| Favourite ≠ authorization | PASS | 10.2 |
| No new permission | PASS | 49K introduces no permission and no grant. Setting your own theme is an ordinary authenticated-user capability, and two of these settings are *accessibility* settings — gating them behind a permission would make the product unusable for whoever lacked it |
| No admin read of others' preferences | PASS | No such route exists. Deliberate; see 5.2 |
| Route shadowing | N/A | Neither path is parameterised, so the hazard documented on `UsersController` / `NotificationController` cannot arise |

### 10.1 The `aria-pref-owner` model, proven end to end

The pre-paint script is the only place a preference could leak between accounts:
it reads `localStorage` before React, before the session, and before any
`/me/preferences` response. Without an owner check, signing in on a shared
machine would show the previous user's dark/COMPACT/140% shell until the new
user's read landed.

The cache is stamped with the **opaque user id** from the token, never the
e-mail — a `localStorage` entry does not need PII to answer "same user?". On a
mismatch the cache is discarded rather than trusted.

Proven at both layers:

- **jsdom** (`PreferenceProvider.spec.tsx`): "discards a cached appearance that
  belongs to another account", "keeps a cached appearance that belongs to the
  arriving account", "wipes the cache and repaints defaults on sign-out", "leaves
  an appearance nobody owns alone".
- **Browser** (checks 30–35, two real accounts): sign-out clears both the
  appearance and the owner stamp; the second account renders
  `comfortable/100/system` with a re-attributed owner id and **no** `favorites`
  group. Screenshot `09`.

Verified as different between User A and User B: theme, density, text scale,
favourites, and navigation state. Dashboard layout is stored in the same row,
keyed by the same unique `userId`, and read through the same single-row lookup,
so it is isolated by construction — the harness did not measure a second
account's dashboard layout separately, and no isolation claim beyond the shared
row key is made for it.

### 10.2 A favourite is not authorization

- A favourite stores an **href**, and an href grants nothing.
- Writes are constrained to the `NAV_TARGETS` allowlist, so an arbitrary URL
  cannot be stored in the first place.
- A revoked permission removes the entry from the effective navigation on the
  next read — no error, no migration, no cleanup job. Tests: "drops a favourite
  the caller may no longer open", "drops a recent entry the caller may no longer
  open", "drops a favourite that is no longer a reachable target" (quick actions).
- Harness check 35 is the adversarial version: a `/admin/directory` favourite
  planted **directly into the database** for an account without
  `admin.users.read` never renders, and does not break the shell.
- The stale row is left in place on purpose. RBAC is the authority; the row is
  inert data.

**Test-data hygiene:** the planted forbidden favourite is created by the harness
and removed by the harness — the restore block clears `navFavorites` for the
second account whether the run passed or failed, and the admin row is written
back to its captured pre-run values. It exists only for the duration of a run.

### 10.3 Two-surface favourite decision (recorded, unchanged)

One authoritative **add** path (the rail star, which is the only surface that has
a nav target to point at) and two **manage** surfaces (the rail and
`/admin/profile`). Full reasoning in 4.10. Not modified by this closure pass.
## Section 11 — Productivity UX closure

| Capability | State | Evidence |
| --- | --- | --- |
| Favourites | GREEN | 12-entry cap enforced in the DTO and in SQL; rail star with `aria-pressed`; visible refusal at the cap ("refuses visibly at the cap instead of doing nothing") rather than a dead control; removal from either surface; harness checks 15–18 |
| Recent items | GREEN | 10 stored / 5 rendered; excludes the current page and anything pinned; recording gated by `isNavTarget()` so `/admin/blog/42` produces no write the server would discard; audit surfaces excluded by prefix |
| Quick actions | GREEN | Derived from **authorized** favourites, falling back to reachable navigation; permission-intersected per pill |
| Loading states | GREEN | `CoreStates.CoreLoading` — `role="status"` + `aria-live="polite"` + `aria-busy`, skeleton lines, never placeholder rows. Used by every fetching widget |
| Empty states | GREEN | `CoreEmpty` with a real message per surface ("اعلان جدیدی ندارید.", "یادآوری پیش رو ندارید.", "دسترسی سریعی برای نمایش وجود ندارد.", "ماژول فعالی برای این حساب وجود ندارد.", `favorites-empty`) |
| Error states | GREEN | `CoreError` per widget plus `CoreWidgetBoundary` for a render-time throw; a failed preference read keeps the pre-paint appearance instead of flashing defaults ("keeps the pre-paint appearance when the read fails") |
| Disabled states | GREEN | `aria-disabled` on the star at the cap; the editor's up/down control that does not exist is disabled, not hidden ("disables the move that does not exist"); no star at all on the collapsed rail, where there is no room for a second control |

Nothing in this section is marked GREEN on intent. Each row names either a test
title or a harness check.

## Section 12 — API and storage closure

### 12.1 Endpoints

| Method | Route | Guard | Behaviour |
| --- | --- | --- | --- |
| `GET` | `/me/preferences` | `JwtAuthGuard` | Returns the caller's effective preferences, already filtered by live RBAC. **Creates no row** — every authenticated page load hits this route, so a write here would turn first render into a write for every user and destroy the only signal distinguishing "chose the defaults" from "never chose". Asserted directly by a spec |
| `PATCH` | `/me/preferences` | `JwtAuthGuard` | Partial update; an omitted field is left untouched. Returns the **full**, re-filtered object so the client never merges a partial response into its own state |

`PATCH` rather than `PUT` because there is no complete representation the client
is expected to send back — a PUT would let a client that knows about four
settings silently reset the fifth. One route rather than one per section because
the write is a single-row upsert either way.

No dashboard-specific persistence API exists: `dashboardLayout` is a field on the
same route, which is why a reorder is one request and not two.

### 12.2 Ownership model

Owner = the authenticated subject, resolved from the verified JWT. There is no
path parameter, no query parameter and no body field that could name a different
user. `UserPreference.userId` is `@unique` with a foreign key to `User`, so a row
belongs to exactly one account and disappears with it.

### 12.3 Validation, two layers

| Field | DTO | SQL |
| --- | --- | --- |
| `theme` / `density` / `motion` | `@IsIn(Object.values(<PrismaEnum>))` — derived from the schema, so adding an enum member cannot leave the DTO behind | Postgres enum types `ThemePreference`, `UIDensity`, `MotionPreference` |
| `textScale` | `@IsIn(TEXT_SCALE_STEPS)` — an enumerated set, not a range: `@Min(100)/@Max(140)` would admit 137%, which no control produces and no token set renders. Out-of-step values are **refused**, not rounded | `UserPreference_textScale_allowed` CHECK |
| `navFavorites` | `@ArrayMaxSize(12)`, `@MaxLength(200)` per href | `UserPreference_navFavorites_bounded` CHECK |
| `navRecent` | `@ArrayMaxSize(10)` | `UserPreference_navRecent_bounded` CHECK |
| `dashboardLayout` | `@ValidateNested` over `DashboardLayoutEntryDto` (`id` + **required** `visible`), max 40 entries, unknown widget ids refused by the service | `UserPreference_dashboardLayout_is_array` CHECK |
| Unknown properties | Rejected by the global `whitelist` + `forbidNonWhitelisted` pipe | — |

`visible` is required rather than defaulted, because an entry that omitted it
would leave "is this widget hidden" undecided, and defaulting it silently would
make a hide-then-reorder round trip quietly unhide the widget.

### 12.4 Defaults

Defaults are **code-level**, returned when no row exists, and no row is created
to hold them: `LIGHT` / `COMFORTABLE` / `100` / `SYSTEM` / not collapsed / empty
lists / full registry visible, with `customized: false` as the signal that
nothing was ever chosen. Column defaults in the migration mirror the same values
for rows created by a `PATCH`.

Three distinct stored states for the layout, three distinct outcomes: `NULL` →
registry default; a JSON array → stored order, unknown ids dropped, unmentioned
widgets appended as visible (so a new widget appears for established users rather
than being invisible to exactly the people most likely to want it); anything else
→ treated as `NULL`.

## Section 13 — Database closure

### 13.1 Migration status

Read from `_prisma_migrations` in `aria-erp-postgres` / `core_db`:

- **16 migrations total, 0 unfinished, 0 rolled back.**
- Latest applied: `20260903130000_add_user_preferences` — 2026-09-03 19:49, 1
  step, no logs.
- The 49J migration immediately before it (`20260903120000_add_global_search_projection`)
  is untouched, as is the 49I one (`20260831120000_add_calendar_reminders`).

### 13.2 The one migration 49K introduces

`apps/api/prisma/core/migrations/20260903130000_add_user_preferences/migration.sql`
— the **only** migration in this phase. Complete inventory of its DDL:

| Statement | Object |
| --- | --- |
| `CREATE TYPE` | `ThemePreference` (`SYSTEM`, `LIGHT`, `DARK`) |
| `CREATE TYPE` | `UIDensity` (`COMFORTABLE`, `COMPACT`) |
| `CREATE TYPE` | `MotionPreference` (`SYSTEM`, `REDUCED`, `FULL`) |
| `CREATE TABLE` | `UserPreference` |
| `CREATE UNIQUE INDEX` | `UserPreference_userId_key` |
| `ALTER TABLE … ADD CONSTRAINT` | `UserPreference_userId_fkey` → `User` |
| `ALTER TABLE … ADD CONSTRAINT` | `UserPreference_textScale_allowed` |
| `ALTER TABLE … ADD CONSTRAINT` | `UserPreference_navFavorites_bounded` |
| `ALTER TABLE … ADD CONSTRAINT` | `UserPreference_navRecent_bounded` |
| `ALTER TABLE … ADD CONSTRAINT` | `UserPreference_dashboardLayout_is_array` |

### 13.3 Non-destructive by inspection

**No `DROP`, no `DELETE`, no `UPDATE`, no `INSERT`, no `ALTER COLUMN`, and no
change to any pre-existing table** — verified by grepping the migration for
leading DDL/DML keywords: every statement is one of the ten above. 49K is
additive only: three new enum types and one new table.

- No 49I object is touched (no `Reminder`, no `CalendarEvent`).
- No 49J object is touched (no `SearchDocument`, no vector column, no index on
  either).
- `User` is referenced only as the **target** of a new foreign key, which adds a
  constraint to the new table and alters nothing on `User` itself.
- No index is added to `UserPreference.userId` beyond the unique constraint, which
  already backs it.
- No new permission row and no grant — 49K adds no RBAC data, so there is nothing
  to seed and nothing to roll back.

`schema.prisma` grew by 182 lines: three enums, one model, and comments. The
`Prisma` client was regenerated (`apps/api/src/generated/core-client`), which is a
build artefact rather than a schema change.

## Section 14 — Regression

### 14.1 Evidence

Full API and web suites were re-run at closure, after the `shrink-0` fix, using a
`.cmd` wrapper redirecting to a file so no output was lost to console truncation.

| Suite | Result |
| --- | --- |
| `apps/api` Jest (full) | **43 suites / 775 tests passed**, EXIT=0 |
| `apps/api` `tsc --noEmit` | EXIT=0, no diagnostics |
| `apps/api` `nest build` | EXIT=0 |
| `apps/web` Jest (full) | **40 suites / 674 tests passed**, EXIT=0 |
| `apps/web` `next build` | EXIT=0, "Compiled successfully", TypeScript check passed, 33 static pages generated, all routes emitted |
| `apps/web` `phase49k-validate.mjs` | **38/38 checks passed**, EXIT=0 |

The harness was re-run one final time at closure, *after* the restore-parse fix in
14.3, from a clean `DARK|COMFORTABLE|100|SYSTEM|false` admin row: 38 PASS, 0 FAIL,
and a direct `psql` read after the process exited confirms the row was put back to
exactly those values.

**49I surfaces, all green in the runs above** — API: `calendar/reminder.service`,
`calendar/reminder-dispatcher.service`, `calendar/jalali.util`,
`notifications/notification.service`, `messaging/messaging.gateway`,
`messaging/connection-registry`, `support/support.service`,
`support/ticket-status.util`, `support/tracking-number.util`,
`surveys/surveys.service`, `users/directory.service`, `users/users.controller`.
Web: `CoreCalendarView`, `CoreNotificationsView`, `CoreNotificationBell`,
`CoreMessagesView`, `CoreSupportView`, `CoreSurveysView`, `CoreSurveyDetailView`,
`CoreSurveyEditorView`, `CoreDirectoryView`, `CoreDirectoryMemberView`,
`CoreProfileView`, and the matching `*-api` client specs.

**49J surfaces, all green** — API: `search/search-ranking`,
`search/search-snippet`, `search/persian-normalize`. Web: `CoreGlobalSearch`,
`search-api`. **Search semantics unchanged:** no file under `apps/api/src/search`,
no search projection, no embedding code and no vector schema appears in
`git diff --name-only`. The only 49K edit that even touches a search-adjacent file
is the shared Core shell, and search UI was not modified.

**Step 4 (dashboard):** `CoreDashboard.spec.tsx` 18 tests, plus the harness
checks in Section 6. Nothing was redesigned; no check was re-run beyond what
closure evidence required.

### 14.2 Not re-run at closure, and why

- **`apps/api` e2e (10 spec files).** No API source file changed after the last
  API run other than the closure document, and the e2e path depends on the
  `aria-erp-e2e-dbproxy` container publishing 5544. Last full evidence is the 49J
  closure (`search.e2e-spec.ts` 41/41, the other nine specs 275/275).
- **`phase49i-validate.mjs`.** 49I's own harness; 49I logic is untouched and its
  web/API suites pass here.
- **1024px viewport.** The `lg:` seam is unchanged from the audit; 390 / 768 /
  1440 were measured.

### 14.3 One harness defect fixed during closure

Not a product defect, but it would have corrupted future evidence, so it is
recorded rather than quietly patched.

The state-restore block parsed the pre-run snapshot's `sidebarCollapsed` as
`collapsed === 't'`. The snapshot is built by concatenating columns with `||`, so
psql renders the boolean as `true`/`false`, never `t`/`f` — meaning the comparison
was always false. Check 38 passed anyway because the captured value happened to be
`false`, but an environment whose rail was collapsed before a run would have been
silently left expanded afterwards.

Now `const wasCollapsed = collapsed === 't' || collapsed === 'true';`, used in the
restore `UPDATE`. `node --check` clean, and the full harness re-run after the fix is
the 38/38 recorded in 14.1. Also added to the reuse notes in 4.11.

## Section 15 — Pre-existing defects (not 49K, not fixed here)

Recorded so no future reader mistakes them for 49K regressions, and so no
repo-wide cleanliness claim is made.

| Defect | Status | Detail |
| --- | --- | --- |
| `apps/web` ESLint cannot run at all | Pre-existing, reconfirmed this phase | `TypeError: Converting circular structure to JSON` from `eslint-config-next` under ESLint 8.57.1, thrown while normalising `apps/web/.eslintrc.js` — before any file is parsed, so it is a config-loading failure and not a lint finding. Already recorded in the 49J closure. **No repo-wide lint-green claim is made anywhere in this document.** |
| `next lint` broken in this Next 16 setup | Pre-existing | Parses `lint` as a directory argument |
| `@typescript-eslint/no-explicit-any` on `(req as any).user?.sub` | Pre-existing, codebase-wide | The same accessor appears in the support, notifications, calendar and search controllers (13 occurrences in that scope alone). `preference.controller.ts` follows the established pattern rather than inventing a second one; changing it is a cross-cutting refactor |
| `CoreSurveyDetailView.spec.tsx` intermittent failure | Pre-existing (49H) | Every assertion runs through `findBy*` / `waitFor` on the default 1 s budget, which lapses under parallel-worker CPU contention. Passes in isolation, repeatedly. Also seen once each on `CoreDirectoryView`, `CoreGlobalSearch` and `BlogCreateForm` in an intermediate run. **Green in the closure run recorded in 14.1** |
| `React state update was not wrapped in act(...)` warning from `CoreNotificationsView` | Pre-existing (49E/49I) | Warning only, suite passes. Not introduced here |
| npm `Unknown project config "shamefully-hoist" / "strict-peer-dependencies"` warnings | Pre-existing | Emitted by every npm invocation in the repo. Cosmetic |

None of these affects a 49K requirement, so per the status rule none is a 49K
blocker. Two of them (`no-explicit-any`, the ESLint config failure) mean 49K
**cannot** produce lint evidence for its own new files, and that is stated rather
than worked around.
## Section 16 — Git and artifact state

Captured with `git status --short`, `git diff --stat`, `git diff --name-only`.

### 16.1 Modified tracked files (25)

49K work: `apps/api/prisma/core/schema.prisma`, `apps/api/src/core-app.module.ts`,
`apps/web/src/app/layout.tsx`, `apps/web/tailwind.config.ts`,
`apps/web/src/styles/globals.css`, `apps/web/src/components/providers/ThemeProvider.tsx`,
`apps/web/src/components/core/{CoreShell,CoreSidebar,CoreHeader,CoreDashboard,ThemeToggle,core-nav}.*`,
`apps/web/src/components/core/__tests__/{CoreShell,CoreSidebar,core-nav}.spec.*`,
`apps/web/src/app/admin/profile/page.tsx`, and the density/token sweep across
`Core{Calendar,Directory,DirectoryMember,Notifications,Profile,Support,TicketCreate,TicketDetail}View.tsx`.
Plus `apps/web/phase48c-validate.mjs`, where a **pre-existing harness defect** was
fixed: checks 13/14 counted `visibleRails`, which cannot see the mobile drawer at
all because the drawer nav carries a different test id.

Total: **1552 insertions, 196 deletions across 25 files.**

One modified line is **not** 49K: the favicon `link` in `layout.tsx` changed from
`/favicon.ico` to `/icon.svg` in an earlier session. Untouched here, still
uncommitted, and already recorded in the working-tree note at the top of this
document.

### 16.2 New files (49K)

- `apps/api/prisma/core/migrations/20260903130000_add_user_preferences/`
- `apps/api/src/preferences/` — `preference.controller.ts`, `preference.service.ts`,
  `preference.service.spec.ts`, `preference.module.ts`, `nav-catalogue.ts`,
  `widget-catalogue.ts`, `dto/preference.dto.ts`
- `apps/web/src/components/core/` — `CoreAppearanceSettings.tsx`,
  `CoreDashboardLayoutEditor.tsx`, `CoreDashboardWidgets.tsx`, `CoreWidgetCard.tsx`,
  `core-widgets.ts`
- `apps/web/src/components/providers/PreferenceProvider.tsx`
- `apps/web/src/lib/preferences-api.ts`
- Specs: `CoreAppearanceSettings.spec.tsx`, `CoreDashboard.spec.tsx`,
  `CoreSidebarPersonalization.spec.tsx`, `ThemeToggle.spec.tsx`,
  `providers/__tests__/PreferenceProvider.spec.tsx`,
  `lib/__tests__/preferences-api.spec.ts`
- `apps/web/phase49k-validate.mjs`, `apps/web/phase49k-shots/` (9 screenshots)
- `docs/reports/PHASE_49K_CLOSURE.md`

### 16.3 Temporary files

All `k49k-*` verification artefacts created during this closure pass — the `.cmd`
wrappers and their `.out` captures — were **read first, then deleted**. Nothing
matching `k49k-*` remains.

The `k-jest*.out` / `k-tsc-web.out` / `k-gitstatus.out` / `j-final.out` captures
from earlier segments and earlier phases predate this pass and are left alone
rather than deleted to force a clean tree.

### 16.4 Secrets

No secret is introduced, read into this document, or committed by 49K. Two
pre-existing untracked credential-shaped files, `apps/api/.tok` and
`apps/api/.rid`, predate this phase, are recorded in the 49J closure, and were not
opened, modified or staged here. **Nothing has been committed at all** — no
`git commit` was run in this phase, and none was requested.

### 16.5 Unrelated dirty artefacts (left in place)

`ERP_Structure_v12.xml`, `api-mounts.json`, `apps/api/tmp-jest.txt`,
`apps/api/testing_module_dump.json`, `apps/api/scripts/search-verify*.sql`,
`apps/web/srv-out.txt`, `apps/web/srv-err.txt`, `apps/web/next-env.d.ts`,
`apps/web/tsconfig.tsbuildinfo`, `apps/web/qa-output/`, `apps/web/probe-drawer.mjs`,
`apps/web/phase48c-shots/`, `apps/web/phase48c1-shots/`, `apps/web/phase49e-shots/`,
`apps/web/phase49h-shots/`, `apps/web/phase49i-shots/`,
`apps/web/phase49i-validate.mjs`,
`apps/web/public/{icon.svg,icon-192.png,icon-512.png,apple-touch-icon.png,manifest.json}`,
`backups/`, `lovable/`, `tools/`, `probe.ps1`, `firefox-*.png`, `ws-install2.txt`,
`ws-install3.txt`.

None is modified by 49K. Note that **no `.gitignore` entry covers any of these** —
`git check-ignore` matches nothing — so they are genuinely untracked rather than
ignored. Whoever commits this phase should stage explicitly by path.

## Section 17 — Environment notes

- Web `:3000`, API `:3001`, both confirmed listening during the harness run.
- `aria-erp-postgres` up and healthy; `core_db`, user `aria_user`, published on
  5433.
- `psql` is driven as `docker exec -i aria-erp-postgres psql -U aria_user -d
  core_db -t -A` with SQL on **stdin**, which avoids both a temp `.sql` file and
  the `CHR(124)` quoting contortions an inline `-c` needs under PowerShell.
- The e2e path additionally needs `aria-erp-e2e-dbproxy` (alpine/socat) publishing
  5544 → `postgres:5432`; both `.env.e2e` and `.env.local` target 5544, so that
  container is load-bearing for e2e and for `prisma migrate status`. Not required
  by anything in this closure pass.
- Harness environment: admin `super-admin-user`. At the start of the closure re-run
  its row read `DARK|COMFORTABLE|100|SYSTEM|false` with no favourites, and it was
  restored to exactly that afterwards (check 38, verified by a direct `psql` read
  after the process exited). An earlier run in the phase started from
  `LIGHT|COMFORTABLE|100|SYSTEM|false`; the theme difference is a real user choice
  made between runs, not harness residue.
- **Console output under PowerShell truncates unpredictably.** The reliable pattern
  used throughout: a small `.cmd` wrapper doing `> file 2>&1` plus
  `echo EXIT=%ERRORLEVEL%`, then read the file back before deleting it.


## Section 18 — Blocker register

| # | Item | Owner phase | State |
| --- | --- | --- | --- |
| — | *(none)* | 49K | **No open 49K blocker.** Every requirement in scope has test, browser, source or database evidence recorded above |
| 49J-1 | Semantic retrieval | 49J | YELLOW BLOCKED — needs a real embedding credential. Untouched by 49K |
| 49J-2 | Semantic relevance | 49J | YELLOW BLOCKED — needs a real corpus. Untouched by 49K |
| 49H-1 | `findBy*` 1 s budgets under worker contention | 49H | Open, pre-existing. Not a 49K blocker (Section 15) |
| Repo-1 | `apps/web` ESLint config cannot load | repo | Open, pre-existing. Not a 49K blocker (Section 15) |

49K does not attempt to close either 49J blocker, and no 49K change touches search
ranking, the search API, the search projection, embedding code, the vector schema
or search authorization — verified against `git diff --name-only` (Section 14.1).

## Section 19 — Final report

**PHASE: 49K**
**STATUS: GREEN**

### 1. Final scope

- **Completed:** preference model + migration, `GET`/`PATCH /me/preferences`,
  theme (with a real `SYSTEM` state), density, text scale, reduced motion,
  favourites, recents, persisted sidebar collapse, widget-registry dashboard with
  reorder/hide/reset/boundary, permission-filtered quick actions and modules, X1 /
  X4 / X6 accessibility fixes, the 140% touch-target fix, and a 38-check browser
  harness.
- **Deferred:** D10 aggregated endpoint (reversed on evidence), N4 nav-group
  memory, locale/language, admin view of others' preferences, role/tenant default
  preferences, per-widget refresh intervals, dashboard sharing, notification
  channel preferences. Reasons in 5.2.
- **Blocked:** nothing in 49K.

### 2. Dashboard

- **Widget architecture:** `core-widgets.ts` registry of 6 widgets; `Record<WidgetId, Component>` makes catalogue/renderer drift a compile error.
- **Personalization:** reorder, hide/show, reset; stored order honoured, unknown ids dropped, new widgets appended visible.
- **Permissions:** one shared RBAC read (asserted to be exactly one), every module and quick action intersected with `visibleNavGroups()`.
- **Persistence:** `dashboardLayout` JSONB on the same preference row; reset writes SQL `NULL` via `resetDashboardLayout`.
- **Responsive:** no overflow at 1440 (COMPACT + 140%), 768 or 390.
- **Quick actions:** derived from authorized favourites, falling back to reachable navigation.

### 3. Personalization

- **Theme:** IMPLEMENTED (light / dark / system, measured + DB-verified).
- **Density:** IMPLEMENTED (44px → 36px, measured before scaling).
- **Text scale:** IMPLEMENTED (100/110/125/140; 16px → 22.4px at 140%).
- **Reduced motion:** IMPLEMENTED (0.3s → 1e-05s; SYSTEM and FULL both verified under emulated OS reduce).
- **Favourites:** IMPLEMENTED (cap 12, DTO + SQL, two manage surfaces, one add path).
- **Recents:** IMPLEMENTED (10 stored / 5 rendered, audit surfaces excluded).
- **Sidebar:** IMPLEMENTED (BROKEN → DONE; 78px collapsed rail survives reload).
- **Locale:** DEFERRED — no column, no locale provider, no locale routing. No language support is claimed.

### 4. Accessibility

- **Keyboard:** PASS (skip link on first Tab; 25 Tabs confined to the drawer; Enter/Space on rail and star).
- **Focus:** PASS (3px measured outline; focus into the drawer, trapped, restored on Escape).
- **Screen reader:** PASS structurally (no interactive control nested in an anchor; `aria-pressed`/`aria-disabled`/`aria-live`). No assistive-technology run performed.
- **Contrast:** NOT RE-MEASURED this phase; pre-existing token pairs, no issue in the audit, and one invisible-in-dark-mode case removed.
- **Touch:** PASS (28×56 → 56×56 at 390px + 140%).
- **RTL:** PASS (`dir="rtl"`; skip link on the leading side, `right=1424` of 1440).
- **Text scale:** PASS (no layout break at 140%).
- **Reduced motion:** PASS.
- **Mobile trigger:** PASS (fixed with `shrink-0`, re-verified in the browser, guarded by a jsdom class-contract test).
- **Browser evidence:** `phase49k-validate.mjs`, 38/38, screenshots `01`–`09`.

Validated against the project-defined accessibility target. Not a claim of full
WCAG conformance.

### 5. Responsive

- **Desktop 1440:** PASS. **Tablet 768:** PASS. **Mobile 390:** PASS.
- **Overflow:** 0px at all three, measured as `scrollWidth − clientWidth`.

### 6. Security

- **User isolation:** PASS (subject always from the verified JWT; no `userId` in any path, query or body).
- **Permission filtering:** PASS (server filters on read, client re-intersects on render).
- **Favourites:** PASS (href only; `NAV_TARGETS` allowlist; revoked target disappears; DB-planted forbidden favourite never renders).
- **Authority injection:** PASS (`whitelist` + `forbidNonWhitelisted` rejects an injected `userId`/`tenantId`).
- **Cross-account isolation:** PASS (`aria-pref-owner`; two real accounts in the browser, four jsdom cases).

### 7. API / storage

- **Endpoints:** `GET /me/preferences`, `PATCH /me/preferences`. No dashboard-specific route.
- **Model:** `UserPreference`, one row per user, `userId @unique` + FK to `User`.
- **Defaults:** code-level, returned without creating a row; `customized: false` distinguishes "chose the defaults" from "never chose".
- **Migration:** `20260903130000_add_user_preferences` — additive only.

### 8. Testing

- **API:** 43 suites / 775 tests, EXIT=0. `preference.service.spec.ts` contributes 40 scoped cases across 10 describes.
- **Web:** 40 suites / 674 tests, EXIT=0. 49K-specific: `PreferenceProvider` 18, `CoreAppearanceSettings` 20, `CoreDashboard` 18, `CoreSidebarPersonalization` 12, `ThemeToggle` 5, `preferences-api` 13, plus additions to `CoreShell`, `CoreSidebar` and `core-nav`.
- **Browser harness:** 38/38.
- **Typecheck:** web EXIT=0, api EXIT=0.
- **Build:** `next build` EXIT=0 "Compiled successfully" (33 static pages); `nest build` EXIT=0.

### 9. Regression

- **49I:** PASS — calendar, reminder, dispatcher, jalali, notifications, messaging (gateway + registry), support (service + 2 utils), surveys, directory, profile; matching web views and API clients all green.
- **49J:** PASS — ranking, snippet, normalize, `CoreGlobalSearch`, `search-api` green; no search file in the diff. Semantics unchanged, blockers untouched.
- **Step 4:** PASS — `CoreDashboard.spec.tsx` 18 tests plus Section 6; nothing redesigned.

### 10. Pre-existing defects

ESLint config cannot load (`eslint-config-next` circular structure), `next lint`
broken under Next 16, codebase-wide `no-explicit-any` on `(req as any).user?.sub`,
49H `findBy*` timeout flakes, a `CoreNotificationsView` `act()` warning, npm config
warnings. All factual, all unrelated, none fixed here. No repo-wide lint-green
claim is made.

### 11. Git / artifacts

- **Changed files:** 25 tracked, +1552 / −196.
- **New files:** the preferences module + migration, five Core components, one
  provider, one API client, six spec files, the harness, 9 screenshots, this report.
- **Temporary files:** all `k49k-*` read then deleted; nothing remains. Older
  `k-*.out` / `j-final.out` predate this pass and are left in place.
- **Secrets:** none introduced, none read into this document, nothing committed at
  all. Pre-existing `.tok` / `.rid` untouched.
- **Unrelated dirty files:** enumerated in 16.5, all untouched, none `.gitignore`d.

### 12. Deferred

Only the intentional items in 5.2. Every one has a factual reason; none is a
capability claimed but missing.

### 13. Final gate

```text
Dashboard                 = PASS
Personalization           = PASS
Density                   = PASS
Accessibility             = PASS
Responsive                = PASS
Security                  = PASS
API/Storage               = PASS
Regression                = PASS
Build                     = PASS
Git Hygiene               = PASS

OVERALL: GREEN
```

49K = **GREEN**. 49J remains **YELLOW** on its own register, unchanged and
untouched: its blockers need a real embedding credential and a real corpus, which
are outside this phase.

