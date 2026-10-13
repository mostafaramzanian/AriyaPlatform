import {render, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {CoreObservabilityView} from '../CoreObservabilityView';
import * as observabilityApi from '@/lib/observability-api';
import {useCorePermissions} from '../useCorePermissions';

/**
 * Phase 49M-2 §21/§28/§30: the observability read surface.
 *
 * WHAT THIS FILE IS DEFENDING, in order of weight:
 *
 *  1. THE SECURITY TAB IS HIDDEN, NOT DISABLED, without `admin.security.read`. Asserted by
 *     absence AND by the request never being made — a disabled tab would advertise that the data
 *     exists, and OPERATIONS_ADMIN legitimately reaches this page without that permission.
 *  2. NO WRITE PATH EXISTS. The client module is asserted to export no create/update/delete
 *     function at all. This is the UI half of "there is no `POST /admin/observability/logs`";
 *     the server half is the controller's own comment and route list.
 *  3. `from` IS ALWAYS SENT. The server rejects an unbounded query, so a tab that forgot the
 *     window would be a 400 the user cannot fix.
 *  4. PER-TAB PARAMETER ISOLATION. The DTOs run with `forbidNonWhitelisted`, so `minLevel`
 *     reaching `/audit-events` is a 400. Asserted for the shared filter state.
 *  5. `succeeded` TRAVELS AS THE STRING `'false'`. `Boolean('false')` is `true`, and this is the
 *     one filter where an inversion silently returns the opposite of an incident query.
 *  6. LEVEL AND SEVERITY ARE TEXT, NOT ONLY COLOUR (§30).
 *  7. `attemptedIdentifier` IS RENDERED AS RECEIVED — masked. The view never reconstructs it.
 */

jest.mock('@/lib/observability-api');
jest.mock('../useCorePermissions');

const api = observabilityApi as jest.Mocked<typeof observabilityApi>;
const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;

const VOCABULARY: observabilityApi.ObservabilityVocabulary = {
    levels: ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'],
    sources: ['http', 'auth', 'rbac'],
    messageCodes: ['http.request.completed', 'auth.login.failed'],
    securityEventTypes: ['LOGIN_FAILED', 'PERMISSION_DENIED'],
    securitySeverities: ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
    lifecycleDomains: ['INTEGRATION', 'MODULE', 'PROVISIONING'],
    lifecyclePhases: ['STARTED', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'REFUSED', 'TIMEOUT'],
};

const HEALTH: observabilityApi.ObservabilityHealth = {
    status: 'healthy',
    database: {reachable: true, error: null},
    writer: {
        queued: 0,
        queueCapacity: 10_000,
        queueUtilization: 0,
        enqueued: 12,
        written: 12,
        dropped: 0,
        failedBatches: 0,
        rejectedUnknownCode: 0,
        lastFlushAt: '2026-09-05T10:00:00.000Z',
        lastErrorAt: null,
        lastErrorMessage: null,
        flushing: false,
    },
    checkedAt: '2026-09-05T10:00:00.000Z',
};

const LOG_ROW: observabilityApi.ApplicationLogRow = {
    id: 'log-1',
    occurredAt: '2026-09-05T10:00:00.000Z',
    level: 'ERROR',
    messageCode: 'http.request.failed',
    message: 'درخواست ناموفق بود',
    source: 'http',
    service: 'core-api',
    environment: 'production',
    instanceRef: null,
    requestId: 'req-1',
    correlationId: 'corr-abcdef123456789',
    traceId: null,
    spanId: null,
    userId: null,
    tenantId: null,
    httpMethod: 'GET',
    route: '/users/:id',
    statusCode: 500,
    durationMs: 42,
    moduleId: null,
    instanceId: null,
    deploymentMode: null,
    context: {attempt: 1},
    errorName: 'InternalServerError',
    errorMessage: 'boom',
    errorStack: 'at somewhere',
};

const AUDIT_ROW: observabilityApi.AuditEventRow = {
    id: 'audit-1',
    occurredAt: '2026-09-05T10:01:00.000Z',
    action: 'user.update',
    resourceType: 'User',
    resourceId: 'user-1',
    actorType: 'USER',
    actorId: 'admin-1',
    actorRole: 'SUPER_ADMIN',
    outcome: 'SUCCESS',
    reason: null,
    tenantId: null,
    requestId: null,
    correlationId: null,
    traceId: null,
    ipAddress: null,
    userAgent: null,
    beforeValue: {displayName: 'قدیمی'},
    afterValue: {displayName: 'جدید'},
    changedFields: ['displayName'],
    moduleId: null,
    instanceId: null,
    durationMs: null,
};

const SECURITY_ROW: observabilityApi.SecurityEventRow = {
    id: 'sec-1',
    occurredAt: '2026-09-05T10:02:00.000Z',
    eventType: 'LOGIN_FAILED',
    severity: 'HIGH',
    succeeded: false,
    actorType: 'ANONYMOUS',
    actorId: null,
    // Masked BEFORE insert. The view renders exactly this.
    attemptedIdentifier: 'ad***@example.com',
    ipAddress: '203.0.113.7',
    userAgent: null,
    httpMethod: 'POST',
    route: '/auth/login',
    requiredPermission: null,
    tenantId: null,
    requestId: null,
    correlationId: null,
    traceId: null,
    moduleId: null,
    instanceId: null,
    reasonCode: 'INVALID_CREDENTIALS',
    detail: null,
};

const LIFECYCLE_ROW: observabilityApi.LifecycleEventRow = {
    id: 'life-1',
    occurredAt: '2026-09-05T10:03:00.000Z',
    domain: 'MODULE',
    eventType: 'module.heartbeat',
    phase: 'SUCCEEDED',
    outcomeCode: 'OK',
    subjectType: 'ModuleInstance',
    subjectId: 'inst-1',
    subjectKey: 'finance-prod-01',
    moduleId: 'finance',
    instanceId: 'inst-1',
    requestId: null,
    correlationId: null,
    traceId: null,
    actorType: 'MODULE',
    actorId: 'finance',
    tenantId: null,
    durationMs: 8,
    attempt: 1,
    detail: null,
};

const RETENTION_ROW: observabilityApi.RetentionRunRow = {
    id: 'ret-1',
    startedAt: '2026-09-05T03:00:00.000Z',
    finishedAt: '2026-09-05T03:00:05.000Z',
    category: 'applicationLog',
    cutoff: '2026-06-07T03:00:00.000Z',
    deletedCount: 0,
    truncated: false,
    succeeded: true,
    errorMessage: null,
    durationMs: 5_000,
};

const page = <T, >(items: T[], hasMore = false): observabilityApi.ObservabilityPage<T> => ({
    items,
    limit: 50,
    offset: 0,
    hasMore,
    range: {from: '2026-09-05T09:00:00.000Z', to: '2026-09-05T10:00:00.000Z'},
});

const grant = (permissions: string[]) => {
    permissionsMock.mockReturnValue({
        permissions,
        roles: [],
        highestRole: null,
        isLoading: false,
        error: null,
        status: null,
        reload: jest.fn(),
    });
};

beforeEach(() => {
    jest.clearAllMocks();

    api.getObservabilityVocabulary.mockResolvedValue(VOCABULARY);
    api.getObservabilityHealth.mockResolvedValue(HEALTH);
    api.listApplicationLogs.mockResolvedValue(page([LOG_ROW]));
    api.listAuditEvents.mockResolvedValue(page([AUDIT_ROW]));
    api.listSecurityEvents.mockResolvedValue(page([SECURITY_ROW]));
    api.listLifecycleEvents.mockResolvedValue(page([LIFECYCLE_ROW]));
    api.listRetentionRuns.mockResolvedValue({items: [RETENTION_ROW]});
});

describe('CoreObservabilityView — authorization', () => {
    it('renders the forbidden state, and fetches nothing, without observability read', async () => {
        grant([]);

        render(<CoreObservabilityView/>);

        expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
        expect(api.listApplicationLogs).not.toHaveBeenCalled();
        expect(api.getObservabilityVocabulary).not.toHaveBeenCalled();
    });

    it('HIDES the security tab — it does not disable it — without admin.security.read', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        // The other four tabs are present...
        expect(await screen.findByRole('button', {name: 'لاگ‌های برنامه'})).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'رخدادهای حسابرسی'})).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'چرخه حیات پلتفرم'})).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'نگهداشت داده'})).toBeInTheDocument();

        // ...and the security tab does not exist in any state. `queryByRole` ignores `disabled`, so a
        // disabled-but-present tab would still fail this assertion — which is the point.
        expect(screen.queryByRole('button', {name: 'رخدادهای امنیتی'})).not.toBeInTheDocument();
        expect(api.listSecurityEvents).not.toHaveBeenCalled();
    });

    it('shows the security tab to a caller holding admin.security.read', async () => {
        grant(['admin.observability.read', 'admin.security.read']);

        render(<CoreObservabilityView/>);

        expect(await screen.findByRole('button', {name: 'رخدادهای امنیتی'})).toBeInTheDocument();
    });
});

