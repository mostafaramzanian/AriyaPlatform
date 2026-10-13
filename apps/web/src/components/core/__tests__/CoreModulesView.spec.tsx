import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreModulesView } from '../CoreModulesView';
import * as modulesApi from '@/lib/modules-api';
import { useCorePermissions } from '../useCorePermissions';

/**
 * Phase 49M §28/§29/§30/§44: the module registry surface.
 *
 * WHAT THIS FILE IS DEFENDING, in order of weight:
 *
 *  1. THE CREDENTIAL IS NEVER RENDERED FROM A READ. The rendered document is asserted not to contain
 *     a credential-shaped value for a module that HAS one stored. This is the UI half of the
 *     containment guarantee; the server half is in the service spec.
 *  2. THERE IS NO ENDPOINT INPUT. Asserted by absence, because "an administrator cannot type a URL"
 *     is exactly the §40 boundary that erodes silently — and because a `baseUrl` field appearing here
 *     later would re-open the confused-deputy surface.
 *  3. HEALTH IS NEVER COLOUR ALONE (§30). The Persian state label is asserted present in the DOM.
 *  4. READ-ONLY CALLERS SEE NO WRITE AFFORDANCES, and a caller with neither permission sees the
 *     forbidden state rather than an empty page.
 *  5. THE UI DOES NOT BRANCH ON DEPLOYMENT MODE. A LOCAL row and a REMOTE row are asserted to render
 *     the same controls — the §35 guarantee, visible.
 */

jest.mock('@/lib/modules-api');
jest.mock('../useCorePermissions');

const api = modulesApi as jest.Mocked<typeof modulesApi>;
const permissionsMock = useCorePermissions as jest.MockedFunction<typeof useCorePermissions>;
const actual = jest.requireActual('@/lib/modules-api');

const INSTANCE: modulesApi.ModuleInstance = {
  id: 'inst-1',
  instanceId: 'finance-prod-01',
  moduleId: 'finance',
  deploymentMode: 'REMOTE',
  version: '1.2.0',
  baseUrl: 'https://finance.example.com',
  healthPath: '/health',
  capabilities: ['invoice.read'],
  apiContracts: ['module.invoke@v1'],
  eventContracts: [],
  lifecycle: 'ACTIVE',
  health: 'HEALTHY',
  healthErrorCode: null,
  lastSeenAt: '2026-09-05T00:00:00.000Z',
  lastProbedAt: null,
  stale: false,
  createdAt: '2026-09-05T00:00:00.000Z',
};

const MODULE: modulesApi.ModuleRegistration = {
  id: '11111111-1111-4111-8111-111111111111',
  moduleId: 'finance',
  displayName: 'Finance',
  moduleType: 'BUSINESS',
  enabled: true,
  tenantScope: 'ALL',
  tenantIds: [],
  protocolVersion: 1,
  hasCredential: true,
  credentialUpdatedAt: '2026-09-05T00:00:00.000Z',
  credentialExpiresAt: null,
  derivedLifecycle: 'ACTIVE',
  aggregateHealth: 'HEALTHY',
  instances: [INSTANCE],
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};

const PLATFORM: modulesApi.ModulePlatformDescriptor = {
  protocolVersion: 1,
  baseContract: 'module.invoke@v1',
  heartbeatIntervalMs: 30_000,
  staleAfterMs: 90_000,
  foundations: {
    conflictPolicies: ['OWNER_WINS'],
    defaultConflictPolicy: 'OWNER_WINS',
    provisioningSteps: ['REGISTER', 'AUTHENTICATE', 'VERIFY', 'ACTIVATE'],
    syncImplemented: false,
    provisioningImplemented: false,
  },
};

/** Phase 54-C (§43.8): one declared feature, and one grant, as the admin routes project them. */
const FEATURE: modulesApi.ModuleFeatureSummary = {
  id: 'feature-row-1',
  moduleId: 'finance',
  featureId: 'leave',
  displayName: 'Leave',
  enabled: true,
  grantedTenantCount: 1,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
};

