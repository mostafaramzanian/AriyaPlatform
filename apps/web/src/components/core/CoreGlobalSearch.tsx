'use client';

import * as React from 'react';
import { DropdownPanel } from '@/components/ui/dropdown-panel';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

import { CoreApiError, hasLocalSession } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  MIN_SEARCH_QUERY,
  SEARCH_SOURCE_LABELS,
  formatSearchTime,
  globalSearch,
  searchSourceLabel,
  splitSnippet,
  type PlatformSearchSourceType,
  type SearchResponse,
  type SearchResult,
  type SearchSourceType,
} from '@/lib/search-api';
import { cn } from '@/lib/utils';
import { CoreEmpty, CoreError, CoreLoading } from './CoreStates';

/**
 * Phase 49J: header global-search entry point.
 *
 * Modelled on `CoreNotificationBell` (49E) — the only existing header popover — so the
 * outside-click/Escape behaviour, the `role="dialog"` panel and the loading/error/empty
 * states are the same ones already in use rather than a second pattern.
 *
 * SNIPPETS ARE RENDERED AS TEXT NODES, ALWAYS. The server sends `snippet` (plain text)
 * plus `highlights` (character offsets), and `splitSnippet` turns that pair into
 * segments. There is no `dangerouslySetInnerHTML` in this file and there must never be
 * one: a matched message body is arbitrary user input, so any HTML path would be a
 * stored-XSS vector reachable by anyone who can send a message.
 *
 * DEGRADED MODE SAYS NOTHING ABOUT WHY. When `degraded` is true the panel says results
 * may be incomplete. Provider identity, model name and credential state are
 * administrative facts guarded by `admin.ai.read`; the server deliberately omits the
 * reason and this component deliberately does not guess at one.
 *
 * NO PERMISSION GATE. The route carries no `@Roles()` check because every result has
 * already passed its own source's authorization rule server-side, so hiding the box
 * would hide a capability every authenticated user has.
 */

/** Debounce, matching `CoreDirectoryView`'s search field so typing is not a request per key. */
const SEARCH_DEBOUNCE_MS = 350;

/** Panel page size. Deliberately smaller than the API default: this is a peek, not the list. */
const PANEL_LIMIT = 8;

/** Facet chip order. Fixed, so the chip row does not reshuffle between queries. */
const FACET_ORDER: PlatformSearchSourceType[] = [
  'TICKET',
  'TICKET_COMMENT',
  'SURVEY',
  'MESSAGE',
  'CONVERSATION',
  'NOTIFICATION',
  'REMINDER',
  'USER',
];

/**
 * Renders one snippet as text nodes, wrapping matched ranges in `<mark>`.
 *
 * The ONLY sanctioned render path for a snippet. `splitSnippet` clamps every offset, so
 * a malformed range cannot drop text; `<mark>` carries the semantics for assistive
 * technology instead of a bare colour change.
 */
function Snippet({ result }: { result: SearchResult }) {
  const segments = React.useMemo(
    () => splitSnippet(result.snippet, result.highlights),
    [result.snippet, result.highlights],
  );

  if (segments.length === 0) return null;

  return (
    <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={index}
            data-testid="search-highlight"
            className="rounded bg-primary/15 px-0.5 text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </p>
  );
}

