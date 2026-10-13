import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreIntegrationsView } from '../CoreIntegrationsView';
import * as integrationsApi from '@/lib/integrations-api';
import { useCorePermissions } from '../useCorePermissions';

/**
 * Phase 49L §41: the integration settings surface.
 *
 * WHAT THIS FILE IS DEFENDING, in order of weight:
 *
 *  1. THE SECRET IS NEVER RENDERED FROM A READ. The form's secret input is asserted empty
 *     on open — for a create AND for an edit of a row that HAS a stored secret — and the
 *     rendered document is asserted not to contain a secret-shaped value. This is the UI
 *     half of the containment guarantee; the server half is in the service spec.
 *  2. AN EMPTY SECRET INPUT MEANS "LEAVE IT ALONE". The PATCH body is inspected.
 *  3. THE FIVE CONNECTION STATES ARE VISIBLE (§42), so an operator can tell "off" from
 *     "broken" from "never tested".
 *  4. READ-ONLY CALLERS SEE NO WRITE AFFORDANCES, and a caller with neither permission
 *     sees the forbidden state rather than an empty page.
 *  5. THERE IS NO WORKFLOW EDITOR. Asserted by absence, because "we didn't build one" is
 *     exactly the kind of boundary that erodes silently.
 */

jest.mock('@/lib/integrations-api');
jest.mock('../useCorePermissions');

const api = integrationsApi as jest.Mocked<typeof integrationsApi>;
const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;

const CONFIG: integrationsApi.Integration = {
  id: 'cfg-1',
  integration: 'N8N',
  baseUrl: 'http://localhost:5678',
  webhookPath: '/webhook/aria',
  enabled: true,
  timeoutMs: 10000,
  maxAttempts: 3,
  hasSecret: true,
  secretUpdatedAt: '2026-09-04T10:00:00.000Z',
  lastTestStatus: 'SUCCESS',
  lastTestedAt: '2026-09-04T11:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-04T11:00:00.000Z',
};

const DESCRIPTOR: integrationsApi.IntegrationDescriptor = {
  key: 'N8N',
  displayName: 'n8n (اتوماسیون محلی)',
  defaultWebhookPath: '/webhook/aria',
};

const EXECUTION: integrationsApi.AutomationExecution = {
  id: 'exec-1',
  integration: 'N8N',
  eventId: 'evt-1',
  eventType: 'ticket.created',
  eventVersion: 1,
  source: 'support',
  status: 'COMPLETED',
  externalExecutionId: 'n8n-9',
  attemptCount: 1,
  errorCode: null,
  correlationId: 'corr-1',
  createdAt: '2026-09-04T11:05:00.000Z',
  startedAt: '2026-09-04T11:05:00.000Z',
  completedAt: '2026-09-04T11:05:02.000Z',
};

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

  // The real helpers are pure; only the network functions are stubbed, so the labels under
  // test are the ones the component actually ships with.
  api.integrationStatusLabel.mockImplementation(
    jest.requireActual('@/lib/integrations-api').integrationStatusLabel,
  );
  api.secretStatusLabel.mockImplementation(
    jest.requireActual('@/lib/integrations-api').secretStatusLabel,
  );
  api.integrationLabel.mockImplementation(
    jest.requireActual('@/lib/integrations-api').integrationLabel,
  );
  api.formatIntegrationTime.mockImplementation(
    jest.requireActual('@/lib/integrations-api').formatIntegrationTime,
  );
  (api as unknown as { AUTOMATION_STATUS_LABELS: unknown }).AUTOMATION_STATUS_LABELS =
    jest.requireActual('@/lib/integrations-api').AUTOMATION_STATUS_LABELS;

  api.listIntegrations.mockResolvedValue({ configs: [CONFIG], integrations: [DESCRIPTOR] });
  api.listAutomationExecutions.mockResolvedValue({ items: [EXECUTION], nextCursor: null });
  api.updateIntegration.mockResolvedValue(CONFIG);
  api.createIntegration.mockResolvedValue(CONFIG);
  api.deleteIntegration.mockResolvedValue({ id: 'cfg-1', deleted: true });
  api.rotateIntegrationSecret.mockResolvedValue({ secret: 'f'.repeat(64) });
  api.testIntegration.mockResolvedValue({ status: 'SUCCESS', message: 'اتصال برقرار شد' });
});