describe('CoreObservabilityView — the mandatory time window (§21)', () => {
    it('always sends `from`, and a bounded `limit`, on the first logs query', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        await waitFor(() => expect(api.listApplicationLogs).toHaveBeenCalled());

        const query = api.listApplicationLogs.mock.calls[0][0];
        // An unbounded query is a 400 server-side, so its absence is not a style question.
        expect(query.from).toBeTruthy();
        expect(new Date(query.from).getTime()).not.toBeNaN();
        expect(query.limit).toBe(50);
        expect(query.offset).toBe(0);
    });

    it('shows the range as editable controls rather than an invisible default', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        const form = await screen.findByRole('form', {name: 'فیلترها'});
        const from = form.querySelector('input[name="from"]') as HTMLInputElement | null;

        expect(from).not.toBeNull();
        expect(from!.type).toBe('datetime-local');
        // Seeded, not blank: `from` is mandatory, so an empty control would be an immediate 400.
        expect(from!.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    });
});

describe('CoreObservabilityView — per-tab parameter isolation', () => {
    /**
     * The DTOs run with `forbidNonWhitelisted`, so an extra parameter is a 400 rather than an
     * ignored one. The filter state is shared across tabs; the QUERIES must not be.
     */
    it('does not leak `minLevel` from the logs filter into the audit query', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        const form = await screen.findByRole('form', {name: 'فیلترها'});
        await userEvent.selectOptions(form.querySelector('select[name="minLevel"]')!, 'WARN');
        await userEvent.click(screen.getByRole('button', {name: 'اعمال فیلترها'}));

        await waitFor(() =>
            expect(api.listApplicationLogs).toHaveBeenCalledWith(
                expect.objectContaining({minLevel: 'WARN'}),
            ),
        );

        await userEvent.click(screen.getByRole('button', {name: 'رخدادهای حسابرسی'}));

        await waitFor(() => expect(api.listAuditEvents).toHaveBeenCalled());
        const auditQuery = api.listAuditEvents.mock.calls.at(-1)![0];
        expect(auditQuery).not.toHaveProperty('minLevel');
        expect(auditQuery).not.toHaveProperty('source');
        expect(auditQuery).not.toHaveProperty('statusCode');
    });

    it('omits an untouched filter entirely instead of sending an empty string', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        await waitFor(() => expect(api.listApplicationLogs).toHaveBeenCalled());

        const query = api.listApplicationLogs.mock.calls[0][0];
        expect(query).not.toHaveProperty('source');
        expect(query).not.toHaveProperty('messageCode');
        expect(query).not.toHaveProperty('route');
    });

    it('sends `statusCode` as a NUMBER, never the raw input string', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        const form = await screen.findByRole('form', {name: 'فیلترها'});
        await userEvent.type(form.querySelector('input[name="statusCode"]')!, '500');
        await userEvent.click(screen.getByRole('button', {name: 'اعمال فیلترها'}));

        await waitFor(() =>
            expect(api.listApplicationLogs).toHaveBeenCalledWith(
                expect.objectContaining({statusCode: 500}),
            ),
        );
    });
});

