import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CoreAIProvidersView } from '../CoreAIProvidersView';
import { CoreApiError } from '@/lib/core-http';
import { fetchMyRbac } from '@/lib/rbac-api';
import {
  createAIProviderConfig,
  deleteAIProviderConfig,
  listAIProviderConfigs,
  testAIProviderConnection,
  updateAIProviderConfig,
  type AIProviderConfig,
  type AIProviderDescriptor,
} from '@/lib/ai-api';

/**
 * Phase 49J-0 coverage for the AI provider configuration screen.
 *
 * WHAT THESE TESTS EXIST TO PROTECT:
 *
 * 1. NO CREDENTIAL IS EVER RENDERED OR REPLAYED. The key field is asserted empty on
 *    edit, and a whole-form resubmit is asserted to omit `credential` entirely — which
 *    is what makes "leave the stored key alone" the default.
 *
 * 2. THE PERMISSION SPLIT IS REAL. `admin.ai.read` alone renders the list with no write
 *    control, including no test button — a probe spends money, so it is write-class.
 *
 * 3. A FAILED PROBE IS A 200. The FAILURE branch is asserted to render as an error
 *    message rather than being swallowed by a success path.
 */

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/admin/ai',
}));

jest.mock('@/lib/rbac-api', () => ({ fetchMyRbac: jest.fn() }));

// SWC-compiled ES module exports are non-configurable, so the module is mocked rather
// than spied on. Every pure helper (labels, formatting, matrix queries) stays real.
jest.mock('@/lib/ai-api', () => ({
  ...jest.requireActual('@/lib/ai-api'),
  listAIProviderConfigs: jest.fn(),
  createAIProviderConfig: jest.fn(),
  updateAIProviderConfig: jest.fn(),
  deleteAIProviderConfig: jest.fn(),
  testAIProviderConnection: jest.fn(),
}));

const listMock = listAIProviderConfigs as jest.MockedFunction<typeof listAIProviderConfigs>;
const createMock = createAIProviderConfig as jest.MockedFunction<typeof createAIProviderConfig>;
const updateMock = updateAIProviderConfig as jest.MockedFunction<typeof updateAIProviderConfig>;
const deleteMock = deleteAIProviderConfig as jest.MockedFunction<typeof deleteAIProviderConfig>;
const testMock = testAIProviderConnection as jest.MockedFunction<typeof testAIProviderConnection>;
const rbacMock = fetchMyRbac as jest.MockedFunction<typeof fetchMyRbac>;

const READ = 'admin.ai.read';
const MANAGE = 'admin.ai.manage';

function rbac(permissions: string[]) {
  return { userId: 'u1', roles: [], permissions, highestRole: null };
}

/** The real registry shape: OPENAI does embeddings, nothing else does anything. */
const PROVIDERS: AIProviderDescriptor[] = [
  {
    key: 'OPENAI',
    displayName: 'OpenAI',
    capabilities: ['EMBEDDING'],
    unsupportedReason: { TEXT_GENERATION: 'تولید متن در این فاز پیاده‌سازی نشده است.' },
  },
  {
    key: 'ANTHROPIC',
    displayName: 'Anthropic Claude',
    capabilities: [],
    unsupportedReason: {
      EMBEDDING: 'Anthropic مدل بردارسازی ارائه نمی‌کند.',
      TEXT_GENERATION: 'تولید متن در این فاز پیاده‌سازی نشده است.',
    },
  },
];

