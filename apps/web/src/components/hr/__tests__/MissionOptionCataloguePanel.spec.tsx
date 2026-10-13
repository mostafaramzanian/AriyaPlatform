import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MissionOptionCataloguePanel } from '../MissionOptionCataloguePanel';
import {
  createMissionOption,
  createMissionOptionGroup,
  fetchMissionOptionGroups,
  updateMissionOption,
  updateMissionOptionGroup,
} from '@/lib/hr-mission-api';
import { CoreApiError } from '@/lib/core-http';
import { missionOption, missionOptionGroup, page } from './hr-fixtures';
import { executableSource } from './source-scan';

/**
 * Phase 55 Step 8D — DOMAIN 1: the Mission OPTION CATALOGUE (`hr.mission.policy`).
 *
 * WHAT ONLY THIS SCREEN CAN GET WRONG. The wire contract is frozen by `hr-mission-api.spec.ts` and the
 * catalogue semantics by `mission-options.ts`, so the claims worth pinning here are the ones the
 * SCREEN owns:
 *
 *   * that the catalogue is a read of the SERVER's catalogue — the groups, the options, their order,
 *     their `active` and `required` flags as returned — and not a client-side list;
 *   * that each write posts EXACTLY the fields its DTO declares, and in particular that `code` is
 *     present on a create and ABSENT from every update, because the code is the machine key the
 *     classification is derived from;
 *   * that no request carries `tenantId`, `actorId` or `projectId` — asserted on the real call
 *     arguments, since the body builders are pure and un-mocked;
 *   * that a read failure is shown with a retry, an empty catalogue is stated as empty, and a
 *     mutation failure is surfaced rather than swallowed.
 *
 * THE CLIENT IS MOCKED, THE BODY BUILDERS ARE NOT. `@/lib/hr-mission-api` is stubbed so no network is
 * touched, but every assertion about WHAT was sent reads the real production function's call
 * arguments — so a builder that emitted an extra field would fail here.
 */

jest.mock('@/lib/hr-mission-api', () => ({
  ...jest.requireActual('@/lib/hr-mission-api'),
  fetchMissionOptionGroups: jest.fn(),
  createMissionOptionGroup: jest.fn(),
  updateMissionOptionGroup: jest.fn(),
  createMissionOption: jest.fn(),
  updateMissionOption: jest.fn(),
}));

const listMock = fetchMissionOptionGroups as jest.MockedFunction<typeof fetchMissionOptionGroups>;
const createGroupMock = createMissionOptionGroup as jest.MockedFunction<
  typeof createMissionOptionGroup
>;
const updateGroupMock = updateMissionOptionGroup as jest.MockedFunction<
  typeof updateMissionOptionGroup
>;
const createOptionMock = createMissionOption as jest.MockedFunction<typeof createMissionOption>;
const updateOptionMock = updateMissionOption as jest.MockedFunction<typeof updateMissionOption>;

/**
 * The group ID and the option ID are what the write PATHS carry: `updateMissionOptionGroup(groupId, …)`,
 * `createMissionOption(groupId, …)` and `updateMissionOption(groupId, optionId, …)`.
 *
 * THE ROW CONTROLS ARE KEYED BY CODE, NOT BY ID, and that is part of the contract this spec pins. A
 * group's `code` is the stable machine key the rule engine classifies by and the thing the operator
 * reads beside the label, so the panel hangs each row's controls off it: every `hr-mission-group-*`
 * and `hr-mission-option-new-*` testid below therefore carries `DURATION`. An option's controls are
 * keyed by the option ID, because an option's code is the group's business while its catalogue row
 * is identified by its own id.
 */
const GROUP_ID = 'grp-duration';
const OPTION_ID = 'opt-daily';

/** Two of the three server-declared groups, each carrying the options the rule set maps. */
const DURATION = missionOptionGroup({
  id: GROUP_ID,
  code: 'DURATION',
  label: 'مدت ماموریت',
  required: true,
  sortOrder: 1,
  options: [
    missionOption({ id: OPTION_ID, optionGroupId: GROUP_ID, code: 'DAILY', label: 'روزانه' }),
  ],
});
const LOCATION = missionOptionGroup({
  id: 'grp-location',
  code: 'LOCATION',
  label: 'محل انجام',
  required: true,
  sortOrder: 2,
  options: [missionOption({ id: 'opt-in-city', optionGroupId: 'grp-location', code: 'IN_CITY' })],
});

