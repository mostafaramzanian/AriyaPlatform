# PHASE 51-HR — ARCHITECTURE & UX READINESS AUDIT

> Planning/audit pass ONLY. **No HR code was written in this pass**, per §28 of the
> Phase 51-HR brief. Every claim below is read off the live repository (`E:/ERP`) and
> cross-checked against `ERP_Structure_v17.xml` and the extracted `lovable/`.
>
> Snapshot at audit time:
> - Branch `master`, HEAD `a38ba77`, **214 dirty working-tree entries**. HR work must stay
>   isolated from that in-flight state (§26).
> - Live backend: `apps/api` (NestJS). npm workspaces = `apps/web`, `apps/api`, `packages/*`.
> - Three physically separate Prisma projects already exist: `prisma/core`
>   (`CORE_DATABASE_URL` → `src/generated/core-client`), `prisma/cms` (`CMS_DATABASE_URL` →
>   `src/generated/cms-client`), `prisma/observability` (`OBSERVABILITY_DATABASE_URL`).
>   All three are `provider = "postgresql"`.
> - Env contract (`src/config/env.validation.ts`): `CORE_DATABASE_URL` **required** (30);
>   `CMS_DATABASE_URL`, `OBSERVABILITY_DATABASE_URL`, `DATABASE_URL` **optional** (31-33).

---

## 0. Executive summary — the two decisions this audit forces

1. **"HR must be a TRUE BUSINESS MODULE" is achievable — but not the way Correspondence
   did it.** The repo already has a hard, working precedent for a domain that owns its own
   database and its own bootable process: **CMS** (`src/modules/cms/**` +
   `prisma/cms/schema.prisma` + `CmsPrismaService` + `cms-main.ts`/`cms-app.module.ts`).
   Correspondence — the closest *business-domain* analogue — did **not** use it; it sits
   inside Core. §6 recommends CMS mechanics applied to an HR domain, with Correspondence's
   security doctrine.

2. **Correspondence scheduled-send is confirmed broken end-to-end on the live tree**, and
   deeper than the brief's §21 describes: it is not one lookup, it is a **five-layer**
   omission including a DB `CHECK` constraint and the web `LetterStatus` type. Needs a
   small, separate, tested fix **before** HR work (§11). Do not fold it into HR.

---

## 1. Current Aria HR readiness

Assets HR can build on (verified in `apps/api`):

| Concern | Existing asset | File / symbol | Reuse for HR |
|---|---|---|---|
| Tenant + identity | `RequestContextService.get()` → `{userId, tenantId, requestId, correlationId}` | `src/common/request-context.service.ts` | **Yes — the §8/§17 doctrine hangs on this.** |
| Permission check | `PermissionService.userHasPermission(userId, perm)` | `src/auth/rbac/**`, `constants/permissions.ts` | Yes — but permission strings live in Core (§6, §9). |
| Jalali calendar | `jalaliWallTimeToInstant`, `instantToJalaliDate`, `instantToZonedTime`, `APP_TIME_ZONE`, `parseJalaliDateKey`, `JALALI_MONTHS` | `src/calendar/jalali.util.ts` | **Yes — reuse verbatim; never re-implement (§8).** |
| Holidays/occasions | `CalendarOccasion` + published-calendar migration | `20260910120000_add_calendar_occasions` | Yes — late/absence math reads holidays here, not a hard-coded list. |
| Directory link | Core `User.department/jobTitle/extension/managerId` (self-ref, `User_manager_not_self` CHECK, cross-tenant pointer never resolved) | `prisma/core/schema.prisma` | **As a link only. §2 forbids adding HR fields to `User`.** |
| Safe background worker | Claim via conditional `updateMany` + `ticking` overlap guard + bounded `take` + `unref()` | `src/calendar/reminder-dispatcher.service.ts` | **Yes — required pattern for any HR scheduler and for the §11 fix.** |
| Operational trace | `LetterTrackingEvent` (append-only) | correspondence | Pattern only. |
| Allowlist HTML sanitization | `sanitize-html` | `correspondence-sanitize.util.ts` | Yes for any HR free-text/reason field. |
| Audit + request logging | `@Global()` audit/observability | `src/observability/**`, `AuditService`, `ObservabilityInterceptor` | Yes for §18 mutations. |
| Empty/loading/error UI | `CoreEmpty`/`CoreLoading`/`CoreError` | `apps/web/src/components/core/CoreStates.tsx` | Yes — replaces Lovable's fake `setTimeout` loading. |

Genuinely absent — must be designed, not assumed:
- **No HR model anywhere.** No `Employee`/`AttendanceRecord`/`LeaveRequest`/
  `MissionRequest`/`OvertimeRequest`/`PersonnelTrafficRecord` in Core, CMS or Observability
  schemas. Core's own comment states employment/HR fields are deliberately absent from `User`.
- **No Excel export** in backend or web: `exceljs` is a dependency of *neither*
  `apps/api/package.json` nor `apps/web/package.json` (risk R3).
- **No charting library** in `apps/web` (`recharts` absent) — chart parity is blocked until
  §16 picks an approach.
- **No `src/modules/hr`, no `prisma/hr`, no `HR_DATABASE_URL`, no HR permission constants.**

---

## 2. Current Lovable HR surfaces

Audited from the extracted reference at `E:/ERP/lovable/` (the brief says `lovable.zip`;
it is already unzipped on disk).

Only **two** HR screens are real and routed — `lovable/src/routes/index.tsx` lines 146-149:
```
active === "hr-report"     → <PersonnelTrafficReportPage />
active === "hr-attendance" → <PersonalAttendancePage userName="محمد رضایی" />
```

`AppSidebar.tsx`'s HR group lists **six** items, but only two have any target:
```
منابع انسانی (hr)
├── حضور و غیاب فردی   (hr-attendance) → ROUTED, real component
├── گزارش تردد پرسنل    (hr-report)     → ROUTED, real component
├── مرخصی              (hr-leave)      → SIDEBAR ONLY — no component, no route
├── ماموریت            (hr-mission)    → SIDEBAR ONLY — no component, no route
├── اضافه کاری          (hr-overtime)   → SIDEBAR ONLY — no component, no route
└── نظرسنجی کارکنان     (hr-survey)     → SIDEBAR ONLY — no component, no route
```

So brief §4 must be read as:
- (A) Personal Attendance and (B) Personnel Traffic Report → **real reference UI exists**;
  reproduce their hierarchy and behavior (§3b, §3c).
- (C) مرخصی, (D) مأموریت, (E) اضافه‌کاری, (F) نظرسنجی → **label + icon only, zero screens.**
  Per §4 we must **not fabricate** their visuals; build Aria-native UX and record them as
  `NEW / NOT PRESENT IN REFERENCE`.

Mock data that must not survive into Aria:
- `PersonalAttendancePage.tsx`: `CURRENT_MONTH_RAW`/`PREVIOUS_MONTH_RAW` literal `Row[]`
  (hard-coded Persian dates `۱۴۰۴/۰۳/۰۲ …`, statuses `present|late|absent|leave`), fixed
  `monthlyTrend`/`lateAbsentData`/`leaveUsage`,
  `DONUT_COLORS = ["#818cf8","#22d3ee","#f59e0b","#0f172a"]`, `userName="محمد رضایی"`.
  `_rebase()` only re-labels months against live Jalali today — the rows and every
  statistic stay fabricated.
- `PersonnelTrafficReportPage.tsx`: `const PEOPLE`, `SAMPLE_ROWS`, `MEMBERSHIP`;
  `handleSubmit()` fakes latency with `window.setTimeout`; the "Excel" export builds an
  `ExcelJS.Workbook()` client-side from those mock rows.
- `routes/index.tsx` also seeds fake correspondence notifications with HR senders
  (`HR-58821`, `HR-58801`) — UI chrome only, no data contract.

**Conclusion:** Lovable HR is **prototype UI**: a visual, interaction and *data-shape*
reference. It is not a backend, not an authz model, not a persistence model.

---

## 3. Exact visual specification

### 3a. Design-token parity — the good news

`apps/web/src/styles/globals.css` and `lovable/src/styles.css` are already on the **same
design system.** Verified identical values:

