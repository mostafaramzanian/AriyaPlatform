import { FileText, Home } from 'lucide-react';
import {
  CORE_NAV,
  activeNavHref,
  flattenNavItems,
  uniqueNavHrefs,
  isExpandable,
  isNavItemActive,
  isNavTarget,
  pageTitleFor,
  railNavGroups,
  toRailGroups,
  visibleNavGroups,
  type CoreNavGroup,
  type CoreNavItem,
} from '../core-nav';

/**
 * Phase 48C.1: the chevron is driven purely by the navigation structure, so the
 * structure-shaping helpers are covered directly.
 */
const NAV: CoreNavGroup[] = [
  {
    id: 'overview',
    label: 'عمومی',
    items: [
      { label: 'خانه', href: '/admin', icon: Home },
      {
        label: 'تنظیمات',
        href: '/admin/settings',
        icon: FileText,
        children: [
          { label: 'پیکربندی', href: '/admin/settings/general', icon: FileText },
          {
            label: 'امنیت',
            href: '/admin/settings/security',
            icon: FileText,
            permission: 'settings.security',
          },
        ],
      },
    ],
  },
];

describe('core-nav structure helpers', () => {
  it('treats an item as expandable only when it has at least one child', () => {
    expect(isExpandable({ label: 'a', href: '/a', icon: Home })).toBe(false);
    expect(isExpandable({ label: 'a', href: '/a', icon: Home, children: [] })).toBe(false);
    expect(
      isExpandable({
        label: 'a',
        href: '/a',
        icon: Home,
        children: [{ label: 'b', href: '/a/b', icon: Home }],
      })
    ).toBe(true);
  });

  it('filters children by permission and keeps the parent expandable', () => {
    const [group] = visibleNavGroups(['settings.security'], true, NAV);
    const settings = group.items.find((item) => item.href === '/admin/settings')!;

    expect(settings.children).toHaveLength(2);
    expect(isExpandable(settings)).toBe(true);
  });

  it('degrades a parent to a leaf when every child is filtered out', () => {
    const gatedOnly: CoreNavGroup[] = [
      {
        id: 'g',
        label: 'g',
        items: [
          {
            label: 'تنظیمات',
            href: '/admin/settings',
            icon: FileText,
            children: [
              {
                label: 'امنیت',
                href: '/admin/settings/security',
                icon: FileText,
                permission: 'settings.security',
              },
            ],
          },
        ],
      },
    ];

    const [group] = visibleNavGroups([], true, gatedOnly);
    const settings = group.items[0];

    // No empty `children` array is left behind, so no chevron can be derived.
    expect(settings.children).toBeUndefined();
    expect(isExpandable(settings)).toBe(false);
  });

  it('keeps gated children visible when enforcement is off', () => {
    const [group] = visibleNavGroups([], false, NAV);
    const settings = group.items.find((item) => item.href === '/admin/settings')!;

    expect(settings.children).toHaveLength(2);
  });

  it('flattens an item tree depth-first', () => {
    const flat = flattenNavItems(NAV[0].items).map((item) => item.href);

    expect(flat).toEqual([
      '/admin',
      '/admin/settings',
      '/admin/settings/general',
      '/admin/settings/security',
    ]);
  });

  it('matches nested routes against their own href', () => {
    expect(isNavItemActive('/admin/settings/security', '/admin/settings/security')).toBe(true);
    expect(isNavItemActive('/admin/settings/security', '/admin/settings')).toBe(true);
    // '/admin' stays exact so it does not light up for every nested route.
    expect(isNavItemActive('/admin/settings', '/admin')).toBe(false);
  });

  it('resolves page titles from nested navigation entries', () => {
    // Real CORE_NAV: leaf entries only, longest-prefix match.
    expect(pageTitleFor('/admin')).toBe('خانه');
    expect(pageTitleFor('/admin/blog/new')).toBe('وبلاگ');
    expect(pageTitleFor('/admin/unknown')).toBe('پنل مدیریت');
  });

  /**
   * Phase 49D-1: the directory entry is gated on `admin.users.read`, the same
   * permission the backend enforces on GET /users/directory.
   */
  it('hides the directory entry without admin.users.read and shows it with it', () => {
    const hrefs = (permissions: string[]) =>
      visibleNavGroups(permissions).flatMap((group) => group.items.map((item) => item.href));

    expect(hrefs([])).not.toContain('/admin/directory');
    expect(hrefs(['admin.users.read'])).toContain('/admin/directory');
    // Enforcement off (still loading / /rbac failed) keeps it visible; the
    // backend remains the authority.
    expect(
      visibleNavGroups([], false).flatMap((group) => group.items.map((item) => item.href))
    ).toContain('/admin/directory');
  });

  it('gates each commerce row on the permission its own surface answers to', () => {
    const hrefs = (permissions: string[]) =>
      visibleNavGroups(permissions).flatMap((group) => group.items.map((item) => item.href));

    // Without any grant the whole group is gone — and with it every href that would 403.
    expect(hrefs([])).not.toContain('/admin/commerce');
    // `commerce.read` opens the home and the register (the same list route feeds both)…
    expect(hrefs(['commerce.read'])).toContain('/admin/commerce');
    expect(hrefs(['commerce.read'])).toContain('/admin/commerce/purchases');
    // …but NOT the task workspace: its rows are decisions, and the decision grant is
    // `commerce.approve` — the permission the approval route itself enforces.
    expect(hrefs(['commerce.read'])).not.toContain('/admin/commerce/tasks');
    // The approval grant opens the task workspace without claiming the register's read.
    expect(hrefs(['commerce.approve'])).toContain('/admin/commerce/tasks');
    // Enforcement off (still loading / /rbac failed) keeps every row visible; the backend
    // remains the authority.
    expect(
      visibleNavGroups([], false).flatMap((group) => group.items.map((item) => item.href))
    ).toEqual(
      expect.arrayContaining(['/admin/commerce', '/admin/commerce/tasks', '/admin/commerce/purchases'])
    );
  });

  /**
   * Phase KPI-RUNTIME: the KPI overview is gated on a UNION of the three read remits, because
   * the five approved KPIs read from Production, Commerce and Financial alike.
   *
   * This is the first row in the catalogue that a single `permission` could not express, so
   * the test pins every direction of it: each remit ALONE opens the row (a Commerce-only
   * reader must reach the page the backend serves them), an unrelated grant does not, no
   * grant at all hides it, and enforcement-off keeps it visible exactly as every other row
   * behaves while `/rbac` is still loading.
   */
  it('shows the KPI entry to ANY of the three read remits, and to none at all', () => {
    const hrefs = (permissions: string[], enforce = true) =>
      visibleNavGroups(permissions, enforce).flatMap((group) =>
        group.items.map((item) => item.href)
      );

    expect(hrefs([])).not.toContain('/admin/kpis');
    expect(hrefs(['production.bom.read'])).toContain('/admin/kpis');
    expect(hrefs(['commerce.read'])).toContain('/admin/kpis');
    expect(hrefs(['financial.check.read'])).toContain('/admin/kpis');
    // An unrelated grant is not a KPI remit — the row stays hidden.
    expect(hrefs(['admin.users.read'])).not.toContain('/admin/kpis');
    // Enforcement off (still loading / /rbac failed) keeps it visible; the backend
    // remains the authority.
    expect(hrefs([], false)).toContain('/admin/kpis');
  });

  it('titles the directory routes, including the member detail route', () => {
    expect(pageTitleFor('/admin/directory')).toBe('دفترچه سازمانی');
    expect(pageTitleFor('/admin/directory/user-1')).toBe('دفترچه سازمانی');
  });

  /**
   * Phase 49G: the support entry is deliberately NOT permission-gated — filing and
   * reading your own ticket is personal, and the requester-facing backend routes
   * carry no `@Roles()` check. `support.tickets` exists in the catalogue but is not
   * seeded, so gating on it would hide the page from everyone.
   */
  it('always shows the support entry, gated on nothing', () => {
    const hrefs = (permissions: string[], enforce = true) =>
      visibleNavGroups(permissions, enforce).flatMap((group) =>
        group.items.map((item) => item.href)
      );

    expect(hrefs([])).toContain('/admin/support');
    expect(hrefs(['admin.support.manage'])).toContain('/admin/support');
    expect(hrefs([], false)).toContain('/admin/support');
  });

  /**
   * Phase 49C-5: the support entry leaves the STATIC rail (the header user menu's
   * «پشتیبانی» entry between تنظیمات and خروج is its dedicated access path — it does
   * NOT live in the Settings Center), but it stays a nav target:
   * `visibleNavGroups` keeps returning it for titles, drift checks and the
   * favourites/recent resolver, while `railNavGroups` filters the static row out.
   */
  it('hides support from the static rail while keeping it a nav target', () => {
    const railHrefs = railNavGroups([]).flatMap((group) => group.items.map((item) => item.href));
    expect(railHrefs).not.toContain('/admin/support');
    // The services group survives with its remaining entry — never an empty header.
    expect(railHrefs).toContain('/admin/surveys');

    const visibleHrefs = visibleNavGroups([]).flatMap((group) =>
      group.items.map((item) => item.href)
    );
    expect(visibleHrefs).toContain('/admin/support');
  });

  it('titles every support route, including the detail and create routes', () => {
    expect(pageTitleFor('/admin/support')).toBe('پشتیبانی');
    expect(pageTitleFor('/admin/support/new')).toBe('پشتیبانی');
    expect(pageTitleFor('/admin/support/ticket-1')).toBe('پشتیبانی');
  });

  /**
   * Phase 49J-0: the AI entry IS gated, and on the READ permission rather than the
   * manage one — OPERATIONS_ADMIN holds `admin.ai.read` only and is entitled to see
   * which provider and model are live. Unlike `support.tickets` (49G), both
   * `admin.ai.*` strings are seeded in core_db, so the gate is real.
   *
   * Phase 49C-2: the platform group is hidden from the RAIL for everyone, so the
   * rail output can no longer express this gate — the same permission semantics now
   * live in the Settings Center tabs (`CoreSettingsCenter.spec.tsx` pins
   * `admin.ai.read` visibility there). What the rail must still guarantee is the
   * STRUCTURE: the declared AI entry keeps its permission string, stays a leaf, and
   * the gate behaves through `visibleNavGroups` on any NON-hidden source.
   */
  it('keeps the AI permission gate on the declared item, not on the manage grant', () => {
    const aiItem = flattenNavItems(CORE_NAV.flatMap((group) => group.items)).find(
      (item) => item.href === '/admin/ai'
    );

    // The declared gate is the READ permission the backend enforces, never the manage one.
    expect(aiItem?.permission).toBe('admin.ai.read');
    expect(isExpandable(aiItem!)).toBe(false);
  });

  it('hides the platform settings group from the rail for everyone', () => {
    // Phase 49C-2: «تنظیمات پلتفرم» is no longer primary navigation. The group is
    // dropped from `visibleNavGroups` output regardless of permissions — including
    // the enforcement-off case, because hiding a config destination is not the same
    // as hiding a primary page behind a transient RBAC failure.
    const groupIds = (permissions: string[], enforce = true) =>
      visibleNavGroups(permissions, enforce).map((group) => group.id);

    expect(
      groupIds([
        'admin.ai.read',
        'admin.integrations.read',
        'admin.modules.read',
        'admin.observability.read',
      ])
    ).not.toContain('platform');
    expect(groupIds([])).not.toContain('platform');
    expect(groupIds([], false)).not.toContain('platform');

    // While the group leaves the rail, the DECLARED catalogue keeps its hrefs: the
    // drift test below still checks them against the server's allowlist, and direct
    // routes keep working.
    expect(uniqueNavHrefs(CORE_NAV.flatMap((group) => group.items)).map((i) => i.href)).toContain(
      '/admin/ai'
    );
  });

  it('titles the AI route', () => {
    expect(pageTitleFor('/admin/ai')).toBe('هوش مصنوعی');
  });

  it('titles the settings page via the non-nav alias map', () => {
    // The settings destination is intentionally NOT a `CORE_NAV` item (the 49K drift
    // test pins the catalogue to the server's `NAV_TARGETS`), so its title comes from
    // the alias — and it must stay unrecordable, i.e. not a nav target.
    expect(pageTitleFor('/admin/settings')).toBe('تنظیمات');
    expect(isNavTarget('/admin/settings')).toBe(false);
  });

  it('titles the reporting landing route via the non-nav alias map', () => {
    // Phase REPORTING-UI: `/admin/reporting` is a REAL route with NO rail row — a nav
    // row is a platform-navigation decision (Production/Financial first-UI-phase
    // precedent), and the rail must not advertise a business capability that does not
    // exist yet. So its shell title comes from the alias, exactly like settings, and
    // the route stays unrecordable: not a nav target, no favourite, no recent entry,
    // no server `NAV_TARGETS` row (the drift test below stays entry-for-entry).
    expect(pageTitleFor('/admin/reporting')).toBe('گزارش‌گیری');
    expect(isNavTarget('/admin/reporting')).toBe(false);
  });

  it('titles the platform settings pages even though the rail hides them', () => {
    // Phase 49C-2: the «تنظیمات پلتفرم» group is hidden from the SIDEBAR only; the
    // hrefs stay declared nav targets, so direct URLs keep their resolved titles.
    expect(pageTitleFor('/admin/ai')).toBe('هوش مصنوعی');
    expect(pageTitleFor('/admin/modules')).toBe('ماژول‌ها و سرویس‌های متصل');
    expect(isNavTarget('/admin/ai')).toBe(true);
  });

  it('keeps the AI entry a leaf, so it renders no chevron', () => {
    const ai = flattenNavItems(CORE_NAV.flatMap((group) => group.items)).find(
      (item) => item.href === '/admin/ai'
    )!;

    expect(isExpandable(ai)).toBe(false);
  });
});

