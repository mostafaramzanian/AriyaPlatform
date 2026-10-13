import { TicketStatus } from '../generated/core-client';

/**
 * Phase 49G: the ticket lifecycle, expressed once.
 *
 * Forward-only. Every allowed edge is listed explicitly rather than derived from an
 * ordering, so no transition can be introduced by accident:
 *
 *   NEW → TRIAGED → ASSIGNED → IN_PROGRESS → WAITING_FOR_REQUESTER
 *                                          → RESOLVED → CLOSED
 *
 * CLOSED is TERMINAL: its successor set is empty, so there is no reopen path and
 * nothing in the schema models one. A closed ticket's continuation is a new ticket.
 *
 * WAITING_FOR_REQUESTER and IN_PROGRESS are mutually reachable, which is the only
 * cycle in the graph and the one real support workflows need: an agent asks a
 * question, the requester answers, work resumes.
 */
const TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  NEW: ['TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED'],
  TRIAGED: ['ASSIGNED', 'IN_PROGRESS', 'RESOLVED'],
  ASSIGNED: ['IN_PROGRESS', 'WAITING_FOR_REQUESTER', 'RESOLVED'],
  IN_PROGRESS: ['WAITING_FOR_REQUESTER', 'RESOLVED'],
  WAITING_FOR_REQUESTER: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: TicketStatus[] = ['CLOSED'];

export function allowedTransitions(from: TicketStatus): TicketStatus[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * A transition is valid only if it is an explicitly listed edge. A no-op
 * (`from === to`) is NOT valid: it would write a history row that records no
 * change, which the `TicketStatusHistory_is_a_change` CHECK also refuses.
 */
export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return allowedTransitions(from).includes(to);
}

export function isTerminal(status: TicketStatus): boolean {
  return allowedTransitions(status).length === 0;
}