| Token | Lovable | Aria | Match |
|---|---|---|---|
| `--font-sans` Vazirmatn stack | line 8 | line 17 | ✅ Aria comment: "mirrors lovable's `--font-sans` order" |
| `--radius` | `0.75rem` (44) | `0.75rem` (70) | ✅ |
| `--primary-glow` (light) | `0.58 0.20 275` | `0.58 0.20 275` (47) | ✅ |
| `--shadow-card` | `0 1px 3px oklch(0 0 0 / .04), 0 8px 24px -6px …` | identical (80) | ✅ |
| `--shadow-glow` | `0 8px 32px -8px oklch(.58 .20 275 / .35)` | identical (82) | ✅ |
| `--gradient-primary` | `linear-gradient(135deg, primary 0%, primary-glow 100%)` | same (85) | ✅ |
| `.gradient-primary` util | 138 | 340 | ✅ |

Aria additionally ships a **dark theme** (`--primary-glow` override @109; comment @133:
"Lovable keeps the gradients and shadow-glow identical in dark mode"). Lovable is
light-only, so dark-mode HR is an Aria-native extension, not a parity regression.

⇒ §5's "translate, don't paste classes" is already half-satisfied: **the tokens match; only
the component classes must be re-expressed with Aria's `card`/`surface`/`badge`/`tabs`/
`table` primitives.**

### 3b. Screen A — `PersonalAttendancePage` hierarchy (verified line refs)

```
root      dir="rtl" · p-6 lg:p-8 · space-y-6 · max-w-[1600px] w-full mx-auto · animate-fade-in (239)
header    h1 text-2xl lg:text-3xl font-bold tracking-tight (247) + greeting w/ userName
filter    PersianDatePicker from/to + PRESETS (current/previous/3mo/this-year, PresetKey)
          draft from/to separate from appliedFrom/appliedTo (Apply pattern), activePreset highlight
leave     TWO hero cards: rounded-3xl border-indigo-400/20 (320) and border-cyan-400/20 (351),
          p-7 lg:p-8, value text-2xl lg:text-3xl font-bold text-white (۵۸٪ / ۴۲٪)
stats     FOUR StatCard (386-389): Clock "حضور این ماه (ساعت)", AlertTriangle "تعداد روزهای
          تأخیر", CalendarX "تعداد روزهای غیبت", TrendingUp "میانگین حضور روزانه"
          StatCard (520-533): icon tile size-10 rounded-xl bg-white/10 grid place-items-center;
          value text-3xl font-bold text-foreground tabular-nums; accent = from-{hue}-500/25 to-{hue}-500/5
          NOTE the hardcoded ۵۸٪/۴۲٪ + these 4 labels are the *shape* to keep, values must be computed.
table     rounded-2xl border border-border bg-card shadow-card overflow-hidden animate-fade-in (393)
          columns: weekday | date | checkIn | checkOut | presence | lunch | description | status
          status badge map (98-102): present · late amber bg-amber-500/10 ·
          absent rose bg-rose-500/10 · leave violet bg-violet-500/10 — Persian label always
          present, so color is never the only signal (§24).
          empty state: rounded-2xl border-dashed bg-card/40 p-10 centered + BarChart3 icon (455-462)
charts    grid lg:grid-cols-3 gap-4 (470), only when showCharts:
          1) ChartCard "روند حضور ماهانه" / "مجموع ساعات حضور در ۶ ماه گذشته" → LineChart
             margin {top:10,right:10,left:-20,bottom:0}, gradient stroke, RTooltip dark
             (background #0f172a, border #1e293b, radius 12, 12px) (471-487)
          2) "توزیع تأخیر و غیبت" / "مقایسه ماهانه" → BarChart, Bar late #f59e0b,
             Bar absent #f43f5e, radius [6,6,0,0] (489-501)
          3) "استفاده از مرخصی" / "ترکیب مرخصی‌های امسال" → PieChart donut,
             innerRadius 55 outerRadius 85 paddingAngle 3, Cells from DONUT_COLORS (503-513)
          ChartCard (536-540): rounded-2xl border border-border bg-card p-5 shadow-card
             animate-fade-in, h3 + 11px subtitle
export    Excel button (Download icon)
```

### 3c. Screen B — `PersonnelTrafficReportPage` hierarchy (verified)

```
header    "گزارش تردد پرسنل" (h1 text-xl lg:text-2xl font-bold tracking-tight)
filter    5 facets each with FieldLabel + lucide size-3.5 icon:
          نوع عضویت → MultiSelect (416) · بخش/دپارتمان → MultiSelect (426) ·
          نام پرسنل → PersonMultiSelect (436) · وضعیت → MultiSelect (444) ·
          از تاریخ/تا تاریخ → PersianDatePicker (458/467)
          state is Set<…> per facet; MultiSelect (751) shows initials+name rows, collapses to
          "+N" chips (796); PersonMultiSelect (854) shows "N نفر انتخاب شده" (911);
          popover closes on outside document mousedown; active-filter pill
          "{toPersianDigitsLocal(activeFilterCount)} فیلتر فعال" (392)
tabs      activeTab: "report" | "analytics" (115, buttons 510/522)
report    4 StatCard (543-567) → table "جزئیات تردد روزانه" (581) with Legend row:
          Legend bg-emerald-400 حاضر / bg-amber-400 تأخیر / bg-rose-400 غایب (587-589);
          Th px-6 py-3 (698); per-row avatar initials() (85) + gradFor(id) (98);
          InfoTooltip(text, weekday, date, status) per row (645, 1005)
analytics <AnalyticalCharts/> (661) — **custom hand-rolled SVG, NOT recharts**:
          area+line paths via stepX = (W - P*2)/(data.length-1), path M/L join,
          area close, fill url(#ot-area)/url(#line-area), stroke url(#line-stroke)
          strokeWidth 2.5, round caps (1331-1345, 1555-1599); horizontal bar rows with
          value + pct (1290-1305, 1535-1536); LeaveStatCard group (1391) with hint lines
          "مرخصی: X٪ از سهمیه"; gradient-text total (1524); میانگین/بیشترین footer (1468-9)
export    ExcelJS.Workbook() (193) with per-column widths (257)
```

**Important consequence of the analytics finding:** screen B already demonstrates the
**no-dependency SVG chart approach** inside the reference itself. Aria can standardize on
that for both screens instead of adopting `recharts` — see §16-R3, which changes the
recommendation from "add recharts" to "build one shared `HrChart` SVG primitive".

### 3d. Shared parity checklist (target → Aria primitive)

