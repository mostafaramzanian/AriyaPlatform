import type {
  HrAttendance,
  HrCurrentAssignment,
  HrEmployee,
  HrEmployeeDetail,
  HrEmploymentRecord,
  HrLeaveRequest,
  HrLeaveType,
  HrOrganizationNode,
  HrOrganizationSummary,
  HrOrganizationTree,
  HrOrganizationUnit,
  HrPage,
  HrPosition,
} from '@/lib/hr-api';
import type {
  HrMissionApprovalDefinition,
  HrMissionApprovalStepDefinition,
  HrMissionOption,
  HrMissionOptionGroup,
  HrMissionPolicyVersion,
  HrMissionRequest,
} from '@/lib/hr-mission-api';
import type {
  MissionRuleAction,
  MissionRuleConditionNode,
  MissionRuleSetVersion,
} from '@/lib/mission-rule-set-version';

/**
 * Phase 51-HR-2B: deterministic HR fixtures for the component/view specs.
 *
 * EVERY VALUE IS INVENTED AND LIVES ONLY HERE. No fixture is imported by application
 * source (§20 forbids business fixtures inside React components), and the browser E2E never
 * reads these rows — it drives the real API against the isolated test database. These
 * builders exist so a spec can assert on a row whose unit, position and interval are known
 * to agree with each other, which is the part a hand-written literal gets wrong.
 *
 * `tenantId` is present because the API contract declares it, NOT because a screen may send
 * one; `hr-api.spec.ts` asserts that no request body ever carries it.
 */

export const TENANT = 'tenant-hr-2b';

/** The identifier every builder defaults to; a spec overrides it to build a second row. */
export const UNIT_IT = 'unit-1';
export const UNIT_SECOND = 'unit-2';
export const POS_ENGINEER = 'pos-1';
export const POS_SECOND = 'pos-2';

