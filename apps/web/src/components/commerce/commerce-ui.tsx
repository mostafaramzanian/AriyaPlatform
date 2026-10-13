'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { CoreEmpty } from '@/components/core/CoreStates';
import { toPersianDigits } from '@/lib/calendar-api';
import type {
  CommerceApprovalStatus,
  CommerceAssignmentState,
  CommerceDocumentStatus,
  CommercePaymentStatus,
  CommerceReceivingStatus,
  CommerceReturnState,
} from '@/lib/commerce-api';
import {
  commerceApprovalStatusLabel,
  commerceApprovalStatusTone,
  commerceAssignmentStatusLabel,
  commerceAssignmentStatusTone,
  commerceDocumentStatusLabel,
  commerceDocumentStatusTone,
  commercePaymentStatusLabel,
  commercePaymentStatusTone,
  commerceReceivingStatusLabel,
  commerceReceivingStatusTone,
  commerceReturnStateLabel,
  commerceReturnStateTone,
  type CommerceTone,
} from '@/lib/commerce-labels';

/**
 * PHASE UI-1: the small building blocks the Commerce screens share.
 *
 * WHY A SHARED FILE AND NOT MARKUP PER SCREEN
 * -------------------------------------------
 * Status is rendered in three screens (home, tasks, register) and §20 of the UI-0 contract
 * fixes the classification: heading, card and badge are Commerce-local copies of the HR
 * pattern (`hr-ui.tsx`) — NOT imports of it, because `hr-ui` is typed on HR's own
 * vocabularies and reaching across module boundaries for presentation would couple two
 * bounded contexts that share nothing else. The visual classes are byte-identical to the
 * HR ones on purpose: Commerce must read as one part of Aria, not a second product.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No loading state, no error state, no forbidden state: `CoreLoading`, `CoreError` and
 * `CoreForbidden` already exist in `CoreStates` and every screen reuses them EXACTLY
 * (UI-0 §20 classifies those as "R"). The empty state is a thin composition — `CoreEmpty`
 * for the sentence, plus the optional next-useful action the contract requires — because
 * `CoreEmpty` alone renders a message and nothing else.
 *
 * Every interactive element carries a `data-testid`. The browser QA scripts drive the real
 * rendered UI, so their selectors must be as explicit as an API contract — never text that
 * a translation would break.
 */

const TONE_CLASSES: Record<CommerceTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