/**
 * Phase 49K (N3): `isNavTarget` decides whether a page visit is worth recording.
 *
 * It exists to keep the client from sending `PATCH /me/preferences` requests the server
 * will discard. `apps/api/.../nav-catalogue.ts` re-validates every href, so a mistake
 * here cannot store an unauthorized route — it can only produce pointless writes, or
 * silently stop recording a page that the rail is supposed to remember.
 */
describe('isNavTarget', () => {
  /** Hand-copied from the server's `NAV_TARGETS`; the drift test below is the point. */
  const SERVER_NAV_TARGETS = [
    '/admin',
    // Phase MANAGEMENT-DASHBOARD-V1: the management dashboard. Gated on the union of the four
    // V1 source remits; the drift test compares hrefs, the gate is pinned by `visibleNavGroups`.
    '/admin/management',
    // Phase KPI-RUNTIME: the KPI overview. Gated on a UNION of the three read remits
    // (`production.bom.read` / `commerce.read` / `financial.check.read`) rather than a single
    // permission, because the five approved KPIs span all three domains. The drift test
    // compares HREFS, so this line pins the entry's existence, not its gate — the gate is
    // pinned by the `visibleNavGroups` suite below.
    '/admin/kpis',
    '/admin/profile',
    '/admin/notifications',
    '/admin/messages',
    '/admin/calendar',
    '/admin/directory',
    '/admin/blog',
    '/admin/support',
    '/admin/surveys',
    '/admin/ai',
    '/admin/integrations',
    '/admin/modules',
    // Phase 49M-2. Present here and in `NAV_TARGETS`, so it is FAVOURITABLE. It is also in
    // the server's `RECENT_EXCLUDED_PREFIXES`, so it is never RECORDED — the two lists answer
    // different questions, and `isNavTarget` deliberately ignores the second one because
    // `CoreShell` checks it before recording anyway.
    '/admin/observability',
    // Phase 50: Official Correspondence (ungated personal workflow; see core-nav).
    // Dynamic letter views stay off both allowlists by design — exact hrefs only.
    '/admin/correspondence',
    '/admin/correspondence/new',
    '/admin/correspondence/drafts',
    '/admin/correspondence/sent',
    '/admin/correspondence/search',
    '/admin/correspondence/archive',
    // Phase 51-HR-2: Human Resources. One entry per declared row, each gated on the read its
    // own controller enforces. The employee DETAIL route stays off both allowlists by design —
    // exact hrefs only, exactly like every other detail page.
    '/admin/hr',
    '/admin/hr/employees',
    '/admin/hr/organization',
    '/admin/hr/positions',
    // Phase 51-HR-2E: the attendance register. ONE entry, gated on `hr.attendance.read` —
    // the read `AttendanceController.list` enforces. A register row's own id is never a
    // target, for the same reason no personnel file is: exact hrefs only.
    '/admin/hr/attendance',
    // Phase 51-HR-2F: the personnel traffic report. ONE more entry, on the SAME
    // `hr.attendance.read`: the report is `GET /hr/attendance` asked with a window that is
    // always bounded, so the phase added a screen and not an API route. The window itself is
    // a query string, which `usePathname()` never includes — so the bare path is the whole
    // target, and a dated path like `/admin/hr/traffic-report/2026-09-18` is not one.
    '/admin/hr/traffic-report',
    // Phase 51-HR-3A: the leave register. ONE more entry, gated on `hr.leave.read` — the read
    // BOTH leave controllers enforce and the read the leave seed migration grants. A request's
    // own id is never a target, and the tenant's leave CATALOGUE has no route of its own: it is
    // rendered inside the register, so there is nothing further to allowlist.
    '/admin/hr/leave',
    // Phase 54-I: the leave-policy configuration and simulation surface. Gated on
    // `hr.leave.policy` — NOT the read above — because the surface exists to exercise
    // configuration authority: a read-only operator reaching it would find every action refused.
    // It is the ENTRY page, not a directory (there is no policy-list endpoint), so the
    // per-policy route it leads to embeds a database id and is therefore never a target here.
    '/admin/hr/leave-policies',
    // Phase 55: Mission. THREE entries, one per declared row, and — unlike the HR rows above — they
    // do NOT share a gate: the register answers to `hr.mission.read`, the approval queue to
    // `hr.mission.approve` (its screen deliberately does not consult the read), and the rule-set
    // surface to `hr.mission.policy` (which its screen says is required INSTEAD OF the other two).
    // `hr.mission.manage` is absent because it gates the writes inside the register, not the entry
    // to any page. All four strings are seeded by
    // 20260923131000_seed_hr_mission_permission_grant, so the gates are real rather than
    // aspirational. `hr.mission.read` still opens the configuration page, which renders its own
    // section list; the nav row is the AUTHORING entry and is gated on authoring authority.
    '/admin/hr/missions',
    '/admin/hr/missions/approvals',
    '/admin/hr/missions/configuration',
    // PHASE UI-1: Procurement. THREE entries, one per declared row. Home and the register
    // share `commerce.read` (they read the same list route); the task workspace is gated on
    // `commerce.approve` — the grant C1's ONLY decision route answers to. The create and
    // detail routes do not exist yet, so — exact hrefs only — nothing else is allowlisted.
    '/admin/commerce',
    '/admin/commerce/tasks',
    '/admin/commerce/purchases',
  ];

  it('accepts every href the server allowlists', () => {
    for (const href of SERVER_NAV_TARGETS) {
      expect(isNavTarget(href)).toBe(true);
    }
  });

  it('matches exactly, never by prefix', () => {
    // `isNavItemActive` DOES match descendants, to highlight the parent row. Recording
    // must not: `/admin/blog/42` is a post, and storing it would put an href in the
    // recent list that resolves to no navigation row at all.
    expect(isNavTarget('/admin/blog/42')).toBe(false);
    expect(isNavTarget('/admin/surveys/7/results')).toBe(false);
    expect(isNavTarget('/admin/profile/login-history')).toBe(false);
  });

  it('rejects near-misses that would otherwise look plausible', () => {
    expect(isNavTarget('/admin/')).toBe(false);
    expect(isNavTarget('/admin/blog?page=2')).toBe(false);
    expect(isNavTarget('/Admin')).toBe(false);
    expect(isNavTarget('')).toBe(false);
    expect(isNavTarget('/login')).toBe(false);
  });

  it('ignores permissions, because recording is not authorization', () => {
    // The client cannot be the authority here: `/rbac` may still be loading when the
    // visit happens. The server filters the href against the caller's grants on write
    // and again on read, so admitting it here is safe and losing it would not be.
    expect(isNavTarget('/admin/blog')).toBe(true);
    expect(isNavTarget('/admin/ai')).toBe(true);
  });

  it('agrees with the server allowlist, entry for entry', () => {
    const declared = uniqueNavHrefs(CORE_NAV.flatMap((group) => group.items)).map(
      (item) => item.href
    );

    // Adding a nav item without adding a NAV_TARGET makes the page unrecordable and the
    // failure is silent at runtime — so it fails here instead.
    expect([...declared].sort()).toEqual([...SERVER_NAV_TARGETS].sort());
  });
});

