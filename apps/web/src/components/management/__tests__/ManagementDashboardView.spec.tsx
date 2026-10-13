import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ManagementDashboardView } from '../ManagementDashboardView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import { fetchKpis } from '@/lib/kpi-api';
import { fetchCommercePendingDecisionsCount } from '@/lib/commerce-pending-api';
import { fetchMissionApprovalsPendingCount } from '@/lib/hr-mission-pending-count';
import { fetchCheckRequestReport } from '@/lib/reporting-api';
import { fetchProductionReport } from '@/lib/production-report-api';
import { fetchPurchaseReport } from '@/lib/purchase-report-api';
import { authState, comparison, grant, kpi, list, PERIOD } from '@/components/kpi/__tests__/kpi-fixtures';
import { executableSource } from '@/components/hr/__tests__/source-scan';

jest.mock('@/components/core/useCorePermissions', () => ({ useCorePermissions: jest.fn() }));
jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));
jest.mock('@/lib/kpi-api', () => ({
  ...jest.requireActual('@/lib/kpi-api'),
  fetchKpis: jest.fn(),
}));
jest.mock('@/lib/commerce-pending-api', () => ({ fetchCommercePendingDecisionsCount: jest.fn() }));
jest.mock('@/lib/hr-mission-pending-count', () => ({ fetchMissionApprovalsPendingCount: jest.fn() }));
jest.mock('@/lib/reporting-api', () => ({
  ...jest.requireActual('@/lib/reporting-api'),
  fetchCheckRequestReport: jest.fn(),
}));
jest.mock('@/lib/production-report-api', () => ({
  ...jest.requireActual('@/lib/production-report-api'),
  fetchProductionReport: jest.fn(),
}));
jest.mock('@/lib/purchase-report-api', () => ({
  ...jest.requireActual('@/lib/purchase-report-api'),
  fetchPurchaseReport: jest.fn(),
}));

const mocked = {
  kpis: fetchKpis as jest.Mock,
  commerce: fetchCommercePendingDecisionsCount as jest.Mock,
  mission: fetchMissionApprovalsPendingCount as jest.Mock,
  financial: fetchCheckRequestReport as jest.Mock,
  production: fetchProductionReport as jest.Mock,
  purchase: fetchPurchaseReport as jest.Mock,
};

const PRODUCTION = 'production.bom.read';
const COMMERCE = 'commerce.read';
const FINANCIAL = 'financial.check.read';
const MISSION = 'hr.mission.approve';

const summary = (byStatus: Record<string, number>) => ({
  items: [],
  total: 0,
  page: 1,
  pageSize: 1,
  summary: { total: Object.values(byStatus).reduce((sum, n) => sum + n, 0), byStatus },
});

/** Every source answers healthily. Individual tests override one source. */
function answerEverything() {
  mocked.kpis.mockResolvedValue(list([kpi({ technicalKey: 'kpi-a', nameFa: 'شاخص الف' })]));
  mocked.commerce.mockResolvedValue(4);
  mocked.mission.mockResolvedValue(2);
  mocked.financial.mockResolvedValue(summary({ '0': 2, '1': 1 }));
  mocked.purchase.mockResolvedValue(summary({ DRAFT: 3 }));
  mocked.production.mockResolvedValue(summary({ APPROVED: 5 }));
}

/** Total of every source request issued. Used to prove a hidden card issued nothing. */
function totalSourceCalls(): number {
  return Object.values(mocked).reduce((sum, fn) => sum + fn.mock.calls.length, 0);
}

/** Install the caller's permissions and an authenticated session. */
function setPermissions(permissions: string[]) {
  authState();
  grant(permissions);
}

beforeEach(() => {
  jest.clearAllMocks();
  answerEverything();
});

