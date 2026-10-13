'use client';

import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  DIRECTORY_PAGE_SIZE,
  fetchDirectory,
  fetchDirectoryMember,
  type DirectoryMember,
} from '@/lib/directory-api';

/**
 * PHASE UI-4: choosing a person, the ONE way the configuration surfaces do it.
 *
 * THE IDENTITY CONTRACT THIS RESPECTS (GAP-8, FORK A). Both surfaces that name a person —
 * a commercial group's liaison (`CreateCommercialGroupDto.liaisonUserId`) and a step's
 * `actorUserId` (the only publishable actor source) — send an OPAQUE Core user id, and
 * the backend verifies it as a member of the acting tenant before storing it
 * (`CommerceIdentityGateway.assertMember`, `assertConfiguredActorMember`). The platform's
 * own wire contract for a user id is `@IsString() @MaxLength(64)`; UUID v4 is only the
 * mint default, never a required shape. This picker therefore offers EVERY directory
 * row exactly as returned — no id filtering, no reformatting — and the only read that can
 * PRODUCE such an id for a browser session is the Core directory (`GET /users/directory`),
 * which requires `admin.users.read`.
 *
 * SO: WHEN THE CALLER HOLDS THE PERMISSION, the picker searches that directory and sends
 * exactly the id the directory returned. WHEN NOT, it does not invent a picker and does
 * not accept a pasted id as a workaround for a missing grant: it states the limitation —
 * the UI-0 posture ("a clear configuration limitation, documented") rather than a
 * control that would fail at the server.
 */

function memberName(member: {
  firstName?: string | null;
  lastName?: string | null;
  email: string;
}): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : member.email;
}


/**
 * Resolve the DISPLAY NAMES of a bounded set of ids, for list rows (a group's liaison,
 * a step's configured user). `enabled` is the caller's `admin.users.read`; without it
 * nothing is requested and the map stays empty — the row renders its fallback word.
 *
 * ONE call per distinct id, bounded by the page the caller just read (never an
 * unbounded scan), each failure leaving that id absent rather than inventing a name.
 * A late response for a stale id set is ignored by the `active` flag, the same
 * lifecycle every fetch in this module uses.
 */