function config(overrides: Partial<AIProviderConfig> = {}): AIProviderConfig {
  return {
    id: 'cfg-1',
    provider: 'OPENAI',
    capability: 'EMBEDDING',
    modelName: 'text-embedding-3-small',
    baseUrl: null,
    enabled: true,
    isDefault: true,
    hasCredential: true,
    credentialUpdatedAt: '2026-01-01T09:00:00.000Z',
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

describe('CoreAIProvidersView — permissions', () => {
  beforeEach(() => {
    rbacMock.mockResolvedValue(rbac([READ, MANAGE]));
    listMock.mockResolvedValue({ configs: [config()], providers: PROVIDERS });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('shows an accessible loading state while permissions resolve', () => {
    rbacMock.mockReturnValue(new Promise(() => undefined) as never);

    render(<CoreAIProvidersView />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByText('در حال بررسی دسترسی...')).toBeInTheDocument();
  });

  it('refuses the page without admin.ai.read and issues no request', async () => {
    rbacMock.mockResolvedValue(rbac([]));

    render(<CoreAIProvidersView />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'شما به تنظیمات هوش مصنوعی دسترسی ندارید.'
    );
    // A request would be a guaranteed 403.
    expect(listMock).not.toHaveBeenCalled();
  });

  it('renders the list read-only with admin.ai.read alone', async () => {
    rbacMock.mockResolvedValue(rbac([READ]));

    render(<CoreAIProvidersView />);

    await screen.findByTestId('ai-config-list');
    expect(screen.getByText('OpenAI')).toBeInTheDocument();

    // No write affordance of any kind, INCLUDING the test button: a probe spends money
    // on the operator's provider account, so it is gated on the write permission.
    expect(screen.queryByTestId('ai-create-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-edit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-test')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-promote')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-delete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ai-toggle-enabled')).not.toBeInTheDocument();
  });

  it('renders every write control with admin.ai.manage', async () => {
    render(<CoreAIProvidersView />);

    await screen.findByTestId('ai-config-list');

    expect(screen.getByTestId('ai-create-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('ai-edit')).toBeInTheDocument();
    expect(screen.getByTestId('ai-test')).toBeInTheDocument();
    expect(screen.getByTestId('ai-delete')).toBeInTheDocument();
  });

  it('surfaces a server 403 as the forbidden state', async () => {
    listMock.mockRejectedValue(new CoreApiError('forbidden', 403));

    render(<CoreAIProvidersView />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'شما به تنظیمات هوش مصنوعی دسترسی ندارید.'
    );
  });

  it('offers a retry on a non-403 failure', async () => {
    listMock.mockRejectedValueOnce(new CoreApiError('سرور پاسخ نداد.', 500));
    listMock.mockResolvedValueOnce({ configs: [config()], providers: PROVIDERS });

    render(<CoreAIProvidersView />);

    expect(await screen.findByText('سرور پاسخ نداد.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));

    expect(await screen.findByTestId('ai-config-list')).toBeInTheDocument();
  });
});

describe('CoreAIProvidersView — the credential is never rendered or replayed', () => {
  beforeEach(() => {
    rbacMock.mockResolvedValue(rbac([READ, MANAGE]));
    listMock.mockResolvedValue({ configs: [config()], providers: PROVIDERS });
    updateMock.mockResolvedValue(config());
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('reports credential presence and rotation time, never a key or its length', async () => {
    render(<CoreAIProvidersView />);

    const status = await screen.findByTestId('ai-credential-status');

    expect(status).toHaveTextContent('ذخیره شده');
    expect(status.textContent).not.toMatch(/sk-/);
    expect(status.textContent).not.toMatch(/\d+\s*کاراکتر/);
  });

  it('opens the edit form with an EMPTY key field', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-edit'));

    // Nothing to seed it from: the server has no projection that returns a credential.
    expect(await screen.findByTestId('ai-credential')).toHaveValue('');
    // The model IS seeded, so the empty key field is not merely an unpopulated form.
    expect(screen.getByTestId('ai-model')).toHaveValue('text-embedding-3-small');
  });

  it('omits `credential` entirely when the field is left empty', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-edit'));
    await screen.findByTestId('ai-form');
    await userEvent.click(screen.getByTestId('ai-save'));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());

    const [, payload] = updateMock.mock.calls[0];

    // An omitted credential means "leave the stored key untouched"; sending `''` or
    // `null` would either 400 or wipe a working key.
    expect(payload).not.toHaveProperty('credential');
    expect(payload).not.toHaveProperty('clearCredential');
    expect(payload.modelName).toBe('text-embedding-3-small');
  });

  it('sends a typed key as `credential`', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-edit'));
    await userEvent.type(await screen.findByTestId('ai-credential'), 'sk-rotated');
    await userEvent.click(screen.getByTestId('ai-save'));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());
    expect(updateMock.mock.calls[0][1].credential).toBe('sk-rotated');
  });

  it('sends `clearCredential` alone, never alongside a key', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-edit'));
    await userEvent.type(await screen.findByTestId('ai-credential'), 'sk-typed');
    // Ticking "remove" discards the typed value: the server refuses both together.
    await userEvent.click(screen.getByTestId('ai-clear-credential'));

    expect(screen.getByTestId('ai-credential')).toHaveValue('');

    await userEvent.click(screen.getByTestId('ai-save'));

    await waitFor(() => expect(updateMock).toHaveBeenCalled());

    const [, payload] = updateMock.mock.calls[0];
    expect(payload.clearCredential).toBe(true);
    expect(payload).not.toHaveProperty('credential');
  });

  it('masks the key input so it is not shoulder-readable and is not autofilled', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-edit'));
    const input = await screen.findByTestId('ai-credential');

    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'off');
  });
});

describe('CoreAIProvidersView — capability matrix and creation', () => {
  beforeEach(() => {
    rbacMock.mockResolvedValue(rbac([READ, MANAGE]));
    listMock.mockResolvedValue({
      configs: [config({ isDefault: false, enabled: false })],
      providers: PROVIDERS,
    });
    createMock.mockResolvedValue(config());
    updateMock.mockResolvedValue(config());
    deleteMock.mockResolvedValue({ id: 'cfg-1', deleted: true });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('offers only server-declared capabilities and only providers capable of them', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-create-toggle'));

    const capability = await screen.findByTestId('ai-capability');
    const provider = screen.getByTestId('ai-provider');

    // TEXT_GENERATION is declared by nobody, so it is not offerable at all.
    expect(capability).toHaveValue('EMBEDDING');
    expect(capability.querySelectorAll('option')).toHaveLength(1);

    // Claude cannot embed — and never will — so it is absent rather than disabled.
    expect(provider).toHaveValue('OPENAI');
    expect(provider.querySelectorAll('option')).toHaveLength(1);
  });

  it('says so plainly when no provider implements any capability', async () => {
    listMock.mockResolvedValue({ configs: [], providers: [] });

    render(<CoreAIProvidersView />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'در حال حاضر هیچ قابلیتی توسط ارائه‌دهندگان پیاده‌سازی‌شده پشتیبانی نمی‌شود.'
    );
    // With nothing configurable, the create control is withheld.
    expect(screen.queryByTestId('ai-create-toggle')).not.toBeInTheDocument();
  });

  it('states the env fallback in the empty state rather than implying AI is off', async () => {
    listMock.mockResolvedValue({ configs: [], providers: PROVIDERS });

    render(<CoreAIProvidersView />);

    expect(await screen.findByText(/تنظیمات محیطی سرور استفاده می‌شود/)).toBeInTheDocument();
  });

  it('creates a row with an explicit payload and no stray fields', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-create-toggle'));
    await userEvent.type(await screen.findByTestId('ai-model'), 'text-embedding-3-large');
    await userEvent.click(screen.getByTestId('ai-save'));

    await waitFor(() => expect(createMock).toHaveBeenCalled());

    const [payload] = createMock.mock.calls[0];

    expect(payload).toEqual({
      provider: 'OPENAI',
      capability: 'EMBEDDING',
      modelName: 'text-embedding-3-large',
      enabled: false,
      isDefault: false,
    });
    // `forbidNonWhitelisted` would reject either of these on a create.
    expect(payload).not.toHaveProperty('clearCredential');
    expect(payload).not.toHaveProperty('baseUrl');
  });

  it('refuses a default that is not enabled before any request is made', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-create-toggle'));
    await userEvent.type(await screen.findByTestId('ai-model'), 'text-embedding-3-small');

    // Ticking "default" ticks "enabled" too, because the DB CHECK requires it — so the
    // impossible pair has to be built by unticking enabled afterwards.
    await userEvent.click(screen.getByTestId('ai-default'));
    await userEvent.click(screen.getByTestId('ai-enabled'));
    await userEvent.click(screen.getByTestId('ai-save'));

    expect(await screen.findByTestId('ai-form-error')).toHaveTextContent(
      'ارائه‌دهنده پیش‌فرض باید فعال باشد.'
    );
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('CoreAIProvidersView — default promotion, enable/disable and delete', () => {
  beforeEach(() => {
    rbacMock.mockResolvedValue(rbac([READ, MANAGE]));
    listMock.mockResolvedValue({
      configs: [config({ isDefault: false, enabled: false })],
      providers: PROVIDERS,
    });
    updateMock.mockResolvedValue(config());
    deleteMock.mockResolvedValue({ id: 'cfg-1', deleted: true });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('promotes a row by sending isDefault with enabled, which the server requires', async () => {
    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-promote'));

    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith('cfg-1', { isDefault: true, enabled: true })
    );
  });

  it('hides the promote control for the row that is already the default', async () => {
    listMock.mockResolvedValue({ configs: [config()], providers: PROVIDERS });

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    // No demote control either: the server refuses to leave a capability with no
    // default, so the only way out is promoting a replacement.
    expect(screen.queryByTestId('ai-promote')).not.toBeInTheDocument();
    expect(screen.getByTestId('ai-default-badge')).toBeInTheDocument();
  });

  it('surfaces the 409 refusal when disabling the active default', async () => {
    listMock.mockResolvedValue({ configs: [config()], providers: PROVIDERS });
    updateMock.mockRejectedValue(
      new CoreApiError('This provider is the active default - promote another first', 409)
    );

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-toggle-enabled'));

    expect(await screen.findByTestId('ai-row-error')).toHaveTextContent('active default');
  });

  it('confirms before deleting and does nothing when the operator declines', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-delete'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('deletes once confirmed', async () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-delete'));

    await waitFor(() => expect(deleteMock).toHaveBeenCalledWith('cfg-1'));

    confirmSpy.mockRestore();
  });
});

describe('CoreAIProvidersView — connection test', () => {
  beforeEach(() => {
    rbacMock.mockResolvedValue(rbac([READ, MANAGE]));
    listMock.mockResolvedValue({ configs: [config()], providers: PROVIDERS });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('probes with the stored key from the row action, sending no credential', async () => {
    testMock.mockResolvedValue({
      status: 'SUCCESS',
      message: 'اتصال برقرار شد (بردار ۱۵۳۶ بعدی).',
    });

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-test'));

    await waitFor(() => expect(testMock).toHaveBeenCalledWith('cfg-1'));

    const result = await screen.findByTestId('ai-test-result');
    expect(result).toHaveAttribute('data-status', 'SUCCESS');
    expect(result).toHaveTextContent('اتصال برقرار شد');
  });

  it('renders a FAILURE as an error even though the route answered 200', async () => {
    testMock.mockResolvedValue({ status: 'FAILURE', message: 'اتصال به سرویس برقرار نشد.' });

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-test'));

    const result = await screen.findByTestId('ai-test-result');
    expect(result).toHaveAttribute('data-status', 'FAILURE');
    expect(result).toHaveTextContent('اتصال به سرویس برقرار نشد.');
  });

  it('verifies an unsaved key typed into the form before it is committed', async () => {
    testMock.mockResolvedValue({ status: 'SUCCESS', message: 'اتصال برقرار شد.' });

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-edit'));
    await userEvent.type(await screen.findByTestId('ai-credential'), 'sk-candidate');
    await userEvent.click(screen.getByTestId('ai-form-test'));

    await waitFor(() => expect(testMock).toHaveBeenCalledWith('cfg-1', 'sk-candidate'));
    // Verifying must not save: the row is only written by the save button.
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('falls back to the stored key when the form field is empty', async () => {
    testMock.mockResolvedValue({ status: 'SUCCESS', message: 'اتصال برقرار شد.' });

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-config-list');

    await userEvent.click(screen.getByTestId('ai-edit'));
    await screen.findByTestId('ai-form');
    await userEvent.click(screen.getByTestId('ai-form-test'));

    await waitFor(() => expect(testMock).toHaveBeenCalledWith('cfg-1', undefined));
  });

  it('offers no form-level test while creating, because there is no row to probe', async () => {
    listMock.mockResolvedValue({ configs: [], providers: PROVIDERS });

    render(<CoreAIProvidersView />);
    await screen.findByTestId('ai-create-toggle');

    await userEvent.click(screen.getByTestId('ai-create-toggle'));
    await screen.findByTestId('ai-form');

    expect(screen.queryByTestId('ai-form-test')).not.toBeInTheDocument();
  });
});
