import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MissionApprovalDefinitionPanel } from '../MissionApprovalDefinitionPanel';
import { CoreApiError } from '@/lib/core-http';
import {
  createMissionApprovalDefinition,
  fetchMissionApprovalDefinitions,
  replaceMissionApprovalDefinitionSteps,
  updateMissionApprovalDefinition,
} from '@/lib/hr-mission-api';
import { missionApprovalDefinition, missionApprovalStep } from './hr-fixtures';
import { executableSource } from './source-scan';

/**
 * Phase 55 Step 8D: DOMAIN 2 — Mission APPROVAL DEFINITION configuration.
 *
 * WHAT ONLY THIS PANEL CAN GET WRONG. The wire contract is frozen by `hr-mission-api.spec.ts` (Step
 * 8A) and the routing rules live in `mission-approval.service.ts`, so the claims worth pinning here
 * are the ones this surface alone decides:
 *
 *   * that the STEP ROUTE IS PRESENTED AS A REPLACEMENT. Its handler takes a
 *     `CreateMissionApprovalDefinitionDto` and reads ONLY `dto.steps`, so an omitted step is a
 *     REMOVED step. A panel that presented it as "add one step" would delete work by accident — so
 *     the spec asserts the payload is the WHOLE list and that the delete control exists.
 *   * that `selfApprovalMode` IS SENT, because `CreateMissionApprovalDefinitionDto` REQUIRES it. It
 *     was refused in the EMPLOYEE request body, and the distinction is exactly what a regression
 *     would collapse.
 *   * that `approverEmployeeId` is the EXECUTABLE reference and a ROLE-ONLY step is never written,
 *     because the service REFUSES to open a flow through a step that names no employee.
 *   * that no `tenantId`, `actorId`, `projectId` or `parallelCompletionMode` is ever posted.
 *
 * THE CLIENT IS MOCKED SO NO NETWORK IS TOUCHED, but every assertion about WHAT was called is made on
 * the real production function's call arguments.
 */

jest.mock('@/lib/hr-mission-api', () => ({
  ...jest.requireActual('@/lib/hr-mission-api'),
  fetchMissionApprovalDefinitions: jest.fn(),
  createMissionApprovalDefinition: jest.fn(),
  updateMissionApprovalDefinition: jest.fn(),
  replaceMissionApprovalDefinitionSteps: jest.fn(),
}));

const listMock = fetchMissionApprovalDefinitions as jest.MockedFunction<
  typeof fetchMissionApprovalDefinitions
>;
const createMock = createMissionApprovalDefinition as jest.MockedFunction<
  typeof createMissionApprovalDefinition
>;
const updateMock = updateMissionApprovalDefinition as jest.MockedFunction<
  typeof updateMissionApprovalDefinition
>;
const replaceStepsMock = replaceMissionApprovalDefinitionSteps as jest.MockedFunction<
  typeof replaceMissionApprovalDefinitionSteps
>;

const DEFINITION_ID = 'def-1';
const STEP_ID = 'step-1';
const APPROVER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The shipped source, so an absence can be asserted where it would actually appear.
 *
 * Comments are stripped by `executableSource` because this file LEGITIMATELY DISCUSSES what it must
 * not do — the header explains why no role picker exists, which means the words `approverRole` must
 * appear. What must not exist is a role-bound CONTROL.
 */
const PANEL_SOURCE = executableSource('src/components/hr/MissionApprovalDefinitionPanel.tsx');

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue({
    items: [
      missionApprovalDefinition({
        id: DEFINITION_ID,
        steps: [
          missionApprovalStep({
            id: STEP_ID,
            approvalDefinitionId: DEFINITION_ID,
            order: 1,
            name: 'تأیید مدیر مستقیم',
            approverEmployeeId: APPROVER_ID,
            approverRole: null,
          }),
        ],
      }),
    ],
    total: 1,
    page: 1,
    pageSize: 20,
  });
  createMock.mockResolvedValue(missionApprovalDefinition());
  updateMock.mockResolvedValue(missionApprovalDefinition({ id: DEFINITION_ID }));
  replaceStepsMock.mockResolvedValue(missionApprovalDefinition({ id: DEFINITION_ID }));
});