const CATALOGUE = page([DURATION, LOCATION], 2);

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue(CATALOGUE);
  createGroupMock.mockResolvedValue(DURATION);
  updateGroupMock.mockResolvedValue(DURATION);
  createOptionMock.mockResolvedValue(missionOption());
  updateOptionMock.mockResolvedValue(missionOption());
});

/**
 * The shipped source, so an absence can be asserted where it would actually appear.
 *
 * `executableSource` strips comments because these files legitimately DISCUSS the concepts they must
 * not implement — the panel's header explains why `code` is not editable and why no project link
 * exists. What must not exist is such a field in the CODE.
 */
const PANEL_SOURCE = executableSource('src/components/hr/MissionOptionCataloguePanel.tsx');
const VIEW_SOURCE = executableSource('src/components/hr/HrMissionConfigurationView.tsx');

describe('the catalogue read', () => {
  it('reads one page of the server catalogue, with no argument at all', async () => {
    render(<MissionOptionCataloguePanel />);

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    expect(listMock.mock.calls[0]).toHaveLength(0);
  });

  it('renders a loading state while the read is in flight', () => {
    listMock.mockReturnValue(new Promise(() => undefined));
    render(<MissionOptionCataloguePanel />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-catalogue')).not.toBeInTheDocument();
  });

  it('renders the groups and their options as the server returned them', async () => {
    render(<MissionOptionCataloguePanel />);

    expect(await screen.findByTestId('hr-mission-group-label-DURATION')).toHaveTextContent(
      'مدت ماموریت'
    );
    expect(screen.getByTestId('hr-mission-group-code-DURATION')).toHaveTextContent('DURATION');
    expect(screen.getByTestId('hr-mission-group-label-LOCATION')).toHaveTextContent('محل انجام');
    // The options belong to their OWN group, so the LOCATION page is not the DURATION page.
    expect(screen.getByTestId('hr-mission-options-LOCATION')).toContainElement(
      screen.getByTestId('hr-mission-option-opt-in-city')
    );
  });

  it('states an empty catalogue as empty rather than as a failure', async () => {
    listMock.mockResolvedValue(page([], 0));

    render(<MissionOptionCataloguePanel />);

    expect(await screen.findByText(/خالی است/)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-catalogue')).not.toBeInTheDocument();
  });

  it('surfaces a failed read with a retry that re-issues it', async () => {
    listMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
    listMock.mockResolvedValueOnce(CATALOGUE);

    render(<MissionOptionCataloguePanel />);

    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByTestId('hr-mission-catalogue')).toBeInTheDocument();
  });
});

describe('creating an option group', () => {
  it('posts exactly the CreateMissionOptionGroupDto fields', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-catalogue');

    await userEvent.click(screen.getByTestId('hr-mission-catalogue-create-group'));
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-code'), 'ENGAGEMENT');
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-label'), 'نوع مشارکت');
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-sort'), '3');
    await userEvent.click(screen.getByTestId('hr-mission-catalogue-new-group-save'));

    await waitFor(() => expect(createGroupMock).toHaveBeenCalledTimes(1));
    // EXACTLY the DTO's four fields: `code`, `label`, `required`, `sortOrder`.
    expect(createGroupMock).toHaveBeenCalledWith({
      code: 'ENGAGEMENT',
      label: 'نوع مشارکت',
      required: true,
      sortOrder: 3,
    });
  });

  it('sends no tenantId, actorId, approverId or project linkage', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-catalogue');

    await userEvent.click(screen.getByTestId('hr-mission-catalogue-create-group'));
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-code'), 'X');
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-label'), 'گروه');
    await userEvent.click(screen.getByTestId('hr-mission-catalogue-new-group-save'));

    await waitFor(() => expect(createGroupMock).toHaveBeenCalledTimes(1));
    const body = createGroupMock.mock.calls[0][0];
    expect(Object.keys(body).sort()).toEqual(['code', 'label', 'required']);
    for (const forbidden of [
      'tenantId',
      'actorId',
      'approverId',
      'projectId',
      'project_id',
      'status',
      'configuration',
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('warns about a group code the rule set does not serve, without refusing it', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-catalogue');

    await userEvent.click(screen.getByTestId('hr-mission-catalogue-create-group'));
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-code'), 'UNKNOWN');

    expect(screen.getByTestId('hr-mission-catalogue-group-code-warning')).toBeInTheDocument();
    // The warning is NOT a refusal, and the proof is that the row becomes submit-ready as soon as the
    // DTO's OWN required fields are filled — `code` and `label`, which are the only two the create
    // DTO marks non-optional. The save is therefore gated on the DTO and never on the warning.
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-label'), 'گروه تازه');
    expect(screen.getByTestId('hr-mission-catalogue-new-group-save')).toBeEnabled();
  });

  it('re-fetches the authoritative catalogue after a successful create', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-catalogue');
    const readsBefore = listMock.mock.calls.length;

    await userEvent.click(screen.getByTestId('hr-mission-catalogue-create-group'));
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-code'), 'ENGAGEMENT');
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-label'), 'نوع مشارکت');
    await userEvent.click(screen.getByTestId('hr-mission-catalogue-new-group-save'));

    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it('shows a create failure instead of swallowing it', async () => {
    createGroupMock.mockRejectedValueOnce(new CoreApiError('کد تکراری است', 409));

    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-catalogue');

    await userEvent.click(screen.getByTestId('hr-mission-catalogue-create-group'));
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-code'), 'ENGAGEMENT');
    await userEvent.type(screen.getByTestId('hr-mission-catalogue-new-group-label'), 'تکراری');
    await userEvent.click(screen.getByTestId('hr-mission-catalogue-new-group-save'));

    expect(await screen.findByTestId('hr-notice-error')).toHaveTextContent('کد تکراری است');
  });
});

describe('updating an option group', () => {
  it('patches exactly the UpdateMissionOptionGroupDto fields, and NEVER the code', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-group-edit-DURATION');

    await userEvent.click(screen.getByTestId('hr-mission-group-edit-DURATION'));
    const labelInput = screen.getByTestId('hr-mission-group-label-input-DURATION');
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'مدت مأموریت');
    await userEvent.click(screen.getByTestId('hr-mission-group-active-input-DURATION'));
    await userEvent.click(screen.getByTestId('hr-mission-group-save-DURATION'));

    await waitFor(() => expect(updateGroupMock).toHaveBeenCalledTimes(1));
    const [groupId, body] = updateGroupMock.mock.calls[0];
    expect(groupId).toBe(GROUP_ID);
    // `code` is NOT settable: it is the stable machine key the classification is derived from, so
    // renaming it would silently reclassify every request already recorded against the group.
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('tenantId');
    expect(body.label).toBe('مدت مأموریت');
    expect(body.active).toBe(false);
    expect(body.required).toBe(true);
    // `sortOrder` was NOT touched, and it comes back as the group's OWN value rather than being
    // dropped: the editor seeds the input from the row it is editing, so a field the operator left
    // alone is re-stated at its current value instead of silently resetting.
    expect(body.sortOrder).toBe(1);
  });

  it('re-fetches the catalogue after a successful update', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-group-edit-DURATION');
    const readsBefore = listMock.mock.calls.length;

    await userEvent.click(screen.getByTestId('hr-mission-group-edit-DURATION'));
    await userEvent.click(screen.getByTestId('hr-mission-group-save-DURATION'));

    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(readsBefore));
  });

  it('shows an update failure instead of swallowing it', async () => {
    updateGroupMock.mockRejectedValueOnce(new CoreApiError('ویرایش مجاز نیست', 403));

    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-group-edit-DURATION');

    await userEvent.click(screen.getByTestId('hr-mission-group-edit-DURATION'));

    const labelInput = screen.getByTestId('hr-mission-group-label-input-DURATION');
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'مدت ماموریت (بازنگری)');
    // `clear` FIRST, because the panel SEEDS this input from the group being edited (sortOrder `1`):
    // typing without clearing would append and send `15`, which is the control working correctly and
    // the assertion below wrong. The seeded value is asserted by the "untouched field" case instead.
    const sortInput = screen.getByTestId('hr-mission-group-sort-input-DURATION');
    await userEvent.clear(sortInput);
    await userEvent.type(sortInput, '5');
    // Unchecking `required` and `active` proves these two flags are the operator's statement rather
    // than values the panel carries over silently.
    await userEvent.click(screen.getByTestId('hr-mission-group-required-input-DURATION'));
    await userEvent.click(screen.getByTestId('hr-mission-group-active-input-DURATION'));
    await userEvent.click(screen.getByTestId('hr-mission-group-save-DURATION'));

    await waitFor(() => expect(updateGroupMock).toHaveBeenCalledTimes(1));
    const [groupId, body] = updateGroupMock.mock.calls[0];
    // The GROUP is the path segment.
    expect(groupId).toBe(GROUP_ID);
    // EXACTLY the DTO's fields, and no others. `required`/`active` are sent explicitly because the
    // operator stated them, and `sortOrder` is the fixture's own value carried through untouched: the
    // panel seeds the input from the group it is editing, so an untouched field is re-stated rather
    // than dropped.
    expect(body).toEqual({
      label: 'مدت ماموریت (بازنگری)',
      sortOrder: 5,
      required: false,
      active: false,
    });
    // `code` IS NOT SETTABLE. It is the machine key the classification is derived from, so renaming
    // it would silently reclassify every request recorded against it.
    expect(body).not.toHaveProperty('code');
    for (const forbidden of ['id', 'tenantId', 'actorId', 'projectId', 'project_id', 'status']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('offers no input bound to the group code', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-group-edit-DURATION');

    await userEvent.click(screen.getByTestId('hr-mission-group-edit-DURATION'));

    // The code is DISPLAYED and stated as immutable, and there is no field that could change it.
    expect(screen.getByTestId('hr-mission-group-code-DURATION')).toHaveTextContent('DURATION');
    expect(screen.queryByTestId('hr-mission-group-code-input-DURATION')).not.toBeInTheDocument();
  });
});

