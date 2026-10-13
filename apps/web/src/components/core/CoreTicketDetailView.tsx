'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  MAX_ATTACHMENTS_PER_COMMENT,
  MAX_ATTACHMENT_BYTES,
  MAX_TICKET_COMMENT_BODY,
  TICKET_ATTACHMENT_ACCEPT,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TYPE_LABELS,
  addTicketComment,
  canSubmitSatisfaction,
  changeTicketStatus,
  formatAttachmentSize,
  formatTicketTime,
  getTicket,
  getTicketAttachmentDownload,
  listTicketComments,
  submitTicketSatisfaction,
  ticketAttachmentTypeLabel,
  ticketUserName,
  uploadTicketAttachment,
  validateTicketAttachment,
  type PendingTicketAttachment,
  type TicketComment,
  type TicketDetail,
  type TicketStatus,
} from '@/lib/support-api';
import { cn } from '@/lib/utils';
import { CoreEmpty, CoreError, CoreForbidden, CoreLoading } from './CoreStates';
import { TicketStatusBadge } from './CoreSupportView';

/**
 * Phase 49G: ticket detail — thread, lifecycle trail and satisfaction.
 *
 * Every agent-only control is rendered from the ticket's own `canManage` /
 * `availableTransitions`, both computed server-side. Hiding a control is presentation
 * only: the backend re-checks `admin.support.manage` and tenant scope on every
 * mutation, so a user who forges a request still gets 403/404.
 *
 * Internal notes are filtered out by the backend for a requester — this view does not
 * receive them at all, so there is no client-side secret to leak.
 *
 * Bodies are rendered as text. No `dangerouslySetInnerHTML`.
 */

