import {
  aiCapabilityLabel,
  aiProviderLabel,
  configurableCapabilities,
  credentialStatusLabel,
  formatAITime,
  providersForCapability,
  supportsCapability,
  unsupportedCapabilityReason,
  type AIProviderDescriptor,
} from '../ai-api';
import { coreDelete, coreGet, corePatch, corePost } from '../core-http';

/**
 * Phase 49J-0 coverage for the AI provider configuration client.
 *
 * The invariant being protected: THE CLIENT NEVER HANDLES A CREDENTIAL IT WAS NOT GIVEN.
 * The response type has no credential field, the read helpers are asserted not to invent
 * one, and `credentialStatusLabel` is asserted to report presence only.
 *
 * The second invariant: THE CAPABILITY MATRIX IS THE SERVER'S. Every helper below is
 * driven by the `providers` payload, so there is no local list that could keep offering a
 * withdrawn capability.
 */

jest.mock('../core-http', () => ({
  coreGet: jest.fn(),
  corePost: jest.fn(),
  corePatch: jest.fn(),
  coreDelete: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const postMock = corePost as jest.MockedFunction<typeof corePost>;
const patchMock = corePatch as jest.MockedFunction<typeof corePatch>;
const deleteMock = coreDelete as jest.MockedFunction<typeof coreDelete>;

/** The real registry shape: OPENAI does embeddings, nothing else does anything. */
const PROVIDERS: AIProviderDescriptor[] = [
  {
    key: 'OPENAI',
    displayName: 'OpenAI',
    capabilities: ['EMBEDDING'],
    unsupportedReason: { TEXT_GENERATION: 'تولید متن در این فاز پیاده‌سازی نشده است.' },
  },
  {
    key: 'AZURE_OPENAI',
    displayName: 'Azure OpenAI',
    capabilities: [],
    unsupportedReason: {
      EMBEDDING: 'این ارائه‌دهنده هنوز پیاده‌سازی نشده است.',
      TEXT_GENERATION: 'این ارائه‌دهنده هنوز پیاده‌سازی نشده است.',
    },
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
  {
    key: 'LOCAL',
    displayName: 'مدل محلی',
    capabilities: [],
    unsupportedReason: {
      EMBEDDING: 'این ارائه‌دهنده هنوز پیاده‌سازی نشده است.',
      TEXT_GENERATION: 'این ارائه‌دهنده هنوز پیاده‌سازی نشده است.',
    },
  },
];

const CONFIG = {
  id: 'cfg-1',
  provider: 'OPENAI' as const,
  capability: 'EMBEDDING' as const,
  modelName: 'text-embedding-3-small',
  baseUrl: null,
  enabled: true,
  isDefault: true,
  hasCredential: true,
  credentialUpdatedAt: '2026-01-01T09:00:00.000Z',
  createdAt: '2026-01-01T09:00:00.000Z',
  updatedAt: '2026-01-01T09:00:00.000Z',
};

describe('ai-api — request paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getMock.mockResolvedValue({} as never);
    postMock.mockResolvedValue({} as never);
    patchMock.mockResolvedValue({} as never);
    deleteMock.mockResolvedValue({} as never);
  });

  it('reads the list from the admin route', async () => {
    const { listAIProviderConfigs } = await import('../ai-api');
    getMock.mockResolvedValueOnce({ configs: [CONFIG], providers: PROVIDERS } as never);

    const result = await listAIProviderConfigs();

    expect(getMock).toHaveBeenCalledWith('/admin/ai/providers');
    expect(result.configs).toHaveLength(1);
    expect(result.providers).toHaveLength(4);
  });

  it('normalises a malformed list body to empty arrays instead of throwing', async () => {
    const { listAIProviderConfigs } = await import('../ai-api');
    getMock.mockResolvedValueOnce(null as never);

    await expect(listAIProviderConfigs()).resolves.toEqual({ configs: [], providers: [] });
  });

  it('never surfaces a credential field', async () => {
    const { listAIProviderConfigs } = await import('../ai-api');
    getMock.mockResolvedValueOnce({ configs: [CONFIG], providers: [] } as never);

    const [config] = (await listAIProviderConfigs()).configs;

    expect(config).not.toHaveProperty('credential');
    expect(config).not.toHaveProperty('credentialCiphertext');
    expect(config.hasCredential).toBe(true);
  });

  it('reads one row by encoded id', async () => {
    const { getAIProviderConfig } = await import('../ai-api');
    await getAIProviderConfig('a/b?c');

    expect(getMock).toHaveBeenCalledWith('/admin/ai/providers/a%2Fb%3Fc');
  });

  it('sends the create payload untouched, with no tenantId or timestamp', async () => {
    const { createAIProviderConfig } = await import('../ai-api');
    await createAIProviderConfig({
      provider: 'OPENAI',
      capability: 'EMBEDDING',
      modelName: 'text-embedding-3-small',
      credential: 'sk-secret',
      enabled: true,
      isDefault: true,
    });

    const [path, payload] = postMock.mock.calls[0];

    expect(path).toBe('/admin/ai/providers');
    expect(payload).toEqual({
      provider: 'OPENAI',
      capability: 'EMBEDDING',
      modelName: 'text-embedding-3-small',
      credential: 'sk-secret',
      enabled: true,
      isDefault: true,
    });
    // `forbidNonWhitelisted` would 400 on any of these.
    expect(payload).not.toHaveProperty('tenantId');
    expect(payload).not.toHaveProperty('credentialUpdatedAt');
    expect(payload).not.toHaveProperty('id');
  });

  it('patches a row by id', async () => {
    const { updateAIProviderConfig } = await import('../ai-api');
    await updateAIProviderConfig('cfg-1', { isDefault: true, enabled: true });

    expect(patchMock).toHaveBeenCalledWith('/admin/ai/providers/cfg-1', {
      isDefault: true,
      enabled: true,
    });
  });

  it('deletes a row by id with no body', async () => {
    const { deleteAIProviderConfig } = await import('../ai-api');
    await deleteAIProviderConfig('cfg-1');

    expect(deleteMock).toHaveBeenCalledWith('/admin/ai/providers/cfg-1');
  });

  it('posts the test with a submitted credential when one is given', async () => {
    const { testAIProviderConnection } = await import('../ai-api');
    await testAIProviderConnection('cfg-1', 'sk-unsaved');

    expect(postMock).toHaveBeenCalledWith('/admin/ai/providers/cfg-1/test', {
      credential: 'sk-unsaved',
    });
  });

  it('posts an EMPTY body when no credential is given, so the stored key is used', async () => {
    const { testAIProviderConnection } = await import('../ai-api');
    await testAIProviderConnection('cfg-1');

    const [path, payload] = postMock.mock.calls[0];

    expect(path).toBe('/admin/ai/providers/cfg-1/test');
    expect(payload).toEqual({});
    // No probe text: the string is fixed server-side so this cannot proxy arbitrary content.
    expect(payload).not.toHaveProperty('text');
    expect(payload).not.toHaveProperty('credential');
  });

  it('returns a FAILURE result rather than rejecting, because the route answers 200', async () => {
    const { testAIProviderConnection } = await import('../ai-api');
    postMock.mockResolvedValueOnce({ status: 'FAILURE', message: 'اتصال برقرار نشد.' } as never);

    await expect(testAIProviderConnection('cfg-1')).resolves.toEqual({
      status: 'FAILURE',
      message: 'اتصال برقرار نشد.',
    });
  });
});

describe('ai-api — the capability matrix comes from the server', () => {
  it('reports declared support only', () => {
    expect(supportsCapability('OPENAI', 'EMBEDDING', PROVIDERS)).toBe(true);
    // The method exists on the class and throws; the matrix is what decides.
    expect(supportsCapability('OPENAI', 'TEXT_GENERATION', PROVIDERS)).toBe(false);
    expect(supportsCapability('ANTHROPIC', 'EMBEDDING', PROVIDERS)).toBe(false);
  });

  it('treats an empty matrix as "nothing is supported" rather than "everything is"', () => {
    expect(supportsCapability('OPENAI', 'EMBEDDING', [])).toBe(false);
    expect(configurableCapabilities([])).toEqual([]);
    expect(providersForCapability('EMBEDDING', [])).toEqual([]);
  });

  it('offers only capabilities some provider implements', () => {
    // Today that is EMBEDDING alone — TEXT_GENERATION is declared by nobody.
    expect(configurableCapabilities(PROVIDERS)).toEqual(['EMBEDDING']);
  });

  it('narrows the provider list to those capable of the capability', () => {
    expect(providersForCapability('EMBEDDING', PROVIDERS).map((p) => p.key)).toEqual(['OPENAI']);
    expect(providersForCapability('TEXT_GENERATION', PROVIDERS)).toEqual([]);
  });

  it('explains an unsupported pair and stays silent about a supported one', () => {
    expect(unsupportedCapabilityReason('ANTHROPIC', 'EMBEDDING', PROVIDERS)).toBe(
      'Anthropic مدل بردارسازی ارائه نمی‌کند.'
    );
    expect(unsupportedCapabilityReason('OPENAI', 'EMBEDDING', PROVIDERS)).toBeNull();
  });

  it('falls back to a generic reason for an unknown provider rather than returning null', () => {
    // Null would read as "supported" to a caller that only checks for a message.
    expect(unsupportedCapabilityReason('OPENAI', 'EMBEDDING', [])).toBe(
      'این قابلیت برای این ارائه‌دهنده پشتیبانی نمی‌شود.'
    );
  });

  it('labels a provider from the server matrix and falls back to the raw key', () => {
    expect(aiProviderLabel('OPENAI', PROVIDERS)).toBe('OpenAI');
    expect(aiProviderLabel('ANTHROPIC', PROVIDERS)).toBe('Anthropic Claude');
    // An unknown key is shown as-is, never as a blank cell.
    expect(aiProviderLabel('MISTRAL', PROVIDERS)).toBe('MISTRAL');
    expect(aiProviderLabel('OPENAI')).toBe('OPENAI');
  });

  it('labels both capabilities in Persian', () => {
    expect(aiCapabilityLabel('EMBEDDING')).toBe('بردارسازی متن (Embedding)');
    expect(aiCapabilityLabel('TEXT_GENERATION')).toBe('تولید متن');
  });
});

describe('ai-api — credential status reports presence only', () => {
  it('says "stored" with the rotation time when a key exists', () => {
    const label = credentialStatusLabel({
      hasCredential: true,
      credentialUpdatedAt: '2026-01-01T09:00:00.000Z',
    });

    expect(label).toContain('ذخیره شده');
    // A length or a prefix would leak; neither is available to leak.
    expect(label).not.toMatch(/sk-/);
    expect(label).not.toMatch(/\d+\s*کاراکتر/);
  });

  it('says "not stored" when no key exists', () => {
    expect(credentialStatusLabel({ hasCredential: false, credentialUpdatedAt: null })).toBe(
      'ذخیره نشده'
    );
  });

  it('still says "stored" when the timestamp is missing', () => {
    // The envelope columns are all-or-nothing in the DB, but a null timestamp must not
    // downgrade the answer to "no key".
    expect(credentialStatusLabel({ hasCredential: true, credentialUpdatedAt: null })).toBe(
      'ذخیره شده'
    );
  });
});

describe('ai-api — time formatting', () => {
  it('renders an ISO instant as a Persian date/time', () => {
    const formatted = formatAITime('2026-01-01T09:00:00.000Z');

    expect(formatted.length).toBeGreaterThan(0);
    expect(formatted).toMatch(/[۰-۹]/);
  });

  it('returns an empty string for null or malformed input instead of "Invalid Date"', () => {
    expect(formatAITime(null)).toBe('');
    expect(formatAITime('not-a-date')).toBe('');
  });
});