RTL · Vazirmatn · `max-w-[1600px]` + `space-y-6` rhythm · `rounded-2xl`/`rounded-3xl` ·
`border-border bg-card` · `shadow-card` / `hover:shadow-glow` · gradient accents ·
h1→h3 hierarchy · `tabular-nums` on every number · lucide icons (already Aria's set) ·
badges with text+icon+color · filters → `ui/select`,`ui/popover`,`ui/command`,`ui/badge` ·
tabs → `ui/tabs` · table → `ui/table` · empty/loading/error →
`components/core/CoreStates` (`CoreEmpty`/`CoreLoading`/`CoreError`) · focus rings ·
responsive + mobile hierarchy · light+dark (Aria has dark; Lovable does not).

---

## 4. Exact functional specification

### 4a. Screen A — حضور و غیاب فردی (self-service)
1. Actor: any authenticated employee, scoped to **their own** record. No employee picker —
   the page is *personal*. Identity comes only from `RequestContextService` (§9).
2. Range: Jalali from/to + the 4 presets; default = current Jalali month. Range is
   **bounded server-side** (max window, e.g. ≤ 24 months) so no preset can request all history.
3. Two leave hero cards = real `LeaveBalance` math: annual entitlement, used, remaining %,
   and the next expiring/overstalled balance. (Lovable's ۵۸٪ / ۴۲٪ are literals.)
4. Four stat tiles = server aggregates over the range: hours present this month, late-day
   count, absent-day count, average daily presence. Computed in SQL, never in the browser.
5. Daily table = one row per **working day** in range: `AttendanceRecord` joined with
   approved `LeaveRequest`/`MissionRequest`/`OvertimeRequest` and `CalendarOccasion`
   holidays. `presence` and `lunch` are **derived, never stored as text**; the em-dash `—`
   cells in Lovable are computed "no punch" states.
6. Charts (3) = the same aggregate source as the table, bucketed by Jalali month / leave
   type. One query per chart family; no client-side summation of the page's table rows.
7. Excel = **server-generated** from the identical, authorized aggregate (§16-R3).
8. States: real loading, empty (no records in range), error — via `CoreStates`, replacing
   `setShowCharts`/`setTimeout` fakery.

### 4b. Screen B — گزارش تردد پرسنل (manager/HR report)
1. Actor: `hr.report.read` plus a team-scoped variant (manager sees own reporting subtree
   only — derived server-side from the directory, never from a client-supplied org path).
2. Facets: membership type, organizational unit, person, status, Jalali range. Each facet
   is a **server-side filter** (query params → SQL predicates). No facet is applied by
   React filtering. Person/department option lists come from bounded HR endpoints, not an
   embedded `PEOPLE` array.
3. Report and Analytics tabs share **one** filtered query; analytics returns aggregates only.
4. Table: paginated (`page`/`pageSize`, hard cap e.g. 200), deterministic `ORDER BY`
   (canonical timestamp + id tiebreak), server-provided total, `InfoTooltip` fed from the
   stored reason text.
5. Summary tiles + charts computed in SQL over the filtered set (§25 — no N+1).
6. Excel: server-side, same authorization, same filters, bounded row cap, no private fields.

### 4c. Screens C–F — `NEW / NOT PRESENT IN REFERENCE`
Only sidebar labels exist, so 51-HR-1..5 scope is the **domain foundation plus a minimal
Aria-native list/detail/request surface** per domain, using A/B's filter/table/badge/status
conventions so the family looks coherent.
- **مرخصی**: request → approve/reject lifecycle, balance-validated at submit; overlapping
  ranges rejected; approved leave back-derives into attendance status (§13).
- **مأموریت**: destination, start/end, reason, approval; suppresses late/absent for its
  window (§13).
- **اضافه‌کاری**: request/record + approval; feeds the analytics totals (§14).
- **نظرسنجی کارکنان**: **do not build.** Core already ships a Surveys platform
  (`src/surveys/**`, `admin/surveys`, `lib/surveys-api.ts`, `ADMIN_SURVEYS_*`). HR should
  segment its audience as employees, not fork a second engine. Open question §16-Q4.

---

## 5. Gap analysis

| # | Gap | Evidence | Severity |
|---|---|---|---|
| G1 | No HR backend, models or module at all | 0 HR tables; Core comment says HR fields deliberately absent from `User` | Blocker (= the phase) |
| G2 | No precedent for a *business* module owning its own DB | Correspondence/Support/Surveys/Calendar live in Core; only CMS/Observability separate | High — forces §6 |
| G3 | `PermissionDomain` is a **Prisma enum in Core**; HR perms need a member → Core migration | `permissions.ts:185-196` first did this for CORRESPONDENCE | High — Core residue |
| G4 | Web talks to **one** API origin | `lib/constants.ts:2` `NEXT_PUBLIC_API_URL`; no per-module base URL | High — shapes §6 |
| G5 | No Excel export dependency anywhere | `exceljs` absent from `apps/api` + `apps/web` | Medium — §16-R3 |
| G6 | No `recharts` in `apps/web` | `apps/web/package.json` | Low — Lovable itself charts screen B in raw SVG (§3c) |
| G7 | Lovable Jalali dates are Persian-digit strings re-derived client-side | `faToEn`, `todayJalali`, `_rebase`, `Intl …ca-persian` | Medium — Aria converts server-side via `jalali.util` |
| G8 | Scheduled-send broken **and** violates repo worker doctrine | §11 | **High — fix before HR** |
| G9 | Dev artifacts committed beside migrations | `migration_diff.sql`, `migration_diff2.sql`, `our_migration.sql`, `prisma/dev.db(+ -journal)` | Medium — §12 |
| G10 | 214 uncommitted entries incl. `core/schema.prisma`, `correspondence.service.ts` | `git status --porcelain` | High process risk — §14 |
| G11 | Web `LetterStatus` type + badge/label maps lack `SCHEDULED` | `correspondence-api.ts:14` | Confirms G8 is unfinished, not designed-away |

---

## 6. Recommended module boundary  ← **requires sign-off (Q1)**

### 6a. What the repo actually proves

| Fact | Evidence |
|---|---|
| Three real Prisma projects, each with own env var + generated client | `prisma/{core,cms,observability}/schema.prisma`; `package.json:28-34` (`prisma:generate:*`, `prisma:migrate:*`) |
| A module can own a client and never touch Core's | `src/database/cms-prisma.service.ts:2-7` — "CMS must never share Core's Prisma client or physically touch Core's database"; `cms-prisma.module.ts` exports only `CmsPrismaService` |
| Domain code may live under `src/modules/<domain>/**` | `src/modules/cms/{blog,media,common}/**` |
| **Correspondence — the nearest business-domain precedent — is hosted inside Core** | `src/core-app.module.ts:22`; `src/app.module.ts:25-26,65-66` ("Phase 50 … first business domain"); tables at `prisma/core/schema.prisma:2510+` |
| Core is independently bootable; CMS is not identity-independent | `core-app.module.ts:40-49`; `cms-app.module.ts:21-38` (JwtStrategy reads Core `User.tokenVersion`; `PermissionService` reads Core `Role`/`Permission`) |
| The Module Platform targets **remote** modules, with one-way dependency | `module-platform.module.ts`: "NO BUSINESS MODULE IMPORT … there will never be an HRModule or FinanceModule here. The dependency runs the OTHER way — a business module injects `ModuleClient`" |
| Platform export contract is deliberately asymmetric | same file: `ModuleClient` IS exported; `ModuleRegistryService` IS NOT |
| `ModuleClient` surface is tiny | `module-client.service.ts:80 call<TData,TPayload>`, `:152 isAvailable`, `:167 actorFromContext` |
| The web has a **single** API origin | `apps/web/src/lib/constants.ts:2` `NEXT_PUBLIC_API_URL \|\| 'http://localhost:4000/api'` |
| 49M's own text **names HR as a future business module** | `module-platform.module.ts` comment above |

⇒ The brief's §19 and the repo disagree about **shape**, not direction. The doctrine is real
and explicitly anticipates an HRModule; **Correspondence did not honor it** — it took the
in-Core shortcut. HR should not repeat that. But "deploy HR as a separate HTTP process
today" is equally premature: with one web origin (G4) a separate process is unreachable
without new gateway work.

### 6b. The three options

**Option A — Core-hosted, like Correspondence.** `src/hr/**`, tables appended to
`prisma/core/schema.prisma`, `PermissionDomain.HR`. Fastest, closest to the nearest
precedent. **Directly violates §19/§23** and adds ~10 HR tables to Core. Rejected.

**Option B — CMS mechanics, Core-adjacent (RECOMMENDED).**
```
apps/api/src/modules/hr/**                       HR domain code, own directory (mirrors src/modules/cms)
apps/api/prisma/hr/schema.prisma                 ALL HR tables; provider postgresql;
                                                 url = env("HR_DATABASE_URL");
                                                 output = ../../src/generated/hr-client
apps/api/src/database/hr-prisma.{module,service}.ts   mirrors cms-prisma.* exactly
apps/api/src/config/env.validation.ts            HR_DATABASE_URL optional (like CMS @31)
apps/api/package.json                            prisma:generate:hr, prisma:migrate:hr, + into prisma:generate
registration: AppModule (main.ts combined deployable) — deliberately NOT CoreAppModule
route namespace /api/hr/** · permission namespace hr.*
```
Consequences, stated honestly:
- `core-main.ts` boots with **zero** HR knowledge → §19's real intent (no HR tables, no
  `HRModule` import in Core) holds for the Core deployable, exactly as it holds for CMS today.
- HR data is physically isolated in `hr_db`; Core's schema gains **no** HR table.
- The combined `main.ts` stays the default deployable, so the single-origin web (G4) works
  unchanged in dev — no gateway invented inside this phase.
- One unavoidable, documented residue in Core: `PermissionDomain.HR` + catalogue rows,
  because `PermissionService`/`RolesGuard` read Core's `Role`/`Permission`
  (`cms-app.module.ts:26-31` proves this is pre-existing and explicitly out of scope to
  redesign). Precedent: CORRESPONDENCE did exactly this (`permissions.ts:185-191`), as did
  Observability with one seeded permission (`core-app.module.ts:161-165`).
- HR must **not** import Core's `PrismaModule` for domain reads; Core identity is reached only
  through the §6d gateway.

**Option C — HR as a registered remote module over the Module Platform.** The purest reading
of §19: HR is its own deployable, in `ModuleRegistration`, signed, swept, reached via
`ModuleClient.call`. Correct end-state, but needs a second web origin or a Core proxy/router,
a provisioning entry, and a pipeline — none of which exist for a business domain.
**Defer**, and design B so C is a promotion, not a rewrite.

### 6c. Recommendation — build B, structured so C stays available

1. **All** HR persistence behind `HrPrismaService`; never a raw Core client for HR rows.
2. Every outbound call to Core identity/directory behind **one** adapter interface
   (`HrIdentityGateway`), so it can be re-pointed from in-process read → `ModuleClient.call`
   without touching services or controllers.
3. Route namespace `/api/hr/**` and permission namespace `hr.*` from day one.
4. **No Prisma FK from `hr_db` to `core_db`.** `coreUserId`/`tenantId` are opaque strings
   validated by the gateway, never relations. This is the single biggest structural
   difference from Correspondence (which *does* have FKs to Core `User`) and it is the price
   of the isolation §19 asks for — so it must be a conscious decision, not drift.
5. Copy the §50 hardening list wholesale: server-derived identity, tenant snapshot column
   never projected, atomic server-side numbering, allowlist sanitization, projection-level
   privacy rules, per-subject rows for per-subject semantics.

### 6d. HR → Core read contract (the only cross-boundary surface)
Needed: resolve `coreUserId` → display name/department for tables; confirm a manager is in
the same tenant before granting team scope; read `CalendarOccasion` holidays for attendance
math.
- **Preferred:** a narrow internal read endpoint in Core (e.g. `GET /internal/hr-principals/:id`,
  tenant-checked, service-token protected), called only through `HrIdentityGateway`.
- **Not allowed:** HR importing Core `PrismaService`; HR reading `core_db` directly; the
  browser sending `tenantId`/`userId`/`managerId`/role (repeats the §8/§17 doctrine).
- **Holidays:** if the boundary makes `CalendarOccasion` unreadable cross-DB, either sync a
  minimal holiday projection into `hr_db` on the §11 worker pattern, or keep holiday reads
  in-process. → **Open question Q2.**

---

## 7. Core `User` vs HR `Employee` — the boundary, concretely

Core `User` keeps **only** what `prisma/core/schema.prisma:2510+` / the identity domain owns:
`id`, `tenantId`, email/name, `tokenVersion`, role links, and the bounded directory fields
already present (`department`, `jobTitle`, `extension`, `managerId` with the
`User_manager_not_self` CHECK and a cross-tenant manager pointer that is never resolved).

**Forbidden (§2, hard):** no `personnelCode`, `employmentType`, `contractFrom/To`,
`baseSalary`, `shiftId`, `nationalId`, `birthDate`, `costCenter`, `hrStatus` on `User`.

**HR-owned (`hr_db`):**
```
Employee            id, tenantId, coreUserId (opaque, unique per tenant), displayName snapshot,
                    personnelCode (server-numbered §10), orgUnitId, positionId, employmentType,
                    hrStatus, managerCoreUserId, shiftPattern, createdAtBy, …
OrganizationUnit    tree within tenant (parent self-ref + no-cycle CHECK, mirroring the
                    User_manager_not_self style guard)
Position / Grade    labels + costing bucket
AttendanceRecord    employeeId, dateKey (Jalali y/m/d), checkInAt, checkOutAt, canonical
                    timestamps + tz, lateMinutes/lunchMinutes DERIVED not stored,
                    source (DEVICE|WEB|MANUAL), manual-adjust audit
LeaveRequest        type, from/to, halfDay, reason(sanitized), balanceDebit, workflow status
LeaveBalance        (employeeId, jalaliYear) entitlement/used/requested, UNIQUE guard
MissionRequest      destination, from/to, deliverable, approval
OvertimeRequest     from/to, hours DERIVED, approval
PersonnelTrafficDailyView (SQL view, not a table) for report B
```
Linking rule: `Employee.coreUserId` is validated at write time by `HrIdentityGateway`
(same tenant, exists) and stored as a plain string. **Renaming a Core user must not break
HR** because HR stores a display snapshot plus the id; **deleting a Core user must not
cascade away HR history**, which is exactly what a separate DB gives us.

---

## 8. Jalali date handling (brief §7) — reuse, never re-implement

Store **canonical instants + a Jalali day key**; convert only at the edges.
1. `AttendanceRecord.checkInAt` etc. are `DateTime` instants. Derive day-level fields with
   `instantToJalaliDate` / `instantToZonedTime` under `APP_TIME_ZONE` (`calendar/jalali.util.ts`).
2. Persist `dateKey` (`yyyy/m/d`) as the join/group key so monthly and per-day reports are a
   plain `GROUP BY`, not a client-side reduction (that is what Lovable's `jKey` does in JS —
   it must become SQL).
3. Convert incoming Jalali filters to instants with `parseJalaliDateKey` /
   `jalaliWallTimeToInstant`; return strings from the API via `instantToJalaliDate` +
   `JALALI_MONTHS`, so the browser never runs `Intl …ca-persian` math (Lovable's
   `todayJalali`, `faToEn`, `_rebase` all disappear).
4. Persian-digit rendering (`toPersianDigits`) is a **presentation-only** helper in
   `apps/web`; the API always exchanges ASCII digits + ISO/Jalali keys.
5. Holidays/weekend model comes from `CalendarOccasion`, never a hard-coded list of
   Saturdays/Fridays — Lovable's `lastDay = pm <= 6 ? 31 : pm <= 11 ? 30 : 29` month-length
   rule is fine for the *calendar* but must not be used to decide working days.
6. Guard: reject ranges where `from > to`, ranges crossing the 24-month bound, and any
   request whose day-key fails `parseJalaliDateKey`.

---

## 9. RBAC & tenant isolation for HR

Anchor: `src/auth/rbac/constants/permissions.ts` — three parallel structures must stay in
sync (`Permissions` object @7, `PermissionToDomain` map @213, `PermissionsByDomain` @286),
plus the Prisma `PermissionDomain` enum in Core and a seed migration
(`…_seed_*_permission_grants.sql`, e.g. `20260912120600`).

**Proposed HR permission set** (mirroring the Phase 50 rationale: gate *administrative*
capability, never personal workflow):
```
hr.employee.manage          create/update/terminate Employee + org units (admin)
hr.attendance.read.self     own attendance  — personal, normally granted broadly
hr.attendance.read.team     reporting-subtree read (derived from directory, not client input)
hr.attendance.manage        manual punch adjustment / corrections (audited)
hr.leave.request            personal, ungated like letter drafting
hr.leave.approve            approve/reject for the reporting subtree
hr.leave.manage             tenant-wide leave administration
hr.report.read              tenant-wide traffic report + export
hr.report.read.team         team-scoped report
```
Rules fixed by existing doctrine:
- `RequestContextService.get()` is the ONLY source of `userId`/`tenantId`; no route accepts
  either from the body/query.
- Tenant is a snapshot column on every HR row, never projected to the client (Survey/Ticket
  convention, restated at `schema.prisma:2519-2520`).
- Team scope is **derived** from `managerCoreUserId`/org tree server-side; a `managerId`
  query param is a *filter to intersect with*, never an authority grant.
- Self-service endpoints must not be gated behind an HR permission that ordinary employees
  lack — the Phase 50 comment (`permissions.ts:164-171`) explains why: a `*.use` string
  gates an empty set and implies a participation model we are not building.
- `PermissionDomain.HR` is a **new enum member + Core seed migration** — the one accepted
  Core residue (§6b). Admin UI grouping (`PermissionsByDomain`) must include it.

---

## 10. Server-side numbering & status machine (mirroring letters)

- `Employee.personnelCode` follows `LetterNumberCounter`'s proven shape: a
  `(tenantId, year)`-keyed counter row mutated by atomic
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`, allocation **inside** the creating
  transaction so a rolled-back create never burns a code. Never client-supplied, never random.
- Request documents (leave/mission/overtime) get their own per-tenant, per-Jalali-year
  counters (`LeaveRequestNumberCounter`, …) or one shared `HrDocumentCounter` with a `kind`
  column — decide once in 51-HR-1 and keep it uniform.
- Status machines belong in **pure functions with a pinned unit spec**, exactly like
  `letter-status.util.ts`:
  `hr-request-status.util.ts` with `LEAVE_STATUS_TRANSITIONS` (`DRAFT → PENDING →
  APPROVED | REJECTED | CANCELLED`), `canTransitionLeaveStatus`, `isLeaveEditable`,
  `isLeaveStatusMutable`. Store derived timestamps (`submittedAt`, `decidedAt`, `decidedBy`,
  `cancelledAt`) and add a DB `CHECK` that ties status ↔ timestamps ↔ decision fields, in the
  *same* migration that adds the column — the exact discipline the Letter table documents
  (`migration.sql:306-314`: "only a sent letter carries a number, and only DRAFT/
  READY_TO_SEND rows carry none").
- **Do not** repeat the §11 mistake: when a status value is added later, the enum, the CHECK,
  the transition table, the "sendable/actionable" allowlist and the frontend union must all
  move together, or the new state becomes unreachable. Write it into the HR status util header
  as a maintenance contract.

---

## 11. Correspondence scheduled-send — confirmed defects & required fix

> This is a **prerequisite**, not part of HR. The brief's §21 identified one symptom; the
> audit found **ten** distinct defects across five layers, one of which makes the feature
> impossible at the database level.

### The exact defect chain (all line-verified)

**D1 — DB CHECK makes `SCHEDULED` unwritable (blocking, worst).**
`20260912120000_add_correspondence/migration.sql:309-314` defines
`Letter_status_timestamps` with exactly four branches — DRAFT / READY_TO_SEND / SENT /
CANCELLED — and none matches `SCHEDULED`. `20260914130000_add_scheduled_send/migration.sql`
only runs `ALTER TYPE "LetterStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED'` (+ adds the column);
it never drops/recreates the CHECK. Verified by grepping **all 28** core migrations: only the
base one ever mentions `Letter_status_timestamps`. Adding an enum value does **not** relax a
CHECK, so `UPDATE "Letter" SET status='SCHEDULED'` violates the constraint → SQLSTATE 23514.
**The schedule action therefore fails at write time**, before the worker is ever reached —
worse than the brief's §21 describes.

**D2 — Incomplete migration.** `ADD VALUE` shipped without the CHECK update D1 requires.
(Related subtlety: a newly added enum value cannot be *used* in the same transaction that adds
it, so the correct migration adds the value and recreates the constraint in separate steps.)

**D3 — Column type drift.** `add_scheduled_send:7` creates `"scheduledAt" TIMESTAMPTZ`, but
`schema.prisma:2640` declares `scheduledAt DateTime?` with no `@db.Timestamptz(3)` — Prisma
maps that to `timestamp(3)`, like every other column in the table (`readyAt`/`sentAt` are
`TIMESTAMP(3)` in the base migration). Database and schema disagree, so a future
`prisma migrate dev` emits a spurious ALTER to "fix" the drift.

**D4 — The worker can never send.** `processScheduledSends()` (`:424-446`) selects
`status: 'SCHEDULED', scheduledAt: { lte: now }` (`:428-429`), then calls `sendDraft()` (`:439`).
But `sendDraft()`'s guard (`:915`) filters `status: { in: ['DRAFT','READY_TO_SEND'] }`, so the
SCHEDULED row is not found and it throws `NotFoundException` (`:927`) → caught and only
`console.warn`ed (`:442`). Once D1 is fixed, the letter stays SCHEDULED forever and warns
every tick.

**D5 — The allowlist contradicts the transition table.** `letter-status.util.ts:25` declares
`SCHEDULED: ['SENT','CANCELLED']` (the edge is legal), while `SENDABLE_LETTER_STATUSES`
(`:45`) is `['DRAFT','READY_TO_SEND']` and `isSendableLetterStatus()` (`:47`) therefore returns
false for SCHEDULED. `sendDraft` hardcodes the same two values instead of calling that helper —
two sources of truth for one rule.

**D6 — Dead code shows the intent existed.** `sendDraft`'s flip (`:998`) **does** include
`'SCHEDULED'` in its `status in` list and clears `scheduledAt` (`:1005`). That branch is
unreachable while D4/D5 hold — the send path was written for scheduled letters; only the
guard was never updated.

**D7 — Wrong tracking semantics.** Scheduling writes a tracking event with `type: 'SENT'`
(`:961`; the inline comment admits "recorded now; the actual delivery happens at scheduledAt").
The real send writes another `SENT` (`:1024`). A scheduled letter therefore gets **two** `SENT`
events, one false — and `LetterTrackingEventType` has no `SCHEDULED` member (`migration.sql:36`
= CREATED, SENT, VIEWED, READ, REFERRED, REFERRAL_ACTED, CLASSIFICATION_CHANGED, ARCHIVED,
UNARCHIVED), so "scheduled" cannot be recorded honestly at all.

**D8 — Worker is neither replica-safe nor bounded.** `onModuleInit` (`:448-452`) starts a bare
`setInterval(60_000)` with no `running`/`ticking` guard and no `unref()`; `processScheduledSends`
has **no `take()` and no tenant filter** → an unbounded cross-tenant scan every 60s **in every
replica**. The sanctioned reference is `reminder-dispatcher.service.ts`:
`REMINDER_TICK_MS`/`REMINDER_BATCH_SIZE` (`:50-53`), `running`+`ticking` (`:61-64`), `unref()`
(`:74-75`), `if (!this.running || this.ticking) return 0` (`:91`), `take: BATCH_SIZE` (`:101`),
and a conditional-UPDATE claim (`:133-138`) whose doc (`:30-46`) states the doctrine — a
concurrent worker's update matches zero rows, so correctness never depends on single-process
deployment. Note: the repo **does** sanction `setInterval` (`reminder-dispatcher.service.ts:16-21`
cites `AuditDispatcherService` as precedent) — the violation is the missing claim and bound,
not the timer.

**D9 — No index for the due-scan.** `Letter` declares `@@index([tenantId, senderId, …])`,
`@@index([tenantId, status, …])`, `@@index([tenantId, letterNumber])`, `@@index([senderId])`
(`schema.prisma:2672-2676`) but **nothing on `scheduledAt`**, and the `[tenantId, status, …]`
index leads with a column the query does not supply. Each tick therefore **sequential-scans the
entire `Letter` table, every 60s, per replica, indefinitely**.

**D10 — Worker impersonates the sender and fails silently.** `buildScopeFromUser(letter.senderId)`
(`:436`) reconstructs the sender's permission scope, so a CONFIDENTIAL scheduled letter whose
sender later loses `correspondence.confidential.manage` can never be dispatched — it warns
forever. Other failures (scope null → `continue`, `:437`) produce no audit row and no terminal
state, so nothing surfaces to an operator.

### Additional cross-layer omissions
- `schema.prisma:2527-2528` still documents the canonical status as "DRAFT / READY_TO_SEND /
  SENT / CANCELLED"; `letter-status.util.ts:7` repeats it. Both are stale after Phase 50+.
- Web: `apps/web/src/lib/correspondence-api.ts:14` `LetterStatus` union lacks `SCHEDULED`;
  `STATUS_LABELS` and `CorrBadges`' `STATUS_STYLES` have no `SCHEDULED` entry → a scheduled
  letter renders with an undefined label / fallback badge.
- `Letter.senderId` FK → `User(id) ON DELETE CASCADE` (`migration.sql:253`): deleting a Core
  user destroys their letters. Directly relevant to §7 — exactly the coupling HR must avoid by
  using an opaque `coreUserId` with no FK.
- No runtime evidence of D1 firing in the api logs, so this is **latent**: either no user has
  attempted a scheduled send on the running instance, or the row never reached the constraint.
  A live reproduction is in the §18 checklist.

### Required fix (one focused, tested change — before any HR code)

1. **New migration**, in order: `ALTER TYPE "LetterStatus" ADD VALUE IF NOT EXISTS 'SCHEDULED'`
   (already present, idempotent) in its own step → `DROP CONSTRAINT "Letter_status_timestamps"`
   → `ADD CONSTRAINT "Letter_status_timestamps" CHECK (…)` with a **`SCHEDULED` branch** pinning
   `scheduledAt IS NOT NULL AND readyAt IS NOT NULL AND sentAt IS NULL AND cancelledAt IS NULL`
   and stating the numbering policy (`letterNumber IS NULL`, because `:989-1004` allocates the
   number only in the send path) → resolve D3 by aligning `scheduledAt` to `TIMESTAMP(3)` **or**
   adding `@db.Timestamptz(3)` to the schema (pick one, in that same migration) → add the
   due-scan index: `CREATE INDEX "Letter_scheduled_due_idx" ON "Letter"("scheduledAt")
   WHERE "status" = 'SCHEDULED'`.
2. **Extend `LetterTrackingEventType` with `SCHEDULED`** and write `type: 'SCHEDULED'` when
   scheduling (`:961`), reserving `SENT` for real dispatch (`:1024`) — fixes D7.
3. **Let the send path accept a due scheduled letter.** Replace the hardcoded guard (`:915`)
   with the status-machine helper and extend `SENDABLE_LETTER_STATUSES` — or, cleaner, add a
   dedicated `dispatchScheduledLetter()` that asserts `status === 'SCHEDULED' &&
   scheduledAt <= now` and reuses the same atomic flip. One rule, one place.
4. **Rebuild the worker on the dispatcher pattern:** `running`/`ticking`, `unref()`,
   `take: BATCH_SIZE`, bounded and no longer unbounded across tenants, with an atomic claim so N
   replicas are safe. The existing flip already behaves as a claim — `flipped.count === 0`
   throws `ConflictException` (`:1011-1014`) inside the transaction, which also rolls back the
   `allocateNext` number. **Preserve that property**: do not move numbering ahead of the claim.
5. **Give permanent failures a terminal representation** (bounded retry counter + failed state,
   or at minimum an audit row) instead of an infinite `console.warn` loop — fixes D10.
6. **Move all four stale surfaces together:** `schema.prisma:2527`, `letter-status.util.ts:7`,
   web `LetterStatus`, `STATUS_LABELS`, `CorrBadges`.
7. **Tests:** schedule→send happy path; a due scheduled letter yields exactly one `SENT` event
   and exactly one number; two workers ticking the same row send exactly once (mirroring
   reminder-dispatcher's "tick twice, expect 0"); invalid transitions (SENT→SCHEDULED,
   CANCELLED→anything); and a DB-level assertion that a SCHEDULED row with `scheduledAt IS NULL`
   now *fails* the CHECK while a valid one passes.

---

## 12. Migrations, git hygiene and the phase gate

Verified state (all `git`-checked at `HEAD a38ba77`):

| Artifact | Status | Read |
|---|---|---|
| `apps/api/prisma/schema.prisma` (14.9 KB, `provider="postgresql"`, `url=env("DATABASE_URL")`, generator with **no `output`**) | tracked | **Legacy pre-split schema.** `package.json:28-34` generates only core/cms/observability. A bare `npx prisma generate` would target *this* file and overwrite the default client — a live footgun. |
| `apps/api/prisma/dev.db` (148 KB SQLite) + `dev.db-journal` (8.5 KB) | **tracked and NOT gitignored** (`git check-ignore` exit 1; `git ls-files` matches) | Dead binary in a PostgreSQL-only project, committed to the repo. |
| `apps/api/prisma/core/migration_diff.sql` (3.7 KB), `migration_diff2.sql` (3.2 KB), `our_migration.sql` (1.4 KB) | untracked (`??`) | Scratch SQL beside `schema.prisma`. Inert for Prisma (only `migrations/<ts>/migration.sql` is read) but looks authoritative to a human. |
| `apps/api/scripts/search-verify.sql`, `search-verify-generated.sql`, `search-verify-checks.sql` | untracked (`??`) | Scratch verification SQL. |
| `apps/api/prisma/core/schema.prisma` | **modified, uncommitted** (` M`) | The correspondence/scheduled-send schema edits are not committed. |
| `git status --porcelain` | **215 entries** | Phase 50/51 work is entirely in flight. |
| 28 core migrations, newest `20260914130000_add_scheduled_send` | — | Naming is `<timestamp>_<snake_case>`; the newest breaks the `YYYYMMDDHHMMSS` pattern used everywhere else. |

**Required before any HR migration is written:**
1. Commit or explicitly park the 215 in-flight entries. HR must not be authored on top of an
   uncommitted Correspondence change set, or a bad HR migration cannot be bisected.
2. Delete the scratch `*.sql` files (untracked, so this is safe and reversible).
3. Untrack `dev.db` / `dev.db-journal` and add `*.db`, `*.db-journal` to `.gitignore`.
4. Decide the fate of the legacy `prisma/schema.prisma`; at minimum never run
   `prisma generate` without an explicit `--schema`.
5. Adopt `YYYYMMDDHHMMSS_snake_case` for HR migrations and the evident
   **one-concern-per-migration** practice: `20260912120000_add_correspondence` →
   `20260912120500_add_correspondence_permission_domain` →
   `20260912120600_seed_correspondence_permission_grants` (table, then enum member, then seed).
   The single `add_scheduled_send` migration that skipped the CHECK is exactly what that
   discipline prevents (D1/D2).

---

## 13. Attendance / leave / mission / overtime — domain design

**Sources of truth.** `AttendanceRecord` is the only place punches live; leave, mission and
overtime are *requests* whose **approved** form suppresses or augments attendance for their
window. Derived day status is computed, never stored as a status string the UI trusts:
`present | late | absent | leave | mission | holiday | weekend`, resolved as
`holiday/weekend (CalendarOccasion) > approved leave > approved mission > punch-derived
(present|late) > absent`.

**Rules to pin (one test each):**
- Leave must not overlap another leave, nor exceed `LeaveBalance` for its Jalali year.
- Approving leave over existing punches must force an explicit adjustment (or flag the record)
  — never silently delete evidence.
- Mission suppresses `late`/`absent` **only** when it covers the whole day; a half-day mission
  leaves the remainder punch-derived.
- Overtime hours are computed from the record window minus the shift, never client-supplied.
- Weekend/holiday semantics come from `CalendarOccasion` + `APP_TIME_ZONE` (§8), so Jalali year
  boundaries are handled in one place.
- Manual adjustments are `MANUAL` source rows carrying actor + sanitized reason + audit event;
  never an in-place mutation of a `DEVICE` row.
- Balances are a `UNIQUE (employeeId, jalaliYear)` row mutated only inside the approval
  transaction, so concurrent double-approval cannot overdraw.

**Report B aggregation.** One SQL query per widget family over the filtered set (monthly hours,
late vs absent, leave composition, per-person totals, presence %), grouped by `dateKey`
(`yyyy/m`) — never by reducing table rows in React. Index the real predicates:
`(tenantId, dateKey)`, `(employeeId, dateKey)`, `(tenantId, status)`, `(orgUnitId, dateKey)`.

**Scheduling.** If HR needs a periodic job (e.g. nightly attendance materialisation for report
B), it must use the §11-fixed dispatcher pattern: bounded `take`, `ticking` guard, `unref()`,
atomic claim. Do not add a second bare `setInterval`.

---

## 14. Phase plan 51-HR-1 … 51-HR-5

**51-HR-0 (gate, not HR):** fix correspondence scheduled-send (§11) + resolve §12 hygiene.
Exit: migration applied, CHECK accepts SCHEDULED, exactly one SENT per scheduled send, two
replicas produce exactly one send, tests green, tree committed.

**51-HR-1 — Foundation.** `prisma/hr/schema.prisma` (Employee, OrganizationUnit, Position,
`HrDocumentCounter`, `LeaveBalance` skeleton), `HrPrismaModule/Service`, `HR_DATABASE_URL`,
generate/migrate scripts, `PermissionDomain.HR` + catalogue rows + seed migration, route
namespace `/api/hr/**`, document status-machine utils, and `HrIdentityGateway` (§6d) with its
first narrow Core read. Exit: a real employee list/detail round-trips through tenant-scoped,
permission-guarded endpoints.

**51-HR-2 — Attendance core.** `AttendanceRecord`, `dateKey` derivation via `jalali.util`, the
derived-status function + unit spec, device/manual ingest, self-service day view. Exit: derived
status matches a hand-computed fixture across a month including a holiday and a month boundary.

**51-HR-3 — Leave + Mission + Overtime.** Request/approve lifecycles, balance validation,
overlap rules, attendance interaction. Exit: approved leave suppresses absence; overdraw is
impossible under concurrent approval.

**51-HR-4 — Report B + exports.** Server-side filters, pagination, SQL aggregates, the shared
SVG chart primitive (§16-R3), server-side Excel. Exit: a 10k-row tenant export completes in
bounded time and memory; every displayed number traces to one named query.

**51-HR-5 — Frontend parity.** Screen A (attendance), then Screen B (traffic report), as
Aria-native pages under `/admin/hr/**` using `CoreStates` and the shared chart primitive;
minimal list/detail/request surfaces for C–F; sidebar entries. Exit: §3d parity checklist
satisfied in light **and** dark mode, with zero mock or hard-coded data.

---

## 15. Frontend & API inventory

### 15a. Frontend (targets, following existing conventions)

| Target | Path | Convention to follow |
|---|---|---|
| HR API client | `apps/web/src/lib/hr-api.ts` | `correspondence-api.ts` style: typed request/response, `core-http.ts` transport, `LetterStatus`-style union types re-exported for UI |
| Routes | `apps/web/src/app/admin/hr/attendance/page.tsx`, `…/report/page.tsx`, `…/leave/page.tsx`, `…/mission/page.tsx`, `…/overtime/page.tsx` | existing `app/admin/**` pages inherit `app/admin/layout.tsx` → `AdminShell` |
| Views | `apps/web/src/components/hr/HrAttendanceView.tsx`, `HrTrafficReportView.tsx`, `HrLeaveView.tsx`, `HrMissionView.tsx`, `HrOvertimeView.tsx` | `components/core/Core*View.tsx` naming and file shape |
| Shared HR primitives | `components/hr/HrChart.tsx`, `HrStatCard.tsx`, `HrStatusBadge.tsx`, `HrDateRangePresets.tsx` | `CoreWidgetCard.tsx`, `CoreDateChip.tsx` |
| States | use `components/core/CoreStates.tsx` | `CoreEmpty`/`CoreLoading`/`CoreError` |
| Jalali input | `components/core/CoreJalaliDatePicker.tsx` | already used by calendar/correspondence |
| Sidebar | `components/core/core-nav.ts` (+ `CoreSidebar.tsx`) | mirror the `Phase 50-LOVABLE-PARITY` correspondence tree (`:190-218`): a real expandable parent with child links, personal items ungated, administrative items gated |
| Permissions in UI | `components/core/useCorePermissions.ts` | gate *administrative* affordances only |

### 15b. Backend endpoints (proposed `/api/hr/**`)

```
Employees
  GET    /api/hr/employees                     list  (q, orgUnitId, status, page, pageSize≤200)
  GET    /api/hr/employees/:id                 detail
  POST   /api/hr/employees                     create  (code allocated server-side, §10)
  PATCH  /api/hr/employees/:id                 update  (no code change)
  POST   /api/hr/employees/:id/terminate       terminate (reason sanitized, audited)
  GET    /api/hr/employees/me                  self profile
Org
  GET    /api/hr/org-units                     tree (bounded depth)
  POST   /api/hr/org-units                     admin
  PATCH  /api/hr/org-units/:id                 admin (cycle-safe)
Attendance
  GET    /api/hr/attendance/me                 screen A: day rows + derived status (from,to)
  GET    /api/hr/attendance/me/summary         screen A: 2 leave cards + 4 stat tiles
  GET    /api/hr/attendance/me/charts          screen A: 3 chart series (monthly buckets)
  GET    /api/hr/attendance                     screen B: filtered, paged day rows
  GET    /api/hr/attendance/summary             screen B: tiles
  GET    /api/hr/attendance/analytics           screen B: analytics aggregates
  POST   /api/hr/attendance/punch               self punch-in/out
  PATCH  /api/hr/attendance/:id                 manual adjustment (source=MANUAL, audited)
Leave / Mission / Overtime
  GET|POST       /api/hr/leave-requests         list (own | team | tenant by permission) / submit
  POST           /api/hr/leave-requests/:id/approve | /reject | /cancel
  GET            /api/hr/leave-balances/me      balances (or :employeeId when authorized)
  GET|POST       /api/hr/mission-requests       + /:id/approve | /reject
  GET|POST       /api/hr/overtime-requests      + /:id/approve | /reject
Exports
  GET    /api/hr/exports/attendance             screen A export (current filters)
  GET    /api/hr/exports/traffic-report         screen B export (current filters)
```
Cross-cutting rules for every route: `RequestContextService` identity; tenant from context only;
permission guard per operation; bounded `pageSize`; deterministic `orderBy` with an id tiebreak;
server-side Jalali range parsing via `jalali.util`; audit on every mutation; exports share the
screen's filter parser so the two can never diverge.
---

## 16. Risks, dependency decisions and open questions

### R1 — HR↔Core identity coupling (HIGH)
If HR is built in `hr_db` with an opaque `coreUserId` (§6c/§6d), every list/table needs a
name/department resolution. Naively that becomes N+1 `HrIdentityGateway` calls per page.
**Mitigation:** batch resolution (`GET /internal/hr-principals?ids=…`, capped) + denormalized
display snapshot stored on `Employee`; HR must render from its own snapshot for reads and
refresh the snapshot on write/sync. **Requires sign-off: Q1.**

### R2 — Holiday/calendar boundary (MEDIUM)
Attendance correctness depends on `CalendarOccasion`, which lives in `core_db`. Options: sync a
minimal projection into `hr_db` (needs a worker → §11 pattern) or keep calendar reads
in-process. **Open: Q2.**

### R3 — Charts and Excel dependencies (MEDIUM → de-risked)
- **Charts:** `apps/web` has **no** `recharts`. But the Lovable reference itself already builds
  screen B's analytics with **raw SVG** (`PersonnelTrafficReportPage.tsx:1331-1345, 1555-1599`).
  **Recommendation: build one shared Aria `HrChart` SVG primitive** (line/area/bar/donut) with
  RTL axis handling and `tabular-nums` labels, instead of adding a charting dependency for two
  screens. Screen A's three charts then use the same primitive.
- **Excel:** `exceljs` is absent from both apps. **Recommendation:** generate `.xlsx`
  server-side only if a real dependency is approved; otherwise export **UTF-8 CSV with a BOM**
  (Excel opens it correctly, including Persian text) from a bounded, authorized SQL query. Do not
  reproduce Lovable's client-side workbook build — it cannot exceed the browser's row limits and
  leaks the full dataset to the client. **Open: Q3.**

### R4 — Two different "surveys" (LOW, product)
`hr-survey` is a sidebar label only, while Core already ships a full Surveys platform.
Forking it would duplicate an engine and fragment results. **Recommendation:** HR links to the
existing Surveys module with an employee audience segment. **Open: Q4.**

### R5 — Dark mode (LOW)
Lovable is light-only; Aria ships dark. HR must be verified in both, using existing tokens. No
new colors may be introduced for badges/charts outside the existing palette.

### R6 — Team-scope derivation (MEDIUM)
"Manager sees their team" requires an org/manpower source of truth. Two candidates exist (Core
`User.managerId` vs HR's own `OrganizationUnit`/`managerCoreUserId`). Using both creates a
split brain. **Recommendation:** HR owns org structure for reporting; Core's `managerId` stays a
directory convenience and is never the authority for HR access. **Open: Q5.**

### R7 — 215 uncommitted entries (HIGH, process)
HR cannot be safely layered on an uncommitted change set (§12). Resolve before 51-HR-1.

### R8 — Coverage of screens C–F (MEDIUM, scope)
Four of six HR surfaces have **no** reference UI. Budget must be explicit that their UX is being
*designed*, not reproduced, and must not be silently dropped from acceptance.

### Open questions requiring a decision (blocking 51-HR-1)
- **Q1.** Accept Option B (§6b) with a documented `PermissionDomain.HR` + catalogue residue in
  Core, and no FK from `hr_db` to `core_db`?
- **Q2.** Holidays: sync projection into `hr_db`, or in-process calendar read?
- **Q3.** Export format: server-side XLSX (new dependency) or BOM CSV?
- **Q4.** `نظرسنجی کارکنان`: segment the existing Surveys platform, or build HR-owned?
- **Q5.** Team scope authority: HR org tree, Core `managerId`, or a defined merge?

---

## 17. Implementation brief (what to build, in order)

**Step 0 — gate (no HR code).** Execute §11 (7 items + migration) and §12 (5 hygiene items).
Nothing else starts until the scheduled-send tests pass and the tree is committed.

**Step 1 — data model.** Author `prisma/hr/schema.prisma` with §7's entities, §13's rules and
§10's counters. Every table: `tenantId` snapshot column, canonical timestamps, `createdAt`/
`updatedAt`, explicit indexes for the real predicates. Status columns get a matching DB `CHECK`
**in the same migration that introduces them** (§10).

**Step 2 — infrastructure.** `hr-prisma.{module,service}.ts` (copy `cms-prisma.*` exactly),
`HR_DATABASE_URL` optional in `env.validation.ts`, `prisma:generate:hr` / `prisma:migrate:hr`
scripts, and register `HrModule` in `AppModule` only (§6b). No Core table, no Core import.

**Step 3 — authorization.** Add `PermissionDomain.HR`, the `Permissions` entries, the
`PermissionToDomain` and `PermissionsByDomain` entries, plus a seed migration granting the
administrative ones to SUPER_ADMIN/ADMIN — mirroring the three-migration correspondence
sequence (§12.5).

**Step 4 — services.** Tenant- and permission-scoped services only; identity exclusively from
`RequestContextService`; every mutation writes an audit event; free text through the allowlist
sanitizer; numbering through the atomic counter inside the creating transaction.

**Step 5 — API.** `/api/hr/**` with DTO validation, bounded pagination, server-side filters and
aggregates. No endpoint accepts `tenantId`, `userId`, role, org path or a computed number.

**Step 6 — frontend.** `apps/web/src/lib/hr-api.ts` (typed, like `correspondence-api.ts`),
`apps/web/src/app/admin/hr/**` pages under the existing admin layout, and
`apps/web/src/components/hr/Hr*View.tsx` following the `Core*View.tsx` convention. Add the HR
group to `components/core/core-nav.ts` **mirroring the Lovable HR tree**, following the
`Phase 50-LOVABLE-PARITY` convention already used for the correspondence tree
(`core-nav.ts:190-218`), and apply the same deliberate gating doctrine documented there
(personal workflow ungated; administrative capability gated). Use `CoreStates` for
loading/empty/error, `CoreJalaliDatePicker` for ranges, and the shared `HrChart` primitive
(§16-R3). **Zero hard-coded rows, zero `setTimeout` loading, zero client-side filtering.**

**Step 7 — verification.** Unit specs for status machines, derived attendance status and balance
math; integration tests for tenant isolation and permission denial; a DB-level test for each new
CHECK; a concurrency test for the approval and numbering paths.

---

## 18. Acceptance criteria

1. **Core purity:** `core-main.ts` boots and serves every Core route with **zero** HR tables,
   zero HR imports and zero HR enums outside the permission catalogue.
2. **No HR fields on Core `User`** — the `prisma/core/schema.prisma` diff contains no HR column.
3. **Tenant isolation:** with a foreign-tenant id in every path/query position, HR returns 404,
   never another tenant's row (correspondence's isolation tests are the template).
4. **Identity is server-derived:** no HR route accepts `tenantId`/`userId`/role; a forged body
   field is ignored and audited.
5. **Pagination is bounded:** an oversized `pageSize` is clamped; unbounded list endpoints do
   not exist.
6. **Server-side aggregation:** no page computes a displayed statistic from a full client-side
   row set.
7. **Visual parity (§3d)** for screens A and B in light **and** dark mode.
8. **No mock data:** no literal employee/attendance arrays, no fake latency, no hard-coded
   statistics anywhere in `apps/web`.
9. **Exports:** identical authorization and filters as the screen; bounded rows; no private
   fields; format per Q3.
10. **Auditability:** create/approve/reject/adjust mutate an audit trail with actor, tenant,
    request id and reason.
11. **Scheduled-send (§11):** a letter can be scheduled; exactly one `SENT` event exists after
    dispatch; two worker replicas produce exactly one send; the CHECK rejects a SCHEDULED row
    with a null `scheduledAt`; a failed dispatch is visible without log-scraping.
12. **Docs move together:** `schema.prisma` comments, status-util headers, web unions/labels/
    badges — the four surfaces that drifted for `SCHEDULED`.

---

## 19. Prohibited (explicitly)

- **No HR tables, HR models or HR columns in `core_db` or Core's `schema.prisma`.**
- **No HR fields on Core `User`** (personnel code, employment type, contract dates, salary,
  shift, national id, birth date, cost center, HR status).
- **No import of `HRModule` from Core**, and no HR semantics in Core domain enums beyond the
  `PermissionDomain.HR` label plus its seeded permissions.
- **No FK from `hr_db` to `core_db`**, and no reliance on Core's `ON DELETE CASCADE` to clean HR
  rows (contrast `Letter.senderId`, `migration.sql:253`).
- No `tenantId`/`userId`/role/manager/org-path/document-number accepted from the browser.
- No Persian-digit or Jalali conversion logic re-implemented in the web layer.
- No `setInterval` background work without the claim/bound/guard pattern (§11 D8, §13).
- No adding a `SCHEDULED`-style enum value without moving enum + CHECK + transition table +
  action allowlist + frontend union together (§10, §11).
- No client-side dataset export, no unbounded query, no per-row N+1 identity lookup.
- No new dependency (charting, Excel) without an explicit decision (§16 Q3 / R3).
- No HR feature work before the scheduled-send fix and the §12 hygiene gate land.

---

## 20. First actions (this week, in order)

1. **Reproduce D1** against the dev database: attempt to set a letter to `SCHEDULED` and capture
   the 23514 violation. This converts the latent defect into a demonstrated one.
2. **Write the §11 migration** (enum + CHECK recreate + type alignment + partial index) and the
   `LetterTrackingEventType.SCHEDULED` member.
3. **Fix `sendDraft`'s guard** and extend `SENDABLE_LETTER_STATUSES`; add
   `dispatchScheduledLetter()` if that reads more honestly than broadening `sendDraft`.
4. **Rebuild the worker** on the `ReminderDispatcherService` shape and add the §11.7 tests.
5. **Close §12:** commit the in-flight set, delete scratch `.sql`, untrack `dev.db`, add ignores.
6. **Collect Q1–Q5 decisions** (§16) before writing a single HR migration.

---

## Appendix — evidence index

| Claim | Where |
|---|---|
| 3 Prisma projects + scripts | `prisma/{core,cms,observability}/schema.prisma`; `apps/api/package.json:28-34` |
| A module owns its own client | `src/database/cms-prisma.service.ts:2-7`; `cms-prisma.module.ts` |
| Domain module namespace | `src/modules/cms/{blog,media,common}/**` |
| Correspondence lives in Core | `src/core-app.module.ts:22`; `src/app.module.ts:25-26,65-66`; `prisma/core/schema.prisma:2510+` |
| Core independently bootable | `core-app.module.ts:40-49`; `cms-app.module.ts:21-38` |
| Platform never imports a business module | `module-platform.module.ts` header; `ModuleClient` exported, registry not |
| Permission catalogue shape | `auth/rbac/constants/permissions.ts:7,162-196,213,261-263,286,349-352` |
| Single web API origin | `apps/web/src/lib/constants.ts:2` |
| Jalali helpers | `src/calendar/jalali.util.ts` |
| Reference worker | `src/calendar/reminder-dispatcher.service.ts:16-21,30-46,50-53,61-64,71-76,90-103,127-138` |
| Scheduled-send defects D1–D10 | `correspondence.service.ts:424-446,448-452,915,927,940-966,961,985-1010,998,1005,1011-1014,1024`; `letter-status.util.ts:7,25,45,47`; `20260912120000_add_correspondence/migration.sql:36,253,309-314`; `20260914130000_add_scheduled_send/migration.sql:4,7`; `schema.prisma:2527-2528,2640,2672-2676`; `apps/web/src/lib/correspondence-api.ts:14` |
| Lovable routing (2 of 6 HR screens) | `lovable/src/routes/index.tsx:19-20,146-149` |
| Lovable sidebar HR group | `lovable/src/components/AppSidebar.tsx` |
| Screen A details | `lovable/src/components/PersonalAttendancePage.tsx:23,38,69,78,87,93,98-102,130,239,247,320,351,386-389,393,455-462,470-513,520-540` |
| Screen B details | `lovable/src/components/PersonnelTrafficReportPage.tsx:8,85,98,115,193,257,392,416-467,510-525,543-589,604,615-645,661,698,751,854,1005,1290-1305,1331-1345,1391,1468-1469,1524,1535-1536,1555-1599` |
| Design-token parity | `apps/web/src/styles/globals.css:17,47,70,80,82,85,109,133,340` vs `lovable/src/styles.css:8,44-70,104-109,138-154` |
| Sidebar/nav convention | `apps/web/src/components/core/core-nav.ts:190-218`; `CoreSidebar.tsx`; `components/admin/AdminShell.tsx`; `app/admin/layout.tsx` |
| Git/migration hygiene | `git status --porcelain` (215); `git ls-files apps/api/prisma/dev.db`; `git check-ignore` → exit 1; `prisma/{schema.prisma,dev.db,dev.db-journal,migration_diff.sql,migration_diff2.sql,our_migration.sql}`; `apps/api/scripts/search-verify*.sql` |
