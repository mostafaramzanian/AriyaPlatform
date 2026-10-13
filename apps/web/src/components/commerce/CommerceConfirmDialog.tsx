'use client';

import * as React from 'react';

import { Button } from '@/components/ui/button';

/**
 * PHASE UI-2: the ONE confirmation surface every consequential Commerce action uses
 * (submit, compensate, refund, receive-back, reject, manual assignment reason).
 *
 * WHY A SHARED COMPONENT AND NOT ONE DIALOG PER SECTION: UI-0 §19.5 fixes the dialog
 * contract — `role="dialog" aria-modal="true" aria-labelledby`, focus MOVES INTO the
 * dialog on open, is TRAPPED while open, and is RESTORED to the opener on close; Escape
 * closes a non-destructive dialog and the backdrop never discards typed input.  One
 * implementation is the only way those four rules cannot drift between sections. It is a
 * hand-rolled dialog (the `CorrReferralDialog` precedent) because the module has no
 * shared dialog primitive and inventing a new dependency for one surface is not allowed.
 *
 * THE CONFIRM BUTTON IS THE CONSEQUENCE, AND IT IS GUARDED: while `pending` is true both
 * buttons disable, so a double-click cannot fire a second mutation, and Escape is
 * ignored (a state-changing request in flight must complete or fail on its own).
 */
export function CommerceConfirmDialog({
  open,
  title,
  description,
  consequences,
  confirmLabel,
  cancelLabel = 'انصراف',
  confirmTone = 'primary',
  pending = false,
  onConfirm,
  onCancel,
  testId,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  /** The "what happens when you press it" line — REQUIRED for destructive actions by convention. */
  consequences?: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmTone?: 'primary' | 'danger';
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Focus into the dialog: its first focusable control, so a keyboard user lands inside.
    const focusFirst = () => {
      const node = containerRef.current;
      if (!node) return;
      const target = node.querySelector<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      (target ?? node).focus();
    };
    focusFirst();

    return () => {
      // Focus restoration: back to whatever opened the dialog, when it is still mounted.
      openerRef.current?.focus?.();
    };
  }, [open]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!pending) onCancel();
      return;
    }
    if (event.key !== 'Tab') return;

    // Trap: cycle within the dialog — focus never escapes to the page behind it.
    const node = containerRef.current;
    if (!node) return;
    const focusable = Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !node.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
      data-testid={testId}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="commerce-confirm-title"
        tabIndex={-1}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-elevated"
      >
        <h2 id="commerce-confirm-title" className="text-base font-semibold text-foreground">
          {title}
        </h2>
        {description && <div className="mt-2 text-sm text-muted-foreground">{description}</div>}
        {consequences && (
          <div className="mt-3 rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs text-foreground">
            {consequences}
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="border border-border bg-background text-foreground hover:bg-secondary"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending}
            data-testid={testId ? `${testId}-confirm` : undefined}
            className={
              confirmTone === 'danger'
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined
            }
          >
            {pending ? 'در حال ثبت…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}