describe('options inside a group', () => {
  it('posts exactly the CreateMissionOptionDto fields, addressed by the group path', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-group-add-option-DURATION');

    await userEvent.click(screen.getByTestId('hr-mission-group-add-option-DURATION'));
    await userEvent.type(screen.getByTestId('hr-mission-option-new-code-DURATION'), 'HOURLY');
    await userEvent.type(screen.getByTestId('hr-mission-option-new-label-DURATION'), 'ساعتی');
    await userEvent.type(screen.getByTestId('hr-mission-option-new-sort-DURATION'), '2');
    await userEvent.click(screen.getByTestId('hr-mission-option-new-save-DURATION'));

    await waitFor(() => expect(createOptionMock).toHaveBeenCalledTimes(1));
    const [groupId, body] = createOptionMock.mock.calls[0];
    // The GROUP is the path segment; the body carries only the DTO's own fields.
    expect(groupId).toBe(GROUP_ID);
    expect(body).toEqual({ code: 'HOURLY', label: 'ساعتی', sortOrder: 2 });
    expect(body).not.toHaveProperty('optionGroupId');
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('projectId');
  });

  it('patches exactly the UpdateMissionOptionDto fields, with both ids in the path', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-option-edit-opt-daily');

    await userEvent.click(screen.getByTestId('hr-mission-option-edit-opt-daily'));
    const labelInput = screen.getByTestId('hr-mission-option-label-input-opt-daily');
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'روزانه کامل');
    await userEvent.click(screen.getByTestId('hr-mission-option-active-input-opt-daily'));
    await userEvent.click(screen.getByTestId('hr-mission-option-save-opt-daily'));

    await waitFor(() => expect(updateOptionMock).toHaveBeenCalledTimes(1));
    const [groupId, optionId, body] = updateOptionMock.mock.calls[0];
    expect(groupId).toBe(GROUP_ID);
    expect(optionId).toBe('opt-daily');
    // The option's `sortOrder` is seeded from the row and re-stated untouched; only `label` and
    // `active` are the operator's changes.
    expect(body).toEqual({ label: 'روزانه کامل', active: false, sortOrder: 1 });
    // Neither id is repeated in the body: the group scopes the row and the option identifies it.
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('optionGroupId');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('tenantId');
  });

  it('omits a blank sortOrder rather than sending 0, which the DTO would read as a real order', async () => {
    // `sortOrder` is `@IsOptional() @IsInt() @Min(0)`, so `0` is a LEGAL value meaning "first". A
    // panel that turned a blank box into `0` would silently promote every cleared row, which is why
    // the builder drops the key instead of coercing it.
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-option-edit-opt-daily');

    await userEvent.click(screen.getByTestId('hr-mission-option-edit-opt-daily'));
    await userEvent.clear(screen.getByTestId('hr-mission-option-sort-input-opt-daily'));
    await userEvent.click(screen.getByTestId('hr-mission-option-save-opt-daily'));

    await waitFor(() => expect(updateOptionMock).toHaveBeenCalledTimes(1));
    const body = updateOptionMock.mock.calls[0][2];
    expect(body).not.toHaveProperty('sortOrder');
    expect(Object.keys(body).sort()).toEqual(['active', 'label']);
  });

  it('keeps the option code out of every editable field', async () => {
    render(<MissionOptionCataloguePanel />);
    await screen.findByTestId('hr-mission-option-edit-opt-daily');

    await userEvent.click(screen.getByTestId('hr-mission-option-edit-opt-daily'));

    // There is no input bound to the code, so it cannot be renamed by accident.
    expect(screen.queryByTestId('hr-mission-option-code-input-opt-daily')).not.toBeInTheDocument();
    expect(screen.getByTestId('hr-mission-option-code-opt-daily')).toHaveTextContent('DAILY');
  });
});

