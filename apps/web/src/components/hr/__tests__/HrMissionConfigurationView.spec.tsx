import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { HrMissionConfigurationView } from '../HrMissionConfigurationView';
import { useCorePermissions } from '@/components/core/useCorePermissions';
import { CoreApiError } from '@/lib/core-http';
import {
  fetchMissionApprovalDefinitions,
  fetchMissionOptionGroups,
  fetchMissionPolicyVersions,
  type HrMissionPolicyVersion,
} from '@/lib/hr-mission-api';
import { executableSource } from './source-scan';
import {
  missionApprovalDefinition,
  missionOptionGroup,
  missionRuleSetVersion,
  page,
} from './hr-fixtures';

/**
 * Phase 55 Step 8D: the Mission ADMIN CONFIGURATION screen (`/admin/hr/missions/configuration`).
 *
 * WHAT THESE SPECS ARE FOR. The wire contract is frozen by `hr-mission-api.spec.ts` (Step 8A) and the
 * three configuration domains have their own focused specs. The claims worth pinning HERE are the
 * ones only the SCREEN can get wrong:
 *
 *   * that ONE grant — `hr.mission.policy` — governs all three domains, because
 *     `mission.controller.ts` decorates every catalogue, definition and policy-version route with it,
 *     reads included;
 *   * that a caller WITHOUT it issues NO request at all — asserted as an ABSENT call on all three
 *     reads, not merely as a hidden table, because a read that would 403 is a request the grants do
 *     not cover;
 *   * that the permission answer is awaited before anything is read, so no request races it;
 *   * that the grant is sufficient on its own — `hr.mission.read` and `hr.mission.approve` guard the
 *     register and the manager queue, so needing either here would make the grant the backend
 *     actually demands unable to do the job it names;
 *   * that DOMAIN 3 is OBSERVED, not edited: the policy card reads and renders the server's versions
 *     and offers NO create/edit/lifecycle control, because `configuration` is `unknown`;
 *   * that the policy card re-reads authoritatively on retry and never manufactures a status.
 *
 * THE PERMISSION SIGNAL IS STUBBED, THE CLIENT IS NOT. `useCorePermissions` is mocked because a spec
 * cannot enrol a user; `@/lib/hr-mission-api` is mocked so no network is touched, but every
 * assertion about WHAT was called is made on the real production functions.
 */

jest.mock('@/components/core/useCorePermissions', () => ({
  useCorePermissions: jest.fn(),
}));

jest.mock('@/lib/hr-mission-api', () => ({
  ...jest.requireActual('@/lib/hr-mission-api'),
  fetchMissionOptionGroups: jest.fn(),
  fetchMissionApprovalDefinitions: jest.fn(),
  fetchMissionPolicyVersions: jest.fn(),
}));

const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const groupsMock = fetchMissionOptionGroups as jest.MockedFunction<typeof fetchMissionOptionGroups>;
const definitionsMock = fetchMissionApprovalDefinitions as jest.MockedFunction<
  typeof fetchMissionApprovalDefinitions
>;
const versionsMock = fetchMissionPolicyVersions as jest.MockedFunction<
  typeof fetchMissionPolicyVersions
>;

const POLICY = 'hr.mission.policy';

const VIEW_SOURCE = executableSource('src/components/hr/HrMissionConfigurationView.tsx');

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

/**
 * A policy version, spelled the way the API spells it.
 *
 * `configuration` is a REAL `MissionRuleSetVersion` (built by the shared fixture) and `actions` comes
 * from the server, because that is now the wire contract: the document is a typed Rule Engine document
 * and eligibility is the server's answer, not this screen's reading of `status`.
 */
function policyVersion(overrides: Partial<HrMissionPolicyVersion> = {}): HrMissionPolicyVersion {
  return {
    id: 'pv-1',
    version: 3,
    status: 'PUBLISHED',
    ruleSetId: 'hr.mission.approval',
    configuration: missionRuleSetVersion(),
    publishedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    // The server's answer for `PUBLISHED`: only archive is legal.
    actions: { canValidate: false, canPublish: false, canArchive: true },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  grant([POLICY]);
  groupsMock.mockResolvedValue(page([missionOptionGroup()]));
  definitionsMock.mockResolvedValue(page([missionApprovalDefinition()]));
  versionsMock.mockResolvedValue(page([policyVersion()]));
});

