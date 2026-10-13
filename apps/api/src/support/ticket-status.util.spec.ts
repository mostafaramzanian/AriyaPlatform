import { TicketStatus } from '../generated/core-client';
import {
  TERMINAL_STATUSES,
  allowedTransitions,
  canTransition,
  isTerminal,
} from './ticket-status.util';

/**
 * Phase 49G unit coverage for the lifecycle.
 *
 * The two invariants the contract rests on are asserted exhaustively rather than by
 * example: CLOSED is terminal with NO reopen path, and the graph is forward-only
 * except for the one intentional IN_PROGRESS ↔ WAITING_FOR_REQUESTER cycle.
 */

const ALL: TicketStatus[] = [
  'NEW',
  'TRIAGED',
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING_FOR_REQUESTER',
  'RESOLVED',
  'CLOSED',
];

describe('ticket status machine', () => {
  it('declares CLOSED as the only terminal status', () => {
    expect(TERMINAL_STATUSES).toEqual(['CLOSED']);
    expect(isTerminal('CLOSED')).toBe(true);

    for (const status of ALL.filter((s) => s !== 'CLOSED')) {
      expect(isTerminal(status)).toBe(false);
    }
  });

  it('allows NO transition out of CLOSED — there is no reopen', () => {
    expect(allowedTransitions('CLOSED')).toEqual([]);

    for (const target of ALL) {
      expect(canTransition('CLOSED', target)).toBe(false);
    }
  });

  it('never allows a status to transition to itself', () => {
    for (const status of ALL) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('only reaches CLOSED from RESOLVED', () => {
    const sources = ALL.filter((from) => canTransition(from, 'CLOSED'));
    expect(sources).toEqual(['RESOLVED']);
  });

  it('lets RESOLVED be reached from every non-terminal working state', () => {
    for (const from of ['NEW', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_REQUESTER'] as TicketStatus[]) {
      expect(canTransition(from, 'RESOLVED')).toBe(true);
    }
  });

  it('supports the one intended cycle: work pauses for the requester and resumes', () => {
    expect(canTransition('IN_PROGRESS', 'WAITING_FOR_REQUESTER')).toBe(true);
    expect(canTransition('WAITING_FOR_REQUESTER', 'IN_PROGRESS')).toBe(true);
  });

  it('never moves backwards through triage/assignment', () => {
    const backwards: Array<[TicketStatus, TicketStatus]> = [
      ['TRIAGED', 'NEW'],
      ['ASSIGNED', 'NEW'],
      ['ASSIGNED', 'TRIAGED'],
      ['IN_PROGRESS', 'NEW'],
      ['IN_PROGRESS', 'TRIAGED'],
      ['IN_PROGRESS', 'ASSIGNED'],
      ['RESOLVED', 'NEW'],
      ['RESOLVED', 'IN_PROGRESS'],
      ['RESOLVED', 'WAITING_FOR_REQUESTER'],
    ];

    for (const [from, to] of backwards) {
      expect(canTransition(from, to)).toBe(false);
    }
  });

  it('exposes a defined transition set for every status', () => {
    for (const status of ALL) {
      expect(Array.isArray(allowedTransitions(status))).toBe(true);
    }
  });

  it('never lists a transition that canTransition would refuse', () => {
    for (const from of ALL) {
      for (const to of allowedTransitions(from)) {
        expect(canTransition(from, to)).toBe(true);
      }
    }
  });
});