/**
 * Phase 54-C closure fix (§43.8): the EFFECTIVE-STATE page, which is the ONLY source of per-tenant
 * entitlement in this console.
 *
 * The spec used to stub `listModuleFeatureTenants` and two arrays of tenant ids, because the view
 * derived the four states in the browser. It does not any more: the server answers per tenant and the
 * view prints the answer. So the fixture is a page, with `effective`/`reasonCode` as the SERVER would
 * project them — including `RESTRICTED_MEMBERS`, the scope whose membership the browser cannot see and
 * which is the whole reason the derivation was removed.
 */
const stateRow = (
  tenantId: string,
  effective: modulesApi.ModuleFeatureEffectiveState,
  reasonCode: 'ALLOWED' | modulesApi.EntitlementFailureCode,
  granted = false
): modulesApi.ModuleFeatureTenantState => ({
  tenantId,
  granted,
  grantedAt: granted ? '2026-09-05T00:00:00.000Z' : null,
  effective,
  reasonCode,
});

const STATE_PAGE: modulesApi.ModuleFeatureStatePage = {
  moduleId: 'finance',
  featureId: 'leave',
  moduleEnabled: true,
  featureEnabled: true,
  tenantScope: 'RESTRICTED',
  tenantCount: 2,
  rows: [
    // Granted AND entitled — the row a read of the grants alone would have shown as merely "granted".
    stateRow('tenant-1', 'ENTITLED', 'ALLOWED', true),
    // In the module's scope, no grant: the distinction §43.8 exists to draw.
    stateRow('tenant-2', 'NOT_GRANTED', 'FEATURE_NOT_GRANTED'),
  ],
  nextCursor: null,
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

  // The real helpers are pure; only the network functions are stubbed, so the labels under test are
  // the ones the component actually ships with — the same approach the 49L view spec uses.
  api.moduleStatusLabel.mockImplementation(actual.moduleStatusLabel);
  api.credentialStatusLabel.mockImplementation(actual.credentialStatusLabel);
  api.tenantScopeLabel.mockImplementation(actual.tenantScopeLabel);
  api.formatModuleTime.mockImplementation(actual.formatModuleTime);
  api.healthErrorLabel.mockImplementation(actual.healthErrorLabel);
  api.isValidModuleId.mockImplementation(actual.isValidModuleId);
  api.isValidFeatureId.mockImplementation(actual.isValidFeatureId);
  api.parseTenantIdList.mockImplementation(actual.parseTenantIdList);

  for (const key of [
    'DEPLOYMENT_MODE_LABELS',
    'MODULE_TYPE_LABELS',
    'LIFECYCLE_LABELS',
    'HEALTH_PRESENTATION',
    'MAX_DISPLAY_NAME_LENGTH',
    'FEATURE_EFFECTIVE_STATE_PRESENTATION',
    'MAX_FEATURE_GRANT_TENANTS',
    'MAX_TENANT_ID_LENGTH',
  ]) {
    (api as unknown as Record<string, unknown>)[key] = actual[key];
  }

  api.listModules.mockResolvedValue([MODULE]);
  api.getModulePlatform.mockResolvedValue(PLATFORM);
  api.createModule.mockResolvedValue(MODULE);
  api.updateModule.mockResolvedValue(MODULE);
  api.deleteModule.mockResolvedValue({ id: MODULE.id, deleted: true });
  api.rotateModuleCredential.mockResolvedValue({ secret: 'f'.repeat(64) });
  api.testModuleInstance.mockResolvedValue({
    registryKnown: true,
    endpointReachable: true,
    applicationHealthy: true,
    state: 'HEALTHY',
  });

  // Phase 54-C (§43.8): one declared feature, and the effective-state PAGE the tenant panel prints.
  api.listModuleFeatures.mockResolvedValue([FEATURE]);
  api.fetchModuleFeatureStates.mockResolvedValue(STATE_PAGE);
  api.declareModuleFeature.mockResolvedValue(FEATURE);
  api.updateModuleFeature.mockResolvedValue(FEATURE);
  api.grantModuleFeature.mockResolvedValue({ granted: 1 });
  api.revokeModuleFeature.mockResolvedValue({ revoked: true });
});

