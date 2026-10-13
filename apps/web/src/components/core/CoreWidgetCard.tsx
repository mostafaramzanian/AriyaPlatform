'use client';

import * as React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

/**
 * Phase 49K: the shared dashboard widget frame, and the per-widget error boundary
 * that keeps one failure from blanking the landing page (D5).
 *
 * WHY A SHARED FRAME: six widgets rendering their own `core-card` heading block is
 * six chances for the heading level, the `aria-labelledby` wiring or the density
 * padding to drift. The frame owns all three, so a widget body is only its data.
 *
 * THE VISUAL LANGUAGE IS UNCHANGED. `core-card` + `p-core-card` + the gradient icon
 * chip + `text-sm font-semibold` heading is exactly what `CoreDashboard` already
 * painted in 48C; this file restates it once instead of per section.
 */

export interface CoreWidgetAction {
  href: string;
  label: string;
}

export interface CoreWidgetCardProps {
  /** Registry id. Drives the heading id and the test hook, never the styling. */
  id: string;
  title: string;
  icon: LucideIcon;
  /** Optional footer link. Omitted for widgets whose body is already links. */
  action?: CoreWidgetAction;
  /** Spans both columns at `md:` and up. Set from `WIDGET_SPAN`, not per-widget. */
  wide?: boolean;
  children: React.ReactNode;
  className?: string;
}

/** `<h3>` because the page already has an `<h1>` (header) and an `<h2>` (hero). */
export function CoreWidgetCard({
  id,
  title,
  icon: Icon,
  action,
  wide = false,
  children,
  className,
}: CoreWidgetCardProps) {
  const headingId = `core-widget-${id}-heading`;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="core-widget"
      data-widget-id={id}
      className={cn('core-card p-core-card', wide && 'md:col-span-2', className)}
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="gradient-primary grid h-10 w-10 shrink-0 place-items-center rounded-xl"
        >
          <Icon className="h-5 w-5 text-primary-foreground" />
        </span>
        <h3 id={headingId} className="min-w-0 truncate text-sm font-semibold text-foreground">
          {title}
        </h3>
      </div>

      <div className="mt-5">{children}</div>

      {action && (
        <Link
          href={action.href}
          data-testid="core-widget-action"
          className="mt-5 inline-flex items-center text-sm font-medium text-primary transition hover:text-primary-glow hover:underline"
        >
          {action.label}
        </Link>
      )}
    </section>
  );
}

interface BoundaryProps {
  widgetId: string;
  /** Shown in the fallback so a failed card is still identifiable. */
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}

interface BoundaryState {
  failed: boolean;
}

/**
 * Per-widget error isolation (D5).
 *
 * WHY A CLASS: `componentDidCatch` / `getDerivedStateFromError` have no hook
 * equivalent, so an error boundary must be a class component. This is the first one
 * in the repo and it is deliberately SCOPED TO WIDGETS rather than introduced as a
 * generic app-wide boundary — a global boundary would swallow failures the developer
 * needs to see in the pages that have no per-panel fallback.
 *
 * WHAT IT DOES AND DOES NOT CATCH: React boundaries catch errors thrown while
 * RENDERING (and in lifecycles) — a widget whose data arrives in an unexpected shape,
 * a bad `.map`, an undefined field. They do NOT catch a rejected fetch, because that
 * rejection never passes through React. Every widget therefore still owns its own
 * request failure state (`CoreError`), and this boundary is the last line of defence
 * behind it, not a substitute for it.
 *
 * DOES NOT RETRY. A render that already threw with the same props would throw again,
 * so offering a retry that cannot work would be dishonest. The neighbouring widgets
 * keep rendering, and a reload is the recovery path.
 */
export class CoreWidgetBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Logged, never surfaced: the message may name internals, and the user already
    // has a visible, actionable fallback in the card itself.
    console.error(`[core-widget:${this.props.widgetId}]`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;

    return (
      <section
        data-testid="core-widget-error"
        data-widget-id={this.props.widgetId}
        className={cn('core-card p-core-card', this.props.wide && 'md:col-span-2')}
      >
        <h3 className="text-sm font-semibold text-foreground">{this.props.title}</h3>
        <Alert
          type="error"
          className="mt-4"
          message="نمایش این کارت با خطا مواجه شد. سایر بخش‌های این صفحه سالم هستند."
        />
      </section>
    );
  }
}
