import type { LucideIcon } from 'lucide-react';
import {
  Archive,
  Bell,
  Boxes,
  BrainCircuit,
  Briefcase,
  CalendarDays,
  CalendarClock,
  CalendarOff,
  ClipboardList,
  FileBarChart,
  FileEdit,
  FilePlus,
  FileText,
  Gauge,
  Home,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  MessageSquare,
  Network,
  Package,
  Plane,
  ScrollText,
  Search,
  Send,
  ShieldCheck,
  ShoppingCart,
  UserCircle,
  Users,
  Users2,
  Workflow,
} from 'lucide-react';

/**
 * Phase 49B: Core navigation definition.
 *
 * Every entry points at a route that actually exists in apps/web. No
 * placeholder or business-module targets are declared here.
 *
 * `permission` is optional and presentation-only: when set, the item is hidden
 * unless `GET /rbac` reports that permission. Hiding a link never replaces
 * backend authorization.
 */

export interface CoreNavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Permission string from the backend catalogue; omit for always-visible. */
  permission?: string;
  /**
   * Phase KPI-RUNTIME: an ALTERNATIVE gate — the item is visible when the caller holds ANY
   * ONE of these permissions, rather than a single `permission`.
   *
   * WHY IT IS NEEDED. `permission` is one string and `granted.has(...)` answers one question,
   * but the five approved KPIs span three domains: Production, Commerce and Financial. A
   * caller who may read Commerce KPIs and nobody else's is a legitimate reader, so gating the
   * row on any SINGLE remit would hide the page from exactly the people the backend serves,
   * while gating it on none would show it to everyone.
   *
   * The two fields are mutually exclusive in intent: `permission` stays the rule for the
   * 40-odd single-gate rows already declared here, and this one exists only for the row that
   * needs a union. It is presentation-only, exactly like `permission` — hiding a link never
   * replaces backend authorization, and `KpiRuntimeController` re-asks the same three-remit
   * question behind `@Roles(...)` plus a per-definition entitlement check.
   */
  anyOfPermissions?: readonly string[];
  /**
   * Phase 48C.1: real sub-navigation. Only items that declare children are
   * rendered as expandable groups — the sidebar never infers children from
   * permissions or from the active route. Leaf items therefore render no
   * expand/collapse affordance at all.
   */
  children?: CoreNavItem[];
  /**
   * Phase 49C-3: TRUE when the destination is no longer rendered in the rail's
   * STATIC navigation because a dedicated access path already exists elsewhere
   * (header user menu, header bell, date chip, dashboard widgets).
   *
   * Unlike the GROUP-level `sidebarHidden` below, this only shapes the static
   * rail list (`railNavGroups`). `visibleNavGroups` keeps returning the item, so
   * stored favourites and recent visits still resolve to a real row (STEP 8 of
   * the phase: never silently delete a user's navigation preferences), the href
   * stays a nav target for the 49K drift test, `pageTitleFor` keeps resolving,
   * and direct URLs keep working. The routes keep their existing server-side
   * authorization — "hidden from the rail" is never "unauthorized".
   */
  sidebarHidden?: boolean;
  /**
   * Phase 50-LOVABLE-PARITY: FALSE when the item must be excluded from the
   * favourites/recent personalization surfaces AND must render no star toggle in
   * the rail — matching the Lovable reference, whose correspondence tree has no
   * starred state at all. TRUE (the default) leaves the existing star behaviour
   * untouched.
   */
  favoriteable?: boolean;
  /**
   * Phase 50-LOVABLE-PARITY: TRUE when an expandable item's sub-tree starts
   * OPEN on first render, with no active child required — matching the Lovable
   * reference, which seeds the مکاتبات submenu open (`open: { mail: true }`).
   */
  defaultOpen?: boolean;
}

export interface CoreNavGroup {
  id: string;
  label: string;
  items: CoreNavItem[];
  /**
   * Phase 49C-2: TRUE when the group is no longer primary navigation and is reached
   * only through the Settings Center (`/admin/settings`). A hidden group stays in
   * `CORE_NAV` ON PURPOSE:
   * - the hrefs remain nav targets, so direct URLs keep working, `pageTitleFor` keeps
   *   resolving their titles, and `isNavTarget`/visit recording keep their verified
   *   semantics (the 49K drift test against the server's `NAV_TARGETS` stays green);
   * - the server allowlist never changes, so nothing backend-side moves.
   * Only the RAIL hides the group, via `visibleNavGroups`.
   */
  sidebarHidden?: boolean;
}

