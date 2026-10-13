import {
  LEAVE_APPROVAL_UNDECIDABLE_REASONS,
  isDecidableLeaveApprovalStepStatus,
  mayDecideLeaveApprovalStep,
  resolveLeaveApprovalDecisionability,
} from './leave-approval-status';

/**
 * Phase 54-J (§7, §27): the DECISIONABILITY read — the single fact an approver's screen needs and
 * the single rule both the read and the write consult.
 *
 * WHY THESE ARE PURE TESTS AGAINST A FUNCTION WITH NO DEPENDENCIES
 * ----------------------------------------------------------------
 * The whole content of the A1 correction is that `GET :id/approval` must report `decidableByActor`
 * without inventing a second authorization model. The only way to PROVE the read and the write agree
 * is to make them call the same zero-dependency function and assert that function directly here — no
 * Nest, no database, no fake. A test that exercised the read and the write through separate HTTP
 * fixtures could pass while the two rules disagreed, which is exactly the drift the phase forbids.
 *
 * WHAT IS DELIBERATELY *NOT* TESTED HERE
 * --------------------------------------
 * The permission (`hr.leave.approve`), the tenant, the actor's login and the step's position are NOT
 * inputs to this function, so none of them appear below — their absence is the assertion. The write
 * path's own refusals (the 403's and the 409's prose) belong to the service's tests; what is pinned
 * here is that both paths read the SAME answer before either one acts on it.
 */

const ACTOR = 'employee-actor';
const OTHER = 'employee-other';

