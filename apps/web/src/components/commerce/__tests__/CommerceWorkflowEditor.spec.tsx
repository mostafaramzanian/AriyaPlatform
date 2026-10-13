import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceWorkflowEditor } from '../settings/CommerceWorkflowEditor';
import { CommerceSettingsGuardProvider } from '../settings/CommerceSettingsGuard';
import {
  addCommerceWorkflowStep,
  archiveCommerceWorkflowVersion,
  deleteCommerceWorkflowStep,
  fetchCommerceWorkflowVersion,
  publishCommerceWorkflowVersion,
  reorderCommerceWorkflowSteps,
  updateCommerceWorkflowStep,
  updateCommerceWorkflowVersion,
  validateCommerceWorkflowVersion,
} from '@/lib/commerce-api';
import { CoreApiError } from '@/lib/core-http';
import { workflowStep, workflowVersion } from './commerce-fixtures';

/**
 * PHASE UI-4: the version editor — the screen where draft/published/immutable becomes
 * concrete and where a refusal becomes a fix-it list.
 *
 * THE CLAIMS WORTH PINNING: only a DRAFT shows editing affordances (with the validate
 * gate on the way to publish, exactly the backend's transitions); a published version
 * says it is immutable and offers «ایجاد نسخهٔ جدید» as its way forward; a refusal with
 * a structured report renders each finding as Persian + the step it belongs to; step
 * order is stated with explicit move controls (a PUT of the full order); and leaving a
 * dirty routing form asks before discarding.
 */
jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommerceWorkflowVersion: jest.fn(),
  updateCommerceWorkflowVersion: jest.fn(),
  validateCommerceWorkflowVersion: jest.fn(),
  publishCommerceWorkflowVersion: jest.fn(),
  archiveCommerceWorkflowVersion: jest.fn(),
  reorderCommerceWorkflowSteps: jest.fn(),
  addCommerceWorkflowStep: jest.fn(),
  updateCommerceWorkflowStep: jest.fn(),
  deleteCommerceWorkflowStep: jest.fn(),
}));

jest.mock('@/lib/directory-api', () => ({
  ...jest.requireActual('@/lib/directory-api'),
  fetchDirectoryMember: jest.fn(),
  fetchDirectory: jest.fn(),
}));

const versionMock = fetchCommerceWorkflowVersion as jest.MockedFunction<
  typeof fetchCommerceWorkflowVersion
>;
const updateVersionMock = updateCommerceWorkflowVersion as jest.MockedFunction<
  typeof updateCommerceWorkflowVersion
>;
const validateMock = validateCommerceWorkflowVersion as jest.MockedFunction<
  typeof validateCommerceWorkflowVersion
>;
const publishMock = publishCommerceWorkflowVersion as jest.MockedFunction<
  typeof publishCommerceWorkflowVersion
>;
const archiveMock = archiveCommerceWorkflowVersion as jest.MockedFunction<
  typeof archiveCommerceWorkflowVersion
>;
const reorderMock = reorderCommerceWorkflowSteps as jest.MockedFunction<
  typeof reorderCommerceWorkflowSteps
>;
const addStepMock = addCommerceWorkflowStep as jest.MockedFunction<typeof addCommerceWorkflowStep>;
const updateStepMock = updateCommerceWorkflowStep as jest.MockedFunction<
  typeof updateCommerceWorkflowStep
>;
const deleteStepMock = deleteCommerceWorkflowStep as jest.MockedFunction<
  typeof deleteCommerceWorkflowStep
>;

function renderEditor(overrides: Partial<Parameters<typeof CommerceWorkflowEditor>[0]> = {}) {
  const onBack = jest.fn();
  const onChanged = jest.fn();
  const onRequestNewVersion = jest.fn();
  render(
    <CommerceSettingsGuardProvider>
      <CommerceWorkflowEditor
        versionId="version-1"
        canWorkflowManage
        canReadDirectory={false}
        onBack={onBack}
        onChanged={onChanged}
        onRequestNewVersion={onRequestNewVersion}
        {...overrides}
      />
    </CommerceSettingsGuardProvider>
  );
  return { onBack, onChanged, onRequestNewVersion };
}

beforeEach(() => {
  jest.clearAllMocks();
  versionMock.mockResolvedValue(workflowVersion());
  updateVersionMock.mockResolvedValue(workflowVersion());
  validateMock.mockResolvedValue(workflowVersion({ status: 'VALIDATED' }));
  publishMock.mockResolvedValue(
    workflowVersion({ status: 'PUBLISHED', publishedAt: '2026-03-20T08:00:00.000Z' })
  );
  archiveMock.mockResolvedValue(workflowVersion({ status: 'ARCHIVED' }));
  reorderMock.mockResolvedValue(workflowVersion());
  addStepMock.mockResolvedValue(workflowStep());
  updateStepMock.mockResolvedValue(workflowStep());
  deleteStepMock.mockResolvedValue({ deleted: true, stepId: 'step-1' });
});

