import { render, screen, waitFor } from '@testing-library/react';
import { CoreModulesList } from '../CoreModulesList';
import { CORE_NAV } from '../core-nav';

/**
 * Phase 49C-4 coverage for the extracted authorised-modules presentation.
 *
 * The component is presentation-only: the data derivation it renders is
 * `visibleNavGroups(CORE_NAV)` — the SAME permission-intersection the sidebar uses —
 * so the tests assert exactly the three behaviours the Account tab depends on:
 * authorised modules render, unauthorised ones do not, and an empty result degrades
 * to a compact honest empty state rather than a giant blank card.
 */
describe('CoreModulesList', () => {
  it('renders modules the caller is authorised to open, grouped like the sidebar', () => {
    render(<CoreModulesList permissions={['blog.read']} enforcePermissions />);

    const list = screen.getByTestId('core-modules-list');
    expect(list).toBeInTheDocument();
    // Ungated personal destinations stay visible.
    expect(screen.getByText('حساب من')).toBeInTheDocument();
    // The gated module appears once its permission is held.
    expect(screen.getByText('وبلاگ')).toBeInTheDocument();
  });

  it('does not offer a module the caller cannot open', async () => {
    render(<CoreModulesList permissions={[]} enforcePermissions />);

    await waitFor(() =>
      expect(screen.getByTestId('core-modules-list')).toBeInTheDocument(),
    );

    expect(screen.queryByText('وبلاگ')).not.toBeInTheDocument();
    // Ungated modules are still there, so this is a filter and not an empty card.
    expect(screen.getByText('حساب من')).toBeInTheDocument();
  });

  it('does not enforce while RBAC has not answered, like the sidebar', () => {
    render(<CoreModulesList permissions={[]} enforcePermissions={false} />);

    // A gated link stays visible on a transient failure rather than vanishing; the
    // backend still answers 403, so this is presentation-only, never a bypass.
    expect(screen.getByText('وبلاگ')).toBeInTheDocument();
  });

  it('renders the compact empty state when nothing resolves', () => {
    render(<CoreModulesList permissions={[]} enforcePermissions source={[]} />);

    expect(screen.getByText('ماژول قابل دسترسی برای حساب شما وجود ندارد.')).toBeInTheDocument();
    expect(screen.queryByTestId('core-modules-list')).not.toBeInTheDocument();
    // Sanity: the production source would never be empty for an ungated nav.
    expect(CORE_NAV.length).toBeGreaterThan(0);
  });
});