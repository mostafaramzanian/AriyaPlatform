'use client';

import * as React from 'react';
import { Search, X, User as UserIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DropdownPanel } from '@/components/ui/dropdown-panel';
import {
  directoryFullName,
  directoryInitials,
  fetchDirectory,
  type DirectoryMember,
} from '@/lib/directory-api';

/**
 * Phase 50: recipient picker over the ORGANIZATION DIRECTORY (49D-1).
 *
 * There is deliberately NO hard-coded people list here — the reference's local
 * people/group arrays are treated as a UX sketch. The picker searches
 * `GET /users/directory`, which the backend scopes to the caller's tenant and
 * projects through the directory privacy allowlist (name, avatar, jobTitle,
 * department — never email, phone, employee code or tenant id), so selection can
 * only ever offer people the caller is already permitted to see.
 *
 * A selected id is still re-verified server-side on every save/send; this component
 * cannot make a foreign id "authorized", it can only help the user pick valid ones.
 */

export interface RecipientPickerProps {
  label: string;
  hint?: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  /** True for the BCC field: a privacy hint is rendered. */
  bcc?: boolean;
  /** Other selected ids (any field), so the same person cannot be picked twice. */
  takenElsewhere?: string[];
}

export function RecipientPicker(props: RecipientPickerProps) {
  const { label, hint, selected, onChange, disabled, bcc, takenElsewhere = [] } = props;
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<DirectoryMember[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [members, setMembers] = React.useState<Map<string, DirectoryMember>>(new Map());
  const [open, setOpen] = React.useState(false);

  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const runSearch = React.useCallback(async (q: string) => {
    setIsSearching(true);
    setError(null);
    try {
      const result = await fetchDirectory({ q: q.trim() || undefined, limit: 20 });
      setResults(result.items);
      setMembers((prev) => {
        const next = new Map(prev);
        for (const member of result.items) next.set(member.id, member);
        return next;
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'جستجوی دفترچه سازمانی ناموفق بود.');
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void runSearch(query);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [open, query, runSearch]);

  const taken = new Set([...selected, ...takenElsewhere]);

  const nameFor = (id: string): string => {
    const member = members.get(id);
    return member ? directoryFullName(member) ?? member.email : `کاربر (${id.slice(0, 8)})`;
  };

  return (
    <div ref={containerRef} className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-xs font-medium text-foreground">{label}</label>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      </div>

      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label} انتخاب‌شده‌ها`}>
          {selected.map((id) => (
            <li key={id}>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/60 px-2.5 py-1 text-[11px] text-foreground">
                <UserIcon aria-hidden="true" className="size-3 text-muted-foreground" />
                {nameFor(id)}
                {!disabled && (
                  <button
                    type="button"
                    aria-label={`حذف ${nameFor(id)} از ${label}`}
                    className="rounded-full p-0.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => onChange(selected.filter((value) => value !== id))}
                  >
                    <X className="size-3" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls="recipient-search-listbox"
          aria-label={`جستجوی ${label} در دفترچه سازمانی`}
          className={cn(
            'w-full rounded-xl border border-input bg-surface py-2 pl-3 pr-9 text-xs text-foreground transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30',
            disabled && 'cursor-not-allowed opacity-60',
          )}
          placeholder="نام یا سمت را جستجو کنید…"
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        />
        <CorrSearchList
          open={open}
          isSearching={isSearching}
          error={error}
          results={results}
          selected={selected}
          taken={taken}
          onPick={(id) => {
            onChange([...selected, id]);
            setQuery('');
          }}
        />
      </div>

      {bcc && (
        <p className="text-[10px] leading-5 text-muted-foreground">
          گیرندگان مخفی تنها برای شما نمایان هستند؛ سایر گیرندگان هرگز فهرست BCC را نمی‌بینند.
        </p>
      )}
    </div>
  );
}

/** The dropdown result list; kept separate so the picker stays under one concern. */
function CorrSearchList({
  open,
  isSearching,
  error,
  results,
  selected,
  taken,
  onPick,
}: {
  open: boolean;
  isSearching: boolean;
  error: string | null;
  results: DirectoryMember[];
  selected: string[];
  taken: Set<string>;
  onPick: (id: string) => void;
}) {
  return (
    <DropdownPanel
      open={open}
      id="recipient-search-listbox"
      role="listbox"
      className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border bg-background shadow-lg"
    >
      {isSearching && (
        <div className="px-3 py-3 text-center text-[11px] text-muted-foreground">در حال جستجو…</div>
      )}
      {!isSearching && error && (
        <div className="px-3 py-3 text-center text-[11px] text-destructive">{error}</div>
      )}
      {!isSearching && !error && results.length === 0 && (
        <div className="px-3 py-3 text-center text-[11px] text-muted-foreground">فردی یافت نشد</div>
      )}
      {!isSearching &&
        results.map((member) => {
          const isSelected = selected.includes(member.id);
          const isTaken = taken.has(member.id) && !isSelected;
          return (
            <button
              key={member.id}
              type="button"
              disabled={isSelected || isTaken}
              aria-label={`انتخاب ${directoryFullName(member) ?? member.email}`}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2 text-right transition hover:bg-secondary',
                (isSelected || isTaken) && 'cursor-not-allowed opacity-50',
              )}
              onClick={() => onPick(member.id)}
            >
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-[10px] font-semibold text-primary"
              >
                {directoryInitials(member)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">
                  {directoryFullName(member) ?? member.email}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {[member.jobTitle, member.department].filter(Boolean).join(' — ') || ' '}
                </span>
              </span>
              {isSelected && <span className="text-[10px] text-muted-foreground">انتخاب‌شده</span>}
            </button>
          );
        })}
    </DropdownPanel>
  );
}