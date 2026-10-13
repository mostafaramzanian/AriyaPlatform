import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductionBomChangeFormView } from '../ProductionBomChangeFormView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import { CoreApiError } from '@/lib/core-http';
import { createProductionBomChange } from '@/lib/production-api';

const pushMock = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn(), refresh: jest.fn() }),
}));

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-api', () => ({
  ...jest.requireActual('@/lib/production-api'),
  createProductionBomChange: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const createMock = createProductionBomChange as jest.MockedFunction<
  typeof createProductionBomChange
>;

/**
 * PHASE PRODUCTION-BOM-CHANGE: the author form (`/admin/production/changes/new`).
 *
 * WHAT THESE SPECS ARE FOR: the form must send EXACTLY the four caller-owned fields and
 * nothing the server owns — no tenant, no requester, no project, no product tree, no status —
 * it must refuse without `production.bom.manage` rather than rendering a form that can only
 * 403, and a refusal must be rendered from its TYPED code so a user reads the Persian
 * sentence the backend's identifier maps to rather than an English token.
 */

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

function authState(user: { userId?: string } | null = { userId: 'u-1' }) {
  return {
    user,
    isLoading: false,
    error: null,
    isAuthenticated: user !== null,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as ReturnType<typeof useAuth>;
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.manage']);
  authMock.mockReturnValue(authState());
  createMock.mockResolvedValue({ id: 'c-1', items: [] } as never);
});

describe('ProductionBomChangeFormView', () => {
  it('refuses without production.bom.manage and renders no form', () => {
    grant(['production.bom.read']);

    render(<ProductionBomChangeFormView />);

    expect(screen.getByText(/production\.bom\.manage/)).toBeInTheDocument();
    expect(screen.queryByTestId('production-change-form-submit')).toBeNull();
  });

  it('offers the BOM, the title, the approver and the notes — and NO server-owned input', () => {
    render(<ProductionBomChangeFormView />);

    expect(screen.getByLabelText('شناسه BOM *')).toBeInTheDocument();
    expect(screen.getByLabelText('عنوان درخواست *')).toBeInTheDocument();
    expect(screen.getByLabelText('مدیر تاییدکننده *')).toBeInTheDocument();
    expect(screen.getByLabelText('توضیحات')).toBeInTheDocument();
    // The requester and the request date are SERVER-derived: there is no control for either,
    // because a body that could name them would be a delegated-authorship feature.
    expect(screen.queryByLabelText(/درخواست‌کننده/)).toBeNull();
    expect(screen.queryByLabelText(/تاریخ درخواست/)).toBeNull();
  });

  it('creates with exactly the four caller-owned fields and opens the new request', async () => {
    render(<ProductionBomChangeFormView />);

    await userEvent.type(
      screen.getByLabelText('شناسه BOM *'),
      '44444444-4444-4444-8444-444444444444'
    );
    await userEvent.type(screen.getByLabelText('عنوان درخواست *'), '  تغییر اقلام الف  ');
    await userEvent.type(screen.getByLabelText('مدیر تاییدکننده *'), 'u-2');
    await userEvent.type(screen.getByLabelText('توضیحات'), 'یادداشت');
    await userEvent.click(screen.getByTestId('production-change-form-submit'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      bomId: '44444444-4444-4444-8444-444444444444',
      title: 'تغییر اقلام الف',
      approverUserId: 'u-2',
      notes: 'یادداشت',
    });
    // The title is TRIMMED, and the payload carries nothing the server owns.
    const payload = createMock.mock.calls[0][0];
    for (const forbidden of ['tenantId', 'requesterUserId', 'projectRef', 'productTreeRef']) {
      expect({ forbidden, present: forbidden in payload }).toEqual({ forbidden, present: false });
    }
    expect(pushMock).toHaveBeenCalledWith('/admin/production/changes/c-1');
  });

  it('omits `notes` entirely when it is left blank, rather than sending an empty string', async () => {
    render(<ProductionBomChangeFormView />);

    await userEvent.type(
      screen.getByLabelText('شناسه BOM *'),
      '44444444-4444-4444-8444-444444444444'
    );
    await userEvent.type(screen.getByLabelText('عنوان درخواست *'), 'x');
    await userEvent.type(screen.getByLabelText('مدیر تاییدکننده *'), 'u-2');
    await userEvent.click(screen.getByTestId('production-change-form-submit'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0]).not.toHaveProperty('notes');
  });

  it('renders a refusal from its TYPED code, never from the English sentence', async () => {
    createMock.mockRejectedValue(
      new CoreApiError('bad request', 400, {
        error: {
          code: 'BOM_CHANGE_REQUEST_FIELD_REQUIRED',
          message: 'approverUserId is not a member of this tenant, or does not exist.',
        },
      })
    );

    render(<ProductionBomChangeFormView />);
    await userEvent.type(
      screen.getByLabelText('شناسه BOM *'),
      '44444444-4444-4444-8444-444444444444'
    );
    await userEvent.type(screen.getByLabelText('عنوان درخواست *'), 'x');
    await userEvent.type(screen.getByLabelText('مدیر تاییدکننده *'), 'u-2');
    await userEvent.click(screen.getByTestId('production-change-form-submit'));

    // The MAPPED Persian sentence, not the server's English one and not the raw code.
    expect(await screen.findByTestId('production-change-form-error')).toHaveTextContent(
      'برخی فیلدهای اجباری خالی یا نامعتبر است'
    );
    expect(pushMock).not.toHaveBeenCalled();
  });
});