describe('CommerceWorkflowEditor — the draft lifecycle', () => {
  it('renders a DRAFT in human language with the routing form and ordered steps', async () => {
    renderEditor();

    expect(await screen.findByText('نسخهٔ «1404-01»')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-workflow-editor-status-DRAFT')).toHaveTextContent(
      'پیش‌نویس'
    );
    expect(screen.getByText('قابل ویرایش است؛ هنوز منتشر نشده است.')).toBeInTheDocument();
    // The technical id is SECONDARY detail, never the headline.
    expect(screen.getByText('version-1')).toBeInTheDocument();
    // The routing form and the ordered steps render.
    expect(screen.getByTestId('commerce-workflow-trigger')).toHaveValue('PURCHASE_SUBMITTED');
    expect(screen.getByTestId('commerce-workflow-step-manager-review')).toBeInTheDocument();
    expect(screen.getByText('مسئول: کاربر مشخص')).toBeInTheDocument();
    // Only the DRAFT gate applies: save disabled until the form is dirty, validate present.
    expect(screen.getByTestId('commerce-workflow-save')).toBeDisabled();
    expect(screen.getByTestId('commerce-workflow-validate')).toBeEnabled();
    expect(screen.queryByTestId('commerce-workflow-publish-open')).not.toBeInTheDocument();
  });

  it('saves ONLY the changed routing columns with the null-clears convention', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText('نسخهٔ «1404-01»');

    // Clear the trigger and set a join policy: two stated changes, one untouched field.
    await user.selectOptions(screen.getByTestId('commerce-workflow-trigger'), '');
    await user.selectOptions(screen.getByTestId('commerce-workflow-join-policy'), 'ALL');

    expect(screen.getByTestId('commerce-workflow-save')).toBeEnabled();
    // While the form is dirty the lifecycle gate is held back — validate would read the
    // STORED version, not the unsaved one.
    expect(screen.getByTestId('commerce-workflow-validate')).toBeDisabled();

    await user.click(screen.getByTestId('commerce-workflow-save'));

    await waitFor(() =>
      expect(updateVersionMock).toHaveBeenCalledWith('version-1', {
        triggerEvent: null,
        parallelJoinPolicy: 'ALL',
      })
    );
    expect(await screen.findByTestId('commerce-workflow-editor-feedback')).toHaveTextContent(
      'ذخیره شد'
    );
  });

  it('renders a refusal as a fix-it list with the step it belongs to', async () => {
    const user = userEvent.setup();
    validateMock.mockRejectedValue(
      new CoreApiError('The workflow version does not pass the configuration checks.', 400, {
        level: 'PUBLISH',
        truncated: false,
        issues: [
          { refusal: 'WORKFLOW_TRIGGER_MISSING', path: 'triggerEvent' },
          { refusal: 'STEP_ACTOR_SOURCE_MISSING', stepKey: 'manager-review', path: 'actorSource' },
          { refusal: 'VERSION_HAS_NO_STEPS' },
        ],
      })
    );

    renderEditor();
    await screen.findByText('نسخهٔ «1404-01»');
    await user.click(screen.getByTestId('commerce-workflow-validate'));

    const issues = await screen.findByTestId('commerce-workflow-issues');
    expect(
      within(issues).getByText(/برای انتشار باید رویداد آغاز فرآیند تعیین شود/)
    ).toBeInTheDocument();
    expect(within(issues).getByText(/مسئول این مرحله تعیین نشده است/)).toBeInTheDocument();
    expect(within(issues).getByText(/مرحلهٔ «بررسی مدیر»/)).toBeInTheDocument();
    expect(within(issues).getByText(/نسخه باید حداقل یک مرحله داشته باشد/)).toBeInTheDocument();
    // The technical coordinate stays secondary, on one LTR line.
    expect(within(issues).getByText('actorSource')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-workflow-editor-error')).toBeInTheDocument();
  });

  it('walks validate → publish: the publish action appears only after VALIDATED', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText('نسخهٔ «1404-01»');

    await user.click(screen.getByTestId('commerce-workflow-validate'));

    expect(
      await screen.findByTestId('commerce-workflow-editor-status-VALIDATED')
    ).toHaveTextContent('اعتبارسنجی‌شده');
    const publishOpen = await screen.findByTestId('commerce-workflow-publish-open');

    await user.click(publishOpen);
    // The review summarises what is being published, then the confirm publishes.
    expect(await screen.findByTestId('commerce-workflow-publish-dialog')).toBeInTheDocument();
    expect(
      screen.getByText(/پس از انتشار، این نسخه نسخهٔ در جریان فرآیند می‌شود/)
    ).toBeInTheDocument();
    expect(screen.getByText('۱. بررسی مدیر')).toBeInTheDocument();

    await user.click(screen.getByTestId('commerce-workflow-publish-confirm'));

    await waitFor(() => expect(publishMock).toHaveBeenCalledWith('version-1'));
    expect(
      await screen.findByTestId('commerce-workflow-editor-status-PUBLISHED')
    ).toHaveTextContent('منتشرشده');
  });
});