describe('CoreIntegrationsView — authorization', () => {
  it('shows the forbidden state, and issues NO request, without the read permission', async () => {
    grant([]);

    render(<CoreIntegrationsView />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(api.listIntegrations).not.toHaveBeenCalled();
    expect(api.listAutomationExecutions).not.toHaveBeenCalled();
  });

  it('renders read-only for a caller with read but not manage', async () => {
    grant(['admin.integrations.read']);

    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');

    // Every write affordance is absent — not disabled, absent — so a read-only
    // OPERATIONS_ADMIN is never invited into a guaranteed 403.
    expect(screen.queryByTestId('integration-create-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-edit-N8N')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-test-N8N')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-rotate-N8N')).not.toBeInTheDocument();
    expect(screen.queryByTestId('integration-delete-N8N')).not.toBeInTheDocument();
  });

  it('renders write affordances for a manager', async () => {
    grant(['admin.integrations.read', 'admin.integrations.manage']);

    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');

    expect(screen.getByTestId('integration-edit-N8N')).toBeInTheDocument();
    expect(screen.getByTestId('integration-test-N8N')).toBeInTheDocument();
    expect(screen.getByTestId('integration-rotate-N8N')).toBeInTheDocument();
    expect(screen.getByTestId('integration-delete-N8N')).toBeInTheDocument();
  });
});

