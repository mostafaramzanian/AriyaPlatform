import { Permissions } from '../auth/rbac/constants/permissions';

/**
 * Phase 49K: server-side mirror of the Core navigation tree.
 *
 * WHY THIS FILE DUPLICATES `apps/web/src/components/core/core-nav.ts`
 * ------------------------------------------------------------------
 * `navFavorites` and `navRecent` hold navigation hrefs, and the two rules that make
 * them safe cannot be enforced anywhere else:
 *
 *  - an href must be one the shell can actually navigate to. A database CHECK can
 *    count the list (`UserPreference_navFavorites_bounded`) but cannot know the
 *    navigation tree, and the browser cannot be trusted to police what it submits.
 *  - an href must be one the CALLER may open. That is an RBAC question, and RBAC
 *    lives here.
 *
 * The API cannot import from `apps/web`, so the allowlist is restated. This is the
 * same deliberate duplication `search-routes.ts` (49J) already carries for search
 * result targets, and it is kept honest the same way: every entry below corresponds
 * to a real page in `apps/web/src/app`, and every `permission` is the string
 * `core-nav.ts` declares for that item — not a stricter one invented here.
 *
 * WHEN A NAV ITEM IS ADDED TO `core-nav.ts` AND NOT HERE, favouriting it is refused
 * rather than silently accepted. That failure is deliberate and visible: a stored
 * href nothing can resolve is worse than a rejected write.
 */

export interface NavTarget {
  /** Exact href, as declared in `core-nav.ts`. Never a prefix or a pattern. */
  href: string;
  /**
   * Permission the shell hides the item behind, or undefined when the item is
   * visible to every authenticated user. Mirrors `CoreNavItem.permission`.
   *
   * Hiding a link is presentation-only in the shell; here it additionally decides
   * whether the href may be STORED and whether a stored one is still RETURNED.
   */
  permission?: string;
  /**
   * Phase KPI-RUNTIME: an ALTERNATIVE gate — the href may be stored when the caller holds ANY
   * ONE of these permissions. Mirrors `CoreNavItem.anyOfPermissions`.
   *
   * WHY IT EXISTS HERE AND NOT ONLY ON THE CLIENT. A stored favourite is re-filtered against
   * live RBAC on every READ, so a gate the shell applies but this file does not would let a
   * user pin `/admin/kpis`, have the grant revoked, and keep receiving the href back — a row
   * pointing at a page that now refuses them. Stating the same union here makes both layers
   * answer the same question, exactly as the single `permission` field already does.
   */
  anyOfPermissions?: readonly string[];
}

/**
 * Every favouritable navigation target, in `core-nav.ts` declaration order.
 *
 * The three gated entries carry the permission the backend genuinely enforces on
 * the page's own routes: `admin.users.read` on `GET /users/directory` (49D-1),
 * `blog.read` on the CMS blog surface, `admin.ai.read` on the two AI config reads
 * (49J-0). `support` and `surveys` are ungated on purpose — `core-nav.ts` explains
 * why at length, and repeating a stricter rule here would hide a page from users
 * the backend admits.
 */
