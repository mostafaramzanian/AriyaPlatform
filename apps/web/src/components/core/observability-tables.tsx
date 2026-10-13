'use client';

import * as React from 'react';

import type {
    ApplicationLogRow,
    AuditEventRow,
    LifecycleEventRow,
    LogLevel,
    RetentionRunRow,
    SecurityEventRow,
} from '@/lib/observability-api';

/**
 * Phase 49M-2: the read-only result tables for `/admin/observability`.
 *
 * Split out of `CoreObservabilityView` because that component owns state, fetching and filter
 * construction, while everything here is a pure function of its props — one row in, one `<tr>`
 * out. The five tables have genuinely different columns and are deliberately NOT unified behind
 * a column-descriptor abstraction: a generic renderer would have to be told how to format a
 * level badge, a masked identifier and a retention cutoff anyway, and the branching would move
 * into configuration where it is harder to read.
 *
 * NOTHING HERE FORMATS A VALUE THE SERVER DID NOT ALREADY REDACT. `attemptedIdentifier` arrives
 * masked, `beforeValue`/`afterValue` arrive redacted, and no component below tries to
 * reconstruct, decode or prettify a sensitive value.
 *
 * STATUS IS NEVER COLOUR ALONE (§30): every badge carries a symbol and a Persian label, and the
 * accessible name is the label.
 */

/** Level presentation: symbol + Persian label + colour class. */
export const LEVEL_PRESENTATION: Record<
    LogLevel,
    { symbol: string; label: string; className: string }
> = {
    TRACE: {symbol: '·', label: 'ردیابی', className: 'bg-muted text-muted-foreground'},
    DEBUG: {symbol: '⋯', label: 'اشکال‌زدایی', className: 'bg-muted text-muted-foreground'},
    INFO: {symbol: 'ℹ', label: 'اطلاع', className: 'bg-sky-100 text-sky-800'},
    WARN: {symbol: '⚠', label: 'هشدار', className: 'bg-amber-100 text-amber-900'},
    ERROR: {symbol: '✕', label: 'خطا', className: 'bg-red-100 text-red-800'},
    FATAL: {symbol: '⛔', label: 'بحرانی', className: 'bg-red-200 text-red-900'},
};

/** Severity presentation for security events. */
export const SEVERITY_PRESENTATION: Record<
    SecurityEventRow['severity'],
    { symbol: string; label: string; className: string }
> = {
    INFO: {symbol: 'ℹ', label: 'اطلاع', className: 'bg-sky-100 text-sky-800'},
    LOW: {symbol: '·', label: 'کم', className: 'bg-muted text-muted-foreground'},
    MEDIUM: {symbol: '⚠', label: 'متوسط', className: 'bg-amber-100 text-amber-900'},
    HIGH: {symbol: '✕', label: 'بالا', className: 'bg-red-100 text-red-800'},
    CRITICAL: {symbol: '⛔', label: 'بحرانی', className: 'bg-red-200 text-red-900'},
};

/** Audit outcome presentation. */
export const OUTCOME_PRESENTATION: Record<
    AuditEventRow['outcome'],
    { symbol: string; label: string; className: string }
> = {
    SUCCESS: {symbol: '✓', label: 'موفق', className: 'bg-emerald-100 text-emerald-800'},
    FAILURE: {symbol: '✕', label: 'ناموفق', className: 'bg-red-100 text-red-800'},
    DENIED: {symbol: '⛔', label: 'رد شده', className: 'bg-amber-100 text-amber-900'},
};

/** Lifecycle phase presentation. Six phases, matching `LIFECYCLE_PHASES` in the contract. */
export const PHASE_PRESENTATION: Record<
    LifecycleEventRow['phase'],
    { symbol: string; label: string; className: string }
> = {
    STARTED: {symbol: '▶', label: 'آغاز شد', className: 'bg-sky-100 text-sky-800'},
    SUCCEEDED: {symbol: '✓', label: 'موفق', className: 'bg-emerald-100 text-emerald-800'},
    FAILED: {symbol: '✕', label: 'ناموفق', className: 'bg-red-100 text-red-800'},
    SKIPPED: {symbol: '⤼', label: 'رد شد', className: 'bg-muted text-muted-foreground'},
    REFUSED: {symbol: '⛔', label: 'نپذیرفت', className: 'bg-amber-100 text-amber-900'},
    TIMEOUT: {symbol: '⌛', label: 'مهلت تمام شد', className: 'bg-amber-100 text-amber-900'},
};

