import { N8nIntegrationProvider } from './n8n-integration.provider';
import {
  EVENT_ID_HEADER,
  IDEMPOTENCY_HEADER,
  INTEGRATION_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  MIN_SECRET_LENGTH,
  signRequest,
} from './integration-signature';
import { ALLOW_PRIVATE_ENV_VAR } from './integration-url.guard';
import type { IntegrationEvent } from './integration.contract';

/**
 * Phase 49L §4/§39: the n8n adapter against a MOCKED HTTP boundary.
 *
 * This is the "test the adapter without requiring n8n" gate. `fetch` is replaced, so
 * every branch — accepted, 4xx, 5xx, timeout, network failure, blocked URL — is
 * exercised deterministically and offline. Real n8n E2E is a separate gate and is
 * reported honestly in the closure document rather than simulated here with a fake
 * success.
 *
 * THE FOUR PROPERTIES THAT CARRY WEIGHT:
 *
 *  1. IT NEVER THROWS. Every failure returns `accepted: false`. A rejected promise here
 *     would become a 500 in the ticket creation that triggered the automation, which
 *     §22 forbids — so "does not throw" is asserted explicitly, not implied.
 *  2. THE REQUEST IS SIGNED, and the signature is the one an independent call to
 *     `signRequest` produces. Recomputing it in the test rather than snapshotting it
 *     means a change to the canonical format fails here instead of silently shipping.
 *  3. RETRYABILITY IS CLASSIFIED CORRECTLY. 5xx/429/timeout retryable, other 4xx not:
 *     replaying a rejected request cannot change the outcome and would burn the budget.
 *  4. THE SSRF GUARD IS RE-APPLIED AT DISPATCH. A row stored while private targets were
 *     allowed must stop being dispatched to when the flag is turned off — asserted by
 *     flipping the env between calls, and by proving `fetch` was never reached.
 */

const SECRET = 'a'.repeat(MIN_SECRET_LENGTH);

const TARGET = {
  baseUrl: 'https://automation.example.com',
  webhookPath: '/webhook/aria',
  timeoutMs: 5000,
};

const envelope = (): IntegrationEvent => ({
  eventId: 'evt-1',
  eventType: 'ticket.created',
  version: 1,
  occurredAt: '2026-09-04T10:00:00.000Z',
  source: 'support',
  tenant: { id: 'tenant-1' },
  actor: { type: 'user', id: 'user-1' },
  correlationId: 'corr-1',
  payload: { ticketId: 't-1' },
});