/**
 * Phase 49C-3: the rail's STATIC list drops personal destinations that already have
 * dedicated access paths (header user menu / header bell / date chip), while the
 * navigation catalogue itself — favourites, recents, titles, targets, permissions —
 * must not lose them.
 */
describe('Phase 49C-3: rail deduplication', () => {
  const DEDICATED_ACCESS_HREFS = ['/admin/profile', '/admin/notifications', '/admin/calendar'];

  const hrefsOf = (groups: CoreNavGroup[]) =>
    groups.flatMap((group) => group.items).map((item) => item.href);

  const railHrefs = (permissions: string[]) => hrefsOf(railNavGroups(permissions, true));

  const visibleHrefs = (permissions: string[]) => hrefsOf(visibleNavGroups(permissions, true));

  it('removes the personal destinations from the STATIC rail only', () => {
    const permissions = ['admin.users.read', 'blog.read'];

    for (const href of DEDICATED_ACCESS_HREFS) {
      expect(railHrefs(permissions)).not.toContain(href);
    }

    // The catalogue itself keeps them — favourites and recents resolve against it.
    for (const href of DEDICATED_ACCESS_HREFS) {
      expect(visibleHrefs(permissions)).toContain(href);
    }
  });

  it('keeps the unrelated primary navigation in the rail', () => {
    const rail = railHrefs(['admin.users.read', 'blog.read']);

    expect(rail).toContain('/admin');
    expect(rail).toContain('/admin/messages');
    expect(rail).toContain('/admin/directory');
    expect(rail).toContain('/admin/blog');
    // Phase 49C-5: support is NO LONGER in the static rail — the header user menu's
    // «پشتیبانی» entry is its dedicated access path (asserted in CoreHeader.spec.tsx) —
    // while the rest of the services group stays.
    expect(rail).not.toContain('/admin/support');
    expect(rail).toContain('/admin/surveys');
  });

  it('keeps enforcing permissions in the rail', () => {
    const NAV: CoreNavGroup[] = [
      {
        id: 'g',
        label: 'گروه',
        items: [
          { label: 'باز', href: '/a', icon: Home },
          { label: 'گیت‌شده', href: '/b', icon: Home, permission: 'x' },
        ],
      },
    ];

    expect(hrefsOf(railNavGroups([], true, NAV))).toEqual(['/a']);
    expect(hrefsOf(railNavGroups(['x'], true, NAV))).toEqual(['/a', '/b']);
  });

  it('never leaves an empty group behind', () => {
    const ALL_HIDDEN: CoreNavGroup[] = [
      {
        id: 'gone',
        label: 'گروه محو',
        items: [
          { label: 'حساب من', href: '/admin/profile', icon: Home, sidebarHidden: true },
          { label: 'اعلان‌ها', href: '/admin/notifications', icon: Home, sidebarHidden: true },
        ],
      },
      {
        id: 'stays',
        label: 'گروه باقی',
        items: [{ label: 'خانه', href: '/admin', icon: Home }],
      },
    ];

    const rail = railNavGroups([], true, ALL_HIDDEN);
    expect(rail.map((group) => group.id)).toEqual(['stays']);

    // The resolver view keeps the hidden group, so stored hrefs keep resolving.
    expect(visibleNavGroups([], true, ALL_HIDDEN).map((group) => group.id)).toEqual([
      'gone',
      'stays',
    ]);
  });

  it('keeps the hidden routes reachable as direct targets with their titles', () => {
    for (const href of DEDICATED_ACCESS_HREFS) {
      expect(isNavTarget(href)).toBe(true);
    }

    expect(pageTitleFor('/admin/profile')).toBe('حساب من');
    expect(pageTitleFor('/admin/notifications')).toBe('اعلان‌ها');
    expect(pageTitleFor('/admin/calendar')).toBe('تقویم');
  });

  it('is a pure pass-through when nothing declares sidebarHidden', () => {
    const PLAIN: CoreNavItem[] = [{ label: 'خانه', href: '/admin', icon: Home }];
    const groups: CoreNavGroup[] = [{ id: 'g', label: 'گروه', items: PLAIN }];

    expect(toRailGroups(groups)).toEqual(groups);
  });
});