export const CORE_NAV: CoreNavGroup[] = [
  {
    id: 'overview',
    label: 'عمومی',
    items: [
      { label: 'خانه', href: '/admin', icon: Home },
      /*
       * Phase MANAGEMENT-DASHBOARD-V1: the management dashboard at `/admin/management`
       * («نمای مدیریت»). A first-class destination, placed right after «خانه».
       *
       * GATED ON A UNION OF THE FOUR V1 SOURCE REMITS: each card reads one of them, and a
       * caller holding none sees no row. A card the caller cannot read renders its own
       * forbidden state, so holding any one remit is enough to open the page.
       */
      {
        label: 'نمای مدیریت',
        href: '/admin/management',
        icon: LayoutDashboard,
        anyOfPermissions: [
          'production.bom.read',
          'commerce.read',
          'financial.check.read',
          'hr.mission.approve',
        ],
      },

      /*
       * Phase KPI-RUNTIME: the five approved KPIs. Unlike the Reporting routes — which have
       * deliberately NO rail row because they are registers of an existing module — a KPI
       * overview is a first-class management destination, so it is discoverable rather than
       * reachable only by URL.
       *
       * GATED ON A UNION, NOT ONE STRING: all three remits appear because the catalogue's
       * five definitions read from Production, Commerce and Financial alike. See the
       * `anyOfPermissions` field above for why a single `permission` cannot express that.
       */
      {
        label: 'شاخص‌های کلیدی عملکرد',
        href: '/admin/kpis',
        icon: Gauge,
        anyOfPermissions: ['production.bom.read', 'commerce.read', 'financial.check.read'],
      },
      // Phase 49C-3: removed from the STATIC rail — the header user menu's «حساب من»
      // entry (49C-1) and the dashboard identity widget's «مشاهده حساب من» action are
      // the dedicated access paths. The href stays a nav target, so direct URLs,
      // titles, the drift test and favourites/recent resolution all keep working.
      {
        label: 'حساب من',
        href: '/admin/profile',
        icon: UserCircle,
        sidebarHidden: true,
      },
      // Phase 49E. Deliberately NOT permission-gated: notifications are personal
      // and the backend routes carry no `@Roles()` check, so gating the link would
      // hide a page every authenticated user is entitled to.
      // Phase 49C-3: removed from the STATIC rail — the header bell (unread badge +
      // panel + «مشاهده همه اعلان‌ها») and the dashboard notifications widget are the
      // dedicated access paths. Same preserved contract as «حساب من» above.
      {
        label: 'اعلان‌ها',
        href: '/admin/notifications',
        icon: Bell,
        sidebarHidden: true,
      },
      // Phase 49F. Also NOT permission-gated: a conversation is personal and the
      // backend routes carry no `@Roles()` check — membership is the only
      // authorization edge, enforced server-side on every read and write.
      { label: 'پیام‌ها', href: '/admin/messages', icon: MessageSquare },
      // Phase 49I. Also NOT permission-gated, and for the strongest version of the
      // reason: a reminder is owned by exactly one user, the backend introduces no
      // calendar permission at all, and ownership is the only authorization edge. The
      // sidebar date chip links here, so gating the item would orphan the chip.
      // Phase 49C-3: removed from the STATIC rail — the rail's own date chip (deep link
      // with the selected date) and the dashboard reminders widget's «تقویم و یادآورها»
      // action are the dedicated access paths. Same preserved contract as «حساب من».
      {
        label: 'تقویم',
        href: '/admin/calendar',
        icon: CalendarDays,
        sidebarHidden: true,
      },
      // Phase 49D-1. `admin.users.read` is the permission the backend actually
      // enforces on GET /users/directory, so the same string is used here —
      // hiding the link is presentation-only and never replaces that check.
      {
        label: 'دفترچه سازمانی',
        href: '/admin/directory',
        icon: Users,
        permission: 'admin.users.read',
      },
    ],
  },
  {
    id: 'content',
    label: 'مدیریت محتوا',
    items: [
      // Preserved CMS baseline. `blog.read` exists in the backend permission
      // catalogue and is returned by GET /rbac for content roles.
      { label: 'وبلاگ', href: '/admin/blog', icon: FileText, permission: 'blog.read' },
    ],
  },
  {
    id: 'hr',
    label: 'منابع انسانی',
    /*
     * Phase 51-HR-2: Human Resources.
     *
     * GATED ON THE READ PERMISSIONS THE HR CONTROLLERS THEMSELVES ENFORCE, and — unlike
     * `support.tickets` (49G) — these ARE seeded in core_db
     * (20260916100100_seed_hr_permission_grants), so the gate genuinely works instead of
     * hiding the module from everyone: `hr.employees.read` on `GET /hr/employees`,
     * `hr.organization.read` on `GET /hr/organization/summary`, `hr.positions.read` on
     * `GET /hr/positions`, and `hr.attendance.read` on `GET /hr/attendance` (51-HR-2E, the
     * register). The `hr.*.manage` writes are deliberately NOT used here: a READ
     * is what entitles a user to see the module, and the editing affordances inside the
     * pages are driven by the manage permissions separately. Hiding the link is
     * presentation-only and never replaces those server-side checks.
     *
     * THE MODULE ROW IS A LEAF, and that is a decision rather than a default: `/admin/hr`
     * is a real page — the counters and the latest personnel files are what an HR
     * administrator opens the module FOR — so it is a destination, not a section toggle.
     * Its four areas therefore sit BESIDE it in one flat group, unlike the مکاتبات tree
     * whose parent exists only to open a sub-menu. The rail still shows exactly one
     * selected row for that shape: `activeNavHref` keeps "you are here" on the most
     * specific declared target, so the module row goes dark while `/admin/hr/employees`
     * lights its own row.
     */
    items: [
      // The home screen's OWN read is `hr.organization.read`: the aggregate it renders
      // comes from `GET /hr/organization/summary`, which the organization controller
      // guards with that permission — its own comment calls it "the real aggregate the HR
      // home screen renders". The five latest personnel files it also loads need
      // `hr.employees.read`, still enforced server-side per call, so a caller holding only
      // the organization grant reaches the page and gets its own 403 rather than a link
      // that bypasses anything.
      {
        label: 'منابع انسانی',
        href: '/admin/hr',
        icon: LayoutDashboard,
        permission: 'hr.organization.read',
      },
      {
        label: 'کارکنان',
        href: '/admin/hr/employees',
        icon: Users2,
        permission: 'hr.employees.read',
      },
      {
        label: 'چارت سازمانی',
        href: '/admin/hr/organization',
        icon: Network,
        permission: 'hr.organization.read',
      },
      {
        label: 'سمت‌ها',
        href: '/admin/hr/positions',
        icon: Briefcase,
        permission: 'hr.positions.read',
      },
      // Phase 51-HR-2E. The attendance register. Gated on `hr.attendance.read` — the read
      // `AttendanceController.list` enforces, seeded in core_db by
      // 20260918130000_seed_hr_attendance_permission_grants — and NOT on
      // `hr.attendance.manage`, for the same reason as the three rows above: a read is what
      // entitles a person to open the module, and the register writes nothing at all, so a
      // manage gate here would hide the page from an analyst who may legitimately read it.
      {
        label: 'حضور و غیاب',
        href: '/admin/hr/attendance',
        icon: CalendarClock,
        permission: 'hr.attendance.read',
      },
      // Phase 51-HR-2F. The personnel traffic report. Gated on the SAME read as the register —
      // `hr.attendance.read`, the one `AttendanceController.list` enforces — because it is the
      // SAME endpoint read with a bounded window: the report adds a screen (always a date or a
      // از/تا range, never «همه روزها»), not a route on the API and not a permission. Gating it
      // on anything else would mean inventing an authority the backend does not have, and a
      // user who may read the register may read this report of it.
      {
        label: 'گزارش رفت‌وآمد پرسنل',
        href: '/admin/hr/traffic-report',
        icon: FileBarChart,
        permission: 'hr.attendance.read',
      },
      // Phase 51-HR-3A. The leave register — the requests this tenant has RECORDED, over the
      // tenant's OWN catalogue of leave kinds. Gated on `hr.leave.read`, the read both
      // `LeaveRequestsController.list` and `LeaveTypesController.list` enforce and the read
      // `20260919120000_seed_hr_leave_permission_grants` seeds in core_db — and NOT on
      // `hr.leave.manage`, for the reason the rows above give: a read is what entitles a person
      // to open a page, and the register's own card writes nothing. The approve/withdraw and
      // catalogue controls inside the page are driven by the manage grant separately.
      //
      // ONE row, not two. The catalogue (`/hr/leave-types`) is deliberately NOT a route of its
      // own and NOT a nav target: it is the register's filter vocabulary and the precondition for
      // submitting anything at all, so it belongs where it is used. A nav row for it would offer
      // a page whose contents are already on this one.
      {
        label: 'مرخصی‌ها',
        href: '/admin/hr/leave',
        icon: CalendarOff,
        permission: 'hr.leave.read',
      },
      // Phase 54-I. The leave-policy CONFIGURATION and simulation surface. Gated on
      // `hr.leave.policy` — the grant the simulate route, version authoring and publish all enforce,
      // and the one `20260919120000_seed_hr_leave_permission_grants` seeds. NOT `hr.leave.read`: the
      // surface exists to exercise configuration authority, so offering it to a read-only operator
      // would advertise a page whose every action 403s. A person holding only `hr.leave.read` still
      // reaches the governance question through the register, which links here only when entitled.
      //
      // It points at the ENTRY surface, not a directory: there is no `GET /hr/leave-policies`, and
      // the page asks "which policy governs this leave type on this day?" to obtain the policy id the
      // per-policy route needs. A nav target cannot name a specific policy, and must not.
      {
        label: 'سیاست‌های مرخصی',
        href: '/admin/hr/leave-policies',
        icon: ShieldCheck,
        permission: 'hr.leave.policy',
      },
      // Phase 55. Mission — the register, the approval queue and the rule-set configuration, each
      // gated on the grant ITS OWN screen consults rather than on one shared Mission read.
      //
      // WHY THREE DIFFERENT GATES ON THREE SIBLINGS. The Mission module separates four authorities
      // — read, manage, approve, policy — and the pages genuinely differ in which one they demand.
      // A single `hr.mission.read` on all three would offer the approval queue and the rule set to
      // an operator whose every action on them is 403, which is the failure the Phase 54-I row above
      // already documents for `hr.leave.policy`. So:
      //
      //   * «ماموریت‌ها» asks for `hr.mission.read` — the read `HrMissionView` names in its own
      //     refusal sentence and the read `MissionController.list` enforces;
      //   * «تأیید ماموریت‌ها» asks for `hr.mission.approve` — `HrMissionApprovalView` states that it
      //     deliberately does NOT consult `hr.mission.read`, because holding it would let an actor
      //     see the register without being entitled to decide anything;
      //   * «پیکربندی ماموریت‌ها» asks for `hr.mission.policy` — `HrMissionConfigurationView` states
      //     the same about both other grants, since authoring a rule set is a fourth act entirely.
      //
      // `hr.mission.manage` is NOT used on any row: it drives the create/edit/submit affordances
      // INSIDE the register, and — as every row above records — a write grant is not what entitles a
      // person to open a page. A holder of only `hr.mission.manage` therefore sees no Mission row and
      // reaches the register's own 403, exactly as a holder of only `hr.leave.manage` sees no
      // leave row.
      //
      // All four grants are seeded in core_db by 20260923131000_seed_hr_mission_permission_grant, so
      // these gates hide nothing from the roles that may use the pages. The `hr` / `mission` FEATURE
      // entitlement is deliberately not consulted: no entry in this file carries one, and the feature
      // gate stays where it is enforced, on the controller.
      //
      // THREE FLAT ROWS, like the areas above rather than a Mission sub-tree: `/admin/hr/missions` is
      // a real page (the register), so it is a destination and not a section toggle, and
      // `activeNavHref` keeps exactly one row lit — the module row stays dark while a child is open.
      // The per-mission, per-step and per-policy routes are absent for the reason every detail page
      // above is: an exact href allowlist cannot hold a database id.
      {
        label: 'ماموریت‌ها',
        href: '/admin/hr/missions',
        icon: Plane,
        permission: 'hr.mission.read',
      },
      {
        label: 'تأیید ماموریت‌ها',
        href: '/admin/hr/missions/approvals',
        icon: ShieldCheck,
        permission: 'hr.mission.approve',
      },
      {
        label: 'پیکربندی ماموریت‌ها',
        href: '/admin/hr/missions/configuration',
        icon: Workflow,
        permission: 'hr.mission.policy',
      },
    ],
  },
  {
    id: 'commerce',
    label: 'تدارکات',
    /*
     * PHASE UI-1: Procurement. THREE rows — the only routes this phase ships; the
     * configuration areas (commercial policy, workflow) arrive with the phases that
     * implement them, because this catalogue declares no placeholder targets.
     *
     * GATED ON THE PERMISSION EACH SURFACE ANSWERS TO, and the strings are seeded in
     * core_db by 20260926100100_seed_commerce_permission_grants, so the gates genuinely
     * work: `commerce.read` on the home and the register (both read
     * GET /commerce/purchase-documents) and `commerce.approve` on the task workspace —
     * the grant C1's only decision route (POST /commerce/commercial-approvals/:id/decision)
     * enforces. A user without `commerce.read` therefore sees no row that would 403.
     * Hiding a link is presentation only; every route keeps its server-side gate, and the
     * module is additionally entitlement-gated (module `commerce`, feature `purchase`).
     */
    items: [
      {
        label: 'خانهٔ تدارکات',
        href: '/admin/commerce',
        icon: ShoppingCart,
        permission: 'commerce.read',
      },
      {
        label: 'نیازمند اقدام من',
        href: '/admin/commerce/tasks',
        icon: Inbox,
        permission: 'commerce.approve',
      },
      {
        label: 'درخواست‌های خرید',
        href: '/admin/commerce/purchases',
        icon: Package,
        permission: 'commerce.read',
      },
    ],
  },
  {
    id: 'services',
    label: 'خدمات',
    items: [
      // Phase 49G. Deliberately NOT permission-gated: filing and reading your own
      // ticket is personal, and the requester-facing backend routes carry no
      // `@Roles()` check — ownership is the authorization edge, enforced server-side.
      // Gating on `support.tickets` would hide the page from everyone, because that
      // permission exists in the catalogue but is not seeded in core_db.
      // Phase 49C-5: removed from the STATIC rail — the header user menu's «پشتیبانی»
      // entry (between «تنظیمات» and «خروج», rendered by `CoreHeader`) is the
      // dedicated access path; it deliberately does NOT live in the Settings Center.
      // Like every `sidebarHidden` entry, the href stays a nav target:
      // `visibleNavGroups` still returns it, so titles, the 49K drift test,
      // direct URLs and favourites/recent resolution all keep working. Ungated here
      // AND ungated as the menu entry — a user gains nothing new by either path, and
      // the route keeps its own server-side authorization regardless.
      { label: 'پشتیبانی', href: '/admin/support', icon: LifeBuoy, sidebarHidden: true },
      // Phase 49H. Also NOT permission-gated, but for a different reason than
      // support: `admin.surveys.manage` and `admin.surveys.results` ARE seeded in
      // core_db, so gating on them would work — it would just hide the page from
      // every non-admin, and answering a published survey is an ordinary
      // authenticated-user capability. The authoring and results controls inside the
      // page are driven by the server-computed `canManage` / `canViewResults` flags
      // instead, so a participant sees the page without seeing admin affordances.
      { label: 'نظرسنجی‌ها', href: '/admin/surveys', icon: ClipboardList },
    ],
  },
  {
    id: 'correspondence',
    label: 'مکاتبات',
    // Phase 50: Official Correspondence. Deliberately NOT permission-gated, exactly
    // like پیام‌ها / پشتیبانی / نظرسنجی‌ها above: the personal workflow (drafting,
    // sending, receiving, referring, archiving into one's own folders) is an
    // ordinary authenticated-user capability bounded by ownership/recipient edges
    // and tenant scope INSIDE CorrespondenceService. The three seeded
    // correspondence permissions (correspondence.manage,
    // correspondence.confidential.read / .manage) gate tenant-wide and
    // confidential operations inside the pages themselves — never the entry.
    //
    // Phase 50-CORRECTION: مکاتبات is a REAL expandable parent item (the first
    // `children` group in the rail, reusing the existing Phase 48C.1 sub-navigation
    // pattern), not a section heading with flat rows. It renders as a pure toggle
    // row (Lovable parity): clicking the PARENT row opens/closes the sub-tree — no
    // separate chevron needed — and a sub-tree whose child is the active route opens
    // by default (`containsActive`) and stays open during child navigation.
    items: [
      {
        label: 'مکاتبات',
        // The parent row is a SECTION TOGGLE in the rail (Lovable parity), not a
        // destination: clicking it only opens/closes the sub-tree. The cartable
        // page is no longer linked from the sidebar — the «کارتابل» child was
        // removed with the parity work, and «صندوق دریافت» is planned as a
        // dedicated core entry later. The href stays DECLARED so direct URLs,
        // titles, visit recording and the 49K drift test keep working.
        href: '/admin/correspondence',
        icon: Mail,
        // Phase 50-LOVABLE-PARITY: the correspondence tree mirrors the Lovable
        // reference — no favourite star anywhere in the tree (`favoriteable: false`
        // hides the toggle and keeps these hrefs out of the favourites/recent
        // personalization groups), and the submenu starts open on first render
        // (`defaultOpen: true`, Lovable seeds `open: { mail: true }`).
        favoriteable: false,
        defaultOpen: true,
        children: [
          {
            label: 'ایجاد نامه جدید',
            href: '/admin/correspondence/new',
            icon: FilePlus,
            favoriteable: false,
          },
          {
            label: 'پیش‌نویس‌ها',
            href: '/admin/correspondence/drafts',
            icon: FileEdit,
            favoriteable: false,
          },
          {
            label: 'نامه‌های ارسالی',
            href: '/admin/correspondence/sent',
            icon: Send,
            favoriteable: false,
          },
          {
            label: 'جستجو',
            href: '/admin/correspondence/search',
            icon: Search,
            favoriteable: false,
          },
          {
            label: 'بایگانی',
            href: '/admin/correspondence/archive',
            icon: Archive,
            favoriteable: false,
          },
        ],
      },
    ],
  },
  {
    id: 'platform',
    label: 'تنظیمات پلتفرم',
    // Phase 49C-2: this group moved OUT of the sidebar. Its destinations are now
    // tabs inside the Settings Center (/admin/settings) reached from the header user
    // menu's «تنظیمات» entry. The hrefs stay declared here (see `sidebarHidden`) so
    // direct routes, titles, drift checks and visit recording keep working.
    sidebarHidden: true,
    items: [
      // Phase 49J-0. Gated on `admin.ai.read`, the permission the controller enforces on
      // the two read routes — and unlike `support.tickets` (49G) this one IS seeded in
      // core_db, so the gate genuinely works rather than hiding the page from everyone.
      // `admin.ai.manage` is NOT used here: OPERATIONS_ADMIN holds read only and is
      // entitled to see which provider and model are live.
      {
        label: 'هوش مصنوعی',
        href: '/admin/ai',
        icon: BrainCircuit,
        permission: 'admin.ai.read',
      },
      // Phase 49L. Gated on `admin.integrations.read`, the permission the controller
      // enforces on its three read routes — seeded in core_db by
      // 20260904120500_seed_integration_permission_grants, so the gate genuinely works.
      // `admin.integrations.manage` is NOT used here, for the same reason as AI:
      // OPERATIONS_ADMIN holds read only and is entitled to see whether automation is
      // reaching the engine when diagnosing. The write controls inside the page are
      // driven by the manage permission separately.
      {
        label: 'اتوماسیون و یکپارچه‌سازی',
        href: '/admin/integrations',
        icon: Workflow,
        permission: 'admin.integrations.read',
      },
      // Phase 49M. Gated on `admin.modules.read`, the permission the controller enforces on
      // its four read routes — seeded in core_db by
      // 20260905120500_seed_module_permission_grants, so the gate genuinely works.
      // `admin.modules.manage` is NOT used here, for the same reason as AI and 49L:
      // OPERATIONS_ADMIN holds read only and is entitled to see whether a module is
      // registered and reachable when diagnosing. The write controls inside the page are
      // driven by the manage permission separately.
      //
      // ONE ENTRY, NOT ONE PER MODULE. A nav item per registered module would make the
      // navigation tree depend on database rows and would break the 49K drift test the
      // moment a module was registered — the registry page lists them instead.
      {
        label: 'ماژول‌ها و سرویس‌های متصل',
        href: '/admin/modules',
        icon: Boxes,
        permission: 'admin.modules.read',
      },
      // Phase 49M-2. Gated on `admin.observability.read`, the permission the controller
      // enforces on its read routes — seeded in core_db by
      // 20260905160000_seed_observability_permission_grants, so the gate genuinely works.
      //
      // THIS PERMISSION IS THE RIGHT GATE FOR THE NAV ENTRY even though the page's security
      // tab needs `admin.security.read` as well: OPERATIONS_ADMIN holds the former and not
      // the latter, and it is entitled to reach the page for application logs and lifecycle
      // history. Gating the entry on the narrower permission would hide the whole page from
      // the role that diagnoses incidents. The tab itself is driven by the security
      // permission separately, the same pattern the AI and 49L pages use for write controls.
      {
        label: 'لاگ‌ها و رخدادها',
        href: '/admin/observability',
        icon: ScrollText,
        permission: 'admin.observability.read',
      },
    ],
  },
];

