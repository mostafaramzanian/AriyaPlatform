import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommercePurchaseCreateView } from '../CommercePurchaseCreateView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { useAuth } from '@/components/providers/AuthProvider';
import {
  createCommercePurchaseDocument,
  fetchCommercePurchaseDocument,
  submitCommercePurchaseDocument,
  updateCommercePurchaseDocument,
  type CommercePurchaseDocument,
} from '@/lib/commerce-api';
import { CoreApiError } from '@/lib/core-http';
import { fetchDirectory, fetchDirectoryMember } from '@/lib/directory-api';
import { purchaseDocument } from './commerce-fixtures';

const push = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn() }),
  usePathname: () => '/admin/commerce/purchases/new',
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
  createCommercePurchaseDocument: jest.fn(),
  updateCommercePurchaseDocument: jest.fn(),
  submitCommercePurchaseDocument: jest.fn(),
  fetchCommercePurchaseDocument: jest.fn(),
}));

jest.mock('@/lib/directory-api', () => ({
  ...jest.requireActual('@/lib/directory-api'),
  fetchDirectory: jest.fn(),
  fetchDirectoryMember: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const authMock = useAuth as jest.MockedFunction<typeof useAuth>;
const createMock = createCommercePurchaseDocument as jest.MockedFunction<
  typeof createCommercePurchaseDocument
>;
const updateMock = updateCommercePurchaseDocument as jest.MockedFunction<
  typeof updateCommercePurchaseDocument
>;
const submitMock = submitCommercePurchaseDocument as jest.MockedFunction<
  typeof submitCommercePurchaseDocument
>;
const fetchDocMock = fetchCommercePurchaseDocument as jest.MockedFunction<
  typeof fetchCommercePurchaseDocument
>;
const directoryMock = fetchDirectory as jest.MockedFunction<typeof fetchDirectory>;
const directoryMemberMock = fetchDirectoryMember as jest.MockedFunction<typeof fetchDirectoryMember>;

function grant(permissions: string[]) {
  permissionsMock.mockReturnValue({
    permissions,
    roles: [],
    highestRole: null,
    isLoading: false,
    error: null,
    status: null,
    reload: jest.fn(),
  });
}

/**
 * A real UUID v4 — one OPAQUE id among others since GAP-8 (the platform's contract for a
 * user id is `@IsString() @MaxLength(64)`; UUID v4 is only the mint default). The form
 * mirrors the DTO's own bound (non-empty, ≤64) before it ever posts; the server re-validates.
 */
const REQUESTER_ID = '4f8a2f10-1234-4a5b-8c6d-7e9f0a1b2c3d';

function authState(userId: string | null = REQUESTER_ID) {
  return {
    user: userId ? { userId } : null,
    isLoading: false,
    error: null,
    isAuthenticated: userId !== null,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
  } as ReturnType<typeof useAuth>;
}

/**
 * PHASE UI-2: Purchase Create — the progressive form, the exact DTO shapes, the
 * draft-vs-submit distinction, and the promise that a FAILED request never loses what the
 * user typed (UI-2 §5/§11/§13/§29).
 */
describe('CommercePurchaseCreateView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    grant(['commerce.read', 'commerce.manage']);
    authMock.mockReturnValue(authState());
    createMock.mockResolvedValue(purchaseDocument());
    submitMock.mockResolvedValue(purchaseDocument({ status: 'SUBMITTED' }));
  });

  /** Walks the wizard from step 1 to the review step with one line of the given quantity. */
  async function reachReview(quantity = '10') {
    const user = userEvent.setup();
    await user.click(screen.getByTestId('commerce-create-next'));
    await screen.findByTestId('commerce-lines-editor');
    await user.type(screen.getByLabelText('مقدار'), quantity);
    await user.click(screen.getByTestId('commerce-create-review'));
    await screen.findByTestId('commerce-purchase-review');
    return user;
  }

  it('refuses without commerce.manage and never reaches the form', () => {
    grant(['commerce.read']);

    render(<CommercePurchaseCreateView />);

    expect(screen.getByText(/commerce\.manage/)).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-purchase-create')).not.toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('starts with the session user as the requester and marks step 1 as the current step', () => {
    render(<CommercePurchaseCreateView />);

    // UI-5: without the directory grant the requester is a STATEMENT, not a text field —
    // a normal user cannot know a UUID, and the form never asks for one.
    expect(screen.getByTestId('commerce-create-requester-readonly')).toHaveTextContent('خود شما');
    expect(screen.getByTestId('commerce-create-step-details')).toHaveAttribute(
      'aria-current',
      'step'
    );
    expect(
      // h2: the shell header owns the page's single h1 (UI-3 browser QA finding).
      screen.getByRole('heading', { level: 2, name: 'درخواست خرید جدید' })
    ).toBeInTheDocument();
  });

  it('picks an OPAQUE requester from the real directory and sends that exact id (GAP-8)', async () => {
    grant(['commerce.read', 'commerce.manage', 'admin.users.read']);
    // Not a UUID: the directory's id is an opaque platform user id, sent verbatim.
    const memberId = 'reza-opaque-member';
    directoryMemberMock.mockResolvedValue({
      id: REQUESTER_ID,
      firstName: 'سارا',
      lastName: 'محمدی',
      email: 'sara@example.com',
    });
    directoryMock.mockResolvedValue({
      items: [
        { id: memberId, firstName: 'رضا', lastName: 'کریمی', email: 'reza@example.com' },
      ],
      hasMore: false,
    });

    render(<CommercePurchaseCreateView />);
    const user = userEvent.setup();

    // The control searches the directory instead of accepting a pasted id.
    await user.type(screen.getByTestId('commerce-create-requester-search'), 'رضا');
    await user.click(screen.getByTestId('commerce-create-requester-search-submit'));
    await waitFor(() => expect(directoryMock).toHaveBeenCalledWith({ q: 'رضا', limit: 20 }));
    await user.click(await screen.findByTestId(`commerce-create-requester-option-${memberId}`));

    await user.click(screen.getByTestId('commerce-create-next'));
    await screen.findByTestId('commerce-lines-editor');
    await user.type(screen.getByLabelText('مقدار'), '3');
    await user.click(screen.getByTestId('commerce-create-review'));
    await screen.findByTestId('commerce-purchase-review');
    await user.click(screen.getByTestId('commerce-create-save'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0].requesterId).toBe(memberId);
  });

  it('never calls the directory without admin.users.read and keeps the safe self default', () => {
    render(<CommercePurchaseCreateView />);

    expect(screen.getByTestId('commerce-create-requester-readonly')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-create-requester-search')).not.toBeInTheDocument();
    expect(directoryMock).not.toHaveBeenCalled();
    expect(directoryMemberMock).not.toHaveBeenCalled();
  });

  /**
   * GAP-8 (FORK A), the counterpart of the UI-5 workaround: the seeded administrator's id
   * (`super-admin-user`) is an OPAQUE platform user id, which is exactly what a Commerce
   * `requesterId` accepts. The self-default therefore works for the seeded admin too — the
   * form prefills the session id VERBATIM and sends that exact value, and membership is
   * verified server-side (`assertMember`), never guessed here.
   */
  it('pre-fills the seeded opaque admin id as the requester (self-default works for super-admin-user)', async () => {
    authMock.mockReturnValue(authState('super-admin-user'));
    grant(['commerce.read', 'commerce.manage']);

    render(<CommercePurchaseCreateView />);

    // Without the directory grant the requester is a read-only statement of self — and the
    // session's opaque id is usable, so the form does not start unselected.
    expect(screen.getByTestId('commerce-create-requester-readonly')).toHaveTextContent('خود شما');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('commerce-create-next'));
    await screen.findByTestId('commerce-lines-editor');
    await user.type(screen.getByLabelText('مقدار'), '3');
    await user.click(screen.getByTestId('commerce-create-review'));
    await screen.findByTestId('commerce-purchase-review');
    await user.click(screen.getByTestId('commerce-create-save'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock.mock.calls[0][0].requesterId).toBe('super-admin-user');
  });

  it('blocks an invalid currency at the presentation layer and stays on step 1', async () => {
    const user = userEvent.setup();
    render(<CommercePurchaseCreateView />);

    // Not a three-letter code — the field uppercases, so type exactly two letters.
    await user.type(screen.getByLabelText(/ارز/), 'ri');
    await user.click(screen.getByTestId('commerce-create-next'));

    expect(await screen.findByText(/ارز باید یک کد سه‌حرفی/)).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-lines-editor')).not.toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('creates a draft with the exact DTO shape — no tenant, no status, no documentNumber', async () => {
    render(<CommercePurchaseCreateView />);
    const user = await reachReview();

    await user.click(screen.getByTestId('commerce-create-save'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const [payload] = createMock.mock.calls[0];
    expect(payload.requesterId).toBe(REQUESTER_ID);
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0].quantity).toBe(10);
    expect(payload.lines[0].lineType).toBe('STANDARD');
    expect(JSON.stringify(payload)).not.toMatch(/tenant|status|documentNumber/);

    // Clear success feedback names WHAT happened, and the view exposes the saved document.
    expect(await screen.findByTestId('commerce-create-success')).toHaveTextContent(
      /پیش‌نویس ذخیره شد/
    );
    expect(await screen.findByTestId('commerce-create-open-detail')).toHaveAttribute(
      'href',
      '/admin/commerce/purchases/doc-1'
    );
  });

  it('saves a SECOND time through PATCH (never minting a second document)', async () => {
    render(<CommercePurchaseCreateView />);
    const user = await reachReview();
    await user.click(screen.getByTestId('commerce-create-save'));
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));

    updateMock.mockResolvedValue(purchaseDocument());
    await user.click(screen.getByTestId('commerce-create-save'));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      'doc-1',
      expect.objectContaining({ requesterId: REQUESTER_ID })
    );
  });

  it('ignores a double-click on save: one POST, not two', async () => {
    let resolveCreate: (value: CommercePurchaseDocument) => void = () => undefined;
    createMock.mockImplementation(() => new Promise((resolve) => (resolveCreate = resolve)));

    render(<CommercePurchaseCreateView />);
    const user = await reachReview();
    const save = screen.getByTestId('commerce-create-save');
    await user.click(save);
    expect(save).toBeDisabled();

    resolveCreate(purchaseDocument());
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
  });

  it('keeps every entered value when the backend refuses the request', async () => {
    render(<CommercePurchaseCreateView />);
    const user = userEvent.setup();

    // Typed on step 1 …
    await user.type(screen.getByLabelText(/شناسهٔ تأمین‌کننده/), 'SUP-9');
    await user.click(screen.getByTestId('commerce-create-next'));
    await screen.findByTestId('commerce-lines-editor');
    // … a line on step 2 …
    await user.type(screen.getByLabelText('مقدار'), '5');
    await user.click(screen.getByTestId('commerce-create-review'));
    await screen.findByTestId('commerce-purchase-review');

    createMock.mockRejectedValue(new CoreApiError('nope', 400));
    await user.click(screen.getByTestId('commerce-create-save'));

    expect(await screen.findByTestId('commerce-create-error')).toHaveTextContent(/معتبر نیست/);
    // Nothing was reset: still on the review step, with the entered text intact.
    expect(screen.getByTestId('commerce-purchase-review')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /مرحلهٔ قبل/ }));
    await screen.findByTestId('commerce-lines-editor');
    expect(screen.getByLabelText('مقدار')).toHaveValue('5');

    await user.click(screen.getByRole('button', { name: /مرحلهٔ قبل/ }));
    await waitFor(() =>
      expect(screen.getByLabelText(/شناسهٔ تأمین‌کننده/)).toHaveValue('SUP-9')
    );
  });

  it('asks for confirmation before submit and then goes to the real detail route', async () => {
    render(<CommercePurchaseCreateView />);
    const user = await reachReview();

    await user.click(screen.getByTestId('commerce-create-submit'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/قابل ویرایش نیست/)).toBeInTheDocument();

    await user.click(within(dialog).getByTestId('commerce-create-confirm-submit-confirm'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(submitMock).toHaveBeenCalledWith('doc-1'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/commerce/purchases/doc-1'));
  });

  it('loads an existing DRAFT for editing and PATCHes it instead of creating', async () => {
    const otherRequesterId = '9b7c1d20-4321-4cba-9f8e-1a2b3c4d5e6f';
    fetchDocMock.mockResolvedValue(
      purchaseDocument({
        requester: {
          id: otherRequesterId,
          profile: {
            id: otherRequesterId,
            firstName: 'رضا',
            lastName: 'کریمی',
            avatarUrl: null,
            jobTitle: null,
            department: null,
          },
        },
      })
    );
    const user = userEvent.setup();

    render(<CommercePurchaseCreateView editDocumentId="doc-1" />);

    // UI-5: the loaded requester is NAMED, not shown as a raw id.
    await waitFor(() =>
      expect(screen.getByTestId('commerce-create-requester-readonly')).toHaveTextContent(
        'رضا کریمی'
      )
    );
    await user.click(screen.getByTestId('commerce-create-step-lines'));
    await screen.findByTestId('commerce-lines-editor');
    await user.click(screen.getByTestId('commerce-create-review'));
    await screen.findByTestId('commerce-purchase-review');
    await user.click(screen.getByTestId('commerce-create-save'));

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(createMock).not.toHaveBeenCalled();
    // The PATCH still states the requester it loaded, unchanged and never invented.
    expect(updateMock.mock.calls[0][1].requesterId).toBe(otherRequesterId);
  });

  it('guards unsaved changes with an explicit confirmation before leaving', async () => {
    const user = userEvent.setup();
    render(<CommercePurchaseCreateView />);

    await user.type(screen.getByLabelText(/ارز/), 'IRR');
    await user.click(screen.getByTestId('commerce-create-back'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/از بین می‌رود/)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();

    await user.click(within(dialog).getByTestId('commerce-create-confirm-leave-confirm'));
    expect(push).toHaveBeenCalledWith('/admin/commerce/purchases');
  });
});