describe('DOMAIN 3 — the policy versions, observed and not edited', () => {
  it('renders each version with its stored status and the consequence that status carries', async () => {
    versionsMock.mockResolvedValue(
      page([policyVersion({ id: 'pv-9', version: 9, status: 'VALIDATED' })])
    );

    render(<HrMissionConfigurationView />);

    expect(await screen.findByTestId('hr-mission-policy-version-9')).toBeInTheDocument();
    expect(screen.getByTestId('hr-mission-policy-version-status-9')).toHaveTextContent(
      'اعتبارسنجی‌شده'
    );
    // The meaning travels with the label: «اعتبارسنجی‌شده» alone does not tell an operator whether the
    // version governs today's decisions.
    expect(screen.getByTestId('hr-mission-policy-version-meaning-9')).toHaveTextContent(/انتشار/);
  });

  it('names each version’s own rule set rather than assuming the Mission one', async () => {
    // The list is filtered server-side by rule set; the row still states what the SERVER returned, so a
    // row describing a different set is reported as such instead of being relabelled.
    versionsMock.mockResolvedValue(
      page([policyVersion({ version: 4, ruleSetId: 'hr.mission.approval' })])
    );

    render(<HrMissionConfigurationView />);

    expect(await screen.findByTestId('hr-mission-policy-version-4')).toHaveTextContent(
      'hr.mission.approval'
    );
  });

  it('states an EMPTY policy list as the absence of configuration, not as a failure', async () => {
    versionsMock.mockResolvedValue(page([]));

    render(<HrMissionConfigurationView />);

    expect(await screen.findByText(/هیچ نسخه‌ای/)).toBeInTheDocument();
    expect(screen.queryByTestId('hr-mission-policy-version-list')).not.toBeInTheDocument();
  });

  it('uses the server page envelope and never invents a total of its own', async () => {
    // `page()` builds `{ items, total, page, pageSize }`. The card renders `items` as received; a
    // client-side count over a page would be a count over a page, not over the configuration.
    versionsMock.mockResolvedValue(page([policyVersion({ version: 1 })], 41));

    render(<HrMissionConfigurationView />);

    expect(await screen.findByTestId('hr-mission-policy-version-1')).toBeInTheDocument();
    expect(screen.queryByText('41')).not.toBeInTheDocument();
  });

  it('surfaces a failed policy read with a retry that re-issues the read', async () => {
    versionsMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));
    versionsMock.mockResolvedValueOnce(page([policyVersion({ version: 7 })]));

    render(<HrMissionConfigurationView />);

    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    await waitFor(() => expect(versionsMock).toHaveBeenCalledTimes(1));

    // `userEvent` rather than a raw `.click()`: the raw DOM call fires the handler OUTSIDE React's
    // act() scope, so the state it sets lands after the test has moved on and React warns about it.
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    // Re-READ, never re-derived: the retry goes back to the server for the authoritative state.
    await waitFor(() => expect(versionsMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('hr-mission-policy-version-7')).toBeInTheDocument();
  });

  it('renders the SERVER’s eligibility and never derives it from status', async () => {
    // The flags deliberately CONTRADICT the status: an `ARCHIVED` version that the server says may be
    // validated. A screen that computed the matrix from `status` would render "no transition is legal"
    // here and fail — which is exactly the defect this assertion exists to catch.
    versionsMock.mockResolvedValue(
      page([
        policyVersion({
          version: 12,
          status: 'ARCHIVED',
          actions: { canValidate: true, canPublish: false, canArchive: false },
        }),
      ])
    );

    render(<HrMissionConfigurationView />);

    expect(await screen.findByTestId('hr-mission-policy-version-actions-12')).toHaveTextContent(
      'اعتبارسنجی'
    );
    // ...and only that one: the other two flags are false, so neither label may appear beside it.
    const actions = screen.getByTestId('hr-mission-policy-version-actions-12');
    expect(actions).not.toHaveTextContent('انتشار');
    expect(actions).not.toHaveTextContent('بایگانی');
  });

  it('states that a version with no legal transition has none, rather than saying nothing', async () => {
    versionsMock.mockResolvedValue(
      page([
        policyVersion({
          version: 13,
          status: 'ARCHIVED',
          actions: { canValidate: false, canPublish: false, canArchive: false },
        }),
      ])
    );

    render(<HrMissionConfigurationView />);

    // Silence would be indistinguishable from a field the screen forgot to render.
    expect(await screen.findByTestId('hr-mission-policy-version-actions-13')).toHaveTextContent(
      'مجاز نیست'
    );
  });

  it('offers NO authoring or lifecycle control, because no Policy editor exists in this phase', async () => {
    versionsMock.mockResolvedValue(page([policyVersion({ status: 'DRAFT' })]));

    render(<HrMissionConfigurationView />);

    await screen.findByTestId('hr-mission-policy-version-3');

    // A DRAFT is exactly the state `validateVersion` accepts, so this is the version a client WOULD
    // wire a Validate button to. Its presence in `actions` is now asserted above, which makes the
    // absence of the BUTTON a deliberate choice rather than a missing field: no version can be
    // AUTHORED from this surface (no Policy editor exists yet), so shipping the transitions on a
    // read-only list would offer an act whose subject nobody can create here.
    const card = screen.getByTestId('hr-mission-policy-versions');
    expect(within(card).queryByRole('button', { name: /اعتبارسنجی/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /انتشار/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /بایگانی/ })).not.toBeInTheDocument();
    // No AUTHORING control either — and the claim is scoped to THIS card, because the catalogue and
    // the definitions beside it legitimately DO create and edit their own server-declared fields.
    // What must not exist is a control over the opaque document, so a card-wide button sweep is the
    // wrong assertion: it would pass for the wrong reason if the other two domains' buttons vanished.
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
  });

  it('states the policy-editor contract gap on the surface instead of faking a schema', async () => {
    render(<HrMissionConfigurationView />);

    // The gap is a CLAIM rendered to the operator, not a comment only a developer reads.
    expect(await screen.findByTestId('hr-mission-policy-editor-gap')).toBeInTheDocument();
  });

  it('names the three rule facts the Mission engine is given, and no fourth', async () => {
    render(<HrMissionConfigurationView />);

    // `mission-options.ts` derives exactly these three from the selected catalogue options.
    expect(await screen.findByTestId('hr-mission-policy-fact-durationMode')).toBeInTheDocument();
    expect(screen.getByTestId('hr-mission-policy-fact-locationType')).toBeInTheDocument();
    expect(screen.getByTestId('hr-mission-policy-fact-engagementType')).toBeInTheDocument();
  });
});

