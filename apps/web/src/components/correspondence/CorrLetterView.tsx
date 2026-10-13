'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  Archive,
  ArrowRight,
  Download,
  Forward,
  Paperclip,
  Printer,
} from 'lucide-react';
import {
  STATUS_LABELS,
  TRACKING_EVENT_LABELS,
  URGENCY_LABELS,
  archiveLetter,
  corrUserName,
  downloadAttachment,
  fetchLetterContent,
  fetchTracking,
  formatCorrDate,
  formatCorrTime,
  markLetter,
  type CorrLetterContent,
  type CorrTrackingEvent,
} from '@/lib/correspondence-api';
import { getAccessToken, parseJwt } from '@/lib/auth-api';
import { ClassificationBadge, UrgencyBadge } from './CorrBadges';
import { CorrReferralDialog } from './CorrReferralDialog';
import { PrintLetterView } from './PrintLetterView';

/**
 * Phase 50: مشاهده نامه — the reference ViewLetterPage information architecture
 * (header / metadata / body / actions / tracking) over the REAL content contract.
 * Everything the viewer may do is a server-computed capability flag (canRefer /
 * canArchive / canMarkRead); nothing here mutates state locally. BCC rows are
 * already filtered by the server per the viewer's entitlement (canSeeBcc), so
 * this surface never sees them.
 */
