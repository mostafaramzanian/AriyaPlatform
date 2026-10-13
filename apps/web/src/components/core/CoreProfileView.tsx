 'use client';

import * as React from 'react';
import Image from 'next/image';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { CoreApiError } from '@/lib/core-http';
import { useReloadToken } from '@/hooks/use-reload-token';
import {
  fetchLoginHistory,
  fetchMyProfile,
  fetchSessions,
  removeAvatar,
  revokeSession,
  updateMyProfile,
  uploadAvatar,
  type CoreProfile,
  type LoginHistoryItem,
  type SessionRecord,
} from '@/lib/users-api';
import { useAuth } from '@/components/providers/AuthProvider';
import { useCorePermissions } from './useCorePermissions';
import { CoreError, CoreForbidden, CoreLoading } from './CoreStates';
import { CoreModulesList } from './CoreModulesList';

const STATUS_LABELS: Record<string, string> = {
  EMPLOYEE: 'کارمند',
  VISITOR: 'بازدیدکننده',
  LEAD: 'سرنخ',
  CUSTOMER: 'مشتری',
  PARTNER: 'همکار',
};

function fullName(profile: CoreProfile): string | null {
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : null;
}

function formatDate(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium' }).format(date);
}

/**
 * Phase 49C-1: the three REAL sections of the former vertical account page —
 * اطلاعات حساب، نشست‌های فعال، تاریخچه ورود — are now an accessible tablist.
 * Phase 49C-4: a fourth tab, ماژول‌های در دسترس, renders the SAME authorised-modules
 * surface the dashboard used to duplicate — the shared `CoreModulesList`, derived
 * from the ONE `useCorePermissions` read this view already performs. No new request,
 * no second module-discovery path.
 *
 * WHAT THE REFACTOR DID NOT CHANGE:
 * - the data contract: the same single mount read (one Promise.all of profile,
 *   sessions, history with their zero-value fallbacks) still feeds every panel,
 *   so switching tabs duplicates NO fetch. Lazy-loading sessions on tab
 *   activation was evaluated and rejected: it would split the verified
 *   load/error contract of the combined read for three same-round-trip requests,
 *   so the existing data behaviour is preserved per the phase contract.
 * - every feature: profile display/edit, avatar upload/remove, revoke, status,
 *   roles, creation date, and the loading/403/error states (which still gate the
 *   whole view) are the same markup inside the panels.
 *
 * WHAT DID CHANGE: presentation only. The active tab is URL-addressable
 * (`/admin/profile?tab=sessions`, and since 49C-4 `?tab=modules`) so refresh and
 * back/forward restore it.
 */
type AccountTabId = 'profile' | 'sessions' | 'login-history' | 'modules';

const ACCOUNT_TABS: ReadonlyArray<{ id: AccountTabId; label: string }> = [
  { id: 'profile', label: 'مشخصات حساب' },
  { id: 'sessions', label: 'نشست‌های فعال' },
  { id: 'login-history', label: 'تاریخچه ورود' },
  { id: 'modules', label: 'ماژول‌های در دسترس' },
];

/** Unknown or missing tab params resolve to the profile tab, mirroring the old page. */
function resolveAccountTab(raw: string | null): AccountTabId {
  return ACCOUNT_TABS.some((tab) => tab.id === raw) ? (raw as AccountTabId) : 'profile';
}

