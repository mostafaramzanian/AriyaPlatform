/**
 * Phase 49B: minimal, reusable Core UI states.
 *
 * Loading uses role="status" + aria-live="polite"; error uses the existing
 * Alert primitive; empty renders a message only — never placeholder rows.
 */

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export function CoreLoading({
  label = 'در حال بارگذاری...',
  className = '',
  lines = 3,
}: {
  label?: string;
  className?: string;
  lines?: number;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={`space-y-3 ${className}`}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }).map((_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="h-4 w-full animate-pulse rounded-lg bg-muted"
          style={{ maxWidth: `${100 - index * 12}%` }}
        />
      ))}
    </div>
  );
}

export function CoreError({
  message,
  onRetry,
  retryLabel = 'تلاش دوباره',
  className = '',
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  return (
    <div className={`space-y-4 ${className}`}>
      <Alert type="error" message={message} />
      {onRetry && (
        <Button type="button" onClick={onRetry} className="text-sm">
          {retryLabel}
        </Button>
      )}
    </div>
  );
}

export function CoreForbidden({
  message = 'شما به این بخش دسترسی ندارید.',
  className = '',
}: {
  message?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Alert type="warning" message={message} />
    </div>
  );
}

export function CoreEmpty({
  message,
  className = '',
}: {
  message: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-dashed border-border bg-muted/40 px-6 py-10 text-center text-sm text-muted-foreground ${className}`}
    >
      {message}
    </div>
  );
}