export const NAV_TARGETS: readonly NavTarget[] = [
  { href: '/admin' },
  // Phase MANAGEMENT-DASHBOARD-V1. The union of the four V1 source remits, mirroring the
  // `anyOfPermissions` on the shell row so the stored favourite and the rail answer the
  // same question.
  {
    href: '/admin/management',
    anyOfPermissions: [
      Permissions.PRODUCTION_BOM_READ,
      Permissions.COMMERCE_READ,
      Permissions.FINANCIAL_CHECK_READ,
      Permissions.HR_MISSION_APPROVE,
    ],
  },
  { href: '/admin/profile' },
  { href: '/admin/notifications' },
  { href: '/admin/messages' },
  { href: '/admin/calendar' },
  { href: '/admin/directory', permission: Permissions.ADMIN_USERS_READ },
  { href: '/admin/blog', permission: Permissions.BLOG_READ },
  { href: '/admin/support' },
  { href: '/admin/surveys' },
  { href: '/admin/ai', permission: Permissions.ADMIN_AI_READ },
  // Phase 49L. Gated on the read permission the integration controller enforces, and
  // seeded in core_db — so a favourite pinned by an administrator stops resolving the
  // moment that grant is revoked, without an error and without a cleanup migration.
  { href: '/admin/integrations', permission: Permissions.ADMIN_INTEGRATIONS_READ },
  // Phase 49M. Same rule: gated on the read permission `ModuleRegistryController` enforces,
  // seeded by 20260905120500_seed_module_permission_grants. ONE entry for the registry page —
  // there is deliberately no per-module href, because a nav target that depends on database
  // rows could not be validated by an allowlist at all.
  { href: '/admin/modules', permission: Permissions.ADMIN_MODULES_READ },
  // Phase 49M-2. Same rule again: gated on `admin.observability.read`, the permission
  // `ObservabilityController` enforces, seeded by
  // 20260905160000_seed_observability_permission_grants.
  //
  // IT IS FAVOURITABLE BUT NOT RECORDABLE — see RECENT_EXCLUDED_PREFIXES below, which now
  // has its first real occupant. A favourite is an explicit act by the person pinning it; a
  // "recent" entry is written automatically by the visitor's browser, and for a page that
  // displays the audit trail that would create a second, unaudited record of who read it.
  { href: '/admin/observability', permission: Permissions.ADMIN_OBSERVABILITY_READ },
  // Phase 50. Official Correspondence — the personal workflow is ungated by design
  // (see permissions.ts: drafting, sending, receiving, referring and archiving into
  // one's own folders are ordinary authenticated-user capabilities bounded by
  // ownership/recipient edges and tenant scope inside CorrespondenceService, exactly
  // as 49H treated survey participation). The correspondence.* permissions gate
  // tenant-wide and confidential operations inside the pages, never the entry.
  // Dynamic letter routes (/admin/correspondence/:id, /new/:draftId) are deliberately
  // NOT here — an allowlist target must be exact and database-independent, so letter
  // views stay unrecordable and un-favouritable, matching every other detail page.
  { href: '/admin/correspondence' },
  { href: '/admin/correspondence/new' },
  { href: '/admin/correspondence/drafts' },
  { href: '/admin/correspondence/sent' },
  { href: '/admin/correspondence/search' },
  { href: '/admin/correspondence/archive' },
  // Phase 51-HR-2. Human Resources: one entry per route the rail declares, each gated on
  // the read permission its OWN controller enforces — `hr.employees.read` on
  // GET /hr/employees, `hr.organization.read` on GET /hr/organization/summary,
  // `hr.positions.read` on GET /hr/positions — and seeded in core_db by
  // 20260916100100_seed_hr_permission_grants. Same rule as 49L/49M: a favourite pinned by an
  // HR user stops resolving the moment that grant is revoked, without an error and without
  // a cleanup migration. The employee DETAIL route (`/admin/hr/employees/:id`) is
  // deliberately absent, exactly like every other detail page — an allowlist target must be
  // exact and database-independent, so it stays unrecordable and un-favouritable.
  { href: '/admin/hr', permission: Permissions.HR_ORGANIZATION_READ },
  { href: '/admin/hr/employees', permission: Permissions.HR_EMPLOYEES_READ },
  { href: '/admin/hr/organization', permission: Permissions.HR_ORGANIZATION_READ },
  { href: '/admin/hr/positions', permission: Permissions.HR_POSITIONS_READ },
  // Phase 51-HR-2E. The attendance register, gated on `hr.attendance.read` — the read
  // `AttendanceController.list` enforces, seeded in core_db by
  // 20260918130000_seed_hr_attendance_permission_grants. `hr.attendance.manage` is
  // deliberately not used: a READ is what entitles a user to open the page, exactly as on
  // the three entries above. ONE entry, because the register has one exact route — a row's
  // own id is never a nav target (an allowlist cannot hold a database id).
  { href: '/admin/hr/attendance', permission: Permissions.HR_ATTENDANCE_READ },
  // Phase 51-HR-2F. The personnel traffic report. ONE more entry, on the SAME read the register
  // is gated on (`hr.attendance.read`), because the report is that same endpoint read with a
  // bounded window: this phase added a screen, not an API route. A second read would have made
  // a favourite stop resolving for a user who can still read the register.
  { href: '/admin/hr/traffic-report', permission: Permissions.HR_ATTENDANCE_READ },
  // Phase 51-HR-3A. The leave register. Gated on `hr.leave.read` — the read BOTH leave
  // controllers enforce (`LeaveRequestsController.list` and `LeaveTypesController.list`) and the
  // read `20260919120000_seed_hr_leave_permission_grants` seeds, so the gate is real rather than
  // aspirational. `hr.leave.manage` is deliberately not used: a READ is what entitles a user to
  // open the page, and the register's own card writes nothing.
  //
  // ONE entry. The tenant's leave CATALOGUE (`/hr/leave-types`) has no route of its own — it is
  // rendered inside the register — so the allowlist has nothing further to declare, and a
  // request's id is never a nav target for the same reason an employee's is not.
  { href: '/admin/hr/leave', permission: Permissions.HR_LEAVE_READ },
  // Phase 54-I. The leave-policy CONFIGURATION and simulation surface. Gated on
  // `hr.leave.policy` — the grant the simulate route, version authoring and publish all enforce
  // (see `leave-policies.controller.ts`). DIFFERENT from the row above on purpose: the register
  // asks for a READ, while this surface exists to exercise configuration authority, so a
  // favourite pinned by a read-only operator would resolve to a page they cannot use.
  //
  // ONE entry, and it is the ENTRY surface rather than a directory. There is no
  // `GET /hr/leave-policies` to list from, so the page asks "which policy governs this leave type
  // on this day?" and reaches the per-policy route with the id that comes back. A per-policy href
  // is therefore NEVER a nav target — it embeds a database id, which an allowlist entry must not,
  // for the same reason `/admin/hr/employees/:id` is absent.
  { href: '/admin/hr/leave-policies', permission: Permissions.HR_LEAVE_POLICY },
  // Phase 55. Human Resources — Mission. THREE entries, one per route the rail declares, and the
  // three do NOT share a gate: each one asks for the grant ITS OWN screen consults.
  //
  //   * the register answers to `hr.mission.read` — the read `MissionController.list` enforces and
  //     the read `HrMissionView` itself names in its refusal sentence;
  //   * the approval queue answers to `hr.mission.approve` — the read `MissionController.pending`
  //     enforces. NOT `hr.mission.read`: `HrMissionApprovalView` states that it deliberately does
  //     not consult that grant, and a queue an approver cannot decide from is not a useful favourite;
  //   * the configuration surface answers to `hr.mission.policy` — the grant every
  //     `policy-versions` route enforces. NOT a read, for the reason `/admin/hr/leave-policies`
  //     above gives: the surface exists to exercise configuration authority, so a favourite pinned
  //     by a read-only operator would resolve to a page whose every action is refused.
  //
  // `hr.mission.manage` is deliberately absent: it gates the writes INSIDE the register, and a
  // manage grant is not what entitles anybody to open a page — the same rule the HR rows above
  // follow. All four strings are seeded in core_db by
  // 20260923131000_seed_hr_mission_permission_grant, so these gates are real rather than
  // aspirational.
  //
  // The feature entitlement `hr` / `mission` (20260923130000) is NOT referenced here, because no
  // navigation entry anywhere in this catalogue carries an entitlement: targets are exact hrefs
  // plus an optional permission, and the feature gate belongs to the controller that enforces it.
  //
  // ONE entry per route, and no fourth: `POST /hr/missions/:id/...` and the per-version policy
  // routes all embed an id, and an allowlist target must be exact and database-independent —
  // exactly why `/admin/hr/employees/:id` is absent.
  { href: '/admin/hr/missions', permission: Permissions.HR_MISSION_READ },
  { href: '/admin/hr/missions/approvals', permission: Permissions.HR_MISSION_APPROVE },
  { href: '/admin/hr/missions/configuration', permission: Permissions.HR_MISSION_POLICY },
  // PHASE UI-1: Procurement. THREE entries, one per declared row, each gated on the
  // permission its own read enforces: `commerce.read` on the module home and the register
  // (both are GET /commerce/purchase-documents), and `commerce.approve` on the task
  // workspace — the grant the ONE decision route in C1 answers to
  // (POST /commerce/commercial-approvals/:id/decision). A document's own id, the create
  // route and the detail route do not exist in the UI yet, so — exact hrefs only — there
  // is nothing further to allowlist.
  { href: '/admin/commerce', permission: Permissions.COMMERCE_READ },
  { href: '/admin/commerce/tasks', permission: Permissions.COMMERCE_APPROVE },
  { href: '/admin/commerce/purchases', permission: Permissions.COMMERCE_READ },
  // Phase KPI-RUNTIME. The ONE row gated on a UNION rather than a single permission: the five
  // approved KPIs read from Production, Commerce and Financial alike, so any one of the three
  // read remits is enough — mirroring `CoreNavItem.anyOfPermissions` on the shell side. A
  // single `permission` here would either hide the page from callers the backend serves or
  // admit callers it refuses, and the drift test only checks hrefs, not gates.
  {
    href: '/admin/kpis',
    anyOfPermissions: [
      Permissions.PRODUCTION_BOM_READ,
      Permissions.COMMERCE_READ,
      Permissions.FINANCIAL_CHECK_READ,
    ],
  },
];