export function unit(overrides: Partial<HrOrganizationUnit> = {}): HrOrganizationUnit {
  return {
    id: UNIT_IT,
    tenantId: TENANT,
    code: 'U-100',
    name: 'فناوری اطلاعات',
    parentId: null,
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function node(overrides: Partial<HrOrganizationNode> = {}): HrOrganizationNode {
  const { children = [], ...rest } = overrides;
  const base = unit(rest);
  return { ...base, children };
}

export function tree(roots: HrOrganizationNode[] = [node()]): HrOrganizationTree {
  return { roots, total: roots.length };
}

export function summary(overrides: Partial<HrOrganizationSummary> = {}): HrOrganizationSummary {
  return {
    units: 4,
    activeUnits: 3,
    positions: 7,
    activePositions: 6,
    employees: 12,
    activeEmployees: 11,
    ...overrides,
  };
}

export function position(overrides: Partial<HrPosition> = {}): HrPosition {
  return {
    id: POS_ENGINEER,
    tenantId: TENANT,
    organizationUnitId: UNIT_IT,
    code: 'POS-100',
    title: 'کارشناس ارشد نرم‌افزار',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    organizationUnit: { id: UNIT_IT, code: 'U-100', name: 'فناوری اطلاعات' },
    ...overrides,
  };
}

export function interval(overrides: Partial<HrEmploymentRecord> = {}): HrEmploymentRecord {
  return {
    id: 'rec-1',
    employeeId: 'emp-1',
    tenantId: TENANT,
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    startDate: '2026-01-01',
    endDate: null,
    organizationUnitId: UNIT_IT,
    positionId: POS_ENGINEER,
    managerEmployeeId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function assignment(overrides: Partial<HrCurrentAssignment> = {}): HrCurrentAssignment {
  return {
    id: 'rec-1',
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    startDate: '2026-01-01',
    organizationUnitId: UNIT_IT,
    positionId: POS_ENGINEER,
    managerEmployeeId: null,
    organizationUnit: { id: UNIT_IT, code: 'IT', name: 'فناوری اطلاعات' },
    position: { id: POS_ENGINEER, code: 'ENG-2', title: 'کارشناس ارشد نرم‌افزار' },
    ...overrides,
  };
}

export function employee(overrides: Partial<HrEmployee> = {}): HrEmployee {
  return {
    id: 'emp-1',
    tenantId: TENANT,
    userId: null,
    employeeCode: 'E-1042',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    identity: {
      id: 'user-1',
      firstName: 'بهار',
      lastName: 'نوری',
      avatarUrl: null,
      jobTitle: 'کارشناس ارشد نرم‌افزار',
      department: 'فناوری اطلاعات',
    },
    currentAssignment: assignment(),
    ...overrides,
  };
}

export function employeeDetail(overrides: Partial<HrEmployeeDetail> = {}): HrEmployeeDetail {
  return { ...employee(), employmentHistory: [interval()], ...overrides };
}

/** A page envelope, shaped exactly like `HrPage<T>`. */
export function page<T>(items: T[], total = items.length): HrPage<T> {
  return { items, total, page: 1, pageSize: 20 };
}

/**
 * Phase 55 Step 8B: ONE mission option group, with its options.
 *
 * `required` is the catalogue's own flag — the flag drives the form's completeness rule and the
 * server re-validates it, so a fixture that set it wrongly would let a spec pass on a form the
 * backend would refuse.
 */
export function missionOptionGroup(
  overrides: Partial<HrMissionOptionGroup> = {}
): HrMissionOptionGroup {
  return {
    id: 'grp-duration',
    code: 'DURATION',
    label: 'مدت ماموریت',
    required: true,
    sortOrder: 1,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    options: [missionOption()],
    ...overrides,
  };
}

/** One option inside a group. `active: false` is an option the form must not offer. */
export function missionOption(overrides: Partial<HrMissionOption> = {}): HrMissionOption {
  return {
    id: 'opt-daily',
    optionGroupId: 'grp-duration',
    code: 'DAILY',
    label: 'روزانه',
    active: true,
    sortOrder: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Phase 55 Step 8D: ONE approval-definition STEP.
 *
 * `approverEmployeeId` DEFAULTS TO A CONCRETE EMPLOYEE because that is the ONLY executable approver
 * reference: a step with `approverEmployeeId: null` is one `mission-approval.service.ts` refuses to
 * open a flow through. A spec that wants the non-executable shape overrides it to `null` explicitly,
 * which is why the default is the working one.
 *
 * `approverRole` IS `null` BY DEFAULT. The DTO accepts a role but the server does not execute a
 * role-only step, so a fixture that populated it by default would make every definition look
 * partly non-executable when the screen's normal case is not.
 */
export function missionApprovalStepDefinition(
  overrides: Partial<HrMissionApprovalStepDefinition> = {}
): HrMissionApprovalStepDefinition {
  return {
    id: 'step-1',
    approvalDefinitionId: 'def-1',
    order: 1,
    name: 'تأیید مدیر مستقیم',
    approverEmployeeId: 'emp-mgr-1',
    approverRole: null,
    required: true,
    ...overrides,
  };
}

/**
 * Phase 55 Step 8D: ONE mission approval STEP definition.
 *
 * `approverEmployeeId` DEFAULTS TO A REAL ID because that is the only EXECUTABLE state:
 * `mission-approval.service.ts` refuses to open a flow through a step that names no employee, so a
 * fixture defaulting to `null` would build a step the server will not route — and a spec overriding
 * only what it is about would then be proving behaviour on an unrunnable row.
 *
 * `approverRole` defaults to `null` and is NOT derived from the employee. A role is a separate,
 * stored fact that resolves nothing, and a fixture that filled it in would quietly suggest the two
 * are interchangeable.
 */
export function missionApprovalStep(
  overrides: Partial<HrMissionApprovalStepDefinition> = {}
): HrMissionApprovalStepDefinition {
  return {
    id: 'step-1',
    approvalDefinitionId: 'def-1',
    order: 1,
    name: 'تأیید مدیر مستقیم',
    approverEmployeeId: '11111111-1111-4111-8111-111111111111',
    approverRole: null,
    required: true,
    ...overrides,
  };
}

/**
 * Phase 55 Step 8D: ONE mission approval DEFINITION, with its ordered steps.
 *
 * `parallelCompletionMode` IS `'ALL_REQUIRED'` AND IS NOT PARAMETERISED BY ANYTHING: the response
 * type declares exactly that one literal because it is the only completion mode the backend honours,
 * and it appears in no request DTO. Overriding it is therefore impossible by type, which is the
 * point — a fixture cannot invent a second completion mode for a screen to render.
 */
export function missionApprovalDefinition(
  overrides: Partial<HrMissionApprovalDefinition> = {}
): HrMissionApprovalDefinition {
  return {
    id: 'def-1',
    name: 'گردش تأیید ماموریت',
    status: 'ACTIVE',
    routingMode: 'SEQUENTIAL',
    parallelCompletionMode: 'ALL_REQUIRED',
    selfApprovalMode: 'NOT_ALLOWED',
    steps: [missionApprovalStep()],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Phase 55 Step 8D: ONE Mission rule-set version.
 *
 * `configuration` IS A REAL `MissionRuleSetVersion`, and that is the point of the contract closure: the
 * shape is the Rule Engine's own declaration (`apps/api/src/rules/rule-spec.interface.ts`), stored and
 * returned verbatim, so the fixture spells a document the server's validator would ACCEPT rather than
 * an opaque blob. The three facts it declares are the three the Mission engine is given
 * (`durationMode`, `locationType`, `engagementType`), which is what makes the fixture usable as a
 * document a spec could actually post.
 *
 * `actions` is stated per status rather than defaulted to all-false, because a fixture whose flags
 * contradicted its own `status` would let a screen appear to honour the server while ignoring it.
 */
export function missionPolicyVersion(
  overrides: Partial<HrMissionPolicyVersion> = {}
): HrMissionPolicyVersion {
  return {
    id: 'pv-1',
    version: 1,
    status: 'DRAFT',
    ruleSetId: 'hr.mission.approval',
    configuration: missionRuleSetVersion(),
    publishedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    // `DRAFT` is the state `validateVersion` accepts, and the fixture's default status.
    actions: { canValidate: true, canPublish: false, canArchive: false },
    ...overrides,
  };
}

/**
 * Phase 55 contract closure: ONE Mission rule-set document, spelled the way the SERVER spells it.
 *
 * WHY THIS IS A SHARED FIXTURE AND NOT A LITERAL IN EACH SPEC
 * ----------------------------------------------------------
 * `configuration` is the Rule Engine's `RuleSetVersion`. Three specs need a document that the server's
 * validator would actually ACCEPT — the fixture above, the API-client spec and the configuration
 * screen — and three hand-written copies would drift until one of them described a document the server
 * refuses. One builder, used by all three, is the only version of this that stays true.
 *
 * THE DOCUMENT IS MINIMAL BUT VALID, NOT MINIMAL BY ACCIDENT:
 *   * `schemaVersion: 1` is the only schema version this engine implements (`RULE_ENGINE_SCHEMA_VERSION`);
 *   * `fields` declares exactly the three facts `mission-options.ts` gives the Mission engine, and
 *     `durationMode` is an `enum` because the three facts are closed token vocabularies;
 *   * the rule MATCHES ALL THREE facts explicitly rather than relying on an empty condition, so the
 *     fixture demonstrates a rule whose outcome a reader can verify by eye;
 *   * `REQUIRED_APPROVAL_STEP.approverRuleRef` carries the `mission-approval-definition:<id>` form
 *     `MissionPolicyService.parseApprovalDefinitionId` requires — any other form is a `409` at runtime.
 */
export function missionRuleSetVersion(
  overrides: Partial<MissionRuleSetVersion> = {}
): MissionRuleSetVersion {
  return {
    ruleSetId: 'hr.mission.approval',
    version: '1',
    status: 'DRAFT',
    schemaVersion: 1,
    fields: [
      { name: 'durationMode', type: 'enum', enumValues: ['HOURLY', 'DAILY'] },
      { name: 'locationType', type: 'enum', enumValues: ['IN_CITY', 'OUT_OF_CITY'] },
      { name: 'engagementType', type: 'enum', enumValues: ['PROJECT', 'NON_PROJECT'] },
    ],
    rules: [
      {
        id: 'mission-requires-approval',
        version: '1',
        name: 'ماموریت روزانه نیازمند تأیید است',
        priority: 10,
        condition: {
          all: [
            { field: 'durationMode', op: 'equals', value: 'DAILY' },
            { field: 'locationType', op: 'equals', value: 'OUT_OF_CITY' },
          ],
        },
        actions: [
          {
            type: 'REQUIRED_APPROVAL_STEP',
            stepOrder: 1,
            approverRuleRef: 'mission-approval-definition:8f14e45f-ceea-467a-9a3f-1c0b1d2e3f40',
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Phase 55 Step 8D-P: the Rule Engine's own two closed unions, one fixture each
// ---------------------------------------------------------------------------

/**
 * EVERY condition-node variant the engine declares, in the order the interface lists them.
 *
 * WHY A FIXTURE RATHER THAN A LITERAL IN EACH SPEC. A spec that claims \"the editor can represent
 * conditions\" is only meaningful if it can be handed a document containing ALL FIVE node kinds — and
 * two hand-written copies of that document (one here, one in the spec) drift until one describes a
 * document no server would accept. The list below IS the closed set, so a sixth node kind added to
 * the engine shows up as a single place to extend rather than as a silently-passing spec.
 *
 * `field` appears in its TWO operand forms — a scalar against a declared `enum` fact, and an array for
 * a membership operator — because `RuleConditionOperand` permits both and the editor renders each
 * differently. `count.where` is populated for the same reason: it is an OPTIONAL nested array, and a
 * fixture that omitted it would let an editor drop it without any spec noticing.
 */
export function missionRuleConditionNodes(): MissionRuleConditionNode[] {
  return [
    {
      all: [
        { field: 'durationMode', op: 'equals', value: 'DAILY' },
        { field: 'locationType', op: 'in', value: ['IN_CITY', 'OUT_OF_CITY'] },
        { field: 'engagementType', op: 'isNotEmpty' },
      ],
    },
    {
      any: [
        { field: 'durationMode', op: 'notEquals', value: 'HOURLY' },
        { field: 'engagementType', op: 'notIn', value: ['PROJECT'] },
      ],
    },
    { not: { field: 'locationType', op: 'isEmpty' } },
    {
      count: {
        over: 'missionDays',
        where: [{ field: 'locationType', op: 'equals', value: 'OUT_OF_CITY' }],
        op: 'greaterThan',
        value: 2,
      },
    },
  ];
}

/**
 * ALL SEVEN frozen action types, one instance each, with every required field present.
 *
 * THE POINT OF THIS FIXTURE IS COMPLETENESS. The editor renders an action by its `type`, so the only
 * way a spec can prove that all seven are represented — and that none is invented — is to hand it a
 * document containing exactly the seven and then assert each one came back out. `RULE_ACTION_TYPES` on
 * the server has no eighth member, so a fixture with eight would be describable only by a server that
 * does not exist.
 *
 * The field values are chosen to be DIFFERENT from one another (`stepOrder` 1 and 2, two distinct
 * `approverRuleRef` prefixes, two `reasonCode`s) so an editor that collapsed two variants into one row
 * could not pass by rendering the same text twice.
 */
export function missionRuleActions(): MissionRuleAction[] {
  return [
    {
      type: 'REQUIRED_APPROVAL_STEP',
      stepOrder: 1,
      approverRuleRef: 'mission-approval-definition:8f14e45f-ceea-467a-9a3f-1c0b1d2e3f40',
    },
    { type: 'AUTO_APPROVE' },
    { type: 'AUTO_REJECT', reasonCode: 'MISSION_LIMIT_EXCEEDED' },
    {
      type: 'LIMIT_REFUSAL',
      limitRef: 'mission-days-per-year',
      countingBasis: 'DAY_COUNT',
      maximum: 30,
      windowStart: '2026-01-01',
      windowEnd: '2026-12-31',
    },
    { type: 'STEP_ACTIVATION', stepOrder: 2 },
    {
      type: 'APPROVER_RESOLUTION',
      approverRuleRef: 'mission-approval-definition:9c1f2ab3-1111-4a2b-8c3d-4e5f60718293',
      resolutionReason: 'PRIMARY',
    },
    {
      type: 'NOTIFY',
      templateRef: 'mission-approval-requested',
      recipientRole: 'MANAGER',
    },
  ];
}

/**
 * ONE condition tree that NESTS, so a renderer's recursion is provable rather than assumed.
 *
 * `missionRuleConditionNodes()` returns each kind at the TOP level, which a non-recursive renderer could
 * pass simply by rendering five sibling rows. This fixture puts `count` and `field` INSIDE an `all`, and
 * an `any` inside a `not`, so a renderer that reads only the root node would lose them — and the census
 * helper's counts (which descend into `all`/`any`/`not`/`count.where`) could not be reproduced by a
 * shallow walk either.
 *
 * THREE `field` LEAVES ARE PRESENT ON PURPOSE — one under `all`, one under `not.any`, and one inside
 * `count.where` — because the count is what a reader checks, and distinct nested positions are what makes
 * a wrong recursion depth visible.
 */
export function nestedMissionRuleCondition(): MissionRuleConditionNode {
  return {
    not: {
      any: [
        { field: 'engagementType', op: 'equals', value: 'NON_PROJECT' },
        {
          all: [
            { field: 'durationMode', op: 'equals', value: 'HOURLY' },
            {
              count: {
                over: 'missionDays',
                where: [{ field: 'locationType', op: 'equals', value: 'IN_CITY' }],
                op: 'greaterThanOrEqual',
                value: 3,
              },
            },
          ],
        },
      ],
    },
  };
}

/**
 * Phase 55 Step 8B: one mission REQUEST.
 *
 * THE DEFAULTS ARE A `DRAFT` DAILY MISSION whose range is a single inclusive day, because that is
 * the state every write predicate treats as eligible — a spec that overrides only the fields it is
 * about therefore still builds a request the screen can act on.
 *
 * `durationMode`, `locationType` and `engagementType` are present because the SERVER serialises its
 * own reading of `selections`; a fixture must carry them too, or a spec would prove the screen
 * classifies rather than reads.
 */
export function missionRequest(overrides: Partial<HrMissionRequest> = {}): HrMissionRequest {
  return {
    id: 'mis-1',
    status: 'DRAFT',
    submittedRevision: null,
    employee: { id: 'emp-1', employeeCode: 'E-1042' },
    durationMode: 'DAILY',
    locationType: 'IN_CITY',
    engagementType: 'NON_PROJECT',
    startDate: '2026-09-18',
    endDate: '2026-09-18',
    startTime: null,
    endTime: null,
    destination: 'اداره کل',
    description: 'شرکت در جلسه',
    correctionReason: null,
    rejectionReason: null,
    selections: [{ optionGroupId: 'grp-duration', missionOptionId: 'opt-daily' }],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Phase 51-HR-2E: one register row.
 *
 * THE DEFAULTS ARE A CLOSED `DEVICE` DAY, and every field the API derives is spelled the
 * way the API spells it: `workDate` is a DATE (`2026-09-18`, not an instant), `dateKey` is
 * the matching Jalali day, and `clockIn`/`clockOut` are INSTANTS with an explicit offset.
 * A spec that overrides only what it is about therefore still renders a coherent row — and
 * a helper that leaked an ISO midnight into `workDate` would be caught by the row specs
 * rather than hidden here.
 *
 * 2026-09-18 is a Friday (and 1405/06/27), so the weekday assertion has a known answer.
 */
export function attendance(overrides: Partial<HrAttendance> = {}): HrAttendance {
  return {
    id: 'att-1',
    tenantId: TENANT,
    employeeId: 'emp-1',
    workDate: '2026-09-18',
    dateKey: '1405/06/27',
    clockIn: '2026-09-18T08:00:00+03:30',
    clockOut: '2026-09-18T17:00:00+03:30',
    source: 'DEVICE',
    reason: null,
    createdAt: '2026-09-18T17:00:05.000Z',
    updatedAt: '2026-09-18T17:00:05.000Z',
    employee: { id: 'emp-1', employeeCode: 'E-1042' },
    ...overrides,
  };
}

/**
 * Phase 51-HR-3A: one entry of a tenant's OWN leave catalogue.
 *
 * NOTHING IS SEEDED SERVER-SIDE, so this builder is the only place a leave kind exists until a
 * spec creates one: `code` is per-tenant unique and `status` is a LIFECYCLE (`ACTIVE` /
 * `INACTIVE`), never a delete — a type that has been requested cannot be removed from under its
 * own history (`ON DELETE RESTRICT`).
 */
export function leaveType(overrides: Partial<HrLeaveType> = {}): HrLeaveType {
  return {
    id: 'lt-1',
    tenantId: TENANT,
    code: 'ANNUAL',
    name: 'مرخصی استحقاقی',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Phase 51-HR-3A: one register row.
 *
 * THE DEFAULTS SPELL THE CONTRACT THE API SPELLS: `startDate`/`endDate` are `YYYY-MM-DD` DAYS
 * (inclusive at BOTH ends — a `@db.Date` column is a calendar day and never an instant),
 * `status` has only the two members the domain declares, and `cancelledAt` is `null` on a
 * standing request. There is deliberately NO decision field, NO duration, NO balance and NO
 * `cancellationReason` here, because the wire contract has none: a fixture that carried one
 * would let a spec assert a value no server can produce.
 *
 * 2026-09-20 → 2026-09-22 is 1405/06/29 → 1405/06/31, a known three-day Jalali period.
 * `cancelledAt` is an INSTANT with an offset, the form the API stamps a withdrawal in.
 */
export function leaveRequest(overrides: Partial<HrLeaveRequest> = {}): HrLeaveRequest {
  return {
    id: 'lr-1',
    tenantId: TENANT,
    employeeId: 'emp-1',
    leaveTypeId: 'lt-1',
    startDate: '2026-09-20',
    endDate: '2026-09-22',
    reason: 'سفر خانوادگی',
    status: 'PENDING',
    cancelledAt: null,
    createdAt: '2026-09-10T06:00:00.000Z',
    updatedAt: '2026-09-10T06:00:00.000Z',
    employee: { id: 'emp-1', employeeCode: 'E-1042' },
    leaveType: { id: 'lt-1', code: 'ANNUAL', name: 'مرخصی استحقاقی', status: 'ACTIVE' },
    ...overrides,
  };
}