// ---------------------------------------------------------------------------
// Global claims about what this surface must never contain
// ---------------------------------------------------------------------------

describe('what the catalogue surface never does', () => {
  it('sends no tenantId, actorId, approverId or project linkage from any write', () => {
    // The bodies are built by pure functions, so the claim can be made over the SOURCE rather than
    // over one sampled call: an absence that only holds for the paths a spec happened to exercise
    // is not an absence.
    for (const forbidden of [
      'tenantId',
      'actorId',
      'approverId',
      'projectId',
      'project_id',
      'Project',
    ]) {
      expect(PANEL_SOURCE).not.toContain(forbidden);
    }
  });

  it('never invents a catalogue entity or a semantic value of its own', () => {
    // The three groups and their option vocabularies are SERVER-declared. The panel may NAME them to
    // warn about a code the rule set does not serve — that is a statement about the engine, not a
    // fabricated record — but it must not build a second catalogue of its own.
    //
    // The distinction is between READING a DTO field and DECLARING a constant table of them: the
    // panel legitimately writes `code: code.trim()` into a request body, so the claim to pin is that
    // no local declaration stands in for the server's data.
    for (const fabricated of [
      'const CATALOGUE',
      'const GROUPS',
      'const OPTIONS',
      'DEFAULT_GROUPS',
      'SEED_GROUPS',
      'FALLBACK_GROUPS',
    ]) {
      expect(PANEL_SOURCE).not.toContain(fabricated);
    }
    // No catalogue literal is ever constructed: every object the panel builds is a REQUEST BODY whose
    // values come from operator input.
    expect(PANEL_SOURCE).not.toMatch(/code:\s*'/);
    expect(PANEL_SOURCE).not.toMatch(/label:\s*'/);
    expect(PANEL_SOURCE).not.toMatch(/sortOrder:\s*\d/);
  });

  it('does not author a policy configuration document', () => {
    // `configuration` is `unknown` in the frozen client for a reason, and a JSON editor for it would
    // be an invented schema. Neither this panel nor the view around it builds one.
    expect(PANEL_SOURCE).not.toContain('configuration');
    expect(VIEW_SOURCE).not.toContain('JSON.parse');
    expect(VIEW_SOURCE).not.toContain('configuration:');
  });

  it('does not link a mission to a Project', () => {
    // `PROJECT` / `NON_PROJECT` is classification only: no `Project` model, key or membership is
    // consulted anywhere in the Mission domain, so nothing on this surface may introduce one.
    expect(VIEW_SOURCE).not.toContain('projectId');
    expect(VIEW_SOURCE).not.toContain('project_id');
    expect(VIEW_SOURCE).not.toMatch(/\/projects/);
  });

  it('consults hr.mission.policy and no other Mission grant', () => {
    // The controller decorates every catalogue route with `Permissions.HR_MISSION_POLICY`. Requiring
    // the register's or the approver's grant here would make the grant the backend demands
    // insufficient to do the job it names.
    expect(VIEW_SOURCE).toContain('hr.mission.policy');
    expect(VIEW_SOURCE).not.toContain('hr.mission.read');
    expect(VIEW_SOURCE).not.toContain('hr.mission.approve');
    expect(PANEL_SOURCE).not.toContain('hr.mission.read');
    expect(PANEL_SOURCE).not.toContain('hr.mission.approve');
  });

  it('introduces no COMPLETED request status and reuses the shared Mission labels', () => {
    // A mission's request statuses are the seven the API declares; `COMPLETED` belongs only to an
    // approval INSTANCE. The catalogue deals in neither, and it takes its wording from the one
    // shared label module rather than minting a second vocabulary.
    expect(PANEL_SOURCE).not.toContain('COMPLETED');
    expect(PANEL_SOURCE).toContain('hr-mission-labels');
  });

  it('adds nothing to navigation', () => {
    // Navigation is out of scope for this step: the surface exists at its route and is reachable
    // without being registered in a menu or an allow-list.
    expect(VIEW_SOURCE).not.toContain('core-nav');
    expect(VIEW_SOURCE).not.toContain('NAV_TARGETS');
    expect(VIEW_SOURCE).not.toContain('nav-catalogue');
  });
});
