import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceCompletionSettings } from '../settings/CommerceCompletionSettings';
import { CommerceSettingsGuardProvider } from '../settings/CommerceSettingsGuard';
import {
  archiveCommerceCompletionPolicy,
  createCommerceCompletionPolicy,
  fetchCommerceCompletionPolicies,
  publishCommerceCompletionPolicy,
  updateCommerceCompletionPolicy,
  validateCommerceCompletionPolicy,
} from '@/lib/commerce-api';
import type { CommerceCompletionPolicyRecord } from '@/lib/commerce-api';

/**
 * PHASE C4-R (GAP-3): «تکمیل خرید» — the completion policy panel inside the Settings Center.
 *
 * THE CLAIMS ONLY THIS SPEC CAN PIN
 * ---------------------------------
 *  1. THE ADMINISTRATOR'S LANGUAGE. The panel says «وضعیت‌های مجاز برای تکمیل» and the
 *     register's own status labels — never `allowedFromStatuses`, never a status code, and
 *     never a prerequisite toggle (the model has none).
 *  2. NO INVENTED DEFAULT. A new policy starts with nothing ticked and cannot be saved
 *     until a label and at least one status are stated.
 *  3. THE PREVIEW ANSWERS THE REAL QUESTION: «با این تنظیمات … در وضعیت … قابل تکمیل است».
 *  4. FAIL-CLOSED IS VISIBLE. With no published policy the panel says completion is
 *     unavailable — not that it is "unrestricted".
 *  5. WRITE AFFORDANCES FOLLOW THE GRANT: `commerce.read` alone renders the rules and no
 *     button that would 403.
 *  6. PUBLICATION AND ARCHIVING ASK FIRST (the shared confirm dialog) and call the exact
 *     contract routes.
 */

jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommerceCompletionPolicies: jest.fn(),
  createCommerceCompletionPolicy: jest.fn(),
  updateCommerceCompletionPolicy: jest.fn(),
  validateCommerceCompletionPolicy: jest.fn(),
  publishCommerceCompletionPolicy: jest.fn(),
  archiveCommerceCompletionPolicy: jest.fn(),
}));

const listMock = fetchCommerceCompletionPolicies as jest.MockedFunction<
  typeof fetchCommerceCompletionPolicies
>;
const createMock = createCommerceCompletionPolicy as jest.MockedFunction<
  typeof createCommerceCompletionPolicy
>;
const updateMock = updateCommerceCompletionPolicy as jest.MockedFunction<
  typeof updateCommerceCompletionPolicy
>;
const validateMock = validateCommerceCompletionPolicy as jest.MockedFunction<
  typeof validateCommerceCompletionPolicy
>;
const publishMock = publishCommerceCompletionPolicy as jest.MockedFunction<
  typeof publishCommerceCompletionPolicy
>;
const archiveMock = archiveCommerceCompletionPolicy as jest.MockedFunction<
  typeof archiveCommerceCompletionPolicy
>;

