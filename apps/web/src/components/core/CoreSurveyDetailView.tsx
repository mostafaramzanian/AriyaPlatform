'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Pencil } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  MAX_ANSWER_TEXT,
  MAX_RATING,
  MIN_RATING,
  changeSurveyStatus,
  deleteSurvey,
  formatSurveyTime,
  getSurvey,
  getSurveyResults,
  isMultiSelect,
  sharePercent,
  submitSurveyResponse,
  surveyQuestionTypeLabel,
  surveyUserName,
  type SurveyDetail,
  type SurveyQuestion,
  type SurveyResults,
} from '@/lib/surveys-api';
import { CoreError, CoreForbidden, CoreLoading } from './CoreStates';
import { SurveyStatusBadge } from './CoreSurveysView';

/**
 * Phase 49H: survey detail, participation form and results panel.
 *
 * Three capabilities live on this page and they are gated three DIFFERENT ways, all
 * decided server-side and merely reflected here:
 *
 *  - participation — ungated by permission; `canRespond` is false once the window
 *    closes or the caller has already responded.
 *  - authoring     — `canManage`, backed by `admin.surveys.manage`.
 *  - results       — `canViewResults`, backed by the SEPARATE
 *    `admin.surveys.results`. A manager without it sees no results panel, and the
 *    panel's own 403 is reported rather than silently swallowed.
 *
 * Every question text, option label and free-text answer is rendered as text. No
 * `dangerouslySetInnerHTML` anywhere, including the results panel, which echoes
 * respondent-authored strings.
 */

/** Draft answers, keyed by question id. Only one branch is used per question type. */
interface AnswerDraft {
  optionIds: string[];
  textValue: string;
  ratingValue: number | null;
}

const EMPTY_DRAFT: AnswerDraft = { optionIds: [], textValue: '', ratingValue: null };

/**
 * Turns the draft map into the wire payload, dropping questions the user left blank.
 *
 * Blank optional answers are omitted rather than sent as empty values, so an untouched
 * optional question does not become a recorded empty answer. Required-but-blank is not
 * filtered out here — it is caught by `firstMissingRequired` before submit.
 */
function toAnswers(questions: SurveyQuestion[], drafts: Record<string, AnswerDraft>) {
  const answers: Array<{
    questionId: string;
    optionIds?: string[];
    textValue?: string;
    ratingValue?: number;
  }> = [];

  for (const question of questions) {
    const draft = drafts[question.id] ?? EMPTY_DRAFT;

    if (question.type === 'SINGLE_CHOICE' || question.type === 'MULTIPLE_CHOICE') {
      if (draft.optionIds.length > 0) {
        answers.push({ questionId: question.id, optionIds: draft.optionIds });
      }
      continue;
    }

    if (question.type === 'TEXT') {
      const trimmed = draft.textValue.trim();
      if (trimmed.length > 0) answers.push({ questionId: question.id, textValue: trimmed });
      continue;
    }

    if (draft.ratingValue !== null) {
      answers.push({ questionId: question.id, ratingValue: draft.ratingValue });
    }
  }

  return answers;
}

/** First required question with nothing filled in, or null when the form is complete. */
function firstMissingRequired(
  questions: SurveyQuestion[],
  drafts: Record<string, AnswerDraft>
): SurveyQuestion | null {
  for (const question of questions) {
    if (!question.isRequired) continue;
    const draft = drafts[question.id] ?? EMPTY_DRAFT;

    if (question.type === 'SINGLE_CHOICE' || question.type === 'MULTIPLE_CHOICE') {
      if (draft.optionIds.length === 0) return question;
    } else if (question.type === 'TEXT') {
      if (draft.textValue.trim().length === 0) return question;
    } else if (draft.ratingValue === null) {
      return question;
    }
  }

  return null;
}

