'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { CoreEmpty } from '@/components/core/CoreStates';
import { toPersianDigits } from '@/lib/calendar-api';
import type { ProductionBomStatus } from '@/lib/production-api';
import {
  productionBomStatusLabel,
  productionBomStatusTone,
  type ProductionTone,
} from '@/lib/production-labels';

/**
 * Phase PRODUCTION-BOM: the small building blocks the Production screens share.
 *
 * WHY A SHARED FILE AND NOT MARKUP PER SCREEN
 * -------------------------------------------
 * The BOM status is rendered on the list and the detail, and the card / heading / empty /
 * pager shapes are used by both — so a class changed in one place has to change in the
 * other. The visual classes are byte-identical to Commerce's (`commerce-ui.tsx`) and HR's
 * (`hr-ui.tsx`) on purpose: Production must read as one part of Aria, not a second product.
 * It is a LOCAL copy, not an import — `commerce-ui` is typed on Commerce's vocabularies and
 * reaching across a module boundary for presentation would couple two bounded contexts.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * No loading, error or forbidden state: `CoreLoading`, `CoreError` and `CoreForbidden`
 * already exist in `CoreStates` and every screen reuses them EXACTLY. The empty state is a
 * thin composition, because `CoreEmpty` alone renders a message and nothing else.
 *
 * Every interactive element carries a `data-testid`, so browser QA selectors are as
 * explicit as an API contract — never text a translation would break.
 */

const TONE_CLASSES: Record<ProductionTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
};

export function ProductionBadge({
  tone,
  children,
  testId,
}: {
  tone: ProductionTone;
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
 * A BOM's lifecycle word, with its tone as the redundant second channel.
 *
 * THE STATUS IS THE SERVER'S FACT. Nothing here computes a display state from the items,
 * the opinion or the timestamps — the wire already carries `status`, and a second opinion
 * about it would be a second source of truth.
 */
export function ProductionBomStatusBadge({ status }: { status: ProductionBomStatus }) {
  return (
    <ProductionBadge
      tone={productionBomStatusTone(status)}
      testId={`production-bom-status-${status}`}
    >
      {productionBomStatusLabel(status)}
    </ProductionBadge>
  );
}

/** The shell every screen section sits in. */
export function ProductionCard({
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
export function ProductionPageHeading({
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
    <div
      data-testid={testId}
      className="mb-6 flex flex-wrap items-start justify-between gap-3"
    >
      <div>
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** An empty list, with the optional next-useful action. */
export function ProductionEmptyState({
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
 * The list pager.
 *
 * `total` is REQUIRED because the backend supplies it (`{items,page,pageSize,total}`): a
 * "page X of Y" is only rendered when the server actually stated Y, so nothing here
 * computes a total that could disagree with the route. The chevrons follow the RAIL's
 * direction — «previous» points right and «next» points left in an RTL layout.
 */
export function ProductionPagination({
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
      data-testid="production-pagination"
      aria-label="صفحه‌بندی"
      className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row"
    >
      <p data-testid="production-page-status" className="text-xs text-muted-foreground">
        صفحهٔ {toPersianDigits(String(page))} از {toPersianDigits(String(totalPages))}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="production-page-prev"
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
          data-testid="production-page-next"
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
