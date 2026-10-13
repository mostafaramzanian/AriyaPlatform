import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommerceCommercialSettings } from '../settings/CommerceCommercialSettings';
import { CommerceSettingsGuardProvider } from '../settings/CommerceSettingsGuard';
import {
  archiveCommerceCommercialConfiguration,
  createCommerceCommercialConfiguration,
  createCommerceCommercialGroup,
  fetchCommerceCommercialConfigurations,
  fetchCommerceCommercialGroups,
  publishCommerceCommercialConfiguration,
  updateCommerceCommercialConfiguration,
  updateCommerceCommercialGroup,
  validateCommerceCommercialConfiguration,
} from '@/lib/commerce-api';
import { CoreApiError } from '@/lib/core-http';
import { fetchDirectory, fetchDirectoryMember } from '@/lib/directory-api';
import {
  commercialConfiguration,
  commercialConfigurationsPage,
  commercialGroup,
} from './commerce-fixtures';

/**
 * PHASE UI-4: «تنظیمات بازرگانی» — groups and the commercial configuration lifecycle.
 *
 * THE CLAIMS WORTH PINNING: a group is a business object (name + code + liaison, no
 * delete — the backend has none), the liaison picker follows the real directory contract
 * (`liaisonUserId` from the directory or an honest limitation), the create form requires
 * DELIBERATE choices (no invented defaults) and sends the DTO's field names exactly, and
 * a published configuration is immutable with «آرشیو» as its explicit exit.
 */
jest.mock('@/lib/commerce-api', () => ({
  ...jest.requireActual('@/lib/commerce-api'),
  fetchCommerceCommercialGroups: jest.fn(),
  createCommerceCommercialGroup: jest.fn(),
  updateCommerceCommercialGroup: jest.fn(),
  fetchCommerceCommercialConfigurations: jest.fn(),
  createCommerceCommercialConfiguration: jest.fn(),
  updateCommerceCommercialConfiguration: jest.fn(),
  validateCommerceCommercialConfiguration: jest.fn(),
  publishCommerceCommercialConfiguration: jest.fn(),
  archiveCommerceCommercialConfiguration: jest.fn(),
}));

jest.mock('@/lib/directory-api', () => ({
  ...jest.requireActual('@/lib/directory-api'),
  fetchDirectory: jest.fn(),
  fetchDirectoryMember: jest.fn(),
}));

const groupsMock = fetchCommerceCommercialGroups as jest.MockedFunction<
  typeof fetchCommerceCommercialGroups
>;
const createGroupMock = createCommerceCommercialGroup as jest.MockedFunction<
  typeof createCommerceCommercialGroup
>;
const updateGroupMock = updateCommerceCommercialGroup as jest.MockedFunction<
  typeof updateCommerceCommercialGroup
>;
const configsMock = fetchCommerceCommercialConfigurations as jest.MockedFunction<
  typeof fetchCommerceCommercialConfigurations
>;
const createConfigMock = createCommerceCommercialConfiguration as jest.MockedFunction<
  typeof createCommerceCommercialConfiguration
>;
const updateConfigMock = updateCommerceCommercialConfiguration as jest.MockedFunction<
  typeof updateCommerceCommercialConfiguration
>;
const validateConfigMock = validateCommerceCommercialConfiguration as jest.MockedFunction<
  typeof validateCommerceCommercialConfiguration
>;
const publishConfigMock = publishCommerceCommercialConfiguration as jest.MockedFunction<
  typeof publishCommerceCommercialConfiguration
>;
const archiveConfigMock = archiveCommerceCommercialConfiguration as jest.MockedFunction<
  typeof archiveCommerceCommercialConfiguration
>;
const fetchDirectoryMock = fetchDirectory as jest.MockedFunction<typeof fetchDirectory>;
const fetchDirectoryMemberMock = fetchDirectoryMember as jest.MockedFunction<
  typeof fetchDirectoryMember
>;

function renderCommercial(canReadDirectory = false) {
  return render(
    <CommerceSettingsGuardProvider>
      <CommerceCommercialSettings canConfigure canReadDirectory={canReadDirectory} />
    </CommerceSettingsGuardProvider>
  );
}