export function CoreSurveyDetailView({ surveyId }: { surveyId: string }) {
  const router = useRouter();
  const [survey, setSurvey] = React.useState<SurveyDetail | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in the retry/submission handlers below (same commit
  // as the token bump), so the survey effect needs no in-effect setter resets.
  // First mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  // Record-change reset, synchronously during render (guarded by the previous
  // id) — never in the effect body (`react-hooks/set-state-in-effect`): drop
  // the stale survey and re-arm the survey read. The results states follow in
  // their own adjustment below (they key off the re-armed survey/data too).
  const [prevSurveyId, setPrevSurveyId] = React.useState(surveyId);
  if (prevSurveyId !== surveyId) {
    setPrevSurveyId(surveyId);
    setSurvey(null);
    setIsLoading(true);
    setError(null);
  }

  const [drafts, setDrafts] = React.useState<Record<string, AnswerDraft>>({});
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submittedAt, setSubmittedAt] = React.useState<string | null>(null);

  const [results, setResults] = React.useState<SurveyResults | null>(null);
  const [resultsError, setResultsError] = React.useState<string | null>(null);
  const [isResultsLoading, setIsResultsLoading] = React.useState(false);

  const [statusBusy, setStatusBusy] = React.useState(false);
  const [statusError, setStatusError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    getSurvey(surveyId)
      .then((data) => {
        if (cancelled) return;
        setSurvey(data);
        // Reset drafts to a clean map for exactly this survey's questions.
        const next: Record<string, AnswerDraft> = {};
        for (const question of data.questions) next[question.id] = { ...EMPTY_DRAFT };
        setDrafts(next);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSurvey(null);
        setError({
          message: err instanceof Error ? err.message : 'دریافت نظرسنجی با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [surveyId, reloadToken]);

  // Results are fetched only when the server says this caller may read them, and only
  // after the survey itself resolves — never speculatively.
  //
  // Clears/re-arms happen synchronously during render, guarded by the inputs
  // that drive this read (the id change and the can-view gate) — never in the
  // effect body (`react-hooks/set-state-in-effect`): the effect below only
  // settles. The gate-close path also resets `isResultsLoading` so a
  // permission flip can never strand the spinner (`setResults(null)` alone
  // would leave the loading flag untouched).
  const canViewResults = survey?.canViewResults === true;
  const [prevResultsKey, setPrevResultsKey] = React.useState(canViewResults);
  if (prevResultsKey !== canViewResults) {
    setPrevResultsKey(canViewResults);
    if (canViewResults) {
      setResults(null);
      setResultsError(null);
      setIsResultsLoading(true);
    } else {
      setResults(null);
      setResultsError(null);
      setIsResultsLoading(false);
    }
  }
  const [prevResultsSurveyId, setPrevResultsSurveyId] = React.useState(surveyId);
  if (prevResultsSurveyId !== surveyId) {
    setPrevResultsSurveyId(surveyId);
    setResults(null);
    setResultsError(null);
    setIsResultsLoading(false);
  }

  React.useEffect(() => {
    if (!canViewResults) return;

    let cancelled = false;

    getSurveyResults(surveyId)
      .then((data) => {
        if (cancelled) return;
        setResults(data);
        setIsResultsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResults(null);
        setResultsError(
          err instanceof CoreApiError && err.status === 403
            ? 'شما به نتایج این نظرسنجی دسترسی ندارید.'
            : 'دریافت نتایج با خطا مواجه شد.'
        );
        setIsResultsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [surveyId, canViewResults, submittedAt]);

  const setDraft = (questionId: string, patch: Partial<AnswerDraft>) => {
    setDrafts((prev) => ({
      ...prev,
      [questionId]: { ...(prev[questionId] ?? EMPTY_DRAFT), ...patch },
    }));
  };

  /** Multi-choice toggle. `maxSelections` is enforced here and again server-side. */
  const toggleOption = (question: SurveyQuestion, optionId: string) => {
    const current = drafts[question.id]?.optionIds ?? [];
    const isSelected = current.includes(optionId);

    if (!isMultiSelect(question)) {
      setDraft(question.id, { optionIds: isSelected ? [] : [optionId] });
      return;
    }

    if (isSelected) {
      setDraft(question.id, { optionIds: current.filter((id) => id !== optionId) });
      return;
    }

    const cap = question.maxSelections;
    if (typeof cap === 'number' && current.length >= cap) {
      setFormError(`برای این پرسش حداکثر ${cap.toLocaleString('fa-IR')} گزینه قابل انتخاب است.`);
      return;
    }

    setFormError(null);
    setDraft(question.id, { optionIds: [...current, optionId] });
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!survey || isSubmitting) return;

    const missing = firstMissingRequired(survey.questions, drafts);
    if (missing) {
      setFormError('پاسخ به پرسش‌های الزامی ضروری است.');
      return;
    }

    const answers = toAnswers(survey.questions, drafts);
    if (answers.length === 0) {
      setFormError('حداقل به یک پرسش پاسخ دهید.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    try {
      const result = await submitSurveyResponse(surveyId, answers);
      setSubmittedAt(result.submittedAt);
      // Re-read the survey so `hasResponded` / `canRespond` come from the server
      // rather than being assumed client-side. The results list re-reads off
      // `submittedAt` — re-armed here in the same commit (the removed in-effect
      // arm used to run one render later).
      setResults(null);
      setResultsError(null);
      setIsResultsLoading(true);
      reload();
    } catch (err: unknown) {
      // 409 means a response already exists. Retrying cannot succeed, so the state is
      // reported and the form is closed by the reload instead.
      if (err instanceof CoreApiError && err.status === 409) {
        setFormError('شما پیش‌تر به این نظرسنجی پاسخ داده‌اید.');
        reload();
      } else {
        setFormError(err instanceof Error ? err.message : 'ثبت پاسخ با خطا مواجه شد.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Only transitions the server listed in `availableTransitions` are ever sent. */
  const handleStatusChange = async (next: 'PUBLISHED' | 'CLOSED') => {
    if (!survey || statusBusy) return;

    setStatusBusy(true);
    setStatusError(null);

    try {
      const updated = await changeSurveyStatus(surveyId, next);
      setSurvey(updated);
    } catch (err: unknown) {
      setStatusError(err instanceof Error ? err.message : 'تغییر وضعیت با خطا مواجه شد.');
    } finally {
      setStatusBusy(false);
    }
  };

  /** Deletion is offered only while DRAFT; a published survey is closed, not deleted. */
  const handleDelete = async () => {
    if (!survey || statusBusy) return;
    if (!window.confirm('این نظرسنجی پیش‌نویس حذف شود؟ این عمل بازگشت‌پذیر نیست.')) return;

    setStatusBusy(true);
    setStatusError(null);

    try {
      await deleteSurvey(surveyId);
      router.push('/admin/surveys');
    } catch (err: unknown) {
      setStatusError(err instanceof Error ? err.message : 'حذف نظرسنجی با خطا مواجه شد.');
      setStatusBusy(false);
    }
  };

  if (isLoading) {
    return <CoreLoading label="در حال بارگذاری نظرسنجی..." lines={5} />;
  }

  if (error?.status === 403) {
    return <CoreForbidden message="شما به این نظرسنجی دسترسی ندارید." />;
  }

  if (error?.status === 404) {
    return <CoreError message="نظرسنجی مورد نظر یافت نشد." />;
  }

  if (error || !survey) {
    return (
      <CoreError
        message={error?.message ?? 'نظرسنجی مورد نظر یافت نشد.'}
        onRetry={reload}
      />
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/admin/surveys"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
        بازگشت به نظرسنجی‌ها
      </Link>

      <header className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold text-foreground">{survey.title}</h1>
            <p className="text-xs text-muted-foreground">
              سازنده: {surveyUserName(survey.createdBy)} — ایجاد:{' '}
              {formatSurveyTime(survey.createdAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {survey.isAnonymous && (
              <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">
                بی‌نام
              </span>
            )}
            <SurveyStatusBadge status={survey.status} />
          </div>
        </div>

        {survey.description && (
          <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
            {survey.description}
          </p>
        )}

        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {survey.startsAt && (
            <div className="flex gap-1">
              <dt>شروع:</dt>
              <dd>{formatSurveyTime(survey.startsAt)}</dd>
            </div>
          )}
          {survey.endsAt && (
            <div className="flex gap-1">
              <dt>پایان:</dt>
              <dd>{formatSurveyTime(survey.endsAt)}</dd>
            </div>
          )}
          <div className="flex gap-1">
            <dt>پرسش‌ها:</dt>
            <dd>{survey.questions.length.toLocaleString('fa-IR')}</dd>
          </div>
        </dl>

        {survey.canManage && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {survey.status === 'DRAFT' && (
              <Link
                href={`/admin/surveys/${survey.id}/edit`}
                className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
                ویرایش
              </Link>
            )}

            {survey.availableTransitions
              .filter((next): next is 'PUBLISHED' | 'CLOSED' => next !== 'DRAFT')
              .map((next) => (
                <button
                  key={next}
                  type="button"
                  onClick={() => handleStatusChange(next)}
                  disabled={statusBusy}
                  data-testid={`survey-transition-${next}`}
                  className="rounded-xl border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {next === 'PUBLISHED' ? 'انتشار' : 'بستن'}
                </button>
              ))}

            {survey.status === 'DRAFT' && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={statusBusy}
                className="rounded-xl border border-destructive/40 px-3 py-1.5 text-sm text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                حذف پیش‌نویس
              </button>
            )}
          </div>
        )}

        {statusError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {statusError}
          </p>
        )}
      </header>

      {survey.hasResponded && (
        <p
          data-testid="survey-already-responded"
          className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-400"
        >
          پاسخ شما ثبت شده است. هر کاربر تنها یک‌بار می‌تواند پاسخ دهد.
        </p>
      )}

      {!survey.hasResponded && !survey.canRespond && (
        <p className="rounded-2xl border border-border bg-muted p-4 text-sm text-muted-foreground">
          در حال حاضر امکان پاسخ‌دهی به این نظرسنجی وجود ندارد.
        </p>
      )}

      {survey.canRespond && (
        <form onSubmit={handleSubmit} className="space-y-4" data-testid="survey-response-form">
          {survey.questions.map((question, index) => {
            const draft = drafts[question.id] ?? EMPTY_DRAFT;

            return (
              <fieldset key={question.id} className="rounded-2xl border border-border bg-card p-4">
                <legend className="px-1 text-sm font-medium text-foreground">
                  {(index + 1).toLocaleString('fa-IR')}. {question.text}
                  {question.isRequired && (
                    <span className="text-destructive" aria-hidden="true">
                      {' *'}
                    </span>
                  )}
                </legend>

                <p className="mt-1 text-xs text-muted-foreground">
                  {surveyQuestionTypeLabel(question.type)}
                  {isMultiSelect(question) && typeof question.maxSelections === 'number' && (
                    <>
                      {' — حداکثر '}
                      {question.maxSelections.toLocaleString('fa-IR')} گزینه
                    </>
                  )}
                </p>

                {(question.type === 'SINGLE_CHOICE' || question.type === 'MULTIPLE_CHOICE') && (
                  <div className="mt-3 space-y-2">
                    {question.options.map((option) => (
                      <label
                        key={option.id}
                        className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                      >
                        <input
                          type={isMultiSelect(question) ? 'checkbox' : 'radio'}
                          name={`question-${question.id}`}
                          checked={draft.optionIds.includes(option.id)}
                          onChange={() => toggleOption(question, option.id)}
                          className="h-4 w-4 accent-primary"
                        />
                        <span>{option.label}</span>
                      </label>
                    ))}
                  </div>
                )}

                {question.type === 'TEXT' && (
                  <div className="mt-3 space-y-1">
                    <textarea
                      value={draft.textValue}
                      onChange={(event) => setDraft(question.id, { textValue: event.target.value })}
                      maxLength={MAX_ANSWER_TEXT}
                      rows={4}
                      aria-label={question.text}
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <p className="text-left text-[11px] text-muted-foreground">
                      {draft.textValue.length.toLocaleString('fa-IR')} /{' '}
                      {MAX_ANSWER_TEXT.toLocaleString('fa-IR')}
                    </p>
                  </div>
                )}

                {question.type === 'RATING' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {Array.from(
                      { length: MAX_RATING - MIN_RATING + 1 },
                      (_, offset) => MIN_RATING + offset
                    ).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setDraft(question.id, { ratingValue: value })}
                        aria-pressed={draft.ratingValue === value}
                        className={
                          draft.ratingValue === value
                            ? 'h-9 w-9 rounded-xl border border-primary bg-primary text-sm text-primary-foreground'
                            : 'h-9 w-9 rounded-xl border border-border bg-background text-sm text-foreground transition hover:bg-muted'
                        }
                      >
                        {value.toLocaleString('fa-IR')}
                      </button>
                    ))}
                  </div>
                )}
              </fieldset>
            );
          })}

          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            data-testid="survey-submit"
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isSubmitting ? 'در حال ثبت...' : 'ثبت پاسخ'}
          </button>
        </form>
      )}

      {survey.canViewResults && (
        <section className="space-y-3" data-testid="survey-results">
          <h2 className="text-lg font-semibold text-foreground">نتایج</h2>

          {/*
            Anonymity notice. Worded as a statement about what results VIEWERS see,
            because the backend enforces no minimum-respondent threshold — with a
            single respondent the aggregate is that person's answer set. It therefore
            must not promise that respondents cannot be identified.
          */}
          <p className="rounded-2xl border border-border bg-muted p-4 text-sm text-muted-foreground">
            هویت پاسخ‌دهندگان برای مشاهده‌کنندگان نتایج نمایش داده نمی‌شود.
          </p>

          {isResultsLoading && <CoreLoading label="در حال بارگذاری نتایج..." lines={3} />}

          {!isResultsLoading && resultsError && <CoreError message={resultsError} />}

          {!isResultsLoading && !resultsError && results && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                تعداد پاسخ‌ها: {results.responseCount.toLocaleString('fa-IR')}
              </p>

              {results.questions.map((question) => (
                <article
                  key={question.questionId}
                  className="rounded-2xl border border-border bg-card p-4"
                >
                  <h3 className="text-sm font-medium text-foreground">{question.text}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {surveyQuestionTypeLabel(question.type)} — پاسخ‌داده‌شده:{' '}
                    {question.answeredCount.toLocaleString('fa-IR')}
                  </p>

                  {question.options.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {question.options.map((option) => {
                        const percent = sharePercent(option.count, question.answeredCount);
                        return (
                          <li key={option.optionId} className="space-y-1">
                            <div className="flex items-center justify-between gap-2 text-xs text-foreground">
                              <span>{option.label}</span>
                              <span className="text-muted-foreground">
                                {option.count.toLocaleString('fa-IR')} (
                                {percent.toLocaleString('fa-IR')}٪)
                              </span>
                            </div>
                            {/* CSS bar — no chart library is introduced. */}
                            <div
                              className="h-2 w-full overflow-hidden rounded-full bg-muted"
                              role="presentation"
                            >
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  {question.type === 'RATING' && (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        میانگین:{' '}
                        {question.ratingAverage === null
                          ? '—'
                          : question.ratingAverage.toLocaleString('fa-IR', {
                              maximumFractionDigits: 2,
                            })}
                      </p>
                      <ul className="space-y-2">
                        {question.ratingDistribution.map((bucket) => {
                          const percent = sharePercent(bucket.count, question.answeredCount);
                          return (
                            <li key={bucket.value} className="space-y-1">
                              <div className="flex items-center justify-between gap-2 text-xs text-foreground">
                                <span>{bucket.value.toLocaleString('fa-IR')}</span>
                                <span className="text-muted-foreground">
                                  {bucket.count.toLocaleString('fa-IR')} (
                                  {percent.toLocaleString('fa-IR')}٪)
                                </span>
                              </div>
                              <div
                                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                                role="presentation"
                              >
                                <div
                                  className="h-full rounded-full bg-primary"
                                  style={{ width: `${percent}%` }}
                                />
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {question.type === 'TEXT' && (
                    <ul className="mt-3 space-y-2">
                      {question.textAnswers.length === 0 && (
                        <li className="text-xs text-muted-foreground">پاسخ متنی ثبت نشده است.</li>
                      )}
                      {question.textAnswers.map((answer, index) => (
                        <li
                          key={index}
                          className="whitespace-pre-wrap rounded-xl border border-border bg-background p-3 text-sm text-foreground"
                        >
                          {answer}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