/** Lifecycle domain labels. INTEGRATION/MODULE/PROVISIONING only — no BUSINESS member exists. */
export const DOMAIN_LABELS: Record<LifecycleEventRow['domain'], string> = {
    INTEGRATION: 'یکپارچه‌سازی',
    MODULE: 'ماژول',
    PROVISIONING: 'راه‌اندازی',
};

/** Actor type labels, shared by the audit, security and lifecycle tables. */
export const ACTOR_TYPE_LABELS: Record<AuditEventRow['actorType'], string> = {
    USER: 'کاربر',
    MODULE: 'ماژول',
    SYSTEM: 'سامانه',
    ANONYMOUS: 'ناشناس',
};

/**
 * Formats a timestamp for display.
 *
 * `fa-IR` WITH `latn` DIGITS: a Persian locale renders Arabic-Indic numerals by default, and a
 * log timestamp gets compared character by character against ids and other rows, where mixed
 * numeral systems are genuinely hard to read. The calendar stays Persian; only digits are Latin.
 */
export function formatTime(value: string | null): string {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
        dateStyle: 'short',
        timeStyle: 'medium',
    }).format(date);
}

/** Symbol + label + colour. The accessible name is the LABEL, never the colour. */
export function Badge({
                          symbol,
                          label,
                          className,
                      }: {
    symbol: string;
    label: string;
    className: string;
}) {
    return (
        <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
            aria-label={label}
        >
      <span aria-hidden="true">{symbol}</span>
      <span>{label}</span>
    </span>
    );
}

/**
 * A monospace, truncating cell for ids and correlation values.
 *
 * Truncated in the CELL but complete in `title`, because a correlation id is the one value an
 * operator copies out of this page, and a `…` in the middle of a copied id is useless.
 */
export function IdCell({value}: { value: string | null }) {
    if (!value) return <span className="text-muted-foreground">—</span>;
    return (
        <span className="font-mono text-[11px]" dir="ltr" title={value}>
      {value.length > 12 ? `${value.slice(0, 12)}…` : value}
    </span>
    );
}

/** A collapsed JSON bag. `<details>` is keyboard-operable and needs no state. */
export function DetailCell({value}: { value: unknown }) {
    if (value === null || value === undefined) {
        return <span className="text-muted-foreground">—</span>;
    }
    return (
        <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">جزئیات</summary>
            <pre
                className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-2 text-[11px]"
                dir="ltr"
            >
        {JSON.stringify(value, null, 2)}
      </pre>
        </details>
    );
}

/**
 * Shared table chrome.
 *
 * A REAL `<table>` with `<th scope="col">`, not a grid of divs: these are tabular data, a screen
 * reader announces the column name with each cell, and column order is meaningful. Horizontal
 * scrolling belongs to the caller's wrapper, so no cell has to truncate to fit.
 */
function DataTable({headers, children}: { headers: string[]; children: React.ReactNode }) {
    return (
        <table className="w-full min-w-[52rem] border-collapse text-start text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
            <tr>
                {headers.map((header) => (
                    <th key={header} scope="col" className="px-3 py-2 text-start font-medium">
                        {header}
                    </th>
                ))}
            </tr>
            </thead>
            <tbody>{children}</tbody>
        </table>
    );
}

export function LogsTable({rows}: { rows: ApplicationLogRow[] }) {
    return (
        <DataTable
            headers={[
                'زمان',
                'سطح',
                'کد پیام',
                'پیام',
                'منبع',
                'مسیر',
                'وضعیت',
                'مدت',
                'همبستگی',
                'جزئیات',
            ]}
        >
            {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap px-3 py-2">{formatTime(row.occurredAt)}</td>
                    <td className="px-3 py-2">
                        <Badge {...LEVEL_PRESENTATION[row.level]} />
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.messageCode}</td>
                    <td className="px-3 py-2">{row.message}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.source}</td>
                    <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                        {row.httpMethod ? `${row.httpMethod} ` : ''}
                        {row.route ?? '—'}
                    </td>
                    <td className="px-3 py-2">{row.statusCode ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                        {row.durationMs === null ? '—' : `${row.durationMs} ms`}
                    </td>
                    <td className="px-3 py-2">
                        <IdCell value={row.correlationId}/>
                    </td>
                    <td className="px-3 py-2">
                        {/* The error name and message are shown; the STACK is inside the details bag only, so a
                stack trace is never the first thing rendered into the page. */}
                        {row.errorName && <p className="mb-1 font-medium text-foreground">{row.errorName}</p>}
                        <DetailCell
                            value={
                                row.context || row.errorMessage || row.errorStack
                                    ? {
                                        ...(row.context ?? {}),
                                        ...(row.errorMessage ? {errorMessage: row.errorMessage} : {}),
                                        ...(row.errorStack ? {errorStack: row.errorStack} : {}),
                                    }
                                    : null
                            }
                        />
                    </td>
                </tr>
            ))}
        </DataTable>
    );
}

