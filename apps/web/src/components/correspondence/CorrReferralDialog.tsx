'use client';

import * as React from 'react';
import { Forward, Search, X, Send, History } from 'lucide-react';
import { cn } from '@/lib/utils';
import { directoryFullName, fetchDirectory, type DirectoryMember } from '@/lib/directory-api';
import {
  REFERRAL_LEVEL_LABELS,
  URGENCY_LABELS,
  corrUserName,
  createReferral,
  formatCorrDate,
  listReferrals,
  newCorrKey,
  type CorrReferral,
  type LetterUrgency,
  type ReferralLevel,
} from '@/lib/correspondence-api';
import { ReferralStatusBadge, UrgencyBadge } from './CorrBadges';

/**
 * Phase 50: ارجاع dialog — the reference ReferralModal interaction pattern
 * (ارجاع جدید / سابقه ارجاع‌ها tabs) over the REAL Aria referral contract.
 * Person search uses the ORGANIZATION directory (never a hard-coded list);
 * creation is a server mutation; the حذف از کارتابل checkbox maps to the REAL
 * removeFromInbox behavior; history is read from the server, never cached.
 */

export interface CorrReferralDialogProps {
  letterId: string;
  letterSubject: string;
  /** The current user's id — self-referral is refused server-side and disabled here. */
  selfId: string;
  open: boolean;
  onClose: () => void;
  onReferred?: () => void;
}

