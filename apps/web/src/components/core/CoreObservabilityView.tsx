'use client';

import * as React from 'react';
import {ScrollText} from 'lucide-react';

import {CoreApiError} from '@/lib/core-http';
import {useReloadToken} from '@/hooks/use-reload-token';
import {
    getObservabilityHealth,
    getObservabilityVocabulary,
    listApplicationLogs,
    listAuditEvents,
    listLifecycleEvents,
    listRetentionRuns,
    listSecurityEvents,
    type ApplicationLogRow,
    type AuditEventRow,
    type LifecycleEventRow,
    type LogLevel,
    type ObservabilityHealth,
    type ObservabilityQuery,
    type ObservabilityVocabulary,
    type RetentionRunRow,
    type SecurityEventRow,
} from '@/lib/observability-api';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Select} from '@/components/ui/select';
import {useCorePermissions} from './useCorePermissions';
import {CoreEmpty, CoreError, CoreForbidden, CoreLoading} from './CoreStates';
import {
    AuditTable,
    Badge,
    LifecycleTable,
    LogsTable,
    RetentionTable,
    SecurityTable,
} from './observability-tables';

/**
 * Phase 49M-2: the observability screen — "لاگ‌ها و رخدادها".
 *
 * Backed by `/admin/observability`, gated on `admin.observability.read` for four of the five
 * tabs and on `admin.security.read` for the security tab. Both are seeded in core_db, so the
 * gating is real — but it is still presentation only: the controller enforces the same strings.
 *
 * THE SECURITY TAB IS HIDDEN, NOT DISABLED, for a caller without `admin.security.read`. A
 * disabled control advertises that a category of data exists and that this person may not see
 * it, which is information in itself; and since the route returns 403 anyway, rendering the tab
 * would only produce an error the user can do nothing about. OPERATIONS_ADMIN legitimately
 * reaches this page and legitimately does not see that tab.
 *
 * THE TIME RANGE IS PART OF THE UI, NOT A HIDDEN DEFAULT, and this is the screen's central
 * design decision. `from` is mandatory server-side because these are the largest tables in the
 * installation and every §21 index leads with `occurredAt`. Rather than hide that behind an
 * invisible "last 24h", the range is a visible, editable control initialised to the last hour —
 * so an operator widening it to 30 days can see that they asked for a bigger query.
 *
 * TABS ONLY FOR IMPLEMENTED CATEGORIES. Five tabs, five backing endpoints. There is no
 * "Traces" tab, no "Alerts" tab and no "Dashboards" tab, because none of those exist server-side
 * — an empty tab promising a feature is worse than its absence.
 *
 * STATUS IS NEVER COLOUR ALONE (§30). Every level and severity badge carries a SYMBOL and a
 * PERSIAN LABEL as well as a colour class, and the accessible name is the label.
 */

const READ_PERMISSION = 'admin.observability.read';
const SECURITY_PERMISSION = 'admin.security.read';

type TabId = 'logs' | 'audit' | 'security' | 'lifecycle' | 'retention';

interface TabDefinition {
    id: TabId;
    label: string;
    /** Permission required to SEE the tab. Absent means the page-level permission suffices. */
    permission?: string;
}

const TABS: TabDefinition[] = [
    {id: 'logs', label: 'لاگ‌های برنامه'},
    {id: 'audit', label: 'رخدادهای حسابرسی'},
    {id: 'security', label: 'رخدادهای امنیتی', permission: SECURITY_PERMISSION},
    {id: 'lifecycle', label: 'چرخه حیات پلتفرم'},
    {id: 'retention', label: 'نگهداشت داده'},
];

/**
 * STATUS PRESENTATION LIVES WITH THE THING THAT RENDERS IT.
 *
 * Level, severity, outcome, phase and domain presentation are in `observability-tables.tsx`
 * beside the tables that consume them; only HEALTH presentation is here, because only this
 * component renders the health banner. `Badge` itself is imported from there so both files
 * produce the same markup — a second copy is how one of them loses its `aria-label`.
 *
 * `disabled` IS DELIBERATELY NEUTRAL, NOT AN ERROR: an installation that never set
 * `OBSERVABILITY_ENABLED` is correctly configured for its choice, and painting that red trains
 * operators to ignore the banner.
 */
