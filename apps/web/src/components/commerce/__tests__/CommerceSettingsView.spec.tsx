import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceSettingsView } from '../settings/CommerceSettingsView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchCommerceCommercialConfigurations,
  fetchCommerceCommercialGroups,
  fetchCommerceWorkflowDefinitions,
} from '@/lib/commerce-api';
import {
  commercialConfigurationsPage,
  workflowDefinitionsPage,
} from './commerce-fixtures';

/**
 * PHASE UI-4: the Commerce configuration DOMAIN as the Settings Center mounts it.
 *
 * THE CLAIMS ONLY THIS SPEC CAN PIN: the domain speaks «نمای کلی / فرآیندهای خرید /
 * تنظیمات بازرگانی» (never WorkflowDefinition and friends), its sub-navigation extends
 * the center's `?tab=` convention with `?view=` through `replace`, a caller without
 * `commerce.read` gets the honest refusal with NO request, actions appear only with
 * their own configuration grants, and — deliberately — there is NO line-routing branch,
 * because no HTTP configuration surface backs one.
 */
const replace = jest.fn();
let mockViewParam: string | null = null;

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace }),
  usePathname: () => '/admin/settings',
  useSearchParams: () =>
    new URLSearchParams(mockViewParam === null ? {} : { view: mockViewParam }),
}));

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommerceWorkflowDefinitions: jest.fn(),
  fetchCommerceWorkflowVersions: jest.fn(),
  fetchCommerceCommercialGroups: jest.fn(),
  fetchCommerceCommercialConfigurations: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const definitionsMock = fetchCommerceWorkflowDefinitions as jest.MockedFunction<
  typeof fetchCommerceWorkflowDefinitions
>;
const configurationsMock = fetchCommerceCommercialConfigurations as jest.MockedFunction<
  typeof fetchCommerceCommercialConfigurations
>;
const groupsMock = fetchCommerceCommercialGroups as jest.MockedFunction<
  typeof fetchCommerceCommercialGroups
>;

function grant(permissions: string[], isLoading = false) {
  permissionsMock.mockReturnValue({
    permissions,
    roles: [],
    highestRole: null,
    isLoading,
    error: null,
    status: null,
    reload: jest.fn(),
  });
}

function authState() {
  return {
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: true,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as ReturnType<typeof useAuth>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockViewParam = null;
  grant(['commerce.read', 'commerce.configure', 'commerce.workflow.manage', 'admin.users.read']);
  authMock.mockReturnValue(authState());
  definitionsMock.mockResolvedValue(workflowDefinitionsPage([], 0));
  configurationsMock.mockResolvedValue(commercialConfigurationsPage([], 0));
  groupsMock.mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });
});

describe('CommerceSettingsView', () => {
  it('refuses without commerce.read and issues NO configuration request', () => {
    grant([]);

    render(<CommerceSettingsView />);

    expect(screen.getByText(/commerce\.read/)).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-settings-view')).not.toBeInTheDocument();
    expect(definitionsMock).not.toHaveBeenCalled();
    expect(configurationsMock).not.toHaveBeenCalled();
  });

  it('shows the permission skeleton while /rbac is in flight', () => {
    grant([], true);

    render(<CommerceSettingsView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-settings-view')).not.toBeInTheDocument();
  });

  it('lands on «نمای کلی» with human-language cards and NO line-routing branch', async () => {
    render(<CommerceSettingsView />);

    const view = await screen.findByTestId('commerce-settings-view');
    expect(within(view).getByRole('heading', { name: 'تدارکات و فرآیند خرید' })).toBeInTheDocument();
    expect(within(view).getByTestId('commerce-settings-nav-overview')).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(within(view).getByTestId('commerce-settings-card-workflows')).toBeInTheDocument();
    expect(within(view).getByTestId('commerce-settings-card-commercial')).toBeInTheDocument();
    // The branch has no HTTP configuration surface (UI-0 GAP-2) — it is absent, not disabled.
    expect(screen.queryByText(/مسیردهی اقلام/)).not.toBeInTheDocument();
    // The landing panel is NOT a KPI dashboard: no fabricated counts.
    expect(within(view).queryByText(/\d+ نسخه/)).not.toBeInTheDocument();
    // No workflow-engine vocabulary on the landing screen.
    expect(screen.queryByText(/WorkflowDefinition/)).not.toBeInTheDocument();
    expect(screen.queryByText(/WorkflowStep/)).not.toBeInTheDocument();
  });

  it('switches sections through the ?view= convention with replace, never a new route', async () => {
    const user = userEvent.setup();
    render(<CommerceSettingsView />);
    await screen.findByTestId('commerce-settings-view');

    await user.click(screen.getByTestId('commerce-settings-nav-workflows'));

    expect(replace).toHaveBeenCalledWith('/admin/settings?tab=commerce&view=workflows', {
      scroll: false,
    });

    await waitFor(() => expect(definitionsMock).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByRole('heading', { name: 'فرآیندهای خرید' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('commerce-settings-nav-workflows')).toHaveAttribute(
      'aria-current',
      'true'
    );
  });

  it('restores the section from ?view= on refresh', async () => {
    mockViewParam = 'commercial';

    render(<CommerceSettingsView />);

    await screen.findByTestId('commerce-settings-view');
    expect(screen.getByTestId('commerce-settings-nav-commercial')).toHaveAttribute(
      'aria-current',
      'true'
    );
    await waitFor(() => expect(configurationsMock).toHaveBeenCalledTimes(1));
    expect(groupsMock).toHaveBeenCalled();
  });

  it('falls back to the landing panel for an unknown ?view value', async () => {
    mockViewParam = 'something-else';

    render(<CommerceSettingsView />);

    expect(await screen.findByTestId('commerce-settings-nav-overview')).toHaveAttribute(
      'aria-current',
      'true'
    );
    expect(definitionsMock).not.toHaveBeenCalled();
  });

  it('shows configuration actions only with their own grants', async () => {
    // commerce.read alone: the lists are readable, no create affordance appears.
    grant(['commerce.read']);

    const { unmount } = render(<CommerceSettingsView />);
    await userEvent.click(screen.getByTestId('commerce-settings-nav-workflows'));
    await waitFor(() => expect(definitionsMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('هنوز فرآیندی برای خرید تعریف نشده است.')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-workflow-create-open')).not.toBeInTheDocument();
    unmount();

    // With commerce.configure the create affordance appears.
    definitionsMock.mockClear();
    grant(['commerce.read', 'commerce.configure']);
    render(<CommerceSettingsView />);
    await userEvent.click(screen.getByTestId('commerce-settings-nav-workflows'));
    await waitFor(() => expect(definitionsMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('commerce-workflow-create-open')).toBeInTheDocument();
  });
});