describe('permission gate: a card the caller cannot read is never issued', () => {
  it('a production-only caller issues only KPI and Production', async () => {
    setPermissions([PRODUCTION]);
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-prd-01-chart')).toBeInTheDocument();
    expect(mocked.kpis).toHaveBeenCalledTimes(1);
    expect(mocked.production).toHaveBeenCalledTimes(1);
    expect(mocked.commerce).not.toHaveBeenCalled();
    expect(mocked.mission).not.toHaveBeenCalled();
    expect(mocked.financial).not.toHaveBeenCalled();
    expect(mocked.purchase).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mgt-que-01')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mgt-fin-01')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mgt-com-01')).not.toBeInTheDocument();
  });

  it('a commerce-only caller issues KPI, Commerce status and Commerce queue only', async () => {
    setPermissions([COMMERCE]);
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-que-01-count')).toBeInTheDocument();
    expect(mocked.kpis).toHaveBeenCalledTimes(1);
    expect(mocked.commerce).toHaveBeenCalledTimes(1);
    expect(mocked.purchase).toHaveBeenCalledTimes(1);
    expect(mocked.production).not.toHaveBeenCalled();
    expect(mocked.financial).not.toHaveBeenCalled();
    expect(mocked.mission).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mgt-que-02')).not.toBeInTheDocument();
  });

  it('a financial-only caller issues KPI and Financial status only', async () => {
    setPermissions([FINANCIAL]);
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-fin-01-chart')).toBeInTheDocument();
    expect(mocked.kpis).toHaveBeenCalledTimes(1);
    expect(mocked.financial).toHaveBeenCalledTimes(1);
    expect(mocked.commerce).not.toHaveBeenCalled();
    expect(mocked.purchase).not.toHaveBeenCalled();
    expect(mocked.production).not.toHaveBeenCalled();
    expect(mocked.mission).not.toHaveBeenCalled();
  });

  it('an HR mission-approve-only caller issues the HR queue and NO KPI request', async () => {
    setPermissions([MISSION]);
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-que-02-count')).toBeInTheDocument();
    expect(mocked.mission).toHaveBeenCalledTimes(1);
    expect(mocked.kpis).not.toHaveBeenCalled();
    expect(mocked.commerce).not.toHaveBeenCalled();
    expect(mocked.financial).not.toHaveBeenCalled();
    expect(mocked.production).not.toHaveBeenCalled();
    expect(mocked.purchase).not.toHaveBeenCalled();
  });

  it('a caller with none of the four remits issues zero source requests and sees the page forbidden state', async () => {
    setPermissions(['core.dashboard.read']);
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-dashboard-forbidden')).toBeInTheDocument();
    expect(totalSourceCalls()).toBe(0);
  });

  it('issues no request while RBAC is still resolving', () => {
    authState();
    (useCorePermissions as unknown as jest.Mock).mockReturnValue({
      permissions: [],
      roles: [],
      highestRole: null,
      isLoading: true,
      error: null,
      status: null,
      reload: jest.fn(),
    });
    render(<ManagementDashboardView />);

    expect(totalSourceCalls()).toBe(0);
  });

  it('a source 403 AFTER an authorized request still shows the card FORBIDDEN state', async () => {
    setPermissions([COMMERCE]);
    mocked.commerce.mockRejectedValue(new CoreApiError('forbidden', 403));
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-que-01-forbidden')).toBeInTheDocument();
    expect(screen.queryByTestId('mgt-que-01-count')).not.toBeInTheDocument();
  });

  it('never sends a tenantId in any source call', async () => {
    setPermissions([PRODUCTION, COMMERCE, FINANCIAL, MISSION]);
    render(<ManagementDashboardView />);
    await screen.findByTestId('mgt-que-02-count');

    const argCount = Object.values(mocked).flatMap((fn) => fn.mock.calls.flat());
    expect(JSON.stringify(argCount)).not.toContain('tenantId');
  });
});


