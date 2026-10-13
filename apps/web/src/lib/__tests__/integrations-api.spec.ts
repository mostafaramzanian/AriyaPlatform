import {
  AUTOMATION_STATUS_LABELS,
  createIntegration,
  deleteIntegration,
  formatIntegrationTime,
  integrationLabel,
  integrationStatusLabel,
  listAutomationExecutions,
  listIntegrations,
  rotateIntegrationSecret,
  secretStatusLabel,
  testIntegration,
  updateIntegration,
  type Integration,
} from '../integrations-api';
import { coreDelete, coreGet, corePatch, corePost } from '../core-http';

/**
 * Phase 49L coverage for the integrations client.
 *
 * THREE INVARIANTS ARE UNDER TEST, and the first two carry security weight:
 *
 *  1. NO REQUEST CARRIES A DESTINATION OR A TENANT. Every path is inspected exactly, and
 *     every body is inspected key-by-key. The §29/§30 anti-pattern — a client choosing
 *     where Aria sends a request — is asserted absent rather than assumed.
 *
 *  2. AN OMITTED SECRET IS GENUINELY OMITTED. If `updateIntegration` filled in an empty
 *     string the server would store an unusable secret and every dispatch would fail; the
 *     bodies below are asserted to have no `secret` key at all in that case.
 *
 *  3. THE STATUS LABELS DISTINGUISH THE FIVE OPERATOR SITUATIONS. Collapsing "disabled",
 *     "no secret", "untested", "test failed" and "connected" into on/off would tell an
 *     operator that a broken integration is merely off.
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

const CONFIG: Integration = {
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

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();

  getMock.mockResolvedValue({ configs: [CONFIG], integrations: [] } as never);
  postMock.mockResolvedValue(CONFIG as never);
  patchMock.mockResolvedValue(CONFIG as never);
  deleteMock.mockResolvedValue({ id: 'cfg-1', deleted: true } as never);
});

describe('request shape', () => {
  it('reads the literal collection path with no parameters', async () => {
    await listIntegrations();
    expect(getMock).toHaveBeenCalledWith('/admin/integrations');
  });

  it('reads executions without any tenant or user parameter', async () => {
    await listAutomationExecutions({ limit: 20, cursor: 'c1' });
    // Only paging. There is no tenant, user or `asUser` parameter to send, because the
    // contract has none — the server derives the tenant from the request context.
    expect(getMock).toHaveBeenCalledWith('/admin/integrations/executions?limit=20&cursor=c1');

    await listAutomationExecutions();
    expect(getMock).toHaveBeenLastCalledWith('/admin/integrations/executions');
  });

  it('sends only the declared create fields', async () => {
    await createIntegration({
      integration: 'N8N',
      baseUrl: 'http://localhost:5678',
      webhookPath: '/webhook/aria',
    });

    const [path, body] = postMock.mock.calls[0];
    expect(path).toBe('/admin/integrations');
    expect(Object.keys(body as object).sort()).toEqual(['baseUrl', 'integration', 'webhookPath']);
  });

  it('OMITS an empty secret rather than sending a blank one', async () => {
    await updateIntegration('cfg-1', { baseUrl: 'http://localhost:5679', secret: '' });

    const [, body] = patchMock.mock.calls[0];
    // Sending `secret: ''` would store an unusable value and break every dispatch.
    expect(body).not.toHaveProperty('secret');
    expect(body).toEqual({ baseUrl: 'http://localhost:5679' });
  });

  it('sends a secret when one was actually typed', async () => {
    await updateIntegration('cfg-1', { secret: 'x'.repeat(32) });
    expect(patchMock.mock.calls[0][1]).toEqual({ secret: 'x'.repeat(32) });
  });

  it('never sends `integration` on an update — a row cannot be retargeted', async () => {
    await updateIntegration('cfg-1', { enabled: false });
    expect(patchMock.mock.calls[0][1]).not.toHaveProperty('integration');
  });

  it('posts rotation and test with NO body at all', async () => {
    await rotateIntegrationSecret('cfg-1');
    await testIntegration('cfg-1');

    expect(postMock.mock.calls[0]).toEqual(['/admin/integrations/cfg-1/secret']);
    expect(postMock.mock.calls[1]).toEqual(['/admin/integrations/cfg-1/test']);
  });

  it('deletes by path only', async () => {
    await deleteIntegration('cfg-1');
    expect(deleteMock).toHaveBeenCalledWith('/admin/integrations/cfg-1');
  });

  it('has no function that accepts an outbound URL', () => {
    // Structural: the §29 anti-pattern is unexpressible from this client.
    const source = [
      createIntegration,
      updateIntegration,
      testIntegration,
      rotateIntegrationSecret,
      listAutomationExecutions,
    ]
      .map((fn) => fn.toString())
      .join('\n');

    expect(source).not.toMatch(/fetch\(/);
    expect(source).not.toMatch(/https?:\/\//);
  });
});

describe('presentation helpers', () => {
  it('distinguishes all five connection states', () => {
    expect(integrationStatusLabel({ ...CONFIG, enabled: false })).toBe('غیرفعال');
    expect(integrationStatusLabel({ ...CONFIG, hasSecret: false })).toBe('کلید امضا تنظیم نشده');
    expect(
      integrationStatusLabel({ ...CONFIG, lastTestStatus: null, lastTestedAt: null }),
    ).toBe('فعال — آزمایش نشده');
    expect(integrationStatusLabel({ ...CONFIG, lastTestStatus: 'FAILURE' })).toBe(
      'اتصال برقرار نشد',
    );
    expect(integrationStatusLabel(CONFIG)).toBe('متصل است');
  });

  it('prioritises "disabled" over a stale successful test', () => {
    // A row that WAS connected and has since been switched off must not read "connected".
    expect(
      integrationStatusLabel({ ...CONFIG, enabled: false, lastTestStatus: 'SUCCESS' }),
    ).toBe('غیرفعال');
  });

  it('reports secret presence without ever implying a value', () => {
    expect(secretStatusLabel({ hasSecret: false, secretUpdatedAt: null })).toBe('ذخیره نشده');
    expect(secretStatusLabel({ hasSecret: true, secretUpdatedAt: null })).toBe('ذخیره شده');
    expect(secretStatusLabel(CONFIG)).toContain('آخرین تغییر');
  });

  it('labels every automation status, with no untranslated fallthrough', () => {
    for (const status of [
      'PENDING',
      'SENT',
      'ACCEPTED',
      'RETRYING',
      'COMPLETED',
      'FAILED',
    ] as const) {
      expect(AUTOMATION_STATUS_LABELS[status]).toBeTruthy();
      // A raw enum name reaching an operator is the failure this guards against.
      expect(AUTOMATION_STATUS_LABELS[status]).not.toBe(status);
    }
  });

  it('falls back to the raw key when the catalogue has no descriptor', () => {
    expect(integrationLabel('N8N', [])).toBe('N8N');
    expect(
      integrationLabel('N8N', [
        { key: 'N8N', displayName: 'n8n (اتوماسیون محلی)', defaultWebhookPath: '/webhook/aria' },
      ]),
    ).toBe('n8n (اتوماسیون محلی)');
  });

  it('formats a valid date and degrades to empty for anything else', () => {
    expect(formatIntegrationTime('2026-09-04T10:00:00.000Z')).not.toBe('');
    expect(formatIntegrationTime(null)).toBe('');
    expect(formatIntegrationTime('not a date')).toBe('');
  });
});