export function CommerceBadge({
  tone,
  children,
  testId,
}: {
  tone: CommerceTone;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

/** A document's lifecycle word, with its tone as the redundant second channel. */
export function CommerceDocumentStatusBadge({ status }: { status: CommerceDocumentStatus }) {
  return (
    <CommerceBadge tone={commerceDocumentStatusTone(status)} testId={`commerce-document-status-${status}`}>
      {commerceDocumentStatusLabel(status)}
    </CommerceBadge>
  );
}

/** A commercial approval's own state — a DIFFERENT lifecycle from the document's. */
export function CommerceApprovalStatusBadge({ status }: { status: CommerceApprovalStatus }) {
  return (
    <CommerceBadge tone={commerceApprovalStatusTone(status)} testId={`commerce-approval-status-${status}`}>
      {commerceApprovalStatusLabel(status)}
    </CommerceBadge>
  );
}

/**
 * The payment projection (`null` included): «جمع کل اعلام نشده» is a fact, never `UNPAID`.
 * The badge's test id carries the projected token so a spec can pin WHICH state rendered.
 */
export function CommercePaymentStatusBadge({ status }: { status: CommercePaymentStatus | null }) {
  return (
    <CommerceBadge
      tone={commercePaymentStatusTone(status)}
      testId={`commerce-payment-status-${status ?? 'UNSTATED'}`}
    >
      {commercePaymentStatusLabel(status)}
    </CommerceBadge>
  );
}

/** A purchase line's receiving projection (C1-R), per line. */
export function CommerceReceivingStatusBadge({ status }: { status: CommerceReceivingStatus }) {
  return (
    <CommerceBadge
      tone={commerceReceivingStatusTone(status)}
      testId={`commerce-receiving-status-${status}`}
    >
      {commerceReceivingStatusLabel(status)}
    </CommerceBadge>
  );
}

/** A return's projected state (C1-S) — the child lifecycle's own word. */
export function CommerceReturnStateBadge({ state }: { state: CommerceReturnState }) {
  return (
    <CommerceBadge tone={commerceReturnStateTone(state)} testId={`commerce-return-state-${state}`}>
      {commerceReturnStateLabel(state)}
    </CommerceBadge>
  );
}

/** A commercial assignment's current state — UNASSIGNED is a real, neutral state. */
export function CommerceAssignmentStatusBadge({ status }: { status: CommerceAssignmentState }) {
  return (
    <CommerceBadge
      tone={commerceAssignmentStatusTone(status)}
      testId={`commerce-assignment-status-${status}`}
    >
      {commerceAssignmentStatusLabel(status)}
    </CommerceBadge>
  );
}

/**
 * A sub-section heading INSIDE a tab, with its optional actions.
 *
 * `CommerceCard` renders the tab's h2; sections within one tab are h3 so the heading
 * hierarchy stays one-step-per-level (one h1 on the page, h2 per tab, h3 per section).
 */
export function CommerceSectionHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The outcome of a mutation, announced to assistive technology.
 *
 * `role="status"` + `aria-live="polite"`: a save/submit/append that replaces a section
 * without moving focus would otherwise be silent for a screen-reader user, and it states
 * WHAT happened (never a bare «موفق شد»).
 */
export function CommerceFeedback({
  message,
  tone = 'ok',
  testId,
}: {
  message: string | null;
  tone?: CommerceTone;
  testId?: string;
}) {
  if (!message) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid={testId}
      className={`mt-3 rounded-xl border px-3 py-2 text-xs ${TONE_CLASSES[tone]}`}
    >
      {message}
    </p>
  );
}

/** A page heading with its optional actions, matching the shell's typography. */
export function CommercePageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  // `<h2>`, NOT `<h1>`: the shell's header already owns the page's single `<h1>`
  // (the model CoreWidgetCard documents — "the page already has an `<h1>` (header)"),
  // so the view heading continues the hierarchy as h2 and section cards stay h3.
  // Keeping this an h1 put commerce pages at TWO h1 elements (browser QA run3 found it).
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="text-xl font-semibold text-foreground sm:text-2xl">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CommerceCard({
  title,
  children,
  className = '',
  testId,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  /** Stable hook for the E2E and component specs — never a translated label. */
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`rounded-2xl border border-border bg-card p-4 sm:p-6 ${className}`}
    >
      {title && <h2 className="mb-4 text-base font-semibold text-foreground">{title}</h2>}
      {children}
    </section>
  );
}

/**
 * An empty state that says WHAT is empty, and offers the next useful step when one exists.
 *
 * The sentence is rendered by `CoreEmpty` (the shared dashed-card primitive); the action is
 * this component's only addition, because a bare "nothing here" with no way forward is the
 * failure mode the UI-0 contract §23 names.
 */
export function CommerceEmptyState({
  message,
  action,
  testId,
}: {
  message: string;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <CoreEmpty message={message} />
      {action && <div className="mt-4 flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * One metric tile. The VALUE is rendered exactly as the caller computed it from an
 * authoritative response (a server `total`, never arithmetic over a page of rows) — this
 * component formats nothing and decides nothing.
 */
export function CommerceSummaryMetric({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="rounded-2xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * The register's pager.
 *
 * `total` is REQUIRED because the backend supplies it (`{items,page,pageSize,total}`): a
 * "page X of Y" is only rendered when the server actually stated Y, which is why this
 * component has no fallback arithmetic that could disagree with the route. RTL note: the
 * chevrons follow the RAIL's direction, so «previous» points right and «next» points left;
 * the labels are the accessible names and the icons are decorative.
 */
export function CommercePagination({
  page,
  pageSize,
  total,
  onPageChange,
  disabled = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav
      data-testid="commerce-pagination"
      aria-label="صفحه‌بندی"
      className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row"
    >
      <p data-testid="commerce-page-status" className="text-xs text-muted-foreground">
        صفحهٔ {toPersianDigits(String(page))} از {toPersianDigits(String(totalPages))}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="commerce-page-prev"
          aria-label="صفحهٔ قبلی"
          disabled={disabled || !hasPrevious}
          onClick={() => onPageChange(page - 1)}
          className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-xs font-medium text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
          قبلی
        </button>
        <button
          type="button"
          data-testid="commerce-page-next"
          aria-label="صفحهٔ بعدی"
          disabled={disabled || !hasNext}
          onClick={() => onPageChange(page + 1)}
          className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-xs font-medium text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          بعدی
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}