describe('CoreObservabilityView — the read-only boundary', () => {
    /**
     * Asserted against the CLIENT MODULE, not the rendered output.
     *
     * A "no write button" assertion only proves this render has no button; asserting that the API
     * module exports no mutation at all proves a future edit cannot add one without touching this
     * file. `POST /admin/observability/logs` does not exist server-side either.
     */
    it('exposes NO write, update or delete function in the observability client', () => {
        const exported = Object.keys(observabilityApi);

        expect(exported).not.toEqual(
            expect.arrayContaining([
                expect.stringMatching(/^(create|update|delete|remove|write|post|patch|purge|prune)/i),
            ]),
        );
        // Everything exported is a read.
        for (const name of exported.filter((key) => typeof (api as never)[key] === 'function')) {
            expect(name).toMatch(/^(get|list)/);
        }
    });
});

describe('CoreObservabilityView — the security tab', () => {
    it('sends `succeeded` as the STRING "false" for the failed-attempts query', async () => {
        grant(['admin.observability.read', 'admin.security.read']);

        render(<CoreObservabilityView/>);

        await userEvent.click(await screen.findByRole('button', {name: 'رخدادهای امنیتی'}));
        await waitFor(() => expect(api.listSecurityEvents).toHaveBeenCalled());

        const form = screen.getByRole('form', {name: 'فیلترها'});
        await userEvent.selectOptions(form.querySelector('select[name="succeeded"]')!, 'false');
        await userEvent.click(screen.getByRole('button', {name: 'اعمال فیلترها'}));

        await waitFor(() => {
            const query = api.listSecurityEvents.mock.calls.at(-1)![0];
            // The string, NOT `false`. `Boolean('false')` is `true`, which would return successful
            // logins for the query that exists to find failed ones.
            expect(query.succeeded).toBe('false');
            expect(typeof query.succeeded).toBe('string');
        });
    });

    it('renders `attemptedIdentifier` exactly as received — masked, never reconstructed', async () => {
        grant(['admin.observability.read', 'admin.security.read']);

        const {container} = render(<CoreObservabilityView/>);

        await userEvent.click(await screen.findByRole('button', {name: 'رخدادهای امنیتی'}));

        expect(await screen.findByText('ad***@example.com')).toBeInTheDocument();
        // The unmasked local part does not appear anywhere: it does not exist client-side to appear.
        expect(container.textContent).not.toContain('admin@example.com');
    });
});