/**
 * Presentation-only filter. Items without a permission are always visible.
 *
 * `enforce` is false while permissions are still loading or when `GET /rbac`
 * failed. In that case gated items stay visible so the existing CMS entry never
 * disappears because of a transient error — the backend still returns 403 for
 * anyone who lacks the permission.
 */
export function visibleNavGroups(
  permissions: string[],
  enforce = true,
  source: CoreNavGroup[] = CORE_NAV
): CoreNavGroup[] {
  const granted = new Set(permissions);

  const allowed = (item: CoreNavItem) => {
    if (!enforce) return true;
    if (item.permission && granted.has(item.permission)) return true;
    if (item.anyOfPermissions?.some((permission) => granted.has(permission))) return true;
    // Neither gate declared: the row is visible to every authenticated user.
    return !item.permission && !item.anyOfPermissions;
  };

  // Children are filtered by the same rule. A `children` array that becomes
  // empty is dropped entirely so the item degrades to a real leaf and loses its
  // chevron, rather than keeping an expandable control with nothing inside.
  const filterItem = (item: CoreNavItem): CoreNavItem => {
    if (!item.children?.length) return item;

    const children = item.children.filter(allowed).map(filterItem);
    const { children: _omit, ...leaf } = item;

    return children.length > 0 ? { ...item, children } : leaf;
  };

  return (
    source
      .map((group) => ({
        ...group,
        items: group.items.filter(allowed).map(filterItem),
      }))
      .filter((group) => group.items.length > 0)
      // Phase 49C-2: Settings-Center-only groups never render in the rail. Hidden
      // groups are filtered AFTER the permission pass, so their items keep their own
      // permission gates wherever they are rendered (Settings Center tabs).
      .filter((group) => !group.sidebarHidden)
  );
}

