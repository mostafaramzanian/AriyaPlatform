'use client';

import * as React from 'react';
import { DropdownPanel } from '@/components/ui/dropdown-panel';

import {
  Plus,
  Search,
  MoreHorizontal,
  FileEdit,
  Eye,
  Send,
  Trash2,
  FolderInput,
  Calendar,
  FileText,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  corrUserName,
  formatCorrDate,
  type CorrLetter,
} from '@/lib/correspondence-api';
import {
  getCalendarToday,
  toLatinDigits,
  toPersianDigits,
  parseDateKey,
  type CalendarDay,
} from '@/lib/calendar-api';
import { CoreJalaliDatePicker } from '@/components/core/CoreJalaliDatePicker';
import {
  CorrClassificationBadge,
  CorrStatusBadge,
  CorrUrgencyBadge,
} from './CorrBadges';

/**
 * Phase 50C: the shared list surface of پیش‌نویس‌ها / نامه‌های ارسالی.
 *
 * Drafts and sent modes match the Lovable reference: two-column Jalali date
 * filters, a search card, a header count, and a table card with mode-specific
 * actions. Inbox keeps the previous compact table.
 */

export interface CorrLetterListProps {
  title: string;
  subtitle: string;
  icon?: React.ComponentType<{ className?: string }>;
  items: CorrLetter[];
  isLoading: boolean;
  error: string | null;
  emptyLabel: string;
  emptyActionLabel: string;
  onCreate: () => void;
  onRetry: () => void;
  onOpen: (letter: CorrLetter) => void;
  onSend?: (letter: CorrLetter) => void;
  onArchive?: (letter: CorrLetter) => void;
  onDelete: (letter: CorrLetter) => void;
  deleteLabel: string;
  deleteConfirmTitle: string;
  deleteConfirmBody: (letter: CorrLetter) => string;
  /** Extra row column content (e.g. delivery status on the sent page). */
  renderExtra?: (letter: CorrLetter) => React.ReactNode;
  searchPlaceholder: string;
  /** Presentation mode. */
  mode?: 'drafts' | 'sent' | 'inbox';
}

