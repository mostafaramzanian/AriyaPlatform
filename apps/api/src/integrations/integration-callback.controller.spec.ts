import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AutomationStatus } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { IntegrationCallbackController } from './integration-callback.controller';

/** The request shape the callback route actually consumes. */
type CallbackReq = Parameters<IntegrationCallbackController['callback']>[2];
import { IntegrationService } from './integration.service';
import { IntegrationProviderRegistry } from './integration-provider.registry';
import { N8nIntegrationProvider } from './n8n-integration.provider';
import {
  EVENT_ID_HEADER,
  IDEMPOTENCY_HEADER,
  MIN_SECRET_LENGTH,
  SIGNATURE_HEADER,
  SIGNATURE_WINDOW_MS,
  TIMESTAMP_HEADER,
  signRequest,
} from './integration-signature';
import type { IntegrationCallbackDto } from './dto/integration.dto';

/**
 * Phase 49L §26/§40: the inbound callback's authentication.
 *
 * THIS IS THE MOST SECURITY-SENSITIVE FILE IN THE PHASE, because the route it covers is
 * `@Public()` — reachable by anyone on the network — and it is the only path by which an
 * external system can change any state in Aria.
 *
 * WHAT EVERY TEST BELOW IS DEFENDING:
 *  - a valid signature is REQUIRED, and its absence is a rejection rather than a bypass;
 *  - the rejection is UNIFORM (401, one message) for every failure class, so the route
 *    cannot be used as an oracle for which integrations or events exist;
 *  - `applyCallback` is not reached at all on any rejection — asserted explicitly,
 *    because "rejected but the mutation already ran" is the failure that matters;
 *  - the idempotency key is DERIVED from the stored row, so a sender cannot choose which
 *    key its signature covers.
 */

const SECRET = 'a'.repeat(MIN_SECRET_LENGTH);
const PATH = '/api/v1/integrations/N8N/callback';

const body = (overrides: Partial<IntegrationCallbackDto> = {}): IntegrationCallbackDto => ({
  eventId: 'evt-1',
  integration: 'N8N',
  status: 'COMPLETED',
  ...overrides,
});

/** A request whose headers are correctly signed for the given body. */
const signedRequest = (dto: IntegrationCallbackDto, now = Date.now()) => {
  const timestamp = String(now);
  const idempotencyKey = `N8N:${dto.eventId}:v1`;

  return {
    path: PATH,
    headers: {
      [TIMESTAMP_HEADER]: timestamp,
      [EVENT_ID_HEADER]: dto.eventId,
      [IDEMPOTENCY_HEADER]: idempotencyKey,
      [SIGNATURE_HEADER]: signRequest(SECRET, {
        method: 'POST',
        path: PATH,
        timestamp,
        eventId: dto.eventId,
        idempotencyKey,
        body: JSON.stringify(dto),
      }),
    },
  } as unknown as CallbackReq;
};