describe('CommerceWorkflowEditor — published immutability and steps', () => {
  it('marks a PUBLISHED version immutable and offers the new-version path', async () => {
    const user = userEvent.setup();
    versionMock.mockResolvedValue(
      workflowVersion({ status: 'PUBLISHED', publishedAt: '2026-03-20T08:00:00.000Z' })
    );
    const { onRequestNewVersion } = renderEditor();

    expect(
      await screen.findByTestId('commerce-workflow-editor-status-PUBLISHED')
    ).toBeInTheDocument();
    expect(screen.getByText('این نسخه منتشر شده و قابل ویرایش نیست.')).toBeInTheDocument();
    // No editing affordances survive: no save, no validate, no step actions.
    expect(screen.queryByTestId('commerce-workflow-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-workflow-validate')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('commerce-workflow-step-edit-manager-review')
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-workflow-step-add')).not.toBeInTheDocument();

    // The primary way forward is a NEW version, and archiving stays explicit.
    await user.click(screen.getByTestId('commerce-workflow-new-version'));
    expect(onRequestNewVersion).toHaveBeenCalled();

    await user.click(screen.getByTestId('commerce-workflow-archive-open'));
    expect(await screen.findByTestId('commerce-workflow-archive-dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('commerce-workflow-archive-dialog-confirm'));
    await waitFor(() => expect(archiveMock).toHaveBeenCalledWith('version-1'));
  });

  it('reorders steps with explicit controls by stating the FULL order (PUT)', async () => {
    const user = userEvent.setup();
    const twoSteps = workflowVersion({
      steps: [
        workflowStep(),
        workflowStep({ id: 'step-2', stepKey: 'liaison-review', displayName: 'بررسی بازرگانی', ordering: 2 }),
      ],
    });
    versionMock.mockResolvedValue(twoSteps);
    reorderMock.mockResolvedValue(twoSteps);

    renderEditor();
    await screen.findByTestId('commerce-workflow-step-manager-review');

    await user.click(screen.getByTestId('commerce-workflow-step-down-manager-review'));

    await waitFor(() =>
      expect(reorderMock).toHaveBeenCalledWith('version-1', ['step-2', 'step-1'])
    );
    expect(await screen.findByTestId('commerce-workflow-editor-feedback')).toHaveTextContent(
      'ترتیب مراحل به‌روزرسانی شد'
    );
  });

  it('edits a step through the drawer and merges the saved row without a refetch', async () => {
    const user = userEvent.setup();
    updateStepMock.mockResolvedValue(workflowStep({ displayName: 'بررسی مدیر ارشد' }));

    renderEditor();
    await screen.findByTestId('commerce-workflow-step-manager-review');

    await user.click(screen.getByTestId('commerce-workflow-step-edit-manager-review'));
    const drawer = await screen.findByTestId('commerce-workflow-step-drawer');
    expect(within(drawer).getByTestId('commerce-workflow-step-display-name')).toHaveValue(
      'بررسی مدیر'
    );
    // The condition section states the mode rule; the advisory step has none.
    expect(
      within(drawer).getByText('شرط فقط برای حالت اجرای «شرطی» تعریف می‌شود؛ مراحل ترتیبی و موازی همیشه اجرا می‌شوند.')
    ).toBeInTheDocument();

    await user.clear(within(drawer).getByTestId('commerce-workflow-step-display-name'));
    await user.type(
      within(drawer).getByTestId('commerce-workflow-step-display-name'),
      'بررسی مدیر ارشد'
    );
    await user.click(screen.getByTestId('commerce-workflow-step-save'));

    await waitFor(() =>
      expect(updateStepMock).toHaveBeenCalledWith(
        'version-1',
        'step-1',
        expect.objectContaining({ displayName: 'بررسی مدیر ارشد' })
      )
    );
    // The host re-reads NOTHING: the saved row is merged into the ordered list.
    expect(versionMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('commerce-workflow-editor-feedback')).toHaveTextContent(
      'مرحله ذخیره شد'
    );
  });

  it('deletes a step only through the confirmation dialog', async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByTestId('commerce-workflow-step-manager-review');

    await user.click(screen.getByTestId('commerce-workflow-step-delete-manager-review'));
    const dialog = await screen.findByTestId('commerce-workflow-delete-step-dialog');
    expect(within(dialog).getByText(/مرحلهٔ «بررسی مدیر»/)).toBeInTheDocument();

    await user.click(screen.getByTestId('commerce-workflow-delete-step-dialog-confirm'));
    await waitFor(() => expect(deleteStepMock).toHaveBeenCalledWith('version-1', 'step-1'));
  });

  it('holds a dirty routing form behind the discard guard before navigating away', async () => {
    const user = userEvent.setup();
    const { onBack } = renderEditor();
    await screen.findByText('نسخهٔ «1404-01»');

    await user.selectOptions(screen.getByTestId('commerce-workflow-join-policy'), 'ALL');
    await user.click(screen.getByTestId('commerce-workflow-editor-back'));

    // The guard asks first; the navigation runs only after the explicit confirm.
    await screen.findByTestId('commerce-settings-discard-dialog');
    expect(onBack).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('commerce-settings-discard-dialog-confirm'));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });
});