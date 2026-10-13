import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileText, Home, Settings } from 'lucide-react';
import { CoreSidebar } from '../CoreSidebar';
import { visibleNavGroups, type CoreNavGroup } from '../core-nav';

/**
 * Phase 48C.1: sidebar-level coverage for the four RTL navigation defects.
 *
 * `visibleNavGroups` is mocked so a navigation tree with real children can be
 * exercised; every other core-nav helper stays real, because the chevron rule
 * (`isExpandable`) is exactly what is under test.
 *
 * Phase 49I: the rail now also renders CoreDateChip, which calls `useRouter` and reads
 * `GET /calendar/today`. Both are stubbed here so these tests stay about navigation
 * affordances — the chip has its own suite in CoreDateChip.spec.tsx.
 */
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin',
}));

jest.mock('@/lib/calendar-api', () => ({
  ...jest.requireActual('@/lib/calendar-api'),
  // Never resolves, so the chip renders nothing and cannot interfere with the
  // navigation assertions below.
  getCalendarToday: jest.fn(() => new Promise(() => undefined)),
  getCalendarMonth: jest.fn(() => new Promise(() => undefined)),
}));

jest.mock('../core-nav', () => ({
  ...jest.requireActual('../core-nav'),
  visibleNavGroups: jest.fn(),
}));

const visibleNavGroupsMock = visibleNavGroups as jest.MockedFunction<typeof visibleNavGroups>;

const NAV_WITH_CHILDREN: CoreNavGroup[] = [
  {
    id: 'overview',
    label: 'عمومی',
    items: [
      // Leaf: icon + label only.
      { label: 'خانه', href: '/admin', icon: Home },
      // Parent: two real children.
      {
        label: 'تنظیمات',
        href: '/admin/settings',
        icon: Settings,
        children: [
          { label: 'پیکربندی', href: '/admin/settings/general', icon: FileText },
          { label: 'امنیت', href: '/admin/settings/security', icon: FileText },
        ],
      },
      // Declares children, but the array is empty — still a leaf.
      { label: 'وبلاگ', href: '/admin/blog', icon: FileText, children: [] },
    ],
  },
];

function renderSidebar(
  overrides: Partial<React.ComponentProps<typeof CoreSidebar>> = {},
  groups: CoreNavGroup[] = NAV_WITH_CHILDREN,
) {
  visibleNavGroupsMock.mockReturnValue(groups);

  const props: React.ComponentProps<typeof CoreSidebar> = {
    pathname: '/admin',
    permissions: [],
    collapsed: false,
    onToggleCollapsed: jest.fn(),
    ...overrides,
  };

  return { ...render(<CoreSidebar {...props} />), props };
}

function itemByLabel(label: string) {
  return screen.getAllByTestId('core-nav-item').find((node) => node.textContent?.includes(label))!;
}

