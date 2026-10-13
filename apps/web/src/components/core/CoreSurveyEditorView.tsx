'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Plus, Trash2 } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  MAX_OPTIONS_PER_QUESTION,
  MAX_OPTION_LABEL,
  MAX_QUESTIONS_PER_SURVEY,
  MAX_QUESTION_TEXT,
  MAX_SURVEY_DESCRIPTION,
  MAX_SURVEY_TITLE,
  createSurvey,
  getSurvey,
  surveyQuestionTypeLabel,
  updateSurvey,
  type SurveyInput,
  type SurveyQuestionInput,
  type SurveyQuestionType,
} from '@/lib/surveys-api';
import { useCorePermissions } from './useCorePermissions';
import { CoreError, CoreForbidden, CoreLoading } from './CoreStates';

/**
 * Phase 49H: questionnaire builder, shared by `/admin/surveys/new` and
 * `/admin/surveys/[id]/edit`.
 *
 * Gating: the page is hidden behind `admin.surveys.manage` via `useCorePermissions`,
 * which is presentation-only — `POST /surveys` and `PATCH /surveys/:id` enforce the
 * same permission server-side, and editing is additionally refused once the survey has
 * left DRAFT.
 *
 * On edit, submitting sends the WHOLE `questions` array because the backend replaces
 * the questionnaire wholesale; a partial patch cannot express deletion or reordering.
 * That also means editing after publication is impossible by design, so this view
 * reports the server's 409 rather than trying to merge.
 *
 * `status` is never part of the payload: creation always yields a DRAFT and lifecycle
 * moves happen on the detail page through `availableTransitions`.
 */

const MANAGE_PERMISSION = 'admin.surveys.manage';

const QUESTION_TYPES: SurveyQuestionType[] = ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TEXT', 'RATING'];

/** A question while being edited. `key` is local only and never sent. */
interface DraftQuestion {
  key: string;
  type: SurveyQuestionType;
  text: string;
  isRequired: boolean;
  /** Empty means "no cap"; only meaningful for MULTIPLE_CHOICE. */
  maxSelections: string;
  options: Array<{ key: string; label: string }>;
}

let keyCounter = 0;
const nextKey = () => `q${++keyCounter}`;

function blankOption() {
  return { key: nextKey(), label: '' };
}

function blankQuestion(): DraftQuestion {
  return {
    key: nextKey(),
    type: 'SINGLE_CHOICE',
    text: '',
    isRequired: true,
    maxSelections: '',
    options: [blankOption(), blankOption()],
  };
}

function isChoice(type: SurveyQuestionType): boolean {
  return type === 'SINGLE_CHOICE' || type === 'MULTIPLE_CHOICE';
}

/**
 * Validates the whole form against the same bounds the DTO enforces, so the common
 * mistakes are reported inline instead of coming back as a 400. The server remains the
 * authority: this is a convenience check, not the enforcement point.
 */
function validate(title: string, description: string, questions: DraftQuestion[]): string | null {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0) return 'عنوان نظرسنجی الزامی است.';
  if (trimmedTitle.length > MAX_SURVEY_TITLE) {
    return `عنوان نمی‌تواند بیش از ${MAX_SURVEY_TITLE.toLocaleString('fa-IR')} نویسه باشد.`;
  }
  if (description.trim().length > MAX_SURVEY_DESCRIPTION) {
    return `توضیحات نمی‌تواند بیش از ${MAX_SURVEY_DESCRIPTION.toLocaleString('fa-IR')} نویسه باشد.`;
  }
  if (questions.length === 0) return 'حداقل یک پرسش لازم است.';
  if (questions.length > MAX_QUESTIONS_PER_SURVEY) {
    return `حداکثر ${MAX_QUESTIONS_PER_SURVEY.toLocaleString('fa-IR')} پرسش مجاز است.`;
  }

  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const position = (index + 1).toLocaleString('fa-IR');

    if (question.text.trim().length === 0) return `متن پرسش ${position} الزامی است.`;
    if (question.text.trim().length > MAX_QUESTION_TEXT) {
      return `متن پرسش ${position} بیش از حد مجاز است.`;
    }

    if (!isChoice(question.type)) continue;

    const labels = question.options.map((option) => option.label.trim());
    if (labels.some((label) => label.length === 0)) {
      return `گزینه‌های پرسش ${position} نمی‌توانند خالی باشند.`;
    }
    if (labels.length < 2) return `پرسش ${position} حداقل به دو گزینه نیاز دارد.`;
    if (labels.length > MAX_OPTIONS_PER_QUESTION) {
      return `پرسش ${position} بیش از ${MAX_OPTIONS_PER_QUESTION.toLocaleString('fa-IR')} گزینه دارد.`;
    }
    if (labels.some((label) => label.length > MAX_OPTION_LABEL)) {
      return `یکی از گزینه‌های پرسش ${position} بیش از حد مجاز است.`;
    }
    // Duplicate labels are rejected by the backend's per-question unique index.
    if (new Set(labels).size !== labels.length) {
      return `گزینه‌های پرسش ${position} تکراری هستند.`;
    }

    if (question.type === 'MULTIPLE_CHOICE' && question.maxSelections.trim().length > 0) {
      const cap = Number(question.maxSelections);
      if (!Number.isInteger(cap) || cap < 1 || cap > labels.length) {
        return `حداکثر انتخاب پرسش ${position} باید عددی بین ۱ و تعداد گزینه‌ها باشد.`;
      }
    }
  }

  return null;
}

