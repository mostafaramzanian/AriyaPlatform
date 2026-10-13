'use client';

import * as React from 'react';
import { FileSpreadsheet, FileText, Loader2 } from 'lucide-react';

import { downloadReportExport } from '@/lib/report-export';

/**
 * Phase REPORTING-VISUALIZATION-EXPORT: the ONE export control, shared by all four
 * reporting screens — the Excel file button and the Word file button, both over the
 * CURRENT filter scope.
 *
 * WHAT IT IS: two buttons that download the server-generated file for the path the
 * screen hands in. The path INCLUDES the screen's active query string (`?status=…&…`
 * built from the same object the list fetch used), so the user never re-enters filters
 * and the file can never describe a different scope than the table: one query, three
 * surfaces (table, chart, file).
 *
 * STATES: idle → one button busy (the other disabled, so two concurrent downloads cannot
 * race the object URL), then back to idle — or a Persian `role="alert"` error with the
 * button intact, never a silent failure. Keyboard-native `<button>`s, `aria-busy` while
 * a file is generating, and a stable layout that does not shift when the error appears.
 */
export function ReportExportButtons({
  testIdPrefix,
  buildPath,
}: {
  /** Test-id stem, e.g. `reporting-export` — rows render as `<stem>-xlsx`, … */
  testIdPrefix: string;
  /**
   * Builds the download path for a format, CURRENT filters included, e.g.
   * `/reporting/commerce/purchase-documents/export/xlsx?status=APPROVED`. The screen
   * owns this function because the screen owns the filter state.
   */
  buildPath: (format: 'xlsx' | 'docx') => string;
}) {
  const [pending, setPending] = React.useState<'xlsx' | 'docx' | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function run(format: 'xlsx' | 'docx') {
    if (pending) return;
    setPending(format);
    setError(null);
    try {
      await downloadReportExport(buildPath(format));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'دریافت خروجی با خطا مواجه شد.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-export`}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`${testIdPrefix}-export-xlsx`}
          disabled={pending !== null}
          aria-busy={pending === 'xlsx'}
          onClick={() => run('xlsx')}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3 text-sm text-foreground transition hover:bg-secondary disabled:opacity-40"
        >
          {pending === 'xlsx' ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />
          )}
          خروجی Excel
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-export-docx`}
          disabled={pending !== null}
          aria-busy={pending === 'docx'}
          onClick={() => run('docx')}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3 text-sm text-foreground transition hover:bg-secondary disabled:opacity-40"
        >
          {pending === 'docx' ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <FileText className="h-4 w-4" aria-hidden="true" />
          )}
          خروجی Word
        </button>
      </div>
      {error ? (
        <p
          role="alert"
          data-testid={`${testIdPrefix}-export-error`}
          className="text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