/**
 * Phase 49C-3: strips the item-level `sidebarHidden` personal destinations
 * (حساب من / اعلان‌ها / تقویم) from an ALREADY permission-filtered group list.
 * Groups whose every item is hidden disappear entirely — the rail never renders
 * an empty group header.
 *
 * Deliberately a separate pass over `visibleNavGroups` output rather than a
 * different query path: `CoreSidebar` keeps ONE navigation seam, and the
 * favourites/recent resolver keeps consuming the FULL `visibleNavGroups` result,
 * so a pinned «تقویم» still resolves to a real row after the static row is gone.
 * The routes are ungated personal destinations that still exist — hiding the
 * static row must not delete the user's personalization (unlike the 49C-2
 * platform group, whose destinations left the rail together with their Settings
 * Center remount).
 */
export function toRailGroups(groups: CoreNavGroup[]): CoreNavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.sidebarHidden),
    }))
    .filter((group) => group.items.length > 0);
}

/** The rail's STATIC list: permission-filtered, minus the deduplicated personal rows. */
export function railNavGroups(
  permissions: string[],
  enforce = true,
  source: CoreNavGroup[] = CORE_NAV
): CoreNavGroup[] {
  return toRailGroups(visibleNavGroups(permissions, enforce, source));
}

/**
 * Single source of truth for the chevron: an item is expandable only when the
 * navigation structure gives it at least one visible child.
 */