describe('CoreModulesView — authorization', () => {
  it('renders the forbidden state for a caller with neither permission', async () => {
    grant([]);

    render(<CoreModulesView />);

    expect(await screen.findByText('شما به این بخش دسترسی ندارید.')).toBeInTheDocument();
    // Not even a read is attempted: the gate is checked before the effect fetches.
    expect(api.listModules).not.toHaveBeenCalled();
  });

  it('shows the registry but NO write affordances to a read-only caller', async () => {
    grant(['admin.modules.read']);

    render(<CoreModulesView />);

    expect(await screen.findByText(/Finance/)).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'ثبت ماژول جدید' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /غیرفعال کردن/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /صدور کلید جدید/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /آزمایش اتصال/ })).not.toBeInTheDocument();
  });

  it('shows write affordances to a manager', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);

    expect(await screen.findByRole('button', { name: 'ثبت ماژول جدید' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /صدور کلید جدید/ })).toBeInTheDocument();
  });
});

describe('CoreModulesView — the credential boundary', () => {
  it('renders NO credential value for a module that has one stored', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    const { container } = render(<CoreModulesView />);

    await screen.findByText(/Finance/);

    // Presence is shown; the value does not exist client-side to show.
    expect(screen.getByText(/کلید دسترسی: صادر شده/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[0-9a-f]{32}/);
  });

  it('shows a generated credential ONCE, after rotation', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);

    await userEvent.click(await screen.findByRole('button', { name: /صدور کلید جدید/ }));

    await waitFor(() => expect(api.rotateModuleCredential).toHaveBeenCalledWith(MODULE.id));
    expect(await screen.findByText(new RegExp('f'.repeat(64)))).toBeInTheDocument();
  });
});

describe('CoreModulesView — §40 boundaries', () => {
  it('offers NO endpoint field in the registration form', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);

    await userEvent.click(await screen.findByRole('button', { name: 'ثبت ماژول جدید' }));

    const form = screen.getByRole('form', { name: 'ثبت ماژول جدید' });

    // The form has an id, a name, a type and a tenant scope — and deliberately no URL of any kind.
    expect(form.querySelector('input[name="moduleId"]')).not.toBeNull();
    expect(form.querySelector('input[name="displayName"]')).not.toBeNull();
    expect(form.querySelector('input[name="baseUrl"]')).toBeNull();
    expect(form.querySelector('input[name="url"]')).toBeNull();
    expect(form.querySelector('input[name="healthPath"]')).toBeNull();
    expect(form.querySelector('input[name="version"]')).toBeNull();
  });

  it('refuses an invalid module id locally, without a request', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);

    await userEvent.click(await screen.findByRole('button', { name: 'ثبت ماژول جدید' }));

    const form = screen.getByRole('form', { name: 'ثبت ماژول جدید' });
    await userEvent.type(form.querySelector('input[name="moduleId"]')!, 'Not A Slug');
    await userEvent.type(form.querySelector('input[name="displayName"]')!, 'Something');
    await userEvent.click(screen.getByRole('button', { name: 'ثبت ماژول' }));

    expect(await screen.findByText(/شناسه ماژول باید/)).toBeInTheDocument();
    expect(api.createModule).not.toHaveBeenCalled();
  });
});