describe('CoreSidebar navigation affordances', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('renders no toggle for a leaf item', () => {
    renderSidebar();

    const home = itemByLabel('خانه');
    expect(home).toHaveAttribute('data-expandable', 'false');
    expect(within(home).queryByTestId('core-nav-toggle')).toBeNull();
  });

  it('renders no toggle when children is an empty array', () => {
    renderSidebar();

    const blog = itemByLabel('وبلاگ');
    expect(blog).toHaveAttribute('data-expandable', 'false');
    expect(within(blog).queryByTestId('core-nav-toggle')).toBeNull();
  });

  it('renders exactly one toggle, on the item that has children', () => {
    renderSidebar();

    const toggles = screen.getAllByTestId('core-nav-toggle');
    expect(toggles).toHaveLength(1);

    const settings = itemByLabel('تنظیمات');
    expect(settings).toHaveAttribute('data-expandable', 'true');
    expect(within(settings).getByTestId('core-nav-toggle')).toBe(toggles[0]);
  });

  it('opens and closes the sub-menu by clicking the parent row, never navigating', async () => {
    const user = userEvent.setup();
    const onNavigate = jest.fn();
    renderSidebar({ onNavigate });

    const toggle = screen.getByTestId('core-nav-toggle');
    expect(toggle).toHaveAttribute('data-open', 'false');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'امنیت' })).toBeNull();

    await user.click(toggle);

    expect(screen.getByTestId('core-nav-toggle')).toHaveAttribute('data-open', 'true');
    expect(screen.getByRole('link', { name: 'امنیت' })).toHaveAttribute(
      'href',
      '/admin/settings/security',
    );
    // A toggle is not a destination — no navigation is reported for the drawer.
    expect(onNavigate).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('core-nav-toggle'));

    expect(screen.getByTestId('core-nav-toggle')).toHaveAttribute('data-open', 'false');
    expect(screen.queryByRole('link', { name: 'امنیت' })).toBeNull();
  });

  it('toggles children with Enter and Space on the parent toggle', async () => {
    const user = userEvent.setup();
    renderSidebar();

    screen.getByTestId('core-nav-toggle').focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('core-nav-toggle')).toHaveAttribute('data-open', 'true');

    await user.keyboard(' ');
    expect(screen.getByTestId('core-nav-toggle')).toHaveAttribute('data-open', 'false');
  });

  it('auto-expands the parent that contains the active child route', () => {
    renderSidebar({ pathname: '/admin/settings/security' });

    expect(screen.getByTestId('core-nav-toggle')).toHaveAttribute('data-open', 'true');
    expect(itemByLabel('امنیت')).toHaveAttribute('data-active', 'true');
    // Phase 50-LOVABLE-PARITY: only the selected row lights up — the parent toggle
    // must NOT inherit the active state from a child route.
    expect(itemByLabel('تنظیمات')).toHaveAttribute('data-active', 'false');
  });

  it('keeps the expandable parent label start-aligned like every leaf row', () => {
    renderSidebar();

    const toggle = screen.getByTestId('core-nav-toggle');
    // A `<button>` computes `text-align: center` from the UA sheet, and the label is a
    // flex-greedy span — without `text-start` the parent's label floats MID-ROW while
    // every leaf `<Link>` (text-align default `start`) hugs its icon. This class is the
    // whole fix, so it gets pinned here (computed-style level is covered by ISSUE B6 in
    // phase50c-corr-correction-qa.mjs).
    expect(toggle).toHaveClass('text-start');
    expect(toggle).not.toHaveClass('text-center');
    expect(toggle).not.toHaveClass('text-right');
  });

  it('drops the toggle in the collapsed rail, where a sub-tree does not fit', () => {
    renderSidebar({ collapsed: true });

    expect(screen.getByTestId('core-sidebar')).toHaveAttribute('data-collapsed', 'true');
    expect(screen.queryAllByTestId('core-nav-toggle')).toHaveLength(0);
    const settings = itemByLabel('تنظیمات');
    expect(settings).toHaveAttribute('data-expandable', 'false');
    // The collapsed parent degrades to a plain link into its section.
    expect(within(settings).getByRole('link')).toHaveAttribute('href', '/admin/settings');
  });

  it('renders exactly one active indicator, on the active parent row, hugging the right edge', () => {
    renderSidebar({ pathname: '/admin/settings' });

    // The parent is active on its OWN route, so its edge marker renders — and it is
    // the only one: no other row matches `/admin/settings`.
    const indicators = screen.getAllByTestId('core-nav-active-indicator');
    expect(indicators).toHaveLength(1);
    expect(
      within(itemByLabel('تنظیمات')).queryByTestId('core-nav-active-indicator'),
    ).not.toBeNull();
    for (const indicator of indicators) {
      // `start-0` is the right edge under dir="rtl".
      expect(indicator).toHaveClass('start-0');
      expect(indicator).not.toHaveClass('end-0');
    }
  });

  it('flips the collapse control between the collapse and expand actions', () => {
    const { unmount } = renderSidebar({ collapsed: false });

    const collapse = screen.getByTestId('core-collapse-toggle');
    expect(collapse).toHaveAttribute('data-action', 'collapse');
    expect(collapse).toHaveAttribute('aria-label', 'بستن منو');
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    unmount();
    renderSidebar({ collapsed: true });

    const expand = screen.getByTestId('core-collapse-toggle');
    expect(expand).toHaveAttribute('data-action', 'expand');
    expect(expand).toHaveAttribute('aria-label', 'باز کردن منو');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
  });

  it('replaces the collapse control with a close control in the drawer variant', async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    renderSidebar({ variant: 'drawer', collapsed: true, onClose });

    // The drawer ignores `collapsed` and always renders expanded.
    expect(screen.getByTestId('core-sidebar-drawer')).toHaveAttribute('data-collapsed', 'false');
    expect(screen.queryByTestId('core-collapse-toggle')).toBeNull();

    await user.click(screen.getByTestId('core-drawer-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports selection so the drawer can close on navigation', async () => {
    const user = userEvent.setup();
    const onNavigate = jest.fn();
    renderSidebar({ variant: 'drawer', onNavigate });

    await user.click(screen.getByRole('link', { name: 'خانه' }));
    expect(onNavigate).toHaveBeenCalled();
  });
  /*
   * X4. The chevron (and, since 49K, the favourite star) used to be `role="button"` spans
   * INSIDE the row's anchor — an interactive control nested in another interactive control,
   * which is invalid ARIA and leaves a screen reader announcing one ambiguous target for
   * three different actions.
   *
   * This asserts STRUCTURE, not appearance, precisely because the appearance did not
   * change: a regression here would be invisible on screen and only a screen-reader user
   * would pay for it.
   */
  /*
   * Phase 51-HR-2: a module row (`/admin/hr`) and one of its own pages
   * (`/admin/hr/employees`) are BOTH declared rows, and the module href is a prefix of the
   * page href. A prefix-only rule would light two rows at once; the rail selects the most
   * specific declared target and nothing else.
   */
  const NAV_WITH_MODULE_AND_PAGES: CoreNavGroup[] = [
    {
      id: 'hr',
      label: 'منابع انسانی',
      items: [
        { label: 'منابع انسانی', href: '/admin/hr', icon: Home },
        { label: 'کارکنان', href: '/admin/hr/employees', icon: FileText },
      ],
    },
  ];

  it('selects only the most specific row when a module row is a prefix of the page row', () => {
    renderSidebar({ pathname: '/admin/hr/employees' }, NAV_WITH_MODULE_AND_PAGES);

    expect(screen.getAllByTestId('core-nav-active-indicator')).toHaveLength(1);
    expect(itemByLabel('کارکنان')).toHaveAttribute('data-active', 'true');
    expect(itemByLabel('منابع انسانی')).toHaveAttribute('data-active', 'false');
  });

  it('still selects the module row on the module page itself', () => {
    renderSidebar({ pathname: '/admin/hr' }, NAV_WITH_MODULE_AND_PAGES);

    expect(screen.getAllByTestId('core-nav-active-indicator')).toHaveLength(1);
    expect(itemByLabel('منابع انسانی')).toHaveAttribute('data-active', 'true');
    expect(itemByLabel('کارکنان')).toHaveAttribute('data-active', 'false');
  });

  it('keeps the row standing in for a sub-tree selected on the collapsed rail', () => {
    // The collapsed rail renders no child rows at all, so the parent that stands in for
    // them must keep the highlight — otherwise collapsing the rail would leave a module
    // the user is inside of looking unselected.
    renderSidebar({ pathname: '/admin/settings/security', collapsed: true });

    expect(screen.getAllByTestId('core-nav-active-indicator')).toHaveLength(1);
    expect(itemByLabel('تنظیمات')).toHaveAttribute('data-active', 'true');
  });

  it('renders the expandable parent as one toggle button, with children as plain links', async () => {
    const user = userEvent.setup();
    renderSidebar();

    const settings = itemByLabel('تنظیمات');
    const toggle = within(settings).getByRole('button', { name: /زیرمنوی تنظیمات/ });

    // A single real button — not a link plus a separate chevron control: activation,
    // focus and announcement come from the platform, and nothing nests inside another
    // interactive control.
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(settings).queryByRole('link')).toBeNull();
    // The row itself is inert — only the button inside it is interactive.
    expect(settings.tagName).toBe('DIV');
    expect(settings).not.toHaveAttribute('role');

    // Enter on the real button opens the sub-tree.
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('core-nav-toggle')).toHaveAttribute('data-open', 'true');

    // Children are plain links carrying their real hrefs.
    expect(screen.getByRole('link', { name: 'امنیت' })).toHaveAttribute(
      'href',
      '/admin/settings/security',
    );
  });
});
