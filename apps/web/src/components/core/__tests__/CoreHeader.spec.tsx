import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreHeader } from '../CoreHeader';

/**
 * Phase 49C-1 header regression: the user disclosure menu must keep its existing
 * behaviour (Account, Logout) and reach the settings destination. The menu itself is
 * NOT redesigned — these assertions pin what already existed plus the one new
 * settings entry point.
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin',
}));

describe('CoreHeader user menu', () => {
  const onLogout = jest.fn();

  function renderHeader() {
    return render(
      <CoreHeader title="خانه" email="admin@test.local" onLogout={onLogout} onOpenMobileNav={jest.fn()} />,
    );
  }

  async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: /admin@test\.local/ }));
    return screen.getByRole('menu', { name: 'منوی کاربر' });
  }

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('opens the existing disclosure on the user chip', async () => {
    const user = userEvent.setup();
    renderHeader();

    const opener = screen.getByRole('button', { name: /admin@test\.local/ });
    expect(opener).toHaveAttribute('aria-haspopup', 'menu');
    expect(opener).toHaveAttribute('aria-expanded', 'false');

    await user.click(opener);
    expect(screen.getByRole('menu', { name: 'منوی کاربر' })).toBeInTheDocument();
    expect(opener).toHaveAttribute('aria-expanded', 'true');
  });

  it('reaches the account page from حساب من', async () => {
    const user = userEvent.setup();
    renderHeader();

    const menu = await openMenu(user);
    const link = within(menu).getByRole('menuitem', { name: /حساب من/ });
    expect(link).toHaveAttribute('href', '/admin/profile');
  });

  it('reaches the settings destination from تنظیمات with its gear icon', async () => {
    const user = userEvent.setup();
    renderHeader();

    const menu = await openMenu(user);
    const link = within(menu).getByRole('menuitem', { name: /تنظیمات/ });
    expect(link).toHaveAttribute('href', '/admin/settings');
    // The gear icon is decorative (aria-hidden), matching the menu's icon pattern.
    const icon = link.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps خروج unchanged and closes the menu', async () => {
    const user = userEvent.setup();
    renderHeader();

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /خروج/ }));

    expect(onLogout).toHaveBeenCalledTimes(1);
    // The panel keeps its exit animation, then unmounts; wait for removal.
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  /**
   * Phase 49C-5 CORRECTION: support belongs to the personal/service access actions in
   * THIS user menu — exactly between تنظیمات and خروج — and must never move back into
   * the platform Settings Center. The life-buoy icon matches the menu's icon pattern,
   * the item is a plain link like its siblings, and /admin/support is the ONLY support
   * destination (the route's server-side authorization is untouched).
   */
  it('reaches the support page from پشتیبانی with its life-buoy icon', async () => {
    const user = userEvent.setup();
    renderHeader();

    const menu = await openMenu(user);
    const link = within(menu).getByRole('menuitem', { name: /پشتیبانی/ });
    expect(link).toHaveAttribute('href', '/admin/support');
    // The icon is decorative (aria-hidden), matching the menu's existing icon pattern.
    const icon = link.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('places پشتیبانی between تنظیمات and خروج in the existing dropdown', async () => {
    const user = userEvent.setup();
    renderHeader();

    const menu = await openMenu(user);
    const labels = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.trim() ?? '');
    // Exact order, matching the user's authoritative placement:
    // حساب من → تنظیمات → پشتیبانی → خروج.
    expect(labels).toEqual(['حساب من', 'تنظیمات', 'پشتیبانی', 'خروج']);
  });

  it('closes the menu when پشتیبانی is chosen, like every other item', async () => {
    const user = userEvent.setup();
    renderHeader();

    const menu = await openMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /پشتیبانی/ }));

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('closes on Escape like before', async () => {
    const user = userEvent.setup();
    renderHeader();

    await openMenu(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