/**
 * Audit surfaces that must NEVER be recorded as navigation history.
 *
 * Security events and login history are an audit trail. A "recent" entry pointing at
 * one would turn a convenience list into a second, unaudited record of who inspected
 * the audit trail — written by the reader's own browser, outside `AuditLog`.
 *
 * PHASE 49M-2 GAVE THIS LIST ITS FIRST REAL OCCUPANT. `/admin/observability` IS in
 * `NAV_TARGETS` above — so it can be favourited deliberately — but it renders application
 * logs, audit events and security events, which is exactly the class of page this rule was
 * written for. The distinction that makes both correct: a favourite is an explicit act by
 * the person pinning it, whereas a recent entry is written automatically on every visit.
 *
 * The remaining entries are still forward-looking: `/admin/security` and `/admin/audit` do
 * not exist as routes today, and login history is a section inside `/admin/profile` rather
 * than a route of its own. Keeping them costs nothing and preserves the guard for whoever
 * adds such a page later without remembering this rule. Matching is by prefix, so a future
 * detail route under any of these paths is covered without another edit.
 *
 * `/admin/profile` itself is deliberately NOT here: it is an ordinary personal page
 * that happens to render an audit section, and excluding it would cost a legitimate
 * favourite to protect nothing — the section is not addressable on its own.
 */