export function isExpandable(item: CoreNavItem): boolean {
  return (item.children?.length ?? 0) > 0;
}

/** Flattens an item and every descendant, for title/active resolution. */
export function flattenNavItems(items: CoreNavItem[]): CoreNavItem[] {
  return items.flatMap((item) => [item, ...flattenNavItems(item.children ?? [])]);
}

/**
 * Phase 50-CORRECTION: hrefs for drift-checking, visit recording and resolution.
 * Same as flattenNavItems but deduplicates by href, keeping the declared set
 * duplicate-free for the drift test against SERVER_NAV_TARGETS. (A safety net:
 * after the parity work the مکاتبات parent no longer shares its href with a
 * «کارتابل» child, so currently nothing actually duplicates.)
 */
export function uniqueNavHrefs(items: CoreNavItem[]): CoreNavItem[] {
  const seen = new Set<string>();
  const out: CoreNavItem[] = [];
  for (const item of flattenNavItems(items)) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    out.push(item);
  }
  return out;
}

/**
 * Phase 49K (N3): true when `pathname` is EXACTLY a declared navigation target.
 *
 * Mirrors the server's `NAV_TARGETS` allowlist, which is built from the same hrefs. Used
 * to decide whether a visit is worth recording at all: `PATCH /me/preferences` drops an
 * href that is not a nav target, so sending `/admin/blog/42` would be a request whose
 * only possible outcome is being ignored.
 *
 * EXACT, not longest-prefix — unlike `isNavItemActive`. A detail page is not the nav
 * target that highlights for it, and recording the parent instead would put a link in
 * the recent list that the user never opened.
 */