describe('the definitions read', () => {
  it('renders a loading state while the read is in flight', () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders the definitions the server returned, with their stored steps', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);

    expect(await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId(`hr-mission-definition-step-${STEP_ID}`)).toHaveTextContent(
      'تأیید مدیر مستقیم'
    );
  });

  it('states an empty list as empty rather than as a failure', async () => {
    listMock.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 });

    render(<MissionApprovalDefinitionPanel canWrite />);

    expect(
      await screen.findByText(/هیچ تعریف گردش تأیید ماموریتی ثبت نشده است/)
    ).toBeInTheDocument();
  });

  it('surfaces a failed read with a retry that re-issues it', async () => {
    listMock.mockRejectedValueOnce(new CoreApiError('خطای سرور', 500));

    render(<MissionApprovalDefinitionPanel canWrite />);

    expect(await screen.findByText('خطای سرور')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });
});

describe('the grant, and the read it covers', () => {
  it('issues NO request at all when the actor holds no hr.mission.policy', () => {
    render(<MissionApprovalDefinitionPanel canWrite={false} />);

    // The refusal is stated, and NOTHING is attempted: a read that would 403 is a request the grants
    // do not cover.
    expect(listMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(replaceStepsMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('hr-mission-approval-definitions-forbidden')).toBeInTheDocument();
  });

  it('names hr.mission.policy as the grant it needs', () => {
    render(<MissionApprovalDefinitionPanel canWrite={false} />);
    expect(screen.getByText(/hr\.mission\.policy/)).toBeInTheDocument();
  });

  it('reads the definitions through the real client, with NO argument at all', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);

    await waitFor(() => expect(listMock).toHaveBeenCalled());
    // No filter, no page, no actor: the server's own default page is the answer, and a client that
    // invented a `status` filter would be hiding rows the server returned.
    expect(listMock).toHaveBeenCalledWith();
    expect(listMock.mock.calls[0]).toHaveLength(0);
  });
});

