'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  COMMERCE_APPROVAL_DECISIONS,
  submitCommerceCommercialDecision,
  type CommerceApproval,
  type CommerceApprovalDecision,
} from '@/lib/commerce-api';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  commerceActionErrorMessage,
  commerceApprovalDecisionLabel,
  commerceApprovalStatusLabel,
  commerceInstantLabel,
} from '@/lib/commerce-labels';
import { CommerceApprovalStatusBadge, CommerceFeedback } from '../commerce-ui';
import { CommerceConfirmDialog } from '../CommerceConfirmDialog';

/** The DTO's own ceiling, restated for the counter — the server re-validates. */
export const COMMERCE_DECISION_COMMENT_MAX = 1000;

/**
 * PHASE UI-3: the focused Commercial Decision workspace (UI-0 §11.1, J5).
 *
 * WHY A PANEL AND NOT A MODAL FORM. The decider stays inside the Purchase context (§11):
 * the panel appears where the approval lives, answers the four questions the phase asks —
 * چرا اینجاست / چه تصمیمی / چه اتفاقی افتاده / بعد چه می‌شود — and closes back to the same
 * trigger. It is a plain section so RTL tab order, long comments and mobile stacking
 * behave like the rest of Aria; the CONSEQUENCE confirmation is the one modal
 * (CommerceConfirmDialog), matching §10.6.
 *
 * WHAT IT SENDS, VERIFIED FROM `CommercialLifecycleService.decide`:
 * `{decision: 'APPROVED'|'REJECTED', comment?}` under `commerce.approve` — and nothing
 * else. No tenantId, no approverUserId, no actingUserId: who decides comes from the
 * session server-side, compared against the approver stored at activation.
 *
 * CONFLICT SEMANTICS (§7/§20). A 409 means the record moved (usually somebody decided it
 * first). The panel keeps the typed comment and the selected decision, asks the parent to
 * refetch the authoritative record, and — if the live record is no longer pending —
 * switches to a decided view that EXPLAINS what changed while still showing the comment
 * the user typed. Nothing is reset, nothing is retried blindly.
 */
