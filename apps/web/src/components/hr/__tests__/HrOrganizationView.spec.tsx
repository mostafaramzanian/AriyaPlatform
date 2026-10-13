import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrOrganizationView } from '../HrOrganizationView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import {
  createHrUnit,
  fetchHrOrganizationTree,
  fetchHrUnits,
  setHrUnitStatus,
  updateHrUnit,
} from '@/lib/hr-api';
import { node, page, tree, unit } from './hr-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrOrganizationTree: jest.fn(),
  fetchHrUnits: jest.fn(),
  createHrUnit: jest.fn(),
  updateHrUnit: jest.fn(),
  setHrUnitStatus: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const treeMock = fetchHrOrganizationTree as jest.MockedFunction<typeof fetchHrOrganizationTree>;
const unitsMock = fetchHrUnits as jest.MockedFunction<typeof fetchHrUnits>;
const createMock = createHrUnit as jest.MockedFunction<typeof createHrUnit>;
const updateMock = updateHrUnit as jest.MockedFunction<typeof updateHrUnit>;
const statusMock = setHrUnitStatus as jest.MockedFunction<typeof setHrUnitStatus>;

const READ = 'hr.organization.read';
const MANAGE = 'hr.organization.manage';

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

const byId = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

/**
 * A two-level chart, so NESTING can be asserted rather than order.
 *
 * `data-depth` is the contract the component exposes for exactly this: a flat list that happens
 * to be alphabetically right is the bug a hierarchy screen actually ships, so the parent/child
 * relationship — not the sequence — is what these tests pin.
 */
const CHART = tree([
  node({
    id: 'unit-1',
    code: 'U-100',
    name: 'فناوری اطلاعات',
    children: [
      node({ id: 'unit-2', code: 'U-110', name: 'توسعه نرم‌افزار', parentId: 'unit-1' }),
      node({ id: 'unit-3', code: 'U-120', name: 'زیرساخت', parentId: 'unit-1' }),
    ],
  }),
  node({ id: 'unit-4', code: 'U-200', name: 'مالی', parentId: null }),
]);

const FORBIDDEN = 'برای مشاهده چارت سازمانی به مجوز hr.organization.read نیاز دارید.';

function settle(units = [unit()], chart = CHART) {
  treeMock.mockResolvedValue(chart);
  unitsMock.mockResolvedValue(page(units, units.length));
}

