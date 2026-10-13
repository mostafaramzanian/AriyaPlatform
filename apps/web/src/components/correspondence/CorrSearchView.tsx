'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Search,
  Filter,
  RotateCcw,
  FileText,
  Eye,
  Paperclip,
  Calendar,
  FolderOpen,
  Shield,
  Clock,
} from 'lucide-react';
import {
  CLASSIFICATION_LABELS,
  LETTER_CATEGORIES,
  STATUS_LABELS,
  URGENCY_LABELS,
  corrUserName,
  formatCorrDate,
  searchLetters,
  type CorrLetter,
  type CorrSearchQuery,
  type LetterClassification,
  type LetterUrgency,
} from '@/lib/correspondence-api';


/**
 * Phase 50S: Advanced search page styled like the Lovable reference.
 *
 * - Real /correspondence/search backend.
 * - Two-column layout: results on the left, filter panel on the right.
 * - Loads on mount and shows a polished result table.
 */

const PAGE_LIMIT = 25;

type SearchRow = CorrLetter & { attachmentCount: number };

const EMPTY_FORM = {
  q: '',
  letterNumber: '',
  subject: '',
  category: '',
  status: '',
  urgency: '',
  classification: '',
  dateFrom: '',
  dateTo: '',
  hasAttachments: 'any' as 'any' | 'yes' | 'no',
  confidential: 'any' as 'any' | 'yes' | 'no',
};