export function CorrLetterView({ letterId }: { letterId: string }) {
  const router = useRouter();

  const [content, setContent] = React.useState<CorrLetterContent | null>(null);
  const [tracking, setTracking] = React.useState<CorrTrackingEvent[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [showReferral, setShowReferral] = React.useState(false);
  const [showPrint, setShowPrint] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  // Loading/error arming lives in event handlers (retry, actions) and in the
  // letterId-change reset below — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect below only settles.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  const [prevLetterId, setPrevLetterId] = React.useState(letterId);
  // Preserve the pre-remediation arm for record changes: a new id re-arms
  // loading and clears the previous error synchronously during render (one
  // extra render, no effect setter). Retries arm through reload().
  if (prevLetterId !== letterId) {
    setPrevLetterId(letterId);
    setIsLoading(true);
    setError(null);
  }

  React.useEffect(() => {
    let active = true;
    Promise.all([fetchLetterContent(letterId), fetchTracking(letterId)])
      .then(([letterContent, rows]) => {
        if (!active) return;
        setContent(letterContent);
        setTracking(rows);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'خواندن نامه ناموفق بود.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [letterId, reloadToken]);

  if (isLoading) {
    return <p className="p-8 text-center text-sm text-muted-foreground">در حال خواندن نامه…</p>;
  }

  if (error || !content) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
        <p className="text-sm text-destructive">{error ?? 'نامه یافت نشد.'}</p>
        <button
          type="button"
          onClick={() => router.push('/admin/correspondence')}
          className="mt-3 text-xs font-medium text-primary underline-offset-4 hover:underline"
        >
          بازگشت به کارتابل
        </button>
      </div>
    );
  }

  const selfId = parseJwt(getAccessToken() ?? '')?.userId ?? null;
  const toRows = (content.recipients ?? []).filter((row) => row.kind === 'TO');
  const ccRows = (content.recipients ?? []).filter((row) => row.kind === 'CC');
  const bccRows = content.canSeeBcc
    ? (content.recipients ?? []).filter((row) => row.kind === 'BCC')
    : [];

  const withBusy = (action: () => Promise<unknown>, message: string) => async () => {
    setActionError(null);
    setNotice(null);
    setIsBusy(true);
    try {
      await action();
      setNotice(message);
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'اقدام ناموفق بود.');
    } finally {
      setIsBusy(false);
    }
  };

  const doArchive = withBusy(() => archiveLetter(content.id, null), 'نامه بایگانی شد.');
  const doMarkRead = withBusy(
    () => markLetter(content.id, 'READ'),
    'نامه خوانده‌شده علامت‌گذاری شد.',
  );

  return (
    <article className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6" dir="rtl">
      <nav aria-label="مسیر" className="flex items-center gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          onClick={() => router.push('/admin/correspondence')}
          className="inline-flex items-center gap-1 transition hover:text-foreground"
        >
          <ArrowRight className="size-3.5" aria-hidden="true" />
          کارتابل مکاتبات
        </button>
        <span aria-hidden="true">/</span>
        <span className="truncate font-medium text-foreground">{content.subject}</span>
      </nav>

      <header className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-lg font-bold leading-7 text-foreground">{content.subject}</h1>
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <UrgencyBadge urgency={content.urgency} />
            <ClassificationBadge classification={content.classification} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground">
          <span>
            شماره:{' '}
            <strong className="font-mono tabular-nums text-foreground">
              {content.letterNumber ?? '—'}
            </strong>
          </span>
          <span>
            تاریخ:{' '}
            <strong className="text-foreground">
              {formatCorrDate(content.letterDate ?? content.createdAt)}
            </strong>
          </span>
          <span>وضعیت: {STATUS_LABELS[content.status]}</span>
          <span>فوریت: {URGENCY_LABELS[content.urgency]}</span>
        </div>
      </header>
      <section className="rounded-2xl border border-border bg-card p-5 shadow-card" aria-label="جزئیات نامه">
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">فرستنده:</dt>
            <dd className="font-medium text-foreground">
              {corrUserName(content.sender)}
              {content.sender.jobTitle ? ` — ${content.sender.jobTitle}` : ''}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">دسته:</dt>
            <dd className="text-foreground">{content.category ?? '—'}</dd>
          </div>
          {toRows.length > 0 && (
            <div className="flex gap-2 sm:col-span-2">
              <dt className="shrink-0 text-muted-foreground">گیرندگان:</dt>
              <dd className="leading-6 text-foreground">
                {toRows.map((row) => corrUserName(row.user)).join('، ')}
              </dd>
            </div>
          )}
          {ccRows.length > 0 && (
            <div className="flex gap-2 sm:col-span-2">
              <dt className="shrink-0 text-muted-foreground">رونوشت:</dt>
              <dd className="leading-6 text-foreground">
                {ccRows.map((row) => corrUserName(row.user)).join('، ')}
              </dd>
            </div>
          )}
          {bccRows.length > 0 && (
            <div className="flex gap-2 sm:col-span-2">
              <dt className="shrink-0 text-muted-foreground">مخفی:</dt>
              <dd className="leading-6 text-foreground">
                {bccRows.map((row) => corrUserName(row.user)).join('، ')}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5 shadow-card" aria-label="متن نامه">
        <div
          className="text-[12.5px] leading-8 text-foreground"
          dangerouslySetInnerHTML={{ __html: content.bodyHtml }}
        />
      </section>

      {(content.attachments.length > 0) && (
        <section className="rounded-2xl border border-border bg-card p-5 shadow-card" aria-label="پیوست‌ها">
          <h2 className="mb-3 flex items-center gap-2 text-xs font-bold text-foreground">
            <Paperclip className="size-3.5" aria-hidden="true" />
            پیوست‌ها ({content.attachments.length.toLocaleString('fa-IR')})
          </h2>
          <ul className="space-y-2">
            {content.attachments.map((file) => (
              <li
                key={file.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border bg-secondary/40 px-3 py-2"
              >
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
                  {file.fileName}
                  <span className="ms-2 text-[10px] text-muted-foreground">
                    {Math.round(file.size / 1024).toLocaleString('fa-IR')} کیلوبایت
                  </span>
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    setActionError(null);
                    try {
                      const { url, fileName } = await downloadAttachment(file.id);
                      const anchor = document.createElement('a');
                      anchor.href = url;
                      anchor.download = fileName;
                      document.body.appendChild(anchor);
                      anchor.click();
                      anchor.remove();
                    } catch (err: unknown) {
                      setActionError(
                        err instanceof Error ? err.message : 'دریافت پیوست ناموفق بود.',
                      );
                    }
                  }}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[11px] font-medium text-foreground transition hover:bg-secondary"
                >
                  <Download className="size-3.5" aria-hidden="true" />
                  دریافت
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-border bg-card p-5 shadow-card" aria-label="اقدامات">
        {notice && (
          <p
            role="status"
            className="mb-3 rounded-lg border border-emerald-400/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"
          >
            {notice}
          </p>
        )}
        {actionError && (
          <p
            role="alert"
            className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {actionError}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {content.canRefer && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => setShowReferral(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-bold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            >
              <Forward className="size-4" aria-hidden="true" />
              ارجاع نامه
            </button>
          )}
          {content.canArchive && (
            <button
              type="button"
              disabled={isBusy}
              onClick={doArchive}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-4 text-xs font-medium text-foreground transition hover:bg-secondary disabled:opacity-60"
            >
              <Archive className="size-4" aria-hidden="true" />
              بایگانی
            </button>
          )}
          {content.canMarkRead && (
            <button
              type="button"
              disabled={isBusy}
              onClick={doMarkRead}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-4 text-xs font-medium text-foreground transition hover:bg-secondary disabled:opacity-60"
            >
              خوانده شد
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowPrint(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-4 text-xs font-medium text-foreground transition hover:bg-secondary"
          >
            <Printer className="size-4" aria-hidden="true" />
            چاپ / A4
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5 shadow-card" aria-label="سابقه ردیابی">
        <h2 className="mb-3 text-xs font-bold text-foreground">ردیابی و سابقه</h2>
        {tracking.length === 0 ? (
          <p className="text-[11.5px] text-muted-foreground">رخدادی ثبت نشده است.</p>
        ) : (
          <ol className="space-y-2.5">
            {tracking.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px]"
              >
                <span className="font-semibold text-foreground">
                  {TRACKING_EVENT_LABELS[event.type] ?? event.type}
                </span>
                {event.actor && (
                  <span className="text-muted-foreground">{corrUserName(event.actor)}</span>
                )}
                <span
                  className="text-muted-foreground"
                  title={formatCorrTime(event.createdAt)}
                >
                  {formatCorrDate(event.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {content.canRefer && selfId && (
        <CorrReferralDialog
          letterId={content.id}
          letterSubject={content.subject}
          selfId={selfId}
          open={showReferral}
          onClose={() => setShowReferral(false)}
          onReferred={reload}
        />
      )}

      <PrintLetterView
        open={showPrint}
        onClose={() => setShowPrint(false)}
        letter={content}
        bodyHtml={content.bodyHtml}
        recipients={content.recipients ?? []}
        signerName={null}
        organizationName={null}
      />
    </article>
  );
}