export function CorrReferralDialog({
  letterId,
  letterSubject,
  selfId,
  open,
  onClose,
  onReferred,
}: CorrReferralDialogProps) {
  const [tab, setTab] = React.useState<'new' | 'history'>('new');
  const [targetId, setTargetId] = React.useState<string | null>(null);
  const [targetName, setTargetName] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<DirectoryMember[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const [level, setLevel] = React.useState<ReferralLevel>('REVIEW');
  const [urgency, setUrgency] = React.useState<LetterUrgency>('NORMAL');
  const [instruction, setInstruction] = React.useState('');
  const [removeFromInbox, setRemoveFromInbox] = React.useState(false);
  const [history, setHistory] = React.useState<CorrReferral[]>([]);
  const [isBusy, setIsBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || tab !== 'history') return;
    let active = true;
    listReferrals(letterId)
      .then((rows) => {
        if (active) setHistory(rows);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'خواندن سابقه ارجاع ناموفق بود.');
      });
    return () => {
      active = false;
    };
  }, [open, tab, letterId]);

  React.useEffect(() => {
    if (!open || tab !== 'new') return;
    const timer = window.setTimeout(() => {
      let active = true;
      setIsSearching(true);
      fetchDirectory({ q: query.trim() || undefined, limit: 12 })
        .then((result) => {
          if (active) setResults(result.items);
        })
        .catch(() => {
          if (active) setResults([]);
        })
        .finally(() => {
          if (active) setIsSearching(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open, tab, query]);

  if (!open) return null;

  const submit = async () => {
    if (!targetId) {
      setError('گیرنده ارجاع را انتخاب کنید.');
      return;
    }
    setError(null);
    setIsBusy(true);
    try {
      await createReferral(letterId, {
        toUserId: targetId,
        level,
        urgency,
        instruction: instruction.trim() || null,
        removeFromInbox,
        clientKey: newCorrKey(),
      });
      onReferred?.();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ثبت ارجاع ناموفق بود.');
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="corr-referral-title"
      className="fixed inset-0 z-50 grid place-items-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <DialogHeader onClose={onClose} />
        <TabBar tab={tab} setTab={setTab} />
        <div className="flex-1 overflow-y-auto p-5" dir="rtl">
          {tab === 'new' ? (
            <NewReferralForm
              letterSubject={letterSubject}
              selfId={selfId}
              targetId={targetId}
              targetName={targetName}
              setTarget={(id, name) => {
                setTargetId(id);
                setTargetName(name);
              }}
              query={query}
              setQuery={setQuery}
              results={results}
              isSearching={isSearching}
              level={level}
              setLevel={setLevel}
              urgency={urgency}
              setUrgency={setUrgency}
              instruction={instruction}
              setInstruction={setInstruction}
              removeFromInbox={removeFromInbox}
              setRemoveFromInbox={setRemoveFromInbox}
              error={error}
            />
          ) : (
            <ReferralHistoryTab history={history} />
          )}
        </div>
        <DialogFooter tab={tab} isBusy={isBusy} onClose={onClose} onSubmit={submit} />
      </div>
    </div>
  );
}

function DialogHeader({ onClose }: { onClose: () => void }) {
  return (
    <header className="flex items-center justify-between border-b border-border px-5 py-3">
      <h2 id="corr-referral-title" className="flex items-center gap-2 text-sm font-bold text-foreground">
        <Forward className="size-4 text-primary" aria-hidden="true" />
        ارجاع نامه
      </h2>
      <button
        type="button"
        aria-label="بستن"
        className="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        onClick={onClose}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </header>
  );
}

function TabBar({ tab, setTab }: { tab: 'new' | 'history'; setTab: (value: 'new' | 'history') => void }) {
  return (
    <div className="border-b border-border px-5 py-2" dir="rtl">
      <div role="tablist" aria-label="ارجاع" className="inline-flex rounded-xl border border-border bg-secondary/40 p-1">
        {(
          [
            { key: 'new', label: 'ارجاع جدید' },
            { key: 'history', label: 'سابقه ارجاع‌ها' },
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
    </div>
  );
}

function DialogFooter({
  tab,
  isBusy,
  onClose,
  onSubmit,
}: {
  tab: 'new' | 'history';
  isBusy: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <footer className="flex items-center justify-between gap-2 border-t border-border bg-secondary/30 px-5 py-3">
      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <History className="size-3" aria-hidden="true" />
        ارجاع پس از ارسال، در سابقه نامه ثبت دائمی می‌شود.
      </p>
      <div className="flex gap-2">
        <button
          type="button"
          className="h-9 rounded-lg border border-border px-4 text-xs font-medium text-foreground transition hover:bg-secondary"
          onClick={onClose}
        >
          انصراف
        </button>
        {tab === 'new' && (
          <button
            type="button"
            disabled={isBusy}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-5 text-xs font-bold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
            onClick={onSubmit}
          >
            <Send className="size-3.5" aria-hidden="true" />
            ارسال ارجاع
          </button>
        )}
      </div>
    </footer>
  );
}

interface NewReferralFormProps {
  letterSubject: string;
  selfId: string;
  targetId: string | null;
  targetName: string | null;
  setTarget: (id: string | null, name: string | null) => void;
  query: string;
  setQuery: (value: string) => void;
  results: DirectoryMember[];
  isSearching: boolean;
  level: ReferralLevel;
  setLevel: (value: ReferralLevel) => void;
  urgency: LetterUrgency;
  setUrgency: (value: LetterUrgency) => void;
  instruction: string;
  setInstruction: (value: string) => void;
  removeFromInbox: boolean;
  setRemoveFromInbox: (value: boolean) => void;
  error: string | null;
}

function NewReferralForm(props: NewReferralFormProps) {
  const chosen = props.results.find((member) => member.id === props.targetId);

  return (
    <div className="space-y-4">
      <p className="truncate rounded-lg bg-secondary/50 px-3 py-2 text-[11px] text-muted-foreground">
        نامه: {props.letterSubject}
      </p>
      {props.targetName && (
        <p className="truncate rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-[11px] font-medium text-foreground">
          گیرنده ارجاع: {props.targetName}
        </p>
      )}
      <TargetSearch
        targetId={props.targetId}
        setTarget={props.setTarget}
        query={props.query}
        setQuery={props.setQuery}
        results={props.results}
        isSearching={props.isSearching}
        selfId={props.selfId}
        chosen={chosen}
      />
      <LevelUrgencyRow
        level={props.level}
        setLevel={props.setLevel}
        urgency={props.urgency}
        setUrgency={props.setUrgency}
      />
      <InstructionField value={props.instruction} onChange={props.setInstruction} />
      <RemoveInboxCheck checked={props.removeFromInbox} onChange={props.setRemoveFromInbox} />
      {props.error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] leading-5 text-destructive"
        >
          {props.error}
        </p>
      )}
    </div>
  );
}
function TargetSearch({
  targetId,
  setTarget,
  query,
  setQuery,
  results,
  isSearching,
  selfId,
  chosen,
}: {
  targetId: string | null;
  setTarget: (id: string | null, name: string | null) => void;
  query: string;
  setQuery: (value: string) => void;
  results: DirectoryMember[];
  isSearching: boolean;
  selfId: string;
  chosen: DirectoryMember | undefined;
}) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="جستجوی افراد سازمان…"
          aria-label="جستجوی گیرنده ارجاع"
          className="h-10 w-full rounded-lg border border-border bg-background pr-9 pl-3 text-xs text-foreground outline-none transition focus:border-ring"
        />
      </div>
      {chosen && (
        <p className="text-[11px] text-muted-foreground">
          انتخاب شده: <strong className="font-semibold text-foreground">{directoryFullName(chosen) ?? chosen.email}</strong>
        </p>
      )}
      <ul
        role="listbox"
        aria-label="نتایج جستجوی افراد"
        className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border bg-background/60 p-1"
      >
        {isSearching && <li className="px-2 py-1.5 text-[11px] text-muted-foreground">در حال جستجو…</li>}
        {!isSearching && results.length === 0 && (
          <li className="px-2 py-1.5 text-[11px] text-muted-foreground">فردی یافت نشد.</li>
        )}
        {!isSearching &&
          results.map((member) => {
            const isSelf = member.id === selfId;
            const isSelected = member.id === targetId;
            const label = directoryFullName(member) ?? member.email;
            return (
              <li key={member.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={isSelf}
                  title={isSelf ? 'ارجاع به خود مجاز نیست.' : undefined}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-right text-[11.5px] transition',
                    isSelected
                      ? 'bg-primary/10 font-semibold text-primary'
                      : 'text-foreground hover:bg-secondary/60',
                    isSelf && 'cursor-not-allowed opacity-50',
                  )}
                  onClick={() => setTarget(member.id, label)}
                >
                  <span className="truncate">{label}</span>
                  <span className="truncate text-[10px] text-muted-foreground">
                    {member.jobTitle ?? member.department ?? member.email}
                  </span>
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}

function LevelUrgencyRow({
  level,
  setLevel,
  urgency,
  setUrgency,
}: {
  level: ReferralLevel;
  setLevel: (value: ReferralLevel) => void;
  urgency: LetterUrgency;
  setUrgency: (value: LetterUrgency) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
        سطح ارجاع
        <select
          value={level}
          onChange={(event) => setLevel(event.target.value as ReferralLevel)}
          className="h-9 w-full rounded-lg border border-border bg-background px-2 text-xs font-normal text-foreground outline-none transition focus:border-ring"
        >
          {(Object.keys(REFERRAL_LEVEL_LABELS) as ReferralLevel[]).map((key) => (
            <option key={key} value={key}>
              {REFERRAL_LEVEL_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
        فوریت
        <select
          value={urgency}
          onChange={(event) => setUrgency(event.target.value as LetterUrgency)}
          className="h-9 w-full rounded-lg border border-border bg-background px-2 text-xs font-normal text-foreground outline-none transition focus:border-ring"
        >
          {(Object.keys(URGENCY_LABELS) as LetterUrgency[]).map((key) => (
            <option key={key} value={key}>
              {URGENCY_LABELS[key]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function InstructionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 text-[11px] font-medium text-muted-foreground">
      دستور / توضیح
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        placeholder="دستور اقدام برای گیرنده ارجاع…"
        aria-label="دستور یا توضیح ارجاع"
        className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-xs font-normal leading-6 text-foreground outline-none transition focus:border-ring"
      />
    </label>
  );
}

function RemoveInboxCheck({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 rounded border-border"
      />
      حذف از کارتابل پس از ارجاع
    </label>
  );
}

function ReferralHistoryTab({ history }: { history: CorrReferral[] }) {
  if (history.length === 0) {
    return (
      <p className="rounded-lg bg-secondary/40 px-3 py-4 text-center text-[11.5px] text-muted-foreground">
        هنوز ارجاعی برای این نامه ثبت نشده است.
      </p>
    );
  }

  return (
    <ol className="space-y-3" aria-label="سابقه ارجاع‌ها">
      {history.map((entry) => (
        <li
          key={entry.id}
          className="space-y-1.5 rounded-xl border border-border bg-card px-3 py-2.5 text-[11.5px]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="truncate font-semibold text-foreground">
              {corrUserName(entry.from)}
              <span className="mx-1 font-normal text-muted-foreground">→</span>
              {corrUserName(entry.to)}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <UrgencyBadge urgency={entry.urgency} />
              <ReferralStatusBadge status={entry.status} />
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted-foreground">
            <span>سطح: {REFERRAL_LEVEL_LABELS[entry.level]}</span>
            <span>تاریخ: {formatCorrDate(entry.createdAt)}</span>
            {entry.viewedAt && <span>مشاهده: {formatCorrDate(entry.viewedAt)}</span>}
            {entry.actedAt && <span>اقدام: {formatCorrDate(entry.actedAt)}</span>}
            {entry.isConfidential && <span className="font-bold text-rose-600">محرمانه</span>}
          </div>
          {entry.instruction && (
            <p className="rounded-lg bg-secondary/40 px-2.5 py-1.5 leading-6 text-foreground">
              {entry.instruction}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}