describe('HR domain — leave approval decisionability', () => {
  describe('the reason vocabulary (§7.3)', () => {
    it('declares exactly the two reasons the phase allows, in declaration order', () => {
      // The phase names the vocabulary explicitly and forbids inventing further categories until
      // the domain proves one is necessary. Asserting the exact list makes adding a third reason a
      // reviewable edit to this file rather than a silent contract change for the browser.
      expect(LEAVE_APPROVAL_UNDECIDABLE_REASONS).toEqual(['NOT_RESOLVED', 'AWAITING_OTHER']);
    });
  });

  describe('§7.1 — the active step is resolved to the current actor', () => {
    it('reports decidableByActor with NO refusal reason', () => {
      const answer = resolveLeaveApprovalDecisionability({
        deciderEmployeeId: ACTOR,
        resolvedApproverEmployeeId: ACTOR,
      });

      expect(answer).toEqual({ decidableByActor: true, undecidableReason: null });
      // The reason is null and NOT absent: a client destructuring it always finds the key, so
      // "decidable" and "undecidable but unwritten" are not the same rendered state.
      expect(answer.undecidableReason).toBeNull();
    });
  });

  describe('§7.2 — the active step is resolved to another actor', () => {
    it('reports not decidable and names AWAITING_OTHER', () => {
      const answer = resolveLeaveApprovalDecisionability({
        deciderEmployeeId: ACTOR,
        resolvedApproverEmployeeId: OTHER,
      });

      expect(answer).toEqual({ decidableByActor: false, undecidableReason: 'AWAITING_OTHER' });
    });

    it('is the comparison of employee ids, never of logins or roles', () => {
      // §8 forbids the browser from making this comparison. That the SERVER makes it from ids — and
      // returns only its answer — is the reason the browser is allowed to draw the button at all.
      expect(
        resolveLeaveApprovalDecisionability({
          deciderEmployeeId: 'employee-x',
          resolvedApproverEmployeeId: 'employee-x',
        }).decidableByActor
      ).toBe(true);
    });
  });

  describe('§7.3 — no approver was resolved for the active step', () => {
    it('reports NOT_RESOLVED rather than letting a null decider match a null approver', () => {
      // THE ORDER OF THE CHECKS IS THE TEST. If `deciderEmployeeId` were compared first, an actor
      // with no personnel record (null) would equal an unresolved step (null) and be told it may
      // decide a step nobody was ever resolved for — the fail-closed block of §17.3 inverted.
      const answer = resolveLeaveApprovalDecisionability({
        deciderEmployeeId: null,
        resolvedApproverEmployeeId: null,
      });

      expect(answer).toEqual({ decidableByActor: false, undecidableReason: 'NOT_RESOLVED' });
    });

    it('reports NOT_RESOLVED for a REAL actor on an unresolved step', () => {
      // The non-employee HR operator case: a legitimate actor who must not be able to decide a gap
      // in the policy. §25.2's point is that having standing in the system is not being the
      // resolved approver.
      expect(
        resolveLeaveApprovalDecisionability({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: null,
        })
      ).toEqual({ decidableByActor: false, undecidableReason: 'NOT_RESOLVED' });
    });

    it('reports AWAITING_OTHER for an actor with no personnel record on a resolved step', () => {
      // `resolveActorEmployee({ required: false })` on the READ yields null. The read must say
      // AWAITING_OTHER here (a real employee owns it and it is not this actor) — never `true`, and
      // never `NOT_RESOLVED`, which would blame the policy for an actor's own absence.
      expect(
        resolveLeaveApprovalDecisionability({
          deciderEmployeeId: null,
          resolvedApproverEmployeeId: ACTOR,
        })
      ).toEqual({ decidableByActor: false, undecidableReason: 'AWAITING_OTHER' });
    });
  });

  describe('§4 — one authoritative implementation for both paths', () => {
    it('accepts exactly one argument: the object of two ids', () => {
      // THE ASSERTION ABOUT WHAT IS MISSING. The function's authority comes from answering one
      // question from two ids; a tenant, a role or a permission parameter would be a SECOND
      // authorization model travelling alongside the real one (§2 of the correction). TypeScript
      // enforces the shape at the call sites — this pins that nobody added a second, optional one.
      expect(resolveLeaveApprovalDecisionability).toHaveLength(1);
      expect(
        resolveLeaveApprovalDecisionability({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: ACTOR,
        })
      ).toEqual({ decidableByActor: true, undecidableReason: null });
    });

    it('returns the same two keys on both answers, so the read shape never branches', () => {
      // A client that had to handle `undecidableReason` being present in one branch and absent in
      // another would need a conditional to discover whether the field exists — precisely the kind
      // of shape-detection that turns a typed contract into guesswork.
      const yes = resolveLeaveApprovalDecisionability({
        deciderEmployeeId: ACTOR,
        resolvedApproverEmployeeId: ACTOR,
      });
      const no = resolveLeaveApprovalDecisionability({
        deciderEmployeeId: ACTOR,
        resolvedApproverEmployeeId: OTHER,
      });

      expect(Object.keys(yes).sort()).toEqual(Object.keys(no).sort());
    });

    it('never returns the ids it was given, so the answer cannot leak the ingredients', () => {
      // §5: "Return the answer, not the ingredients." Spreading the input into the result would hand
      // the browser the right-hand side of a comparison it is forbidden to recompute (§8).
      const answer = resolveLeaveApprovalDecisionability({
        deciderEmployeeId: ACTOR,
        resolvedApproverEmployeeId: OTHER,
      });

      expect(JSON.stringify(answer)).not.toContain(ACTOR);
      expect(JSON.stringify(answer)).not.toContain(OTHER);
    });
  });

  describe('the step-status gate used by the read', () => {
    it('permits a decision only on the ACTIVE step', () => {
      // `isDecidableLeaveApprovalStepStatus` is the SAME predicate the write path consults before it
      // looks for an active step, so a read that reported `true` for a PENDING or APPROVED step
      // would promise an action the write refuses with a 409.
      expect(isDecidableLeaveApprovalStepStatus('ACTIVE')).toBe(true);
      expect(isDecidableLeaveApprovalStepStatus('PENDING')).toBe(false);
      expect(isDecidableLeaveApprovalStepStatus('APPROVED')).toBe(false);
      expect(isDecidableLeaveApprovalStepStatus('REJECTED')).toBe(false);
      expect(isDecidableLeaveApprovalStepStatus('SKIPPED')).toBe(false);
      expect(isDecidableLeaveApprovalStepStatus('CANCELLED')).toBe(false);
    });

    it('answers false with NO reason for a step that is not ACTIVE, keeping the vocabulary minimal', () => {
      // §7.3 forbids extra refusal categories: a non-ACTIVE step is already described by the
      // INSTANCE and REQUEST statuses on the same payload, so inventing `ALREADY_DECIDED` here
      // would create a second, weaker authority for a fact the wire already states.
      expect(
        mayDecideLeaveApprovalStep({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: ACTOR,
          stepStatus: 'APPROVED',
        })
      ).toEqual({ decidableByActor: false, undecidableReason: null });
    });

    it('still reports NOT_RESOLVED for an unresolved ACTIVE step', () => {
      expect(
        mayDecideLeaveApprovalStep({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: null,
          stepStatus: 'ACTIVE',
        })
      ).toEqual({ decidableByActor: false, undecidableReason: 'NOT_RESOLVED' });
    });

    it('reports true for the ACTIVE step resolved to this actor', () => {
      expect(
        mayDecideLeaveApprovalStep({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: ACTOR,
          stepStatus: 'ACTIVE',
        })
      ).toEqual({ decidableByActor: true, undecidableReason: null });
    });

    it('reports AWAITING_OTHER for the ACTIVE step resolved to somebody else', () => {
      expect(
        mayDecideLeaveApprovalStep({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: OTHER,
          stepStatus: 'ACTIVE',
        })
      ).toEqual({ decidableByActor: false, undecidableReason: 'AWAITING_OTHER' });
    });

    it('refuses to decide a resolved PENDING step, even for its own resolved approver', () => {
      // §18.3: a predecessor has not decided yet. The APPROVED case above covers a step that already
      // has an outcome; this covers one that simply has not been reached — both are "not the step
      // being asked", and both must be false rather than a reason the vocabulary lacks.
      expect(
        mayDecideLeaveApprovalStep({
          deciderEmployeeId: ACTOR,
          resolvedApproverEmployeeId: ACTOR,
          stepStatus: 'PENDING',
        })
      ).toEqual({ decidableByActor: false, undecidableReason: null });
    });
  });
});
