import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceWorkflowSettings } from '../settings/CommerceWorkflowSettings';
import { CommerceSettingsGuardProvider } from '../settings/CommerceSettingsGuard';
import {
  createCommerceWorkflowDefinition,
  createCommerceWorkflowVersion,
  fetchCommerceWorkflowDefinitions,
  fetchCommerceWorkflowVersion,
  fetchCommerceWorkflowVersions,
  renameCommerceWorkflowDefinition,
} from '@/lib/commerce-api';
import {
  workflowDefinition,
  workflowDefinitionsPage,
  workflowVersion,
  workflowVersionSummary,
  workflowVersionsPage,
} from './commerce-fixtures';

/**
 * PHASE UI-4: «فرآیندهای خرید» — definitions and their version history.
 *
 * THE CLAIMS WORTH PINNING: the list speaks human language (name + technical code +
 * version count), the create dialog validates against the SAME bounds the DTO states
 * and maps a duplicate-code 409 into Persian, a version row states its status word AND
 * its hint (draft = editable, published = immutable), and the create-version flow lands
 * in the real editor — no mock page, no fake capability.
 */
jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommerceWorkflowDefinitions: jest.fn(),
  fetchCommerceWorkflowVersions: jest.fn(),
  fetchCommerceWorkflowVersion: jest.fn(),
  createCommerceWorkflowDefinition: jest.fn(),
  renameCommerceWorkflowDefinition: jest.fn(),
  createCommerceWorkflowVersion: jest.fn(),
}));

const definitionsMock = fetchCommerceWorkflowDefinitions as jest.MockedFunction<
  typeof fetchCommerceWorkflowDefinitions
>;
const versionsMock = fetchCommerceWorkflowVersions as jest.MockedFunction<
  typeof fetchCommerceWorkflowVersions
>;
const versionMock = fetchCommerceWorkflowVersion as jest.MockedFunction<
  typeof fetchCommerceWorkflowVersion
>;
const createDefinitionMock = createCommerceWorkflowDefinition as jest.MockedFunction<
  typeof createCommerceWorkflowDefinition
>;
const renameDefinitionMock = renameCommerceWorkflowDefinition as jest.MockedFunction<
  typeof renameCommerceWorkflowDefinition
>;
const createVersionMock = createCommerceWorkflowVersion as jest.MockedFunction<
  typeof createCommerceWorkflowVersion
>;

function renderSettings(props: Partial<Parameters<typeof CommerceWorkflowSettings>[0]> = {}) {
  return render(
    <CommerceSettingsGuardProvider>
      <CommerceWorkflowSettings
        canConfigure
        canWorkflowManage
        canReadDirectory
        {...props}
      />
    </CommerceSettingsGuardProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  definitionsMock.mockResolvedValue(workflowDefinitionsPage());
  versionsMock.mockResolvedValue(workflowVersionsPage());
  versionMock.mockResolvedValue(workflowVersion());
  createDefinitionMock.mockResolvedValue(workflowDefinition());
  renameDefinitionMock.mockResolvedValue(workflowDefinition({ name: 'نام تازه' }));
  createVersionMock.mockResolvedValue(workflowVersionSummary());
});