/**
 * Audit events from observability_db.
 *
 * `changedFields` IS THE HEADLINE, and the before/after values live inside the collapsed bag —
 * an operator scanning this table wants to know WHICH fields moved, and a row that inlined two
 * JSON documents would push every other column off the screen. Both values arrive already
 * redacted by the same `redactPayload` the core audit trail uses; nothing here un-redacts them.
 */
export function AuditTable({rows}: { rows: AuditEventRow[] }) {
    return (
        <DataTable
            headers={[
                'زمان',
                'کنش',
                'منبع',
                'عامل',
                'نتیجه',
                'فیلدهای تغییریافته',
                'همبستگی',
                'مقادیر',
            ]}
        >
            {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap px-3 py-2">{formatTime(row.occurredAt)}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.action}</td>
                    <td className="px-3 py-2">
                        <span className="font-mono text-[11px]">{row.resourceType}</span>
                        {row.resourceId && (
                            <>
                                {' '}
                                <IdCell value={row.resourceId}/>
                            </>
                        )}
                    </td>
                    <td className="px-3 py-2">
                        <p>{ACTOR_TYPE_LABELS[row.actorType]}</p>
                        <IdCell value={row.actorId}/>
                        {row.actorRole && <p className="text-muted-foreground">{row.actorRole}</p>}
                    </td>
                    <td className="px-3 py-2">
                        <Badge {...OUTCOME_PRESENTATION[row.outcome]} />
                        {row.reason && <p className="mt-1 text-muted-foreground">{row.reason}</p>}
                    </td>
                    <td className="px-3 py-2">
                        {row.changedFields.length === 0 ? (
                            <span className="text-muted-foreground">—</span>
                        ) : (
                            <span className="font-mono text-[11px]">{row.changedFields.join('، ')}</span>
                        )}
                    </td>
                    <td className="px-3 py-2">
                        <IdCell value={row.correlationId}/>
                    </td>
                    <td className="px-3 py-2">
                        <DetailCell
                            value={
                                row.beforeValue !== null || row.afterValue !== null
                                    ? {before: row.beforeValue, after: row.afterValue}
                                    : null
                            }
                        />
                    </td>
                </tr>
            ))}
        </DataTable>
    );
}

/**
 * Security events. Reachable only with `admin.security.read`.
 *
 * `attemptedIdentifier` IS RENDERED AS RECEIVED. It was masked before insert, so there is no
 * unmasked copy in the database and none in this response — the client is not trusted to hide it
 * and, just as importantly, cannot forget to. Nothing below attempts to reverse the mask.
 *
 * `succeeded` GETS ITS OWN BADGE rather than being folded into the severity column, because a
 * successful HIGH-severity event and a failed one mean opposite things: a blocked attack versus
 * a breach.
 */
export function SecurityTable({rows}: { rows: SecurityEventRow[] }) {
    return (
        <DataTable
            headers={[
                'زمان',
                'نوع رخداد',
                'شدت',
                'نتیجه',
                'شناسه تلاش‌شده',
                'نشانی IP',
                'مسیر',
                'دسترسی لازم',
                'جزئیات',
            ]}
        >
            {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap px-3 py-2">{formatTime(row.occurredAt)}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.eventType}</td>
                    <td className="px-3 py-2">
                        <Badge {...SEVERITY_PRESENTATION[row.severity]} />
                    </td>
                    <td className="px-3 py-2">
                        <Badge
                            {...(row.succeeded
                                ? {symbol: '✓', label: 'موفق', className: 'bg-emerald-100 text-emerald-800'}
                                : {symbol: '⛔', label: 'ناموفق', className: 'bg-red-100 text-red-800'})}
                        />
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                        {row.attemptedIdentifier ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                        {row.ipAddress ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]" dir="ltr">
                        {row.httpMethod ? `${row.httpMethod} ` : ''}
                        {row.route ?? '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.requiredPermission ?? '—'}</td>
                    <td className="px-3 py-2">
                        <p className="mb-1">{ACTOR_TYPE_LABELS[row.actorType]}</p>
                        {row.reasonCode && <p className="mb-1 font-mono text-[11px]">{row.reasonCode}</p>}
                        <DetailCell value={row.detail}/>
                    </td>
                </tr>
            ))}
        </DataTable>
    );
}