export const RECENT_EXCLUDED_PREFIXES: readonly string[] = [
  '/admin/security',
  '/admin/audit',
  '/admin/observability',
  '/admin/profile/security',
  '/admin/profile/login-history',
];

const TARGETS_BY_HREF = new Map(NAV_TARGETS.map((target) => [target.href, target]));

/** The declared target for an href, or undefined when the shell has no such item. */
export function navTargetFor(href: string): NavTarget | undefined {
  return TARGETS_BY_HREF.get(href);
}

/**
 * True when `href` is a real target the holder of `granted` may open.
 *
 * An unknown href and a forbidden one are deliberately indistinguishable to the
 * caller: refusing them with one message means a write cannot be used to probe which
 * pages exist behind a permission the caller lacks.
 */
export function isNavTargetAllowed(href: string, granted: ReadonlySet<string>): boolean {
  const target = TARGETS_BY_HREF.get(href);

  if (!target) return false;
  if (target.permission && granted.has(target.permission)) return true;
  if (target.anyOfPermissions?.some((permission) => granted.has(permission))) return true;
  // Neither gate declared: the href is open to every authenticated user.
  return !target.permission && !target.anyOfPermissions;
}

/** True when the href is an audit surface that may not enter `navRecent`. */
export function isExcludedFromRecent(href: string): boolean {
  return RECENT_EXCLUDED_PREFIXES.some(
    (prefix) => href === prefix || href.startsWith(`${prefix}/`)
  );
}
