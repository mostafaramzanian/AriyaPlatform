import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrPositionsView } from '../HrPositionsView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import {
  createHrPosition,
  fetchHrPositions,
  fetchHrUnits,
  setHrPositionStatus,
  updateHrPosition,
} from '@/lib/hr-api';
import { page, position, unit } from './hr-fixtures';

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-api', () => ({
  ...jest.requireActual('@/lib/hr-api'),
  fetchHrPositions: jest.fn(),
  fetchHrUnits: jest.fn(),
  createHrPosition: jest.fn(),
  updateHrPosition: jest.fn(),
  setHrPositionStatus: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const listMock = fetchHrPositions as jest.MockedFunction<typeof fetchHrPositions>;
const unitsMock = fetchHrUnits as jest.MockedFunction<typeof fetchHrUnits>;
const createMock = createHrPosition as jest.MockedFunction<typeof createHrPosition>;
const updateMock = updateHrPosition as jest.MockedFunction<typeof updateHrPosition>;
const statusMock = setHrPositionStatus as jest.MockedFunction<typeof setHrPositionStatus>;

const READ = 'hr.positions.read';
const MANAGE = 'hr.positions.manage';
const ORG_READ = 'hr.organization.read';

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

/** Elements are reached by id: the panel reuses several of the filter labels. */
const byId = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
};

