import { coreDelete, coreGet, corePatch, corePost } from './core-http';

/**
 * Phase 49H: Surveys / Participation client.
 *
 * Mirrors the backend contract exactly (`GET /surveys`, `POST /surveys`,
 * `GET /surveys/:id`, `PATCH /surveys/:id`, `PATCH /surveys/:id/status`,
 * `DELETE /surveys/:id`, `POST /surveys/:id/responses`, `GET /surveys/:id/results`).
 *
 * No function here accepts a `createdById`, `userId` or tenant identifier: the backend
 * derives the actor from the authenticated identity, and the query DTO runs under
 * `forbidNonWhitelisted`, so sending one would be rejected outright. The client is
 * therefore structurally incapable of acting as someone else, or of asking for another
 * tenant's surveys.
 *
 * `status`, `publishedAt` and `closedAt` are likewise never sent on create or edit —
 * the lifecycle moves only through the dedicated status call.
 */

export type SurveyStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED';

export type SurveyQuestionType = 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'TEXT' | 'RATING';

/**
 * Exactly the person fields the backend projects for a survey author. Email, status
 * and tenantId are deliberately absent — they never reach the client.
 */
export interface SurveyUser {
  id: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  jobTitle: string | null;
}

export interface SurveyOption {
  id: string;
  label: string;
  order: number;
}

export interface SurveyQuestion {
  id: string;
  type: SurveyQuestionType;
  text: string;
  isRequired: boolean;
  order: number;
  maxSelections: number | null;
  options: SurveyOption[];
}

export interface Survey {
  id: string;
  title: string;
  description: string | null;
  status: SurveyStatus;
  isAnonymous: boolean;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: SurveyUser;
  questionCount: number;
  /** True when the caller may author/edit this survey. */
  canManage: boolean;
  /** True when the caller may read this survey's aggregated results. */
  canViewResults: boolean;
  /** True when the survey is open AND the caller has not already responded. */
  canRespond: boolean;
  hasResponded: boolean;
  /** Transitions the caller can perform right now; empty for a participant. */
  availableTransitions: SurveyStatus[];
}

export interface SurveyDetail extends Survey {
  questions: SurveyQuestion[];
}

export interface SurveyOptionResult {
  optionId: string;
  label: string;
  order: number;
  count: number;
}

export interface SurveyQuestionResult {
  questionId: string;
  type: SurveyQuestionType;
  text: string;
  order: number;
  /** Number of responses that answered THIS question, not the survey total. */
  answeredCount: number;
  options: SurveyOptionResult[];
  ratingAverage: number | null;
  ratingDistribution: { value: number; count: number }[];
  textAnswers: string[];
}

/**
 * Aggregated results.
 *
 * There is NO respondent identifier of any kind in this shape — no user id, email,
 * employee code or response id — because the backend does not project one and has no
 * per-respondent results endpoint at all.
 *
 * AGGREGATION THRESHOLD POLICY: NOT DEFINED. The backend enforces no minimum
 * respondent count, so on an anonymous survey with a single respondent the aggregate
 * IS that person's answer set. The UI states that identities are not shown to results
 * viewers; it must not claim that respondents cannot be identified.
 */
export interface SurveyResults {
  surveyId: string;
  title: string;
  status: SurveyStatus;
  isAnonymous: boolean;
  responseCount: number;
  questions: SurveyQuestionResult[];
}

export interface SurveySubmissionResult {
  responseId: string;
  surveyId: string;
  submittedAt: string;
}

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface SurveyQuery {
  cursor?: string;
  limit?: number;
  scope?: 'available' | 'mine' | 'all';
  status?: SurveyStatus;
}

/** Backend defaults, caps and bounds, mirrored so the UI never asks for more. */
export const SURVEY_PAGE_SIZE = 20;
export const SURVEY_MAX_PAGE_SIZE = 100;
export const MAX_SURVEY_TITLE = 200;
export const MAX_SURVEY_DESCRIPTION = 2000;
export const MAX_QUESTION_TEXT = 500;
export const MAX_OPTION_LABEL = 200;
export const MAX_ANSWER_TEXT = 2000;
export const MAX_QUESTIONS_PER_SURVEY = 50;
export const MAX_OPTIONS_PER_QUESTION = 20;
export const MIN_RATING = 1;
export const MAX_RATING = 5;

/** Persian question-type labels. Presentation only. */
const QUESTION_TYPE_LABELS: Record<SurveyQuestionType, string> = {
  SINGLE_CHOICE: 'تک‌گزینه‌ای',
  MULTIPLE_CHOICE: 'چندگزینه‌ای',
  TEXT: 'پاسخ متنی',
  RATING: 'امتیازی',
};

export function surveyQuestionTypeLabel(type: SurveyQuestionType): string {
  return QUESTION_TYPE_LABELS[type] ?? 'نامشخص';
}

/** Persian status labels. Presentation only; the server owns the lifecycle. */
const SURVEY_STATUS_LABELS: Record<SurveyStatus, string> = {
  DRAFT: 'پیش‌نویس',
  PUBLISHED: 'منتشرشده',
  CLOSED: 'بسته‌شده',
};