export function CoreProfileView() {
  const { isAuthenticated } = useAuth();
  const rbac = useCorePermissions(isAuthenticated);
  const { highestRole, roles } = rbac;

  /**
   * Same rule as the sidebar and the dashboard widgets: enforce the permission
   * filter only once RBAC has actually answered, so a transient failure hides
   * nothing and the backend still answers 403 on navigation.
   */
  const enforcePermissions = !rbac.isLoading && !rbac.error;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [profile, setProfile] = React.useState<CoreProfile | null>(null);
  const [sessions, setSessions] = React.useState<SessionRecord[]>([]);
  const [history, setHistory] = React.useState<LoginHistoryItem[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isEditing, setIsEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({ firstName: '', lastName: '', phone: '' });
  const [avatarBusy, setAvatarBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
  // Re-arms loading/cleared in every reload handler below (same commit as the
  // token bump), so the profile effect needs no in-effect setter resets. First
  // mount is covered by the initial `isLoading: true`.
  const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

  /*
   * Tab state. The URL param is the addressable source: it is read for the
   * initial render and re-applied whenever it changes (back/forward), while
   * clicks update a local copy so switching never waits on the replace
   * round-trip. `replace`, not `push`: a tab is presentation state, not a
   * history entry the back button should replay one click at a time.
   */
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = React.useState<AccountTabId>(() => resolveAccountTab(tabParam));

  // Re-apply on param change (back/forward) during render, guarded by the
  // previous value — never as an effect-body setter
  // (`react-hooks/set-state-in-effect`). Clicks go through `selectTab` below,
  // which updates the URL first, so by the time the param resolves the state
  // already matches. Mount is a no-op (identity equal).
  const [prevTabParam, setPrevTabParam] = React.useState(tabParam);
  if (prevTabParam !== tabParam) {
    setPrevTabParam(tabParam);
    setActiveTab(resolveAccountTab(tabParam));
  }

  /*
   * Phase 49C-4: with four labels the ACTIVE tab can sit outside the tablist's
   * own scrollable viewport on the narrowest phones (it is the fourth button in
   * an RTL strip). Bring it into view whenever the selection changes — from a
   * click, a keyboard move, or a direct `?tab=` load. `nearest/nearest` keeps
   * the PAGE itself from scrolling: only the tablist moves.
   */
  React.useEffect(() => {
    const index = ACCOUNT_TABS.findIndex((tab) => tab.id === activeTab);
    // Optional call: jsdom (and any exotic embedder) does not implement
    // scrollIntoView, and a missing method must never break tab selection.
    tabRefs.current[index]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeTab]);

  const selectTab = React.useCallback(
    (id: AccountTabId) => {
      if (id === activeTab) return;
      setActiveTab(id);
      router.replace(`${pathname ?? '/admin/profile'}?tab=${id}`, { scroll: false });
    },
    [activeTab, pathname, router],
  );

  /*
   * Arrow-key movement between tabs (WAI-ARIA Authoring Practices). Under
   * <html dir="rtl"> "forward" is visually LEFT, so the arrow directions flip
   * instead of fighting the reading order. Home/End jump to the ends.
   */
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const handleTablistKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = ACCOUNT_TABS.findIndex((tab) => tab.id === activeTab);
    const isRtl = document.documentElement.getAttribute('dir') === 'rtl';
    const forward = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = isRtl ? 'ArrowRight' : 'ArrowLeft';

    let nextIndex: number | null = null;
    if (event.key === forward) {
      nextIndex = (currentIndex + 1) % ACCOUNT_TABS.length;
    } else if (event.key === backward) {
      nextIndex = (currentIndex - 1 + ACCOUNT_TABS.length) % ACCOUNT_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = ACCOUNT_TABS.length - 1;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(ACCOUNT_TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  };

  React.useEffect(() => {
    let active = true;

    Promise.all([fetchMyProfile(), fetchSessions().catch(() => []), fetchLoginHistory().catch(() => [])])
      .then(([data, sessionData, historyData]) => {
        if (!active) return;
        setProfile(data);
        setSessions(sessionData);
        setHistory(historyData);
        setDraft({
          firstName: data.firstName ?? '',
          lastName: data.lastName ?? '',
          phone: data.phone ?? '',
        });
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setProfile(null);
        setError({
          message: err instanceof Error ? err.message : 'دریافت اطلاعات حساب با خطا مواجه شد.',
          status: err instanceof CoreApiError ? err.status : null,
        });
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [reloadToken]);

  const saveProfile = async () => {
    if (!profile) return;
    setIsSaving(true);
    try {
      const next = await updateMyProfile({
        firstName: draft.firstName || null,
        lastName: draft.lastName || null,
        phone: draft.phone || null,
      });
      setProfile(next);
      setDraft({
        firstName: next.firstName ?? '',
        lastName: next.lastName ?? '',
        phone: next.phone ?? '',
      });
      setIsEditing(false);
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'ذخیره اطلاعات حساب با خطا مواجه شد.',
        status: err instanceof CoreApiError ? err.status : null,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const onAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarBusy(true);
    try {
      const next = await uploadAvatar(file);
      setProfile(next);
      // The profile is already updated above; re-read everything else (sessions,
      // history, read-freshness) through the hook: it re-arms loading/cleared,
      // exactly what the removed in-effect arm used to establish.
      reload();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'آپلود تصویر پروفایل با خطا مواجه شد.',
        status: err instanceof CoreApiError ? err.status : null,
      });
    } finally {
      setAvatarBusy(false);
      e.target.value = '';
    }
  };

  const onRemoveAvatar = async () => {
    setAvatarBusy(true);
    try {
      const next = await removeAvatar();
      setProfile(next);
      // Same re-read as the upload path above (the removed in-effect arm).
      reload();
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'حذف تصویر پروفایل با خطا مواجه شد.',
        status: err instanceof CoreApiError ? err.status : null,
      });
    } finally {
      setAvatarBusy(false);
    }
  };

  const onRevokeSession = async (sessionId: string) => {
    try {
      await revokeSession(sessionId);
      setSessions((items) => items.map((item) => (item.id === sessionId ? { ...item, revoked: true } : item)));
    } catch (err) {
      setError({
        message: err instanceof Error ? err.message : 'لغو نشست با خطا مواجه شد.',
        status: err instanceof CoreApiError ? err.status : null,
      });
    }
  };

  if (isLoading) {
    return (
      <div className="core-card p-core-card">
        <CoreLoading label="در حال بارگذاری اطلاعات حساب..." />
      </div>
    );
  }

  if (error?.status === 403) {
    return <CoreForbidden />;
  }

  if (error || !profile) {
    return (
      <CoreError
        message={error?.message ?? 'اطلاعات حساب یافت نشد.'}
        onRetry={error?.status === 401 ? undefined : reload}
      />
    );
  }

  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  const name = fullName(profile);
  if (name) rows.push({ label: 'نام', value: name });
  rows.push({ label: 'ایمیل', value: profile.email });
  if (profile.phone) rows.push({ label: 'تلفن', value: profile.phone });
  if (profile.status) rows.push({ label: 'وضعیت حساب', value: STATUS_LABELS[profile.status] ?? profile.status });
  if (typeof profile.emailVerified === 'boolean') {
    rows.push({ label: 'تأیید ایمیل', value: profile.emailVerified ? 'تأیید شده' : 'تأیید نشده' });
  }
  if (highestRole) rows.push({ label: 'نقش اصلی', value: highestRole.displayName });
  if (roles.length > 1) rows.push({ label: 'همه نقش‌ها', value: roles.map((r) => r.displayName).join('، ') });
  if (profile.createdAt) rows.push({ label: 'تاریخ ایجاد', value: formatDate(profile.createdAt) });

  return (
    <div className="space-y-core-gap">
      {/*
        Phase 49C-1: the tablist replaces vertical stacking as the page's own
        navigation. `overflow-x-auto` (not a breakpoint hack) keeps the tabs usable
        at 360px; since 49C-4 there are four labels, so on the narrowest phones the
        TABLIST — and only the tablist — scrolls horizontally. Arrow keys are
        handled on each FOCUSED tab (the container is never focused itself), which
        is the WAI-ARIA Authoring Practices tab pattern.
      */}
      <div role="tablist" aria-label="بخش‌های حساب" className="flex gap-2 overflow-x-auto border-b border-border">
        {ACCOUNT_TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(node) => {
              tabRefs.current[index] = node;
              /*
               * Phase 49C-4: on a DIRECT load of `/admin/profile?tab=modules` the
               * tablist mounts long after this component did (behind the loading
               * gate), so the [activeTab] effect below has already run and would
               * never fire again. Scrolling here, in the ref callback, covers the
               * mount case: whatever tab the URL selected becomes visible inside
               * the scrollable tablist. `nearest/nearest` keeps the PAGE from
               * scrolling — only the tablist moves — and the optional call keeps
               * environments without scrollIntoView (jsdom) unaffected.
               */
              if (activeTab === tab.id) {
                node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
              }
            }}
            type="button"
            role="tab"
            id={`account-tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`account-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={handleTablistKeyDown}
            className={cn(
              'whitespace-nowrap rounded-md px-4 py-2.5 text-sm font-medium transition',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              activeTab === tab.id
                ? 'border-b-2 border-primary text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/*
        Only the ACTIVE panel is mounted. The active tab is preserved on refresh
        because it lives in the URL (`?tab=`), not in component state alone.
      */}
      {activeTab === 'profile' ? (
        <div
          role="tabpanel"
          id="account-panel-profile"
          aria-labelledby="account-tab-profile"
          tabIndex={0}
          className="space-y-core-gap"
        >
          <section className="core-card p-core-card md:p-core-card-lg" aria-labelledby="profile-heading">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="profile-heading" className="text-base font-semibold text-foreground">اطلاعات حساب</h2>
                <p className="mt-1 text-xs text-muted-foreground">پروفایل خود را مشاهده و در صورت وجود قرارداد امن، ویرایش کنید.</p>
              </div>
              {!isEditing ? (
                <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => setIsEditing(true)}>
                  ویرایش
                </button>
              ) : null}
            </div>

            <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-center">
              <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-border bg-muted text-lg font-semibold text-foreground">
                {profile.avatarUrl ? (
                  <Image
                    src={profile.avatarUrl}
                    alt="avatar"
                    unoptimized
                    width={80}
                    height={80}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  (name ?? profile.email[0] ?? 'U').toUpperCase()
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="cursor-pointer rounded-md border border-border px-3 py-2 text-sm">
                  {avatarBusy ? 'در حال آپلود...' : 'آپلود تصویر'}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={onAvatarChange} />
                </label>
                {profile.avatarUrl ? (
                  <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" onClick={onRemoveAvatar} disabled={avatarBusy}>
                    حذف تصویر
                  </button>
                ) : null}
              </div>
            </div>


            {isEditing ? (
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span>نام</span>
                  <input value={draft.firstName} onChange={(e) => setDraft((d) => ({ ...d, firstName: e.target.value }))} className="w-full rounded-md border border-border bg-background px-3 py-2" />
                </label>
                <label className="space-y-2 text-sm">
                  <span>نام خانوادگی</span>
                  <input value={draft.lastName} onChange={(e) => setDraft((d) => ({ ...d, lastName: e.target.value }))} className="w-full rounded-md border border-border bg-background px-3 py-2" />
                </label>
                <label className="space-y-2 text-sm md:col-span-2">
                  <span>تلفن</span>
                  <input value={draft.phone} onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))} className="w-full rounded-md border border-border bg-background px-3 py-2" />
                </label>
                <div className="md:col-span-2 flex items-center gap-2">
                  <button onClick={saveProfile} disabled={isSaving} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
                    {isSaving ? 'در حال ذخیره...' : 'ذخیره'}
                  </button>
                  <button onClick={() => setIsEditing(false)} className="rounded-md border border-border px-4 py-2 text-sm">
                    انصراف
                  </button>
                </div>
              </div>
            ) : (
              <dl className="mt-5 divide-y divide-border text-sm">
                {rows.map((row) => (
                  <div key={row.label} className="flex items-start justify-between gap-4 py-3.5">
                    <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
                    <dd className="min-w-0 break-words text-end font-medium text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        </div>
      ) : activeTab === 'sessions' ? (
        <div
          role="tabpanel"
          id="account-panel-sessions"
          aria-labelledby="account-tab-sessions"
          tabIndex={0}
        >
          <section className="core-card p-core-card md:p-core-card-lg" aria-labelledby="account-sessions-heading">
            <h2 id="account-sessions-heading" className="text-base font-semibold text-foreground">نشست‌های فعال</h2>
            <div className="mt-4 space-y-3">
              {sessions.length === 0 ? <p className="text-sm text-muted-foreground">هیچ نشست فعالی ثبت نشده است.</p> : sessions.map((session) => (
                <div key={session.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <div>
                    <div>ایجاد: {formatDate(session.createdAt)}</div>
                    <div>انقضا: {formatDate(session.expiresAt)}</div>
                  </div>
                  <button className="rounded-md border border-border px-3 py-2" onClick={() => onRevokeSession(session.id)} disabled={session.revoked}>
                    {session.revoked ? 'لغو شده' : 'لغو نشست'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : activeTab === 'login-history' ? (
        <div
          role="tabpanel"
          id="account-panel-login-history"
          aria-labelledby="account-tab-login-history"
          tabIndex={0}
        >
          <section className="core-card p-core-card md:p-core-card-lg" aria-labelledby="account-history-heading">
            <h2 id="account-history-heading" className="text-base font-semibold text-foreground">تاریخچه ورود</h2>
            <div className="mt-4 space-y-3">
              {history.length === 0 ? <p className="text-sm text-muted-foreground">تاریخچه ورود موجود نیست.</p> : history.map((item) => (
                <div key={item.id} className="rounded-md border border-border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className={item.success ? 'text-green-600' : 'text-red-600'}>{item.success ? 'موفق' : 'ناموفق'}</span>
                    <span className="text-muted-foreground">{formatDate(item.createdAt)}</span>
                  </div>
                  <div className="mt-2 text-muted-foreground">{item.action === 'login' ? 'ورود موفق' : 'ورود ناموفق'}</div>
                  {item.ipAddress ? <div className="mt-1 text-muted-foreground">IP: {item.ipAddress}</div> : null}
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : activeTab === 'modules' ? (
        <div
          role="tabpanel"
          id="account-panel-modules"
          aria-labelledby="account-tab-modules"
          tabIndex={0}
        >
          {/*
            Phase 49C-4: the authorised-modules surface, moved from the dashboard.
            Same shared presentation (`CoreModulesList`), same single RBAC read this
            view already performs — no extra request, no second discovery path. The
            dashboard's own modules card is gone, so this is now the ONLY surface
            that answers "what can I actually open?" outside the sidebar.
          */}
          <section className="core-card p-core-card md:p-core-card-lg" aria-labelledby="account-modules-heading">
            <h2 id="account-modules-heading" className="text-base font-semibold text-foreground">ماژول‌های در دسترس</h2>
            <div className="mt-4">
              <CoreModulesList
                permissions={rbac.permissions}
                enforcePermissions={enforcePermissions}
              />
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