describe('KPI card semantics', () => {
  it('renders the server comparison and the server current period', async () => {
    setPermissions([PRODUCTION]);
    const item = kpi({ technicalKey: 'kpi-a', nameFa: 'شاخص الف' });
    mocked.kpis.mockResolvedValue({
      ...list([item]),
      comparisons: { 'kpi-a': comparison({ direction: 'DECREASE', unitSemantic: 'SECONDS' }) },
    });
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-kpi-comparison-kpi-a')).toHaveTextContent('کاهش');
    expect(screen.getByTestId('mgt-kpi-01-subtitle')).toHaveTextContent('سمت سرور');
  });

  it('renders an unavailable comparison honestly', async () => {
    setPermissions([PRODUCTION]);
    const item = kpi({ technicalKey: 'kpi-a', nameFa: 'شاخص الف' });
    mocked.kpis.mockResolvedValue({
      ...list([item]),
      comparisons: {
        'kpi-a': comparison({
          availability: 'NOT_AVAILABLE',
          unavailableReason: 'PREVIOUS_NOT_AVAILABLE',
          direction: null,
          absoluteChange: null,
          relativeChange: null,
          changeDisplay: null,
        }),
      },
    });
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-kpi-comparison-unavailable-kpi-a')).toHaveTextContent(
      'بازه مقایسه عددی ندارد'
    );
  });

  it('marks a partial month as در جریان', async () => {
    setPermissions([PRODUCTION]);
    const partial = kpi({ technicalKey: 'kpi-a', nameFa: 'شاخص الف' });
    mocked.kpis.mockResolvedValue({ ...list([partial]), period: { ...PERIOD, completed: false } });
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-kpi-01-subtitle')).toHaveTextContent('در جریان');
  });

  it('keeps an unavailable KPI as an honest dash, never a zero', async () => {
    setPermissions([PRODUCTION]);
    const missing = kpi({
      technicalKey: 'kpi-a',
      nameFa: 'شاخص الف',
      availability: 'NOT_AVAILABLE',
      unavailableReason: 'EMPTY_COHORT',
      value: null,
      display: null,
    });
    mocked.kpis.mockResolvedValue(list([missing]));
    render(<ManagementDashboardView />);

    const tile = await screen.findByTestId('mgt-kpi-unavailable-kpi-a');
    expect(tile).toHaveTextContent('—');
    expect(tile).not.toHaveTextContent('۰');
  });

  it('does not compute a comparison in the browser', () => {
    const source = executableSource('src/components/management/ManagementDashboardView.tsx');
    expect(source).not.toMatch(/previousValue|currentValue|absoluteChange\s*[-=]/);
  });
});

describe('error semantics', () => {
  it('maps 403 to FORBIDDEN', async () => {
    setPermissions([COMMERCE]);
    mocked.commerce.mockRejectedValue(new CoreApiError('forbidden', 403));
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-que-01-forbidden')).toBeInTheDocument();
  });

  it('maps 404 to UNAVAILABLE', async () => {
    setPermissions([COMMERCE]);
    mocked.commerce.mockRejectedValue(new CoreApiError('not found', 404));
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-que-01-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('mgt-que-01-error')).not.toBeInTheDocument();
  });

  it('maps 500 to ERROR with a retry, not UNAVAILABLE', async () => {
    setPermissions([PRODUCTION]);
    mocked.production.mockRejectedValue(new CoreApiError('boom', 500));
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-prd-01-error')).toBeInTheDocument();
    expect(screen.queryByTestId('mgt-prd-01-unavailable')).not.toBeInTheDocument();
  });

  it('maps a non-HTTP failure to ERROR and retries to ready', async () => {
    setPermissions([MISSION]);
    mocked.mission.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(7);
    render(<ManagementDashboardView />);

    await screen.findByTestId('mgt-que-02-error');
    fireEvent.click(screen.getByRole('button', { name: /دوباره/ }));

    await waitFor(() => expect(screen.getByTestId('mgt-que-02-count')).toHaveTextContent('۷'));
    expect(mocked.mission).toHaveBeenCalledTimes(2);
  });

  it('a failed card does not disturb the other cards', async () => {
    setPermissions([PRODUCTION, COMMERCE]);
    mocked.commerce.mockRejectedValue(new CoreApiError('boom', 500));
    render(<ManagementDashboardView />);

    expect(await screen.findByTestId('mgt-prd-01-chart')).toBeInTheDocument();
    expect(screen.getByTestId('mgt-que-01-error')).toBeInTheDocument();
  });
});