/** Draft questions → wire payload. Ordering is positional; no `order` field is sent. */
function toQuestionInputs(questions: DraftQuestion[]): SurveyQuestionInput[] {
  return questions.map((question) => {
    const base: SurveyQuestionInput = {
      type: question.type,
      text: question.text.trim(),
      isRequired: question.isRequired,
    };

    if (!isChoice(question.type)) return base;

    base.options = question.options.map((option) => ({ label: option.label.trim() }));

    if (question.type === 'MULTIPLE_CHOICE' && question.maxSelections.trim().length > 0) {
      base.maxSelections = Number(question.maxSelections);
    }

    return base;
  });
}

export function CoreSurveyEditorView({ surveyId }: { surveyId?: string }) {
  const router = useRouter();
  const isEdit = typeof surveyId === 'string' && surveyId.length > 0;
  const { permissions, isLoading: isPermissionsLoading } = useCorePermissions(true);
  const canManage = permissions.includes(MANAGE_PERMISSION);

  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [isAnonymous, setIsAnonymous] = React.useState(false);
  // `datetime-local` values; converted to ISO on submit and omitted when blank.
  const [startsAt, setStartsAt] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [questions, setQuestions] = React.useState<DraftQuestion[]>([blankQuestion()]);

  const [isLoading, setIsLoading] = React.useState(isEdit);
  const [loadError, setLoadError] = React.useState<{
    message: string;
    status: number | null;
  } | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the load effect needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setLoadError);
  // Record-change reset, synchronously during render (guarded by the previous
  // id) — never in the effect body (`react-hooks/set-state-in-effect`): re-arm
  // the load. First mount is covered by the initial `isLoading: isEdit`.
  const [prevSurveyId, setPrevSurveyId] = React.useState(surveyId);
  if (prevSurveyId !== surveyId) {
    setPrevSurveyId(surveyId);
    setIsLoading(true);
    setLoadError(null);
  }
  const [isSaving, setIsSaving] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  /** `datetime-local` needs `YYYY-MM-DDTHH:mm` in local time, not the raw ISO string. */
  const toLocalInput = (iso: string | null): string => {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
      date.getHours()
    )}:${pad(date.getMinutes())}`;
  };

  React.useEffect(() => {
    if (!isEdit || !canManage) return;

    let cancelled = false;

    getSurvey(surveyId)
      .then((survey) => {
        if (cancelled) return;

        setTitle(survey.title);
        setDescription(survey.description ?? '');
        setIsAnonymous(survey.isAnonymous);
        setStartsAt(toLocalInput(survey.startsAt));
        setEndsAt(toLocalInput(survey.endsAt));
        setQuestions(
          survey.questions.map((question) => ({
            key: nextKey(),
            type: question.type,
            text: question.text,
            isRequired: question.isRequired,
            maxSelections: question.maxSelections === null ? '' : String(question.maxSelections),
            options: question.options.map((option) => ({
              key: nextKey(),
              label: option.label,
            })),
          }))
        );

        // A non-DRAFT survey cannot be edited at all — say so instead of presenting a
        // form whose every submission would 409.
        if (survey.status !== 'DRAFT') {
          setLoadError({
            message: 'تنها نظرسنجی‌های پیش‌نویس قابل ویرایش هستند.',
            status: 409,
          });
        }

        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError({
          message: err instanceof Error ? err.message : 'دریافت نظرسنجی با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isEdit, canManage, surveyId, reloadToken]);

  const patchQuestion = (key: string, patch: Partial<DraftQuestion>) => {
    setQuestions((prev) =>
      prev.map((question) => (question.key === key ? { ...question, ...patch } : question))
    );
  };

  const addQuestion = () => {
    setQuestions((prev) =>
      prev.length >= MAX_QUESTIONS_PER_SURVEY ? prev : [...prev, blankQuestion()]
    );
  };

  const removeQuestion = (key: string) => {
    setQuestions((prev) => (prev.length <= 1 ? prev : prev.filter((q) => q.key !== key)));
  };

  const moveQuestion = (index: number, delta: -1 | 1) => {
    setQuestions((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addOption = (key: string) => {
    setQuestions((prev) =>
      prev.map((question) =>
        question.key === key && question.options.length < MAX_OPTIONS_PER_QUESTION
          ? { ...question, options: [...question.options, blankOption()] }
          : question
      )
    );
  };

  const removeOption = (questionKey: string, optionKey: string) => {
    setQuestions((prev) =>
      prev.map((question) =>
        question.key === questionKey && question.options.length > 2
          ? { ...question, options: question.options.filter((o) => o.key !== optionKey) }
          : question
      )
    );
  };

  const patchOption = (questionKey: string, optionKey: string, label: string) => {
    setQuestions((prev) =>
      prev.map((question) =>
        question.key === questionKey
          ? {
              ...question,
              options: question.options.map((option) =>
                option.key === optionKey ? { ...option, label } : option
              ),
            }
          : question
      )
    );
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSaving) return;

    const problem = validate(title, description, questions);
    if (problem) {
      setFormError(problem);
      return;
    }

    // A window whose end precedes its start is rejected by the backend; catching it
    // here keeps the message specific.
    if (startsAt.length > 0 && endsAt.length > 0 && new Date(endsAt) <= new Date(startsAt)) {
      setFormError('زمان پایان باید بعد از زمان شروع باشد.');
      return;
    }

    const payload: SurveyInput = {
      title: title.trim(),
      isAnonymous,
      questions: toQuestionInputs(questions),
    };

    const trimmedDescription = description.trim();
    if (trimmedDescription.length > 0) payload.description = trimmedDescription;
    if (startsAt.length > 0) payload.startsAt = new Date(startsAt).toISOString();
    if (endsAt.length > 0) payload.endsAt = new Date(endsAt).toISOString();

    setIsSaving(true);
    setFormError(null);

    try {
      const saved = isEdit ? await updateSurvey(surveyId, payload) : await createSurvey(payload);
      router.push(`/admin/surveys/${saved.id}`);
    } catch (err: unknown) {
      if (err instanceof CoreApiError && err.status === 409) {
        setFormError('این نظرسنجی دیگر قابل ویرایش نیست.');
      } else {
        setFormError(err instanceof Error ? err.message : 'ذخیره نظرسنجی با خطا مواجه شد.');
      }
      setIsSaving(false);
    }
  };

  if (isPermissionsLoading) {
    return <CoreLoading label="در حال بررسی دسترسی..." lines={3} />;
  }

  if (!canManage) {
    return <CoreForbidden message="شما اجازه ساخت یا ویرایش نظرسنجی را ندارید." />;
  }

  if (isLoading) {
    return <CoreLoading label="در حال بارگذاری نظرسنجی..." lines={5} />;
  }

  if (loadError?.status === 403) {
    return <CoreForbidden message="شما به این نظرسنجی دسترسی ندارید." />;
  }

  if (loadError) {
    return (
      <div className="space-y-4">
        <CoreError
          message={loadError.message}
          {...(loadError.status === 409 ? {} : { onRetry: reload })}
        />
        <Link
          href={isEdit ? `/admin/surveys/${surveyId}` : '/admin/surveys'}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
          بازگشت
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6" data-testid="survey-editor">
      <Link
        href={isEdit ? `/admin/surveys/${surveyId}` : '/admin/surveys'}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
        بازگشت
      </Link>

      <header>
        <h1 className="text-2xl font-semibold text-foreground">
          {isEdit ? 'ویرایش نظرسنجی' : 'نظرسنجی جدید'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          نظرسنجی به‌صورت پیش‌نویس ذخیره می‌شود و انتشار آن جداگانه انجام می‌گیرد.
        </p>
      </header>

      <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
        <div className="space-y-1">
          <label htmlFor="survey-title" className="block text-sm text-foreground">
            عنوان
          </label>
          <input
            id="survey-title"
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={MAX_SURVEY_TITLE}
            required
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="survey-description" className="block text-sm text-foreground">
            توضیحات
          </label>
          <textarea
            id="survey-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={MAX_SURVEY_DESCRIPTION}
            rows={3}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="survey-starts" className="block text-sm text-foreground">
              زمان شروع (اختیاری)
            </label>
            <input
              id="survey-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="survey-ends" className="block text-sm text-foreground">
              زمان پایان (اختیاری)
            </label>
            <input
              id="survey-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
              className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={isAnonymous}
            onChange={(event) => setIsAnonymous(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>
            نظرسنجی بی‌نام
            <span className="mt-1 block text-xs text-muted-foreground">
              هویت پاسخ‌دهندگان برای مشاهده‌کنندگان نتایج نمایش داده نمی‌شود.
            </span>
          </span>
        </label>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-foreground">پرسش‌ها</h2>
          <button
            type="button"
            onClick={addQuestion}
            disabled={questions.length >= MAX_QUESTIONS_PER_SURVEY}
            data-testid="survey-add-question"
            className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            افزودن پرسش
          </button>
        </div>

        {questions.map((question, index) => (
          <fieldset
            key={question.key}
            className="space-y-3 rounded-2xl border border-border bg-card p-4"
          >
            <legend className="px-1 text-sm font-medium text-foreground">
              پرسش {(index + 1).toLocaleString('fa-IR')}
            </legend>

            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => moveQuestion(index, -1)}
                disabled={index === 0}
                aria-label="انتقال به بالا"
                className="rounded-xl border border-border px-2 py-1 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                بالا
              </button>
              <button
                type="button"
                onClick={() => moveQuestion(index, 1)}
                disabled={index === questions.length - 1}
                aria-label="انتقال به پایین"
                className="rounded-xl border border-border px-2 py-1 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                پایین
              </button>
              <button
                type="button"
                onClick={() => removeQuestion(question.key)}
                disabled={questions.length <= 1}
                aria-label="حذف پرسش"
                className="inline-flex items-center gap-1 rounded-xl border border-destructive/40 px-2 py-1 text-xs text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                حذف
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <div className="space-y-1">
                <label
                  htmlFor={`q-text-${question.key}`}
                  className="block text-xs text-muted-foreground"
                >
                  متن پرسش
                </label>
                <input
                  id={`q-text-${question.key}`}
                  type="text"
                  value={question.text}
                  onChange={(event) => patchQuestion(question.key, { text: event.target.value })}
                  maxLength={MAX_QUESTION_TEXT}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor={`q-type-${question.key}`}
                  className="block text-xs text-muted-foreground"
                >
                  نوع پرسش
                </label>
                <select
                  id={`q-type-${question.key}`}
                  value={question.type}
                  onChange={(event) =>
                    patchQuestion(question.key, {
                      type: event.target.value as SurveyQuestionType,
                      // Leaving MULTIPLE_CHOICE drops the cap so a stale value cannot
                      // be sent for a type that has no such concept.
                      maxSelections: '',
                    })
                  }
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {QUESTION_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {surveyQuestionTypeLabel(type)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={question.isRequired}
                onChange={(event) =>
                  patchQuestion(question.key, { isRequired: event.target.checked })
                }
                className="h-4 w-4 accent-primary"
              />
              پاسخ الزامی است
            </label>

            {isChoice(question.type) && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">گزینه‌ها</p>

                {question.options.map((option) => (
                  <div key={option.key} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={option.label}
                      onChange={(event) =>
                        patchOption(question.key, option.key, event.target.value)
                      }
                      maxLength={MAX_OPTION_LABEL}
                      aria-label="عنوان گزینه"
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <button
                      type="button"
                      onClick={() => removeOption(question.key, option.key)}
                      disabled={question.options.length <= 2}
                      aria-label="حذف گزینه"
                      className="rounded-xl border border-border p-2 text-muted-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => addOption(question.key)}
                  disabled={question.options.length >= MAX_OPTIONS_PER_QUESTION}
                  className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  افزودن گزینه
                </button>

                {question.type === 'MULTIPLE_CHOICE' && (
                  <div className="space-y-1">
                    <label
                      htmlFor={`q-max-${question.key}`}
                      className="block text-xs text-muted-foreground"
                    >
                      حداکثر انتخاب (خالی = بدون محدودیت)
                    </label>
                    <input
                      id={`q-max-${question.key}`}
                      type="number"
                      min={1}
                      max={question.options.length}
                      value={question.maxSelections}
                      onChange={(event) =>
                        patchQuestion(question.key, { maxSelections: event.target.value })
                      }
                      className="w-32 rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                )}
              </div>
            )}

            {question.type === 'RATING' && (
              <p className="text-xs text-muted-foreground">
                مقیاس امتیاز از ۱ تا ۵ ثابت است و در سرور اعتبارسنجی می‌شود.
              </p>
            )}
          </fieldset>
        ))}
      </section>

      {formError && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isSaving}
          data-testid="survey-save"
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isSaving ? 'در حال ذخیره...' : isEdit ? 'ذخیره تغییرات' : 'ذخیره پیش‌نویس'}
        </button>
        <Link
          href={isEdit ? `/admin/surveys/${surveyId}` : '/admin/surveys'}
          className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          انصراف
        </Link>
      </div>
    </form>
  );
}
