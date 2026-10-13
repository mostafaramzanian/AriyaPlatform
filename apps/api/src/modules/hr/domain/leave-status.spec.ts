import {
  LEAVE_REQUEST_INITIAL_STATUS,
  LEAVE_REQUEST_STATUSES,
  LEAVE_REQUEST_STATUS_TRANSITIONS,
  canTransitionLeaveRequest,
  isLeaveRequestRestatable,
  isLeaveRequestStatus,
  isTerminalLeaveRequestStatus,
  type LeaveRequestStatus,
} from './leave-status';

/**
 * Phase 51-HR-3A: the leave lifecycle, tested WITHOUT Nest, WITHOUT a database and WITHOUT a
 * Prisma fake — which is the whole reason the rules live in `domain/`.
 *
 * WHAT THESE SPECS PIN, AND WHY EACH ONE IS WORTH A TEST
 * -----------------------------------------------------
 * The transition table is the CONTRACT the schema and the migration were written against: the
 * enum in `hr_db` declares exactly four members, `LeaveRequest_*_state_check` ties `status` to the
 * timestamps in both directions, and `LeaveService.cancel` refuses anything the table does not
 * permit. A table with no reader would be a comment; a table with only an indirect reader
 * (the service) would fail there and pass here for the wrong reason, so the rules are asserted
 * directly as well.
 *
 * `isLeaveRequestStatus` is the boundary of the WIRE vocabulary rather than a convenience: it is
 * what lets a query filter be validated against the same four members the database declares,
 * instead of against a fourth spelling typed into a DTO.
 *
 * PHASE 54-E WIDENED THIS VOCABULARY FROM TWO MEMBERS TO FOUR, and these specs were edited in the
 * same change — which is the maintenance contract the previous phase's `leave-status.ts` header
 * recorded when it wrote "APPROVED / REJECTED arrive later with their authority, their permission
 * and their seed row, in one change". The expectations that READ AS NEGATIVE ASSERTIONS below
 * (`has no APPROVED member`) became POSITIVE ones (`reaches exactly the two decision states`), and
 * that inversion is the point of this file: it is where the phase's own claim is falsifiable.
 */

const SAMPLE_STATUSES: LeaveRequestStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