describe('CoreObservabilityView — presentation is never colour alone (§30)', () => {
    it('renders the log level as a Persian word, not only a colour class', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        // ERROR. A screen reader and a colour-blind operator both read this.
        expect(await screen.findByText('خطا')).toBeInTheDocument();
    });

    it('renders the security severity as a word', async () => {
        grant(['admin.observability.read', 'admin.security.read']);

        render(<CoreObservabilityView/>);

        await userEvent.click(await screen.findByRole('button', {name: 'رخدادهای امنیتی'}));

        // HIGH severity plus the failed-attempt badge.
        expect(await screen.findByText('بالا')).toBeInTheDocument();
        expect(screen.getByText('ناموفق')).toBeInTheDocument();
    });

    it('renders the lifecycle phase as a word AND keeps the raw outcome code', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        await userEvent.click(await screen.findByRole('button', {name: 'چرخه حیات پلتفرم'}));

        // The normalized phase is comparable across domains; the outcome code keeps the original.
        expect(await screen.findByText('موفق')).toBeInTheDocument();
        expect(screen.getByText('OK')).toBeInTheDocument();
    });

    it('renders tabular results in a real table with column headers', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        expect(await screen.findByRole('table')).toBeInTheDocument();
        expect(screen.getByRole('columnheader', {name: 'کد پیام'})).toBeInTheDocument();
    });
});