export function isNavTarget(pathname: string): boolean {
  return flattenNavItems(CORE_NAV.flatMap((group) => group.items)).some(
    (item) => item.href === pathname
  );
}

/**
 * Phase 49M-2: navigation targets whose visits must NOT be recorded.
 *
 * MIRRORS the server's `RECENT_EXCLUDED_PREFIXES` in `apps/api/src/preferences/nav-catalogue.ts`,
 * for the same reason `isNavTarget` mirrors `NAV_TARGETS`: the server already drops these hrefs
 * from `navRecent`, so sending one is a request whose only outcome is being discarded.
 *
 * WHY AN OBSERVABILITY PAGE IS EXCLUDED WHILE STILL BEING FAVOURITABLE: `/admin/observability`
 * displays application logs, audit events and security events. An automatic "recent" entry for
 * it would be a second record of who inspected the audit trail — written by the reader's own
 * browser and stored outside any audit table. A FAVOURITE is different: it is an explicit,
 * deliberate act by the person pinning it, which is why the href stays in `CORE_NAV`.
 *
 * Prefix-matched, so a future detail route beneath one of these paths is covered without an edit.
 */
export const RECENT_EXCLUDED_PREFIXES: readonly string[] = [
  '/admin/security',
  '/admin/audit',
  '/admin/observability',
  '/admin/profile/security',
  '/admin/profile/login-history',
];