describe('CommerceWorkflowSettings — definitions', () => {
  it('renders definitions in human language with the technical code as detail', async () => {
    renderSettings();

    expect(await screen.findByText('فرآیند خرید استاندارد')).toBeInTheDocument();
    expect(screen.getByText('standard-purchase')).toBeInTheDocument();
    expect(screen.getByText(/۲ نسخه/)).toBeInTheDocument();
    // The backend's row vocabulary is never the primary UI.
    expect(screen.queryByText(/WorkflowDefinition/)).not.toBeInTheDocument();
  });

  it('states the empty domain and offers the create CTA only with commerce.configure', async () => {
    definitionsMock.mockResolvedValue(workflowDefinitionsPage([], 0));

    const { unmount } = renderSettings({ canConfigure: false });
    expect(await screen.findByText('هنوز فرآیندی برای خرید تعریف نشده است.')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-workflow-create-open')).not.toBeInTheDocument();
    unmount();

    renderSettings({ canConfigure: true });
    expect(await screen.findByTestId('commerce-workflow-create-open')).toBeInTheDocument();
  });

  it('validates the create form against the DTO bounds before any request', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByTestId('commerce-workflow-definition-rows');

    await user.click(screen.getByTestId('commerce-workflow-create-open'));
    await user.click(screen.getByTestId('commerce-workflow-create-submit'));

    expect(await screen.findByTestId('commerce-workflow-create-error')).toHaveTextContent(
      'کد فرآیند را وارد کنید.'
    );
    expect(createDefinitionMock).not.toHaveBeenCalled();
  });

  it('creates a definition with exactly {code, name} and lands in its version list', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByTestId('commerce-workflow-definition-rows');

    await user.click(screen.getByTestId('commerce-workflow-create-open'));
    await user.type(screen.getByLabelText(/^کد فرآیند/), 'fast-track');
    await user.type(screen.getByLabelText(/^نام فرآیند/), 'خرید سریع');
    await user.click(screen.getByTestId('commerce-workflow-create-submit'));

    await waitFor(() =>
      expect(createDefinitionMock).toHaveBeenCalledWith({ code: 'fast-track', name: 'خرید سریع' })
    );
    // The success path closes the dialog, reloads and SELECTS the new definition.
    expect(await screen.findByTestId('commerce-workflow-versions')).toBeInTheDocument();
    expect(versionsMock).toHaveBeenCalledWith('def-1', expect.objectContaining({ page: 1 }));
  });

  it('maps a duplicate-code 409 into Persian and preserves what was typed', async () => {
    const user = userEvent.setup();
    const { CoreApiError } = jest.requireActual('@/lib/core-http');
    createDefinitionMock.mockRejectedValue(
      new CoreApiError('A workflow definition already uses the code "standard-purchase".', 409)
    );

    renderSettings();
    await screen.findByTestId('commerce-workflow-definition-rows');
    await user.click(screen.getByTestId('commerce-workflow-create-open'));
    await user.type(screen.getByLabelText(/^کد فرآیند/), 'standard-purchase');
    await user.type(screen.getByLabelText(/^نام فرآیند/), 'نام تکراری');
    await user.click(screen.getByTestId('commerce-workflow-create-submit'));

    expect(await screen.findByTestId('commerce-workflow-create-error')).toHaveTextContent(
      'از قبل وجود دارد'
    );
    // The entered values survive the failure.
    expect(screen.getByLabelText(/^کد فرآیند/)).toHaveValue('standard-purchase');
  });

  it('renames a definition through its own PATCH and reports success', async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByTestId('commerce-workflow-definition-rows');

    await user.click(screen.getByTestId('commerce-workflow-rename-standard-purchase'));
    const nameInput = screen.getByLabelText(/^نام فرآیند/);
    await user.clear(nameInput);
    await user.type(nameInput, 'نام تازه');
    await user.click(screen.getByTestId('commerce-workflow-rename-submit'));

    await waitFor(() =>
      expect(renameDefinitionMock).toHaveBeenCalledWith('def-1', { name: 'نام تازه' })
    );
    expect(await screen.findByTestId('commerce-workflow-feedback')).toHaveTextContent('تغییر یافت');
  });
});

describe('CommerceWorkflowSettings — version history', () => {
  it('opens the version list and states each version with its status word AND hint', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByTestId('commerce-workflow-versions-standard-purchase'));
    expect(await screen.findByTestId('commerce-workflow-versions')).toBeInTheDocument();
    expect(versionsMock).toHaveBeenCalledWith(
      'def-1',
      expect.objectContaining({ page: 1, pageSize: 20 })
    );

    // A DRAFT row teaches the rule the UI lives by: editable now, published later.
    expect(await screen.findByText('1404-01')).toBeInTheDocument();
    expect(await screen.findByText('قابل ویرایش است؛ هنوز منتشر نشده است.')).toBeInTheDocument();
    expect(screen.getByText('۱ مرحله')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-workflow-version-open-1404-01')).toHaveTextContent(
      'ویرایش و انتشار'
    );
    // The engine's row vocabulary never becomes the primary UI.
    expect(screen.queryByText(/WorkflowDefinitionVersion/)).not.toBeInTheDocument();
  });

  it('marks a published version as immutable in the row wording', async () => {
    const user = userEvent.setup();
    versionsMock.mockResolvedValue(
      workflowVersionsPage([
        workflowVersionSummary({
          id: 'v-9',
          versionLabel: '1403-12',
          status: 'PUBLISHED',
          publishedAt: '2026-02-01T08:00:00.000Z',
        }),
      ])
    );
    renderSettings();

    await user.click(await screen.findByTestId('commerce-workflow-versions-standard-purchase'));

    expect(
      await screen.findByTestId('commerce-workflow-version-status-PUBLISHED')
    ).toHaveTextContent('منتشرشده');
    expect(screen.getByText('این نسخه منتشر شده و قابل ویرایش نیست.')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-workflow-version-open-1403-12')).toHaveTextContent(
      'مشاهده و مدیریت'
    );
  });

  it('creates a NEW draft version with only the stated label and opens the editor', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByTestId('commerce-workflow-versions-standard-purchase'));
    await user.click(await screen.findByTestId('commerce-workflow-create-version-open'));
    await user.type(screen.getByLabelText(/^برچسب نسخه/), '1404-02');
    await user.click(screen.getByTestId('commerce-workflow-create-version-submit'));

    await waitFor(() =>
      expect(createVersionMock).toHaveBeenCalledWith('def-1', { versionLabel: '1404-02' })
    );
    // The created draft opens straight into the real editor (its version read fires).
    await waitFor(() => expect(versionMock).toHaveBeenCalledTimes(1));
    expect(versionMock).toHaveBeenCalledWith('version-1');
  });

  it('filters versions by status through the documented query', async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(await screen.findByTestId('commerce-workflow-versions-standard-purchase'));
    await screen.findByTestId('commerce-workflow-version-rows');

    await user.selectOptions(screen.getByTestId('commerce-workflow-status-filter'), 'PUBLISHED');

    await waitFor(() =>
      expect(versionsMock).toHaveBeenCalledWith(
        'def-1',
        expect.objectContaining({ status: 'PUBLISHED' })
      )
    );
  });
});