'use client';

import * as React from 'react';
import type { HrEmployeeStatus, HrRecordStatus, HrTone } from '@/lib/hr-api';
import { hrEmployeeStatusLabel, hrEmployeeStatusTone, hrRecordStatusLabel, hrRecordStatusTone } from '@/lib/hr-api';

/**
 * Phase 51-HR-2: the small building blocks the HR screens share.
 *
 * WHY A SHARED FILE RATHER THAN FIVE COPIES
 * -----------------------------------------
 * Status is rendered in four different screens (dashboard, list, detail, positions) and
 * §30 requires the SAME rule everywhere: a state is a WORD that a screen reader and a
 * colour-blind operator can read, with colour as a second, redundant channel. Putting
 * the badge here is what stops one screen from inventing a colour-only dot later.
 *
 * Every interactive element carries a `data-testid`. The browser E2E drives the real
 * rendered UI, so its selectors must be as explicit as an API contract — never text
 * that a translation would break.
 */

const TONE_CLASSES: Record<HrTone, string> = {
  ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  muted: 'border-border bg-muted text-muted-foreground',
  danger: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export function HrBadge({
  tone,
  children,
  testId,
}: {
  tone: HrTone;
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

export function HrEmployeeStatusBadge({ status }: { status: HrEmployeeStatus }) {
  return (
    <HrBadge tone={hrEmployeeStatusTone(status)} testId={`hr-employee-status-${status}`}>
      {hrEmployeeStatusLabel(status)}
    </HrBadge>
  );
}

export function HrRecordStatusBadge({ status }: { status: HrRecordStatus }) {
  return (
    <HrBadge tone={hrRecordStatusTone(status)} testId={`hr-record-status-${status}`}>
      {hrRecordStatusLabel(status)}
    </HrBadge>
  );
}

/** A page heading with its optional actions, matching the shell's typography. */
export function HrPageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-xl font-semibold text-foreground sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function HrCard({
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

/** A definition row: the label is muted, the value is what a reader came for. */
export function HrField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** Inline feedback for a mutation, so a rejection is never silent. */
export function HrNotice({ tone, message }: { tone: 'ok' | 'error'; message: string }) {
  return (
    <p
      data-testid={`hr-notice-${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mb-4 rounded-xl border px-4 py-2 text-sm ${
        tone === 'error'
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
      }`}
    >
      {message}
    </p>
  );
}