/** True when the href is an audit surface whose visits are never recorded. */
export function isExcludedFromRecent(pathname: string): boolean {
  return RECENT_EXCLUDED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/** True when a visit to `pathname` is worth recording: a declared target, not an audit surface. */
export function isRecordableVisit(pathname: string): boolean {
  return isNavTarget(pathname) && !isExcludedFromRecent(pathname);
}

/** Longest-prefix match so nested routes highlight their parent entry. */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === '/admin') {
    return pathname === '/admin';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Phase 51-HR-2: the ONE declared href whose row lights up for `pathname`.
 *
 * `isNavItemActive` answers "does this href COVER the path", which is exactly right when
 * the path is a detail page with no row of its own: `/admin/blog/42` still lights up
 * وبلاگ, and that is why the rule is a prefix. It is wrong as soon as a more specific row
 * exists, because then two rows answer yes at once — `/admin/hr/employees` is covered by
 * BOTH `/admin/hr` and its own row. That is the same defect Phase 50 fixed for an
 * expandable parent and its selected child (`NavRow`), and it appears for the same
 * reason: a navigation list can only ever have one "you are here".
 *
 * So the winner is the MOST SPECIFIC match and every other matching row stays dark.
 * Nothing changes for a detail route (its parent is the only match, so it still wins) or
 * for an item on its own href; the only rows this silences are the ones a declared
 * descendant already claims.
 *
 * The caller decides WHICH hrefs are candidates, because that is a rendering question
 * rather than a catalogue question: `CoreSidebar` passes only what can actually render a
 * row — see the note there about the collapsed rail, where a sub-tree has no rows at all.
 * The list is used EXACTLY as given (deduplicated by href, never flattened), so a caller
 * that passes top-level rows does not accidentally hand the answer to a hidden child.
 */
export function activeNavHref(pathname: string, items: CoreNavItem[]): string | null {
  const matches = [...new Set(items.map((item) => item.href))].filter((href) =>
    isNavItemActive(pathname, href)
  );

  // Longest href = most specific. The hrefs are deduplicated above, so there is no tie.
  return matches.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Phase 49C-1: title aliases for REAL routes outside `CORE_NAV`.
 *
 * `pageTitleFor` normally resolves through the nav catalogue, but a route like the
 * settings page is deliberately NOT a nav item: adding it to `CORE_NAV` would break the
 * 49K drift test against the server's `NAV_TARGETS` (the settings href is not in the
 * server allowlist, so the rail must not declare it either). The alias only shapes the
 * header title; it never makes the route a nav target, so it cannot be recorded as a
 * recent visit and never reaches the server allowlist.
 */
const PAGE_TITLE_ALIASES: Readonly<Record<string, string>> = {
  '/admin/settings': 'تنظیمات',
  /*
   * Phase REPORTING-UI: `/admin/reporting` is a REAL route with deliberately NO rail
   * row — adding one is a platform-navigation decision (the Production/Financial
   * first-UI-phase precedent), and the rail must not claim destinations behind a
   * business capability that does not exist yet. The alias is the mechanism this file
   * already documents for exactly this shape (a real route outside `CORE_NAV`): the
   * shell's persistent header title resolves to «گزارش‌گیری» instead of the generic
   * fallback, WITHOUT making the route a nav target — so it can never be favourited,
   * never enters `navRecent`, and never needs a row in the server's `NAV_TARGETS`
   * (the 49K drift test stays untouched, entry for entry).
   */
  '/admin/reporting': 'گزارش‌گیری',
  /*
   * Phase REPORTING-PURCHASE-REPORT: `/admin/reporting/purchase-requests` follows the
   * same shape — a REAL route with deliberately NO rail row. `pageTitleFor` matches
   * exact pathnames here, so both report routes need their own entry; the deep detail
   * id route reads most honestly as the register's own title.
   */
  '/admin/reporting/purchase-requests': 'گزارش درخواست‌های خرید',
  /*
   * Phase REPORTING-PRODUCTION-REPORT: `/admin/reporting/production` follows the
   * same shape — a REAL route with deliberately NO rail row. `pageTitleFor` matches
   * exact pathnames here, so the register route needs its own entry; the deep detail
   * id route reads most honestly as the register's own title.
   */
  '/admin/reporting/production': 'گزارش عملیات تولید',
  /*
   * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT:
   * `/admin/reporting/production/bom-change-requests` follows the same shape — a REAL
   * route with deliberately NO rail row. `pageTitleFor` matches exact pathnames here,
   * so the register route needs its own entry; the deep detail id route reads most
   * honestly as the register's own title. The full report name lives in the page's
   * identity block and `metadata.title`.
   */
  '/admin/reporting/production/bom-change-requests': 'گزارش درخواست‌های تغییر BOM',
  /*
   * Phase REPORTING-HR-PERSONNEL-TRAFFIC: `/admin/reporting/hr/personnel-traffic`
   * follows the same shape — a REAL route with deliberately NO rail row.
   * `pageTitleFor` matches exact pathnames here, so the register route needs its own
   * entry; the deep detail id route reads most honestly as the register's own title.
   */
  '/admin/reporting/hr/personnel-traffic': 'گزارش تردد پرسنل',
  /*
   * Phase REPORTING-HR-LEAVE-REQUEST: `/admin/reporting/hr/leave-requests`
   * follows the same shape — a REAL route with deliberately NO rail row.
   * `pageTitleFor` matches exact pathnames here, so the register route needs its own
   * entry; the deep detail id route reads most honestly as the register's own title.
   */
  '/admin/reporting/hr/leave-requests': 'گزارش وضعیت درخواست‌های مرخصی',
  /*
   * Phase REPORTING-HR-MISSION-REQUEST: `/admin/reporting/hr/mission-requests`
   * follows the same shape — a REAL route with deliberately NO rail row.
   * `pageTitleFor` matches exact pathnames here, so the register route needs its own
   * entry; the deep detail id route reads most honestly as the register's own title.
   */
  '/admin/reporting/hr/mission-requests': 'گزارش وضعیت درخواست‌های مأموریت',
  /*
   * Phase REPORTING-COMMERCE-PAYMENT-HISTORY: `/admin/reporting/commerce/payment-history`
   * follows the same shape — a REAL route with deliberately NO rail row.
   * `pageTitleFor` matches exact pathnames here, so the register route needs its own
   * entry; the deep detail id route reads most honestly as the register's own title.
   */
  '/admin/reporting/commerce/payment-history': 'گزارش تاریخچه پرداخت‌های بازرگانی',
  /*
   * Phase REPORTING-COMMERCE-RETURN-LIFECYCLE: `/admin/reporting/commerce/return-lifecycle`
   * follows the same shape — a REAL route with deliberately NO rail row.
   * `pageTitleFor` matches exact pathnames here, so the register route needs its own
   * entry; the deep detail id route reads most honestly as the register's own title.
   */
  '/admin/reporting/commerce/return-lifecycle': 'گزارش چرخه حیات مرجوعی‌های بازرگانی',
  /*
   * Phase REPORTING-COMMERCE-RECEIVING-STATUS: `/admin/reporting/commerce/receiving`
   * follows the same shape — a REAL route with deliberately NO rail row.
   * `pageTitleFor` matches exact pathnames here, so the register route needs its own
   * entry; the deep detail id route reads most honestly as the register's own title.
   */
  '/admin/reporting/commerce/receiving': 'گزارش وضعیت دریافت‌های بازرگانی',
  /*
   * Phase KPI-RUNTIME: `/admin/kpis` now HAS a `CORE_NAV` row (unlike every reporting route
   * above), so `pageTitleFor` normally resolves its title from that row — this entry is the
   * FALLBACK for the exact path when the row is filtered out of the flattened list the
   * resolver walks. The two strings are stated identically on purpose: the header must never
   * disagree with the rail about what this page is called.
   */
  '/admin/kpis': 'شاخص‌های کلیدی عملکرد',
};

export function pageTitleFor(pathname: string): string {
  const all = flattenNavItems(CORE_NAV.flatMap((group) => group.items));
  const match = all
    .filter((item) => isNavItemActive(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return match?.label ?? PAGE_TITLE_ALIASES[pathname] ?? 'پنل مدیریت';
}
