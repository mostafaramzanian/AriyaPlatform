'use client';

import * as React from 'react';

/**
 * PHASE UI-4: the ONE modal shell the Commerce configuration surfaces use — a centered
 * `dialog` for short forms (create/rename) and a side `drawer` for the workflow step
 * editor.
 *
 * WHY A NEW COMPONENT AND NOT `CommerceConfirmDialog`: the confirm dialog is a
 * two-button consequence surface with no fields, and a step editor buried in it would be
 * the "full editor in a modal" the UI-4 brief forbids. What the two DO share is the
 * accessibility contract, and this component restates it exactly: `role="dialog"`
 * `aria-modal="true"` `aria-labelledby`, focus MOVES IN on open, is TRAPPED while open
 * (Tab/Shift+Tab cycle), and is RESTORED to the opener on close; Escape closes only when
 * no request is in flight and the caller's dirty guard allows it.
 *
 * THE CONSEQUENCE IS THE CALLER'S: `onCancel` is where a dirty form asks "discard?" —
 * this shell never decides whether closing is safe, it only guarantees that closing is
 * an explicit act (Escape, the cancel button, or the backdrop) and that it is announced.
 */

const DIALOG_WIDTHS = {
  dialog: 'max-w-lg',
  drawer: 'max-w-2xl',
} as const;

export function CommerceSettingsDialog({
  open,
  title,
  description,
  variant = 'dialog',
  pending = false,
  onCancel,
  children,
  footer,
  testId,
}: {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  /** `dialog` = centered form; `drawer` = side panel, scrolled independently. */
  variant?: 'dialog' | 'drawer';
  /** While true both dismissal paths are ignored — a request in flight must finish. */
  pending?: boolean;
  onCancel: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  testId?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const titleId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Focus into the surface: the first focusable control, so a keyboard user lands inside.
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
      // Restore focus to whatever opened the surface, when it is still mounted.
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
      className={
        variant === 'drawer'
          ? 'fixed inset-0 z-50 flex justify-start bg-background/70 backdrop-blur-sm'
          : 'fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm'
      }
      onKeyDown={handleKeyDown}
      data-testid={testId}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        dir="rtl"
        className={
          variant === 'drawer'
            ? `flex h-full w-full ${DIALOG_WIDTHS.drawer} flex-col overflow-y-auto border-e border-border bg-card p-5 shadow-elevated`
            : `w-full ${DIALOG_WIDTHS.dialog} rounded-2xl border border-border bg-card p-5 shadow-elevated`
        }
      >
        <h2 id={titleId} className="text-base font-semibold text-foreground">
          {title}
        </h2>
        {description && <div className="mt-2 text-sm text-muted-foreground">{description}</div>}
        <div className="mt-4 flex-1 space-y-4">{children}</div>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">{footer}</div>
      </div>
    </div>
  );
}