/**
 * Lifecycle events: the interleaved platform timeline.
 *
 * `outcomeCode` SITS BESIDE `phase`, NOT INSTEAD OF IT. The phase is the normalized, cross-domain
 * answer to "how did this step end" and is what makes an integration failure comparable to a
 * provisioning failure; the outcome code is the original domain-specific string, kept so the
 * normalization is lossless. Showing only one of the two would give up either comparability or
 * fidelity.
 */
export function LifecycleTable({rows}: { rows: LifecycleEventRow[] }) {
    return (
        <DataTable
            headers={[
                'زمان',
                'حوزه',
                'نوع رخداد',
                'مرحله',
                'موضوع',
                'ماژول',
                'تلاش',
                'مدت',
                'همبستگی',
                'جزئیات',
            ]}
        >
            {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap px-3 py-2">{formatTime(row.occurredAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{DOMAIN_LABELS[row.domain]}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.eventType}</td>
                    <td className="px-3 py-2">
                        <Badge {...PHASE_PRESENTATION[row.phase]} />
                        {row.outcomeCode && (
                            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{row.outcomeCode}</p>
                        )}
                    </td>
                    <td className="px-3 py-2">
                        <span className="font-mono text-[11px]">{row.subjectType}</span>
                        {row.subjectKey && <p className="text-muted-foreground">{row.subjectKey}</p>}
                        <IdCell value={row.subjectId}/>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.moduleId ?? '—'}</td>
                    <td className="px-3 py-2">{row.attempt ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2">
                        {row.durationMs === null ? '—' : `${row.durationMs} ms`}
                    </td>
                    <td className="px-3 py-2">
                        <IdCell value={row.correlationId}/>
                    </td>
                    <td className="px-3 py-2">
                        <DetailCell value={row.detail}/>
                    </td>
                </tr>
            ))}
        </DataTable>
    );
}

/**
 * Retention runs: the evidence that pruning is happening, and what it removed.
 *
 * THIS TABLE IS THE ONLY PROOF A READER HAS that a gap in the older data is policy rather than
 * loss. `truncated` therefore gets its own visible marker: it means the per-run chunk ceiling was
 * hit and rows remain above the cutoff, so the next pass has more to do — which is very different
 * from a completed run that simply found little to delete.
 *
 * A ZERO `deletedCount` IS A SUCCESS, not an anomaly: a healthy installation inside its retention
 * window has nothing old enough to remove.
 */
export function RetentionTable({rows}: { rows: RetentionRunRow[] }) {
    return (
        <DataTable
            headers={['آغاز', 'پایان', 'دسته', 'مرز زمانی', 'حذف‌شده', 'وضعیت', 'مدت', 'خطا']}
        >
            {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                    <td className="whitespace-nowrap px-3 py-2">{formatTime(row.startedAt)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatTime(row.finishedAt)}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{row.category}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatTime(row.cutoff)}</td>
                    <td className="px-3 py-2">{row.deletedCount}</td>
                    <td className="space-y-1 px-3 py-2">
                        <Badge
                            {...(row.succeeded
                                ? {symbol: '✓', label: 'موفق', className: 'bg-emerald-100 text-emerald-800'}
                                : {symbol: '✕', label: 'ناموفق', className: 'bg-red-100 text-red-800'})}
                        />
                        {row.truncated && (
                            <Badge
                                symbol="⋯"
                                label="ناتمام؛ ادامه در اجرای بعدی"
                                className="bg-amber-100 text-amber-900"
                            />
                        )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                        {row.durationMs === null ? '—' : `${row.durationMs} ms`}
                    </td>
                    <td className="px-3 py-2">{row.errorMessage ?? '—'}</td>
                </tr>
            ))}
        </DataTable>
    );
}

