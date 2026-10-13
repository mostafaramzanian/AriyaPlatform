import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrEmployeesView } from '../HrEmployeesView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import {
  fetchHrEmployees,
  fetchHrPositions,
  fetchHrUnits,
} from '@/lib/hr-api';
import { employee, page, position, unit } from './hr-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrEmployees: jest.fn(),
  fetchHrUnits: jest.fn(),
  fetchHrPositions: jest.fn(),
  createHrEmployee: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const employeesMock = fetchHrEmployees as jest.MockedFunction<typeof fetchHrEmployees>;
const unitsMock = fetchHrUnits as jest.MockedFunction<typeof fetchHrUnits>;
const positionsMock = fetchHrPositions as jest.MockedFunction<typeof fetchHrPositions>;

const READ = 'hr.employees.read';
const MANAGE = 'hr.employees.manage';
const ORG_READ = 'hr.organization.read';
const POS_READ = 'hr.positions.read';

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

/** Elements are reached by id: the create form duplicates several filter labels. */
const byId = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

const FORBIDDEN = 'برای مشاهده پرونده‌های پرسنلی به مجوز hr.employees.read نیاز دارید.';

function settleCatalogues() {
  unitsMock.mockResolvedValue(page([unit()]));
  positionsMock.mockResolvedValue(page([position()]));
}

