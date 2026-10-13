'use client';

import { Inbox as InboxIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type InboxItem } from '@/lib/correspondence-api';

import { InboxStamp } from './InboxStamp';

export function InboxSurface({
  tab,
  setTab,
  items,
  isLoading,
  error,
  actionError,
  onViewed,
  onActed,
  onRemove,
  onRetry,
}: {
  tab: 'letters' | 'referrals';
  setTab: (value: 'letters' | 'referrals') => void;
  items: InboxItem[];
  isLoading: boolean;
  error: string | null;
  actionError: string | null;
  onViewed: (item: InboxItem) => void;
  onActed: (item: InboxItem) => void;
  onRemove: (item: InboxItem) => void;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6" dir="rtl">
      <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <div className="size-11 rounded-xl gradient-primary grid place-items-center shadow-glow">
            <InboxIcon className="size-5 text-primary-foreground" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">نامه‌های دریافتی</h1>
            <h2 className="text-xs text-muted-foreground mt-0.5">
              کارتابل شما — نامه‌های خطاب‌شده به شما و ارجاع‌های دریافتی
            </h2>
          </div>
        </div>
      </header>

      <div
        role="tablist"
        aria-label="نوع صندوق"
        className="mb-4 inline-flex rounded-xl border border-border bg-secondary/40 p-1"
      >
        {(
          [
            { key: 'letters', label: 'نامه‌های دریافتی' },
            { key: 'referrals', label: 'ارجاع‌های دریافتی' },
          ] as const
        ).map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            className={cn(
              'h-8 rounded-lg px-4 text-xs font-medium transition',
              tab === entry.key
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {actionError && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
        >
          {actionError}
        </div>
      )}

      {isLoading && (
        <div role="status" aria-live="polite" className="py-6 text-center text-xs text-muted-foreground">
          در حال بارگذاری…
        </div>
      )}

      {!isLoading && error && (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive"
        >
          {error}
          <button type="button" className="mr-2 underline" onClick={onRetry}>
            تلاش دوباره
          </button>
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="rounded-2xl border border-border bg-card px-4 py-16 text-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <span className="grid size-14 place-items-center rounded-2xl bg-secondary/60">
              <InboxIcon className="size-6" aria-hidden="true" />
            </span>
            <p className="text-sm">
              {tab === 'letters' ? 'نامه دریافتی یافت نشد' : 'ارجاع دریافتی یافت نشد'}
            </p>
          </div>
        </div>
      )}

      {!isLoading && !error && items.length > 0 && (
        <ul className="space-y-2">
          {items.map((item) => (
            <InboxRow
              key={`${item.source}-${item.itemId}`}
              item={item}
              onViewed={() => onViewed(item)}
              onActed={() => onActed(item)}
              onRemove={() => onRemove(item)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export function InboxRow({
  item,
  onViewed,
  onActed,
  onRemove,
}: {
  item: InboxItem;
  onViewed: () => void;
  onActed: () => void;
  onRemove: () => void;
}) {
  return <InboxStamp item={item} onViewed={onViewed} onActed={onActed} onRemove={onRemove} />;
}