export function useCommerceMemberNames(
  ids: readonly (string | null)[],
  enabled: boolean
): Map<string, string> {
  const [names, setNames] = React.useState<Map<string, string>>(new Map());
  const unique = React.useMemo(
    () => [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))],
    [ids]
  );
  const key = unique.join('|');

  React.useEffect(() => {
    if (!enabled || unique.length === 0) return;
    let active = true;

    Promise.all(
      unique.map(async (id) => {
        try {
          const member = await fetchDirectoryMember(id);
          return [id, memberName(member)] as const;
        } catch {
          // A failed lookup leaves the id absent — the row shows its fallback label.
          return null;
        }
      })
    ).then((resolved) => {
      if (!active) return;
      const next = new Map<string, string>();
      for (const entry of resolved) {
        if (entry) next.set(entry[0], entry[1]);
      }
      setNames(next);
    });

    return () => {
      active = false;
    };
    // `key` is the stable identity of the id set; `unique` changes identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  return names;
}

export function CommerceMemberPicker({
  id,
  label,
  value,
  onChange,
  enabled,
  disabled = false,
  helper,
  limitationText,
  testId,
  allowClear = true,
}: {
  id: string;
  label: string;
  value: string | null;
  onChange: (memberId: string | null) => void;
  /** The caller's `admin.users.read` — the directory route's own gate. */
  enabled: boolean;
  disabled?: boolean;
  helper?: string;
  limitationText: string;
  testId?: string;
  /**
   * PHASE UI-5: FALSE when the field must always HOLD an id — the purchase requester is
   * REQUIRED (`@IsNotEmpty()`), so a «حذف انتخاب» control would only produce a state the
   * server refuses. The default stays TRUE so every UI-4 caller keeps the affordance it
   * was designed with (a group's liaison and an optional actor user are both clearable).
   */
  allowClear?: boolean;
}) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<DirectoryMember[] | null>(null);
  const [selectedName, setSelectedName] = React.useState<string | null>(null);
  const [isSearching, setSearching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Resolve the CURRENT value's name once, so an edit shows WHO is configured rather
  // than a bare id. Best effort: a failure leaves the id visible and nothing invented.
  React.useEffect(() => {
    if (!enabled || !value) return;
    let active = true;
    fetchDirectoryMember(value)
      .then((member) => {
        if (active) setSelectedName(memberName(member));
      })
      .catch(() => {
        if (active) setSelectedName(null);
      });
    return () => {
      active = false;
    };
  }, [enabled, value]);

  // NOT a <form>: this control renders inside OTHER forms (the step drawer's
  // `commerce-workflow-step-form`, the group dialogs), and a nested <form> is invalid
  // HTML that React reports as a hydration error. The search is driven by an explicit
  // button plus the input's Enter key instead, which is what the form gave us anyway.
  const search = () => {
    if (!enabled || disabled) return;
    setSearching(true);
    setError(null);
    fetchDirectory({ q: query.trim() || undefined, limit: DIRECTORY_PAGE_SIZE })
      .then((page) => {
        // EVERY row the directory returned is offered, exactly as returned (GAP-8):
        // the id is opaque, so there is nothing here to test it against — membership
        // is verified server-side on write, never guessed in the browser.
        setResults(page.items);
        setSearching(false);
      })
      .catch((err: unknown) => {
        setResults(null);
        setError(err instanceof Error ? err.message : 'جستجوی کاربران با خطا مواجه شد.');
        setSearching(false);
      });
  };

  if (!enabled) {
    return (
      <div className="space-y-1" data-testid={testId ? `${testId}-limitation` : undefined}>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="rounded-xl border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {limitationText}
        </p>
        {value && (
          <p className="text-xs text-muted-foreground">
            مقدار ثبت‌شدهٔ فعلی:{' '}
            <span dir="ltr" className="rounded-md bg-muted px-1.5 py-0.5">
              {value}
            </span>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{label}</p>

      {value ? (
        <div
          data-testid={testId ? `${testId}-selected` : undefined}
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-secondary/40 px-3 py-2"
        >
          <span className="text-sm text-foreground">
            {selectedName ?? (
              <span dir="ltr" className="text-xs">
                {value}
              </span>
            )}
          </span>
          {allowClear && (
            <Button
              type="button"
              disabled={disabled}
              onClick={() => {
                onChange(null);
                setSelectedName(null);
              }}
              data-testid={testId ? `${testId}-clear` : undefined}
              className="h-8 border border-border bg-background px-2 text-xs text-foreground hover:bg-secondary"
            >
              حذف انتخاب
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">کاربری انتخاب نشده است.</p>
      )}

      {/*
        The search button calls the SAME handler as the input's Enter key — one action,
        one request, in every environment (user-event does not drive implicit form
        submission reliably).
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            id={id}
            name={id}
            label="جستجوی کاربر"
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                search();
              }
            }}
            placeholder="بخشی از نام یا ایمیل"
            data-testid={testId ? `${testId}-search` : undefined}
          />
        </div>
        <Button
          type="button"
          disabled={disabled || isSearching}
          aria-busy={isSearching}
          onClick={() => search()}
          data-testid={testId ? `${testId}-search-submit` : undefined}
          className="text-xs"
        >
          {isSearching ? 'در حال جستجو…' : 'جستجو'}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      {results && (
        <div
          data-testid={testId ? `${testId}-results` : undefined}
          className="max-h-48 overflow-y-auto rounded-xl border border-border"
        >
          {results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {'کاربری با این مشخصات یافت نشد.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onChange(member.id);
                      setSelectedName(memberName(member));
                      setResults(null);
                      setQuery('');
                    }}
                    data-testid={testId ? `${testId}-option-${member.id}` : undefined}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-start transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="text-sm text-foreground">{memberName(member)}</span>
                    {member.jobTitle && (
                      <span className="text-xs text-muted-foreground">{member.jobTitle}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
    </div>
  );
}