import {
  isMissionApprovalInstanceHistorical,
  isMissionApprovalStepStatus,
  isDecidableMissionApprovalStepStatus,
  mayActivateSequentialStep,
  mayDecideMissionApprovalStep,
  resolveMissionApprovalDecisionability,
  resolveParallelOutcome,
  resolveSequentialRouting,
  type MissionApprovalStepStatus,
  type MissionStepState,
} from './mission-approval';

const ACTOR = 'employee-actor';
const OTHER = 'employee-other';
const SUBSTITUTED = 'employee-substituted';
const REQUESTER = 'employee-requester';

describe('HR domain — mission approval', () => {
  describe('vocabularies', () => {
    it('accepts valid step statuses', () => {
      expect(isMissionApprovalStepStatus('ACTIVE')).toBe(true);
      expect(isMissionApprovalStepStatus('CORRECTION_REQUIRED')).toBe(true);
      expect(isMissionApprovalStepStatus('DONE')).toBe(false);
    });
  });

  describe('isDecidableMissionApprovalStepStatus', () => {
    it('permits only ACTIVE', () => {
      const allowed: MissionApprovalStepStatus[] = [
        'PENDING',
        'APPROVED',
        'REJECTED',
        'CORRECTION_REQUIRED',
        'SKIPPED',
        'CANCELLED',
      ];
      expect(isDecidableMissionApprovalStepStatus('ACTIVE')).toBe(true);
      for (const status of allowed) {
        expect(isDecidableMissionApprovalStepStatus(status)).toBe(false);
      }
    });
  });

  describe('resolveMissionApprovalDecisionability', () => {
    it('reports decidable for primary resolved approver', () => {
      expect(
        resolveMissionApprovalDecisionability({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: ACTOR,
          requesterEmployeeId: OTHER,
          selfApprovalMode: 'NOT_ALLOWED',
        })
      ).toEqual({ decidableByActor: true, undecidableReason: null });
    });

    it('reports AWAITING_OTHER for another actor', () => {
      expect(
        resolveMissionApprovalDecisionability({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: OTHER,
          requesterEmployeeId: REQUESTER,
          selfApprovalMode: 'NOT_ALLOWED',
        })
      ).toEqual({ decidableByActor: false, undecidableReason: 'AWAITING_OTHER' });
    });

    it('reports NOT_RESOLVED for unresolved step', () => {
      expect(
        resolveMissionApprovalDecisionability({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: null,
          requesterEmployeeId: REQUESTER,
          selfApprovalMode: 'NOT_ALLOWED',
        })
      ).toEqual({ decidableByActor: false, undecidableReason: 'NOT_RESOLVED' });
    });

    it('reports SELF_APPROVAL_NOT_ALLOWED by default', () => {
      expect(
        resolveMissionApprovalDecisionability({
          deciderEmployeeId: REQUESTER,
          resolvedApproverEmployeeId: REQUESTER,
          requesterEmployeeId: REQUESTER,
          selfApprovalMode: 'NOT_ALLOWED',
        })
      ).toEqual({ decidableByActor: false, undecidableReason: 'SELF_APPROVAL_NOT_ALLOWED' });
    });

    it('allows self-approval when policy explicitly enables it', () => {
      expect(
        resolveMissionApprovalDecisionability({
          deciderEmployeeId: REQUESTER,
          resolvedApproverEmployeeId: REQUESTER,
          requesterEmployeeId: REQUESTER,
          selfApprovalMode: 'ALLOWED',
        })
      ).toEqual({ decidableByActor: true, undecidableReason: null });
    });

    it('treats an authorized substitute as decidable', () => {
      expect(
        resolveMissionApprovalDecisionability({
          deciderEmployeeId: SUBSTITUTED,
          resolvedApproverEmployeeId: SUBSTITUTED,
          requesterEmployeeId: REQUESTER,
          selfApprovalMode: 'NOT_ALLOWED',
        })
      ).toEqual({ decidableByActor: true, undecidableReason: null });
    });
  });

  describe('mayDecideMissionApprovalStep', () => {
    it('permits ACTIVE step resolved to actor', () => {
      expect(
        mayDecideMissionApprovalStep({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: ACTOR,
          requesterEmployeeId: REQUESTER,
          selfApprovalMode: 'NOT_ALLOWED',
          stepStatus: 'ACTIVE',
        })
      ).toEqual({ decidableByActor: true, undecidableReason: null });
    });

    it('refuses to decide a PENDING step even for the owner', () => {
      expect(
        mayDecideMissionApprovalStep({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: ACTOR,
          requesterEmployeeId: REQUESTER,
          selfApprovalMode: 'NOT_ALLOWED',
          stepStatus: 'PENDING',
        })
      ).toEqual({ decidableByActor: false, undecidableReason: null });
    });
  });

  describe('sequential routing', () => {
    it('approve last step completes the flow', () => {
      expect(
        resolveSequentialRouting({
          decision: 'APPROVED',
          order: 2,
          stepCount: 3,
          hasNextStep: false,
        })
      ).toEqual({
        stepStatus: 'APPROVED',
        requestStatus: 'APPROVED',
        instanceStatus: 'COMPLETED',
        nextStepOrder: null,
        cascade: null,
      });
    });

    it('approve intermediate step activates the next', () => {
      expect(
        resolveSequentialRouting({
          decision: 'APPROVED',
          order: 0,
          stepCount: 3,
          hasNextStep: true,
        })
      ).toEqual({
        stepStatus: 'APPROVED',
        requestStatus: 'IN_APPROVAL',
        instanceStatus: 'ACTIVE',
        nextStepOrder: 1,
        cascade: null,
      });
    });

    it('reject ends the flow and skips later steps', () => {
      expect(
        resolveSequentialRouting({
          decision: 'REJECTED',
          order: 1,
          stepCount: 3,
          hasNextStep: true,
        })
      ).toEqual({
        stepStatus: 'REJECTED',
        requestStatus: 'REJECTED',
        instanceStatus: 'REJECTED',
        nextStepOrder: null,
        cascade: 'SKIPPED',
      });
    });

    it('correction_required returns the request for correction', () => {
      expect(
        resolveSequentialRouting({
          decision: 'CORRECTION_REQUIRED',
          order: 1,
          stepCount: 3,
          hasNextStep: true,
        })
      ).toEqual({
        stepStatus: 'CORRECTION_REQUIRED',
        requestStatus: 'CORRECTION_REQUIRED',
        instanceStatus: 'CORRECTION_REQUIRED',
        nextStepOrder: null,
        cascade: null,
      });
    });
  });

  describe('parallel ALL_REQUIRED', () => {
    const base: MissionStepState[] = [
      { order: 0, status: 'PENDING', required: true },
      { order: 1, status: 'PENDING', required: true },
      { order: 2, status: 'PENDING', required: false },
    ];

    it('is insufficient when only one approves', () => {
      expect(
        resolveParallelOutcome([{ ...base[0], status: 'APPROVED' }, base[1], base[2]])
      ).toEqual({ requestStatus: 'IN_APPROVAL', instanceStatus: 'ACTIVE' });
    });

    it('completes when all required steps approve', () => {
      expect(
        resolveParallelOutcome([
          { ...base[0], status: 'APPROVED' },
          { ...base[1], status: 'APPROVED' },
          base[2],
        ])
      ).toEqual({ requestStatus: 'APPROVED', instanceStatus: 'COMPLETED' });
    });

    it('rejects if any step rejects', () => {
      expect(
        resolveParallelOutcome([
          { ...base[0], status: 'APPROVED' },
          { ...base[1], status: 'REJECTED' },
          base[2],
        ])
      ).toEqual({ requestStatus: 'REJECTED', instanceStatus: 'REJECTED' });
    });

    it('returns for correction if any step requests correction', () => {
      expect(
        resolveParallelOutcome([
          { ...base[0], status: 'APPROVED' },
          { ...base[1], status: 'CORRECTION_REQUIRED' },
          base[2],
        ])
      ).toEqual({ requestStatus: 'CORRECTION_REQUIRED', instanceStatus: 'CORRECTION_REQUIRED' });
    });

    it('does not complete if a required step is still pending', () => {
      expect(
        resolveParallelOutcome([
          { ...base[0], status: 'APPROVED' },
          { ...base[1], status: 'PENDING' },
          { ...base[2], status: 'APPROVED' },
        ])
      ).toEqual({ requestStatus: 'IN_APPROVAL', instanceStatus: 'ACTIVE' });
    });
  });

  describe('sequential activation', () => {
    it('activates the first pending step when none is active', () => {
      expect(
        mayActivateSequentialStep({ order: 0, activeOrder: null, pendingOrders: [0, 1] })
      ).toBe(true);
    });

    it('refuses to activate a future step before the active one', () => {
      expect(mayActivateSequentialStep({ order: 2, activeOrder: 0, pendingOrders: [1, 2] })).toBe(
        false
      );
    });

    it('activates the immediate successor', () => {
      expect(mayActivateSequentialStep({ order: 1, activeOrder: 0, pendingOrders: [1, 2] })).toBe(
        true
      );
    });

    it('refuses to reactivate a previous step', () => {
      expect(mayActivateSequentialStep({ order: 0, activeOrder: 1, pendingOrders: [0] })).toBe(
        false
      );
    });
  });

  describe('approval history', () => {
    it('treats completed, rejected, correction_required and superseded as historical', () => {
      for (const status of [
        'COMPLETED',
        'REJECTED',
        'CORRECTION_REQUIRED',
        'SUPERSEDED',
      ] as const) {
        expect(isMissionApprovalInstanceHistorical(status)).toBe(true);
      }
      expect(isMissionApprovalInstanceHistorical('ACTIVE')).toBe(false);
    });
  });
});
