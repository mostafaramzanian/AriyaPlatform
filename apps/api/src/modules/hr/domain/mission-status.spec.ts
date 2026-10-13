import {
  MISSION_REQUEST_INITIAL_STATUS,
  MISSION_REQUEST_STATUSES,
  MISSION_REQUEST_STATUS_TRANSITIONS,
  canTransitionMissionRequest,
  isMissionRequestRestatable,
  isMissionRequestStatus,
  isTerminalMissionRequestStatus,
  type MissionRequestStatus,
} from './mission-status';

const SAMPLE_STATUSES: MissionRequestStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'IN_APPROVAL',
  'CORRECTION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
];

describe('HR domain — mission request status', () => {
  describe('the vocabulary', () => {
    it('declares exactly the seven members the schema declares, in schema order', () => {
      expect(MISSION_REQUEST_STATUSES).toEqual([
        'DRAFT',
        'SUBMITTED',
        'IN_APPROVAL',
        'CORRECTION_REQUIRED',
        'APPROVED',
        'REJECTED',
        'CANCELLED',
      ]);
    });

    it('starts a request in DRAFT and nowhere else', () => {
      expect(MISSION_REQUEST_INITIAL_STATUS).toBe('DRAFT');
      expect(isMissionRequestStatus(MISSION_REQUEST_INITIAL_STATUS)).toBe(true);
    });

    it('lists every state including terminal ones with an empty outgoing set', () => {
      expect(Object.keys(MISSION_REQUEST_STATUS_TRANSITIONS).sort()).toEqual(
        SAMPLE_STATUSES.slice().sort()
      );
      expect(MISSION_REQUEST_STATUS_TRANSITIONS.APPROVED).toEqual([]);
      expect(MISSION_REQUEST_STATUS_TRANSITIONS.REJECTED).toEqual([]);
      expect(MISSION_REQUEST_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
    });
  });

  describe('isMissionRequestStatus', () => {
    it('accepts every declared member', () => {
      for (const status of SAMPLE_STATUSES) {
        expect(isMissionRequestStatus(status)).toBe(true);
      }
    });

    it('refuses casing, whitespace and unknown values', () => {
      for (const value of [
        'draft',
        'Draft',
        ' DRAFT',
        'APPROVED ',
        'approve',
        '',
        null,
        undefined,
        42,
      ]) {
        expect(isMissionRequestStatus(value)).toBe(false);
      }
    });
  });

  describe('canTransitionMissionRequest', () => {
    it('permits draft -> submitted and draft -> cancelled', () => {
      expect(canTransitionMissionRequest('DRAFT', 'SUBMITTED')).toBe(true);
      expect(canTransitionMissionRequest('DRAFT', 'CANCELLED')).toBe(true);
    });

    it('permits submitted -> in_approval and submitted -> cancelled', () => {
      expect(canTransitionMissionRequest('SUBMITTED', 'IN_APPROVAL')).toBe(true);
      expect(canTransitionMissionRequest('SUBMITTED', 'CANCELLED')).toBe(true);
    });

    it('permits in_approval -> approved, rejected, correction_required and cancelled', () => {
      expect(canTransitionMissionRequest('IN_APPROVAL', 'APPROVED')).toBe(true);
      expect(canTransitionMissionRequest('IN_APPROVAL', 'REJECTED')).toBe(true);
      expect(canTransitionMissionRequest('IN_APPROVAL', 'CORRECTION_REQUIRED')).toBe(true);
      expect(canTransitionMissionRequest('IN_APPROVAL', 'CANCELLED')).toBe(true);
    });

    it('permits correction_required -> submitted (resubmission) and cancelled', () => {
      expect(canTransitionMissionRequest('CORRECTION_REQUIRED', 'SUBMITTED')).toBe(true);
      expect(canTransitionMissionRequest('CORRECTION_REQUIRED', 'CANCELLED')).toBe(true);
    });

    it('refuses no-op transitions', () => {
      for (const status of SAMPLE_STATUSES) {
        expect(canTransitionMissionRequest(status, status)).toBe(false);
      }
    });

    it('refuses approved -> completed', () => {
      expect(
        canTransitionMissionRequest('APPROVED', 'COMPLETED' as unknown as MissionRequestStatus)
      ).toBe(false);
    });

    it('refuses terminal states from being re-decided', () => {
      for (const terminal of ['APPROVED', 'REJECTED', 'CANCELLED'] as const) {
        for (const target of SAMPLE_STATUSES) {
          expect(canTransitionMissionRequest(terminal, target)).toBe(false);
        }
      }
    });
  });

  describe('isTerminalMissionRequestStatus', () => {
    it('reports the four live states as non-terminal and the three end states as terminal', () => {
      expect(isTerminalMissionRequestStatus('DRAFT')).toBe(false);
      expect(isTerminalMissionRequestStatus('SUBMITTED')).toBe(false);
      expect(isTerminalMissionRequestStatus('IN_APPROVAL')).toBe(false);
      expect(isTerminalMissionRequestStatus('CORRECTION_REQUIRED')).toBe(false);
      expect(isTerminalMissionRequestStatus('APPROVED')).toBe(true);
      expect(isTerminalMissionRequestStatus('REJECTED')).toBe(true);
      expect(isTerminalMissionRequestStatus('CANCELLED')).toBe(true);
    });
  });

  describe('isMissionRequestRestatable', () => {
    it('is the exact inverse of terminality for every member', () => {
      for (const status of SAMPLE_STATUSES) {
        expect(isMissionRequestRestatable(status)).toBe(!isTerminalMissionRequestStatus(status));
      }
    });
  });
});
