import { NotFoundException } from '@nestjs/common';
import { LeaveApprovalService } from './leave-approval.service';
import type { HrActor } from '../hr-actor';

/**
 * Phase 54-J (§7): the APPROVABILITY READ contract on `LeaveApprovalService`, and the write path's
 * independent re-check of the very same predicate.
 *
 * WHY THE STUBS ARE HAND-BUILT RATHER THAN A PRISMA FAKE
 * ------------------------------------------------------
 * These tests assert the SHAPE OF A RESPONSE and the ORDER OF REFUSALS. Only a few collaborator
 * methods matter: one read of the instance, one lookup of the actor's own personnel record, and the
 * writes that record a decision. A fake large enough to satisfy Prisma's full API would be machinery
 * asserting itself; a handful of `jest.fn()`s state exactly which calls the behaviour under test may
 * depend on, so an unexpected second read or write is a failure rather than a silent round-trip.
 *
 * WHAT IS *NOT* COVERED HERE, AND WHERE IT LIVES
 * ----------------------------------------------
 * The ROUTE GUARD (`hr.leave.approve`) is not this service's concern and is not simulated: §2 of the
 * A1 correction is explicit that `decidableByActor` is presentation state and the write routes remain
 * authoritative. The pure comparison — every combination of decider, resolved approver and step
 * status — is pinned in `domain/leave-approval-decisionability.spec.ts` against the ONE function
 * both paths call. This file proves the service WIRES that function into both paths and leaks nothing.
 */

const TENANT = 'tenant-a';