function policy(
  overrides: Partial<CommerceCompletionPolicyRecord> = {}
): CommerceCompletionPolicyRecord {
  return {
    id: 'p1',
    status: 'PUBLISHED',
    versionLabel: '۱۴۰۴-۰۱',
    allowedFromStatuses: ['APPROVED'],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(canConfigure = true) {
  return render(
    <CommerceSettingsGuardProvider>
      <CommerceCompletionSettings canConfigure={canConfigure} />
    </CommerceSettingsGuardProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue({ items: [], page: 1, pageSize: 50, total: 0 });
  createMock.mockResolvedValue(policy({ status: 'DRAFT' }));
  updateMock.mockResolvedValue(policy({ status: 'DRAFT' }));
  validateMock.mockResolvedValue(policy({ status: 'VALIDATED' }));
  publishMock.mockResolvedValue(policy({ status: 'PUBLISHED' }));
  archiveMock.mockResolvedValue(policy({ status: 'ARCHIVED' }));
});

describe('CommerceCompletionSettings', () => {
  it('says completion is NOT configured when nothing is published — never "unrestricted"', async () => {
    renderPanel();

    expect(await screen.findByTestId('completion-none-published')).toHaveTextContent(
      /تکمیل خرید در حال حاضر برای هیچ سندی امکان‌پذیر نیست/
    );
    // …and states what the rule does and does not govern, in one honest sentence.
    expect(screen.getByText(/به پرداخت، تحویل، گردش/)).toBeInTheDocument();
    expect(screen.queryByText(/allowedFromStatuses/)).not.toBeInTheDocument();
  });

  it('explains the rule in the administrator’s language when one is published', async () => {
    listMock.mockResolvedValue({ items: [policy()], page: 1, pageSize: 50, total: 1 });

    renderPanel();

    const summary = await screen.findByTestId('completion-current-summary');
    expect(summary).toHaveTextContent(/وضعیت «تأییدشده»/);
    expect(summary).toHaveTextContent(/قابل تکمیل است/);
    // No backend vocabulary anywhere on the panel.
    expect(screen.queryByText(/PurchaseDocumentStatus/)).not.toBeInTheDocument();
    expect(screen.queryByText(/APPROVED/)).not.toBeInTheDocument();
  });

  it('opens a draft with NOTHING pre-selected and previews the rule as the admin chooses', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByTestId('completion-none-published');

    await user.click(screen.getByTestId('completion-new-policy'));

    const dialog = await screen.findByTestId('completion-form');
    for (const status of ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'] as const) {
      expect(within(dialog).getByTestId(`completion-status-${status}`)).not.toBeChecked();
    }
    // Nothing chosen, no label: the save is disabled — no default the screen invented.
    expect(within(dialog).getByTestId('completion-save-draft')).toBeDisabled();

    await user.type(within(dialog).getByTestId('completion-label-input'), '۱۴۰۴-۰۱');
    await user.click(within(dialog).getByTestId('completion-status-APPROVED'));
    await user.click(within(dialog).getByTestId('completion-status-REJECTED'));

    expect(within(dialog).getByTestId('completion-preview')).toHaveTextContent(
      /وضعیت «تأییدشده، ردشده»/
    );
    expect(within(dialog).getByTestId('completion-save-draft')).toBeEnabled();

    await user.click(within(dialog).getByTestId('completion-save-draft'));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith({
        versionLabel: '۱۴۰۴-۰۱',
        allowedFromStatuses: ['APPROVED', 'REJECTED'],
      })
    );
    expect(await screen.findByTestId('completion-feedback')).toHaveTextContent(/پیش‌نویس ذخیره شد/);
  });

  it('edits a DRAFT’s set without renaming it, and validates through the contract route', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue({
      items: [policy({ id: 'draft-1', status: 'DRAFT' })],
      page: 1,
      pageSize: 50,
      total: 1,
    });

    renderPanel();
    await user.click(await screen.findByTestId('completion-edit-draft-1'));

    const dialog = await screen.findByTestId('completion-form');
    expect(within(dialog).getByTestId('completion-label-input')).toBeDisabled();
    expect(within(dialog).getByTestId('completion-status-APPROVED')).toBeChecked();

    await user.click(within(dialog).getByTestId('completion-status-CANCELLED'));
    await user.click(within(dialog).getByTestId('completion-save-draft'));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith('draft-1', {
        allowedFromStatuses: ['APPROVED', 'CANCELLED'],
      })
    );

    await user.click(await screen.findByTestId('completion-validate-draft-1'));
    await waitFor(() => expect(validateMock).toHaveBeenCalledWith('draft-1'));
  });

  it('asks before publishing and before archiving, and calls the exact routes', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue({
      items: [policy({ id: 'draft-2', status: 'VALIDATED' })],
      page: 1,
      pageSize: 50,
      total: 1,
    });

    renderPanel();
    await user.click(await screen.findByTestId('completion-publish-draft-2'));

    // The confirmation states the consequence BEFORE anything is sent.
    const confirm = await screen.findByTestId('completion-confirm');
    expect(confirm).toHaveTextContent(/قاعدهٔ منتشرشدهٔ قبلی بایگانی می‌شود/);
    expect(publishMock).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole('button', { name: 'انتشار' }));
    await waitFor(() => expect(publishMock).toHaveBeenCalledWith('draft-2'));
  });

  it('confirms archiving of the published rule, warning that completion then stops', async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue({
      items: [policy({ id: 'pub-1', status: 'PUBLISHED' })],
      page: 1,
      pageSize: 50,
      total: 1,
    });

    renderPanel();
    await user.click(await screen.findByTestId('completion-archive-pub-1'));

    const confirm = await screen.findByTestId('completion-confirm');
    expect(confirm).toHaveTextContent(/تا انتشار قاعدهٔ جدید، تکمیل خرید ممکن نخواهد بود/);

    await user.click(within(confirm).getByRole('button', { name: 'آرشیو' }));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith('pub-1'));
  });

  it('shows no write affordance to a reader without commerce.configure', async () => {
    listMock.mockResolvedValue({
      items: [policy({ id: 'pub-3', status: 'PUBLISHED' })],
      page: 1,
      pageSize: 50,
      total: 1,
    });

    renderPanel(false);

    // The rule itself is readable…
    expect(await screen.findByTestId('completion-current-summary')).toBeInTheDocument();
    // …and nothing that would 403 is offered.
    expect(screen.queryByTestId('completion-new-policy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('completion-edit-pub-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('completion-publish-pub-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('completion-archive-pub-3')).not.toBeInTheDocument();
  });

  it('reports a failed read honestly and offers a retry that re-asks', async () => {
    const user = userEvent.setup();
    listMock.mockRejectedValueOnce(new Error('offline'));

    renderPanel();

    expect(await screen.findByText(/خواندن قواعد تکمیل خرید ناموفق بود/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    expect(await screen.findByTestId('completion-none-published')).toBeInTheDocument();
  });
});