export function CorrLetterList(props: CorrLetterListProps) {
  const {
    title,
    subtitle,
    icon: Icon = FileEdit,
    items,
    isLoading,
    error,
    emptyLabel,
    emptyActionLabel,
    onCreate,
    onRetry,
    onOpen,
    onSend,
    onArchive,
    onDelete,
    deleteLabel,
    deleteConfirmTitle,
    deleteConfirmBody,
    renderExtra,
    searchPlaceholder,
    mode = 'sent',
  } = props;

  const isDrafts = mode === 'drafts';
  const isSent = mode === 'sent';
  const showFilters = isDrafts || isSent;

  const [query, setQuery] = React.useState('');
  const [fromDate, setFromDate] = React.useState<string | null>(null);
  const [toDate, setToDate] = React.useState<string | null>(null);
  const [openPicker, setOpenPicker] = React.useState<'from' | 'to' | null>(null);
  const [today, setToday] = React.useState<CalendarDay | null>(null);
  const [todayError, setTodayError] = React.useState<string | null>(null);
  const [menuFor, setMenuFor] = React.useState<string | null>(null);
  const [confirmFor, setConfirmFor] = React.useState<CorrLetter | null>(null);

  React.useEffect(() => {
    if (!showFilters) return;
    let active = true;
    getCalendarToday()
      .then((day) => {
        if (active) setToday(day);
      })
      .catch(() => {
        if (active) setTodayError('تقویم در دسترس نیست');
      });
    return () => {
      active = false;
    };
  }, [showFilters]);

  React.useEffect(() => {
    if (!openPicker) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-corr-date-picker]')) setOpenPicker(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openPicker]);

  const dateNumber = React.useCallback((iso: string | null | undefined) => {
    if (!iso) return 0;
    const latin = toLatinDigits(formatCorrDate(iso));
    const match = /(\d{4})[\-/](\d{1,2})[\-/](\d{1,2})/.exec(latin);
    if (!match) return 0;
    const [, jy, jm, jd] = match.map(Number);
    return jy * 10000 + jm * 100 + jd;
  }, []);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const fromNum = fromDate ? dateNumber(fromDate) : 0;
    const toNum = toDate ? dateNumber(toDate) : 0;

    return items.filter((letter) => {
      if (needle) {
        const haystack = [
          letter.subject,
          letter.letterNumber ?? '',
          letter.category ?? '',
          corrUserName(letter.sender),
          ...(letter.recipients ?? []).map((r) => corrUserName(r.user)),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      const source = isDrafts ? letter.createdAt : letter.sentAt ?? letter.createdAt;
      const dateNum = dateNumber(source);
      if (fromNum && dateNum < fromNum) return false;
      if (toNum && dateNum > toNum) return false;
      return true;
    });
  }, [items, query, fromDate, toDate, dateNumber, isDrafts]);

  React.useEffect(() => {
    if (!menuFor) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('[data-corr-menu]')) setMenuFor(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuFor]);

  const displayDate = (value: string | null) =>
    value ? toPersianDigits(value) : null;

  const pickerInitialMonth = React.useCallback(
    (value: string | null) => {
      if (value) {
        const parsed = parseDateKey(value);
        if (parsed) return { jy: parsed.jy, jm: parsed.jm };
      }
      if (today) return { jy: today.jy, jm: today.jm };
      return { jy: 1405, jm: 1 };
    },
    [today],
  );

  const renderDateFilter = (label: string, value: string | null, which: 'from' | 'to') => {
    const open = openPicker === which;
    return (
      <div className="relative" data-corr-date-picker>
        <div className="text-[11px] text-muted-foreground mb-2">{label}</div>
        <button
          type="button"
          onClick={() => setOpenPicker(open ? null : which)}
          className={cn(
            'inline-flex h-11 w-full items-center gap-2 rounded-xl border bg-secondary/60 px-3 text-sm outline-none transition',
            open ? 'border-primary ring-2 ring-primary/20' : 'border-border hover:border-primary/40',
          )}
        >
          <Calendar className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="flex-1 text-right truncate">
            {displayDate(value) || (which === 'from' ? '۱۴۰۴/۰۱/۰۱' : '۱۴۰۴/۱۲/۲۹')}
          </span>
          {value && (
            <X
              className="size-3.5 text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                if (which === 'from') setFromDate(null);
                else setToDate(null);
                setOpenPicker(null);
              }}
            />
          )}
        </button>
        <DropdownPanel open={open} className="absolute z-50 mt-2 w-80 rounded-2xl border border-border bg-popover p-3 shadow-elevated">
            {today ? (
              <CoreJalaliDatePicker
                value={value}
                onSelect={(date) => {
                  if (which === 'from') setFromDate(date);
                  else setToDate(date);
                  setOpenPicker(null);
                }}
                initialMonth={pickerInitialMonth(value)}
                todayKey={today.date}
                className="w-full"
              />
            ) : (
              <div className="py-6 text-center text-xs text-muted-foreground">
                {todayError || 'در حال بارگذاری تقویم…'}
              </div>
            )}
        </DropdownPanel>
      </div>
    );
  };

  const headerSubtitle = isDrafts
    ? `نامه‌های ذخیره‌شده و آماده ویرایش — ${filtered.length} مورد`
    : isSent
      ? `مکاتبات خروجی شما — ${filtered.length} مورد`
      : subtitle;

  const createLabel = isDrafts
    ? 'ایجاد پیش‌نویس جدید'
    : isSent
      ? 'ایجاد نامه جدید'
      : emptyActionLabel;

  const tableTitle = isDrafts
    ? 'لیست پیش‌نویس‌ها'
    : isSent
      ? 'لیست نامه‌های ارسالی'
      : title;

  return (
    <div className="space-y-6" dir="rtl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="size-11 rounded-xl gradient-primary grid place-items-center shadow-glow">
            <Icon className="size-5 text-primary-foreground" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">{title}</h1>
            <p className="text-xs text-muted-foreground mt-0.5">{headerSubtitle}</p>
          </div>
        </div>
        <button
          type="button"
          className="inline-flex h-11 items-center gap-2 rounded-xl gradient-primary px-5 text-sm font-semibold text-primary-foreground shadow-glow hover:opacity-95 transition"
          onClick={onCreate}
        >
          <Plus className="size-4" aria-hidden="true" />
          {createLabel}
        </button>
      </header>

      {showFilters ? (
        <div className="rounded-2xl border border-border bg-card p-4 lg:p-5 shadow-card">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
            <div className="lg:col-span-6">
              <div className="text-[11px] text-muted-foreground mb-2">جستجو</div>
              <div className="relative">
                <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <input
                  type="search"
                  aria-label={searchPlaceholder}
                  placeholder={searchPlaceholder}
                  className="w-full h-11 rounded-xl bg-secondary/60 border border-border pr-10 pl-4 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>
            <div className="lg:col-span-3">
              {renderDateFilter('از تاریخ', fromDate, 'from')}
            </div>
            <div className="lg:col-span-3">
              {renderDateFilter('تا تاریخ', toDate, 'to')}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-card p-4 lg:p-5 shadow-card">
          <div className="relative">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="search"
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
              className="w-full h-11 rounded-xl bg-secondary/60 border border-border pr-10 pl-4 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
      )}

      {isLoading && (
        <div
          role="status"
          aria-live="polite"
          className="py-6 text-center text-xs text-muted-foreground"
        >
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

      {!isLoading && !error && (
        <div className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-foreground">{tableTitle}</h2>
              <span className="text-xs text-muted-foreground bg-secondary rounded-full px-2 py-0.5">
                {filtered.length} مورد
              </span>
            </div>
            {isDrafts && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium rounded-full border px-2.5 py-1 bg-indigo-500/10 text-indigo-300 border-indigo-400/25">
                <Sparkles className="size-3" /> فقط ارسال نشده‌ها
              </span>
            )}
          </div>
          <CorrLetterTable
            items={filtered}
            onOpen={onOpen}
            onSend={onSend}
            onArchive={onArchive}
            deleteLabel={deleteLabel}
            renderExtra={renderExtra}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
            setConfirmFor={setConfirmFor}
            emptyLabel={emptyLabel}
            emptyActionLabel={emptyActionLabel}
            onCreate={onCreate}
            hasQuery={query.trim().length > 0 || !!fromDate || !!toDate}
            mode={mode}
          />
        </div>
      )}

      {confirmFor && (
        <CorrDeleteDialog
          title={deleteConfirmTitle}
          body={deleteConfirmBody(confirmFor)}
          onCancel={() => setConfirmFor(null)}
          onConfirm={() => {
            onDelete(confirmFor);
            setConfirmFor(null);
          }}
        />
      )}
    </div>
  );
}