describe('HrEmployeesView', () => {
  beforeEach(() => {
    grant([READ, MANAGE, ORG_READ, POS_READ]);
    employeesMock.mockResolvedValue(page([employee()], 1));
    settleCatalogues();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('waits for the permission answer before it decides what to show', () => {
    grant([], true);

    render(<HrEmployeesView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-employees')).not.toBeInTheDocument();
    // No request is issued while the grant is still unknown.
    expect(employeesMock).not.toHaveBeenCalled();
  });

  it('refuses the screen without hr.employees.read and reads nothing', () => {
    grant([]);

    render(<HrEmployeesView />);

    expect(screen.getByText(FORBIDDEN)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-employee-table')).not.toBeInTheDocument();
    expect(employeesMock).not.toHaveBeenCalled();
  });

  it('renders the real list route, each row linking to its detail route', async () => {
    employeesMock.mockResolvedValue(page([employee({ id: 'emp-7', employeeCode: 'E-7' })], 1));

    render(<HrEmployeesView />);

    const link = await screen.findByTestId('hr-employee-link-E-7');
    expect(link).toHaveAttribute('href', '/admin/hr/employees/emp-7');

    // Scoped to the table: the unit and position names are also the filter `<option>`
    // labels, so an unscoped query would match the filter as well as the row.
    const table = within(screen.getByTestId('hr-employee-table'));
    // The unit and the position come from the derived assignment, not from the employee row.
    // The expected strings are taken FROM THE FIXTURE rather than retyped: these labels carry
    // a Persian zero-width non-joiner, and a hand-copied literal is a different string which
    // would then fail for a reason that has nothing to do with the screen under test.
    expect(table.getByText(unit().name)).toBeInTheDocument();
    expect(table.getByText(position().title)).toBeInTheDocument();
  });

  it('never renders security metadata even when the API returns it', async () => {
    employeesMock.mockResolvedValue(
      page([
        employee({
          passwordHash: 'super-secret-hash',
          tokenVersion: 7,
        } as never),
      ]),
    );

    render(<HrEmployeesView />);

    await screen.findByTestId('hr-employee-table');
    expect(screen.queryByText('super-secret-hash')).not.toBeInTheDocument();
    // The tenant is never echoed back to the operator either.
    expect(screen.queryByText('tenant-hr-2b')).not.toBeInTheDocument();
  });

  it('debounces typing into a single server-backed search request', async () => {
    render(<HrEmployeesView />);
    await screen.findByTestId('hr-employee-table');

    await userEvent.type(byId<HTMLInputElement>('hr-employee-search'), 'نوری');

    await waitFor(
      () =>
        expect(employeesMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ search: 'نوری' }),
        ),
      { timeout: 5000 },
    );
    // A filter change is a NEW query: it goes back to page one.
    expect(employeesMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });

  it('sends the status filter to the server instead of filtering locally', async () => {
    render(<HrEmployeesView />);
    await screen.findByTestId('hr-employee-table');

    await userEvent.selectOptions(
      byId<HTMLSelectElement>('hr-employee-status-filter'),
      'TERMINATED',
    );

    await waitFor(() =>
      expect(employeesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'TERMINATED', page: 1 }),
      ),
    );
  });

  it('scopes by unit and drops a position that does not belong to the new unit', async () => {
    unitsMock.mockResolvedValue(page([unit(), unit({ id: 'unit-2', code: 'U-200' })]));
    positionsMock.mockResolvedValue(
      page([position(), position({ id: 'pos-2', organizationUnitId: 'unit-2' })]),
    );

    render(<HrEmployeesView />);
    await screen.findByTestId('hr-employee-table');

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-employee-unit-filter'), 'unit-1');
    await waitFor(() =>
      expect(employeesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationUnitId: 'unit-1' }),
      ),
    );

    // pos-1 is a legal filter for unit-1 …
    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-employee-position-filter'), 'pos-1');
    await waitFor(() =>
      expect(employeesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationUnitId: 'unit-1', positionId: 'pos-1' }),
      ),
    );

    // … but not for unit-2, so switching units must clear it rather than send it.
    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-employee-unit-filter'), 'unit-2');

    await waitFor(() =>
      expect(employeesMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ organizationUnitId: 'unit-2' }),
      ),
    );
    const lastCall = employeesMock.mock.calls.at(-1)?.[0];
    expect(lastCall?.positionId).toBeUndefined();
    expect(byId<HTMLSelectElement>('hr-employee-position-filter').value).toBe('');
  });

  it('distinguishes an honestly empty tenant from an empty filter result', async () => {
    employeesMock.mockResolvedValue(page([]));

    render(<HrEmployeesView />);

    expect(await screen.findByText('هنوز پرونده پرسنلی ثبت نشده است.')).toBeInTheDocument();

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-employee-status-filter'), 'ACTIVE');

    expect(await screen.findByText('هیچ کارمندی با این فیلترها یافت نشد.')).toBeInTheDocument();
  });

  it('renders a 403 from the list route as forbidden, with no retry', async () => {
    employeesMock.mockRejectedValue(new CoreApiError('شما به این بخش دسترسی ندارید.', 403));

    render(<HrEmployeesView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  it('renders a retryable failure and re-reads the same query', async () => {
    employeesMock.mockRejectedValueOnce(
      new CoreApiError('دریافت فهرست کارکنان با خطا مواجه شد.', 500),
    );

    render(<HrEmployeesView />);

    expect(await screen.findByText('دریافت فهرست کارکنان با خطا مواجه شد.')).toBeInTheDocument();

    employeesMock.mockResolvedValue(page([employee()], 1));
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByTestId('hr-employee-table')).toBeInTheDocument();
  });

  it('disables the previous control on page one and pages forward through the server', async () => {
    employeesMock.mockResolvedValue(page([employee()], 45));

    render(<HrEmployeesView />);
    await screen.findByTestId('hr-employee-table');

    expect(screen.getByTestId('hr-employee-prev')).toBeDisabled();

    await userEvent.click(screen.getByTestId('hr-employee-next'));

    await waitFor(() =>
      expect(employeesMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    );
    expect(screen.getByTestId('hr-employee-prev')).toBeEnabled();
  });

  it('hides every mutation control without hr.employees.manage', async () => {
    grant([READ]);

    render(<HrEmployeesView />);

    await screen.findByTestId('hr-employee-table');
    expect(screen.queryByTestId('hr-employee-create-open')).not.toBeInTheDocument();
    // And it does not read the catalogues it has no permission for.
    expect(unitsMock).not.toHaveBeenCalled();
    expect(positionsMock).not.toHaveBeenCalled();
  });

  it('disables creation when manage is held without the catalogue reads', async () => {
    grant([READ, MANAGE]);

    render(<HrEmployeesView />);

    await screen.findByTestId('hr-employee-table');
    expect(screen.getByTestId('hr-employee-create-open')).toBeDisabled();
    expect(
      screen.getByText(
        'برای ثبت پرونده جدید، مجوز خواندن چارت سازمانی (hr.organization.read) و سمت‌ها (hr.positions.read) نیز لازم است.',
      ),
    ).toBeInTheDocument();
  });

  // __HR_EMPLOYEES_SPEC_PART_4__
});