const jsonResponse = (status: number, body: unknown = {}) =>
  ({
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const originalFetch = global.fetch;
const originalFlag = process.env[ALLOW_PRIVATE_ENV_VAR];

describe('N8nIntegrationProvider', () => {
  let provider: N8nIntegrationProvider;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    provider = new N8nIntegrationProvider();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    delete process.env[ALLOW_PRIVATE_ENV_VAR];
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalFlag === undefined) {
      delete process.env[ALLOW_PRIVATE_ENV_VAR];
    } else {
      process.env[ALLOW_PRIVATE_ENV_VAR] = originalFlag;
    }
  });

  it('declares the N8N key, which is what the registry resolves against', () => {
    expect(provider.key).toBe('N8N');
  });

  it('POSTs the envelope as JSON to baseUrl + webhookPath', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));

    await provider.send(TARGET, envelope(), SECRET);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe('https://automation.example.com/webhook/aria');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(envelope());
  });

  it('signs the request with the exact canonical material', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));

    await provider.send(TARGET, envelope(), SECRET);

    const [, init] = fetchMock.mock.calls[0];
    const expected = signRequest(SECRET, {
      method: 'POST',
      path: '/webhook/aria',
      timestamp: init.headers[TIMESTAMP_HEADER],
      eventId: 'evt-1',
      idempotencyKey: 'N8N:evt-1:v1',
      body: init.body,
    });

    expect(init.headers[SIGNATURE_HEADER]).toBe(expected);
    expect(init.headers[EVENT_ID_HEADER]).toBe('evt-1');
    expect(init.headers[INTEGRATION_HEADER]).toBe('N8N');
    expect(init.headers[IDEMPOTENCY_HEADER]).toBe('N8N:evt-1:v1');
  });

  it('never puts the secret in a header, a query string or the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));

    await provider.send(TARGET, envelope(), SECRET);

    const [url, init] = fetchMock.mock.calls[0];
    const serialised = JSON.stringify({ url, headers: init.headers, body: init.body });

    expect(serialised).not.toContain(SECRET);
  });

  it('applies the configured timeout through AbortSignal', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200));

    await provider.send({ ...TARGET, timeoutMs: 1234 }, envelope(), SECRET);

    // The signal is opaque, so what is asserted is that ONE was supplied — the absence
    // of a timeout is the failure worth catching, since it would let a dispatch hang
    // for the duration of the OS socket timeout.
    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });

  describe('outcome classification', () => {
    it('reports ACCEPTED with the engine execution id when the body carries one', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { executionId: 'n8n-777' }));

      await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toEqual({
        accepted: true,
        externalExecutionId: 'n8n-777',
      });
    });

    it('accepts a numeric execution id and a snake_case field', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { execution_id: 'x-1' }));
      await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toMatchObject({
        externalExecutionId: 'x-1',
      });

      fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 42 }));
      await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toMatchObject({
        externalExecutionId: '42',
      });
    });

    it('still counts as accepted when the workflow returns nothing usable', async () => {
      // A workflow with no "Respond to Webhook" node returns an empty body. That is not
      // a delivery failure, so an unparseable response must not become one.
      for (const body of ['', 'not json', '[]', '{"unrelated":true}']) {
        fetchMock.mockResolvedValueOnce({
          status: 200,
          text: async () => body,
        } as unknown as Response);

        await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toEqual({
          accepted: true,
          externalExecutionId: undefined,
        });
      }
    });

    it('rejects an over-long execution id rather than storing it', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { executionId: 'x'.repeat(500) }));

      await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toEqual({
        accepted: true,
        externalExecutionId: undefined,
      });
    });

    it('classifies 5xx and 429 as retryable', async () => {
      for (const status of [500, 502, 503, 429]) {
        fetchMock.mockResolvedValueOnce(jsonResponse(status));

        await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toEqual({
          accepted: false,
          errorCode: `HTTP_${status}`,
          retryable: true,
        });
      }
    });

    it('classifies other 4xx as NOT retryable', async () => {
      // A 404 means the workflow is not registered and a 401/403 means the signature was
      // rejected. Replaying either cannot change the outcome; retrying would only burn
      // the bounded attempt budget and delay the FAILED an operator needs to see.
      for (const status of [400, 401, 403, 404, 409, 422]) {
        fetchMock.mockResolvedValueOnce(jsonResponse(status));

        await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toEqual({
          accepted: false,
          errorCode: `HTTP_${status}`,
          retryable: false,
        });
      }
    });

    it('maps a timeout to TIMEOUT and keeps it retryable', async () => {
      const err = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      fetchMock.mockRejectedValue(err);

      await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toEqual({
        accepted: false,
        errorCode: 'TIMEOUT',
        retryable: true,
      });
    });

    it('maps a connection failure to UNREACHABLE — the "n8n is stopped" case', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toEqual({
        accepted: false,
        errorCode: 'UNREACHABLE',
        retryable: true,
      });
    });

    it('NEVER throws, whatever fetch does', async () => {
      // The property that keeps a business operation alive. Asserted for a thrown
      // string, null, undefined and a plain object, because reading `err.name` on any
      // of those unguarded would itself throw.
      for (const rejection of ['boom', null, undefined, 42, {}]) {
        fetchMock.mockRejectedValueOnce(rejection);

        await expect(provider.send(TARGET, envelope(), SECRET)).resolves.toMatchObject({
          accepted: false,
        });
      }
    });
  });

  describe('SSRF re-validation at dispatch', () => {
    it('refuses a private target and NEVER calls fetch', async () => {
      const result = await provider.send(
        { ...TARGET, baseUrl: 'http://127.0.0.1:5678' },
        envelope(),
        SECRET,
      );

      expect(result).toEqual({ accepted: false, errorCode: 'SSRF_BLOCKED', retryable: false });
      // The important half: no request left the process.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is NOT retryable, because the policy will not change on its own', async () => {
      const result = await provider.send(
        { ...TARGET, baseUrl: 'http://10.0.0.1' },
        envelope(),
        SECRET,
      );

      expect(result.retryable).toBe(false);
    });

    it('re-reads the flag per dispatch, so revoking it stops an existing row', async () => {
      process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';
      fetchMock.mockResolvedValue(jsonResponse(200));

      await expect(
        provider.send({ ...TARGET, baseUrl: 'http://localhost:5678' }, envelope(), SECRET),
      ).resolves.toMatchObject({ accepted: true });

      delete process.env[ALLOW_PRIVATE_ENV_VAR];

      await expect(
        provider.send({ ...TARGET, baseUrl: 'http://localhost:5678' }, envelope(), SECRET),
      ).resolves.toMatchObject({ accepted: false, errorCode: 'SSRF_BLOCKED' });
    });

    it('refuses a webhookPath that would change the authority', async () => {
      const result = await provider.send(
        { ...TARGET, webhookPath: 'https://evil.example/steal' },
        envelope(),
        SECRET,
      );

      expect(result).toEqual({
        accepted: false,
        errorCode: 'MALFORMED_TARGET',
        retryable: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});