function CorrLetterTable({
  items,
  onOpen,
  onSend,
  onArchive,
  deleteLabel,
  renderExtra,
  menuFor,
  setMenuFor,
  setConfirmFor,
  emptyLabel,
  emptyActionLabel,
  onCreate,
  hasQuery,
  mode,
}: {
  items: CorrLetter[];
  onOpen: (letter: CorrLetter) => void;
  onSend?: (letter: CorrLetter) => void;
  onArchive?: (letter: CorrLetter) => void;
  deleteLabel: string;
  renderExtra?: (letter: CorrLetter) => React.ReactNode;
  menuFor: string | null;
  setMenuFor: (id: string | null) => void;
  setConfirmFor: (letter: CorrLetter) => void;
  emptyLabel: string;
  emptyActionLabel: string;
  onCreate: () => void;
  hasQuery: boolean;
  mode: 'drafts' | 'sent' | 'inbox';
}) {
  const isDrafts = mode === 'drafts';
  const isSent = mode === 'sent';
  const showId = isDrafts || isSent;

  if (items.length === 0) {
    return (
      <div className="px-4 py-16 text-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <span className="grid size-14 place-items-center rounded-2xl bg-secondary/60">
            <FileEdit className="size-6" aria-hidden="true" />
          </span>
          <p className="text-sm">{hasQuery ? 'نتیجه‌ای برای جستجو یافت نشد' : emptyLabel}</p>
          {!hasQuery && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground"
              onClick={onCreate}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {emptyActionLabel}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[720px] text-right text-sm">
        <thead>
          <tr className="text-right text-[11px] uppercase tracking-wider text-muted-foreground bg-secondary/40">
            {showId && (
              <th scope="col" className="px-5 py-3 font-medium w-[140px]">شناسه</th>
            )}
            <th scope="col" className="px-5 py-3 font-medium">موضوع</th>
            <th scope="col" className="px-5 py-3 font-medium">گیرنده / بخش</th>
            {isDrafts ? (
              <>
                <th scope="col" className="px-5 py-3 font-medium w-[120px]">وضعیت</th>
                <th scope="col" className="px-5 py-3 font-medium w-[140px]">تاریخ ایجاد</th>
                <th scope="col" className="px-5 py-3 font-medium w-[140px]">آخرین ویرایش</th>
              </>
            ) : isSent ? (
              <>
                <th scope="col" className="px-5 py-3 font-medium w-[140px]">تاریخ ارسال</th>
                <th scope="col" className="px-5 py-3 font-medium w-[150px]">آخرین وضعیت</th>
              </>
            ) : (
              <>
                <th scope="col" className="px-5 py-3 font-medium w-[150px]">وضعیت</th>
                <th scope="col" className="px-5 py-3 font-medium w-[140px]">تاریخ ارسال</th>
                {renderExtra && <th scope="col" className="px-5 py-3 font-medium w-[150px]">پیگیری</th>}
              </>
            )}
            <th scope="col" className="px-3 py-3 font-medium text-center w-[80px]">اقدامات</th>
          </tr>
        </thead>
        <tbody>
          {items.map((letter) => (
            <CorrLetterRow
              key={letter.id}
              letter={letter}
              onOpen={onOpen}
              onSend={onSend}
              onArchive={onArchive}
              deleteLabel={deleteLabel}
              renderExtra={renderExtra}
              menuOpen={menuFor === letter.id}
              setMenuFor={setMenuFor}
              onRequestDelete={setConfirmFor}
              mode={mode}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CorrLetterRow({
  letter,
  onOpen,
  onSend,
  onArchive,
  deleteLabel,
  renderExtra,
  menuOpen,
  setMenuFor,
  onRequestDelete,
  mode,
}: {
  letter: CorrLetter;
  onOpen: (letter: CorrLetter) => void;
  onSend?: (letter: CorrLetter) => void;
  onArchive?: (letter: CorrLetter) => void;
  deleteLabel: string;
  renderExtra?: (letter: CorrLetter) => React.ReactNode;
  menuOpen: boolean;
  setMenuFor: (id: string | null) => void;
  onRequestDelete: (letter: CorrLetter) => void;
  mode: 'drafts' | 'sent' | 'inbox';
}) {
  const isDrafts = mode === 'drafts';
  const isSent = mode === 'sent';
  const showId = isDrafts || isSent;

  return (
    <tr className="border-t border-border hover:bg-secondary/40 transition group cursor-pointer">
      {showId && (
        <td className="px-5 py-4 text-right">
          <span className="inline-flex items-center font-mono text-[12px] font-semibold text-indigo-300 bg-indigo-500/10 border border-indigo-400/25 rounded-md px-2.5 py-1">
            {letter.letterNumber ?? '—'}
          </span>
        </td>
      )}
      <td className="max-w-[260px] px-5 py-4">
        <button
          type="button"
          className="flex w-full items-center gap-2.5 text-right"
          onClick={() => onOpen(letter)}
        >
          <span className="size-8 rounded-lg bg-indigo-500/10 grid place-items-center text-indigo-300 shrink-0">
            <FileText className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold text-foreground truncate hover:text-primary transition">
              {letter.subject}
            </div>
            <span className="mt-1 flex items-center gap-1.5">
              <CorrUrgencyBadge urgency={letter.urgency} />
              {letter.classification !== 'NORMAL' && (
                <CorrClassificationBadge classification={letter.classification} />
              )}
            </span>
          </div>
        </button>
      </td>
      <td className="max-w-[160px] truncate px-5 py-4 text-muted-foreground">
        {(letter.recipients ?? []).length > 0
          ? (letter.recipients ?? [])
              .slice(0, 2)
              .map((recipient) => corrUserName(recipient.user))
              .join('، ') + ((letter.recipients ?? []).length > 2 ? ' …' : '')
          : corrUserName(letter.sender)}
      </td>
      {isDrafts ? (
        <>
          <td className="px-5 py-4">
            <CorrStatusBadge status={letter.status} />
          </td>
          <td className="px-5 py-4 tabular-nums text-muted-foreground">
            {formatCorrDate(letter.createdAt)}
          </td>
          <td className="px-5 py-4 tabular-nums text-muted-foreground">
            {formatCorrDate(letter.updatedAt)}
          </td>
        </>
      ) : isSent ? (
        <>
          <td className="px-5 py-4 tabular-nums text-muted-foreground">
            {formatCorrDate(letter.sentAt ?? letter.updatedAt)}
          </td>
          <td className="px-5 py-4">{renderExtra ? renderExtra(letter) : '—'}</td>
        </>
      ) : (
        <>
          <td className="px-5 py-4">
            <CorrStatusBadge status={letter.status} />
          </td>
          <td className="px-5 py-4 tabular-nums text-muted-foreground">
            {formatCorrDate(letter.sentAt ?? letter.updatedAt)}
          </td>
          {renderExtra && <td className="px-5 py-4">{renderExtra(letter)}</td>}
        </>
      )}
      <td className="relative px-3 py-4 text-center" data-corr-menu>
        <button
          type="button"
          aria-label={`عملیات برای ${letter.subject}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="size-9 grid place-items-center rounded-lg border border-border/60 bg-secondary/40 hover:bg-secondary hover:border-primary/40 text-muted-foreground hover:text-foreground transition"
          onClick={() => setMenuFor(menuOpen ? null : letter.id)}
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
        <DropdownPanel
          open={menuOpen}
          role="menu"
            aria-label={`عملیات ${letter.subject}`}
          className="absolute left-4 top-11 z-20 w-52 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-lg"
        >
            {isDrafts && (
              <MenuItem
                icon={FileEdit}
                label="ادامه ویرایش"
                onClick={() => {
                  setMenuFor(null);
                  onOpen(letter);
                }}
              />
            )}
            <MenuItem
              icon={Eye}
              label={isDrafts ? 'مشاهده پیش‌نویس' : 'مشاهده نامه'}
              onClick={() => {
                setMenuFor(null);
                onOpen(letter);
              }}
            />
            {onSend && letter.status !== 'SENT' && isDrafts && (
              <MenuItem
                icon={Send}
                label="ارسال فوری"
                onClick={() => {
                  setMenuFor(null);
                  onSend(letter);
                }}
              />
            )}
            {onArchive && letter.status === 'SENT' && (
              <MenuItem
                icon={FolderInput}
                label="بایگانی"
                onClick={() => {
                  setMenuFor(null);
                  onArchive(letter);
                }}
              />
            )}
            <div className="my-1 h-px bg-border" />
            <MenuItem
              icon={Trash2}
              label={deleteLabel}
              danger
              onClick={() => {
                setMenuFor(null);
                onRequestDelete(letter);
              }}
            />
        </DropdownPanel>
      </td>
    </tr>
  );
}

function CorrDeleteDialog({
  title,
  body,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="corr-delete-title"
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-2xl" dir="rtl">
        <h2 id="corr-delete-title" className="text-sm font-bold text-foreground text-right">
          {title}
        </h2>
        <p className="mt-2 text-xs leading-6 text-muted-foreground text-right">{body}</p>
        <div className="mt-4 flex flex-row-reverse justify-start gap-2">
          <button
            type="button"
            autoFocus
            className="h-9 rounded-xl bg-destructive px-4 text-xs font-semibold text-destructive-foreground transition hover:bg-destructive/90"
            onClick={onConfirm}
          >
            حذف کن
          </button>
          <button
            type="button"
            className="h-9 rounded-xl border border-border px-4 text-xs font-medium text-foreground transition hover:bg-secondary"
            onClick={onCancel}
          >
            انصراف
          </button>
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'flex w-full items-center gap-2.5 px-3 py-2 text-right text-xs transition',
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-secondary',
      )}
      onClick={onClick}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="flex-1">{label}</span>
    </button>
  );
}