export function CoreGlobalSearch() {
  const router = useRouter();

  const [open, setOpen] = React.useState(false);
  const [input, setInput] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [response, setResponse] = React.useState<SearchResponse | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Re-arms loading/cleared in the retry handler (same commit as the token
  // bump), so the search effect needs no in-effect setter resets.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);
  const [activeSource, setActiveSource] = React.useState<SearchSourceType | null>(null);

  const panelRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Debounced query. `input` drives the field; `query` drives the request.
  React.useEffect(() => {
    const handle = setTimeout(() => setQuery(input.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [input]);

  // A source filter only makes sense against the query it was chosen for, and
  // a query change is also the moment the result/loading state re-arms (the
  // debounce above changes `query` from a timer, so no event handler could do
  // it there). Applied during render, guarded by the previous query — never as
  // an effect-body setter (`react-hooks/set-state-in-effect`).
  const [prevQuery, setPrevQuery] = React.useState(query);
  if (prevQuery !== query) {
    setPrevQuery(query);
    setActiveSource(null);
    if (query.length < MIN_SEARCH_QUERY) {
      setResponse(null);
      setError(null);
      setIsLoading(false);
    } else {
      setIsLoading(true);
      setError(null);
    }
  }

  React.useEffect(() => {
    // Short queries were already reset during the render above.
    if (query.length < MIN_SEARCH_QUERY) return;

    // No token, no request: an anonymous caller would only get a 401 to
    // display. The reset settles through a microtask so the effect body holds
    // no synchronous setters (`react-hooks/set-state-in-effect`).
    if (!hasLocalSession()) {
      let cancelled = false;
      Promise.resolve()
        .then(() => {
          if (cancelled) return;
          setResponse(null);
          setError(null);
          setIsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }

    let cancelled = false;

    globalSearch(query, {
      limit: PANEL_LIMIT,
      ...(activeSource ? { sourceType: activeSource } : {}),
    })
      .then((result) => {
        if (cancelled) return;
        setResponse(result);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setResponse(null);
        setError(
          err instanceof CoreApiError || err instanceof Error
            ? err.message
            : 'جست‌وجو با خطا مواجه شد.',
        );
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [query, activeSource, reloadToken]);

  // Outside click / Escape close, identical to the notification panel and the user menu.
  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const openPanel = () => {
    setOpen(true);
    // Focus is moved on the next frame: the field does not exist until the panel renders
    // on small viewports, where the trigger is an icon button.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  /**
   * Navigates to a result.
   *
   * `href` and `anchor` are built SERVER-SIDE from route constants and a row id, never
   * from matched text, so nothing user-authored reaches the router. The anchor is passed
   * as a hash for the target page to consume; a page that ignores it simply lands at the
   * top, which is why no result depends on one.
   */
  const openResult = (result: SearchResult) => {
    const { href, anchor } = result.navigation;
    setOpen(false);
    router.push(anchor ? `${href}#${anchor}` : href);
  };

  const results = response?.results ?? [];
  const tooShort = query.length > 0 && query.length < MIN_SEARCH_QUERY;
  const facets = FACET_ORDER.filter((source) => (response?.sourceCounts?.[source] ?? 0) > 0);

  return (
    <div className="relative" ref={panelRef}>
      {/*
        Two triggers, one state. The inline field is the desktop affordance; below `sm`
        the header has no room for it, so an icon button opens the same panel and the
        panel owns its own field. Both carry the same `aria-*` wiring.
      */}
      <button
        type="button"
        onClick={openPanel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="جست‌وجوی سراسری"
        data-testid="global-search-trigger"
        className="flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
      >
        <Search className="h-5 w-5" aria-hidden="true" />
      </button>

      <div className="relative hidden sm:block">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          type="search"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          role="combobox"
          aria-expanded={open}
          aria-controls="global-search-panel"
          aria-autocomplete="list"
          aria-label="جست‌وجوی سراسری"
          placeholder="جست‌وجو در تیکت‌ها، پیام‌ها، نظرسنجی‌ها..."
          data-testid="global-search-input"
          className="w-[min(20rem,40vw)] rounded-xl border border-input bg-surface px-4 py-2 pe-10 text-sm text-foreground transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
        />
      </div>

      <DropdownPanel
        open={open}
        id="global-search-panel"
          role="dialog"
          aria-label="نتایج جست‌وجو"
          data-testid="global-search-panel"
        className="absolute end-0 mt-2 w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-elevated"
      >
          {/* Mobile-only field: the trigger above is an icon, so the panel supplies the input. */}
          <div className="border-b border-border p-3 sm:hidden">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                aria-label="جست‌وجوی سراسری"
                placeholder="جست‌وجو..."
                data-testid="global-search-input-mobile"
                className="w-full rounded-xl border border-input bg-surface px-4 py-2 pe-10 text-sm text-foreground transition placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>
          </div>

          {response?.degraded && (
            <p
              data-testid="global-search-degraded"
              className="border-b border-border bg-warning/10 px-4 py-2 text-[11px] leading-5 text-muted-foreground"
            >
              نتایج ممکن است کامل نباشد.
            </p>
          )}

          {facets.length > 1 && (
            <div className="flex flex-wrap gap-1.5 border-b border-border px-3 py-2">
              <button
                type="button"
                onClick={() => {
                  // A no-op click must not strand the panel in loading; a real
                  // switch re-arms in the same handler commit (the removed
                  // in-effect setters used to arm one render later).
                  if (activeSource === null) return;
                  setIsLoading(true);
                  setError(null);
                  setActiveSource(null);
                }}
                data-testid="global-search-facet-all"
                aria-pressed={activeSource === null}
                className={cn(
                  'rounded-lg px-2 py-1 text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  activeSource === null
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-secondary',
                )}
              >
                همه
              </button>
              {facets.map((source) => (
                <button
                  key={source}
                  type="button"
                  onClick={() => {
                    if (activeSource === source) return;
                    setIsLoading(true);
                    setError(null);
                    setActiveSource(source);
                  }}
                  data-testid="global-search-facet"
                  data-source={source}
                  aria-pressed={activeSource === source}
                  className={cn(
                    'rounded-lg px-2 py-1 text-[11px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activeSource === source
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-secondary',
                  )}
                >
                  {SEARCH_SOURCE_LABELS[source]}
                  <span className="ms-1 text-muted-foreground">
                    {response?.sourceCounts?.[source]}
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="max-h-[60vh] overflow-y-auto">
            {tooShort && (
              <p className="px-4 py-4 text-xs text-muted-foreground">
                برای جست‌وجو دست‌کم {MIN_SEARCH_QUERY} نویسه وارد کنید.
              </p>
            )}

            {!tooShort && query.length === 0 && (
              <p className="px-4 py-4 text-xs text-muted-foreground">
                عبارتی برای جست‌وجو وارد کنید.
              </p>
            )}

            {!tooShort && query.length >= MIN_SEARCH_QUERY && isLoading && (
              <div className="px-4 py-4">
                <CoreLoading label="در حال جست‌وجو..." lines={3} />
              </div>
            )}

            {!isLoading && error && (
              <div className="px-4 py-4">
                <CoreError message={error} onRetry={reload} />
              </div>
            )}

            {!isLoading && !error && query.length >= MIN_SEARCH_QUERY && results.length === 0 && (
              <div className="px-4 py-4">
                <CoreEmpty message="نتیجه‌ای یافت نشد." />
              </div>
            )}

            {!isLoading && !error && results.length > 0 && (
              <ul className="divide-y divide-border" data-testid="global-search-results">
                {results.map((result) => (
                  <li key={`${result.sourceType}:${result.sourceId}`}>
                    <button
                      type="button"
                      onClick={() => openResult(result)}
                      data-testid="global-search-result"
                      data-source={result.sourceType}
                      className="w-full px-4 py-3 text-start transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 truncate text-sm font-medium text-foreground">
                          {result.title}
                        </p>
                        <span className="shrink-0 rounded-lg bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {searchSourceLabel(result)}
                        </span>
                      </div>

                      <Snippet result={result} />

                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {formatSearchTime(result.timestamp)}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/*
            No "see all results" link: there is no /admin/search page in this phase, and a
            link to a route that does not exist would be a dead end. `hasMore` is surfaced
            as text instead, so the user knows the panel is a subset.
          */}
          {response?.hasMore && (
            <p
              data-testid="global-search-has-more"
              className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground"
            >
              نتایج بیشتری موجود است. عبارت جست‌وجو را دقیق‌تر کنید.
            </p>
          )}
      </DropdownPanel>
    </div>
  );
}