/**
 * Phase 51-HR-2: Human Resources enters the rail as a FLAT group. `/admin/hr` is a real
 * page — counters plus the latest personnel files — so it is a row BESIDE its areas
 * rather than a section toggle above them, unlike the مکاتبات tree.
 *
 * Every row is gated on the read permission the HR controller behind it enforces, so a
 * caller holding one HR read sees exactly the rows that read covers.
 *
 * Phase 51-HR-2E added the attendance register as the FOURTH area: `hr.attendance.read` on
 * `GET /hr/attendance`, seeded so the gate is real.
 *
 * Phase 51-HR-2F added the personnel traffic report as the FIFTH: the SAME
 * `GET /hr/attendance` read, asked with a window that is always bounded (one Jalali day, or a
 * Gregorian از/تا pair). No new endpoint means no new authority, so the report is gated on the
 * SAME `hr.attendance.read` the register already asks for.
 */
describe('Phase 51-HR-2: the HR group', () => {
  const HR_READS = [
    'hr.employees.read',
    'hr.organization.read',
    'hr.positions.read',
    'hr.attendance.read',
    // Phase 51-HR-3A: what BOTH leave controllers enforce — the register `GET
    // /hr/leave-requests` and the catalogue `GET /hr/leave-types`. ONE read, because a tenant
    // that may see what was requested is a tenant that may see the kinds it named.
    'hr.leave.read',
  ];

  /**
   * ONE ROW IS NOT READ-GATED, AND THAT IS THE POINT OF IT.
   *
   * Phase 54-I added `/admin/hr/leave-policies`, which exists to exercise CONFIGURATION authority,
   * so it answers to `hr.leave.policy` — the grant the simulate route enforces — and deliberately
   * not to a read: a read entitles an operator to see the register, not to reconfigure what
   * governs it. It is therefore kept OUT of `HR_READS` and asserted on its own, so the two gates
   * can never silently collapse into one.
   */
  const POLICY_GRANTS = ['hr.leave.policy'];

  /**
   * Phase 55: the three Mission rows do NOT share a gate — each answers to the grant its own screen
   * consults — so all three are listed here rather than folded into `HR_READS`, for exactly the
   * reason `POLICY_GRANTS` was split out above: collapsing them into the Mission READ would make a
   * future single-grant regression pass silently. `hr.mission.read` is the register's READ and is NOT
   * in `HR_READS` because it is asserted beside its two siblings, so the three can be compared.
   *
   * `hr.mission.manage` is deliberately absent: it is a write grant and opens no row at all.
   */
  const MISSION_GRANTS = ['hr.mission.read', 'hr.mission.approve', 'hr.mission.policy'];

  const MISSION_HREFS = [
    '/admin/hr/missions',
    '/admin/hr/missions/approvals',
    '/admin/hr/missions/configuration',
  ];

  /** The two attendance rows share `hr.attendance.read`; neither adds a grant. */
  const ATTENDANCE_HREFS = ['/admin/hr/attendance', '/admin/hr/traffic-report'];

  const hrHrefs = (permissions: string[], enforce = true) =>
    visibleNavGroups(permissions, enforce)
      .filter((group) => group.id === 'hr')
      .flatMap((group) => group.items.map((item) => item.href));

  it('is one flat group: the module page and its areas, with no toggle in sight', () => {
    const group = visibleNavGroups([...HR_READS, ...POLICY_GRANTS, ...MISSION_GRANTS]).find(
      (entry) => entry.id === 'hr'
    )!;

    expect(group.items.map((item) => item.href)).toEqual([
      '/admin/hr',
      '/admin/hr/employees',
      '/admin/hr/organization',
      '/admin/hr/positions',
      ...ATTENDANCE_HREFS,
      '/admin/hr/leave',
      '/admin/hr/leave-policies',
      ...MISSION_HREFS,
    ]);

    // Flat on purpose: the module page is a destination, so nothing here is a section
    // toggle and no page is orphaned behind a chevron.
    for (const item of group.items) {
      expect(isExpandable(item)).toBe(false);
    }
  });

  it('gates every row on the read its own controller enforces', () => {
    expect(hrHrefs([])).toEqual([]);

    // Holding ONE HR read opens exactly the rows that read covers. The module page is
    // gated on `hr.organization.read` — the read its summary endpoint enforces.
    expect(hrHrefs(['hr.positions.read'])).toEqual(['/admin/hr/positions']);
    expect(hrHrefs(['hr.organization.read'])).toEqual(['/admin/hr', '/admin/hr/organization']);
    expect(hrHrefs(['hr.employees.read'])).toEqual(['/admin/hr/employees']);
    // BOTH attendance surfaces answer to the one grant: the report asks the SAME read as the
    // register, so a caller who may see the punch log sees the report over it. And both are
    // READ pages: `hr.attendance.read` opens them, while `hr.attendance.manage` — the punch
    // permissions — is deliberately not what either nav row asks for.
    expect(hrHrefs(['hr.attendance.read'])).toEqual(ATTENDANCE_HREFS);
    expect(hrHrefs(['hr.attendance.manage'])).toEqual([]);
    // Phase 51-HR-3A: the register is READ-gated, exactly like the rows above. A manage grant
    // writes; it does not entitle anybody to open a page they cannot read.
    expect(hrHrefs(['hr.leave.read'])).toEqual(['/admin/hr/leave']);
    expect(hrHrefs(['hr.leave.manage'])).toEqual([]);
    // Phase 54-I: the configuration surface answers to a DIFFERENT grant — the one the simulate
    // route enforces. So neither grant opens the other's row, which is the point: a read entitles
    // a user to the register, and `hr.leave.policy` entitles them to configure.
    expect(hrHrefs(POLICY_GRANTS)).toEqual(['/admin/hr/leave-policies']);
    expect(hrHrefs(['hr.leave.read'])).not.toContain('/admin/hr/leave-policies');
    expect(hrHrefs(POLICY_GRANTS)).not.toContain('/admin/hr/leave');
    // Phase 55: THREE Mission rows, THREE different gates, and they never open one another. The
    // register's read does NOT open the approval queue or the rule set (both screens refuse to be
    // operated by a reader), the approver grant opens ONLY the queue, and the policy grant opens
    // ONLY the authoring surface.
    expect(hrHrefs(['hr.mission.read'])).toEqual(['/admin/hr/missions']);
    expect(hrHrefs(['hr.mission.approve'])).toEqual(['/admin/hr/missions/approvals']);
    expect(hrHrefs(['hr.mission.policy'])).toEqual(['/admin/hr/missions/configuration']);
    expect(hrHrefs(['hr.mission.read'])).not.toContain('/admin/hr/missions/approvals');
    expect(hrHrefs(['hr.mission.read'])).not.toContain('/admin/hr/missions/configuration');
    expect(hrHrefs(['hr.mission.approve'])).not.toContain('/admin/hr/missions');
    expect(hrHrefs(['hr.mission.policy'])).not.toContain('/admin/hr/missions');
    // The MANAGE grant opens nothing: it drives the writes inside the register, and a write grant is
    // not what entitles a person to open a page — the same rule `hr.leave.manage` follows.
    expect(hrHrefs(['hr.mission.manage'])).toEqual([]);
    // The FEATURE entitlement is not a navigation gate anywhere in the catalogue: `hr.mission.read`
    // is a permission, and an entitlement token would never open a nav row.
    expect(hrHrefs(['hr/mission', 'mission', 'hr.mission'])).toEqual([]);
    // Seven read-gated rows, plus the one leave-configuration row and the three Mission rows.
    expect(hrHrefs(HR_READS)).toHaveLength(7);
    expect(hrHrefs([...HR_READS, ...POLICY_GRANTS])).toHaveLength(8);
    expect(hrHrefs([...HR_READS, ...POLICY_GRANTS, ...MISSION_GRANTS])).toHaveLength(11);

    // Enforcement off (still loading / `/rbac` failed) keeps them visible; the backend
    // stays the authority on every HR route.
    expect(hrHrefs([], false)).toHaveLength(11);
  });

  it('titles every HR route, including the personnel-file detail route', () => {
    expect(pageTitleFor('/admin/hr')).toBe('منابع انسانی');
    expect(pageTitleFor('/admin/hr/employees')).toBe('کارکنان');
    expect(pageTitleFor('/admin/hr/employees/e-1')).toBe('کارکنان');
    expect(pageTitleFor('/admin/hr/organization')).toBe('چارت سازمانی');
    expect(pageTitleFor('/admin/hr/positions')).toBe('سمت‌ها');
    expect(pageTitleFor('/admin/hr/attendance')).toBe('حضور و غیاب');
    expect(pageTitleFor('/admin/hr/traffic-report')).toBe('گزارش رفت‌وآمد پرسنل');
    expect(pageTitleFor('/admin/hr/leave')).toBe('مرخصی‌ها');
    expect(pageTitleFor('/admin/hr/leave-policies')).toBe('سیاست‌های مرخصی');
    // Phase 55: the three Mission rows carry the same labels their own pages declare in
    // `metadata.title`, so the header and the rail agree.
    expect(pageTitleFor('/admin/hr/missions')).toBe('ماموریت‌ها');
    expect(pageTitleFor('/admin/hr/missions/approvals')).toBe('تأیید ماموریت‌ها');
    expect(pageTitleFor('/admin/hr/missions/configuration')).toBe('پیکربندی ماموریت‌ها');
  });

  it('records the module and its areas, but never a personnel file', () => {
    for (const href of [
      '/admin/hr',
      '/admin/hr/employees',
      '/admin/hr/organization',
      '/admin/hr/positions',
      '/admin/hr/attendance',
      '/admin/hr/traffic-report',
      '/admin/hr/leave',
      '/admin/hr/leave-policies',
      ...MISSION_HREFS,
    ]) {
      expect(isNavTarget(href)).toBe(true);
    }

    // Same rule as every other detail page: an exact allowlist cannot hold a database id.
    expect(isNavTarget('/admin/hr/employees/e-1')).toBe(false);
    expect(isNavTarget('/admin/hr/attendance/att-1')).toBe(false);
    // The report takes no path segment at all: its window lives in the query string, which
    // `usePathname()` never includes — so a deeper path is a different route, not this row.
    expect(isNavTarget('/admin/hr/traffic-report/2026-09-18')).toBe(false);
    // The leave register has NO detail route to exclude and no catalogue route of its own: the
    // catalogue is rendered on the register, so a request's own id is the only near-miss left.
    expect(isNavTarget('/admin/hr/leave/req-1')).toBe(false);
    expect(isNavTarget('/admin/hr/leave-types')).toBe(false);
    // Phase 54-I: the per-policy surface is reachable but NOT recordable, because its path IS a
    // policy id. An allowlist entry must be exact and database-independent, so history and
    // favourites stop at the entry page — the same rule as a personnel file.
    expect(isNavTarget('/admin/hr/leave-policies/policy-1')).toBe(false);
    // Phase 55: the Mission module's id-bearing routes are reachable but NOT recordable, for the same
    // reason as a personnel file: a per-mission, per-step or per-version href embeds a database id, and
    // an allowlist target must be exact and database-independent. The three declared rows are the only
    // Mission entries, and each appears EXACTLY ONCE — no alias and no trailing-slash variant.
    expect(isNavTarget('/admin/hr/missions/mis-1')).toBe(false);
    expect(isNavTarget('/admin/hr/missions/approvals/step-1')).toBe(false);
    expect(isNavTarget('/admin/hr/missions/configuration/version-1')).toBe(false);
    for (const href of MISSION_HREFS) {
      expect(MISSION_HREFS.filter((candidate) => candidate === href)).toHaveLength(1);
      expect(isNavTarget(`${href}/`)).toBe(false);
    }
  });
});

