# Phase Report — Reporting UI/UX Foundation

> Review commit: **`646d874`** — `feat(web): establish reporting user experience`.
> Baseline before this phase: `9a6cde3` (first-capability evidence-review hash commit).

## 1. What this phase is

The first **Reporting surface in the ERP web application** — a polished,
Persian-first, RTL-native landing experience for the Reporting bounded context,
built on the verified backend state that has **no Reporting business contract**,
no Reporting API, no permissions and no persistence
(`docs/reports/PHASE-REPORTING-FIRST-CAPABILITY-EVIDENCE.md`).

**The page is strictly presentational.** It claims no report type, no KPI, no
dashboard and no AI — deliberately. Its whole job is the four answers of the
phase brief §5: _where am I_ (page identity), _what this section is for_ (one
sentence), _is something broken_ (nothing is, and nothing renders as if it
were), _what can I do now_ (understand the page — no action exists yet).

**What changed:** route `/admin/reporting`, two Reporting components + tests, one
title-alias line in `core-nav.ts` + one alias test, and the browser QA harness
that proves the rendered UI. **Zero backend changes.**

## 2. A. Pre-flight — frontend architecture inspected

| Area                         | Findings (the actual locations, not assumptions)                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing / layouts            | App Router under `apps/web/src/app`; admin routes wrapped by `app/admin/layout.tsx` → `AdminShell` → `CoreShell` (header, permission-aware rail/drawer, skip link, `<main id="content">`, auth redirect). A new admin page = one `page.tsx` + metadata, exactly the Commerce/Financial pattern.                                                                                                                                                                |
| Navigation                   | Single source of truth `components/core/core-nav.ts` (`CORE_NAV`); rail/drawer from `CoreSidebar`; title lookup `pageTitleFor`; recordability `isNavTarget`; a 49K drift test pins the catalogue to the server's `NAV_TARGETS` allowlist (`core-nav.spec.ts` `SERVER_NAV_TARGETS`, hand-copied). **No Reporting entry exists anywhere** (quote-checked across web, API preferences platform, docs and history).                                                |
| Nav precedent (§17 decision) | Production routes and Financial F1 (`docs/PHASE-FINANCIAL-CHECK-REQUEST-F1-IMPLEMENTATION.md:295-296,360`) were both deliberately shipped **with NO sidebar entry**: "adding one is a platform-navigation decision"; their precedent is reachable-by-URL pages. Reporting follows it: **no rail/drawer row, no `CORE_NAV` item, no `NAV_TARGETS` change, drift test untouched.**                                                                               |
| Shared UI                    | States: `CoreStates.tsx` (`CoreLoading`/`CoreError`/`CoreForbidden`/`CoreEmpty`); feature pattern files `hr-ui.tsx` / `commerce-ui.tsx` / `financial-ui.tsx` (page heading + card + empty-state compositions, byte-identical classes across modules; Commerce documents the single-h1 rule — page headings below the shell use `h2`); utilities `glass`, `gradient-primary`, `core-card`, density tokens `p-core-card`/`py-core-card` in `styles/globals.css`. |
| Icons / palette              | `lucide-react` only; semantic tokens (`bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-primary/10`, `text-primary`); dark mode via `.dark` + `data-theme` on `<html>`; Vazirmatn variable font.                                                                                                                                                                                                                                     |
| RTL                          | `<html lang="fa" dir="rtl">` (`app/layout.tsx:91`); logical utilities (`start-*`, `ms-/me-`) throughout; no `Breadcrumb` component exists anywhere in web (so none was invented); chevrons in commerce follow the rail's direction with accessible names.                                                                                                                                                                                                      |
| Screens studied (≥3)         | `CommerceHomeView` (module home: heading → metric tiles → area cards → latest list; "no figure is arithmetic" honesty rule); `HrDashboardView` (heading → counters → area cards → latest card; everything server-sourced); `CheckRequestListView` + `financial-ui.tsx` (the newest first-UI-phase building blocks); `CoreDashboard` (identity/dashboard chrome for comparison).                                                                                |
| Copy / i18n                  | Inline Persian everywhere (`next-intl` is an unused dependency; `fa.json`/`en.json` exist but admin screens render Persian literals); `data-testid` hooks carry the stable English test names; QA scripts assert through testids, never text a translation could break.                                                                                                                                                                                        |
| Tooling                      | jest (`src/**/*.spec.{ts,tsx}`, jsdom, `@/` alias); `tsc --noEmit`; prettier (mixed CRLF baseline — even untouched files such as `hr-ui.tsx` fail `--check`); **eslint is pre-existing-broken** (crashes with "Converting circular structure to JSON" from `.eslintrc.js` on untouched files too; recorded in F1 §14 — reproduced, not introduced).                                                                                                            |
| Frontend QA workflow         | puppeteer + system Chrome harnesses (`phase49c3-visual-qa.mjs`, `phase51hr2d-hr-browser-e2e.mjs`): real login, real session, real screenshots, PASS/FAIL lines, non-zero exit on failure; `*-shots/` dirs stay untracked by convention. Dev: `next dev`; docker prod web on `:3000` (stale build), combined API on `:3001`.                                                                                                                                    |

