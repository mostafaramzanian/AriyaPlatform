'use client';

import { CoreEmpty } from '@/components/core/CoreStates';

/**
 * Phase REPORTING-CHECK-REQUEST-REPORT: the report register's NO-RECORDS
 * state — «برای این فیلترها درخواستی پیدا نشد.»
 *
 * WHAT CHANGED FROM THE FOUNDATION PHASE: the intentional «no reports exist
 * yet» landing copy is gone because the first report now exists. What stays
 * is the honest distinction the phase brief §25 asks for: this state means
 * «no rows matched these filters», NOT «the product has no Reporting», and
 * never a failure. A system failure renders `CoreError` instead — the two
 * must never look alike.
 *
 * No retry button (nothing failed), no fabricated rows, no action that could
 * not complete. Message-only composition over `CoreEmpty`, the same shape
 * every sibling register's empty state uses, so the report reads as one part
 * of the ERP.
 */
export function ReportingEmptyState({ message, testId }: { message: string; testId?: string }) {
  return (
    <div data-testid={testId ?? 'reporting-empty-state'}>
      <CoreEmpty message={message} />
    </div>
  );
}