describe('HrPositionsView', () => {
  beforeEach(() => {
    grant([READ, MANAGE, ORG_READ]);
    listMock.mockResolvedValue(page([position()], 1));
    unitsMock.mockResolvedValue(page([unit()]));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('waits for the permission answer before it issues any read', () => {
    grant([], true);

    render(<HrPositionsView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('refuses the catalogue without hr.positions.read and reads nothing', () => {
    grant([]);

    render(<HrPositionsView />);

    // The message names the missing grant; asserting on the grant keeps the spec
    // independent of the exact Persian wording.
    expect(screen.getByText(/hr\.positions\.read/)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-position-table')).not.toBeInTheDocument();
    expect(listMock).not.toHaveBeenCalled();
    expect(unitsMock).not.toHaveBeenCalled();
  });

  it('renders the real position rows with their unit and status word', async () => {
    listMock.mockResolvedValue(
      page([position({ id: 'pos-9', code: 'POS-9', title: 'تحلیلگر داده' })], 1),
    );

    render(<HrPositionsView />);

    expect(await screen.findByTestId('hr-position-row-pos-9')).toBeInTheDocument();
    expect(screen.getByText('POS-9')).toBeInTheDocument();
    expect(screen.getByText('تحلیلگر داده')).toBeInTheDocument();
    expect(screen.getByText('فناوری اطلاعات')).toBeInTheDocument();
    expect(screen.getByTestId('hr-record-status-ACTIVE')).toHaveTextContent('فعال');
  });

  it('drives the server search after the debounce rather than per keystroke', async () => {
    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');
    listMock.mockClear();

    await userEvent.type(byId<HTMLInputElement>('hr-position-search'), 'تحلیلگر');

    await waitFor(
      () =>
        expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'تحلیلگر' })),
      { timeout: 5000 },
    );
    // Typing eight characters never becomes eight requests.
    expect(listMock.mock.calls.length).toBeLessThan(3);
  });

  it('sends the status filter only when one is chosen', async () => {
    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: undefined }));

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-position-status-filter'), 'INACTIVE');

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'INACTIVE' })),
    );
  });

  it('distinguishes an honestly empty catalogue from an empty filter result', async () => {
    listMock.mockResolvedValue(page([]));

    render(<HrPositionsView />);

    expect(await screen.findByText('هنوز سمتی ثبت نشده است.')).toBeInTheDocument();

    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-position-status-filter'), 'ACTIVE');

    expect(await screen.findByText('هیچ سمتی با این فیلترها یافت نشد.')).toBeInTheDocument();
  });

  it('renders a 403 as forbidden without offering a retry that cannot succeed', async () => {
    listMock.mockRejectedValue(new CoreApiError('شما به این بخش دسترسی ندارید.', 403));

    render(<HrPositionsView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تلاش دوباره' })).not.toBeInTheDocument();
  });

  it('renders a retryable failure and re-reads on retry', async () => {
    listMock.mockRejectedValueOnce(new CoreApiError('دریافت فهرست سمت‌ها با خطا مواجه شد.', 500));

    render(<HrPositionsView />);

    expect(await screen.findByText('دریافت فهرست سمت‌ها با خطا مواجه شد.')).toBeInTheDocument();

    listMock.mockResolvedValue(page([position()], 1));
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByTestId('hr-position-table')).toBeInTheDocument();
  });

  it('pages forward through the server and disables the previous control on page one', async () => {
    listMock.mockResolvedValue(page([position()], 45));

    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    expect(screen.getByTestId('hr-position-prev')).toBeDisabled();

    await userEvent.click(screen.getByTestId('hr-position-next'));

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    );
  });
  it('hides every mutation control without hr.positions.manage', async () => {
    grant([READ, ORG_READ]);

    render(<HrPositionsView />);

    await screen.findByTestId('hr-position-table');
    expect(screen.queryByTestId('hr-position-create-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-position-edit-pos-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('hr-position-toggle-pos-1')).not.toBeInTheDocument();
    // And it does not read a catalogue it has no permission to show.
    expect(unitsMock).not.toHaveBeenCalled();
  });

  it('offers no delete control at all — a position is retired, never removed', async () => {
    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    const row = screen.getByTestId('hr-position-row-pos-1');
    const labels = Array.from(row.querySelectorAll('button')).map((button) => button.textContent);
    expect(labels).not.toContain('حذف');
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('creates a position from the real form and reloads the list', async () => {
    createMock.mockResolvedValue(position({ id: 'pos-new', title: 'کارشناس شبکه' }));

    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    await userEvent.click(screen.getByTestId('hr-position-create-open'));
    await userEvent.type(byId<HTMLInputElement>('hr-position-code'), 'POS-200');
    await userEvent.type(byId<HTMLInputElement>('hr-position-title'), 'کارشناس شبکه');
    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-position-unit'), 'unit-1');
    await userEvent.click(screen.getByTestId('hr-position-create-submit'));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        code: 'POS-200',
        title: 'کارشناس شبکه',
        organizationUnitId: 'unit-1',
      }),
    );
    expect(await screen.findByTestId('hr-notice-ok')).toHaveTextContent(/ثبت شد/);
  });

  /**
   * A genuinely blank field never reaches this component's own validator: `code`, `title` and
   * `organizationUnitId` all carry the `required` attribute, so the BROWSER refuses the submit
   * first and `onSubmit` is never called. Asserting a local message for an empty title would
   * therefore be asserting behaviour the form does not have.
   *
   * The reachable branch is a field that satisfies `required` but breaks the machine-key rule:
   * a non-empty, non-uppercase code. That is what this pins — and it must cost no request.
   */
  it('refuses a create whose code breaks the machine-key rule, without spending a request', async () => {
    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    await userEvent.click(screen.getByTestId('hr-position-create-open'));
    await userEvent.type(byId<HTMLInputElement>('hr-position-code'), 'pos-201');
    await userEvent.type(byId<HTMLInputElement>('hr-position-title'), 'کارشناس شبکه');
    await userEvent.selectOptions(byId<HTMLSelectElement>('hr-position-unit'), 'unit-1');
    await userEvent.click(screen.getByTestId('hr-position-create-submit'));

    expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent(/کد سمت/);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('requires the organisation unit even when code and title are filled', async () => {
    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    await userEvent.click(screen.getByTestId('hr-position-create-open'));
    await userEvent.type(byId<HTMLInputElement>('hr-position-code'), 'POS-201');
    await userEvent.type(byId<HTMLInputElement>('hr-position-title'), 'کارشناس شبکه');
    await userEvent.click(screen.getByTestId('hr-position-create-submit'));

    // The unit select is `required` too, so the browser blocks the submit and the API
    // client is never reached — the property that matters is that nothing was sent.
    await waitFor(() => expect(createMock).not.toHaveBeenCalled());
    expect(screen.getByTestId('hr-position-form-create')).toBeInTheDocument();
  });

  it('updates a position without ever sending the immutable code', async () => {
    updateMock.mockResolvedValue(position({ title: 'کارشناس ارشد امنیت' }));

    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    await userEvent.click(screen.getByTestId('hr-position-edit-pos-1'));

    // The code is the position's identity: it is shown, but frozen.
    expect(byId<HTMLInputElement>('hr-position-code')).toBeDisabled();

    const title = byId<HTMLInputElement>('hr-position-title');
    await userEvent.clear(title);
    await userEvent.type(title, 'کارشناس ارشد امنیت');
    await userEvent.click(screen.getByTestId('hr-position-edit-submit'));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith('pos-1', {
        title: 'کارشناس ارشد امنیت',
        organizationUnitId: 'unit-1',
      }),
    );
    const payload = updateMock.mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty('code');
  });

  it('retires an active position through the status route and reports its failure', async () => {
    statusMock.mockRejectedValueOnce(new CoreApiError('تعارض با وضعیت فعلی داده', 409));

    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    await userEvent.click(screen.getByTestId('hr-position-toggle-pos-1'));

    await waitFor(() => expect(statusMock).toHaveBeenCalledWith('pos-1', 'INACTIVE'));
    expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent('تعارض');
  });

  it('keeps a rejected mutation from corrupting the row already on screen', async () => {
    updateMock.mockRejectedValue(new CoreApiError('تعارض با وضعیت فعلی داده', 409));

    render(<HrPositionsView />);
    await screen.findByTestId('hr-position-table');

    await userEvent.click(screen.getByTestId('hr-position-edit-pos-1'));
    const title = byId<HTMLInputElement>('hr-position-title');
    await userEvent.clear(title);
    await userEvent.type(title, 'عنوان ردشده');
    await userEvent.click(screen.getByTestId('hr-position-edit-submit'));

    expect(await screen.findByTestId('hr-notice-error')).toBeInTheDocument();
    // The screen still shows the server's value, never the rejected draft.
    expect(screen.getByTestId('hr-position-row-pos-1')).toHaveTextContent('کارشناس');
  });
});