const COMMENT_PAGE_SIZE = 20;

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border/60 py-3 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function CoreTicketDetailView({ ticketId }: { ticketId: string }) {
  const [ticket, setTicket] = React.useState<TicketDetail | null>(null);
  const [comments, setComments] = React.useState<TicketComment[]>([]);
  const [hasMoreComments, setHasMoreComments] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in every reload handler below (same commit as the
  // token bump), so the ticket effect needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  // Record-change reset, synchronously during render (guarded by the previous
  // id) — never in the effect body (`react-hooks/set-state-in-effect`): drop
  // the stale ticket/thread and re-arm the read.
  const [prevTicketId, setPrevTicketId] = React.useState(ticketId);
  if (prevTicketId !== ticketId) {
    setPrevTicketId(ticketId);
    setTicket(null);
    setComments([]);
    setHasMoreComments(false);
    setIsLoading(true);
    setError(null);
  }

  const [replyBody, setReplyBody] = React.useState('');
  const [replyInternal, setReplyInternal] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [isMutating, setIsMutating] = React.useState(false);

  const [rating, setRating] = React.useState(5);
  const [ratingComment, setRatingComment] = React.useState('');

  /**
   * Attachment state (49G-2). Three distinct things, deliberately separate:
   *  - `selectedFile`: picked but not sent anywhere yet; the user can still drop it.
   *  - `pendingAttachments`: uploaded and stored, but not yet bound to a comment.
   *    Inert server-side until the reply commits.
   *  - `attachmentNotice` / `attachmentError`: the success and failure surfaces.
   */
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);
  const [pendingAttachments, setPendingAttachments] = React.useState<PendingTicketAttachment[]>([]);
  const [isUploading, setIsUploading] = React.useState(false);
  const [attachmentError, setAttachmentError] = React.useState<string | null>(null);
  const [attachmentNotice, setAttachmentNotice] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    Promise.all([getTicket(ticketId), listTicketComments(ticketId, { limit: COMMENT_PAGE_SIZE })])
      .then(([detail, page]) => {
        if (cancelled) return;
        setTicket(detail);
        setComments(page.items ?? []);
        setHasMoreComments(Boolean(page.hasMore));
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTicket(null);
        setComments([]);
        setError({
          message: err instanceof Error ? err.message : 'دریافت تیکت با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ticketId, reloadToken]);

  const loadMoreComments = async () => {
    const last = comments[comments.length - 1];
    if (!hasMoreComments || !last) return;

    try {
      const page = await listTicketComments(ticketId, {
        cursor: last.id,
        limit: COMMENT_PAGE_SIZE,
      });
      setComments((prev) => [...prev, ...(page.items ?? [])]);
      setHasMoreComments(Boolean(page.hasMore));
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'دریافت پاسخ‌ها با خطا مواجه شد.');
    }
  };

  const handleReply = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = replyBody.trim();
    if (value.length === 0 || isMutating) return;

    setIsMutating(true);
    setActionError(null);

    try {
      // `isInternal` is only ever sent when the server said this caller may manage
      // the ticket; it is refused (not downgraded) server-side otherwise.
      // Pending attachments are claimed here: the server binds only ids that are
      // unbound, uploaded by this caller and already scoped to THIS ticket.
      await addTicketComment(ticketId, {
        body: value,
        ...(ticket?.canManage && replyInternal ? { isInternal: true } : {}),
        ...(pendingAttachments.length > 0
          ? { attachmentIds: pendingAttachments.map((item) => item.id) }
          : {}),
      });
      setReplyBody('');
      setReplyInternal(false);
      setPendingAttachments([]);
      setSelectedFile(null);
      setAttachmentError(null);
      setAttachmentNotice(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'ثبت پاسخ با خطا مواجه شد.');
    } finally {
      setIsMutating(false);
    }
  };

  const handleTransition = async (next: TicketStatus) => {
    if (isMutating) return;

    setIsMutating(true);
    setActionError(null);

    try {
      await changeTicketStatus(ticketId, { status: next });
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'تغییر وضعیت با خطا مواجه شد.');
    } finally {
      setIsMutating(false);
    }
  };

  const handleSatisfaction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isMutating) return;

    setIsMutating(true);
    setActionError(null);

    try {
      await submitTicketSatisfaction(ticketId, {
        rating,
        ...(ratingComment.trim().length > 0 ? { comment: ratingComment.trim() } : {}),
      });
      setRatingComment('');
      reload();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'ثبت بازخورد با خطا مواجه شد.');
    } finally {
      setIsMutating(false);
    }
  };

  /**
   * Opens an attachment through the authorized route. The URL is minted server-side
   * only after authorization, so it is never embedded in the page markup.
   */
  const openAttachment = async (attachmentId: string) => {
    try {
      const download = await getTicketAttachmentDownload(attachmentId);
      window.open(download.url, '_blank', 'noopener,noreferrer');
    } catch {
      setActionError('دریافت فایل پیوست با خطا مواجه شد.');
    }
  };

  /**
   * Picks a file. Validation here is UX only — it saves a doomed round trip and gives
   * an immediate answer; the backend re-checks size and MIME regardless, so a caller
   * who bypasses this gets a 4xx rather than a stored file.
   */
  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setAttachmentNotice(null);

    if (!file) {
      setSelectedFile(null);
      setAttachmentError(null);
      return;
    }

    const reason = validateTicketAttachment(file);
    if (reason) {
      setSelectedFile(null);
      setAttachmentError(reason);
      // Clear the control so re-picking the same rejected file fires `change` again.
      event.target.value = '';
      return;
    }

    setAttachmentError(null);
    setSelectedFile(file);
  };

  /** Drops the picked file before it is ever sent. */
  const clearSelectedFile = () => {
    setSelectedFile(null);
    setAttachmentError(null);
    setAttachmentNotice(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /**
   * Uploads the picked file. The result is a PENDING attachment: stored, but bound to
   * nothing, so no reader can reach it until the reply that claims it commits.
   */
  const handleUpload = async () => {
    if (!selectedFile || isUploading) return;

    // Re-checked at submit time too: the file could have been picked before a limit
    // changed, and this keeps the pre-flight rule in exactly one place.
    const reason = validateTicketAttachment(selectedFile);
    if (reason) {
      setAttachmentError(reason);
      return;
    }

    if (pendingAttachments.length >= MAX_ATTACHMENTS_PER_COMMENT) {
      setAttachmentError(
        `حداکثر ${MAX_ATTACHMENTS_PER_COMMENT.toLocaleString('fa-IR')} فایل برای هر پاسخ مجاز است.`,
      );
      return;
    }

    setIsUploading(true);
    setAttachmentError(null);
    setAttachmentNotice(null);

    try {
      const uploaded = await uploadTicketAttachment(ticketId, selectedFile);
      setPendingAttachments((prev) => [...prev, uploaded]);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setAttachmentNotice('فایل بارگذاری شد و با ثبت پاسخ پیوست می‌شود.');
    } catch (err: unknown) {
      setAttachmentError(
        err instanceof Error ? err.message : 'بارگذاری فایل پیوست با خطا مواجه شد.',
      );
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Forgets an uploaded-but-unbound attachment locally. The stored object is left
   * alone deliberately: there is no client-facing delete route, and an unclaimed
   * attachment is unreachable, so dropping the id is enough — inventing a delete
   * endpoint would be new backend surface this phase must not add.
   */
  const discardPendingAttachment = (attachmentId: string) => {
    setPendingAttachments((prev) => prev.filter((item) => item.id !== attachmentId));
    setAttachmentNotice(null);
  };

  const backLink = (
    <Link
      href="/admin/support"
      className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowRight aria-hidden="true" className="h-4 w-4" />
      بازگشت به فهرست تیکت‌ها
    </Link>
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {backLink}
        <div className="core-card p-core-card">
          <CoreLoading label="در حال بارگذاری تیکت..." lines={6} />
        </div>
      </div>
    );
  }

  if (error?.status === 403) {
    return (
      <div className="space-y-6">
        {backLink}
        <CoreForbidden message="شما به این تیکت دسترسی ندارید." />
      </div>
    );
  }

  if (error?.status === 404) {
    return (
      <div className="space-y-6">
        {backLink}
        <div
          className="rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center"
          data-testid="ticket-not-found"
        >
          <h1 className="text-base font-semibold text-foreground">تیکت یافت نشد</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            این تیکت وجود ندارد یا در دسترس شما نیست.
          </p>
        </div>
      </div>
    );
  }

  if (error || !ticket) {
    return (
      <div className="space-y-6">
        {backLink}
        <CoreError
          message={error?.message ?? 'تیکت یافت نشد.'}
          onRetry={error?.status === 401 ? undefined : reload}
        />
      </div>
    );
  }

  const showSatisfactionForm = canSubmitSatisfaction(ticket, ticket.requester.id);
  const isClosed = ticket.status === 'CLOSED';

  return (
    <div className="space-y-6">
      {backLink}

      <section className="core-card p-core-card" aria-labelledby="ticket-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 id="ticket-heading" className="text-xl font-semibold text-foreground">
              {ticket.subject}
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              شماره پیگیری: <span dir="ltr">{ticket.trackingNumber}</span>
            </p>
          </div>
          <TicketStatusBadge status={ticket.status} />
        </div>

        <p className="mt-4 whitespace-pre-line break-words text-sm text-foreground">
          {ticket.body}
        </p>

        <dl className="mt-6">
          <DetailRow label="نوع">{TICKET_TYPE_LABELS[ticket.type]}</DetailRow>
          <DetailRow label="اولویت">{TICKET_PRIORITY_LABELS[ticket.priority]}</DetailRow>
          <DetailRow label="دسته‌بندی">{ticket.category || '—'}</DetailRow>
          <DetailRow label="ثبت‌کننده">{ticketUserName(ticket.requester)}</DetailRow>
          <DetailRow label="کارشناس">{ticketUserName(ticket.assignee)}</DetailRow>
          <DetailRow label="زمان ثبت">{formatTicketTime(ticket.createdAt)}</DetailRow>
          {ticket.resolvedAt && (
            <DetailRow label="زمان حل">{formatTicketTime(ticket.resolvedAt)}</DetailRow>
          )}
          {ticket.closedAt && (
            <DetailRow label="زمان بستن">{formatTicketTime(ticket.closedAt)}</DetailRow>
          )}
        </dl>
      </section>

      {/*
        All attachments bound to this ticket, from the ticket body and every reply the
        caller may see. The list comes from the server's own projection — it contains no
        `storageKey`, no internal path and no tenant identifier, and an attachment on an
        internal note is filtered out server-side for a requester. Download goes through
        the authorized route, which mints a URL only after re-checking visibility.
      */}
      {ticket.attachments.length > 0 && (
        <section className="core-card p-5" aria-labelledby="ticket-attachments-heading">
          <h2 id="ticket-attachments-heading" className="text-sm font-semibold text-foreground">
            فایل‌های پیوست
          </h2>
          <ul className="mt-3 space-y-2" data-testid="ticket-attachments">
            {ticket.attachments.map((attachment) => (
              <li
                key={attachment.id}
                data-testid="ticket-attachment-row"
                className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              >
                <button
                  type="button"
                  onClick={() => void openAttachment(attachment.id)}
                  className="inline-flex min-h-[2rem] items-center rounded-xl border border-border px-3 py-1.5 text-xs text-primary transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {attachment.fileName}
                </button>
                <span>{ticketAttachmentTypeLabel(attachment.mimeType)}</span>
                <span>{formatAttachmentSize(attachment.size)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {actionError && <CoreError message={actionError} />}

      {ticket.canManage && ticket.availableTransitions.length > 0 && (
        <section className="core-card p-5" aria-labelledby="ticket-transitions-heading">
          <h2 id="ticket-transitions-heading" className="text-sm font-semibold text-foreground">
            تغییر وضعیت
          </h2>
          <div className="mt-3 flex flex-wrap gap-2" data-testid="ticket-transitions">
            {ticket.availableTransitions.map((next) => (
              <button
                key={next}
                type="button"
                onClick={() => void handleTransition(next)}
                disabled={isMutating}
                className="rounded-xl border border-border px-3 py-1.5 text-sm text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {TICKET_STATUS_LABELS[next]}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="ticket-thread-heading">
        <h2 id="ticket-thread-heading" className="text-sm font-semibold text-foreground">
          پاسخ‌ها
        </h2>

        {comments.length === 0 && <CoreEmpty message="هنوز پاسخی ثبت نشده است." />}

        {comments.length > 0 && (
          <ul className="space-y-3" data-testid="ticket-comments">
            {comments.map((comment) => (
              <li
                key={comment.id}
                data-testid="ticket-comment"
                data-internal={comment.isInternal ? 'true' : 'false'}
                className={cn(
                  'core-card p-4',
                  comment.isInternal && 'border-amber-500/40 bg-amber-500/5',
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {ticketUserName(comment.author)}
                  </span>
                  {comment.isInternal && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                      یادداشت داخلی
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatTicketTime(comment.createdAt)}
                  </span>
                </div>

                <p className="mt-2 whitespace-pre-line break-words text-sm text-muted-foreground">
                  {comment.body}
                </p>

                {comment.attachments.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {comment.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <button
                          type="button"
                          onClick={() => void openAttachment(attachment.id)}
                          className="inline-flex min-h-[2rem] items-center rounded-xl border border-border px-3 py-1.5 text-xs text-primary transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {attachment.fileName}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {hasMoreComments && (
          <button
            type="button"
            onClick={() => void loadMoreComments()}
            className="rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            نمایش پاسخ‌های بیشتر
          </button>
        )}
      </section>

      {!isClosed && (
        <form onSubmit={handleReply} className="core-card space-y-3 p-5" data-testid="ticket-reply">
          <label htmlFor="ticket-reply-body" className="text-sm font-semibold text-foreground">
            ثبت پاسخ
          </label>
          <textarea
            id="ticket-reply-body"
            rows={4}
            maxLength={MAX_TICKET_COMMENT_BODY}
            value={replyBody}
            onChange={(event) => setReplyBody(event.target.value)}
            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />

          {/* Rendered only for a caller the server said may manage this ticket. */}
          {ticket.canManage && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={replyInternal}
                onChange={(event) => setReplyInternal(event.target.checked)}
                className="rounded border-border"
              />
              یادداشت داخلی (برای ثبت‌کننده نمایش داده نمی‌شود)
            </label>
          )}

          {/*
            Attachment control (49G-2). Upload is a separate, explicit step from
            sending: the file is stored first and only claimed when the reply commits,
            which is exactly the contract the backend expects.
          */}
          <div className="space-y-2 rounded-xl border border-border/60 p-3" data-testid="ticket-attachment-picker">
            <label
              htmlFor="ticket-attachment-input"
              className="block text-xs font-medium text-foreground"
            >
              پیوست فایل (اختیاری)
            </label>

            <input
              ref={fileInputRef}
              id="ticket-attachment-input"
              data-testid="ticket-attachment-input"
              type="file"
              accept={TICKET_ATTACHMENT_ACCEPT}
              onChange={handleFileSelect}
              disabled={isUploading || isMutating}
              className="block w-full min-h-[2rem] cursor-pointer text-xs text-muted-foreground file:me-3 file:min-h-[2rem] file:cursor-pointer file:rounded-xl file:border file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-xs file:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            />

            <p className="text-[11px] text-muted-foreground">
              حداکثر {formatAttachmentSize(MAX_ATTACHMENT_BYTES)} — تصویر، PDF، متن، Office یا ZIP
            </p>

            {selectedFile && (
              <div
                className="flex flex-wrap items-center gap-2 text-xs text-foreground"
                data-testid="ticket-attachment-selected"
              >
                <span className="min-w-0 break-all">{selectedFile.name}</span>
                <span className="text-muted-foreground">
                  ({formatAttachmentSize(selectedFile.size)})
                </span>
                <button
                  type="button"
                  onClick={() => void handleUpload()}
                  disabled={isUploading || isMutating}
                  className="inline-flex min-h-[2rem] items-center rounded-xl border border-primary bg-primary/10 px-3 py-1.5 text-xs text-primary transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  {isUploading ? 'در حال بارگذاری...' : 'بارگذاری فایل'}
                </button>
                <button
                  type="button"
                  onClick={clearSelectedFile}
                  disabled={isUploading}
                  className="inline-flex min-h-[2rem] items-center rounded-xl border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  حذف انتخاب
                </button>
              </div>
            )}

            {isUploading && (
              <p role="status" aria-live="polite" className="text-[11px] text-muted-foreground">
                در حال بارگذاری فایل...
              </p>
            )}

            {attachmentError && (
              <p
                role="alert"
                data-testid="ticket-attachment-error"
                className="text-[11px] text-destructive"
              >
                {attachmentError}
              </p>
            )}

            {attachmentNotice && !attachmentError && (
              <p
                role="status"
                aria-live="polite"
                data-testid="ticket-attachment-notice"
                className="text-[11px] text-emerald-600 dark:text-emerald-400"
              >
                {attachmentNotice}
              </p>
            )}

            {pendingAttachments.length > 0 && (
              <ul className="space-y-1.5" data-testid="ticket-attachment-pending">
                {pendingAttachments.map((attachment) => (
                  <li
                    key={attachment.id}
                    className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"
                  >
                    <span className="min-w-0 break-all text-foreground">{attachment.fileName}</span>
                    <span>{ticketAttachmentTypeLabel(attachment.mimeType)}</span>
                    <span>{formatAttachmentSize(attachment.size)}</span>
                    <button
                      type="button"
                      onClick={() => discardPendingAttachment(attachment.id)}
                      disabled={isMutating}
                      className="inline-flex min-h-[2rem] items-center rounded-xl border border-border px-3 py-1 text-[11px] text-muted-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                    >
                      انصراف
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            type="submit"
            disabled={isMutating || replyBody.trim().length === 0}
            className="inline-flex items-center gap-2 rounded-xl border border-primary bg-primary/10 px-4 py-2 text-sm text-primary transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {isMutating ? 'در حال ثبت...' : 'ارسال پاسخ'}
          </button>
        </form>
      )}

      {isClosed && (
        <CoreEmpty message="این تیکت بسته شده است و پاسخ جدیدی نمی‌پذیرد. برای موضوع جدید، تیکت تازه ثبت کنید." />
      )}

      {showSatisfactionForm && (
        <form
          onSubmit={handleSatisfaction}
          className="core-card space-y-3 p-5"
          data-testid="ticket-satisfaction"
        >
          <h2 className="text-sm font-semibold text-foreground">میزان رضایت شما</h2>

          <div>
            <label htmlFor="ticket-rating" className="text-xs text-muted-foreground">
              امتیاز (۱ تا ۵)
            </label>
            <select
              id="ticket-rating"
              value={rating}
              onChange={(event) => setRating(Number(event.target.value))}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-40"
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value.toLocaleString('fa-IR')}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="ticket-rating-comment" className="text-xs text-muted-foreground">
              توضیح (اختیاری)
            </label>
            <textarea
              id="ticket-rating-comment"
              rows={3}
              maxLength={1000}
              value={ratingComment}
              onChange={(event) => setRatingComment(event.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <button
            type="submit"
            disabled={isMutating}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm text-foreground transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            ثبت بازخورد
          </button>
        </form>
      )}

      {ticket.satisfaction && (
        <section className="core-card p-5" data-testid="ticket-satisfaction-result">
          <h2 className="text-sm font-semibold text-foreground">بازخورد ثبت‌شده</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            امتیاز: {ticket.satisfaction.rating.toLocaleString('fa-IR')} از ۵
          </p>
          {ticket.satisfaction.comment && (
            <p className="mt-1 whitespace-pre-line break-words text-sm text-muted-foreground">
              {ticket.satisfaction.comment}
            </p>
          )}
        </section>
      )}

      <section className="core-card p-5" aria-labelledby="ticket-history-heading">
        <h2 id="ticket-history-heading" className="text-sm font-semibold text-foreground">
          تاریخچه وضعیت
        </h2>
        <ol className="mt-3 space-y-2" data-testid="ticket-history">
          {ticket.statusHistory.map((entry) => (
            <li key={entry.id} className="text-xs text-muted-foreground">
              {entry.fromStatus
                ? `${TICKET_STATUS_LABELS[entry.fromStatus]} → ${TICKET_STATUS_LABELS[entry.toStatus]}`
                : `ایجاد تیکت (${TICKET_STATUS_LABELS[entry.toStatus]})`}
              {' — '}
              {ticketUserName(entry.changedBy)}
              {' — '}
              {formatTicketTime(entry.createdAt)}
              {entry.note ? ` — ${entry.note}` : ''}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