export function CorrSearchView() {
  const router = useRouter();
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [rows, setRows] = React.useState<SearchRow[]>([]);
  // Skeleton-first: the mount search below is already in flight from the
  // initial `useState`, and every form change re-arms loading/cleared in its
  // own handler (same commit) — never in the effect body
  // (`react-hooks/set-state-in-effect`): the effect only settles.
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const buildQuery = React.useCallback((): CorrSearchQuery => {
    const query: CorrSearchQuery = { limit: PAGE_LIMIT, scope: 'visible' };
    if (form.q.trim()) query.q = form.q.trim();
    if (form.letterNumber.trim()) query.letterNumber = form.letterNumber.trim();
    if (form.subject.trim()) query.subject = form.subject.trim();
    if (form.category) query.category = form.category;
    if (form.status) query.status = form.status;
    if (form.urgency) query.urgency = form.urgency as LetterUrgency;
    if (form.classification) query.classification = form.classification as LetterClassification;
    if (form.dateFrom) query.dateFrom = new Date(form.dateFrom).toISOString();
    if (form.dateTo) query.dateTo = new Date(form.dateTo).toISOString();
    if (form.hasAttachments !== 'any') query.hasAttachments = form.hasAttachments;
    if (form.confidential !== 'any') query.confidential = form.confidential;
    return query;
  }, [form]);

  const run = React.useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const result = await searchLetters(buildQuery());
      setRows(result.items);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'جستجو ناموفق بود.');
    } finally {
      setIsLoading(false);
    }
  }, [buildQuery]);

  // Form-driven (and first-mount) search: settles only — the loading/cleared
  // arming that used to sit here synchronously moved into the handlers that
  // change the query (`setField`/`reset`) and into the initial `useState`.
  React.useEffect(() => {
    searchLetters(buildQuery())
      .then((result) => setRows(result.items))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'جستجو ناموفق بود.');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [buildQuery]);

  const setField = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) => {
    setError(null);
    setIsLoading(true);
    setForm((current) => ({ ...current, [key]: value }));
  };

  const reset = () => {
    setError(null);
    setIsLoading(true);
    setForm(EMPTY_FORM);
    void run();
  };

  const activeFilters =
    (form.q ? 1 : 0) +
    (form.letterNumber ? 1 : 0) +
    (form.subject ? 1 : 0) +
    (form.category ? 1 : 0) +
    (form.status ? 1 : 0) +
    (form.urgency ? 1 : 0) +
    (form.classification ? 1 : 0) +
    (form.dateFrom ? 1 : 0) +
    (form.dateTo ? 1 : 0) +
    (form.hasAttachments !== 'any' ? 1 : 0) +
    (form.confidential !== 'any' ? 1 : 0);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6" dir="rtl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="size-11 rounded-xl gradient-primary grid place-items-center shadow-glow">
            <Search className="size-5 text-primary-foreground" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-foreground">جستجوی پیشرفته مکاتبات</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              جستجو در نامه‌های قابل مشاهده شما با فیلترهای آنی — نتایج از سرور بارگذاری می‌شوند.
            </p>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Results */}
        <section className="lg:col-span-8 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-foreground">نتایج جستجو</h2>
              <span className="text-xs text-muted-foreground bg-secondary rounded-full px-2.5 py-0.5">
                {rows.length} مورد
              </span>
            </div>
            <div className="relative flex-1 sm:max-w-sm">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="search"
                placeholder="جستجو در موضوع، فرستنده، گیرنده…"
                value={form.q}
                onChange={(event) => setField('q', event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void run();
                }}
                className="w-full h-10 rounded-xl bg-secondary/60 border border-border pr-10 pl-4 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition"
              />
            </div>
          </div>

          {isLoading && (
            <div
              role="status"
              aria-live="polite"
              className="py-8 text-center text-xs text-muted-foreground"
            >
              در حال بارگذاری نتایج…
            </div>
          )}

          {!isLoading && error && (
            <div
              role="alert"
              className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive"
            >
              {error}
              <button type="button" className="mr-2 underline" onClick={() => run()}>
                تلاش دوباره
              </button>
            </div>
          )}

          {!isLoading && !error && rows.length === 0 && (
            <div className="rounded-2xl border border-border bg-card p-8 text-center text-muted-foreground">
              <span className="grid size-14 place-items-center rounded-2xl bg-secondary/60 mx-auto mb-3">
                <Search className="size-6" aria-hidden="true" />
              </span>
              <p className="text-sm">نتیجه‌ای یافت نشد.</p>
              <p className="text-[11px] mt-1">فیلترها را تغییر دهید یا همه را پاک کنید.</p>
            </div>
          )}

          {!isLoading && !error && rows.length > 0 && (
            <div className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[720px] text-right text-sm">
                  <thead>
                    <tr className="text-right text-[11px] uppercase tracking-wider text-muted-foreground bg-secondary/40">
                      <th scope="col" className="px-5 py-3 font-medium w-[120px]">شماره</th>
                      <th scope="col" className="px-5 py-3 font-medium">موضوع</th>
                      <th scope="col" className="px-5 py-3 font-medium w-[140px]">فرستنده</th>
                      <th scope="col" className="px-5 py-3 font-medium w-[140px]">گیرنده</th>
                      <th scope="col" className="px-5 py-3 font-medium w-[100px]">وضعیت</th>
                      <th scope="col" className="px-5 py-3 font-medium w-[120px]">تاریخ</th>
                      <th scope="col" className="px-5 py-3 font-medium text-center w-[80px]">اقدام</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className="border-t border-border hover:bg-secondary/40 transition group cursor-pointer"
                        onClick={() => router.push(`/admin/correspondence/${row.id}`)}
                      >
                        <td className="px-5 py-4">
                          <span className="inline-flex items-center font-mono text-[12px] font-semibold text-indigo-300 bg-indigo-500/10 border border-indigo-400/25 rounded-md px-2.5 py-1">
                            {row.letterNumber ?? '—'}
                          </span>
                        </td>
                        <td className="max-w-[18rem] px-5 py-4">
                          <div className="font-medium truncate text-foreground">{row.subject}</div>
                          {row.attachmentCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground mt-1">
                              <Paperclip className="size-3" aria-hidden="true" />
                              {row.attachmentCount} پیوست
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-4 text-muted-foreground truncate">
                          {corrUserName(row.sender)}
                        </td>
                        <td className="px-5 py-4 text-muted-foreground truncate">
                          {(row.recipients ?? []).length > 0
                            ? (row.recipients ?? [])
                                .slice(0, 1)
                                .map((r) => corrUserName(r.user))
                                .join('') + ((row.recipients ?? []).length > 1 ? ' …' : '')
                            : '—'}
                        </td>
                        <td className="px-5 py-4">
                          {row.status === 'SENT' ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-400/25 px-2 py-0.5 text-[11px] font-medium">
                              ارسال شده
                            </span>
                          ) : row.status === 'DRAFT' ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-300 border border-amber-400/25 px-2 py-0.5 text-[11px] font-medium">
                              پیش‌نویس
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 text-sky-300 border border-sky-400/25 px-2 py-0.5 text-[11px] font-medium">
                              {STATUS_LABELS[row.status as keyof typeof STATUS_LABELS] ?? row.status}
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-4 tabular-nums text-muted-foreground">
                          {formatCorrDate(row.sentAt ?? row.createdAt)}
                        </td>
                        <td className="px-5 py-4 text-center">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              router.push(`/admin/correspondence/${row.id}`);
                            }}
                            className="inline-flex items-center gap-1 rounded-lg bg-primary/10 text-primary border border-primary/20 px-2.5 py-1.5 text-[11px] font-medium hover:bg-primary/20 transition"
                          >
                            <Eye className="size-3.5" aria-hidden="true" />
                            مشاهده
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* Filters */}
        <aside className="lg:col-span-4 space-y-4">
          <div className="rounded-2xl border border-border bg-card p-4 shadow-card lg:sticky lg:top-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Filter className="size-4 text-primary" aria-hidden="true" />
                <h3 className="text-sm font-bold text-foreground">فیلترهای پیشرفته</h3>
              </div>
              {activeFilters > 0 && (
                <span className="text-[11px] font-medium rounded-full bg-primary/10 text-primary px-2 py-0.5">
                  {activeFilters} فیلتر
                </span>
              )}
            </div>

            <div className="space-y-5">
              {/* Main info */}
              <div>
                <h4 className="text-[11px] font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                  <FileText className="size-3" aria-hidden="true" />
                  اطللاعات پایه
                </h4>
                <div className="space-y-3">
                  <Field label="شماره نامه">
                    <input
                      type="text"
                      value={form.letterNumber}
                      onChange={(event) => setField('letterNumber', event.target.value)}
                      placeholder="AR-…"
                      className="h-10 w-full rounded-xl border border-border bg-secondary/60 px-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 font-mono"
                    />
                  </Field>
                  <Field label="موضوع">
                    <input
                      type="text"
                      value={form.subject}
                      onChange={(event) => setField('subject', event.target.value)}
                      placeholder="عنوان نامه…"
                      className="h-10 w-full rounded-xl border border-border bg-secondary/60 px-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                  </Field>
                  <Field label="دسته">
                    <Select
                      value={form.category}
                      onChange={(event) => setField('category', event.target.value)}
                      options={[
                        { label: 'همه', value: '' },
                        ...LETTER_CATEGORIES.map((c) => ({ label: c, value: c })),
                      ]}
                    />
                  </Field>
                </div>
              </div>

              <div className="h-px bg-border" />

              {/* Letter attributes */}
              <div>
                <h4 className="text-[11px] font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                  <Clock className="size-3" aria-hidden="true" />
                  مشخصات نامه
                </h4>
                <div className="space-y-3">
                  <Field label="وضعیت">
                    <Select
                      value={form.status}
                      onChange={(event) => setField('status', event.target.value)}
                      options={[
                        { label: 'همه', value: '' },
                        ...(Object.keys(STATUS_LABELS) as Array<keyof typeof STATUS_LABELS>).map((key) => ({
                          label: STATUS_LABELS[key],
                          value: key,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="فوریت">
                    <Select
                      value={form.urgency}
                      onChange={(event) => setField('urgency', event.target.value as LetterUrgency)}
                      options={[
                        { label: 'همه', value: '' },
                        ...(Object.keys(URGENCY_LABELS) as LetterUrgency[]).map((key) => ({
                          label: URGENCY_LABELS[key],
                          value: key,
                        })),
                      ]}
                    />
                  </Field>
                  <Field label="طبقه‌بندی">
                    <Select
                      value={form.classification}
                      onChange={(event) => setField('classification', event.target.value as LetterClassification)}
                      options={[
                        { label: 'همه', value: '' },
                        ...(Object.keys(CLASSIFICATION_LABELS) as LetterClassification[]).map((key) => ({
                          label: CLASSIFICATION_LABELS[key],
                          value: key,
                        })),
                      ]}
                    />
                  </Field>
                </div>
              </div>

              <div className="h-px bg-border" />

              {/* Date range */}
              <div>
                <h4 className="text-[11px] font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                  <Calendar className="size-3" aria-hidden="true" />
                  بازه زمانی
                </h4>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="از تاریخ">
                    <input
                      type="date"
                      value={form.dateFrom}
                      onChange={(event) => setField('dateFrom', event.target.value)}
                      className="h-10 w-full rounded-xl border border-border bg-secondary/60 px-2 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                  </Field>
                  <Field label="تا تاریخ">
                    <input
                      type="date"
                      value={form.dateTo}
                      onChange={(event) => setField('dateTo', event.target.value)}
                      className="h-10 w-full rounded-xl border border-border bg-secondary/60 px-2 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                  </Field>
                </div>
              </div>

              <div className="h-px bg-border" />

              {/* Extra */}
              <div>
                <h4 className="text-[11px] font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
                  <Shield className="size-3" aria-hidden="true" />
                  سایر
                </h4>
                <div className="space-y-3">
                  <Field label="پیوست">
                    <Select
                      value={form.hasAttachments}
                      onChange={(event) =>
                        setField('hasAttachments', event.target.value as typeof form.hasAttachments)
                      }
                      options={[
                        { label: 'همه', value: 'any' },
                        { label: 'دارد', value: 'yes' },
                        { label: 'ندارد', value: 'no' },
                      ]}
                    />
                  </Field>
                  <Field label="محرمانه/سری">
                    <Select
                      value={form.confidential}
                      onChange={(event) =>
                        setField('confidential', event.target.value as typeof form.confidential)
                      }
                      options={[
                        { label: 'همه', value: 'any' },
                        { label: 'محرمانه/سری', value: 'yes' },
                        { label: 'عادی', value: 'no' },
                      ]}
                    />
                  </Field>
                </div>
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => run()}
                  disabled={isLoading}
                  className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl gradient-primary px-4 text-sm font-bold text-primary-foreground shadow-glow hover:opacity-95 transition disabled:opacity-60"
                >
                  <Search className="size-3.5" aria-hidden="true" />
                  جستجو
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border px-4 text-sm font-medium text-foreground transition hover:bg-secondary"
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  پاک کردن
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5 text-[11px] font-medium text-muted-foreground">
      <span className="block">{label}</span>
      {children}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: React.ChangeEventHandler<HTMLSelectElement>;
  options: { label: string; value: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={onChange}
        className="h-10 w-full appearance-none rounded-xl border border-border bg-secondary/60 pl-9 pr-3 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" aria-hidden="true" />
    </div>
  );
}