describe('HR domain — leave request status', () => {
  describe('the vocabulary', () => {
    it('declares exactly the four members the schema declares, in schema order', () => {
      // `prisma/hr/schema.prisma` declares PENDING, APPROVED, REJECTED, CANCELLED — in that order.
      // The order is asserted because it is the order a reader expects; a reordering is a
      // deliberate edit here rather than a silent diff in a select.
      expect(LEAVE_REQUEST_STATUSES).toEqual(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);
    });

    it('starts a request in PENDING and nowhere else', () => {
      // The state a create produces is a CONSTANT, not a default a caller can restate:
      // `LeaveRepository.createRequest` writes it, and this assertion makes "no create produces
      // anything else" a claim about the domain rather than about one call site. 54-E did not
      // change this: a decision is recorded by an APPROVER on a routed flow, never at creation.
      expect(LEAVE_REQUEST_INITIAL_STATUS).toBe('PENDING');
      expect(isLeaveRequestStatus(LEAVE_REQUEST_INITIAL_STATUS)).toBe(true);
    });

    it('reaches exactly the two decision states, and only from PENDING', () => {
      // THE INVERSION OF THE PREVIOUS PHASE'S ASSERTION, and it is worth spelling out. 51-HR-3A
      // asserted `not.toContain('APPROVED')` because no authoritative approval rule existed, so a
      // decision state would have been one nobody was entitled to write. 54-E supplies the rule —
      // `LeaveApprovalStepInstance.resolvedApproverEmployeeId` says who was asked — so the members
      // are now correct and this asserts they are present, in the schema's order.
      expect(LEAVE_REQUEST_STATUSES).toContain('APPROVED');
      expect(LEAVE_REQUEST_STATUSES).toContain('REJECTED');

      // EVERY member has a row, INCLUDING the terminal ones whose list is empty. A state missing
      // from the table and a state whose list is empty would both read as "no way out", and one of
      // them means "nobody added it yet".
      expect(Object.keys(LEAVE_REQUEST_STATUS_TRANSITIONS).sort()).toEqual([
        'APPROVED',
        'CANCELLED',
        'PENDING',
        'REJECTED',
      ]);
      // A decision is reachable from PENDING and from nowhere else: this is what makes "the second
      // approval" unwritable at the DOMAIN level, with `LeaveApprovalService.decide`'s status guard
      // as the runtime reader of the same fact.
      expect(LEAVE_REQUEST_STATUS_TRANSITIONS.PENDING).toEqual([
        'APPROVED',
        'REJECTED',
        'CANCELLED',
      ]);
      expect(LEAVE_REQUEST_STATUS_TRANSITIONS.APPROVED).toEqual([]);
      expect(LEAVE_REQUEST_STATUS_TRANSITIONS.REJECTED).toEqual([]);
    });
  });

  describe('isLeaveRequestStatus', () => {
    it('accepts every declared member', () => {
      for (const status of SAMPLE_STATUSES) {
        expect({ status, accepted: isLeaveRequestStatus(status) }).toEqual({
          status,
          accepted: true,
        });
      }
    });

    it('refuses anything else, including the near-misses', () => {
      // Casing, whitespace and a near-miss are all refused: a filter that accepted `cancelled`
      // would build a query matching nothing, which reads to an operator as "no such leave" rather
      // than as a typo.
      //
      // `APPROVED` WAS REMOVED FROM THIS LIST IN 54-E because it became a REAL member — keeping it
      // here would have asserted the opposite of the vocabulary. `APPROVED ` and `approved` replace
      // it: the near-misses that matter now are the ones a caller reaches by casing or by
      // whitespace, and the DECISION verbs (`approve`/`reject`) are a further trap worth naming,
      // because they are what the ROUTES are called while the STATES are their past participles.
      for (const value of [
        'cancelled',
        'Pending',
        ' PENDING',
        'APPROVED ',
        'approved',
        'approve',
        'reject',
        '',
        null,
        undefined,
      ]) {
        expect({ value, accepted: isLeaveRequestStatus(value) }).toEqual({
          value,
          accepted: false,
        });
      }
      expect(isLeaveRequestStatus(42)).toBe(false);
      expect(isLeaveRequestStatus({ status: 'PENDING' })).toBe(false);
    });
  });

  describe('canTransitionLeaveRequest', () => {
    it('permits the transitions this phase implements, and no others', () => {
      // THREE pairs since 54-E, and they are the three endpoints of the flow: a decision either
      // way, or a withdrawal. `PENDING -> CANCELLED` is 51-HR-3A's; the first two arrived with the
      // approval rule, and they are the ONLY way either decision state is reachable.
      expect(canTransitionLeaveRequest('PENDING', 'CANCELLED')).toBe(true);
      expect(canTransitionLeaveRequest('PENDING', 'APPROVED')).toBe(true);
      expect(canTransitionLeaveRequest('PENDING', 'REJECTED')).toBe(true);
    });

    it('refuses PENDING -> PENDING as a no-op', () => {
      // A no-op is not a transition, and answering "yes" would let a caller write a second audit
      // event for an act that did not happen — the failure the withdrawal's own audit payload is
      // built to avoid.
      expect(canTransitionLeaveRequest('PENDING', 'PENDING')).toBe(false);
    });

    it('treats every decided or withdrawn state as terminal in both directions', () => {
      // What this encodes: a second withdrawal would overwrite the instant the first one stamped,
      // and "when was this withdrawn?" would stop being answerable by the row. The database states
      // the same thing through `LeaveRequest_cancelled_state_check` (and, since 54-E,
      // `LeaveRequest_approved_state_check` / `LeaveRequest_rejected_state_check`).
      //
      // `APPROVED -> REJECTED` IS THE CASE WORTH NAMING. It is not merely "a second decision" — it
      // is a decision that CONTRADICTS the recorded one, and a request whose row says `APPROVED`
      // while its last step says `REJECTED` is exactly the incoherence the terminal set prevents.
      // `LeaveApprovalService.decide` reads `DECIDABLE_LEAVE_REQUEST_STATUS` for the same reason.
      for (const terminal of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
        for (const target of SAMPLE_STATUSES) {
          expect({
            from: terminal,
            to: target,
            allowed: canTransitionLeaveRequest(terminal, target),
          }).toEqual({ from: terminal, to: target, allowed: false });
        }
      }
    });

    it('agrees with the table for EVERY ordered pair of members', () => {
      // Exhaustive rather than illustrative: the assertions above name the interesting pairs, and
      // this one makes the table's own consistency falsifiable — a row edited without its reader
      // (or vice versa) fails here.
      for (const from of SAMPLE_STATUSES) {
        for (const to of SAMPLE_STATUSES) {
          const expected = LEAVE_REQUEST_STATUS_TRANSITIONS[from].includes(to);
          expect({ from, to, allowed: canTransitionLeaveRequest(from, to) }).toEqual({
            from,
            to,
            allowed: expected,
          });
        }
      }
    });

    it('permits exactly three ordered pairs today', () => {
      // A count rather than a list, so widening the table fails here as well as in the exhaustive
      // check above — and it cannot pass vacuously, because the permitted pairs are asserted to be
      // exactly the three this phase's flow can produce.
      const permitted = SAMPLE_STATUSES.flatMap((from) =>
        SAMPLE_STATUSES.filter((to) => canTransitionLeaveRequest(from, to)).map(
          (to) => `${from}->${to}`
        )
      );
      expect(permitted.sort()).toEqual([
        'PENDING->APPROVED',
        'PENDING->CANCELLED',
        'PENDING->REJECTED',
      ]);
    });
  });

  describe('isTerminalLeaveRequestStatus', () => {
    it('reports PENDING as live and every decided or withdrawn state as terminal', () => {
      // FOUR assertions since 54-E rather than two, and the added pair is the phase's claim: a
      // request that has been decided is FINISHED. A non-terminal `APPROVED` would permit
      // `APPROVED -> CANCELLED`, which would let a granted request be withdrawn after the fact.
      expect(isTerminalLeaveRequestStatus('PENDING')).toBe(false);
      expect(isTerminalLeaveRequestStatus('APPROVED')).toBe(true);
      expect(isTerminalLeaveRequestStatus('REJECTED')).toBe(true);
      expect(isTerminalLeaveRequestStatus('CANCELLED')).toBe(true);
    });

    it('lists every terminal state with an EMPTY list rather than omitting it', () => {
      // The distinction the domain file documents: a state MISSING from the table and a state
      // whose list is empty would both read as "no way out", and one of them means "nobody added
      // it yet". All three terminal states are present and empty, so terminality is a statement the
      // file MAKES — and `hasOwnProperty` rather than a truthiness check, because an omitted key
      // would read as `undefined` and the assertion would pass for the wrong reason.
      for (const terminal of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
        expect(
          Object.prototype.hasOwnProperty.call(LEAVE_REQUEST_STATUS_TRANSITIONS, terminal)
        ).toBe(true);
        expect(LEAVE_REQUEST_STATUS_TRANSITIONS[terminal]).toEqual([]);
        expect(LEAVE_REQUEST_STATUS_TRANSITIONS[terminal]).toHaveLength(0);
      }
    });
  });

  describe('isLeaveRequestRestatable', () => {
    it('lets a pending request be restated', () => {
      expect(isLeaveRequestRestatable('PENDING')).toBe(true);
    });

    it('refuses to restate a decided or withdrawn one', () => {
      // The consequence the schema states: a decided or withdrawn request is NEVER edited in
      // place — a correction is a NEW request, which is what keeps the trail of the decision and
      // the flow's history intact. `LeaveService.update` reads the stored row and asks THIS
      // predicate, so the refusal is a 409 about the row rather than a validation of the body.
      //
      // RESTATING A DECIDED REQUEST WOULD BE WORSE THAN RESTATING A WITHDRAWN ONE: the days a flow
      // decided would stop matching the days the request now states, and the decision would
      // describe a request that no longer exists. That is why this is asserted for BOTH decision
      // states rather than only for `CANCELLED`.
      expect(isLeaveRequestRestatable('APPROVED')).toBe(false);
      expect(isLeaveRequestRestatable('REJECTED')).toBe(false);
      expect(isLeaveRequestRestatable('CANCELLED')).toBe(false);
    });

    it('is the exact inverse of terminality for every member', () => {
      // Derived rather than restated, and asserted as a derivation: the two predicates cannot
      // drift, so the day a decision state arrives (decided, therefore terminal, therefore not
      // restatable) needs no second rule — which is precisely what happened in 54-E, where this
      // assertion required NO edit while the vocabulary around it widened.
      for (const status of SAMPLE_STATUSES) {
        expect({ status, restatable: isLeaveRequestRestatable(status) }).toEqual({
          status,
          restatable: !isTerminalLeaveRequestStatus(status),
        });
      }
    });
  });
});
