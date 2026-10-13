import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrDashboardView } from '../HrDashboardView';
import { CoreApiError } from '@/lib/core-http';
import { fetchHrEmployees, fetchHrOrganizationSummary } from '@/lib/hr-api';
import { employee, page, summary } from './hr-fixtures';

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrEmployees: jest.fn(),
  fetchHrOrganizationSummary: jest.fn(),
}));

const summaryMock = fetchHrOrganizationSummary as jest.MockedFunction<
  typeof fetchHrOrganizationSummary
>;
const employeesMock = fetchHrEmployees as jest.MockedFunction<typeof fetchHrEmployees>;

/** The screen formats counts with `fa-IR`; the assertion is computed the same way. */
const fa = (value: number) => value.toLocaleString('fa-IR');

describe('HrDashboardView', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('holds the screen in an accessible loading state until BOTH reads settle', () => {
    summaryMock.mockReturnValue(new Promise(() => undefined));
    employeesMock.mockReturnValue(new Promise(() => undefined));

    render(<HrDashboardView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    // Nothing is rendered from a half-loaded pair.
    expect(screen.queryByTestId('hr-dashboard')).not.toBeInTheDocument();
  });

  it('shows the counts the SERVER computed, not arithmetic over the returned page', async () => {
    summaryMock.mockResolvedValue(
      summary({ employees: 137, units: 9, activeUnits: 7, positions: 41 }),
    );
    // One row, a total of 137: the dashboard must repeat 137 and must not count the rows.
    employeesMock.mockResolvedValue(page([employee()], 137));

    render(<HrDashboardView />);

    expect(await screen.findByTestId('hr-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('hr-count-employees')).toHaveTextContent(fa(137));
    expect(screen.getByTestId('hr-count-units')).toHaveTextContent(fa(9));
    expect(screen.getByTestId('hr-count-active-units')).toHaveTextContent(fa(7));
    expect(screen.getByTestId('hr-count-positions')).toHaveTextContent(fa(41));

    // Exactly the one sample row was rendered — so 137 provably did not come from this list.
    expect(screen.getAllByTestId(/^hr-dashboard-employee-/)).toHaveLength(1);
  });

  it('asks the list route for a five-row sample and the summary route for the totals', async () => {
    summaryMock.mockResolvedValue(summary());
    employeesMock.mockResolvedValue(page([employee()]));

    render(<HrDashboardView />);

    await screen.findByTestId('hr-dashboard');
    expect(employeesMock).toHaveBeenCalledWith({ pageSize: 5 });
    expect(summaryMock).toHaveBeenCalledTimes(1);
  });

  it('points the five area cards at the real HR routes', async () => {
    summaryMock.mockResolvedValue(summary());
    employeesMock.mockResolvedValue(page([employee()]));

    render(<HrDashboardView />);

    await screen.findByTestId('hr-dashboard');
    expect(screen.getByTestId('hr-area-employees')).toHaveAttribute(
      'href',
      '/admin/hr/employees',
    );
    expect(screen.getByTestId('hr-area-organization')).toHaveAttribute(
      'href',
      '/admin/hr/organization',
    );
    expect(screen.getByTestId('hr-area-positions')).toHaveAttribute(
      'href',
      '/admin/hr/positions',
    );
    // Phase 51-HR-2E: the attendance register is a real area of the module, so the home
    // page links to it like the other three — a page reachable only by typing a URL would
    // not be navigation.
    expect(screen.getByTestId('hr-area-attendance')).toHaveAttribute(
      'href',
      '/admin/hr/attendance'
    );
    // Phase 51-HR-3A: the leave register joins the home page's areas with the same shape —
    // one card, one real route.
    expect(screen.getByTestId('hr-area-leave')).toHaveAttribute('href', '/admin/hr/leave');
  });

  it('links each sampled employee to its own detail route', async () => {
    summaryMock.mockResolvedValue(summary());
    employeesMock.mockResolvedValue(page([employee({ id: 'emp-9', employeeCode: 'E-9' })]));

    render(<HrDashboardView />);

    const link = await screen.findByTestId('hr-dashboard-employee-E-9');
    expect(link).toHaveAttribute('href', '/admin/hr/employees/emp-9');
  });

  it('renders the empty state when the tenant genuinely has no personnel file', async () => {
    summaryMock.mockResolvedValue(summary({ employees: 0 }));
    employeesMock.mockResolvedValue(page([]));

    render(<HrDashboardView />);

    expect(await screen.findByText('هنوز پرونده پرسنلی ثبت نشده است.')).toBeInTheDocument();
    expect(screen.getByTestId('hr-count-employees')).toHaveTextContent(fa(0));
  });

  it('renders 403 as an authorization answer with NO retry control', async () => {
    summaryMock.mockRejectedValue(new CoreApiError('شما به این بخش دسترسی ندارید.', 403));
    employeesMock.mockResolvedValue(page([]));

    render(<HrDashboardView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    // A retry can never succeed while the grant is missing, so it is not offered.
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-dashboard')).not.toBeInTheDocument();
  });

  it('renders a failure with the API message and re-reads on retry', async () => {
    summaryMock.mockRejectedValueOnce(new CoreApiError('دریافت با خطا مواجه شد.', 500));
    employeesMock.mockRejectedValueOnce(new CoreApiError('دریافت با خطا مواجه شد.', 500));

    render(<HrDashboardView />);

    expect(await screen.findByText('دریافت با خطا مواجه شد.')).toBeInTheDocument();

    // The retry is one more real round of reads, not a local reset.
    summaryMock.mockResolvedValue(summary());
    employeesMock.mockResolvedValue(page([employee()]));

    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    await waitFor(() => expect(screen.getByTestId('hr-dashboard')).toBeInTheDocument());
    expect(summaryMock).toHaveBeenCalledTimes(2);
    expect(employeesMock).toHaveBeenCalledTimes(2);
  });
});
