'use client';

import * as React from 'react';
import Image from 'next/image';
import { DropdownPanel } from '@/components/ui/dropdown-panel';
import { useRef } from 'react';
import {
  Save,
  Send,
  Paperclip,
  Upload,
  X,
  Sparkles,
  PenLine,
  Eye,
  EyeOff,
  Hash,
  Calendar,
  Clock,
  Tag,
  Flame,
  FileText,
  Trash2,
  ChevronDown,
  Check,
  RotateCcw,
} from 'lucide-react';
import {
  LETTER_CATEGORIES,
  CLASSIFICATION_LABELS,
  MAX_SUBJECT_LENGTH,
  formatCorrDate,
  type CorrAttachment,
  type CorrLetter,
  type LetterClassification,
  type LetterUrgency,
} from '@/lib/correspondence-api';
import {
  formatJalaliLabel,
  getCalendarToday,
  parseDateKey,
  toLatinDigits,
  toPersianDigits,
  type CalendarDay,
} from '@/lib/calendar-api';
import { CoreJalaliDatePicker } from '@/components/core/CoreJalaliDatePicker';
import { cn } from '@/lib/utils';
import { RichLetterEditor } from './RichLetterEditor';
import { RecipientPicker } from './RecipientPicker';

/** Attachment surface of the composer — temp uploads are allowed before a draft exists. */
export interface ComposerAttachments {
  items: CorrAttachment[];
  canUpload: boolean;
  busy: boolean;
  onUpload: (file: File) => void;
  onDelete: (attachmentId: string) => void;
}

export interface ComposerState {
  subject: string;
  setSubject: (value: string) => void;
  category: string;
  setCategory: (value: string) => void;
  urgency: LetterUrgency;
  setUrgency: (value: LetterUrgency) => void;
  classification: LetterClassification;
  setClassification: (value: LetterClassification) => void;
  letterDate: string;
  setLetterDate: (value: string) => void;
  letterNumber: string;
  setLetterNumber: (value: string) => void;
  toIds: string[];
  setToIds: (value: string[]) => void;
  ccIds: string[];
  setCcIds: (value: string[]) => void;
  bccIds: string[];
  setBccIds: (value: string[]) => void;
  showBcc: boolean;
  setShowBcc: (value: boolean) => void;
  body: string;
  setBody: (value: string) => void;
  signatureUrl: string | null;
  setSignatureUrl: (value: string | null) => void;
  scheduledAtDate: string | null;
  setScheduledAtDate: (value: string | null) => void;
  scheduledAtTime: string;
  setScheduledAtTime: (value: string) => void;
}