describe('manual refresh', () => {
  it('renders exactly one refresh control', async () => {
    setPermissions([PRODUCTION]);
    render(<ManagementDashboardView />);
    await screen.findByTestId('mgt-prd-01-chart');

    expect(screen.getAllByRole('button', { name: 'بروزرسانی' })).toHaveLength(1);
  });

  it('re-queries only the issued sources and leaves hidden sources unrequested', async () => {
    setPermissions([PRODUCTION, COMMERCE]);
    render(<ManagementDashboardView />);
    await screen.findByTestId('mgt-prd-01-chart');
    await screen.findByTestId('mgt-que-01-count');

    fireEvent.click(screen.getByTestId('mgt-dashboard-refresh'));

    await waitFor(() => expect(mocked.kpis).toHaveBeenCalledTimes(2));
    expect(mocked.production).toHaveBeenCalledTimes(2);
    expect(mocked.commerce).toHaveBeenCalledTimes(2);
    expect(mocked.purchase).toHaveBeenCalledTimes(2);
    expect(mocked.financial).not.toHaveBeenCalled();
    expect(mocked.mission).not.toHaveBeenCalled();
  });

  it('contains no polling, timers or intervals', () => {
    const source = executableSource('src/components/management/ManagementDashboardView.tsx');
    expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
  });
});

describe('queues and footer', () => {
  it('shows the commercial-decision queue under its approved label and as-of-now subtitle', async () => {
    setPermissions([COMMERCE]);
    render(<ManagementDashboardView />);

    expect(await screen.findByText('در انتظار تصمیم بازرگانی')).toBeInTheDocument();
    expect(screen.getByTestId('mgt-que-01-subtitle')).toHaveTextContent('وضعیت فعلی');
  });

  it('renders queues as a count only, never rows', async () => {
    setPermissions([COMMERCE, MISSION]);
    render(<ManagementDashboardView />);
    await screen.findByTestId('mgt-que-01-count');

    expect(screen.getByTestId('mgt-que-01').querySelectorAll('li, tr, table')).toHaveLength(0);
    expect(screen.getByTestId('mgt-que-02').querySelectorAll('li, tr, table')).toHaveLength(0);
  });

  it('shows the honest empty message for a queue with zero pending', async () => {
    setPermissions([COMMERCE]);
    mocked.commerce.mockResolvedValue(0);
    render(<ManagementDashboardView />);

    expect(await screen.findByText('موردی در انتظار نیست.')).toBeInTheDocument();
    expect(screen.queryByTestId('mgt-que-01-count')).not.toBeInTheDocument();
  });

  it('drills the Financial card to /admin/reporting', async () => {
    setPermissions([FINANCIAL]);
    render(<ManagementDashboardView />);
    await screen.findByTestId('mgt-fin-01-chart');

    expect(screen.getByTestId('mgt-fin-01').querySelector('a')).toHaveAttribute('href', '/admin/reporting');
  });

  it('renders the four footer shortcuts', async () => {
    setPermissions([PRODUCTION]);
    render(<ManagementDashboardView />);

    const nav = screen.getByRole('navigation', { name: 'پیوندهای سریع' });
    expect(nav.querySelectorAll('a')).toHaveLength(4);
    expect(nav.querySelector('a[href="/admin/kpis"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/admin/reporting"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/admin/reporting/purchase-requests"]')).not.toBeNull();
    expect(nav.querySelector('a[href="/admin/reporting/production"]')).not.toBeNull();
  });
});