const MEMBER = {
  id: '4f8a2f10-1234-4a5b-8c6d-7e9f0a1b2c3d',
  firstName: 'سارا',
  lastName: 'محمدی',
  email: 'sara@example.com',
};

beforeEach(() => {
  jest.clearAllMocks();
  groupsMock.mockResolvedValue({ items: [commercialGroup()], page: 1, pageSize: 20, total: 1 });
  configsMock.mockResolvedValue(commercialConfigurationsPage());
  createGroupMock.mockResolvedValue(commercialGroup());
  updateGroupMock.mockResolvedValue(commercialGroup({ name: 'فناوری اطلاعات', liaisonUserId: null }));
  createConfigMock.mockResolvedValue(commercialConfiguration());
  updateConfigMock.mockResolvedValue(commercialConfiguration());
  validateConfigMock.mockResolvedValue(commercialConfiguration({ status: 'VALIDATED' }));
  publishConfigMock.mockResolvedValue(commercialConfiguration({ status: 'PUBLISHED' }));
  archiveConfigMock.mockResolvedValue(commercialConfiguration({ status: 'ARCHIVED' }));
  fetchDirectoryMock.mockResolvedValue({ items: [MEMBER], hasMore: false });
  fetchDirectoryMemberMock.mockResolvedValue(MEMBER);
});

describe('CommerceCommercialSettings — groups', () => {
  it('renders a group as a business object and names its liaison through the directory', async () => {
    renderCommercial(true);

    expect(await screen.findByText('گروه فناوری اطلاعات')).toBeInTheDocument();
    expect(screen.getByText('IT')).toBeInTheDocument();
    // The liaison's NAME resolves through the directory (bounded to the page's ids).
    await waitFor(() =>
      expect(fetchDirectoryMemberMock).toHaveBeenCalledWith('u-2')
    );
    // No delete affordance exists — the backend removed deletion from the surface (§3-L).
    expect(screen.queryByText('حذف گروه')).not.toBeInTheDocument();
  });

  it('states the liaison selection LIMITATION without admin.users.read — no fake picker', async () => {
    const user = userEvent.setup();
    renderCommercial(false);

    await screen.findByText('گروه فناوری اطلاعات');
    await user.click(screen.getByTestId('commerce-commercial-group-edit-IT'));

    const dialog = await screen.findByTestId('commerce-commercial-group-edit-dialog');
    expect(screen.getByTestId('commerce-commercial-group-edit-liaison-limitation')).toBeInTheDocument();
    expect(within(dialog).queryByTestId('commerce-commercial-group-edit-liaison-search')).not.toBeInTheDocument();
    // Nothing was requested from the directory the caller may not read.
    expect(fetchDirectoryMock).not.toHaveBeenCalled();
  });

  it('creates a group with exactly {code, name} plus the chosen liaison', async () => {
    const user = userEvent.setup();
    renderCommercial(true);
    await screen.findByText('گروه فناوری اطلاعات');

    await user.click(screen.getByTestId('commerce-commercial-group-create-open'));
    const dialog = await screen.findByTestId('commerce-commercial-group-create-dialog');

    // Submit empty: the DTO's own requirements are stated as field errors, no request.
    await user.click(screen.getByTestId('commerce-commercial-group-create-submit'));
    expect(await screen.findByTestId('commerce-commercial-group-create-error')).toHaveTextContent(
      'کد گروه را وارد کنید.'
    );
    expect(createGroupMock).not.toHaveBeenCalled();

    await user.type(within(dialog).getByTestId('commerce-commercial-group-code'), 'GOODS');
    await user.type(within(dialog).getByTestId('commerce-commercial-group-name'), 'کالای عمومی');

    // The liaison comes from the real directory search — the id the backend verifies.
    await user.type(within(dialog).getByTestId('commerce-commercial-group-create-liaison-search'), 'سارا');
    await user.click(within(dialog).getByTestId('commerce-commercial-group-create-liaison-search-submit'));
    await user.click(
      await within(dialog).findByTestId(`commerce-commercial-group-create-liaison-option-${MEMBER.id}`)
    );

    await user.click(screen.getByTestId('commerce-commercial-group-create-submit'));

    await waitFor(() =>
      expect(createGroupMock).toHaveBeenCalledWith({
        code: 'GOODS',
        name: 'کالای عمومی',
        liaisonUserId: MEMBER.id,
      })
    );
    // NO tenant, no actor field — the client sends the DTO and nothing else.
    expect(JSON.stringify(createGroupMock.mock.calls[0][0])).not.toMatch(/tenant|actor/i);
  });

  it('renames a group and CLEARS its liaison with an explicit null', async () => {
    const user = userEvent.setup();
    renderCommercial(true);
    await screen.findByText('گروه فناوری اطلاعات');

    await user.click(screen.getByTestId('commerce-commercial-group-edit-IT'));
    const dialog = await screen.findByTestId('commerce-commercial-group-edit-dialog');

    const nameInput = within(dialog).getByTestId('commerce-commercial-group-edit-name');
    await user.clear(nameInput);
    await user.type(nameInput, 'فناوری اطلاعات');
    await user.click(
      within(dialog).getByTestId('commerce-commercial-group-edit-liaison-clear')
    );

    await user.click(screen.getByTestId('commerce-commercial-group-edit-submit'));

    await waitFor(() =>
      expect(updateGroupMock).toHaveBeenCalledWith('group-1', {
        name: 'فناوری اطلاعات',
        liaisonUserId: null,
      })
    );
  });
});

