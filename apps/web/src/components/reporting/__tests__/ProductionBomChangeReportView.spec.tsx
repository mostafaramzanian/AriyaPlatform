import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ProductionBomChangeReportView } from '../ProductionBomChangeReportView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  fetchProductionBomChangeReport,
  type ReportingProductionBomChangePage,
} from '@/lib/production-bom-change-report-api';
import { downloadReportExport } from '@/lib/report-export';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

jest.mock('@/lib/production-bom-change-report-api', () => ({
  ...jest.requireActual('@/lib/production-bom-change-report-api'),
  fetchProductionBomChangeReport: jest.fn(),
}));

jest.mock('@/lib/report-export', () => ({
  ...jest.requireActual('@/lib/report-export'),
  downloadReportExport: jest.fn().mockResolvedValue(undefined),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const fetchMock = fetchProductionBomChangeReport as jest.MockedFunction<
  typeof fetchProductionBomChangeReport
>;
const downloadMock = downloadReportExport as jest.MockedFunction<typeof downloadReportExport>;

/**
 * Phase REPORTING-PRODUCTION-BOM-CHANGE-REPORT: what the FIFTH Reporting workspace
 * actually promises, as executable behavior:
 *
 *  1. IDENTITY — the report exists by name, under the page heading, no h1.
 *  2. FILTERS — only the source register's four (`status`, `search`, `projectRef`,
 *     `bomId`), always as a SERVER query, never a client-side sieve; a malformed
 *     `bomId` is a field validation message, never a fired request.
 *  3. AUTHORIZATION — without `production.bom.read` no request is issued.
 *  4. SUMMARY HONESTY — every rendered figure comes from the API payload; the
 *     component owns no counting code, and the chart reads the same server summary.
 *  5. STATES — empty and error are distinct; neither fakes the other.
 *  6. SCOPE — no write/scheduling/AI affordance exists, because no backend contract
 *     does; the EXPORT actions exist because one does, and they carry the CURRENT
 *     query so file, table and chart describe the same population.
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

function row(
  overrides: Partial<ReportingProductionBomChangePage['items'][number]> = {}
): ReportingProductionBomChangePage['items'][number] {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    bomId: '22222222-2222-4222-8222-222222222222',
    title: 'تغییر اقلام پروژه ۴۲',
    projectRef: 'proj-42',
    productTreeRef: 'tree-771',
    status: 'SUBMITTED',
    managerOpinion: null,
    itemCount: 2,
    submittedAt: '2026-01-10T08:00:00.000Z',
    decidedAt: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    ...overrides,
  };
}

function page(items = [row()], total = items.length): ReportingProductionBomChangePage {
  return {
    items,
    total,
    page: 1,
    pageSize: 20,
    summary: {
      total,
      byStatus: {
        DRAFT: 0,
        SUBMITTED: items.length,
        APPROVED: 0,
        REJECTED: 0,
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant(['production.bom.read']);
  authMock.mockReturnValue(authState());
  fetchMock.mockResolvedValue(page());
});

describe('ProductionBomChangeReportView — «گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)»', () => {
  it('renders the report identity under the page heading — one h-level per step', async () => {
    render(<ProductionBomChangeReportView />);

    const pageHeading = screen.getByRole('heading', { level: 2, name: 'گزارش‌گیری' });
    expect(pageHeading).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'گزارش وضعیت درخواست‌های تغییر فهرست مواد (BOM)',
      })
    ).toBeInTheDocument();

    expect(await screen.findByTestId('production-bom-change-report-table')).toBeInTheDocument();
  });

  it('queries the SERVER with the page window and the four contract filters only', async () => {
    render(<ProductionBomChangeReportView />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        status: undefined,
        search: '',
        projectRef: '',
        bomId: '',
      })
    );
  });

  it('issues NO request without production.bom.read — the gate is a closed door', async () => {
    grant(['production.bom.manage']);
    render(<ProductionBomChangeReportView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders every summary figure from the API payload — never a component count', async () => {
    fetchMock.mockResolvedValue({
      ...page([row()], 7),
      summary: {
        total: 7,
        byStatus: { DRAFT: 2, SUBMITTED: 5, APPROVED: 0, REJECTED: 0 },
      },
    });
    render(<ProductionBomChangeReportView />);

    expect(
      await screen.findByTestId('production-bom-change-report-summary-all-count')
    ).toHaveTextContent('۷');
    expect(
      await screen.findByTestId('production-bom-change-report-summary-count-SUBMITTED')
    ).toHaveTextContent('۵');
    expect(
      await screen.findByTestId('production-bom-change-report-summary-count-DRAFT')
    ).toHaveTextContent('۲');
    expect(
      screen.getByTestId('production-bom-change-report-summary-count-REJECTED')
    ).toHaveTextContent('۰');
  });

  it('renders a row with the source status vocabulary and the four-state badges only', async () => {
    fetchMock.mockResolvedValue(
      page([
        row({ title: 'تغییر موتور', status: 'APPROVED', managerOpinion: 'APPROVED', itemCount: 3 }),
      ])
    );
    render(<ProductionBomChangeReportView />);

    expect(
      await screen.findByTestId('production-bom-change-report-status-APPROVED')
    ).toHaveTextContent('تایید شده');
    expect(screen.getByText('تغییر موتور')).toBeInTheDocument();
    // The status options are the CLOSED four-member set — no fifth status is offered.
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).not.toContain('نیاز به اصلاح');
    expect(options).not.toContain('بازگشایی');
  });

  it('renders a dash for a row with no decision yet — never a fabricated opinion', async () => {
    fetchMock.mockResolvedValue(page([row({ managerOpinion: null })]));
    render(<ProductionBomChangeReportView />);

    const table = await screen.findByTestId('production-bom-change-report-table');
    expect(table).toHaveTextContent('—');
  });

  it('links a row into the read-only detail — the only row affordance', async () => {
    render(<ProductionBomChangeReportView />);

    const link = await screen.findByTestId(
      'production-bom-change-report-row-link-11111111-1111-4111-8111-111111111111'
    );
    expect(link).toHaveAttribute(
      'href',
      '/admin/reporting/production/bom-change-requests/11111111-1111-4111-8111-111111111111'
    );
    expect(
      screen.getByTestId(
        'production-bom-change-report-row-details-11111111-1111-4111-8111-111111111111'
      )
    ).toHaveTextContent('جزئیات');
  });
});

describe("ProductionBomChangeReportView — server filters (the register's proven four)", () => {
  it('applies the status filter through the SERVER query', async () => {
    render(<ProductionBomChangeReportView />);
    await screen.findByTestId('production-bom-change-report-table');

    await userEvent.selectOptions(
      screen.getByTestId('production-bom-change-report-status-filter'),
      'APPROVED'
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'APPROVED', page: 1 })
      )
    );
  });

  it('applies the search through the SERVER query on submit', async () => {
    render(<ProductionBomChangeReportView />);
    await screen.findByTestId('production-bom-change-report-table');

    await userEvent.type(
      screen.getByTestId('production-bom-change-report-search-input'),
      ' موتور '
    );
    await userEvent.click(screen.getByTestId('production-bom-change-report-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: 'موتور', page: 1 })
      )
    );
  });

  it('applies the EXACT project reference through the SERVER query on submit', async () => {
    render(<ProductionBomChangeReportView />);
    await screen.findByTestId('production-bom-change-report-table');

    await userEvent.type(
      screen.getByTestId('production-bom-change-report-project-input'),
      ' proj-42 '
    );
    await userEvent.click(screen.getByTestId('production-bom-change-report-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ projectRef: 'proj-42', page: 1 })
      )
    );
  });

  it('applies a valid bomId through the SERVER query on submit', async () => {
    render(<ProductionBomChangeReportView />);
    await screen.findByTestId('production-bom-change-report-table');

    await userEvent.type(
      screen.getByTestId('production-bom-change-report-bom-input'),
      '22222222-2222-4222-8222-222222222222'
    );
    await userEvent.click(screen.getByTestId('production-bom-change-report-apply-filters'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ bomId: '22222222-2222-4222-8222-222222222222', page: 1 })
      )
    );
  });

  it('refuses a malformed bomId as a field message — never a fired request', async () => {
    render(<ProductionBomChangeReportView />);
    await screen.findByTestId('production-bom-change-report-table');
    const callsSoFar = fetchMock.mock.calls.length;

    await userEvent.type(
      screen.getByTestId('production-bom-change-report-bom-input'),
      'not-a-uuid'
    );
    await userEvent.click(screen.getByTestId('production-bom-change-report-apply-filters'));

    const message = await screen.findByTestId('production-bom-change-report-bom-error');
    expect(message).toHaveTextContent('شناسه BOM باید یک شناسه معتبر (UUID) باشد.');
    expect(fetchMock).toHaveBeenCalledTimes(callsSoFar);
  });

  it('sets the status filter from a summary chip and clears it via «همه»', async () => {
    render(<ProductionBomChangeReportView />);
    await screen.findByTestId('production-bom-change-report-table');

    await userEvent.click(screen.getByTestId('production-bom-change-report-summary-status-DRAFT'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'DRAFT' }))
    );

    await userEvent.click(screen.getByTestId('production-bom-change-report-summary-all'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }))
    );
  });

  it('clears every filter at once and resets to page 1', async () => {
    render(<ProductionBomChangeReportView />);
    await screen.findByTestId('production-bom-change-report-table');

    await userEvent.selectOptions(
      screen.getByTestId('production-bom-change-report-status-filter'),
      'DRAFT'
    );
    await userEvent.type(screen.getByTestId('production-bom-change-report-search-input'), 'x');
    await userEvent.click(screen.getByTestId('production-bom-change-report-apply-filters'));
    await waitFor(() =>
      expect(screen.getByTestId('production-bom-change-report-clear-filters')).toBeInTheDocument()
    );

    await userEvent.click(screen.getByTestId('production-bom-change-report-clear-filters'));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: undefined,
          search: '',
          projectRef: '',
          bomId: '',
          page: 1,
        })
      )
    );
    expect(screen.queryByTestId('production-bom-change-report-bom-error')).not.toBeInTheDocument();
  });
});

describe('ProductionBomChangeReportView — states', () => {
  it('renders the NO-RECORDS state with the filter-scoped message — not an error', async () => {
    fetchMock.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      summary: {
        total: 0,
        byStatus: { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0 },
      },
    });
    render(<ProductionBomChangeReportView />);

    expect(await screen.findByTestId('production-bom-change-report-empty')).toBeInTheDocument();
    expect(screen.getByText('برای این فیلترها درخواستی پیدا نشد.')).toBeInTheDocument();
    expect(screen.queryByTestId('production-bom-change-report-error')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the ERROR state with retry — never an empty state', async () => {
    fetchMock.mockRejectedValueOnce(new Error('boom'));
    render(<ProductionBomChangeReportView />);

    const error = await screen.findByTestId('production-bom-change-report-error');
    expect(error).toBeInTheDocument();
    expect(error).toHaveTextContent('دریافت گزارش با خطا مواجه شد.');
    expect(screen.queryByTestId('production-bom-change-report-empty')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows a skeleton while the first load is in flight — no fake figures', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ProductionBomChangeReportView />);

    expect(await screen.findByTestId('production-bom-change-report-loading')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // The summary strip renders placeholders (aria-hidden bars), never a digit.
    expect(
      screen.queryByTestId('production-bom-change-report-summary-all-count')
    ).not.toBeInTheDocument();
  });
});

describe('ProductionBomChangeReportView — chart, export and scope protection', () => {
  /** Comment lines removed: prose that EXPLAINS a rule must not violate it. */
  const codeOf = (file: string): string => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const path = jest.requireActual('path') as typeof import('path');
    return fs
      .readFileSync(path.join(__dirname, '..', file), 'utf8')
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith('//') &&
          !trimmed.startsWith('*') &&
          !trimmed.startsWith('/*') &&
          !trimmed.startsWith('{/*')
        );
      })
      .join('\n');
  };

  it('shows the truthful distribution bars over the SERVER summary', async () => {
    render(<ProductionBomChangeReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByTestId('production-bom-change-report-chart')).toHaveAttribute(
      'aria-label',
      'توزیع وضعیت درخواست‌ها'
    );
    expect(
      screen.getByTestId('production-bom-change-report-chart-count-SUBMITTED')
    ).toHaveTextContent('۱');
  });

  it('renders the export actions for the CURRENT scope — the contract now exists', async () => {
    render(<ProductionBomChangeReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByTestId('production-bom-change-report-export-xlsx')).toHaveTextContent(
      'خروجی Excel'
    );
    expect(screen.getByTestId('production-bom-change-report-export-docx')).toHaveTextContent(
      'خروجی Word'
    );
  });

  it('propagates the CURRENT query to the export path — one query, three surfaces', async () => {
    render(<ProductionBomChangeReportView />);
    await screen.findByTestId('production-bom-change-report-table');

    // Active scope: a status chip + a typed search/project, applied through the bar.
    await userEvent.click(
      screen.getByTestId('production-bom-change-report-summary-status-APPROVED')
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'APPROVED' }))
    );

    await userEvent.click(screen.getByTestId('production-bom-change-report-export-xlsx'));

    await waitFor(() => expect(downloadMock).toHaveBeenCalledTimes(1));
    const path = downloadMock.mock.calls[0][0] as string;
    expect(path).toContain('/reporting/production/bom-change-requests/export/xlsx');
    expect(path).toContain('status=APPROVED');
    expect(path).toContain('page=1');
    expect(path).toContain('pageSize=20');
  });

  it('offers no requester-id filter — an actor id has no display contract', () => {
    const source = codeOf('ProductionBomChangeReportView.tsx');
    expect(source.toLowerCase()).not.toContain('requesteruserid');
  });

  it('owns no write, scheduling or AI affordance — the backend has none', () => {
    const source = codeOf('ProductionBomChangeReportView.tsx');
    for (const needle of [
      'زمان‌بندی',
      'اشتراک',
      'ارسال خودکار',
      'هوش مصنوعی',
      'تحلیل هوشمند',
      'csv',
      'pdf',
    ]) {
      expect({ needle, present: source.toLowerCase().includes(needle.toLowerCase()) }).toEqual({
        needle,
        present: false,
      });
    }
  });

  it('offers no Production mutation — the report never approves, rejects, edits or submits', () => {
    const source = codeOf('ProductionBomChangeReportView.tsx');
    // The register's only navigation is the detail link; the workflow lives in
    // Production's own screens and must not be reachable from here. (`submit`
    // is deliberately NOT a needle: the filter bar's submit button is a form,
    // not a Production transition.)
    for (const needle of ['/admin/production/', 'approve', 'reject']) {
      expect({ needle, present: source.includes(needle) }).toEqual({ needle, present: false });
    }
  });
});