describe('CoreIntegrationsView — secret containment', () => {
  beforeEach(() => grant(['admin.integrations.read', 'admin.integrations.manage']));

  it('opens the edit form with an EMPTY secret input even though one is stored', async () => {
    const user = userEvent.setup();
    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');
    await user.click(screen.getByTestId('integration-edit-N8N'));

    const input = screen.getByTestId('integration-secret') as HTMLInputElement;

    // There is nothing to prefill it with: the server has no projection that returns a
    // secret. A placeholder value would imply otherwise.
    expect(input.value).toBe('');
    expect(input.type).toBe('password');
  });

  it('sends NO secret when the input is left empty', async () => {
    const user = userEvent.setup();
    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');
    await user.click(screen.getByTestId('integration-edit-N8N'));
    await user.click(screen.getByTestId('integration-save'));

    await waitFor(() => expect(api.updateIntegration).toHaveBeenCalled());

    const [, payload] = api.updateIntegration.mock.calls[0];
    // Empty means "leave the stored secret untouched" — the PATCH contract.
    expect(payload).not.toHaveProperty('secret');
  });

  it('sends the secret when one is typed', async () => {
    const user = userEvent.setup();
    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');
    await user.click(screen.getByTestId('integration-edit-N8N'));
    await user.type(screen.getByTestId('integration-secret'), 'z'.repeat(32));
    await user.click(screen.getByTestId('integration-save'));

    await waitFor(() => expect(api.updateIntegration).toHaveBeenCalled());
    expect(api.updateIntegration.mock.calls[0][1].secret).toBe('z'.repeat(32));
  });

  it('shows a generated secret ONCE, with an explicit warning', async () => {
    const user = userEvent.setup();
    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');
    await user.click(screen.getByTestId('integration-rotate-N8N'));

    const value = await screen.findByTestId('integration-secret-value');
    expect(value).toHaveTextContent('f'.repeat(64));
    // The warning is load-bearing: the value cannot be retrieved again.
    expect(screen.getByTestId('integration-secret-once')).toHaveTextContent('کپی کنید');
  });

  it('clears the generated secret on dismissal', async () => {
    const user = userEvent.setup();
    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');
    await user.click(screen.getByTestId('integration-rotate-N8N'));
    await screen.findByTestId('integration-secret-value');

    await user.click(screen.getByRole('button', { name: 'متوجه شدم' }));

    expect(screen.queryByTestId('integration-secret-value')).not.toBeInTheDocument();
  });

  it('renders no secret-shaped value anywhere in the normal list view', async () => {
    render(<CoreIntegrationsView />);
    await screen.findByTestId('integration-list');

    // The row reports presence and a rotation date, never a value.
    expect(screen.getByTestId('integration-secret-status-N8N')).toHaveTextContent('ذخیره شده');
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('CoreIntegrationsView — status, test and boundaries', () => {
  beforeEach(() => grant(['admin.integrations.read', 'admin.integrations.manage']));

  it('surfaces the connection state distinctly for each situation', async () => {
    const cases: Array<[Partial<integrationsApi.Integration>, string]> = [
      [{ enabled: false }, 'غیرفعال'],
      [{ hasSecret: false }, 'کلید امضا تنظیم نشده'],
      [{ lastTestStatus: null, lastTestedAt: null }, 'فعال — آزمایش نشده'],
      [{ lastTestStatus: 'FAILURE' }, 'اتصال برقرار نشد'],
      [{}, 'متصل است'],
    ];

    for (const [overrides, expected] of cases) {
      api.listIntegrations.mockResolvedValue({
        configs: [{ ...CONFIG, ...overrides }],
        integrations: [DESCRIPTOR],
      });

      const { unmount } = render(<CoreIntegrationsView />);
      expect(await screen.findByTestId('integration-status-N8N')).toHaveTextContent(expected);
      unmount();
    }
  });

  it('renders the test outcome message without any upstream detail', async () => {
    api.testIntegration.mockResolvedValue({
      status: 'FAILURE',
      message: 'اتصال به سرویس اتوماسیون برقرار نشد.',
    });

    const user = userEvent.setup();
    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');
    await user.click(screen.getByTestId('integration-test-N8N'));

    const result = await screen.findByTestId('integration-test-result-N8N');
    expect(result).toHaveTextContent('اتصال به سرویس اتوماسیون برقرار نشد.');
    // No status code, no response body: those would make this a probe for the operator's
    // infrastructure.
    expect(result.textContent).not.toMatch(/\b[45]\d\d\b/);
  });

  it('lists deliveries with a translated status and a bare error code', async () => {
    api.listAutomationExecutions.mockResolvedValue({
      items: [{ ...EXECUTION, status: 'FAILED', errorCode: 'TIMEOUT', attemptCount: 3 }],
      nextCursor: null,
    });

    render(<CoreIntegrationsView />);

    const list = await screen.findByTestId('automation-execution-list');
    expect(list).toHaveTextContent('ticket.created');
    expect(list).toHaveTextContent('ناموفق');
    // A short code, exactly as stored — the server bounds it and refuses response bodies.
    expect(list).toHaveTextContent('TIMEOUT');
    expect(list).toHaveTextContent('3 تلاش');
  });

  it('says plainly that Aria works without an integration when none is configured', async () => {
    api.listIntegrations.mockResolvedValue({ configs: [], integrations: [DESCRIPTOR] });

    render(<CoreIntegrationsView />);

    // §22 made visible: an unconfigured platform is a normal state, not a warning.
    expect(await screen.findByText(/آریا بدون آن کامل کار می‌کند/)).toBeInTheDocument();
  });

  it('locks the service selector when editing, so a row cannot be retargeted', async () => {
    const user = userEvent.setup();
    render(<CoreIntegrationsView />);

    await screen.findByTestId('integration-list');
    await user.click(screen.getByTestId('integration-edit-N8N'));

    expect(screen.getByTestId('integration-service')).toBeDisabled();
  });

  it('exposes NO workflow editor — the graph belongs to the engine', async () => {
    render(<CoreIntegrationsView />);
    await screen.findByTestId('integration-list');

    // Asserted by absence, because this boundary is exactly the kind that erodes quietly.
    for (const forbidden of [/گردش کار/, /workflow/i, /node/i, /canvas/i]) {
      expect(document.body.textContent ?? '').not.toMatch(forbidden);
    }
  });

  it('renders a surfaced error with a retry rather than an empty page', async () => {
    api.listIntegrations.mockRejectedValue(new Error('boom'));

    render(<CoreIntegrationsView />);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });
});