describe('CoreObservabilityView — paging without a total', () => {
    /**
     * There is no `total`, by design: `SELECT count(*)` over a multi-million-row window costs as
     * much as the page. So the controls are driven by `hasMore` and `offset` alone, and the label is
     * a row RANGE rather than "page X of Y".
     */
    it('disables "next" when the server reports no further rows', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        expect(await screen.findByRole('button', {name: 'بعدی'})).toBeDisabled();
        expect(screen.getByRole('button', {name: 'قبلی'})).toBeDisabled();
    });

    it('advances `offset` by the page size and re-queries', async () => {
        api.listApplicationLogs.mockResolvedValue(page([LOG_ROW], true));
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        await userEvent.click(await screen.findByRole('button', {name: 'بعدی'}));

        await waitFor(() =>
            expect(api.listApplicationLogs).toHaveBeenCalledWith(expect.objectContaining({offset: 50})),
        );
        // Going forward makes "previous" reachable, which it was not on the first page.
        expect(screen.getByRole('button', {name: 'قبلی'})).not.toBeDisabled();
    });

    it('resets paging when the filters are applied again', async () => {
        api.listApplicationLogs.mockResolvedValue(page([LOG_ROW], true));
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        await userEvent.click(await screen.findByRole('button', {name: 'بعدی'}));
        await waitFor(() =>
            expect(api.listApplicationLogs).toHaveBeenCalledWith(expect.objectContaining({offset: 50})),
        );

        const form = screen.getByRole('form', {name: 'فیلترها'});
        await userEvent.selectOptions(form.querySelector('select[name="minLevel"]')!, 'ERROR');
        await userEvent.click(screen.getByRole('button', {name: 'اعمال فیلترها'}));

        // Page 2 of the old query says nothing about the new one.
        await waitFor(() => {
            const query = api.listApplicationLogs.mock.calls.at(-1)![0];
            expect(query.offset).toBe(0);
            expect(query.minLevel).toBe('ERROR');
        });
    });

    it('offers no paging controls on the retention tab, which has no window', async () => {
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        await userEvent.click(await screen.findByRole('button', {name: 'نگهداشت داده'}));

        await waitFor(() => expect(api.listRetentionRuns).toHaveBeenCalled());
        expect(screen.queryByRole('button', {name: 'بعدی'})).not.toBeInTheDocument();
        // A zero-deletion run is a SUCCESS, and is displayed as one.
        expect(await screen.findByText('موفق')).toBeInTheDocument();
    });
});

describe('CoreObservabilityView — failure and emptiness', () => {
    it('shows the empty state, not placeholder rows, for a window with no events', async () => {
        api.listApplicationLogs.mockResolvedValue(page([]));
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        expect(await screen.findByText('در این بازه زمانی رخدادی ثبت نشده است.')).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('surfaces a failed query as a retryable error', async () => {
        api.listApplicationLogs.mockRejectedValue(new Error('پایگاه‌داده در دسترس نیست'));
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        expect(await screen.findByText('پایگاه‌داده در دسترس نیست')).toBeInTheDocument();
        expect(screen.getByRole('button', {name: 'تلاش دوباره'})).toBeInTheDocument();
    });

    it('still renders the filters when the vocabulary request fails', async () => {
        api.getObservabilityVocabulary.mockRejectedValue(new Error('nope'));
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        // `allSettled`, not `all`: losing the option lists must not take the page down with them.
        const form = await screen.findByRole('form', {name: 'فیلترها'});
        expect(form.querySelector('select[name="minLevel"]')).not.toBeNull();
        await waitFor(() => expect(api.listApplicationLogs).toHaveBeenCalled());
    });

    it('reports the writer as disabled without treating it as a failure', async () => {
        api.getObservabilityHealth.mockResolvedValue({
            status: 'disabled',
            reason: 'OBSERVABILITY_ENABLED is not "true"',
        });
        grant(['admin.observability.read']);

        render(<CoreObservabilityView/>);

        expect(await screen.findByText('غیرفعال')).toBeInTheDocument();
        // Still a working read surface: the tables query regardless.
        await waitFor(() => expect(api.listApplicationLogs).toHaveBeenCalled());
    });
});