/**
 * Phase 51-HR-2: `activeNavHref` keeps exactly ONE row selected now that a declared href
 * (`/admin/hr`) can be the prefix of another declared row in the same group
 * (`/admin/hr/employees`). `CoreSidebar` renders the row this helper picks, and nothing else.
 */
describe('activeNavHref', () => {
  const declared = () => flattenNavItems(CORE_NAV.flatMap((group) => group.items));

  it('picks the most specific row when one declared href shadows another', () => {
    expect(activeNavHref('/admin/hr/employees', declared())).toBe('/admin/hr/employees');
    // The module page still wins on its own route.
    expect(activeNavHref('/admin/hr', declared())).toBe('/admin/hr');
  });

  it('still resolves a detail route to the row that owns it', () => {
    // A personnel file has no row of its own, so its AREA stays selected…
    expect(activeNavHref('/admin/hr/employees/e-1', declared())).toBe('/admin/hr/employees');
    // …exactly like a blog post keeps the blog row, which is why `isNavItemActive` is a
    // prefix rule in the first place.
    expect(activeNavHref('/admin/blog/42', declared())).toBe('/admin/blog');
  });

  it('leaves an expandable parent to its own href', () => {
    // مکاتبات is a SECTION TOGGLE: the sub-tree keeps it open, but the selected row is the
    // child. That is the Phase 50 rule, now expressed by the same helper.
    expect(activeNavHref('/admin/correspondence/drafts', declared())).toBe(
      '/admin/correspondence/drafts'
    );
  });

  it('resolves nothing for a path the catalogue does not declare', () => {
    expect(activeNavHref('/admin/unknown', declared())).toBeNull();
    expect(activeNavHref('/admin', [])).toBeNull();
  });
});