describe('the ONE grant, and the three reads it covers', () => {
  it('reads all three domains through the real client under the ONE policy grant', async () => {
    render(<HrMissionConfigurationView />);

    await waitFor(() => expect(groupsMock).toHaveBeenCalled());
    // `mission.controller.ts` guards the catalogue, the definitions and the policy versions with the
    // same `@Roles(Permissions.HR_MISSION_POLICY)` — reads included — so one grant covers all three.
    expect(definitionsMock).toHaveBeenCalled();
    expect(versionsMock).toHaveBeenCalled();
    expect(screen.getByTestId('hr-mission-configuration')).toBeInTheDocument();
  });

  it('issues NO request at all when the actor holds no hr.mission.policy', async () => {
    grant([]);
    render(<HrMissionConfigurationView />);

    await waitFor(() => expect(screen.getByText(/hr\.mission\.policy/)).toBeInTheDocument());

    // The refusal is stated, and NOTHING is attempted — not one of the three reads.
    expect(groupsMock).not.toHaveBeenCalled();
    expect(definitionsMock).not.toHaveBeenCalled();
    expect(versionsMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('hr-mission-configuration')).not.toBeInTheDocument();
  });

  it('waits for the permission signal before reading anything', () => {
    grant([POLICY], true);
    render(<HrMissionConfigurationView />);

    // Still loading: no read may race the answer that decides whether the reads are allowed.
    expect(groupsMock).not.toHaveBeenCalled();
    expect(definitionsMock).not.toHaveBeenCalled();
    expect(versionsMock).not.toHaveBeenCalled();
  });

  it('does not consult the register or the approval grant, which are other surfaces’ grants', async () => {
    render(<HrMissionConfigurationView />);

    await waitFor(() => expect(groupsMock).toHaveBeenCalled());
    // Requiring either would make the grant the backend actually demands insufficient.
    expect(VIEW_SOURCE).not.toContain('hr.mission.read');
    expect(VIEW_SOURCE).not.toContain('hr.mission.approve');
  });
});