export function surveyStatusLabel(status: SurveyStatus): string {
  return SURVEY_STATUS_LABELS[status] ?? status;
}

const SURVEY_SCOPE_LABELS: Record<NonNullable<SurveyQuery['scope']>, string> = {
  available: 'قابل پاسخ',
  mine: 'ساخته‌شده توسط من',
  all: 'همه',
};

export function surveyScopeLabel(scope: NonNullable<SurveyQuery['scope']>): string {
  return SURVEY_SCOPE_LABELS[scope];
}

/** True when a choice question accepts more than one option. */
export function isMultiSelect(question: SurveyQuestion): boolean {
  return question.type === 'MULTIPLE_CHOICE';
}

function buildSurveyQuery(query: SurveyQuery): string {
  const params = new URLSearchParams();

  if (query.cursor) params.set('cursor', query.cursor);
  if (typeof query.limit === 'number') {
    params.set('limit', String(Math.min(query.limit, SURVEY_MAX_PAGE_SIZE)));
  }
  if (query.scope) params.set('scope', query.scope);
  if (query.status) params.set('status', query.status);

  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

export function listSurveys(query: SurveyQuery = {}): Promise<PageResult<Survey>> {
  return coreGet<PageResult<Survey>>(`/surveys${buildSurveyQuery(query)}`);
}

export function getSurvey(id: string): Promise<SurveyDetail> {
  return coreGet<SurveyDetail>(`/surveys/${encodeURIComponent(id)}`);
}

/** One question in an authoring payload. `order` is the array index, assigned server-side. */
export interface SurveyQuestionInput {
  type: SurveyQuestionType;
  text: string;
  isRequired?: boolean;
  maxSelections?: number;
  options?: { label: string }[];
}

export interface SurveyInput {
  title: string;
  description?: string;
  isAnonymous?: boolean;
  startsAt?: string;
  endsAt?: string;
  questions: SurveyQuestionInput[];
}

/**
 * Authors a survey. It is always created as a DRAFT: `status`, `publishedAt` and
 * `closedAt` are server-set and are not part of this input.
 */
export function createSurvey(input: SurveyInput): Promise<SurveyDetail> {
  return corePost<SurveyDetail>('/surveys', input);
}

/**
 * Edits a DRAFT. When `questions` is present it REPLACES the entire questionnaire —
 * a partial patch of an ordered, nested structure cannot express deletion or
 * reordering. The server refuses the whole request once the survey has left DRAFT.
 */
export function updateSurvey(id: string, input: Partial<SurveyInput>): Promise<SurveyDetail> {
  return corePatch<SurveyDetail>(`/surveys/${encodeURIComponent(id)}`, input);
}

/**
 * Lifecycle transition. Only statuses listed in the survey's `availableTransitions`
 * are offered, so the UI cannot propose a move the server would refuse. There is no
 * 'DRAFT' target: publishing is irreversible.
 */
export function changeSurveyStatus(
  id: string,
  status: 'PUBLISHED' | 'CLOSED'
): Promise<SurveyDetail> {
  return corePatch<SurveyDetail>(`/surveys/${encodeURIComponent(id)}/status`, { status });
}

/** Deletes a DRAFT. A published survey is closed, never deleted. */
export function deleteSurvey(id: string): Promise<{ deleted: true; id: string }> {
  return coreDelete<{ deleted: true; id: string }>(`/surveys/${encodeURIComponent(id)}`);
}

/**
 * Submits the caller's one and only response. There is no `userId` in the payload:
 * the respondent is the authenticated subject. A second submission is refused
 * server-side with 409, which the UI surfaces rather than retrying.
 */
export function submitSurveyResponse(
  id: string,
  answers: {
    questionId: string;
    optionIds?: string[];
    textValue?: string;
    ratingValue?: number;
  }[]
): Promise<SurveySubmissionResult> {
  return corePost<SurveySubmissionResult>(`/surveys/${encodeURIComponent(id)}/responses`, {
    answers,
  });
}

/**
 * Aggregated results. Requires `admin.surveys.results` server-side — a DIFFERENT
 * permission from the one that allows authoring, so a 403 here does not imply the
 * caller cannot edit the survey.
 */
export function getSurveyResults(id: string): Promise<SurveyResults> {
  return coreGet<SurveyResults>(`/surveys/${encodeURIComponent(id)}/results`);
}

/** Display name for a survey author. Falls back to a neutral label, never to an email. */
export function surveyUserName(user: SurveyUser | null | undefined): string {
  if (!user) return 'نامشخص';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'کاربر';
}

/**
 * Persian absolute date/time. Deliberately absolute rather than relative, matching
 * `formatTicketTime` (49G): no new date library is introduced and the value stays
 * stable between renders.
 */
export function formatSurveyTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('fa-IR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

/**
 * Whole-percent share of `count` in `total`, for the results bars.
 *
 * Returns 0 when `total` is 0 rather than NaN, so an unanswered question renders an
 * empty bar instead of a broken one.
 */
export function sharePercent(count: number, total: number): number {
  if (!Number.isFinite(count) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((count / total) * 100);
}