## 3. B. UX decision — why this experience, and why it is honest

The backend truth (evidence phase) is: Reporting is a **real, registered bounded
context** whose first business capability has evidence `UNSUPPORTED` everywhere.
A Reporting page that shows metrics, lists, charts or a create button would be
fabricating the domain (§1: "A clean empty state with no primary action is
preferable to a fake button"). A page that refuses to exist at all would hide
an area of the product that users will legitimately look for as the ERP grows.

So the chosen experience is a **stable shell with a calm, intentional empty
workspace**:

- It is a _place_, not a preview: page header with the Persian identity
  «گزارش‌گیری» + one explanatory sentence («فضای کاری گزارش‌های سازمان شما»),
  then exactly one `core-card` workspace containing the empty composition.
- The empty state answers "is something broken?" without a single technical
  word: «در حال حاضر گزارشی وجود ندارد» (what is) + «گزارش‌های موردنیاز شما
  در این بخش در دسترس قرار خواهند گرفت.» (what will be) — no error colors, no
  retry control, no permission language.
- **Navigation honesty** (§17): no sidebar/rail row is added because the
  architecture establishes none (Production → Financial precedent; the drift
  test would otherwise force a backend allowlist edit for a non-capability).
  The page is reached by URL like its Financial/Production siblings. The shell
  header still answers "where am I?" (alias below) instead of falling back to
  «پنل مدیریت».
- **Route honesty** (§18): exactly one route, `/admin/reporting`. No children,
  no submenus, no `/admin/reports` alias, no search-route registration.
- **AI honesty** (§27): the `AI_GATEWAY` seam exists on the backend, but no
  Reporting AI use case exists — so nothing in this UI mentions, implies or
  teases AI ("خلاصه‌سازی", "هوشمند", "Ask AI" all banned by the component tests).
- **Future-readiness without pre-building** (§28): the shell (route, identity,
  workspace card, testids) is exactly where a future confirmed capability will
  plug content in. No "coming soon" dashboards, no disabled buttons, no
  placeholder grids — nothing to tear out later.

## 4. C. Visual implementation

| Element           | Implementation (all tokens/patterns from the audit)                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page structure    | `ReportingView` → page heading (`h2` + one sentence, `mb-6` like every module) → single workspace card (`core-card p-4 sm:p-6`) → `ReportingEmptyState`. No breadcrumbs (none exist in the app), no secondary cards, no filler sections.                                                                                       |
| Typography        | Page `h2` `text-xl font-semibold sm:text-2xl` (Commerce `CommercePageHeading` scale); setup sentinel `h3` `text-base font-semibold sm:text-lg`; sentences `text-sm` (never `text-xs`) with `leading-7` for Persian readability; Vazirmatn everywhere via the app font stack.                                                   |
| Heading hierarchy | Shell header `h1` (via alias «گزارش‌گیری») → page `h2` → empty `h3` — one step per level, asserted in tests and proven in the browser DOM. Commerce's single-h1 correction is followed; Financial's/HR's double-`h1` wart is not copied.                                                                                       |
| Colors            | Neutral-positive only: card `bg-card`/`border-border`, text `foreground`/`muted-foreground`, icon tile `border-primary/20 bg-primary/10 text-primary` (theme-resolved, reads calm in both themes). No red, no gradients, no new palette.                                                                                       |
| Icons             | One `lucide-react` glyph (`BarChart3`, the universal reporting mark) in a 64px rounded tile with a small offset frame — aria-hidden decoration; the two sentences carry 100% of the meaning. No second icon family, no stock illustration, no oversized graphic.                                                               |
| Empty state       | Vertically generous (`py-14 sm:py-16`), centered flex column, `max-w-md` description: visual → `h3` → sentence. Feels intentional (like a workspace state) rather than unfinished (like a missing feature) — verified in the §29 review.                                                                                       |
| Navigation        | No `CORE_NAV` change; no `NAV_TARGETS` change; `PAGE_TITLE_ALIASES['/admin/reporting'] = 'گزارش‌گیری'` using the mechanism `core-nav.ts` documents for real routes outside the rail (the settings precedent) — header h1 resolves, while `isNavTarget` stays false and the 49K drift test stays entry-for-entry.               |
| Responsive        | Mobile-first composition (stacked, centered), `sm:` scale-ups like sibling views; shell provides rail ≥1024px and the RTL drawer below. Proven at 1440 / 1280 / 768 / 390 / 360 with zero horizontal overflow and intact hierarchy at every width.                                                                             |
| RTL               | Native, not mirrored: `<html dir="rtl">` document, right-aligned identity text, right-anchored rail (measured), centered content needing no directional utilities; source scan forbids `text-left/right`, `ml-/mr-/pl-/pr-`, `left-/right-`, `dir="ltr"`. Focus order starts with the RTL-aware `skip-link` (`focus:start-4`). |

## 5. D. Interaction

| Concern                 | Behavior (inherited vs. owned)                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Navigation              | Inherited from `CoreShell`: permission-aware rail (desktop), overlay drawer (tablet/mobile), active-row highlight. Reporting contributes **no row** by decision — proven in-browser: zero anchors to `/admin/reporting` in the entire document at every viewport, open drawer included.                                                                                    |
| Route behavior          | Proven in the browser: direct load renders registered identity; hard refresh preserves it; back leaves the route, forward returns and re-renders; a signed-out visitor is redirected to `/login` (isolated-context probe — the earlier shared-context run was measuring the session's token, fixed by `createBrowserContext`).                                             |
| Hover / focus / pressed | The page owns no interactive element, so there is no hover/pressed state of its own — nothing to polish and nothing that can mislead. Focus behavior is the shell's: skip link first, then the header cluster; the walk never stalls on `<body>` (asserted keystroke by keystroke).                                                                                        |
| Active state            | Not applicable to a catalogue-less route (no row can claim it); the shell header's «گزارش‌گیری» title is the only location signal, and it renders on this page instead of the generic fallback.                                                                                                                                                                            |
| Loading                 | None by design (§20): the page renders static content with zero requests; a skeleton would be theater. Proven in-browser: no `status` role, no skeletons.                                                                                                                                                                                                                  |
| Error handling          | None by design (§21): no operation exists to fail; no error box is rendered (`alert` role absent). The console stays error-clean across the whole QA run.                                                                                                                                                                                                                  |
| Accessibility           | One `h1` per document; `h2`→`h3` outline with exact Persian names; the decorative icon composition is `aria-hidden` (the sentences are the message); Persian-only user text (no Latin); skip-link entry; visible shell focus rings untouched; zero animations owned (reduced-motion has nothing to reduce); theme agreement `.dark` ⇔ `data-theme` asserted on both flips. |

## 6. E. Scope protection

Explicitly confirmed — by component tests (DOM + source scans), by the QA run,
and by a final repo-wide grep:

```text
No fake reports       — zero routes, zero record shapes, zero digits anywhere
No fake KPIs          — no figures, no counters, no percentages anywhere
No fake charts        — no chart component, no series, no axes; the ONE glyph is
                        an aria-hidden identity mark, not a visualization
No fake dashboards    — one card holds one empty state, not a metric grid
No fake actions       — workspace contains 0 links/buttons/inputs/tabindex
No fake API data      — component sources import no `@/` API client, router or
                        fetch primitive at all (`fetch(`, `axios`, `useRouter`,
                        `next/link`, hooks and timers banned in code)
No AI feature         — no AI copy, no "هوش مصنوعی"/"openai" in code, no gateway
                        usage, no AI-adjacent CTA in any language
No backend changes    — `git diff` touches `apps/web/` only; reporting module,
                        AI platform, Prisma, RBAC, nav allowlist untouched
```

The vocabulary scan also bans `kpi`, `dashboard`/`داشبورد`, `widget`,
`metric`, `analytics` and the five most plausible fake CTAs (Persian:
new-report / create-report / build-report / get-export / schedule-subscribe
phrasings) in Reporting **code** (comments excluded by the same `codeOf` rule
the backend isolation suite uses, so rule documentation cannot trip the gate).

## 7. F. UX review (human — §29, from the rendered screenshots)

| Question            | Verdict after review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clarity             | A first-time user reads header «گزارش‌گیری» + workspace «در حال حاضر گزارشی وجود ندارد» and knows exactly where they are and what this section is for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Emotional quality   | Calm and professional in **both** themes — dark mode verified click-flipped both ways, `.dark` ⇔ `data-theme` agreement asserted (the first harness run asserted the wrong _direction_ because headless Chrome prefers dark; fixed to flip-based assertions).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Simplicity          | Heading + one card + one state. No card grid, no "sections to fill space".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Hierarchy           | Title dominant at every width (1440/1280/768/390/360 measured; tablet/mobile verified through user-visible-viewport evidence after proving fullPage capture shifts the RTL canvas).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Empty-state quality | Intentional: centered geometry, generous but bounded whitespace, primary-tinted tile small enough to support the message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Persian quality     | Natural and blame-free: current-state sentence + future-readiness sentence; no system vocabulary, no failure implication, no Latin leak (browser-proven).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| RTL quality         | Native: right-aligned identity, right-anchored rail (measured), centered composition, no physical-direction utilities in code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Visual balance      | Whitespace as designed; no cramped controls; icon scale (32px glyph in 64px tile) subordinate to the message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Enterprise quality  | Side-by-side with the mature HR screen: same chrome, same card treatment, same density and spacing tokens — one product. Sibling reference screenshot captured in the run.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Corrections made    | (1) Theme QA rewritten from direction-blind to flip-based after the first run exposed the wrong assumption. (2) Protected-route probe moved to an isolated browser context after the shared-context run leaked the session. (3) Console filter restricted to app errors — dev-only HMR socket noise (bfcache navigation test) and favicon noise are documented and excluded with reasons. (4) QA screenshots changed from `fullPage` to viewport-only after the pixel probe proved fullPage capture shifts the RTL canvas ~+217px (viewport capture reads the exact user-visible pixels). No product code changed in any correction — all four were harness/measurement fixes. |

## 8. G. Verification — every command actually executed

Run from `E:\ERP\apps\web` unless noted; `npx` is blocked by this machine's
PowerShell execution policy, so the hoisted binaries
(`..\..\node_modules\.bin\…`) were invoked via `cmd /c`. Timings are measured.

| #   | Stage              | Command                                                                                | Result                                                                                                                                                                                                                                                                                                               |
| --- | ------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Focused tests      | `jest src/components/reporting src/components/core/__tests__/core-nav.spec.ts`         | **PASS** — 2 suites, 51 tests (re-run green after formatting)                                                                                                                                                                                                                                                        |
| 2   | Broader regression | `jest --silent` (full web suite)                                                       | **PASS** — 105 suites, 1773 tests, 42.3 s                                                                                                                                                                                                                                                                            |
| 3   | Typecheck          | `tsc --noEmit` (the `type-check` script)                                               | **PASS** — exit 0, no diagnostics                                                                                                                                                                                                                                                                                    |
| 4   | Formatting         | `prettier --check` on all touched/new files                                            | **PASS** — the 4 new files plus `reporting-ui-visual-qa.mjs` after `--write`; the 2 shared-file edits are prettier-canonical in their hunks while the files carry pre-existing drift in untouched regions (correspondence children, commerce array), so they fail `--check` at baseline exactly as before this phase |
| 5   | Lint               | `eslint` on touched files                                                              | **ENVIRONMENT/PRE-EXISTING failure** — crashes with "Converting circular structure to JSON" from `.eslintrc.js` on _untouched_ files too (measured on `hr-ui.tsx`); recorded in F1 §14 as broken independent of any phase                                                                                            |
| 6   | Build              | `next build`                                                                           | **PASS** — "Compiled successfully", 65/65 static pages, `/admin/reporting` listed as a static route                                                                                                                                                                                                                  |
| 7   | Browser QA (§30)   | `node reporting-ui-visual-qa.mjs` (dev `:3003` + API `:3001`, real Chrome, real login) | **PASS** — **78/78 checks** across desktop/laptop/tablet/mobile, refresh, back/forward, protected route, keyboard, both themes, drawer; zero console errors; screenshots in `reporting-ui-qa-shots/`                                                                                                                 |
| 8   | Scope proof        | `git status --porcelain`, `git diff --stat`                                            | only `apps/web/` touched; no API, no Prisma, no RBAC, no nav allowlist                                                                                                                                                                                                                                               |

Classification: **INTRODUCED — none. PRE-EXISTING — the eslint toolchain breakage (no file in this repo can pass an `eslint` invocation right now) and the `core-nav` prettier drift in untouched regions. ENVIRONMENT — `npx.ps1` execution policy (worked around), docker stack served QA. OUT OF SCOPE — the phase intentionally does not run API e2e (nothing on the backend changed).**

## 9. H. Remaining gaps

| Classification                           | Item                                                                                                                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **implemented**                          | The Reporting landing experience: route, page, empty state, title alias, 51 tests, browser QA harness + 78/78 run                                                                                                                                               |
| **future**                               | The first Reporting _business_ capability (contract, API, permission, list/detail surfaces) — the workspace card is where its content plugs in; a sidebar row then becomes the platform-navigation decision it still is not                                     |
| **future**                               | Reporting in global search / favourites / recents — requires the catalogue + allowlist contract, deliberately not pre-built                                                                                                                                     |
| **blocked by missing business contract** | Everything on the brief's forbidden list (§1): reports, KPIs, dashboards, charts, metrics, builders, filters, schedules, exports, subscriptions, saved reports, AI summaries/explanations, analytics — none exists on the backend, so none may appear in the UI |

## 10. I. Commit

- Feature commit: **`646d874`** — `feat(web): establish reporting user experience`
  (route + components + tests + alias + QA harness; single focused commit).
- Documentation commit only if it matches repository convention: the phase
  record `docs/reports/PHASE-REPORTING-UI-UX-FOUNDATION.md` is included in the
  feature commit (as with `83a080a`/`fec78be`, which carried their reports),
  with the hash recorded by a follow-up hash commit exactly like
  `38566f8`/`5d14a57`.
- Baseline: `9a6cde3`. Backend untouched: no `apps/api` file in the diff.

The governing principles held:

```text
MAKE THE USER FEEL THAT THE PRODUCT IS CALM, CLEAR, AND IN CONTROL.
BEAUTIFUL UI MUST NEVER BE USED TO HIDE MISSING BUSINESS FUNCTIONALITY.
```
