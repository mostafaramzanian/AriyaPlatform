import { SurveyStatus } from '../generated/core-client';

/**
 * Phase 49H: the survey lifecycle, expressed once.
 *
 * Forward-only, with every allowed edge listed explicitly rather than derived from
 * an ordering, so no transition can be introduced by accident:
 *
 *   DRAFT → PUBLISHED → CLOSED
 *
 * Two properties this graph deliberately has, in contrast to the ticket lifecycle
 * (`ticket-status.util.ts`), which has a legitimate IN_PROGRESS ⇄
 * WAITING_FOR_REQUESTER cycle:
 *
 *  - There are NO cycles at all. In particular PUBLISHED → DRAFT does not exist.
 *    Un-publishing a survey people may already have answered would strand those
 *    responses against a questionnaire that is once again editable, so the
 *    questionnaire is frozen at publication instead.
 *  - CLOSED is TERMINAL: its successor set is empty, so there is no reopen path and
 *    nothing in the schema models one. A closed survey's continuation is a new
 *    survey.
 *
 * DRAFT → CLOSED is also absent: a survey that was never published has nothing to
 * close, and allowing it would produce a CLOSED row with no `publishedAt`, which the
 * `Survey_status_timestamps` CHECK refuses outright. Abandoning a draft is a delete,
 * not a transition.
 */
const TRANSITIONS: Record<SurveyStatus, SurveyStatus[]> = {
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['CLOSED'],
  CLOSED: [],
};

/** Statuses from which no further transition is possible. */
export const TERMINAL_SURVEY_STATUSES: SurveyStatus[] = ['CLOSED'];

export function allowedSurveyTransitions(from: SurveyStatus): SurveyStatus[] {
  return TRANSITIONS[from] ?? [];
}

/**
 * A transition is valid only if it is an explicitly listed edge. A no-op
 * (`from === to`) is NOT valid: re-publishing an already-published survey would
 * otherwise overwrite `publishedAt` and silently move the audit trail.
 */
export function canTransitionSurvey(from: SurveyStatus, to: SurveyStatus): boolean {
  return allowedSurveyTransitions(from).includes(to);
}

export function isSurveyTerminal(status: SurveyStatus): boolean {
  return allowedSurveyTransitions(status).length === 0;
}

/**
 * Whether a survey is open for participation AT THIS MOMENT.
 *
 * Status alone is not sufficient: a PUBLISHED survey whose `endsAt` has passed is
 * closed in practice even though no one has run the CLOSED transition, and one whose
 * `startsAt` is in the future has not opened yet. Both are answered here rather than
 * at each call site, so the participation route, the list `scope=available` filter
 * and the projected `canRespond` flag can never disagree.
 *
 * There is no background job that flips an expired survey to CLOSED — nothing in
 * Core schedules work — so this predicate, not the status column, is the authority
 * on whether an answer may be accepted.
 */
export function isSurveyOpen(
  survey: { status: SurveyStatus; startsAt: Date | null; endsAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (survey.status !== 'PUBLISHED') return false;
  if (survey.startsAt && survey.startsAt.getTime() > now.getTime()) return false;
  if (survey.endsAt && survey.endsAt.getTime() <= now.getTime()) return false;
  return true;
}