describe('CoreModulesView — health presentation (§30)', () => {
  it('renders the health STATE AS TEXT, not only as a colour', async () => {
    grant(['admin.modules.read']);

    render(<CoreModulesView />);

    // The Persian label is what a screen reader and a colour-blind operator read.
    expect(await screen.findAllByText('سالم')).not.toHaveLength(0);
  });

  it('surfaces a stale instance as unavailable even when its last report was healthy', async () => {
    api.listModules.mockResolvedValue([
      {
        ...MODULE,
        aggregateHealth: 'UNAVAILABLE',
        instances: [{ ...INSTANCE, health: 'HEALTHY', stale: true }],
      },
    ]);

    grant(['admin.modules.read']);

    render(<CoreModulesView />);

    expect(await screen.findAllByText('در دسترس نیست')).not.toHaveLength(0);
    // The instance line itself says so, not only the aggregate badge. Matched with the separator so
    // the platform descriptor's "آستانه بی‌پاسخی" heading is not what satisfies this.
    expect(screen.getByText(/· بی‌پاسخ/)).toBeInTheDocument();
  });

  it('explains a health error code in words', async () => {
    api.listModules.mockResolvedValue([
      {
        ...MODULE,
        aggregateHealth: 'DEGRADED',
        instances: [{ ...INSTANCE, health: 'DEGRADED', healthErrorCode: 'NO_HEALTH_STATE' }],
      },
    ]);

    grant(['admin.modules.read']);

    render(<CoreModulesView />);

    expect(
      await screen.findByText('سرویس پاسخ داد اما وضعیت سلامت را اعلام نکرد.')
    ).toBeInTheDocument();
  });
});

describe('CoreModulesView — deployment neutrality (§35)', () => {
  it('renders the SAME controls for a LOCAL and a REMOTE instance', async () => {
    api.listModules.mockResolvedValue([
      {
        ...MODULE,
        instances: [
          { ...INSTANCE, instanceId: 'mod-local-01', deploymentMode: 'LOCAL', baseUrl: null },
          { ...INSTANCE, id: 'inst-2', instanceId: 'mod-remote-01', deploymentMode: 'REMOTE' },
        ],
      },
    ]);

    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);

    await screen.findByText(/Finance/);

    // Both instances render, both get a probe button: nothing in the UI branches on the mode.
    expect(screen.getByText('mod-local-01')).toBeInTheDocument();
    expect(screen.getByText('mod-remote-01')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /آزمایش اتصال/ })).toHaveLength(2);

    // The mode is DISPLAYED, which is the only thing it is allowed to affect.
    expect(screen.getByText(/محلی/)).toBeInTheDocument();
    expect(screen.getByText(/راه دور/)).toBeInTheDocument();
  });

  it('probes by instance id, never by a URL', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);

    await userEvent.click(await screen.findByRole('button', { name: /آزمایش اتصال/ }));

    await waitFor(() =>
      expect(api.testModuleInstance).toHaveBeenCalledWith(MODULE.id, 'finance-prod-01')
    );
  });
});

describe('CoreModulesView — states', () => {
  it('renders an empty state rather than a blank page', async () => {
    api.listModules.mockResolvedValue([]);
    grant(['admin.modules.read']);

    render(<CoreModulesView />);

    expect(await screen.findByText('هیچ ماژولی ثبت نشده است.')).toBeInTheDocument();
  });

  it('tells the operator when a module has never announced an instance', async () => {
    api.listModules.mockResolvedValue([
      { ...MODULE, instances: [], derivedLifecycle: 'DISCOVERED', aggregateHealth: 'UNKNOWN' },
    ]);

    grant(['admin.modules.read']);

    render(<CoreModulesView />);

    expect(
      await screen.findByText('هنوز هیچ نمونه‌ای از این ماژول خودش را ثبت نکرده است.')
    ).toBeInTheDocument();
  });

  it('reads the platform descriptor from the server rather than hard-coding it', async () => {
    grant(['admin.modules.read']);

    render(<CoreModulesView />);

    await screen.findByText(/Finance/);

    expect(api.getModulePlatform).toHaveBeenCalledTimes(1);
    expect(screen.getByText('module.invoke@v1')).toBeInTheDocument();
  });
});

/**
 * Phase 54-C (§43.8): the FEATURES section.
 *
 * WHAT THIS FILE DEFENDS, in the same order of weight the rest of the spec uses:
 *
 *  1. THE REFUSAL IS EXPLAINED, NOT NAMED. Each of the four states §43.8 asks for is rendered as the
 *     Persian sentence from the presentation record, so an operator reads WHY a tenant is refused —
 *     and a module-level refusal is named as the module's even when a grant exists.
 *  2. A READ-ONLY CALLER GETS NO WRITE AFFORDANCE. The section is readable with the read code alone;
 *     declaring, offering, renaming, granting and revoking all need the manage code.
 *  3. THE FORM REFUSES LOCALLY. A bad feature id and an over-long grant are messages rather than
 *     round trips, against the same rules the DTO and the SQL CHECK enforce.
 *  4. THE GRANT BODY IS NORMALISED, not passed through: duplicates collapse, so one call cannot ask
 *     for the same row twice.
 */