describe('CommerceCommercialSettings — configuration lifecycle', () => {
  it('renders the configuration list with status words and the guided action per state', async () => {
    renderCommercial();

    expect(await screen.findByText('1404-01')).toBeInTheDocument();
    expect(screen.getByTestId('commerce-commercial-config-row-status-DRAFT')).toHaveTextContent(
      'پیش‌نویس'
    );
    expect(screen.getByTestId('commerce-commercial-config-open-1404-01')).toHaveTextContent(
      'ویرایش و انتشار'
    );
    // The engine's vocabulary stays out of the primary UI.
    expect(screen.queryByText(/CommercialConfigurationVersion/)).not.toBeInTheDocument();
  });

  it('requires deliberate choices in the create form and never invents defaults', async () => {
    const user = userEvent.setup();
    renderCommercial();
    await screen.findByTestId('commerce-commercial-config-rows');

    await user.click(screen.getByTestId('commerce-commercial-config-create-open'));
    await screen.findByTestId('commerce-commercial-config-create-dialog');

    // Every required select starts EMPTY («انتخاب کنید»), then blocks the submit.
    expect(screen.getByTestId('commerce-commercial-assignment-trigger')).toHaveValue('');
    expect(screen.getByTestId('commerce-commercial-no-assignment-behavior')).toHaveValue('');
    expect(screen.getByTestId('commerce-commercial-approval-activation')).toHaveValue('');
    expect(screen.getByTestId('commerce-commercial-projection-policy')).toHaveValue('');

    await user.click(screen.getByTestId('commerce-commercial-config-create-submit'));

    expect(await screen.findByText('برچسب نسخه را وارد کنید.')).toBeInTheDocument();
    expect(createConfigMock).not.toHaveBeenCalled();
  });

  it('creates a configuration with the DTO field names and one rule', async () => {
    const user = userEvent.setup();
    groupsMock.mockResolvedValue({ items: [commercialGroup()], page: 1, pageSize: 20, total: 1 });
    renderCommercial();
    await screen.findByTestId('commerce-commercial-config-rows');

    await user.click(screen.getByTestId('commerce-commercial-config-create-open'));
    await screen.findByTestId('commerce-commercial-config-create-dialog');

    await user.type(screen.getByTestId('commerce-commercial-version-label'), '1404-01');
    await user.selectOptions(
      screen.getByTestId('commerce-commercial-assignment-trigger'),
      'PURCHASE_SUBMITTED'
    );
    await user.selectOptions(
      screen.getByTestId('commerce-commercial-no-assignment-behavior'),
      'LEAVE_UNASSIGNED'
    );
    await user.selectOptions(
      screen.getByTestId('commerce-commercial-match-behavior'),
      'HIGHEST_PRIORITY'
    );
    await user.selectOptions(
      screen.getByTestId('commerce-commercial-approval-activation'),
      'NOT_REQUIRED'
    );
    await user.selectOptions(
      screen.getByTestId('commerce-commercial-projection-policy'),
      'DOCUMENT_WORKFLOW'
    );
    await user.type(screen.getByTestId('commerce-commercial-rule-label-0'), 'کالای عمومی');
    await user.selectOptions(screen.getByTestId('commerce-commercial-rule-group-0'), 'group-1');

    await user.click(screen.getByTestId('commerce-commercial-config-create-submit'));

    await waitFor(() => expect(createConfigMock).toHaveBeenCalledTimes(1));
    const payload = createConfigMock.mock.calls[0][0];
    expect(payload.versionLabel).toBe('1404-01');
    expect(payload.assignmentRules).toHaveLength(1);
    expect(payload.assignmentRules[0]).toEqual({
      label: 'کالای عمومی',
      priority: 0,
      commercialGroupId: 'group-1',
      condition: null,
    });
    expect(JSON.stringify(payload)).not.toMatch(/tenant|status/i);
  });

  it('follows the exact lifecycle: save → validate → publish → archive, read-only when not DRAFT', async () => {
    const user = userEvent.setup();
    configsMock.mockResolvedValue(commercialConfigurationsPage([commercialConfiguration()]));
    renderCommercial();
    await screen.findByTestId('commerce-commercial-config-rows');

    // DRAFT: the editable form with save (dirty-gated) and validate.
    await user.click(screen.getByTestId('commerce-commercial-config-open-1404-01'));
    await screen.findByTestId('commerce-commercial-config-editor');
    expect(screen.getByTestId('commerce-commercial-config-save')).toBeDisabled();
    expect(screen.getByTestId('commerce-commercial-config-validate')).toBeEnabled();

    await user.type(screen.getByTestId('commerce-commercial-version-label'), '-جدید');
    expect(screen.getByTestId('commerce-commercial-config-save')).toBeEnabled();
    await user.click(screen.getByTestId('commerce-commercial-config-save'));
    await waitFor(() => expect(updateConfigMock).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId('commerce-commercial-config-validate'));
    await waitFor(() => expect(validateConfigMock).toHaveBeenCalledWith('config-1'));

    // VALIDATED: the form sits behind the disabled fieldset, publish appears.
    expect(
      await screen.findByTestId('commerce-commercial-config-status-VALIDATED')
    ).toHaveTextContent('اعتبارسنجی‌شده');
    expect(screen.getByTestId('commerce-commercial-version-label')).toBeDisabled();
    await user.click(screen.getByTestId('commerce-commercial-config-publish-open'));
    expect(
      await screen.findByTestId('commerce-commercial-config-publish-dialog')
    ).toBeInTheDocument();
    await user.click(screen.getByTestId('commerce-commercial-config-publish-dialog-confirm'));
    await waitFor(() => expect(publishConfigMock).toHaveBeenCalledWith('config-1'));

    // PUBLISHED: immutable wording, archive as the explicit exit, no save/validate.
    expect(
      await screen.findByTestId('commerce-commercial-config-status-PUBLISHED')
    ).toHaveTextContent('منتشرشده');
    expect(screen.getByText('این نسخه منتشر شده و قابل ویرایش نیست.')).toBeInTheDocument();
    expect(screen.queryByTestId('commerce-commercial-config-save')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commerce-commercial-config-validate')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('commerce-commercial-config-archive-open'));
    expect(await screen.findByTestId('commerce-commercial-config-archive-dialog')).toBeInTheDocument();
    await user.click(screen.getByTestId('commerce-commercial-config-archive-dialog-confirm'));
    await waitFor(() => expect(archiveConfigMock).toHaveBeenCalledWith('config-1'));
  });

  it('maps a §7 checklist refusal into a Persian sentence the administrator can act on', async () => {
    const user = userEvent.setup();
    validateConfigMock.mockRejectedValue(
      new CoreApiError(
        '§7.8: approvalActivation PURCHASE_SUBMITTED requires an approvalApprover.',
        409
      )
    );
    renderCommercial();
    await screen.findByTestId('commerce-commercial-config-rows');

    await user.click(screen.getByTestId('commerce-commercial-config-open-1404-01'));
    await screen.findByTestId('commerce-commercial-config-editor');
    await user.click(screen.getByTestId('commerce-commercial-config-validate'));

    expect(await screen.findByTestId('commerce-commercial-config-error')).toHaveTextContent(
      'تعیین تصمیم‌گیرندهٔ تأیید بازرگانی لازم است'
    );
  });
});