'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { CoreEmpty } from '@/components/core/CoreStates';
import { toPersianDigits } from '@/lib/calendar-api';
import {
  financialStatusLabel,
  financialStatusTone,
  type FinancialTone,
} from '@/lib/financial-labels';

/**
 * Phase F1 — FINANCIAL FOUNDATION: the small building blocks the Financial screens
 * share.
 *
 * WHY A SHARED FILE AND NOT MARKUP PER SCREEN: the status badge renders on the list and
 * the detail, and the card / heading / empty / pager shapes are used by both — so a class
 * changed in one place has to change in the other. The visual classes are byte-identical
 * to Production's (`production-ui.tsx`) and Commerce's (`commerce-ui.tsx`) on purpose:
 * Financial must read as one part of Aria, not a second product. It is a LOCAL copy, not
 * an import — `production-ui` is typed on Production's vocabularies, and reaching across a
 * bounded-context boundary for presentation would couple two contexts.
 *
 * Every interactive element carries a `data-testid`, so browser QA selectors are as
 * explicit as an API contract — never text a translation would break.
 */

const TONE_CLASSES: Record<FinancialTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

export function FinancialBadge({
  tone,
  children,
  testId,
}: {
  tone: FinancialTone;
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

/**
 * A request's stage word, with its tone as the redundant second channel.
 *
 * THE STATUS IS THE SERVER'S FACT. Nothing here computes a display state from the
 * decision or the timestamps — the wire already carries `status`, and a second opinion
 * about it would be a second source of truth. The ORDINAL is shown beside the label so
 * the source's own numbering stays visible.
 */
export function FinancialCheckRequestStatusBadge({ status }: { status: number }) {
  return (
    <FinancialBadge tone={financialStatusTone(status)} testId={`financial-check-status-${status}`}>
      <span className="mx-1">{financialStatusLabel(status)}</span>
      <span className="opacity-60">({toPersianDigits(status)})</span>
    </FinancialBadge>
  );
}

/** The shell every screen section sits in. */
export function FinancialCard({
  children,
  className = '',
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className={`rounded-2xl border border-border bg-card p-5 ${className}`}
    >
      {children}
    </section>
  );
}

/** The page title plus its optional primary action. */
export function FinancialPageHeading({
  title,
  description,
  actions,
  testId,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The empty state — a thin composition over `CoreEmpty`, one message, one test id. */
export function FinancialEmptyState({ message, testId }: { message: string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <CoreEmpty message={message} />
    </div>
  );
}

/**
 * The pager every list uses — the same shape as Production's, with the page's own numbers
 * in Persian. It renders NOTHING for a single page: a pager with one page is furniture,
 * and the row above it already says what a reader needs.
 */
export function FinancialPagination({
  page,
  pageSize,
  total,
  onPageChange,
  disabled,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  disabled?: boolean;
}) {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (pageCount <= 1) return null;

  return (
    <nav
      data-testid="financial-pagination"
      aria-label="صفحه‌بندی"
      className="mt-4 flex items-center justify-between gap-2 text-sm"
    >
      <button
        type="button"
        data-testid="financial-pagination-prev"
        disabled={disabled || page <= 1}
        onClick={() => onPageChange(page - 1)}
        className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
      >
        <ChevronRight className="h-4 w-4" />
        قبلی
      </button>
      <span className="text-muted-foreground" data-testid="financial-pagination-status">
        صفحه {toPersianDigits(page)} از {toPersianDigits(pageCount)}
      </span>
      <button
        type="button"
        data-testid="financial-pagination-next"
        disabled={disabled || page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        className="inline-flex h-9 items-center gap-1 rounded-xl border border-border px-3 text-foreground transition hover:bg-secondary disabled:opacity-40"
      >
        بعدی
        <ChevronLeft className="h-4 w-4" />
      </button>
    </nav>
  );
}