describe('HrOrganizationView', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('gates the whole screen on hr.organization.read without reading anything', () => {
    grant([]);

    render(<HrOrganizationView />);

    expect(screen.getByText(FORBIDDEN)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-organization')).not.toBeInTheDocument();
    // A screen without the read grant does not spend two requests discovering that.
    expect(treeMock).not.toHaveBeenCalled();
    expect(unitsMock).not.toHaveBeenCalled();
  });

  it('holds the screen in an accessible loading state until permissions resolve', () => {
    grant([], true);

    render(<HrOrganizationView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-organization')).not.toBeInTheDocument();
  });

  it('renders the chart as a real hierarchy, not a flat list', async () => {
    grant([READ]);
    settle();

    render(<HrOrganizationView />);
    await screen.findByTestId('hr-org-tree');

    expect(screen.getByTestId('hr-org-node-U-100')).toHaveAttribute('data-depth', '0');
    expect(screen.getByTestId('hr-org-node-U-110')).toHaveAttribute('data-depth', '1');
    expect(screen.getByTestId('hr-org-node-U-200')).toHaveAttribute('data-depth', '0');
    // The child really lives INSIDE the parent's subtree, not merely after it in the DOM.
    expect(
      screen.getByTestId('hr-org-node-U-100').contains(screen.getByTestId('hr-org-node-U-110')),
    ).toBe(true);
  });

  it('counts every unit in the chart through the flattened total', async () => {
    grant([READ]);
    settle();

    render(<HrOrganizationView />);

    expect(await screen.findByTestId('hr-org-tree-total')).toHaveTextContent(
      (4).toLocaleString('fa-IR'),
    );
  });

  it('shows the empty chart state when the tenant has no units', async () => {
    grant([READ]);
    settle([], tree([]));

    render(<HrOrganizationView />);

    /**
     * Both the chart card AND the units table are empty in this scenario, so the assertion is
     * scoped to the CARD: an unscoped text query would match two nodes and would therefore
     * pass even if the chart had rendered its own contradiction. `hr-org-tree` must be absent —
     * an empty chart is an empty state, never an empty `<ul>`.
     */
    expect(
      within(await screen.findByTestId('hr-org-tree-card')).getByText(
        'هنوز واحد سازمانی ثبت نشده است.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('hr-org-tree')).not.toBeInTheDocument();
  });

  it('surfaces a retryable error and re-reads the chart on retry', async () => {
    grant([READ]);
    treeMock.mockRejectedValueOnce(new CoreApiError('خطای شبکه', 500));
    unitsMock.mockResolvedValue(page([unit()]));

    render(<HrOrganizationView />);
    await screen.findByText('خطای شبکه');

    treeMock.mockResolvedValue(CHART);
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByTestId('hr-org-tree')).toBeInTheDocument();
  });

  it('offers NO delete control — a unit is retired, never removed', async () => {
    grant([READ, MANAGE]);
    settle();

    render(<HrOrganizationView />);
    await screen.findByTestId('hr-unit-table');

    const labels = Array.from(document.querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).not.toContain('حذف');
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('hides every write control from a read-only operator', async () => {
    grant([READ]);
    settle();

    render(<HrOrganizationView />);
    await screen.findByTestId('hr-unit-table');

    expect(screen.queryByTestId('hr-unit-create-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-unit-edit-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-unit-toggle-status')).not.toBeInTheDocument();
  });

  it('answers a server 403 with the forbidden message and renders NO organization data', async () => {
    grant([READ]);
    // The grant is present on the client but the SERVER refuses: the backend stays
    // authoritative. The screen keeps its shell — which is what makes the refusal legible —
    // but every unit read must come back empty rather than partially populated.
    treeMock.mockRejectedValue(new CoreApiError('شما به این بخش دسترسی ندارید.', 403));
    unitsMock.mockRejectedValue(new CoreApiError('شما به این بخش دسترسی ندارید.', 403));

    render(<HrOrganizationView />);

    const notice = (await screen.findAllByRole('alert'))[0];
    expect(notice).toHaveTextContent('شما به این بخش دسترسی ندارید.');

    // NO DATA LEAKED: no chart node, no table, no rows, and a zero total.
    expect(screen.queryByTestId('hr-org-tree')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-unit-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-org-node-U-100')).not.toBeInTheDocument();
    expect(await screen.findByTestId('hr-unit-total')).toHaveTextContent('۰');

    // A permission answer is not retryable, so no retry control is offered for it, and the
    // refusal must never be dressed up as a generic 500-style failure.
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  it('sends an OMITTED parent for a root unit, never a null or an empty string', async () => {
    grant([READ, MANAGE]);
    settle();
    createMock.mockResolvedValue(unit({ id: 'unit-9', code: 'U-900', name: 'پشتیبانی' }));

    render(<HrOrganizationView />);
    await screen.findByTestId('hr-unit-table');

    await userEvent.click(screen.getByTestId('hr-unit-create-open'));
    await userEvent.type(byId<HTMLInputElement>('hr-unit-code'), 'U-900');
    await userEvent.type(byId<HTMLInputElement>('hr-unit-name'), 'پشتیبانی');
    await userEvent.click(screen.getByTestId('hr-unit-create-submit'));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ code: 'U-900', name: 'پشتیبانی' }));
    // The confirmation carries the name the SERVER echoed, not the one that was typed.
    expect(await screen.findByTestId('hr-notice-ok')).toHaveTextContent(/پشتیبانی/);
  });

  it('re-parents a unit and never sends the immutable code', async () => {
    grant([READ, MANAGE]);
    // The TABLE row is what carries the select test hook, so the unit being edited must be in
    // the paged list as well as in the chart.
    settle([unit({ id: 'unit-4', code: 'U-200', name: 'مالی' })]);
    updateMock.mockResolvedValue(unit({ id: 'unit-4', code: 'U-200', name: 'مالی' }));

    render(<HrOrganizationView />);
    await screen.findByTestId('hr-unit-table');

    await userEvent.click(screen.getByTestId('hr-unit-select-row-U-200'));
    await userEvent.click(await screen.findByTestId('hr-unit-edit-open'));
    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-unit-parent'), 'unit-1');
    await userEvent.click(screen.getByTestId('hr-unit-edit-submit'));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith('unit-4', { name: 'مالی', parentId: 'unit-1' }),
    );
    // `UpdateOrganizationUnitDto` has no `code` field: sending one would be rejected outright
    // by the whitelist pipe, so the code must never appear in the payload.
    expect(updateMock.mock.calls[0][1]).not.toHaveProperty('code');
  });
});