describe('CoreModulesView — feature entitlement (§43.8)', () => {
  const presentation = actual.FEATURE_EFFECTIVE_STATE_PRESENTATION;

  /** Opens the features section of the single module row. */
  const openFeatures = async () => {
    await userEvent.click(await screen.findByRole('button', { name: /^قابلیت/ }));
  };

  it('reads the features lazily, and shows a read-only caller no write affordance', async () => {
    grant(['admin.modules.read']);

    render(<CoreModulesView />);
    await screen.findByText(/Finance/);

    // Lazily: nothing is asked for until the operator opens the section.
    expect(api.listModuleFeatures).not.toHaveBeenCalled();

    await openFeatures();

    expect(api.listModuleFeatures).toHaveBeenCalledWith('finance');
    expect(await screen.findByText('leave')).toBeInTheDocument();

    expect(screen.queryByRole('button', { name: 'اعلام قابلیت جدید' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ارائه/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ویرایش نام' })).not.toBeInTheDocument();

    // The tenant READ is still available to the read code, and the revoke is not.
    await userEvent.click(await screen.findByRole('button', { name: /مستأجر/ }));
    expect(await screen.findByText('tenant-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^لغو مجوز/ })).not.toBeInTheDocument();
  });

  it('turns the platform OFFER off through the manage route', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);
    await openFeatures();
    await screen.findByText('leave');

    await userEvent.click(screen.getByRole('button', { name: /ارائه/ }));

    await waitFor(() =>
      expect(api.updateModuleFeature).toHaveBeenCalledWith('finance', 'leave', { enabled: false })
    );
  });

  it('names the MODULE as the refusal even when the tenant holds a grant', async () => {
    api.listModules.mockResolvedValue([{ ...MODULE, enabled: false }]);
    // The refusal is the SERVER's: the module is off, so the page says BLOCKED_BY_MODULE for a tenant
    // that still holds a grant. The view has no rule of its own to disagree with it.
    api.fetchModuleFeatureStates.mockResolvedValue({
      ...STATE_PAGE,
      moduleEnabled: false,
      rows: [stateRow('tenant-1', 'BLOCKED_BY_MODULE', 'MODULE_DISABLED', true)],
    });

    grant(['admin.modules.read']);

    render(<CoreModulesView />);
    await openFeatures();
    await screen.findByText('leave');
    await userEvent.click(screen.getByRole('button', { name: /مستأجر/ }));

    // tenant-1 IS granted and is still refused — by the module. Rendering "granted" here would be the
    // lie this derivation exists to prevent.
    expect(await screen.findByText(presentation.BLOCKED_BY_MODULE.label)).toBeInTheDocument();
    expect(screen.queryByText(presentation.ENTITLED.label)).not.toBeInTheDocument();
  });

  it('separates "not granted" from "blocked by the feature", per tenant', async () => {
    api.listModules.mockResolvedValue([
      { ...MODULE, tenantScope: 'RESTRICTED', tenantIds: ['tenant-1', 'tenant-2'] },
    ]);

    grant(['admin.modules.read']);

    render(<CoreModulesView />);
    await openFeatures();
    await screen.findByText('leave');
    await userEvent.click(screen.getByRole('button', { name: /مستأجر/ }));

    expect(await screen.findByText(presentation.ENTITLED.label)).toBeInTheDocument();
    expect(screen.getByText(presentation.NOT_GRANTED.label)).toBeInTheDocument();
    expect(screen.queryByText(presentation.BLOCKED_BY_FEATURE.label)).not.toBeInTheDocument();
  });

  it('says the PLATFORM does not offer the feature, for a tenant that holds a grant', async () => {
    api.listModuleFeatures.mockResolvedValue([{ ...FEATURE, enabled: false }]);
    // Again the server's answer: the module offers Leave, the PLATFORM does not, so a granted tenant is
    // refused by the feature rather than by the module — the third membership scope's case, which the
    // browser could never decide because it cannot see the membership table.
    api.fetchModuleFeatureStates.mockResolvedValue({
      ...STATE_PAGE,
      featureEnabled: false,
      rows: [stateRow('tenant-1', 'BLOCKED_BY_FEATURE', 'FEATURE_DISABLED', true)],
    });

    grant(['admin.modules.read']);

    render(<CoreModulesView />);
    await openFeatures();
    await screen.findByText('leave');
    await userEvent.click(screen.getByRole('button', { name: /مستأجر/ }));

    expect(await screen.findByText(presentation.BLOCKED_BY_FEATURE.label)).toBeInTheDocument();
    expect(screen.queryByText(presentation.ENTITLED.label)).not.toBeInTheDocument();
  });

  it('refuses an invalid feature id locally, without a request', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);
    await openFeatures();
    await screen.findByText('leave');

    await userEvent.click(screen.getByRole('button', { name: 'اعلام قابلیت جدید' }));

    const form = screen.getByRole('form', { name: 'اعلام قابلیت جدید' });
    await userEvent.type(form.querySelector('input[name="featureId"]')!, 'Leave');
    await userEvent.type(form.querySelector('input[name="featureDisplayName"]')!, 'Leaves');
    await userEvent.click(screen.getByRole('button', { name: 'اعلام قابلیت' }));

    // The same slug rule the DTO and the SQL CHECK enforce, refused here instead of through a 422.
    expect(await screen.findByText(/شناسه قابلیت باید/)).toBeInTheDocument();
    expect(api.declareModuleFeature).not.toHaveBeenCalled();
  });

  it('refuses a grant that names more tenants than one call may carry', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);
    await openFeatures();
    await screen.findByText('leave');
    await userEvent.click(screen.getByRole('button', { name: /مستأجر/ }));

    const form = await screen.findByRole('form', { name: 'ثبت مجوز leave' });
    // 65 distinct ids: one more than the route accepts, which is one more than the form accepts.
    fireEvent.change(form.querySelector('textarea[name="grantTenantIds-leave"]')!, {
      target: { value: Array.from({ length: 65 }, (_, index) => `tenant-${index}`).join(', ') },
    });
    await userEvent.click(screen.getByRole('button', { name: 'ثبت مجوز' }));

    expect(await screen.findByText(/حداکثر 64 مستأجر/)).toBeInTheDocument();
    expect(api.grantModuleFeature).not.toHaveBeenCalled();
  });

  it('sends a grant NORMALISED: duplicates collapse, blanks drop', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);
    await openFeatures();
    await screen.findByText('leave');
    await userEvent.click(screen.getByRole('button', { name: /مستأجر/ }));

    const form = await screen.findByRole('form', { name: 'ثبت مجوز leave' });
    fireEvent.change(form.querySelector('textarea[name="grantTenantIds-leave"]')!, {
      target: { value: 'tenant-a, tenant-a، tenant-b\n' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'ثبت مجوز' }));

    await waitFor(() =>
      expect(api.grantModuleFeature).toHaveBeenCalledWith('finance', 'leave', [
        'tenant-a',
        'tenant-b',
      ])
    );
  });

  it('revokes exactly the tenant row it names', async () => {
    grant(['admin.modules.read', 'admin.modules.manage']);

    render(<CoreModulesView />);
    await openFeatures();
    await screen.findByText('leave');
    await userEvent.click(screen.getByRole('button', { name: /مستأجر/ }));

    await userEvent.click(await screen.findByRole('button', { name: 'لغو مجوز tenant-1' }));

    await waitFor(() =>
      expect(api.revokeModuleFeature).toHaveBeenCalledWith('finance', 'leave', 'tenant-1')
    );
  });
});
