import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreDirectoryMemberView } from '../CoreDirectoryMemberView';
import { CoreApiError } from '@/lib/core-http';
import { fetchDirectoryMember, type DirectoryMember } from '@/lib/directory-api';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/directory/u1',
}));

jest.mock('@/lib/directory-api', () => ({
  ...jest.requireActual('@/lib/directory-api'),
  fetchDirectoryMember: jest.fn(),
}));

const fetchMemberMock = fetchDirectoryMember as jest.MockedFunction<typeof fetchDirectoryMember>;

function member(overrides: Partial<DirectoryMember> = {}): DirectoryMember {
  return {
    id: 'u1',
    firstName: 'بهار',
    lastName: 'نوری',
    email: 'bahar@example.com',
    phone: '021-2001',
    avatarUrl: null,
    status: 'EMPLOYEE',
    department: 'مالی',
    jobTitle: 'حسابدار',
    extension: '201',
    managerId: 'mgr-1',
    manager: {
      id: 'mgr-1',
      firstName: 'آرش',
      lastName: 'کریمی',
      avatarUrl: null,
      jobTitle: 'مدیر مالی',
    },
    ...overrides,
  };
}

describe('CoreDirectoryMemberView', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state first', () => {
    fetchMemberMock.mockReturnValue(new Promise(() => undefined));

    render(<CoreDirectoryMemberView memberId="u1" />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('در حال بارگذاری اطلاعات همکار...')).toBeInTheDocument();
  });

  it('renders every approved directory field', async () => {
    fetchMemberMock.mockResolvedValue(member());

    render(<CoreDirectoryMemberView memberId="u1" />);

    expect(await screen.findByRole('heading', { name: 'بهار نوری' })).toBeInTheDocument();
    expect(screen.getByText('bahar@example.com')).toBeInTheDocument();
    expect(screen.getByText('021-2001')).toBeInTheDocument();
    expect(screen.getByText('201')).toBeInTheDocument();
    expect(screen.getAllByText('مالی').length).toBeGreaterThan(0);
    expect(screen.getAllByText('حسابدار').length).toBeGreaterThan(0);
    expect(screen.getByText('کارمند')).toBeInTheDocument();
    expect(fetchMemberMock).toHaveBeenCalledWith('u1');
  });

  it('links the manager to their own directory entry', async () => {
    fetchMemberMock.mockResolvedValue(member());

    render(<CoreDirectoryMemberView memberId="u1" />);

    const link = await screen.findByRole('link', { name: /آرش کریمی/ });
    expect(link).toHaveAttribute('href', '/admin/directory/mgr-1');
  });

  it('renders a dash instead of a manager when the relation is null', async () => {
    fetchMemberMock.mockResolvedValue(member({ managerId: 'mgr-1', manager: null }));

    render(<CoreDirectoryMemberView memberId="u1" />);

    await screen.findByRole('heading', { name: 'بهار نوری' });
    // managerId is set but points outside the tenant, so nothing about it is shown.
    expect(screen.queryByRole('link', { name: /آرش کریمی/ })).not.toBeInTheDocument();
    expect(screen.queryByText('mgr-1')).not.toBeInTheDocument();
  });

  it('never renders a sensitive field even if the API returns one', async () => {
    fetchMemberMock.mockResolvedValue(
      member({ passwordHash: 'leaked-hash', tenantId: 'tenant-a' } as never),
    );

    render(<CoreDirectoryMemberView memberId="u1" />);

    await screen.findByRole('heading', { name: 'بهار نوری' });
    expect(screen.queryByText('leaked-hash')).not.toBeInTheDocument();
    expect(screen.queryByText('tenant-a')).not.toBeInTheDocument();
  });

  it('shows one identical not-found state for unknown and cross-tenant ids', async () => {
    fetchMemberMock.mockRejectedValue(new CoreApiError('Directory member not found', 404));

    render(<CoreDirectoryMemberView memberId="foreign-id" />);

    expect(await screen.findByTestId('directory-not-found')).toBeInTheDocument();
    expect(screen.getByText('این همکار در دفترچه سازمانی شما وجود ندارد.')).toBeInTheDocument();
    // No retry: a 404 is a definitive answer, not a transient failure.
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  it('renders the forbidden state on 403', async () => {
    fetchMemberMock.mockRejectedValue(new CoreApiError('دسترسی ندارید', 403));

    render(<CoreDirectoryMemberView memberId="u1" />);

    expect(await screen.findByText('شما به دفترچه سازمانی دسترسی ندارید.')).toBeInTheDocument();
  });

  it('offers a retry for a transient error', async () => {
    fetchMemberMock.mockRejectedValueOnce(new CoreApiError('خطای شبکه', 500));

    render(<CoreDirectoryMemberView memberId="u1" />);

    expect(await screen.findByText('خطای شبکه')).toBeInTheDocument();

    fetchMemberMock.mockResolvedValue(member());
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByRole('heading', { name: 'بهار نوری' })).toBeInTheDocument();
  });

  it('always offers a way back to the list, in every state', async () => {
    fetchMemberMock.mockRejectedValue(new CoreApiError('Directory member not found', 404));

    render(<CoreDirectoryMemberView memberId="u1" />);

    await waitFor(() =>
      expect(screen.getByRole('link', { name: /بازگشت به دفترچه سازمانی/ })).toHaveAttribute(
        'href',
        '/admin/directory',
      ),
    );
  });
});