describe('IntegrationCallbackController', () => {
  let controller: IntegrationCallbackController;
  let prisma: {
    integrationConfig: { findUnique: jest.Mock };
    automationExecution: { findUnique: jest.Mock };
  };
  let integrations: { applyCallback: jest.Mock };

  beforeEach(async () => {
    prisma = {
      integrationConfig: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'cfg-1',
          integration: 'N8N',
          enabled: true,
          secretCiphertext: 'ct',
          secretIv: 'iv',
          secretAuthTag: 'tag',
        }),
      },
      automationExecution: {
        findUnique: jest.fn().mockResolvedValue({ eventVersion: 1 }),
      },
    };

    integrations = {
      applyCallback: jest.fn().mockResolvedValue({
        executionId: 'exec-1',
        status: AutomationStatus.COMPLETED,
        duplicate: false,
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [IntegrationCallbackController],
      providers: [
        { provide: IntegrationService, useValue: integrations },
        IntegrationProviderRegistry,
        { provide: N8nIntegrationProvider, useValue: { key: 'N8N', send: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: { decrypt: jest.fn().mockReturnValue(SECRET) } },
      ],
    }).compile();

    controller = moduleRef.get(IntegrationCallbackController);
  });

  it('accepts a correctly signed callback and applies it', async () => {
    const dto = body();

    await expect(controller.callback('N8N', dto, signedRequest(dto))).resolves.toEqual({
      accepted: true,
      executionId: 'exec-1',
      status: AutomationStatus.COMPLETED,
      duplicate: false,
    });

    expect(integrations.applyCallback).toHaveBeenCalledWith('N8N', dto);
  });

  it('reports a duplicate as accepted, not as an error (§18)', async () => {
    integrations.applyCallback.mockResolvedValue({
      executionId: 'exec-1',
      status: AutomationStatus.COMPLETED,
      duplicate: true,
    });

    const dto = body();

    await expect(controller.callback('N8N', dto, signedRequest(dto))).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
    });
  });

  describe('rejections', () => {
    /** Every rejection must be a 401 AND must not reach the mutation. */
    const expectRejected = async (
      integration: string,
      dto: IntegrationCallbackDto,
      req: CallbackReq,
    ) => {
      await expect(controller.callback(integration, dto, req)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(integrations.applyCallback).not.toHaveBeenCalled();
    };

    it('rejects a MISSING signature — this is the one that must never be a bypass', async () => {
      const dto = body();
      const req = signedRequest(dto);
      delete req.headers[SIGNATURE_HEADER];

      await expectRejected('N8N', dto, req);
    });

    it('rejects an empty signature header', async () => {
      const dto = body();
      const req = signedRequest(dto);
      req.headers[SIGNATURE_HEADER] = '';

      await expectRejected('N8N', dto, req);
    });

    it('rejects a signature made with the wrong secret', async () => {
      const dto = body();
      const req = signedRequest(dto);
      req.headers[SIGNATURE_HEADER] = signRequest('b'.repeat(MIN_SECRET_LENGTH), {
        method: 'POST',
        path: PATH,
        // signedRequest stamped a String(now); read it back through the header
        // union as the canonical string it is.
        timestamp: String(req.headers[TIMESTAMP_HEADER]),
        eventId: dto.eventId,
        idempotencyKey: 'N8N:evt-1:v1',
        body: JSON.stringify(dto),
      });

      await expectRejected('N8N', dto, req);
    });

    it('rejects a TAMPERED body — the signature covers the outcome', async () => {
      const original = body({ status: 'COMPLETED' });
      const req = signedRequest(original);

      // Same signature, different body: a workflow failure presented as a success.
      await expectRejected('N8N', body({ status: 'FAILED' }), req);
    });

    it('rejects an EXPIRED timestamp — replay of a captured request', async () => {
      const dto = body();
      const stale = Date.now() - SIGNATURE_WINDOW_MS - 1000;

      // The signature is genuinely valid for that timestamp; only the clock rejects it.
      await expectRejected('N8N', dto, signedRequest(dto, stale));
    });

    it('rejects a timestamp far in the FUTURE', async () => {
      const dto = body();
      await expectRejected('N8N', dto, signedRequest(dto, Date.now() + SIGNATURE_WINDOW_MS + 1000));
    });

    it('rejects a missing timestamp', async () => {
      const dto = body();
      const req = signedRequest(dto);
      delete req.headers[TIMESTAMP_HEADER];

      await expectRejected('N8N', dto, req);
    });

    it('rejects an UNKNOWN integration without touching the database', async () => {
      const dto = body({ integration: 'ZAPIER' as never });

      await expectRejected('ZAPIER', dto, signedRequest(body()));
      // Rejected by the registry before any read, so the route cannot be used to
      // enumerate configured integrations.
      expect(prisma.integrationConfig.findUnique).not.toHaveBeenCalled();
    });

    it('rejects when the integration is DISABLED', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue({
        id: 'cfg-1',
        integration: 'N8N',
        enabled: false,
        secretCiphertext: 'ct',
        secretIv: 'iv',
        secretAuthTag: 'tag',
      });

      const dto = body();
      await expectRejected('N8N', dto, signedRequest(dto));
    });

    it('rejects when NO SECRET is stored — never falls through to "unsigned is fine"', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue({
        id: 'cfg-1',
        integration: 'N8N',
        enabled: true,
        secretCiphertext: null,
        secretIv: null,
        secretAuthTag: null,
      });

      const dto = body();
      await expectRejected('N8N', dto, signedRequest(dto));
    });

    it('rejects an UNKNOWN event with the same 401 as a bad signature', async () => {
      prisma.automationExecution.findUnique.mockResolvedValue(null);

      const dto = body({ eventId: 'evt-nope' });
      await expectRejected('N8N', dto, signedRequest(dto));
    });

    it('rejects a header event id that disagrees with the body', async () => {
      const dto = body();
      const req = signedRequest(dto);
      req.headers[EVENT_ID_HEADER] = 'evt-other';

      await expectRejected('N8N', dto, req);
    });

    it('rejects a substituted idempotency key', async () => {
      const dto = body();
      const req = signedRequest(dto);
      // The expected key is DERIVED from the stored eventVersion, so a sender cannot
      // choose which key its signature covers.
      req.headers[IDEMPOTENCY_HEADER] = 'N8N:evt-1:v99';

      await expectRejected('N8N', dto, req);
    });

    it('discloses NOTHING about which check failed', async () => {
      const cases: Array<() => Promise<unknown>> = [
        () => controller.callback('ZAPIER', body({ integration: 'ZAPIER' as never }), signedRequest(body())),
        () => {
          const dto = body();
          const req = signedRequest(dto);
          delete req.headers[SIGNATURE_HEADER];
          return controller.callback('N8N', dto, req);
        },
        () => controller.callback('N8N', body(), signedRequest(body(), Date.now() - 10 * 60_000)),
      ];

      const messages = new Set<string>();

      for (const run of cases) {
        try {
          await run();
        } catch (err) {
          messages.add((err as Error).message);
        }
      }

      // ONE message for every failure class: no oracle for integrations, events, clock
      // skew or signature validity.
      expect(messages.size).toBe(1);
      expect([...messages][0]).toBe('Callback rejected');
    });
  });
});

