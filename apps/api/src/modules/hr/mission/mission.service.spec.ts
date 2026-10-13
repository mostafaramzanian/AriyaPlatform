import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MissionService } from './mission.service';
import { MissionApprovalService } from './mission-approval.service';
import type { MissionRepository } from './mission.repository';
import type { MissionApprovalRepository } from './mission-approval.repository';
import type { LeaveApprovalRepository } from '../leave/leave-approval.repository';
import type { MissionPolicyService } from './mission-policy.service';
import type { EmployeeRepository } from '../employees/employees.repository';
import type { HrAuditGateway } from '../hr-audit.gateway';
import type { HrNotificationGateway } from '../hr-notification.gateway';
import { HR_DEFAULT_PAGE_SIZE, HR_MAX_PAGE_SIZE } from '../hr.constants';
import { HrActor } from '../hr-actor';

function option(id: string, code: string, groupId: string) {
  return {
    id,
    code,
    label: code,
    active: true,
    sortOrder: 0,
    optionGroupId: groupId,
    tenantId: 't1',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('55 — MissionService (application layer smoke)', () => {
  const actor: HrActor = {
    tenantId: 't1',
    userId: 'u1',
    requestId: 'r1',
    correlationId: 'c1',
    ip: '127.0.0.1',
    userAgent: 'jest',
  };

  const groups = [
    {
      id: 'g-duration',
      code: 'DURATION',
      label: 'Duration',
      required: true,
      active: true,
      sortOrder: 0,
      options: [option('o-daily', 'DAILY', 'g-duration')],
    },
    {
      id: 'g-location',
      code: 'LOCATION',
      label: 'Location',
      required: true,
      active: true,
      sortOrder: 1,
      options: [option('o-in-city', 'IN_CITY', 'g-location')],
    },
    {
      id: 'g-engagement',
      code: 'ENGAGEMENT',
      label: 'Engagement',
      required: true,
      active: true,
      sortOrder: 2,
      options: [option('o-non-project', 'NON_PROJECT', 'g-engagement')],
    },
  ];

  const selections = [
    { optionGroupId: 'g-duration', missionOptionId: 'o-daily' },
    { optionGroupId: 'g-location', missionOptionId: 'o-in-city' },
    { optionGroupId: 'g-engagement', missionOptionId: 'o-non-project' },
  ];

  const employee = { id: 'e1', employeeCode: 'E001', userId: 'u1' };
  const draftRequest = {
    id: 'mr1',
    tenantId: 't1',
    employeeId: employee.id,
    status: 'DRAFT',
    submittedRevision: 0,
    durationMode: 'DAILY',
    locationType: 'IN_CITY',
    engagementType: 'NON_PROJECT',
    startDate: new Date('2026-10-01T00:00:00.000Z'),
    endDate: new Date('2026-10-02T00:00:00.000Z'),
    startTime: null,
    endTime: null,
    destination: null,
    description: null,
    employee,
    optionSelections: selections,
    approvalInstances: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const inApprovalRequest = { ...draftRequest, status: 'IN_APPROVAL' };
  const approvedRequest = { ...draftRequest, status: 'APPROVED' };

  let service: MissionService;
  let missionRepo: Record<string, jest.Mock>;
  let approvalRepo: Record<string, jest.Mock>;
  let approvals: { prepareInstanceSteps: unknown };
  let policy: { resolveDecision: jest.Mock };
  let employees: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let notifications: Record<string, jest.Mock>;

  beforeEach(() => {
    missionRepo = {
      listOptionGroupPage: jest.fn().mockResolvedValue([groups, 3]),
      createRequest: jest.fn().mockResolvedValue(draftRequest),
      replaceOptionSelections: jest.fn().mockResolvedValue(undefined),
      findRequestById: jest.fn().mockResolvedValue(draftRequest),
      markSubmitted: jest.fn().mockResolvedValue({ ...draftRequest, status: 'SUBMITTED' }),
      markInApproval: jest.fn().mockResolvedValue(inApprovalRequest),
      markApproved: jest.fn().mockResolvedValue(approvedRequest),
      markRejected: jest.fn().mockResolvedValue({ ...draftRequest, status: 'REJECTED' }),
      submitAndAutoApprove: jest.fn().mockResolvedValue(undefined),
      submitAndAutoReject: jest.fn().mockResolvedValue(undefined),
      markInApprovalDurable: jest.fn().mockResolvedValue(undefined),
      listRequestPage: jest.fn().mockResolvedValue([[draftRequest], 1]),
      updateRequest: jest.fn().mockResolvedValue(draftRequest),
    };
    approvalRepo = {
      findDefinitionById: jest.fn().mockResolvedValue({
        id: 'def1',
        tenantId: 't1',
        name: 'Sequential',
        routingMode: 'SEQUENTIAL',
        parallelCompletionMode: 'ALL_REQUIRED',
        selfApprovalMode: 'NOT_ALLOWED',
        steps: [
          {
            id: 'sd1',
            order: 1,
            name: 'Manager',
            approverEmployeeId: 'e2',
            approverRole: null,
            required: true,
          },
        ],
      }),
      openInstance: jest.fn().mockResolvedValue({
        id: 'inst1',
        tenantId: 't1',
        missionRequestId: 'mr1',
        sequenceNumber: 1,
        status: 'ACTIVE',
        routingMode: 'SEQUENTIAL',
        steps: [
          {
            order: 1,
            status: 'ACTIVE',
            resolvedApproverEmployeeId: 'e2',
            resolutionReason: 'PRIMARY',
          },
        ],
      }),
    };
    approvals = {
      prepareInstanceSteps: jest.fn().mockResolvedValue([
        {
          approvalStepDefinitionId: 'sd1',
          order: 1,
          resolvedApproverEmployeeId: 'e2',
          resolutionReason: 'PRIMARY',
          resolutionSignal: null,
        },
      ]),
    };
    policy = {
      resolveDecision: jest.fn().mockResolvedValue({
        kind: 'REQUIRED_APPROVAL',
        approvalDefinitionId: 'def1',
        versionLabel: 'v1',
      }),
    };
    employees = {
      findById: jest.fn().mockResolvedValue(employee),
      findByIdentityUserId: jest.fn().mockResolvedValue(employee),
    };
    audit = {
      record: jest.fn().mockResolvedValue(undefined),
      buildOutboxPayload: jest.fn().mockReturnValue({
        tenantId: 't1',
        auditId: 'mock-audit-id',
        payload: {},
      }),
    };
    notifications = {
      notifySubmitted: jest.fn().mockResolvedValue(undefined),
      notifyApproved: jest.fn().mockResolvedValue(undefined),
    };

    service = new MissionService(
      missionRepo as unknown as MissionRepository,
      approvalRepo as unknown as MissionApprovalRepository,
      approvals as unknown as MissionApprovalService,
      policy as unknown as MissionPolicyService,
      employees as unknown as EmployeeRepository,
      audit as unknown as HrAuditGateway,
      notifications as unknown as HrNotificationGateway
    );
  });

  it('creates a DRAFT request and replaces option selections', async () => {
    const dto = {
      employeeId: employee.id,
      selections,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      destination: 'Tehran office',
      description: 'Client visit',
    };
    const result = await service.create(actor, dto);
    expect(missionRepo.createRequest).toHaveBeenCalled();
    expect(missionRepo.replaceOptionSelections).toHaveBeenCalledWith('t1', 'mr1', selections);
    expect(audit.record).toHaveBeenCalled();
    expect(result.status).toBe('DRAFT');
  });

  it('submits a DRAFT and opens an approval instance', async () => {
    // Phase B2.5: the durable path calls markSubmitted then markInApprovalDurable (no
    // intermediate refresh). The second findRequestById call is the refresh() AFTER the
    // durable commit, so it returns the IN_APPROVAL state directly.
    missionRepo.findRequestById = jest
      .fn()
      .mockResolvedValueOnce(draftRequest)
      .mockResolvedValueOnce(inApprovalRequest);
    const result = await service.submit(actor, 'mr1');
    expect(missionRepo.markSubmitted).toHaveBeenCalledWith('t1', 'mr1', 1);
    expect(approvals.prepareInstanceSteps).toHaveBeenCalled();
    expect(approvalRepo.openInstance).toHaveBeenCalled();
    expect(notifications.notifySubmitted).toHaveBeenCalled();
    expect(result.status).toBe('IN_APPROVAL');
  });

  it('auto-approves when policy says AUTO_APPROVE', async () => {
    policy.resolveDecision = jest
      .fn()
      .mockResolvedValue({ kind: 'AUTO_APPROVE', versionLabel: 'v1' });
    // Phase B2.5: the durable path calls submitAndAutoApprove (no intermediate refresh
    // after markSubmitted). The second findRequestById is the refresh() after the durable
    // commit — it returns APPROVED directly.
    missionRepo.findRequestById = jest
      .fn()
      .mockResolvedValueOnce(draftRequest)
      .mockResolvedValueOnce(approvedRequest);
    const result = await service.submit(actor, 'mr1');
    expect(result.status).toBe('APPROVED');
  });

  /**
   * Phase 55: ONLY a concrete `approverEmployeeId` can produce an executable Mission approval flow.
   *
   * `approverRole` exists on `MissionApprovalDefinitionStep` because the schema mirrors the leave
   * configuration, which DOES resolve a role to a person. Mission deliberately does not: there is no
   * role resolver, and none may be added here — inventing one would mean a step whose approver is
   * decided at submit time by whoever happens to hold a role, which is exactly the authority the
   * `resolvedApproverEmployeeId` column exists to make checkable.
   *
   * So the failing direction must be a REFUSAL, and it must happen BEFORE anything is recorded as
   * submitted or opened. A flow that opened with a null approver would be worse than a refusal: the
   * request would sit IN_APPROVAL with no one able to decide it, which no later read can repair.
   */
  it('refuses a role-only approver step instead of inventing a resolver, and opens no flow', async () => {
    // The step names a ROLE and no employee — the shape the schema allows and Mission cannot honor.
    approvalRepo.findDefinitionById = jest.fn().mockResolvedValue({
      id: 'def1',
      tenantId: 't1',
      name: 'Role-based',
      routingMode: 'SEQUENTIAL',
      parallelCompletionMode: 'ALL_REQUIRED',
      selfApprovalMode: 'NOT_ALLOWED',
      steps: [
        {
          id: 'sd1',
          order: 1,
          name: 'Any HR manager',
          approverEmployeeId: null,
          approverRole: 'HR_MANAGER',
          required: true,
        },
      ],
    });
    // The real refusal, from the real service: this is what `MissionApprovalService` does when a
    // step carries a role and no employee id, and the test drives it rather than restating it.
    const realApprovals = new MissionApprovalService(
      { listEffectiveSubstitutions: jest.fn().mockResolvedValue([]) } as unknown as MissionApprovalRepository,
      { listEffectiveSubstitutions: jest.fn().mockResolvedValue([]) } as unknown as LeaveApprovalRepository,
      missionRepo as unknown as MissionRepository,
      employees as unknown as EmployeeRepository,
      audit as unknown as HrAuditGateway,
      notifications as unknown as HrNotificationGateway
    );
    approvals.prepareInstanceSteps = realApprovals.prepareInstanceSteps.bind(realApprovals);

    missionRepo.findRequestById = jest
      .fn()
      .mockResolvedValueOnce(draftRequest)
      .mockResolvedValueOnce({ ...draftRequest, status: 'SUBMITTED' });

    await expect(service.submit(actor, 'mr1')).rejects.toThrow(
      /Role-based approver resolution is not available for Mission/
    );

    // NOTHING WAS OPENED, and no instance was written: the refusal is total rather than partial.
    expect(approvalRepo.openInstance).not.toHaveBeenCalled();
    expect(missionRepo.markInApproval).not.toHaveBeenCalled();
    expect(notifications.notifySubmitted).not.toHaveBeenCalled();
  });

  /**
   * Phase 55 (§49): every Mission mutating act reaches the ONE platform audit trail, through the
   * gateway and through the CONSTANTS — never a literal.
   *
   * WHY THIS IS ASSERTED HERE AND NOT IN `hr-isolation.spec.ts`. That guard's audit rule is a
   * per-file FLOOR of three `this.audit.record(` call sites, applied to a curated list of services
   * whose shape happens to be one call per act. `mission-approval.service.ts` records all three of
   * its decisions (approve, reject, correction) from ONE call site whose `action` is chosen by the
   * branch — a correct shape, and one the floor cannot describe. Naming it there would have meant
   * lowering the floor for every other service, which is weakening a guard rather than extending it.
   *
   * So the Mission rule is stated where it is true: all three services are wired to the gateway
   * (no service owns a second audit path), and the resource/action strings they write are the ones
   * `hr.constants.ts` declares — the same values `mission-approval.service.ts` branches between.
   */
  it('records every Mission act through the gateway using the declared audit constants', () => {
    const dir = __dirname;
    const sources = [
      'mission.service.ts',
      'mission-approval.service.ts',
      'mission-policy.service.ts',
    ].map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));

    // EVERY Mission service writes through the gateway, and none reaches past it to the platform
    // audit seam — the second answer to "which tenant, which event identity" this rejects.
    const unwired = sources
      .filter(
        ({ text }) =>
          !text.includes("from '../hr-audit.gateway'") ||
          !text.includes('private readonly audit: HrAuditGateway')
      )
      .map(({ file }) => file);
    expect(unwired).toEqual([]);

    // Phase B2.5: durable-required services may use `this.audit.buildOutboxPayload(` instead
    // of `this.audit.record(`. Both are legitimate audit surfaces from the gateway.
    const recordless = sources
      .filter(({ text }) =>
        !/this\.audit\.record\(/.test(text) && !/this\.audit\.buildOutboxPayload\(/.test(text)
      )
      .map(({ file }) => file);
    expect(recordless).toEqual([]);

    const pastTheGateway = sources
      .filter(({ text }) => /platform\/audit\/audit\.contract|common\/audit\.service/.test(text))
      .map(({ file }) => file);
    expect(pastTheGateway).toEqual([]);

    // The audit vocabulary is the constants', not literals: EVERY record names its resource through
    // `HR_AUDIT_RESOURCE` (one constant per call, so the counts must match exactly), and no record
    // anywhere spells an action or resource as a string.
    //
    // `action:` is NOT counted against `records`, deliberately. Two of the three services choose the
    // action by BRANCH rather than naming it inline — `mission-approval.service.ts`'s single call
    // resolves approve/reject/correction in a nested ternary, and `mission.service.ts` has one call
    // that resolves resubmit-or-submit the same way. A count equality there would fail on a correct
    // implementation and its only "fix" would be to flatten a decision into duplication. What is
    // asserted instead is that every action constant used is FROM the catalogue, and that none is a
    // literal.
    for (const { file, text } of sources) {
      // Phase B2.5: durable events use `buildOutboxPayload` instead of `record`. Both are
      // legitimate audit surfaces and both name their resource through `HR_AUDIT_RESOURCE`.
      const bestEffort = text.match(/this\.audit\.record\(/g) ?? [];
      const durable = text.match(/this\.audit\.buildOutboxPayload\(/g) ?? [];
      const records = [...bestEffort, ...durable];
      const resources = text.match(/resource: HR_AUDIT_RESOURCE\.\w+/g) ?? [];
      expect({ file, records: records.length, resources: resources.length }).toEqual({
        file,
        records: resources.length,
        resources: records.length,
      });
      // No inline string for either column, anywhere — the constants are the only vocabulary.
      expect(text).not.toMatch(/resource:\s*['"]/);
      expect(text).not.toMatch(/action:\s*['"]/);
    }

    // EVERY action constant the three services write is declared in `HR_AUDIT_ACTION`, so a branch
    // cannot introduce a vocabulary of its own. The four decision actions §49 requires Mission to
    // distinguish — a submission, a resubmission, a decision and a post-decision correction — are
    // each present, which is what makes the trail answer "was this approved or corrected?".
    const constants = readFileSync(join(__dirname, '..', 'hr.constants.ts'), 'utf8');
    const actions = new Set<string>();
    for (const { text } of sources) {
      for (const match of text.matchAll(/HR_AUDIT_ACTION\.(\w+)/g)) {
        actions.add(match[1]);
      }
    }
    const undeclared = [...actions].filter(
      (name) => !new RegExp(`^\\s+${name}:\\s`, 'm').test(constants)
    );
    expect(undeclared).toEqual([]);
    for (const required of ['SUBMIT', 'RESUBMIT', 'APPROVE', 'REJECT', 'CORRECTION']) {
      expect([...actions]).toContain(required);
    }

    // THE RESOURCES ARE THE FOUR DECLARED, and no fifth: a Mission act written under, say,
    // `HR_AUDIT_RESOURCE.LEAVE` would be invisible to a query for travel authorization.
    const resources = new Set<string>();
    for (const { text } of sources) {
      for (const match of text.matchAll(/resource: HR_AUDIT_RESOURCE\.(\w+)/g)) {
        resources.add(match[1]);
      }
    }
    expect([...resources].sort()).toEqual([
      'MISSION',
      'MISSION_APPROVAL_DEFINITION',
      'MISSION_OPTION',
      'MISSION_POLICY_VERSION',
    ]);
  });

  /**
   * CONTRACT CLOSURE (pre-Step-8A): THE LIST ENVELOPE IS UNIFORM.
   *
   * WHY THIS EXISTS. Three Mission configuration lists — option groups, approval definitions and
   * policy versions — returned the repository's POSITIONAL TUPLE `[rows, count]` straight to the
   * wire, while `list` (and every list in `LeaveService` before it) answers
   * `{ items, total, page, pageSize }`. A Web client could not type both shapes with one rule, and
   * `pageSize` was not recoverable from the tuple at all, so the effective page size the server
   * actually used was unknowable to the caller.
   *
   * The tuple is now destructured in the service. These assertions pin the ENVELOPE and the two
   * ECHOED page facts, because the failure this catches is silent: a spread of the tuple would
   * compile, would satisfy `items`/`total`, and would still be wrong about `page`/`pageSize`.
   */
  describe('list responses use the shared { items, total, page, pageSize } envelope', () => {
    it('normalizes the option-group tuple and echoes the EFFECTIVE page facts', async () => {
      // The fixture already returns `[groups, 3]` — a tuple, not a page.
      const result = await service.listOptionGroups(actor, {});

      expect(result.items).toEqual(groups);
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      // `sanitizePage`'s default, NOT a missing `undefined`: the tuple carried no page size, so
      // the service must state the one it actually used.
      expect(result.pageSize).toBe(HR_DEFAULT_PAGE_SIZE);
      // Exactly these four keys — a spread of the tuple would leak numeric keys.
      expect(Object.keys(result).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
      // The repository contract is UNCHANGED: still called with the tenant and the window.
      expect(missionRepo.listOptionGroupPage).toHaveBeenCalledWith(
        't1',
        { active: undefined },
        { skip: 0, take: HR_DEFAULT_PAGE_SIZE }
      );
    });

    it('clamps the ECHOED pageSize to the module maximum rather than echoing the request', async () => {
      const result = await service.listOptionGroups(actor, { page: 3, pageSize: 100000 });

      // The request asked for 100000; the answer must state what was really served.
      expect(result.pageSize).toBe(HR_MAX_PAGE_SIZE);
      expect(result.page).toBe(3);
      expect(missionRepo.listOptionGroupPage).toHaveBeenCalledWith(
        't1',
        { active: undefined },
        { skip: (3 - 1) * HR_MAX_PAGE_SIZE, take: HR_MAX_PAGE_SIZE }
      );
    });

    it('normalizes the approval-definition tuple the same way', async () => {
      const definition = { id: 'def1', name: 'Sequential' };
      approvalRepo.listDefinitionPage = jest.fn().mockResolvedValue([[definition], 1]);

      const result = await service.listApprovalDefinitions(actor, { status: 'ACTIVE' });

      expect(result.items).toEqual([definition]);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(HR_DEFAULT_PAGE_SIZE);
      expect(Object.keys(result).sort()).toEqual(['items', 'page', 'pageSize', 'total']);
      expect(approvalRepo.listDefinitionPage).toHaveBeenCalledWith(
        't1',
        { status: 'ACTIVE' },
        { skip: 0, take: HR_DEFAULT_PAGE_SIZE }
      );
    });
  });

  /**
   * CONTRACT CLOSURE (pre-Step-8A): THE REQUEST STATES WHY IT CAME BACK.
   *
   * WHY THIS EXISTS. `MissionRequest.correctionReason` and `.rejectionReason` are real columns the
   * correction and reject flows write, and `findRequestById` returns them (`include`, never a
   * narrower `select`) — but the serializer dropped both. The consequence was a permission
   * inversion: the ONLY explanation of a returned request lived on the approval steps, readable
   * solely by a holder of `hr.mission.approve`, so the employee who must ACT on
   * `CORRECTION_REQUIRED` could not see why.
   *
   * The assertions read a service READ rather than the serializer directly, because the claim is
   * about what a caller receives.
   */
  describe('a request exposes the correction and rejection reasons it carries', () => {
    it('returns the stored correctionReason and rejectionReason verbatim', async () => {
      missionRepo.findRequestById = jest.fn().mockResolvedValue({
        ...draftRequest,
        status: 'CORRECTION_REQUIRED',
        correctionReason: 'تاریخ پایان اصلاح شود.',
        rejectionReason: null,
      });

      const result = await service.getById(actor, 'mr1');

      expect(result.correctionReason).toBe('تاریخ پایان اصلاح شود.');
      expect(result.rejectionReason).toBeNull();
    });

    it('keeps both fields NULL when neither decision stated one', async () => {
      missionRepo.findRequestById = jest
        .fn()
        .mockResolvedValue({ ...draftRequest, correctionReason: null, rejectionReason: null });

      const result = await service.getById(actor, 'mr1');

      // `null` means "nobody stated anything" and must never become a sentence, an empty string or
      // a copy of the other field.
      expect(result.correctionReason).toBeNull();
      expect(result.rejectionReason).toBeNull();
    });

    it('never substitutes one reason for the other', async () => {
      missionRepo.findRequestById = jest.fn().mockResolvedValue({
        ...draftRequest,
        status: 'REJECTED',
        correctionReason: null,
        rejectionReason: 'خارج از بودجه است.',
      });

      const result = await service.getById(actor, 'mr1');

      // The MIRROR of the case above: a rejection states its own reason and the correction stays
      // `null`. Deriving one from the other would pass a naive "a reason is present" assertion.
      expect(result.rejectionReason).toBe('خارج از بودجه است.');
      expect(result.correctionReason).toBeNull();
    });

    it('carries the reasons onto the paged LIST read as well as the detail read', async () => {
      missionRepo.listRequestPage = jest.fn().mockResolvedValue([
        [
          {
            ...draftRequest,
            status: 'CORRECTION_REQUIRED',
            correctionReason: 'ساعت شروع اشتباه است.',
            rejectionReason: null,
          },
        ],
        1,
      ]);

      const page = await service.list(actor, {});

      expect(page.items[0].correctionReason).toBe('ساعت شروع اشتباه است.');
      expect(page.items[0].rejectionReason).toBeNull();
      // The envelope `list` already had is untouched by this closure.
      expect(page.total).toBe(1);
      expect(page.page).toBe(1);
    });
  });
});