describe('creating a definition', () => {
  it('sends the exact CreateMissionApprovalDefinitionDto fields, and nothing else', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId('hr-mission-definition-create-open'));
    await userEvent.type(screen.getByTestId('hr-mission-definition-new-name'), 'گردش مدیرعامل');

    // The single default step, completed to the DTO's own constraints.
    await userEvent.type(screen.getByLabelText(/عنوان مرحله/), 'تأیید مدیرعامل');
    await userEvent.type(screen.getByLabelText(/شناسهٔ کارمند تأییدکننده/), APPROVER_ID);

    await userEvent.click(screen.getByTestId('hr-mission-definition-create-submit'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith({
      name: 'گردش مدیرعامل',
      routingMode: 'SEQUENTIAL',
      selfApprovalMode: 'NOT_ALLOWED',
      steps: [
        {
          order: 1,
          name: 'تأیید مدیرعامل',
          approverEmployeeId: APPROVER_ID,
          required: true,
        },
      ],
    });
  });

  it('sends selfApprovalMode because the DTO REQUIRES it, and honours the chosen value', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId('hr-mission-definition-create-open'));
    await userEvent.type(
      screen.getByTestId('hr-mission-definition-new-name'),
      'گردش با تأیید خودی'
    );
    await userEvent.selectOptions(
      screen.getByTestId('hr-mission-definition-new-self-approval'),
      'ALLOWED'
    );
    await userEvent.selectOptions(
      screen.getByTestId('hr-mission-definition-new-routing'),
      'PARALLEL'
    );
    await userEvent.type(screen.getByLabelText(/عنوان مرحله/), 'تأیید');
    await userEvent.type(screen.getByLabelText(/شناسهٔ کارمند تأییدکننده/), APPROVER_ID);

    await userEvent.click(screen.getByTestId('hr-mission-definition-create-submit'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const body = createMock.mock.calls[0][0];
    // `selfApprovalMode` is a REQUIRED member of the create DTO. It was refused in the EMPLOYEE
    // request body for a different reason (a requester must not decide their own eligibility), and
    // this assertion is what stops that rule from being applied to a context it does not govern.
    expect(body.selfApprovalMode).toBe('ALLOWED');
    expect(body.routingMode).toBe('PARALLEL');
  });

  it('never posts a tenant, an actor, a project or the frozen completion mode', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId('hr-mission-definition-create-open'));
    await userEvent.type(screen.getByTestId('hr-mission-definition-new-name'), 'گردش ت');
    await userEvent.type(screen.getByLabelText(/عنوان مرحله/), 'مرحله');
    await userEvent.type(screen.getByLabelText(/شناسهٔ کارمند تأییدکننده/), APPROVER_ID);
    await userEvent.click(screen.getByTestId('hr-mission-definition-create-submit'));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    const serialised = JSON.stringify(createMock.mock.calls[0][0]);

    for (const forbidden of [
      'tenantId',
      'actorId',
      'approverId',
      'projectId',
      'project_id',
      // `parallelCompletionMode` is in the RESPONSE as a frozen `'ALL_REQUIRED'` and in NO request
      // DTO, so sending it would be asserting a rule the server owns.
      'parallelCompletionMode',
      '"id"',
      'createdAt',
      'updatedAt',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('does not offer a role-bound approver control', () => {
    // The DTO accepts `approverRole` and the response carries it, but the service REFUSES to open a
    // flow through a step that names no employee. This client has no contract mapping a role to the
    // people who hold it, so offering a role picker would invent manager-hierarchy resolution.
    //
    // The panel DOES assign the key once — inside `buildSteps`, and only beside an employee id, so a
    // stored role survives a replacement without ever being the assignment on its own. What must not
    // exist is a control that SETS it from nothing.
    expect(PANEL_SOURCE).not.toMatch(/setApproverRole|approverRole:\s*(event|value|''|"")/);
    expect(PANEL_SOURCE).not.toMatch(/label="نقش تأییدکننده"/);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('editing a definition', () => {
  it('sends the exact UpdateMissionApprovalDefinitionDto fields, and NOT the steps', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId(`hr-mission-definition-edit-${DEFINITION_ID}`));
    await userEvent.clear(screen.getByTestId(`hr-mission-definition-name-input-${DEFINITION_ID}`));
    await userEvent.type(
      screen.getByTestId(`hr-mission-definition-name-input-${DEFINITION_ID}`),
      'گردش اصلاح‌شده'
    );
    await userEvent.selectOptions(
      screen.getByTestId(`hr-mission-definition-status-input-${DEFINITION_ID}`),
      'INACTIVE'
    );
    await userEvent.click(
      screen.getByTestId(`hr-mission-definition-settings-save-${DEFINITION_ID}`)
    );

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock).toHaveBeenCalledWith(DEFINITION_ID, {
      name: 'گردش اصلاح‌شده',
      routingMode: 'SEQUENTIAL',
      selfApprovalMode: 'NOT_ALLOWED',
      status: 'INACTIVE',
    });

    // THE STEPS ARE NOT IN THE PATCH. They move through their own route because replacing a
    // definition's ordered steps is a different act from renaming it.
    expect(updateMock.mock.calls[0][1]).not.toHaveProperty('steps');
  });

  it('re-fetches the authoritative list after a successful edit', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);
    expect(listMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId(`hr-mission-definition-edit-${DEFINITION_ID}`));
    await userEvent.click(
      screen.getByTestId(`hr-mission-definition-settings-save-${DEFINITION_ID}`)
    );

    // The next state is whatever the server now returns. A client that patched its own copy would be
    // reporting its own guess.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('surfaces a rejected edit rather than reporting a save that did not happen', async () => {
    updateMock.mockRejectedValueOnce(new CoreApiError('ترتیب مراحل تکراری است.', 409));

    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId(`hr-mission-definition-edit-${DEFINITION_ID}`));
    await userEvent.click(
      screen.getByTestId(`hr-mission-definition-settings-save-${DEFINITION_ID}`)
    );

    expect(await screen.findByText('ترتیب مراحل تکراری است.')).toBeInTheDocument();
    // No re-fetch on failure: nothing changed, and a refresh would imply it had.
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

describe('replacing the steps', () => {
  it('presents the step route as a REPLACEMENT and says so before the save', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId(`hr-mission-definition-edit-steps-${DEFINITION_ID}`));

    expect(screen.getByTestId('hr-mission-steps-replacement-note')).toHaveTextContent(
      /جایگزین مراحل تعریف می‌شود/
    );
    // The consequence is stated, not implied: an omitted step is a REMOVED step.
    expect(screen.getByTestId('hr-mission-steps-replacement-note')).toHaveTextContent(/حذف می‌شود/);
  });

  it('seeds the editor from the server rows, so an untouched save preserves them', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId(`hr-mission-definition-edit-steps-${DEFINITION_ID}`));
    await userEvent.click(screen.getByTestId(`hr-mission-definition-steps-save-${DEFINITION_ID}`));

    await waitFor(() => expect(replaceStepsMock).toHaveBeenCalledTimes(1));
    expect(replaceStepsMock).toHaveBeenCalledWith(DEFINITION_ID, {
      name: 'گردش تأیید ماموریت',
      routingMode: 'SEQUENTIAL',
      selfApprovalMode: 'NOT_ALLOWED',
      steps: [
        {
          order: 1,
          name: 'تأیید مدیر مستقیم',
          approverEmployeeId: APPROVER_ID,
          required: true,
        },
      ],
    });
  });

  it('sends the WHOLE list, so a removed row is a removed step', async () => {
    listMock.mockResolvedValue({
      items: [
        missionApprovalDefinition({
          id: DEFINITION_ID,
          steps: [
            missionApprovalStep({ id: 'step-1', order: 1, name: 'مرحلهٔ اول' }),
            missionApprovalStep({ id: 'step-2', order: 2, name: 'مرحلهٔ دوم' }),
          ],
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId(`hr-mission-definition-edit-steps-${DEFINITION_ID}`));
    expect(screen.getAllByTestId(/^hr-mission-step-order-/)).toHaveLength(2);

    // Remove the first row. The route REPLACES the list, so omitting it is what deletes it — this is
    // the act an incremental "add a step" UI could not express, and the one it would perform by
    // accident.
    await userEvent.click(screen.getAllByTestId(/^hr-mission-step-remove-/)[0]);
    expect(screen.getAllByTestId(/^hr-mission-step-order-/)).toHaveLength(1);

    await userEvent.click(screen.getByTestId(`hr-mission-definition-steps-save-${DEFINITION_ID}`));

    await waitFor(() => expect(replaceStepsMock).toHaveBeenCalledTimes(1));
    const steps = replaceStepsMock.mock.calls[0][1].steps;
    // ONE step, and it is the SECOND: the payload is the whole new list rather than a patch naming
    // the row to drop.
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe('مرحلهٔ دوم');
  });
});

describe('approver resolution', () => {
  it('shows approverEmployeeId as the executable reference', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    expect(screen.getByTestId(`hr-mission-definition-step-approver-${STEP_ID}`)).toHaveTextContent(
      APPROVER_ID
    );
  });

  it('states a step with no employee as having NO executable approver', async () => {
    listMock.mockResolvedValue({
      items: [
        missionApprovalDefinition({
          id: DEFINITION_ID,
          steps: [
            missionApprovalStep({
              id: STEP_ID,
              approverEmployeeId: null,
              approverRole: 'HR_MANAGER',
            }),
          ],
        }),
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    // The executable reference is ABSENT, and the row says so rather than drawing an empty cell:
    // an empty cell reads as a missing relation while this is a configuration the flow refuses.
    expect(screen.getByTestId(`hr-mission-definition-step-approver-${STEP_ID}`)).toHaveTextContent(
      'بدون تأییدکنندهٔ اجرایی'
    );
    // The role is DISPLAYED because the response carries it, and labelled non-executable.
    expect(screen.getByTestId(`hr-mission-definition-step-role-${STEP_ID}`)).toHaveTextContent(
      /غیراجرایی/
    );
    expect(screen.getByTestId(`hr-mission-definition-step-role-${STEP_ID}`)).toHaveTextContent(
      'HR_MANAGER'
    );
  });

  it('refuses to save a step that names no approver employee', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId('hr-mission-definition-create-open'));
    await userEvent.type(
      screen.getByTestId('hr-mission-definition-new-name'),
      'گردش بی‌تأییدکننده'
    );
    await userEvent.type(screen.getByLabelText(/عنوان مرحله/), 'مرحله');

    // The DTO accepts a step with neither an employee nor a role, but the service refuses to open a
    // flow through one — so the form blocks it rather than letting a dead configuration be written.
    expect(screen.getByTestId('hr-mission-definition-create-submit')).toBeDisabled();
    expect(screen.getByTestId(/^hr-mission-step-problem-/)).toHaveTextContent(
      /هیچ تأییدکننده‌ای ندارد/
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  it('always carries the stored role BESIDE an employee, never instead of one', async () => {
    render(<MissionApprovalDefinitionPanel canWrite />);
    await screen.findByTestId(`hr-mission-definition-${DEFINITION_ID}`);

    await userEvent.click(screen.getByTestId(`hr-mission-definition-edit-steps-${DEFINITION_ID}`));
    await userEvent.click(screen.getByTestId(`hr-mission-definition-steps-save-${DEFINITION_ID}`));

    await waitFor(() => expect(replaceStepsMock).toHaveBeenCalledTimes(1));
    const step = replaceStepsMock.mock.calls[0][1].steps[0];
    // The stored role was `null` on this row, so it is OMITTED rather than sent as `null`: the DTO
    // marks it `@IsOptional() @IsString()`, and a present `null` is not a string.
    expect(step).not.toHaveProperty('approverRole');
    expect(step.approverEmployeeId).toBe(APPROVER_ID);
  });
});
/**
 * WHAT THIS PANEL MUST NOT DO — asserted against the source it actually ships.
 *
 * These are the step's own global prohibitions, and they are checked here rather than trusted because
 * each one is a single line away from being reintroduced: a `parallelCompletionMode` in a body, a
 * `tenantId` in a form, a `rules` field in a JSON editor. The scan reads EXECUTABLE source (comments
 * stripped), since this file and the panel legitimately DISCUSS these very concepts.
 */
describe('the banned vocabulary', () => {
  it('does not post a tenant, an actor, a project or a server-derived status', () => {
    expect(PANEL_SOURCE).not.toMatch(/tenantId/);
    expect(PANEL_SOURCE).not.toMatch(/actorId/);
    expect(PANEL_SOURCE).not.toMatch(/projectId/);
    expect(PANEL_SOURCE).not.toMatch(/project_id/);
    expect(PANEL_SOURCE).not.toMatch(/parallelCompletionMode\s*:/);
  });

  it('does not reproduce the approval engine or invent a manager hierarchy', () => {
    // No resolution, no traversal, no substitute lookup: the panel writes configuration and the
    // service decides what it means.
    expect(PANEL_SOURCE).not.toMatch(/resolvedApproverEmployeeId/);
    expect(PANEL_SOURCE).not.toMatch(/canDecide/);
    expect(PANEL_SOURCE).not.toMatch(/decidableByActor/);
    expect(PANEL_SOURCE).not.toMatch(/managerId/);
    expect(PANEL_SOURCE).not.toMatch(/reportsTo/);
  });

  it('reuses the shared Mission label utility rather than defining its own vocabulary', () => {
    // One status vocabulary across every Mission surface: a second local `Record<...>` of statuses
    // would let two screens disagree about what a DRAFT is.
    expect(PANEL_SOURCE).toContain('missionDefinitionStatusLabel');
    expect(PANEL_SOURCE).not.toMatch(
      /const\s+\w*STATUS_LABELS\s*:\s*Record<HrMissionDefinitionStatus/
    );
  });

  it('introduces no generic admin framework and no navigation', () => {
    expect(PANEL_SOURCE).not.toMatch(/SERVER_NAV_TARGETS|NAV_TARGETS|core-nav|nav-catalogue/);
    expect(PANEL_SOURCE).not.toMatch(/DataTable|CrudProvider|AdminResource/);
  });
});
