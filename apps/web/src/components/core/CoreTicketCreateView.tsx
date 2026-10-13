'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';

import { CoreApiError } from '@/lib/core-http';
import {
  MAX_TICKET_BODY,
  MAX_TICKET_SUBJECT,
  TICKET_PRIORITY_LABELS,
  TICKET_TYPE_LABELS,
  createTicket,
  type TicketPriority,
  type TicketType,
} from '@/lib/support-api';
import { CoreError } from './CoreStates';

/**
 * Phase 49G: new ticket form.
 *
 * The form carries exactly what the backend accepts on create: type, priority,
 * subject and body. There is deliberately NO requester field, NO status field and NO
 * tracking-number field — the requester is the authenticated caller, status always
 * starts at NEW, and the tracking number is minted server-side. The DTO runs under
 * `forbidNonWhitelisted`, so adding any of them would be rejected rather than
 * honoured.
 *
 * Lengths mirror the backend bounds (and the database CHECKs), so the counter the
 * user sees is the real limit rather than a guess.
 */
export function CoreTicketCreateView() {
  const router = useRouter();

  const [type, setType] = React.useState<TicketType>('SUPPORT');
  const [priority, setPriority] = React.useState<TicketPriority>('NORMAL');
  const [subject, setSubject] = React.useState('');
  const [body, setBody] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canSubmit = subject.trim().length > 0 && body.trim().length > 0 && !isSubmitting;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const ticket = await createTicket({
        type,
        priority,
        subject: subject.trim(),
        body: body.trim(),
      });
      // Straight to the ticket, so the user sees their tracking number immediately.
      router.push(`/admin/support/${ticket.id}`);
    } catch (err: unknown) {
      setError(
        err instanceof CoreApiError || err instanceof Error
          ? err.message
          : 'ثبت تیکت با خطا مواجه شد.',
      );
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Link
        href="/admin/support"
        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowRight aria-hidden="true" className="h-4 w-4" />
        بازگشت به فهرست تیکت‌ها
      </Link>

      <form
        onSubmit={handleSubmit}
        className="core-card space-y-5 p-core-card"
        data-testid="ticket-form"
      >
        <div>
          <h1 className="text-xl font-semibold text-foreground">ثبت تیکت جدید</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            شماره پیگیری پس از ثبت به‌صورت خودکار ساخته می‌شود.
          </p>
        </div>

        {error && <CoreError message={error} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ticket-type" className="text-xs text-muted-foreground">
              نوع درخواست
            </label>
            <select
              id="ticket-type"
              value={type}
              onChange={(event) => setType(event.target.value as TicketType)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {(Object.keys(TICKET_TYPE_LABELS) as TicketType[]).map((value) => (
                <option key={value} value={value}>
                  {TICKET_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="ticket-priority" className="text-xs text-muted-foreground">
              اولویت
            </label>
            <select
              id="ticket-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as TicketPriority)}
              className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {(Object.keys(TICKET_PRIORITY_LABELS) as TicketPriority[]).map((value) => (
                <option key={value} value={value}>
                  {TICKET_PRIORITY_LABELS[value]}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              اولویت اعلام‌شده پیشنهادی است و ممکن است توسط کارشناس تغییر کند.
            </p>
          </div>
        </div>

        <div>
          <label htmlFor="ticket-subject" className="text-xs text-muted-foreground">
            موضوع
          </label>
          <input
            id="ticket-subject"
            type="text"
            required
            maxLength={MAX_TICKET_SUBJECT}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {subject.length.toLocaleString('fa-IR')} از{' '}
            {MAX_TICKET_SUBJECT.toLocaleString('fa-IR')}
          </p>
        </div>

        <div>
          <label htmlFor="ticket-body" className="text-xs text-muted-foreground">
            توضیحات
          </label>
          <textarea
            id="ticket-body"
            required
            rows={8}
            maxLength={MAX_TICKET_BODY}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            {body.length.toLocaleString('fa-IR')} از {MAX_TICKET_BODY.toLocaleString('fa-IR')}
          </p>
        </div>

        <button
          type="submit"
          disabled={!canSubmit}
          data-testid="ticket-submit"
          className="inline-flex items-center gap-2 rounded-xl border border-primary bg-primary/10 px-5 py-2 text-sm text-primary transition hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          {isSubmitting ? 'در حال ثبت...' : 'ثبت تیکت'}
        </button>
      </form>
    </div>
  );
}