function ScheduledAtField({
  date,
  time,
  onDate,
  onTime,
  onClear,
}: {
  date: string | null;
  time: string;
  onDate: (value: string | null) => void;
  onTime: (value: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [today, setToday] = React.useState<CalendarDay | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const surfaceRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    getCalendarToday().then(setToday).catch(() => setToday(null));
  }, []);

  React.useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (triggerRef.current && triggerRef.current.contains(event.target)) return;
      if (surfaceRef.current && surfaceRef.current.contains(event.target)) return;
      setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const selectedParts = React.useMemo(() => (date ? parseDateKey(date) : null), [date]);
  const initialMonth = React.useMemo(
    () => (selectedParts ? { jy: selectedParts.jy, jm: selectedParts.jm } : today ? { jy: today.jy, jm: today.jm } : { jy: 1405, jm: 6 }),
    [selectedParts, today]
  );
  const todayKey = today ? today.date : '1405/06/21';

  const displayDate = React.useMemo(() => {
    if (!date) return 'فوری — ارسال همین حالا';
    const parsed = parseDateKey(date);
    if (!parsed) return date;
    return `${formatJalaliLabel(parsed)}${time ? `، ${toPersianDigits(time)}` : ''}`;
  }, [date, time]);

  const handleSelect = (value: string) => {
    onDate(value);
    if (!time) onTime('00:00');
  };

  const handleTimeChange = (value: string) => {
    const raw = toLatinDigits(value).replace(/[^0-9]/g, '').slice(0, 4);
    let hh = raw.slice(0, 2);
    let mm = raw.slice(2);
    if (hh.length === 2 && hh > '23') hh = '23';
    if (mm.length === 2 && mm > '59') mm = '59';
    const formatted = raw.length > 2 ? `${hh}:${mm}` : raw;
    onTime(formatted);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full h-11 items-center justify-between rounded-xl border border-border bg-secondary/60 px-3 text-sm outline-none transition focus:bg-secondary focus:ring-2 focus:ring-primary/20"
      >
        <span className={cn('font-mono', !date && 'text-muted-foreground')}>
          {toPersianDigits(displayDate)}
        </span>
        <ChevronDown className={cn('size-4 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} />
      </button>

      <DropdownPanel
        open={open}
        ref={surfaceRef}
        className="absolute z-50 mt-1 w-80 rounded-2xl border border-border bg-card p-4 shadow-card"
          style={{ direction: 'rtl', textAlign: 'right' }}
        >
          {!today ? (
            <div className="p-4 text-sm text-muted-foreground text-center">در حال بارگذاری تقویم…</div>
          ) : (
            <>
              <CoreJalaliDatePicker
                value={date}
                onSelect={handleSelect}
                initialMonth={initialMonth}
                todayKey={todayKey}
                className="w-full"
              />
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-secondary/40 p-2">
                <Clock className="size-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground whitespace-nowrap">ساعت (۲۴ ساعته):</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={toPersianDigits(time)}
                  onChange={(e) => handleTimeChange(e.target.value)}
                  placeholder="۱۴:۳۰"
                  className="flex-1 h-9 rounded-lg border-0 bg-transparent px-2 text-left font-mono text-sm outline-none"
                  dir="ltr"
                />
                {time && (
                  <button
                    type="button"
                    onClick={() => onTime('')}
                    className="rounded-lg p-1.5 hover:bg-secondary"
                  >
                    <X className="size-4 text-muted-foreground" />
                  </button>
                )}
              </div>
              {date && (
                <button
                  type="button"
                  onClick={onClear}
                  className="mt-3 w-full rounded-lg py-2 text-xs text-muted-foreground hover:bg-secondary transition"
                >
                  ارسال فوری (بدون زمان‌بندی)
                </button>
              )}
            </>
          )}
      </DropdownPanel>
    </div>
  );
}

const URGENCIES: LetterUrgency[] = ['NORMAL', 'IMPORTANT', 'URGENT', 'CRITICAL'];
const CLASSIFICATIONS: LetterClassification[] = ['NORMAL', 'CONFIDENTIAL', 'SECRET'];

const urgencyMeta: Record<LetterUrgency, { label: string; cls: string; dot: string }> = {
  NORMAL: { label: 'عادی', cls: 'bg-secondary/70 text-foreground border-border hover:bg-secondary', dot: 'bg-muted-foreground' },
  IMPORTANT: { label: 'مهم', cls: 'bg-secondary/70 text-foreground border-border hover:bg-secondary', dot: 'bg-muted-foreground' },
  URGENT: { label: 'فوری', cls: 'bg-secondary/70 text-foreground border-border hover:bg-secondary', dot: 'bg-muted-foreground' },
  CRITICAL: { label: 'خیلی فوری', cls: 'bg-secondary/70 text-foreground border-border hover:bg-secondary', dot: 'bg-muted-foreground' },
};

const classificationMeta: Record<LetterClassification, { label: string; cls: string; dot: string }> = {
  NORMAL: { label: 'عادی', cls: 'bg-secondary/70 text-foreground border-border hover:bg-secondary', dot: 'bg-muted-foreground' },
  CONFIDENTIAL: { label: 'محرمانه', cls: 'bg-secondary/70 text-foreground border-border hover:bg-secondary', dot: 'bg-muted-foreground' },
  SECRET: { label: 'سری', cls: 'bg-secondary/70 text-foreground border-border hover:bg-secondary', dot: 'bg-muted-foreground' },
};

export function ComposerBody({
  letter,
  state: s,
  validationError,
  error,
  isBusy,
  attachments,
  onSaveDraft,
  onSend,
  onCancel,
  onSignatureUpload,
  onSignatureClear,
  defaultShowPreview = true,
}: {
  letter: CorrLetter | null;
  state: ComposerState;
  defaultShowPreview?: boolean;
  validationError: string | null;
  error: string | null;
  isBusy: boolean;
  attachments?: ComposerAttachments;
  onSaveDraft: () => void;
  onSend: () => void;
  onCancel: () => void;
  onSignatureUpload?: (file: File | string) => void;
  onSignatureClear?: () => void;
}) {
  const [showPreview, setShowPreview] = React.useState(defaultShowPreview);
  const taken = [...s.toIds, ...s.ccIds, ...s.bccIds];

  return (
    <div className="flex min-h-0 flex-1 flex-col" dir="rtl">
      {/* Page header */}
      <div className="px-6 lg:px-8 pt-6 pb-4 max-w-[1700px] w-full mx-auto">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="size-11 rounded-xl gradient-primary grid place-items-center shadow-glow">
              <Sparkles className="size-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl lg:text-2xl font-bold tracking-tight">ایجاد نامه جدید</h1>
              <p className="text-xs text-muted-foreground mt-0.5">نگارش، پیش‌نمایش و ارسال نامه‌ی رسمی سازمانی</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="hidden md:inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary/50 px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-secondary transition"
          >
            {showPreview ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            {showPreview ? 'مخفی کردن پیش‌نمایش' : 'نمایش پیش‌نمایش'}
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mx-auto w-full max-w-[1700px] px-6 lg:px-8 mb-4"
        >
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs leading-6 text-destructive">
            {error}
          </div>
        </div>
      )}

      {/* Body: split view */}
      <div className="flex-1 min-h-0 px-6 lg:px-8 pb-28 max-w-[1700px] w-full mx-auto">
        <div
          className={cn(
            "grid grid-cols-1 gap-6",
            showPreview && "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
            !showPreview && "max-w-4xl mx-auto"
          )}
        >
          {/* LEFT: Form */}
          <div className="min-w-0 space-y-5">
            {/* Header info card */}
            <Card>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="شماره نامه" icon={Hash}>
                  <div className="relative">
                    <input
                      value={s.letterNumber}
                      onChange={(e) => s.setLetterNumber(e.target.value)}
                      placeholder="AR-1405-00001"
                      className="w-full h-11 rounded-xl border border-border bg-secondary/60 px-3 text-sm font-mono tracking-wide outline-none transition focus:bg-secondary focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    اگر وارد نشود، سرور در زمان ارسال شماره صادر می‌کند.
                  </p>
                </Field>

                <Field label="زمان ارسال" icon={Calendar}>
                  <ScheduledAtField
                    date={s.scheduledAtDate}
                    time={s.scheduledAtTime}
                    onDate={s.setScheduledAtDate}
                    onTime={s.setScheduledAtTime}
                    onClear={() => {
                      s.setScheduledAtDate(null);
                      s.setScheduledAtTime('');
                    }}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">خالی = ارسال فوری؛ در غیر این صورت نامه در زمان واردشده ارسال می‌شود.</p>
                </Field>
              </div>
            </Card>

            {/* Subject & meta */}
            <Card>
              <Field label="موضوع نامه" required>
                <input
                  value={s.subject}
                  onChange={(event) => s.setSubject(event.target.value)}
                  maxLength={MAX_SUBJECT_LENGTH}
                  placeholder="موضوع نامه را وارد کنید…"
                  className="w-full h-13 py-3 rounded-xl border border-border bg-secondary/60 px-4 text-base font-medium outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition placeholder:text-muted-foreground/60"
                />
              </Field>
              {validationError && (
                <p role="alert" className="mt-1 text-[10.5px] leading-5 text-destructive">
                  {validationError}
                </p>
              )}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
                <Field label="دسته‌بندی" icon={Tag}>
                  <CategorySelect value={s.category} onChange={s.setCategory} />
                </Field>
                <Field label="فوریت نامه" icon={Flame}>
                  <UrgencySelect value={s.urgency} onChange={s.setUrgency} />
                </Field>
                <Field label="طبقه‌بندی" icon={Tag}>
                  <ClassificationSelect value={s.classification} onChange={s.setClassification} />
                </Field>
              </div>
            </Card>

            {/* Recipients */}
            <Card>
              <RecipientPicker
                label="گیرندگان"
                hint="از دفترچه سازمانی"
                selected={s.toIds}
                onChange={s.setToIds}
                takenElsewhere={taken}
              />
              <div className="mt-4">
                <RecipientPicker
                  label="رونوشت (CC)"
                  selected={s.ccIds}
                  onChange={s.setCcIds}
                  takenElsewhere={taken}
                />
              </div>
              {!s.showBcc ? (
                <button
                  type="button"
                  className="mt-4 text-[11px] text-muted-foreground underline transition hover:text-foreground"
                  onClick={() => s.setShowBcc(true)}
                >
                  افزودن گیرنده مخفی (BCC)
                </button>
              ) : (
                <div className="mt-4">
                  <RecipientPicker
                    label="مخفی (BCC)"
                    bcc
                    selected={s.bccIds}
                    onChange={s.setBccIds}
                    takenElsewhere={taken}
                  />
                </div>
              )}
            </Card>

            {/* Editor */}
            <Card padded={false}>
              <div className="px-5 pt-4 pb-2 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <FileText className="size-4 text-primary" />
                  متن نامه
                </div>
              </div>
              <div className="px-5 pb-5">
                <RichLetterEditor value={s.body} onChange={s.setBody} placeholder="متن نامه…" />
              </div>
            </Card>

            {/* Signature */}
            <Card>
              <SignatureCard
                signatureUrl={s.signatureUrl}
                onUpload={onSignatureUpload}
                onClear={onSignatureClear}
              />
            </Card>

            {/* Attachments */}
            {attachments && <AttachmentsCard attachments={attachments} />}
          </div>

          {showPreview && (
            <>
            {/* RIGHT: Live preview */}
            <div className="min-w-0 lg:sticky lg:top-[88px] lg:self-start">
              <div className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-gradient-to-l from-primary/10 to-transparent">
                  <div className="text-sm font-semibold flex items-center gap-2">
                    <Eye className="size-4 text-primary" /> پیش‌نمایش زنده
                  </div>
                  <span className={cn("inline-flex items-center gap-1.5 text-[10px] font-medium rounded-full border px-2 py-0.5", urgencyMeta[s.urgency].cls)}>
                    <span className={cn("size-1.5 rounded-full", urgencyMeta[s.urgency].dot)} />
                    {urgencyMeta[s.urgency].label}
                  </span>
                </div>

                <div className="p-5 max-h-[60vh] overflow-auto bg-white">
                  {/* Letterhead */}
                  <div className="relative rounded-xl bg-white text-slate-900 shadow-xl ring-1 ring-black/5 overflow-hidden">
                    <div className="absolute inset-x-0 top-0 h-1 gradient-primary" />
                    <div className="px-6 pt-6 pb-4 border-b border-slate-200 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="size-11 rounded-xl gradient-primary grid place-items-center shadow-glow">
                          <Sparkles className="size-5 text-white" />
                        </div>
                        <div>
                          <div className="text-base font-bold text-slate-800">آریا سیستم</div>
                          <div className="text-[10px] text-slate-500">Aria ERP — سامانه مکاتبات سازمانی</div>
                        </div>
                      </div>
                      <div className="text-left text-[11px] text-slate-600 leading-tight">
                        <div>شماره: <span className="font-mono font-semibold text-slate-800">{s.letterNumber.trim() || letter?.letterNumber || 'پیش‌نمایش'}</span></div>
                        <div>تاریخ: <span className="font-semibold text-slate-800">{s.scheduledAtDate ? formatJalaliLabel(parseDateKey(s.scheduledAtDate) ?? { jy: 1405, jm: 6, jd: 1 }) : formatCorrDate(new Date().toISOString())}</span></div>
                        <div>ساعت: <span className="font-semibold text-slate-800">{s.scheduledAtDate && s.scheduledAtTime ? toPersianDigits(s.scheduledAtTime) : nowFa()}</span></div>
                      </div>
                    </div>

                    <div className="px-6 py-5 space-y-4">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">موضوع</div>
                        <div className="text-base font-bold text-slate-800">
                          {s.subject || <span className="text-slate-400 font-normal">— موضوع نامه —</span>}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2 text-[11px]">
                        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", classificationMeta[s.classification].cls)}>
                          <span className={cn("size-1 rounded-full", classificationMeta[s.classification].dot)} />
                          {CLASSIFICATION_LABELS[s.classification]}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-100 text-slate-700 px-2 py-0.5">
                          {s.category}
                        </span>
                      </div>

                      {taken.length > 0 && (
                        <div className="text-[12px] text-slate-700">
                          <span className="text-slate-500">گیرنده: </span>
                          {taken.length} نفر
                        </div>
                      )}

                      <div className="h-px bg-slate-200" />

                      <div
                        className="text-[13px] leading-loose text-slate-800 [&_*]:text-slate-800"
                        dangerouslySetInnerHTML={{ __html: sanitizePreviewHtml(s.body) || "<p class='text-slate-400'>متن نامه اینجا نمایش داده می‌شود…</p>" }}
                      />

                      <div className="pt-4 mt-4 border-t border-dashed border-slate-200 flex items-end justify-between gap-3">
                        <div className="text-[11px] text-slate-500 leading-relaxed">
                          با تشکر،<br/>
                          <span className="text-slate-700 font-semibold">فرستنده</span><br/>
                          سامانه مکاتبات
                        </div>
                        <div className="text-center">
                          {s.signatureUrl ? (
                            <Image
                              src={s.signatureUrl}
                              alt="امضا"
                              unoptimized
                              width={140}
                              height={80}
                              className="max-h-[80px] object-contain rounded bg-white p-1"
                            />
                          ) : (
                            <div className="h-[64px] w-[140px] rounded border border-dashed border-slate-300 grid place-items-center text-[10px] text-slate-400">
                              محل امضا
                            </div>
                          )}
                          <div className="text-[10px] text-slate-500 mt-1">امضای دیجیتال</div>
                        </div>
                      </div>

                      {attachments && attachments.items.length > 0 && (
                        <div className="pt-3 border-t border-slate-200">
                          <div className="text-[10px] uppercase tracking-wider text-slate-400 mb-2">پیوست‌ها ({attachments.items.length})</div>
                          <ul className="space-y-1">
                            {attachments.items.map((f) => (
                              <li key={f.id} className="flex items-center gap-2 text-[11px] text-slate-700">
                                <Paperclip className="size-3 text-slate-400" />
                                <span className="truncate">{f.fileName}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            </>
          )}
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 z-10 border-t border-border bg-background/95 backdrop-blur-xl">
        <div className="max-w-[1700px] mx-auto px-6 lg:px-8 h-[76px] flex items-center justify-between gap-3">
          <div className="text-[11px] text-muted-foreground hidden md:block">
            آخرین ذخیره خودکار: لحظاتی پیش
          </div>
          <div className="flex items-center gap-2 ms-auto">
            <button
              type="button"
              onClick={onCancel}
              className="h-10 px-4 rounded-xl text-xs text-muted-foreground transition hover:text-foreground"
            >
              انصراف
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={onSaveDraft}
              className="h-11 px-5 rounded-xl border border-border bg-secondary/60 hover:bg-secondary text-sm font-medium inline-flex items-center gap-2 transition disabled:opacity-60"
            >
              <Save className="size-4" /> ذخیره به عنوان پیش‌نویس
            </button>
            <button
              type="button"
              disabled={isBusy}
              onClick={onSend}
              className="h-11 px-6 rounded-xl gradient-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-2 shadow-glow hover:opacity-95 transition disabled:opacity-60"
            >
              <Send className="size-4" /> ارسال نامه
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({ children, padded = true }: { children: React.ReactNode; padded?: boolean }) {
  return (
    <div className={cn(
      "rounded-2xl border border-border bg-card shadow-card",
      padded && "p-5"
    )}>{children}</div>
  );
}

function Field({
  label, icon: Icon, required, children,
}: { label: string; icon?: React.ComponentType<{ className?: string }>; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5 text-[12px] font-medium text-foreground/85">
        {Icon && <Icon className="size-3.5 text-muted-foreground" />}
        {label}
        {required && <span className="text-rose-400">*</span>}
      </div>
      {children}
    </div>
  );
}

function CategorySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="w-full h-11 rounded-xl border border-border bg-secondary/60 px-3 text-xs flex items-center justify-between outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition"
      >
        <span className="flex-1 text-right text-foreground font-medium">{value}</span>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-200 ms-2", open && "rotate-180")} />
      </button>
      <DropdownPanel open={open} className="absolute z-20 mt-1.5 w-full rounded-xl border border-border bg-card shadow-card overflow-hidden py-1">
          {LETTER_CATEGORIES.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => { onChange(entry); setOpen(false); }}
              className={cn(
                "w-full h-10 px-3 flex items-center justify-between gap-2 text-xs transition hover:bg-secondary/60",
                value === entry ? "bg-secondary text-foreground" : "text-muted-foreground"
              )}
            >
              <span className="flex-1 text-right">{entry}</span>
              {value === entry && <span className="size-1.5 rounded-full bg-primary" />}
            </button>
          ))}
      </DropdownPanel>
    </div>
  );
}

function UrgencySelect({ value, onChange }: { value: LetterUrgency; onChange: (value: LetterUrgency) => void }) {
  return (
    <CustomSelect
      options={URGENCIES.map((u) => ({ key: u, label: urgencyMeta[u].label, meta: urgencyMeta[u] }))}
      value={value}
      onChange={(k) => onChange(k as LetterUrgency)}
      badge={(m) => (
        <span className={cn("inline-flex items-center text-[12px] font-medium", m.cls)}>
          {m.label}
        </span>
      )}
    />
  );
}

function ClassificationSelect({ value, onChange }: { value: LetterClassification; onChange: (value: LetterClassification) => void }) {
  return (
    <CustomSelect
      options={CLASSIFICATIONS.map((c) => ({ key: c, label: classificationMeta[c].label, meta: classificationMeta[c] }))}
      value={value}
      onChange={(k) => onChange(k as LetterClassification)}
      badge={(m) => (
        <span className={cn("inline-flex items-center text-[12px] font-medium", m.cls)}>
          {m.label}
        </span>
      )}
    />
  );
}

interface CustomSelectOption<M> {
  key: string;
  label: string;
  meta: M;
}

function CustomSelect<M extends { cls: string; dot: string }>({
  options,
  value,
  onChange,
  badge,
}: {
  options: CustomSelectOption<M>[];
  value: string;
  onChange: (key: string) => void;
  badge: (meta: M, label: string) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const active = React.useMemo(() => options.find((o) => o.key === value) ?? options[0], [options, value]);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="w-full h-11 rounded-xl border border-border bg-secondary/60 px-3 text-xs flex items-center justify-between outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition"
      >
        <span className="flex-1 text-right">{badge(active.meta, active.label)}</span>
        <ChevronDown className={cn("size-4 text-muted-foreground transition-transform duration-200 ms-2", open && "rotate-180")} />
      </button>
      <DropdownPanel open={open} className="absolute z-20 mt-1.5 w-full rounded-xl border border-border bg-card shadow-card overflow-hidden py-1">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => { onChange(o.key); setOpen(false); }}
              className={cn(
                "w-full h-10 px-3 flex items-center justify-between gap-2 text-xs transition hover:bg-secondary/60",
                value === o.key ? "bg-secondary" : ""
              )}
            >
              <span className="flex-1 text-right">{badge(o.meta, o.label)}</span>
              {value === o.key && <span className="size-1.5 rounded-full bg-primary" />}
            </button>
          ))}
      </DropdownPanel>
    </div>
  );
}

function sanitizePreviewHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<!--\[if[^]*?\]-->/gi, '')
    .replace(/style="([^"]*)"/gi, (_, styles) => {
      const align = styles.match(/text-align\s*:\s*([^;"\s]+)/i);
      if (!align) return '';
      const a = align[1].toLowerCase();
      if (a === 'left') return '';
      return `style="text-align:${a};"`;
    })
    .replace(/ class="[^"]*"/gi, '')
    .replace(/ dir="[^"]*"/gi, '')
    .replace(/<span[^>]*>\s*<\/span>/gi, '');
}

function SignatureCard({
  signatureUrl,
  onUpload,
  onClear,
}: {
  signatureUrl: string | null;
  onUpload?: (file: File | string) => void;
  onClear?: () => void;
}) {
  const sigInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const isDrawingRef = useRef(false);
  const [drawing, setDrawing] = React.useState(false);
  const [hasStroke, setHasStroke] = React.useState(false);

  const getCtx = () => {
    const c = canvasRef.current;
    return c ? c.getContext('2d') : null;
  };

  const initCanvas = React.useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    c.width = Math.max(320, Math.floor(rect.width));
    c.height = 200;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#0f172a';
    setHasStroke(false);
  }, []);

  React.useEffect(() => {
    if (!drawing) return;
    // Defer init so the modal layout is measured.
    const id = requestAnimationFrame(initCanvas);
    return () => cancelAnimationFrame(id);
  }, [drawing, initCanvas]);

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const ctx = getCtx();
    if (!ctx || !canvasRef.current) return;
    isDrawingRef.current = true;
    const point = getPoint(e, canvasRef.current);
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    setHasStroke(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const ctx = getCtx();
    const c = canvasRef.current;
    if (!ctx || !c) return;
    const point = getPoint(e, c);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    isDrawingRef.current = false;
  };

  const handleDone = () => {
    const c = canvasRef.current;
    if (!c || !hasStroke) return;
    const dataUrl = c.toDataURL('image/png');
    onUpload?.(dataUrl);
    setDrawing(false);
    setHasStroke(false);
  };

  const handleFile = (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    onUpload?.(f);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold flex items-center gap-2">
          <PenLine className="size-4 text-primary" />
          امضای دیجیتال
        </div>
      </div>

      <div
        className={cn(
          "relative rounded-xl border-2 border-dashed bg-secondary/30 min-h-[150px] grid place-items-center text-center px-4 transition",
          signatureUrl ? "border-primary/40" : "border-border hover:border-primary/40"
        )}
      >
        {signatureUrl ? (
          <div className="flex flex-col items-center gap-2 py-3 w-full">
            <div className="text-xs text-muted-foreground">پیش‌نمایش امضا</div>
            <Image
              src={signatureUrl}
              alt="امضا"
              unoptimized
              width={220}
              height={110}
              className="max-h-[110px] object-contain rounded bg-white p-1"
            />
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => sigInputRef.current?.click()}
                className="text-[11px] text-primary hover:opacity-80 inline-flex items-center gap-1"
              >
                <Upload className="size-3" /> بارگذاری مجدد
              </button>
              <button
                type="button"
                onClick={() => setDrawing(true)}
                className="text-[11px] text-primary hover:opacity-80 inline-flex items-center gap-1"
              >
                <PenLine className="size-3" /> ترسیم مجدد
              </button>
              <button
                type="button"
                onClick={() => onClear?.()}
                className="text-[11px] text-rose-300 hover:text-rose-200 inline-flex items-center gap-1"
              >
                <Trash2 className="size-3" /> حذف امضا
              </button>
            </div>
          </div>
        ) : (
          <div className="py-5">
            <div className="size-10 mx-auto rounded-xl gradient-primary grid place-items-center shadow-glow mb-2">
              <PenLine className="size-5 text-primary-foreground" />
            </div>
            <div className="text-sm font-medium">امضای خود را بارگذاری یا ترسیم کنید</div>
            <div className="text-[11px] text-muted-foreground mt-1">PNG شفاف، حداکثر ۲ مگابایت</div>
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => sigInputRef.current?.click()}
                className="h-9 px-3 rounded-lg gradient-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5 shadow-glow"
              >
                <Upload className="size-3.5" /> بارگذاری
              </button>
              <button
                type="button"
                onClick={() => setDrawing(true)}
                className="h-9 px-3 rounded-lg border border-border bg-card text-foreground text-xs font-medium inline-flex items-center gap-1.5"
              >
                <PenLine className="size-3.5" /> ترسیم
              </button>
            </div>
            <input ref={sigInputRef} type="file" accept="image/*" hidden onChange={(e) => handleFile(e.target.files)} />
          </div>
        )}
      </div>

      {drawing && (
        <div
          ref={modalRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => { if (e.target === modalRef.current) setDrawing(false); }}
        >
          <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold flex items-center gap-2">
                <PenLine className="size-4 text-primary" />
                ترسیم امضا
              </div>
              <button
                type="button"
                onClick={() => setDrawing(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <canvas
              ref={canvasRef}
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
              className="w-full h-[200px] rounded-lg border border-border bg-white cursor-crosshair touch-none"
            />
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={handleDone}
                disabled={!hasStroke}
                className="h-9 px-4 rounded-lg gradient-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Check className="size-3.5" /> ذخیره امضا
              </button>
              <button
                type="button"
                onClick={initCanvas}
                className="h-9 px-4 rounded-lg border border-border bg-card text-foreground text-xs font-medium inline-flex items-center gap-1.5"
              >
                <RotateCcw className="size-3.5" /> پاک کردن
              </button>
              <button
                type="button"
                onClick={() => setDrawing(false)}
                className="h-9 px-4 rounded-lg border border-border bg-card text-foreground text-xs font-medium inline-flex items-center gap-1.5"
              >
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getPoint(e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const clientX = 'touches' in e ? e.touches[0]?.clientX ?? e.changedTouches[0]?.clientX ?? 0 : e.clientX;
  const clientY = 'touches' in e ? e.touches[0]?.clientY ?? e.changedTouches[0]?.clientY ?? 0 : e.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function AttachmentsCard({ attachments }: { attachments: ComposerAttachments }) {
  const [dragOver, setDragOver] = React.useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => attachments.onUpload(file));
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold flex items-center gap-2">
          <Paperclip className="size-4 text-primary" />
          پیوست‌ها
        </div>
        <div className="text-[11px] text-muted-foreground">
          {attachments.items.length.toLocaleString('fa-IR')} فایل
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
        className={cn(
          "relative rounded-2xl border-2 border-dashed bg-card p-6 text-center transition",
          dragOver ? "border-dotted border-primary bg-primary/5" : "border-border hover:border-dotted hover:border-primary/60"
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          disabled={attachments.busy}
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
        />
        <div
          className={cn(
            "size-12 mx-auto rounded-full grid place-items-center mb-3 transition",
            dragOver ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground"
          )}
        >
          <Upload className="size-5" />
        </div>
        <div className="text-sm font-medium text-foreground">
          فایل‌ها را اینجا رها کنید یا
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={attachments.busy}
          className="mt-3 h-10 px-5 rounded-xl gradient-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5 shadow-glow disabled:opacity-50"
        >
          <Upload className="size-3.5" /> انتخاب فایل
        </button>
        <div className="text-[10px] text-muted-foreground mt-3">
          PDF, DOCX, XLSX, JPG, PNG — حداکثر ۱۰ مگابایت
        </div>
      </div>

      {attachments.items.length > 0 && (
        <ul className="mt-4 space-y-2">
          {attachments.items.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 px-3 py-2"
            >
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-foreground">
                {file.fileName}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {Math.round(file.size / 1024).toLocaleString('fa-IR')} کیلوبایت
              </span>
              <button
                type="button"
                aria-label={`حذف پیوست ${file.fileName}`}
                disabled={attachments.busy}
                onClick={() => attachments.onDelete(file.id)}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function nowFa() {
  return new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' }).format(new Date());
}