export function CommerceCommercialDecisionPanel({
  approval,
  documentNumber,
  lineLabel,
  onDecided,
  onStale,
  onClose,
}: {
  approval: CommerceApproval;
  documentNumber: string;
  lineLabel?: string | null;
  /** Called with the server's OWN decided record — the only source of new state. */
  onDecided: (decided: CommerceApproval) => void;
  /** Called on a state conflict so the parent refetches approvals (no blind retry). */
  onStale: () => void;
  onClose: () => void;
}) {
  const [decision, setDecision] = React.useState<CommerceApprovalDecision | null>(null);
  const [comment, setComment] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLElement | null>(null);

  /**
   * The server's OWN decided record, kept locally until the parent's refetch replaces the
   * prop. Without it there would be a window after a successful POST in which the form
   * still looked submittable — a second click would be a second mutation the server would
   * have to refuse. The response is authoritative, so it can be shown immediately.
   */
  const [recorded, setRecorded] = React.useState<CommerceApproval | null>(null);
  const effective = recorded && recorded.id === approval.id ? recorded : approval;

  // Focus enters the workspace predictably when it opens (§21).
  React.useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const submit = async () => {
    if (pending) return;
    if (!decision) {
      setFieldError('برای ثبت، یکی از دو تصمیم را انتخاب کنید.');
      return;
    }
    if (comment.length > COMMERCE_DECISION_COMMENT_MAX) {
      setFieldError(`نظر نمی‌تواند بیش از ${COMMERCE_DECISION_COMMENT_MAX} نویسه باشد.`);
      return;
    }

    setFieldError(null);
    setError(null);
    setPending(true);
    setConfirmOpen(false);
    try {
      const trimmed = comment.trim();
      const decided = await submitCommerceCommercialDecision(approval.id, {
        decision,
        ...(trimmed ? { comment: trimmed } : {}),
      });
      // The response is the new authoritative state — no optimistic marking.
      setComment('');
      setSuccess(`تصمیم «${commerceApprovalDecisionLabel(decision)}» برای سند ${documentNumber} ثبت شد.`);
      setRecorded(decided);
      onDecided(decided);
    } catch (err: unknown) {
      // The comment and the selection stay exactly where they were (§20).
      setSuccess(null);
      setError(commerceActionErrorMessage(err, 'ثبت تصمیم انجام نشد؛ دوباره تلاش کنید.'));
      if (err instanceof Error && /is already|was decided while/i.test(err.message)) {
        onStale();
      }
    } finally {
      setPending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !pending) {
      event.stopPropagation();
      onClose();
    }
  };

  // The live record moved (decided elsewhere, or our own success just landed).
  if (effective.status !== 'PENDING') {
    return (
      <section
        ref={rootRef}
        tabIndex={-1}
        data-testid="commerce-decision-panel"
        aria-labelledby="commerce-decision-title"
        onKeyDown={handleKeyDown}
        className="rounded-2xl border border-primary/30 bg-primary/5 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="commerce-decision-title" className="text-sm font-semibold text-foreground">
            نتیجهٔ تصمیم بازرگانی
          </h3>
          <CommerceApprovalStatusBadge status={effective.status} />
        </div>
        <p className="mt-2 text-sm text-foreground">
          {commerceApprovalStatusLabel(effective.status)}
          {effective.decidedAt ? ` — ${commerceInstantLabel(effective.decidedAt)}` : ''}
        </p>
        {effective.comment && (
          <p className="mt-1 text-sm text-muted-foreground">نظر ثبت‌شده: {effective.comment}</p>
        )}
        {success && <CommerceFeedback message={success} testId="commerce-decision-success" />}
        {error && comment.trim().length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="commerce-decision-preserved-comment">
            نظر ثبت‌نشدهٔ شما: {comment}
          </p>
        )}
        {error && <CommerceFeedback message={error} tone="danger" testId="commerce-decision-error" />}
        <div className="mt-4">
          <Button type="button" onClick={onClose} data-testid="commerce-decision-close">
            بستن
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      data-testid="commerce-decision-panel"
      aria-labelledby="commerce-decision-title"
      onKeyDown={handleKeyDown}
      className="rounded-2xl border border-primary/30 bg-primary/5 p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="commerce-decision-title" className="text-sm font-semibold text-foreground">
          تصمیم بازرگانی
        </h3>
        <CommerceApprovalStatusBadge status={approval.status} />
      </div>

      {/* WHY HERE / WHAT IS BEING DECIDED — only facts this record actually carries. */}
      <p className="mt-2 text-sm text-foreground">این مورد در انتظار تصمیم شماست.</p>
      <p className="mt-1 text-xs text-muted-foreground">
        سند درخواست خرید{' '}
        <span dir="ltr" className="rounded-md bg-muted px-2 py-0.5 text-foreground">
          {documentNumber}
        </span>
        {lineLabel ? ` — ${lineLabel}` : ''}
        {' — '}
        <span title={approval.createdAt}>ایجاد: {commerceInstantLabel(approval.createdAt)}</span>
      </p>

      <fieldset className="mt-4" disabled={pending}>
        <legend className="mb-2 text-sm font-medium text-foreground">تصمیم شما</legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
          {COMMERCE_APPROVAL_DECISIONS.map((value) => (
            <label
              key={value}
              htmlFor={`commerce-decision-${value}`}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground"
            >
              <input
                id={`commerce-decision-${value}`}
                type="radio"
                name="commerce-decision"
                value={value}
                checked={decision === value}
                onChange={() => {
                  setDecision(value);
                  setFieldError(null);
                }}
                aria-describedby={
                  fieldError ? 'commerce-decision-field-error' : 'commerce-decision-hint'
                }
                className="h-4 w-4"
              />
              {commerceApprovalDecisionLabel(value)}
            </label>
          ))}
        </div>
        <p id="commerce-decision-hint" className="mt-1 text-xs text-muted-foreground">
          با ثبت تصمیم، وضعیت این تأیید بازرگانی تغییر می‌کند؛ وضعیت سند درخواست خرید تغییری نمی‌کند.
        </p>
        {fieldError && (
          <p id="commerce-decision-field-error" className="mt-1 text-xs text-destructive">
            {fieldError}
          </p>
        )}

        <div className="mt-4">
          <label
            htmlFor="commerce-decision-comment"
            className="mb-1 block text-xs text-muted-foreground"
          >
            نظر / توضیح (اختیاری)
          </label>
          <textarea
            id="commerce-decision-comment"
            rows={3}
            maxLength={COMMERCE_DECISION_COMMENT_MAX}
            value={comment}
            disabled={pending}
            onChange={(event) => setComment(event.target.value)}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm leading-7 text-foreground outline-none transition focus:border-ring disabled:opacity-60"
          />
          <p className="mt-1 text-end text-xs text-muted-foreground" aria-hidden="true">
            {toPersianDigits(comment.length)} / {toPersianDigits(COMMERCE_DECISION_COMMENT_MAX)}
          </p>
        </div>
      </fieldset>

      <CommerceFeedback message={error} tone="danger" testId="commerce-decision-error" />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => setConfirmOpen(true)}
          disabled={pending || decision === null}
          aria-busy={pending}
          data-testid="commerce-decision-submit"
        >
          {pending ? 'در حال ثبت…' : 'ثبت تصمیم'}
        </Button>
        <Button
          type="button"
          onClick={onClose}
          disabled={pending}
          data-testid="commerce-decision-cancel"
          className="border border-border bg-background text-foreground hover:bg-secondary"
        >
          انصراف
        </Button>
      </div>

      <CommerceConfirmDialog
        open={confirmOpen}
        testId="commerce-decision-confirm"
        title="آیا این تصمیم ثبت شود؟"
        description={
          decision
            ? `تصمیم انتخابی: ${commerceApprovalDecisionLabel(decision)} — سند ${documentNumber}`
            : undefined
        }
        consequences={
          decision === 'REJECTED'
            ? 'با ثبت این تصمیم، این تأیید بازرگانی «ردشده» می‌شود؛ وضعیت سند درخواست خرید تغییر نمی‌کند.'
            : 'با ثبت این تصمیم، این تأیید بازرگانی «تأییدشده» می‌شود و پروژکشن بازرگانی سند دوباره محاسبه می‌شود؛ وضعیت سند درخواست خرید تغییر نمی‌کند.'
        }
        confirmLabel="ثبت تصمیم"
        confirmTone={decision === 'REJECTED' ? 'danger' : 'primary'}
        pending={pending}
        onConfirm={() => void submit()}
        onCancel={() => setConfirmOpen(false)}
      />
    </section>
  );
}