const HEALTH_PRESENTATION: Record<
    ObservabilityHealth['status'],
    { symbol: string; label: string; className: string }
> = {
    healthy: {symbol: '✓', label: 'سالم', className: 'bg-emerald-100 text-emerald-800'},
    degraded: {symbol: '⚠', label: 'کاهش‌یافته', className: 'bg-amber-100 text-amber-900'},
    unhealthy: {symbol: '✕', label: 'ناسالم', className: 'bg-red-100 text-red-800'},
    disabled: {symbol: '○', label: 'غیرفعال', className: 'bg-muted text-muted-foreground'},
};

/** Default window: the last hour. Narrow on purpose — see the component comment. */
const DEFAULT_RANGE_MINUTES = 60;

/** Mirrors `MAX_RANGE_DAYS` in the DTO. Shown to the user rather than discovered via a 400. */
const MAX_RANGE_DAYS = 92;

const PAGE_SIZE = 50;

/** `datetime-local` needs `YYYY-MM-DDTHH:mm` in LOCAL time, not an ISO UTC string. */
function toLocalInputValue(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
        date.getHours(),
    )}:${pad(date.getMinutes())}`;
}

/**
 * Every filter control on the screen, in one flat bag.
 *
 * FLAT, BUT NEVER SENT FLAT. Each tab builds its own query object from the subset of these
 * fields its endpoint actually accepts, because the DTOs run with `forbidNonWhitelisted` — an
 * unknown parameter is a 400, not a silently ignored one. So `level` never reaches
 * `/audit-events` even though both tabs share this state.
 *
 * All values are STRINGS, including `statusCode`, because that is what an `<input>` yields; the
 * numeric conversion happens once, at query-build time, where an empty string can be dropped
 * instead of becoming `NaN`.
 */
interface FilterState {
    from: string;
    to: string;
    minLevel: string;
    source: string;
    messageCode: string;
    route: string;
    statusCode: string;
    correlationId: string;
    requestId: string;
    traceId: string;
    userId: string;
    moduleId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    actorId: string;
    outcome: string;
    eventType: string;
    severity: string;
    succeeded: string;
    ipAddress: string;
    domain: string;
    phase: string;
    subjectId: string;
}

function emptyFilters(): FilterState {
    const now = new Date();
    const from = new Date(now.getTime() - DEFAULT_RANGE_MINUTES * 60_000);
    return {
        from: toLocalInputValue(from),
        to: toLocalInputValue(now),
        minLevel: '',
        source: '',
        messageCode: '',
        route: '',
        statusCode: '',
        correlationId: '',
        requestId: '',
        traceId: '',
        userId: '',
        moduleId: '',
        action: '',
        resourceType: '',
        resourceId: '',
        actorId: '',
        outcome: '',
        eventType: '',
        severity: '',
        succeeded: '',
        ipAddress: '',
        domain: '',
        phase: '',
        subjectId: '',
    };
}

/**
 * Drops blank values, so an untouched control never reaches the wire.
 *
 * NOT COSMETIC. The DTOs run with `forbidNonWhitelisted`, and `source=''` fails `@IsIn` — an
 * empty select would turn into a 400 rather than "no filter". Returning `Partial<T>` keeps each
 * per-tab query object typed, so a field the endpoint does not accept is still a compile error.
 */
function present<T extends object>(entries: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entries)) {
        if (value === undefined || value === null || value === '') continue;
        out[key] = value;
    }
    return out as Partial<T>;
}

/**
 * Converts a `datetime-local` value to an ISO instant.
 *
 * Returns `null` for an unparseable value rather than `Invalid Date`.toISOString(), which
 * THROWS — an operator half-way through typing a date should not see an exception.
 */
function toIso(localValue: string): string | null {
    if (!localValue) return null;
    const date = new Date(localValue);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

/** Union of every row shape, so one `useState` serves all five tabs. */
type AnyRow =
    | ApplicationLogRow
    | AuditEventRow
    | SecurityEventRow
    | LifecycleEventRow
    | RetentionRunRow;

export function CoreObservabilityView() {
    const {
        permissions,
        isLoading: isPermissionsLoading,
        status: permissionStatus,
    } = useCorePermissions(true);

    const canRead = permissions.includes(READ_PERMISSION);
    const canReadSecurity = permissions.includes(SECURITY_PERMISSION);

    const [tab, setTab] = React.useState<TabId>('logs');
    const [filters, setFilters] = React.useState<FilterState>(emptyFilters);
    /** The filters the LAST request actually used, so typing does not refetch. */
    const [applied, setApplied] = React.useState<FilterState>(filters);
    const [offset, setOffset] = React.useState(0);

    const [vocabulary, setVocabulary] = React.useState<ObservabilityVocabulary | null>(null);
    const [health, setHealth] = React.useState<ObservabilityHealth | null>(null);
    const [rows, setRows] = React.useState<AnyRow[]>([]);
    const [hasMore, setHasMore] = React.useState(false);
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<{ message: string; status: number | null } | null>(null);
    // Re-arms loading/cleared in the filter/tab/pagination/retry handlers below
    // (same commit as the token bump), so the data effect needs no in-effect
    // setter resets. First mount is covered by the initial `isLoading: true`.
    const { token: reloadToken, reload } = useReloadToken(setIsLoading, setError);

    const visibleTabs = React.useMemo(
        () => TABS.filter((entry) => !entry.permission || permissions.includes(entry.permission)),
        [permissions],
    );

    /**
     * If the active tab becomes invisible, fall back to the first visible one.
     *
     * Reachable because `permissions` arrives asynchronously: the tab list is empty on the first
     * render and `security` could otherwise stay selected for a caller who cannot read it, which
     * would fire a request guaranteed to 403.
     *
     * Applied during render, guarded by the previous tab list — never as an effect-body setter
     * (`react-hooks/set-state-in-effect`) — and it re-arms the data read in the same commit (the
     * removed in-effect setters used to arm one render later).
     */
    const [prevVisibleTabs, setPrevVisibleTabs] = React.useState(visibleTabs);
    if (prevVisibleTabs !== visibleTabs) {
        setPrevVisibleTabs(visibleTabs);
        if (visibleTabs.length > 0 && !visibleTabs.some((entry) => entry.id === tab)) {
            setTab(visibleTabs[0].id);
            setIsLoading(true);
            setError(null);
        }
    }

    /** Vocabulary and health load once. Neither is per-tab, and neither depends on the filters. */
    React.useEffect(() => {
        if (!canRead || isPermissionsLoading) return;
        let active = true;

        // Settled, not `all`: a degraded health check must not blank out the filter options, and a
        // vocabulary failure must not hide the health banner. Each is optional to the other.
        void Promise.allSettled([getObservabilityVocabulary(), getObservabilityHealth()]).then(
            ([vocabularyResult, healthResult]) => {
                if (!active) return;
                if (vocabularyResult.status === 'fulfilled') setVocabulary(vocabularyResult.value);
                if (healthResult.status === 'fulfilled') setHealth(healthResult.value);
            },
        );

        return () => {
            active = false;
        };
    }, [canRead, isPermissionsLoading, reloadToken]);

    /**
     * The one data effect.
     *
     * Keyed on `applied`, NOT `filters`: a `useEffect` over the live control state would fire a
     * query per keystroke against the largest tables in the installation. The user presses
     * "اعمال فیلترها" and that copies `filters` into `applied`.
     */
    React.useEffect(() => {
        if (!canRead || isPermissionsLoading) return;
        if (tab === 'security' && !canReadSecurity) return;

        const from = toIso(applied.from);
        if (!from && tab !== 'retention') {
            // The invalid-range refusal settles through a microtask so the effect
            // body holds no synchronous setters
            // (`react-hooks/set-state-in-effect`).
            let refCancelled = false;
            Promise.resolve().then(() => {
                if (refCancelled) return;
                setError({message: 'بازه زمانی نامعتبر است. تاریخ شروع را بررسی کنید.', status: null});
                setIsLoading(false);
            });
            return () => {
                refCancelled = true;
            };
        }

        const to = toIso(applied.to);
        let active = true;

        // Not named `window`: that shadows the global inside a client component, which is how a later
        // edit ends up reading `window.location` off a query object. `from` is non-null for every
        // branch except `retention`, which ignores it — the guard above already returned otherwise.
        //
        // `to` is spread conditionally rather than passed through `present`, because `toIso` returns
        // `string | null` and `ObservabilityQuery.to` is `string | undefined`: `Partial<{to: string |
        // null}>` would not be assignable, and widening the client type to accept `null` would let a
        // literal "to=null" reach the DTO.
        const range: ObservabilityQuery = {
            from: from as string,
            limit: PAGE_SIZE,
            offset,
            ...(to ? {to} : {}),
        };

        // Each branch sends ONLY the parameters its DTO whitelists — see `FilterState`.
        const request = (): Promise<{ items: AnyRow[]; hasMore: boolean }> => {
            switch (tab) {
                case 'logs':
                    return listApplicationLogs({
                        ...range,
                        ...present({
                            minLevel: (applied.minLevel || undefined) as LogLevel | undefined,
                            source: applied.source || undefined,
                            messageCode: applied.messageCode || undefined,
                            route: applied.route || undefined,
                            statusCode: applied.statusCode ? Number(applied.statusCode) : undefined,
                            requestId: applied.requestId || undefined,
                            correlationId: applied.correlationId || undefined,
                            traceId: applied.traceId || undefined,
                            userId: applied.userId || undefined,
                            moduleId: applied.moduleId || undefined,
                        }),
                    });
                case 'audit':
                    return listAuditEvents({
                        ...range,
                        ...present({
                            action: applied.action || undefined,
                            resourceType: applied.resourceType || undefined,
                            resourceId: applied.resourceId || undefined,
                            actorId: applied.actorId || undefined,
                            outcome: (applied.outcome || undefined) as 'SUCCESS' | 'FAILURE' | 'DENIED' | undefined,
                            correlationId: applied.correlationId || undefined,
                        }),
                    });
                case 'security':
                    return listSecurityEvents({
                        ...range,
                        ...present({
                            eventType: applied.eventType || undefined,
                            severity: (applied.severity || undefined) as SecurityEventRow['severity'] | undefined,
                            succeeded: (applied.succeeded || undefined) as 'true' | 'false' | undefined,
                            ipAddress: applied.ipAddress || undefined,
                            actorId: applied.actorId || undefined,
                        }),
                    });
                case 'lifecycle':
                    return listLifecycleEvents({
                        ...range,
                        ...present({
                            domain: (applied.domain || undefined) as LifecycleEventRow['domain'] | undefined,
                            phase: (applied.phase || undefined) as LifecycleEventRow['phase'] | undefined,
                            eventType: applied.eventType || undefined,
                            subjectId: applied.subjectId || undefined,
                            correlationId: applied.correlationId || undefined,
                            moduleId: applied.moduleId || undefined,
                        }),
                    });
                case 'retention':
                default:
                    // No window and no paging: the endpoint returns the last N runs, and there are a few
                    // per day at most. Normalised to the same shape so the render path stays uniform.
                    return listRetentionRuns().then((page) => ({items: page.items, hasMore: false}));
            }
        };

        request()
            .then((page) => {
                if (!active) return;
                setRows(page.items);
                setHasMore(page.hasMore);
                setIsLoading(false);
            })
            .catch((err: unknown) => {
                if (!active) return;
                setError({
                    message: err instanceof Error ? err.message : 'دریافت رخدادها با خطا مواجه شد.',
                    status: err instanceof CoreApiError ? err.status : null,
                });
                setIsLoading(false);
            });

        return () => {
            active = false;
        };
    }, [canRead, canReadSecurity, isPermissionsLoading, tab, applied, offset, reloadToken]);

    /** Applying filters resets paging: page 3 of the previous query is meaningless for a new one. */
    const applyFilters = () => {
        // Re-arm only when this actually changes a data-effect input — an
        // identical "apply" refires nothing and must not strand the spinner
        // (the removed in-effect setters used to arm one render later).
        if (filters !== applied || offset !== 0) {
            setIsLoading(true);
            setError(null);
        }
        setOffset(0);
        setApplied(filters);
    };

    const resetFilters = () => {
        const next = emptyFilters();
        setIsLoading(true);
        setError(null);
        setFilters(next);
        setOffset(0);
        setApplied(next);
    };

    /** Switching tab clears paging but KEEPS the range, which is the point of a shared window. */
    const selectTab = (next: TabId) => {
        // Re-arm only when the switch changes a data-effect input — re-selecting
        // the active tab at page 1 refires nothing.
        if (next !== tab || offset !== 0) {
            setIsLoading(true);
            setError(null);
        }
        setTab(next);
        setOffset(0);
        setRows([]);
    };

    const setField = (key: keyof FilterState) => (value: string) =>
        setFilters((current) => ({...current, [key]: value}));

    /** Vocabulary-driven `<option>` lists. Empty means "any", never a hardcoded first value. */
    const optionsOf = (values: readonly string[] | undefined, anyLabel: string) => [
        {value: '', label: anyLabel},
        ...(values ?? []).map((value) => ({value, label: value})),
    ];

    if (isPermissionsLoading) {
        return <CoreLoading label="در حال بارگذاری دسترسی‌ها..."/>;
    }

    // Presentation-only gate. Every route enforces the same permission server-side.
    if (!canRead || permissionStatus === 403 || error?.status === 403) {
        return <CoreForbidden/>;
    }

    const healthPresentation = health ? HEALTH_PRESENTATION[health.status] : null;

    return (
        <div className="space-y-6" dir="rtl">
            <header className="space-y-1">
                <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
                    <ScrollText className="h-5 w-5" aria-hidden="true"/>
                    لاگ‌ها و رخدادها
                </h1>
                <p className="text-sm text-muted-foreground">
                    این صفحه فقط خواندنی است. هیچ رخدادی از اینجا ثبت یا حذف نمی‌شود؛ حذف تنها بر اساس سیاست
                    نگهداشت انجام می‌گیرد.
                </p>
            </header>

            {health && healthPresentation && (
                <section
                    aria-label="وضعیت سامانه رخدادنگاری"
                    className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-muted/30 p-4 text-xs text-muted-foreground"
                >
                    <Badge {...healthPresentation} />
                    {health.reason && <span>{health.reason}</span>}
                    {health.writer && (
                        <>
              <span>
                صف: {health.writer.queued} از {health.writer.queueCapacity}
              </span>
                            <span>نوشته‌شده: {health.writer.written}</span>
                            {/* Surfaced ALWAYS, not only when non-zero: a reader needs to know that "0 dropped"
                  was measured rather than assumed. */}
                            <span>حذف‌شده زیر فشار: {health.writer.dropped}</span>
                        </>
                    )}
                    {health.database && !health.database.reachable && (
                        <span>پایگاه‌داده رخدادها در دسترس نیست.</span>
                    )}
                </section>
            )}

            <nav aria-label="دسته‌های رخداد" className="flex flex-wrap gap-2 border-b border-border pb-2">
                {visibleTabs.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        onClick={() => selectTab(entry.id)}
                        aria-current={tab === entry.id ? 'page' : undefined}
                        className={`rounded-full px-3 py-1 text-sm transition ${
                            tab === entry.id
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-muted text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        {entry.label}
                    </button>
                ))}
            </nav>

            {/* Not a `<form>` with an `onSubmit` alone: Enter inside a filter field should apply, and a
          `<form>` gives that for free — but the button is still explicit for pointer users. */}
            <form
                aria-label="فیلترها"
                className="space-y-4 rounded-2xl border border-border p-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    applyFilters();
                }}
            >
                {tab !== 'retention' && (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Input
                            label="از تاریخ"
                            type="datetime-local"
                            name="from"
                            required
                            value={filters.from}
                            onChange={(event) => setField('from')(event.target.value)}
                        />
                        <Input
                            label="تا تاریخ"
                            type="datetime-local"
                            name="to"
                            value={filters.to}
                            onChange={(event) => setField('to')(event.target.value)}
                        />
                    </div>
                )}

                {tab === 'logs' && (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Select
                            label="حداقل سطح"
                            name="minLevel"
                            value={filters.minLevel}
                            options={optionsOf(vocabulary?.levels, 'همه سطوح')}
                            onChange={(event) => setField('minLevel')(event.target.value)}
                        />
                        <Select
                            label="منبع"
                            name="source"
                            value={filters.source}
                            options={optionsOf(vocabulary?.sources, 'همه منابع')}
                            onChange={(event) => setField('source')(event.target.value)}
                        />
                        <Select
                            label="کد پیام"
                            name="messageCode"
                            value={filters.messageCode}
                            options={optionsOf(vocabulary?.messageCodes, 'همه کدها')}
                            onChange={(event) => setField('messageCode')(event.target.value)}
                        />
                        <Input
                            label="مسیر"
                            name="route"
                            placeholder="/users/:id"
                            value={filters.route}
                            onChange={(event) => setField('route')(event.target.value)}
                        />
                        <Input
                            label="کد وضعیت"
                            name="statusCode"
                            type="number"
                            inputMode="numeric"
                            value={filters.statusCode}
                            onChange={(event) => setField('statusCode')(event.target.value)}
                        />
                        <Input
                            label="شناسه همبستگی"
                            name="correlationId"
                            value={filters.correlationId}
                            onChange={(event) => setField('correlationId')(event.target.value)}
                        />
                        <Input
                            label="شناسه درخواست"
                            name="requestId"
                            value={filters.requestId}
                            onChange={(event) => setField('requestId')(event.target.value)}
                        />
                        <Input
                            label="شناسه کاربر"
                            name="userId"
                            value={filters.userId}
                            onChange={(event) => setField('userId')(event.target.value)}
                        />
                    </div>
                )}

                {tab === 'audit' && (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Input
                            label="کنش"
                            name="action"
                            value={filters.action}
                            onChange={(event) => setField('action')(event.target.value)}
                        />
                        <Input
                            label="نوع منبع"
                            name="resourceType"
                            value={filters.resourceType}
                            onChange={(event) => setField('resourceType')(event.target.value)}
                        />
                        <Input
                            label="شناسه منبع"
                            name="resourceId"
                            value={filters.resourceId}
                            onChange={(event) => setField('resourceId')(event.target.value)}
                        />
                        <Select
                            label="نتیجه"
                            name="outcome"
                            value={filters.outcome}
                            options={[
                                {value: '', label: 'همه نتایج'},
                                {value: 'SUCCESS', label: 'موفق'},
                                {value: 'FAILURE', label: 'ناموفق'},
                                {value: 'DENIED', label: 'رد شده'},
                            ]}
                            onChange={(event) => setField('outcome')(event.target.value)}
                        />
                        <Input
                            label="شناسه عامل"
                            name="actorId"
                            value={filters.actorId}
                            onChange={(event) => setField('actorId')(event.target.value)}
                        />
                        <Input
                            label="شناسه همبستگی"
                            name="correlationId"
                            value={filters.correlationId}
                            onChange={(event) => setField('correlationId')(event.target.value)}
                        />
                    </div>
                )}

                {tab === 'security' && (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Select
                            label="نوع رخداد"
                            name="eventType"
                            value={filters.eventType}
                            options={optionsOf(vocabulary?.securityEventTypes, 'همه رخدادها')}
                            onChange={(event) => setField('eventType')(event.target.value)}
                        />
                        <Select
                            label="شدت"
                            name="severity"
                            value={filters.severity}
                            options={optionsOf(vocabulary?.securitySeverities, 'همه شدت‌ها')}
                            onChange={(event) => setField('severity')(event.target.value)}
                        />
                        {/* Sent as the STRING "true"/"false". See `SecurityEventQuery`. */}
                        <Select
                            label="نتیجه"
                            name="succeeded"
                            value={filters.succeeded}
                            options={[
                                {value: '', label: 'همه'},
                                {value: 'false', label: 'فقط تلاش‌های ناموفق'},
                                {value: 'true', label: 'فقط موفق'},
                            ]}
                            onChange={(event) => setField('succeeded')(event.target.value)}
                        />
                        <Input
                            label="نشانی IP"
                            name="ipAddress"
                            value={filters.ipAddress}
                            onChange={(event) => setField('ipAddress')(event.target.value)}
                        />
                        <Input
                            label="شناسه عامل"
                            name="actorId"
                            value={filters.actorId}
                            onChange={(event) => setField('actorId')(event.target.value)}
                        />
                    </div>
                )}

                {tab === 'lifecycle' && (
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Select
                            label="حوزه"
                            name="domain"
                            value={filters.domain}
                            options={optionsOf(vocabulary?.lifecycleDomains, 'همه حوزه‌ها')}
                            onChange={(event) => setField('domain')(event.target.value)}
                        />
                        <Select
                            label="مرحله"
                            name="phase"
                            value={filters.phase}
                            options={optionsOf(vocabulary?.lifecyclePhases, 'همه مراحل')}
                            onChange={(event) => setField('phase')(event.target.value)}
                        />
                        <Input
                            label="نوع رخداد"
                            name="eventType"
                            value={filters.eventType}
                            onChange={(event) => setField('eventType')(event.target.value)}
                        />
                        <Input
                            label="شناسه موضوع"
                            name="subjectId"
                            value={filters.subjectId}
                            onChange={(event) => setField('subjectId')(event.target.value)}
                        />
                        <Input
                            label="شناسه ماژول"
                            name="moduleId"
                            value={filters.moduleId}
                            onChange={(event) => setField('moduleId')(event.target.value)}
                        />
                        <Input
                            label="شناسه همبستگی"
                            name="correlationId"
                            value={filters.correlationId}
                            onChange={(event) => setField('correlationId')(event.target.value)}
                        />
                    </div>
                )}

                {tab === 'retention' && (
                    <p className="text-xs text-muted-foreground">
                        آخرین اجراهای سیاست نگهداشت. این فهرست بازه زمانی ندارد.
                    </p>
                )}

                {tab !== 'retention' && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="submit" className="text-sm">
                            اعمال فیلترها
                        </Button>
                        <Button type="button" onClick={resetFilters} className="text-sm">
                            بازنشانی
                        </Button>
                        <span className="text-xs text-muted-foreground">
              حداکثر بازه مجاز {MAX_RANGE_DAYS} روز است.
            </span>
                    </div>
                )}
            </form>

            {/* `aria-live="polite"`: paging and tab switches replace this region without moving focus, so
          a screen reader would otherwise announce nothing at all after "بعدی". */}
            <section aria-label="نتایج" aria-live="polite" className="space-y-4">
                {isLoading ? (
                    <CoreLoading label="در حال بارگذاری رخدادها..."/>
                ) : error ? (
                    <CoreError message={error.message} onRetry={reload}/>
                ) : rows.length === 0 ? (
                    <CoreEmpty message="در این بازه زمانی رخدادی ثبت نشده است."/>
                ) : (
                    <>
                        <div className="overflow-x-auto rounded-2xl border border-border">
                            {tab === 'logs' && <LogsTable rows={rows as ApplicationLogRow[]}/>}
                            {tab === 'audit' && <AuditTable rows={rows as AuditEventRow[]}/>}
                            {tab === 'security' && <SecurityTable rows={rows as SecurityEventRow[]}/>}
                            {tab === 'lifecycle' && <LifecycleTable rows={rows as LifecycleEventRow[]}/>}
                            {tab === 'retention' && <RetentionTable rows={rows as RetentionRunRow[]}/>}
                        </div>

                        {tab !== 'retention' && (
                            <div className="flex flex-wrap items-center gap-3">
                                <Button
                                    type="button"
                                    disabled={offset === 0}
                                    onClick={() => {
                                        // Re-arm in the same handler commit (the removed
                                        // in-effect setters used to arm one render later).
                                        setIsLoading(true);
                                        setError(null);
                                        setOffset((current) => Math.max(0, current - PAGE_SIZE));
                                    }}
                                    className="text-sm"
                                >
                                    قبلی
                                </Button>
                                <Button
                                    type="button"
                                    disabled={!hasMore}
                                    onClick={() => {
                                        setIsLoading(true);
                                        setError(null);
                                        setOffset((current) => current + PAGE_SIZE);
                                    }}
                                    className="text-sm"
                                >
                                    بعدی
                                </Button>
                                {/* Row range, NOT "page X of Y": there is no total to divide by, by design. */}
                                <span className="text-xs text-muted-foreground">
                  ردیف {offset + 1} تا {offset + rows.length}
                </span>
                            </div>
                        )}
                    </>
                )}
            </section>
        </div>
    );
}