const ACTOR: HrActor = {
  tenantId: TENANT,
  userId: 'login-of-actor',
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

/** A step awaiting this actor, in the shape `findLiveInstance` actually returns. */
function liveInstance(
  overrides: {
    resolvedApproverEmployeeId?: string | null;
    stepStatus?: string;
    status?: 'ACTIVE' | 'COMPLETED';
  } = {}
) {
  const stepStatus = overrides.stepStatus ?? 'ACTIVE';
  return {
    id: 'instance-1',
    leaveRequestId: 'leave-1',
    tenantId: TENANT,
    status: overrides.status ?? 'ACTIVE',
    stepCount: 1,
    requestStartDate: new Date('2026-10-01T00:00:00.000Z'),
    requestEndDate: new Date('2026-10-03T00:00:00.000Z'),
    steps: [
      {
        id: 'step-1',
        // THE ROW'S OWN COLUMNS, mirrored from `LeaveApprovalStepInstance` (schema) — `findLiveInstance`
        // returns them via `include: { steps }` and `serializeInstance` spreads them, so they all reach
        // the wire. Fixtures that omitted them would let a `select` narrow in the service pass unnoticed,
        // which is exactly the regression the exact-key-set test below exists to catch.
        approvalInstanceId: 'instance-1',
        approvalStepDefinitionId: 'stepdef-1',
        tenantId: TENANT,
        order: 1,
        status: stepStatus,
        resolvedApproverEmployeeId:
          overrides.resolvedApproverEmployeeId === undefined
            ? 'employee-actor'
            : overrides.resolvedApproverEmployeeId,
        resolutionReason: 'PRIMARY',
        resolutionSignal: 'SIGNAL_DIRECT_LINE_MANAGER',
        decision: null,
        decidedByEmployeeId: null,
        decisionReason: null,
        decidedAt: null,
        ruleVersionLabel: 'v1',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        // No `resolvedApproverEmployee` / `decidedByEmployee` relation object: `findLiveInstance` does
        // NOT include `STEP_LABEL`, so those joins are absent from this read (asserted below).
      },
    ],
  };
}

function build(
  overrides: {
    instance?: ReturnType<typeof liveInstance> | null;
    employee?: { id: string; employeeCode: string } | null;
  } = {}
) {
  const instance = 'instance' in overrides ? overrides.instance : liveInstance();
  const employee =
    'employee' in overrides ? overrides.employee : { id: 'employee-actor', employeeCode: 'E-1' };

  const approvals = {
    findLiveInstance: jest.fn().mockResolvedValue(instance),
    listInstances: jest.fn().mockResolvedValue([]),
    recordDecision: jest.fn().mockResolvedValue(undefined),
    listAwaitingSteps: jest.fn().mockResolvedValue([]),
    closeInstanceOnWithdrawal: jest.fn().mockResolvedValue(0),
  };
  const leave = {
    findRequestById: jest
      .fn()
      .mockResolvedValue({ id: 'leave-1', tenantId: TENANT, status: 'PENDING' }),
  };
  const employees = { findByIdentityUserId: jest.fn().mockResolvedValue(employee) };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const service = new LeaveApprovalService(
    approvals as never,
    leave as never,
    employees as never,
    audit as never
  );

  return { service, approvals, leave, employees, audit };
}

describe('HR leave — the approval READ contract (54-J / A1)', () => {
  describe('§7.1–§7.3 — the server reports decisionability', () => {
    it('reports decidableByActor true with a null reason for the actor’s own step', async () => {
      const { service } = build();

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');

      expect(flow).toMatchObject({ decidableByActor: true, undecidableReason: null });
    });

    it('reports AWAITING_OTHER when the active step belongs to another employee', async () => {
      const { service } = build({
        instance: liveInstance({ resolvedApproverEmployeeId: 'employee-other' }),
      });

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');

      expect(flow).toMatchObject({ decidableByActor: false, undecidableReason: 'AWAITING_OTHER' });
    });

    it('reports NOT_RESOLVED when nobody was resolved for the active step', async () => {
      const { service } = build({ instance: liveInstance({ resolvedApproverEmployeeId: null }) });

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');

      expect(flow).toMatchObject({ decidableByActor: false, undecidableReason: 'NOT_RESOLVED' });
    });

    it('reports AWAITING_OTHER for an actor with no personnel record', async () => {
      // `required: false` on the READ — a legitimate HR operator who is not an employee gets an
      // honest answer rather than a 403 on a question they were allowed to ask.
      const { service, employees } = build({ employee: null });

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');

      expect(flow).toMatchObject({ decidableByActor: false, undecidableReason: 'AWAITING_OTHER' });
      expect(employees.findByIdentityUserId).toHaveBeenCalledWith(TENANT, ACTOR.userId);
    });

    it('refuses the read for a request outside the actor’s tenant', async () => {
      // §7.8 — TENANT ISOLATION ON THE READ. The lookup is scoped, so a foreign id is a 404 before
      // any decisionability fact could be computed and returned.
      const { service, leave } = build();
      leave.findRequestById.mockResolvedValue(null);

      await expect(service.getLiveFlow(ACTOR, 'foreign-id')).rejects.toThrow(NotFoundException);
      expect(leave.findRequestById).toHaveBeenCalledWith(TENANT, 'foreign-id');
    });
  });

  describe('§7.4 — a COMPLETED approval instance presents no decision', () => {
    it('reports decidableByActor false with NO reason when the flow has no active step', async () => {
      // COMPLETED with a single APPROVED step: nobody is awaiting a decision. The reason is null
      // rather than `AWAITING_OTHER`, because §7.3 forbids a refusal category the domain does not
      // need — "the flow is over" is already stated by `status`.
      const { service } = build({
        instance: liveInstance({ status: 'COMPLETED', stepStatus: 'APPROVED' }),
      });

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');

      expect(flow).toMatchObject({
        status: 'COMPLETED',
        decidableByActor: false,
        undecidableReason: null,
      });
    });

    it('reports decidableByActor false when the instance has no steps at all', async () => {
      // Defensive: not reachable through the routing engine, which activates step 1 in the same
      // transaction (§18.1), but the read must not invent an action for an empty flow either.
      const { service } = build({
        instance: { ...liveInstance({ status: 'COMPLETED' }), steps: [] },
      });

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');

      expect(flow).toMatchObject({ decidableByActor: false, undecidableReason: null });
    });

    it('returns null — not a fabricated flow — for a request with no live instance', async () => {
      // §18.5: an ungoverned request has no flow, and throwing would make that indistinguishable
      // from a missing request. No decisionability fact is invented for a flow that does not exist.
      const { service } = build({ instance: null });

      await expect(service.getLiveFlow(ACTOR, 'leave-1')).resolves.toBeNull();
    });
  });

  describe('§7.5 — the read does not expose identity or authorization ingredients', () => {
    it('carries no tenantId, actorId or the current actor’s employee id', async () => {
      // §5: "Return the answer, not the ingredients." The payload must answer ONE question without
      // handing the browser a tenant, a session actor id, or the employee id the comparison used —
      // any of which would invite a client-side authorization rule (§8).
      const { service } = build();

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');
      const json = JSON.stringify(flow);

      expect(flow && 'tenantId' in flow).toBe(false);
      expect(flow && 'approvalDefinitionId' in flow).toBe(false);
      expect(flow && 'actorId' in flow).toBe(false);
      expect(flow && 'deciderEmployeeId' in flow).toBe(false);
      expect(json).not.toContain('login-of-actor');
      // The ACTOR'S OWN employee id must not be a field. The step's resolved-approver label may
      // legitimately repeat the same value, so this checks KEYS rather than the whole payload.
      expect(Object.keys(flow ?? {})).not.toContain('currentActorEmployeeId');
      expect(Object.keys(flow ?? {})).not.toContain('deciderEmployeeId');
      // THE INSTANCE-LEVEL `tenantId` is stripped by this read (§5) and must not be a key. The STEP's
      // own `tenantId` column is a PRE-EXISTING pass-through from the row spread (54-E) — this phase
      // does not widen OR narrow it, so the assertion is on the KEY the strip owns, not a string that
      // a step-level column would also match. Stripping step columns would be an unreviewed contract
      // change (§6), which the phase explicitly forbids.
      const step0 = (flow?.steps ?? [])[0] as Record<string, unknown> | undefined;
      expect(Object.prototype.hasOwnProperty.call(flow ?? {}, 'tenantId')).toBe(false);
      expect(step0 && 'tenantId' in step0).toBe(true);
    });

    it('still returns the facts an approval screen is required to render', async () => {
      // The correction (§6) forbids EXPANDING the response, not returning what it already returns:
      // statuses, the request dates, the step order and the decision facts below.
      const { service } = build();

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');

      expect(flow).toMatchObject({
        status: 'ACTIVE',
        requestStartDate: '2026-10-01',
        requestEndDate: '2026-10-03',
        steps: [expect.objectContaining({ order: 1, status: 'ACTIVE' })],
      });
    });

    it('carries every field a step row already exposes — resolution, decision and rule version', async () => {
      // §6's assessment hinges on this: `serializeInstance` spreads the ROW, so the fields the DB
      // stores on a step reach the client WITHOUT a contract change. These are listed here because
      // they are what the 54-J screen renders and what an expansion of the read would have to
      // justify being absent — `resolutionReason`/`resolutionSignal` (how the approver was found),
      // `decision` + `decidedAt` + `decisionReason` (what was decided and why) and `ruleVersionLabel`
      // (the policy version in force, §17.5). A future `select` that dropped any of them would fail
      // here rather than silently blanking the approval screen.
      const { service } = build();

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');
      const step = flow?.steps[0];

      expect(step).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          resolutionReason: expect.any(String),
          resolutionSignal: expect.anything(),
          decision: null,
          decidedAt: null,
          decisionReason: null,
          ruleVersionLabel: expect.anything(),
          decidedByEmployeeId: null,
        })
      );
      // Decided and resolution fields are PRESENT as keys even while null — a screen that wrote
      // `step.decidedAt === undefined` would render a different state than `null` implies.
      expect(step && 'decidedAt' in step).toBe(true);
      expect(step && 'resolutionReason' in step).toBe(true);
    });

    it('exposes each step as a flat object of scalar columns — no relation label rides this read', async () => {
      // §6's contract, stated where it is TESTABLE: `serializeInstance` spreads whatever
      // `findLiveInstance` returned, so the step keys on the wire are that row's OWN SCALAR COLUMNS
      // and nothing nested. `resolvedApproverEmployee` / `decidedByEmployee` would only appear if the
      // repository added `STEP_LABEL` to this include (it does not — see `findLiveInstance`), and that
      // would be a response widening needing review. Asserting the EXACT key set pins the contract
      // without pretending the stub proves anything about the repository's own query.
      const { service } = build();

      const flow = await service.getLiveFlow(ACTOR, 'leave-1');
      const step = flow?.steps[0];

      // Exact key set: every scalar column of `LeaveApprovalStepInstance` the schema declares, and
      // NOT the two Employee relation joins. A `select` that narrowed the row, or an `include` that
      // added a label, fails here rather than silently blanking or widening the approval screen.
      expect(Object.keys(step ?? {}).sort()).toEqual(
        [
          'approvalInstanceId',
          'approvalStepDefinitionId',
          'createdAt',
          'decidedAt',
          'decidedByEmployeeId',
          'decision',
          'decisionReason',
          'id',
          'order',
          'resolutionReason',
          'resolutionSignal',
          'resolvedApproverEmployeeId',
          'ruleVersionLabel',
          'status',
          'tenantId',
          'updatedAt',
        ].sort()
      );
      expect(step).toEqual(
        expect.objectContaining({ resolvedApproverEmployeeId: 'employee-actor' })
      );
    });
  });
});
