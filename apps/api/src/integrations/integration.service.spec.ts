import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AutomationStatus } from '../generated/core-client';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AuditService } from '../common/audit.service';
import { RequestContextService } from '../common/request-context.service';
import { ObservabilityLifecycleService } from '../observability/observability-lifecycle.service';
import { IntegrationService, RETRY_BATCH_SIZE } from './integration.service';
import { IntegrationProviderRegistry } from './integration-provider.registry';
import { N8nIntegrationProvider } from './n8n-integration.provider';
import { ALLOW_PRIVATE_ENV_VAR } from './integration-url.guard';
import { MIN_SECRET_LENGTH } from './integration-signature';

/**
 * Phase 49L: the domain rules of the integration platform.
 *
 * WHAT THIS FILE PROVES, AND WHY EACH ONE IS HERE RATHER THAN ASSUMED:
 *
 *  - THE SECRET NEVER LEAVES. Every projection is inspected for the three envelope
 *    columns, and the audit payloads are inspected too — an audit row is a place a
 *    credential leaks to quietly, because nobody reads it until an incident.
 *  - A BUSINESS OPERATION IS NEVER FAILED BY AUTOMATION. `trigger` is exercised with no
 *    config, a disabled config, a secret-less config and a provider that fails, and in
 *    every case it RESOLVES.
 *  - IDEMPOTENCY IS THE DATABASE'S JOB. The P2002 path is exercised directly, because
 *    that is the branch a read-then-write implementation would not have.
 *  - TENANT IS NEVER WIDENED. The list read is asserted to carry `tenantId` in its
 *    predicate even when it is null.
 *  - RETRY IS BOUNDED. The attempt budget is asserted at its edge, and the terminal
 *    transition is asserted to clear `nextAttemptAt` — which is what the CHECK
 *    constraint requires and what keeps a completed row out of the retry index.
 *  - A CALLBACK CANNOT DO ANYTHING ELSE. The only mutation it can reach is the delivery
 *    status of one located row.
 *
 * The provider is a STUB. Real HTTP behaviour is covered in
 * `n8n-integration.provider.spec.ts`; here it is a controllable boundary so the state
 * machine can be driven through every outcome.
 */

const SECRET = 'a'.repeat(MIN_SECRET_LENGTH);
const CIPHER = { ciphertext: 'ct', iv: 'iv', authTag: 'tag' };

const configRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'cfg-1',
  integration: 'N8N',
  baseUrl: 'https://automation.example.com',
  webhookPath: '/webhook/aria',
  enabled: true,
  timeoutMs: 5000,
  maxAttempts: 3,
  secretCiphertext: CIPHER.ciphertext,
  secretIv: CIPHER.iv,
  secretAuthTag: CIPHER.authTag,
  secretUpdatedAt: new Date('2026-09-01T00:00:00.000Z'),
  lastTestStatus: null,
  lastTestedAt: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

const executionRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'exec-1',
  integration: 'N8N',
  eventId: 'evt-1',
  eventType: 'ticket.created',
  eventVersion: 1,
  source: 'support',
  idempotencyKey: 'N8N:evt-1:v1',
  tenantId: 'tenant-1',
  actorId: 'user-1',
  correlationId: 'corr-1',
  status: AutomationStatus.PENDING,
  externalExecutionId: null,
  attemptCount: 0,
  nextAttemptAt: null,
  errorCode: null,
  createdAt: new Date('2026-09-04T10:00:00.000Z'),
  startedAt: null,
  completedAt: null,
  updatedAt: new Date('2026-09-04T10:00:00.000Z'),
  ...overrides,
});

const uniqueViolation = () => Object.assign(new Error('unique'), { code: 'P2002' });

describe('IntegrationService', () => {
  let service: IntegrationService;
  let prisma: {
    integrationConfig: Record<string, jest.Mock>;
    automationExecution: Record<string, jest.Mock>;
  };
  let crypto: { encrypt: jest.Mock; decrypt: jest.Mock };
  let audit: { log: jest.Mock };
  let provider: { key: 'N8N'; send: jest.Mock };
  /**
   * 49M-2. The FULL public surface of `ObservabilityLifecycleService` is stubbed, not just the
   * `integration` method this service calls: a partial stub would turn a future emission through
   * `record` or `module` into a TypeError instead of a failed assertion.
   */
  let lifecycle: {
    record: jest.Mock;
    integration: jest.Mock;
    module: jest.Mock;
    provisioning: jest.Mock;
  };

  const actor = 'user-admin-1';
  const originalFlag = process.env[ALLOW_PRIVATE_ENV_VAR];

  beforeEach(async () => {
    prisma = {
      integrationConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      automationExecution: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    crypto = {
      encrypt: jest.fn().mockReturnValue(CIPHER),
      decrypt: jest.fn().mockReturnValue(SECRET),
    };

    audit = { log: jest.fn().mockResolvedValue(undefined) };
    provider = { key: 'N8N', send: jest.fn().mockResolvedValue({ accepted: true }) };

    lifecycle = {
      record: jest.fn(),
      integration: jest.fn(),
      module: jest.fn(),
      provisioning: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IntegrationService,
        IntegrationProviderRegistry,
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: crypto },
        { provide: AuditService, useValue: audit },
        { provide: N8nIntegrationProvider, useValue: provider },
        // `@Optional()` on the service means OMITTING this would silently no-op every
        // emission and let the assertions below pass vacuously. It is registered here, once,
        // for the whole file.
        { provide: ObservabilityLifecycleService, useValue: lifecycle },
      ],
    }).compile();

    service = moduleRef.get(IntegrationService);

    // A public target, so the SSRF guard is not what is under test in most cases.
    delete process.env[ALLOW_PRIVATE_ENV_VAR];
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env[ALLOW_PRIVATE_ENV_VAR];
    } else {
      process.env[ALLOW_PRIVATE_ENV_VAR] = originalFlag;
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Secret containment
  // ───────────────────────────────────────────────────────────────────────────

  describe('secret containment', () => {
    it('never returns the envelope columns from any projection', async () => {
      prisma.integrationConfig.findMany.mockResolvedValue([configRow()]);
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());

      const list = await service.listConfigs();
      const one = await service.getConfig('cfg-1');

      for (const projection of [list.configs[0], one]) {
        expect(projection).not.toHaveProperty('secretCiphertext');
        expect(projection).not.toHaveProperty('secretIv');
        expect(projection).not.toHaveProperty('secretAuthTag');
        // Presence and rotation time only.
        expect(projection.hasSecret).toBe(true);
        expect(projection.secretUpdatedAt).toBeInstanceOf(Date);
      }
    });

    it('reports hasSecret false — not an empty string — when none is stored', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(
        configRow({ secretCiphertext: null, secretIv: null, secretAuthTag: null, secretUpdatedAt: null }),
      );

      const one = await service.getConfig('cfg-1');

      expect(one.hasSecret).toBe(false);
      expect(one.secretUpdatedAt).toBeNull();
    });

    it('never puts the plaintext secret in an audit payload', async () => {
      prisma.integrationConfig.create.mockResolvedValue(configRow());

      await service.createConfig(actor, {
        integration: 'N8N',
        baseUrl: 'https://automation.example.com',
        webhookPath: '/webhook/aria',
        secret: SECRET,
      });

      const payloads = JSON.stringify(audit.log.mock.calls);
      expect(payloads).not.toContain(SECRET);
      // Presence is recorded, which is the auditable fact.
      expect(audit.log.mock.calls[0][0].newValue.hasSecret).toBe(true);
    });

    it('encrypts through CryptoService and stores all three envelope parts', async () => {
      prisma.integrationConfig.create.mockResolvedValue(configRow());

      await service.createConfig(actor, {
        integration: 'N8N',
        baseUrl: 'https://automation.example.com',
        webhookPath: '/webhook/aria',
        secret: SECRET,
      });

      expect(crypto.encrypt).toHaveBeenCalledWith(SECRET);
      const data = prisma.integrationConfig.create.mock.calls[0][0].data;
      expect(data.secretCiphertext).toBe(CIPHER.ciphertext);
      expect(data.secretIv).toBe(CIPHER.iv);
      expect(data.secretAuthTag).toBe(CIPHER.authTag);
      expect(data.secretUpdatedAt).toBeInstanceOf(Date);
    });

    it('returns a generated secret ONCE from rotateSecret, at full entropy', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      const { secret } = await service.rotateSecret(actor, 'cfg-1');

      // 32 random bytes as hex. Above MIN_SECRET_LENGTH and not derived from anything.
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(audit.log.mock.calls)).not.toContain(secret);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Configuration rules
  // ───────────────────────────────────────────────────────────────────────────

  describe('configuration', () => {
    const base = {
      integration: 'N8N' as const,
      baseUrl: 'https://automation.example.com',
      webhookPath: '/webhook/aria',
    };

    it('refuses an SSRF-blocked baseUrl BEFORE writing anything', async () => {
      await expect(
        service.createConfig(actor, { ...base, baseUrl: 'http://127.0.0.1:5678' }),
      ).rejects.toThrow(BadRequestException);

      // The point of "before": a rejected URL must never reach the database, or a later
      // dispatch inherits it.
      expect(prisma.integrationConfig.create).not.toHaveBeenCalled();
    });

    it('refuses enabling without a secret, so an unsigned dispatch is impossible', async () => {
      await expect(
        service.createConfig(actor, { ...base, enabled: true }),
      ).rejects.toThrow(BadRequestException);

      prisma.integrationConfig.findUnique.mockResolvedValue(
        configRow({ enabled: false, secretCiphertext: null, secretIv: null, secretAuthTag: null }),
      );

      await expect(service.updateConfig(actor, 'cfg-1', { enabled: true })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows enabling in the SAME request that supplies the secret', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(
        configRow({ enabled: false, secretCiphertext: null, secretIv: null, secretAuthTag: null }),
      );
      prisma.integrationConfig.update.mockResolvedValue(configRow({ enabled: true }));

      await expect(
        service.updateConfig(actor, 'cfg-1', { enabled: true, secret: SECRET }),
      ).resolves.toMatchObject({ enabled: true });
    });

    it('creates DISABLED by default, so a new row cannot start sending live events', async () => {
      prisma.integrationConfig.create.mockResolvedValue(configRow({ enabled: false }));

      await service.createConfig(actor, base);

      expect(prisma.integrationConfig.create.mock.calls[0][0].data.enabled).toBe(false);
    });

    it('leaves the stored secret untouched when the update omits one', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      await service.updateConfig(actor, 'cfg-1', { webhookPath: '/webhook/other' });

      const data = prisma.integrationConfig.update.mock.calls[0][0].data;
      // This is what makes the masked GET safe to round-trip: the UI submits the whole
      // form back without ever having seen the secret.
      expect(data).not.toHaveProperty('secretCiphertext');
      expect(data).not.toHaveProperty('secretUpdatedAt');
      expect(crypto.encrypt).not.toHaveBeenCalled();
    });

    it('treats a no-op PATCH as idempotent rather than an error', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());

      await expect(service.updateConfig(actor, 'cfg-1', {})).resolves.toMatchObject({
        id: 'cfg-1',
      });
      expect(prisma.integrationConfig.update).not.toHaveBeenCalled();
    });

    it('audits enable, disable and rotation as their OWN actions', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow({ enabled: false }));
      prisma.integrationConfig.update.mockResolvedValue(configRow({ enabled: true }));

      await service.updateConfig(actor, 'cfg-1', { enabled: true, secret: SECRET });

      const actions = audit.log.mock.calls.map((call) => call[0].action);
      // Queryable by action name, not buried in a generic update's changedFields.
      expect(actions).toContain('INTEGRATION_UPDATED');
      expect(actions).toContain('INTEGRATION_ENABLED');
      expect(actions).toContain('INTEGRATION_SECRET_ROTATED');
    });

    it('rejects an unknown integration key', async () => {
      await expect(
        service.createConfig(actor, { ...base, integration: 'ZAPIER' as never }),
      ).rejects.toThrow(BadRequestException);
    });

    it('surfaces a duplicate integration as a Conflict, not a 500', async () => {
      prisma.integrationConfig.create.mockRejectedValue(uniqueViolation());

      await expect(service.createConfig(actor, base)).rejects.toMatchObject({ status: 409 });
    });

    it('404s an unknown config id on every read and write path', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(null);

      await expect(service.getConfig('missing')).rejects.toThrow(NotFoundException);
      await expect(service.updateConfig(actor, 'missing', {})).rejects.toThrow(NotFoundException);
      await expect(service.deleteConfig(actor, 'missing')).rejects.toThrow(NotFoundException);
      await expect(service.rotateSecret(actor, 'missing')).rejects.toThrow(NotFoundException);
      await expect(service.testConnection(actor, 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Dispatch, envelope, availability
  // ───────────────────────────────────────────────────────────────────────────

  describe('trigger', () => {
    const input = {
      eventType: 'ticket.created' as const,
      source: 'support' as const,
      payload: { ticketId: 't-1', status: 'NEW' },
    };

    beforeEach(() => {
      prisma.automationExecution.create.mockResolvedValue({
        id: 'exec-1',
        status: AutomationStatus.PENDING,
      });
    });

    it('SKIPS with no error when no integration is configured', async () => {
      prisma.integrationConfig.findFirst.mockResolvedValue(null);

      await expect(service.trigger(input)).resolves.toEqual({
        dispatched: false,
        status: 'SKIPPED',
      });

      // No row is written: an execution nothing will ever retry or complete is noise and
      // would make "how many automations failed" unanswerable.
      expect(prisma.automationExecution.create).not.toHaveBeenCalled();
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('SKIPS when the only integration is disabled', async () => {
      // `findFirst` is called with `enabled: true`, so a disabled row is simply not found.
      prisma.integrationConfig.findFirst.mockResolvedValue(null);

      await expect(service.trigger(input)).resolves.toMatchObject({ status: 'SKIPPED' });
      expect(prisma.integrationConfig.findFirst.mock.calls[0][0].where).toEqual({ enabled: true });
    });

    it('builds the §8 envelope with every required field', async () => {
      prisma.integrationConfig.findFirst.mockResolvedValue(configRow());

      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-9',
        startTime: Date.now(),
        userId: 'user-7',
        tenantId: 'tenant-3',
      });

      await service.trigger({ ...input, actor: { type: 'user', id: 'user-7' } });

      const envelope = provider.send.mock.calls[0][1];

      expect(envelope.eventId).toEqual(expect.any(String));
      expect(envelope.eventType).toBe('ticket.created');
      expect(envelope.version).toBe(1);
      expect(envelope.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(envelope.source).toBe('support');
      expect(envelope.tenant).toEqual({ id: 'tenant-3' });
      expect(envelope.actor).toEqual({ type: 'user', id: 'user-7' });
      expect(envelope.correlationId).toBe('corr-9');
      expect(envelope.payload).toEqual(input.payload);
    });

    it('carries only actorId/actorType — never an email, role or session', async () => {
      prisma.integrationConfig.findFirst.mockResolvedValue(configRow());

      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-1',
        startTime: Date.now(),
        userId: 'user-7',
        userEmail: 'admin@localhost',
        userRole: 'SUPER_ADMIN',
        tenantId: 'tenant-3',
      });

      await service.trigger({ ...input, actor: { type: 'user', id: 'user-7' } });

      const serialised = JSON.stringify(provider.send.mock.calls[0][1]);
      expect(serialised).not.toContain('admin@localhost');
      expect(serialised).not.toContain('SUPER_ADMIN');
      expect(Object.keys(provider.send.mock.calls[0][1].actor)).toEqual(['type', 'id']);
    });

    it('keeps a NULL tenant as null rather than inventing one', async () => {
      prisma.integrationConfig.findFirst.mockResolvedValue(configRow());

      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-1',
        startTime: Date.now(),
        userId: 'user-7',
        tenantId: null,
      });

      await service.trigger(input);

      // NULL is its own bucket (§9), not a wildcard and not an omission.
      expect(provider.send.mock.calls[0][1].tenant).toEqual({ id: null });
      expect(prisma.automationExecution.create.mock.calls[0][0].data.tenantId).toBeNull();
    });

    it('rejects an unknown event type as a CALLER bug', async () => {
      await expect(
        service.trigger({ ...input, eventType: 'ticket.exploded' as never }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.integrationConfig.findFirst).not.toHaveBeenCalled();
    });

    it('refuses the connection-probe type through the normal dispatch path', async () => {
      // The probe is not a domain event and must not be emittable by a module or by the
      // manual-trigger route; only `testConnection` constructs it.
      await expect(
        service.trigger({ ...input, eventType: 'integration.connection.test' as never }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses an over-large payload rather than truncating it', async () => {
      await expect(
        service.trigger({ ...input, payload: { blob: 'x'.repeat(70_000) } }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.automationExecution.create).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Execution tracking, idempotency, bounded retry
  // ───────────────────────────────────────────────────────────────────────────

  describe('execution tracking and idempotency', () => {
    const input = {
      eventType: 'ticket.created' as const,
      source: 'support' as const,
      payload: { ticketId: 't-1' },
      eventId: 'evt-1',
    };

    beforeEach(() => {
      prisma.integrationConfig.findFirst.mockResolvedValue(configRow());
      prisma.automationExecution.create.mockResolvedValue({
        id: 'exec-1',
        status: AutomationStatus.PENDING,
      });
    });

    it('materialises the deterministic idempotency key on the row', async () => {
      await service.trigger(input);

      expect(prisma.automationExecution.create.mock.calls[0][0].data.idempotencyKey).toBe(
        'N8N:evt-1:v1',
      );
    });

    it('returns the EXISTING outcome on a duplicate instead of dispatching again', async () => {
      prisma.automationExecution.create.mockRejectedValue(uniqueViolation());
      prisma.automationExecution.findUnique.mockResolvedValue({
        id: 'exec-existing',
        status: AutomationStatus.COMPLETED,
      });

      const result = await service.trigger(input);

      expect(result).toEqual({
        dispatched: false,
        duplicate: true,
        executionId: 'exec-existing',
        status: AutomationStatus.COMPLETED,
      });
      // The point: no second delivery.
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('records ACCEPTED with the external reference when the engine returns one', async () => {
      provider.send.mockResolvedValue({ accepted: true, externalExecutionId: 'n8n-1' });

      const result = await service.trigger(input);

      expect(result).toMatchObject({ dispatched: true, status: 'ACCEPTED' });
      const last = prisma.automationExecution.update.mock.calls.at(-1)![0].data;
      expect(last).toMatchObject({
        status: AutomationStatus.ACCEPTED,
        externalExecutionId: 'n8n-1',
        nextAttemptAt: null,
      });
    });

    it('records SENT — not ACCEPTED — when the engine returns 2xx and no reference', async () => {
      provider.send.mockResolvedValue({ accepted: true });

      const result = await service.trigger(input);

      // Honest distinction: only ACCEPTED means something exists on the other side that
      // a callback can refer to.
      expect(result).toMatchObject({ status: 'SENT' });
    });

    it('schedules a bounded retry for a retryable failure', async () => {
      provider.send.mockResolvedValue({ accepted: false, errorCode: 'HTTP_502', retryable: true });

      const result = await service.trigger(input);

      expect(result).toMatchObject({ status: 'RETRYING', errorCode: 'HTTP_502' });
      const last = prisma.automationExecution.update.mock.calls.at(-1)![0].data;
      expect(last.status).toBe(AutomationStatus.RETRYING);
      expect(last.nextAttemptAt).toBeInstanceOf(Date);
      // Finite and in the future — never null (which would mean "not retryable") and
      // never in the past (which would make the retry pass spin).
      expect((last.nextAttemptAt as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('FAILS a non-retryable failure immediately, without spending the budget', async () => {
      provider.send.mockResolvedValue({ accepted: false, errorCode: 'HTTP_404', retryable: false });

      const result = await service.trigger(input);

      expect(result).toMatchObject({ status: 'FAILED', errorCode: 'HTTP_404' });
      const last = prisma.automationExecution.update.mock.calls.at(-1)![0].data;
      expect(last).toMatchObject({ status: AutomationStatus.FAILED, nextAttemptAt: null });
      expect(last.completedAt).toBeInstanceOf(Date);
    });

    it('FAILS with NO_SECRET when the stored secret cannot be decrypted', async () => {
      crypto.decrypt.mockImplementation(() => {
        throw new Error('bad key');
      });

      const result = await service.trigger(input);

      // A misconfigured master key must not take down the business operation.
      expect(result).toMatchObject({ status: 'FAILED', errorCode: 'NO_SECRET' });
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('never rejects, even when the provider itself resolves a failure', async () => {
      provider.send.mockResolvedValue({ accepted: false, errorCode: 'UNREACHABLE', retryable: true });

      await expect(service.trigger(input)).resolves.toBeDefined();
    });

    it('clears nextAttemptAt at the START of an attempt, so a crash leaves it claimable', async () => {
      await service.trigger(input);

      expect(prisma.automationExecution.update.mock.calls[0][0].data).toMatchObject({
        attemptCount: 1,
        nextAttemptAt: null,
      });
      expect(prisma.automationExecution.update.mock.calls[0][0].data.startedAt).toBeInstanceOf(Date);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Bounded retry pass
  // ───────────────────────────────────────────────────────────────────────────

  describe('processRetries', () => {
    it('claims each row with a CONDITIONAL update, so two instances cannot both retry', async () => {
      prisma.automationExecution.findMany.mockResolvedValue([
        executionRow({ status: AutomationStatus.RETRYING, attemptCount: 1, nextAttemptAt: new Date(0) }),
      ]);
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());

      await service.processRetries(new Date());

      const claim = prisma.automationExecution.updateMany.mock.calls[0][0];
      // The predicate IS the exclusivity: a second instance matches zero rows.
      expect(claim.where).toMatchObject({
        id: 'exec-1',
        status: AutomationStatus.RETRYING,
      });
      expect(claim.where.nextAttemptAt).toEqual({ lte: expect.any(Date) });
      expect(claim.data).toEqual({ nextAttemptAt: null });
    });

    it('does nothing further when the claim loses the race', async () => {
      prisma.automationExecution.findMany.mockResolvedValue([
        executionRow({ status: AutomationStatus.RETRYING, nextAttemptAt: new Date(0) }),
      ]);
      prisma.automationExecution.updateMany.mockResolvedValue({ count: 0 });

      const retried = await service.processRetries(new Date());

      expect(retried).toBe(0);
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('is BOUNDED: it never asks for more than the batch size', async () => {
      await service.processRetries(new Date());

      expect(prisma.automationExecution.findMany.mock.calls[0][0].take).toBe(RETRY_BATCH_SIZE);
    });

    it('only ever considers RETRYING rows that are due', async () => {
      await service.processRetries(new Date());

      const where = prisma.automationExecution.findMany.mock.calls[0][0].where;
      expect(where.status).toBe(AutomationStatus.RETRYING);
      expect(where.nextAttemptAt).toEqual({ lte: expect.any(Date) });
    });

    it('terminally FAILS a row whose integration was disabled between attempts', async () => {
      prisma.automationExecution.findMany.mockResolvedValue([
        executionRow({ status: AutomationStatus.RETRYING, nextAttemptAt: new Date(0) }),
      ]);
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow({ enabled: false }));

      await service.processRetries(new Date());

      const last = prisma.automationExecution.update.mock.calls.at(-1)![0].data;
      expect(last).toMatchObject({
        status: AutomationStatus.FAILED,
        errorCode: 'INTEGRATION_UNAVAILABLE',
        nextAttemptAt: null,
      });
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('stops at maxAttempts — the attempt budget is real', async () => {
      // attemptCount 2 with maxAttempts 3 means this attempt is the third and last.
      prisma.automationExecution.findMany.mockResolvedValue([
        executionRow({ status: AutomationStatus.RETRYING, attemptCount: 2, nextAttemptAt: new Date(0) }),
      ]);
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow({ maxAttempts: 3 }));
      provider.send.mockResolvedValue({ accepted: false, errorCode: 'TIMEOUT', retryable: true });

      await service.processRetries(new Date());

      const last = prisma.automationExecution.update.mock.calls.at(-1)![0].data;
      // Retryable failure, budget spent -> FAILED, not RETRYING. This is what makes the
      // policy bounded rather than "retryable means forever".
      expect(last).toMatchObject({ status: AutomationStatus.FAILED, nextAttemptAt: null });
    });

    it('rebuilds the envelope from stored contract fields with an EMPTY payload', async () => {
      prisma.automationExecution.findMany.mockResolvedValue([
        executionRow({ status: AutomationStatus.RETRYING, attemptCount: 1, nextAttemptAt: new Date(0) }),
      ]);
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());

      await service.processRetries(new Date());

      const envelope = provider.send.mock.calls[0][1];
      // The payload is deliberately NOT persisted (§19), so a retry redelivers the event
      // IDENTITY rather than the original body. Asserted rather than glossed over.
      expect(envelope.payload).toEqual({});
      expect(envelope.eventId).toBe('evt-1');
      expect(envelope.eventType).toBe('ticket.created');
      expect(envelope.version).toBe(1);
      expect(envelope.tenant).toEqual({ id: 'tenant-1' });
      expect(envelope.correlationId).toBe('corr-1');
    });

    it('survives a throwing attempt without crashing the pass', async () => {
      prisma.automationExecution.findMany.mockResolvedValue([
        executionRow({ status: AutomationStatus.RETRYING, attemptCount: 1, nextAttemptAt: new Date(0) }),
      ]);
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      provider.send.mockRejectedValue(new Error('boom'));

      // An unhandled rejection inside a timer callback terminates the Node process.
      await expect(service.processRetries(new Date())).resolves.toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Callback, tenant isolation, connection test
  // ───────────────────────────────────────────────────────────────────────────

  describe('applyCallback', () => {
    it('marks the located execution COMPLETED and clears retryability', async () => {
      prisma.automationExecution.findUnique.mockResolvedValue({
        id: 'exec-1',
        status: AutomationStatus.SENT,
      });

      const result = await service.applyCallback('N8N', {
        eventId: 'evt-1',
        integration: 'N8N',
        status: 'COMPLETED',
        externalExecutionId: 'n8n-5',
      });

      expect(result).toEqual({
        executionId: 'exec-1',
        status: AutomationStatus.COMPLETED,
        duplicate: false,
      });

      const data = prisma.automationExecution.updateMany.mock.calls[0][0].data;
      expect(data).toMatchObject({
        status: AutomationStatus.COMPLETED,
        externalExecutionId: 'n8n-5',
        nextAttemptAt: null,
      });
      expect(data.completedAt).toBeInstanceOf(Date);
    });

    it('locates the row by (integration, eventId) and by nothing else', async () => {
      prisma.automationExecution.findUnique.mockResolvedValue({
        id: 'exec-1',
        status: AutomationStatus.SENT,
      });

      await service.applyCallback('N8N', {
        eventId: 'evt-1',
        integration: 'N8N',
        status: 'FAILED',
        errorCode: 'WORKFLOW_ERROR',
      });

      // No table, column, filter or operator from the payload participates in the lookup.
      expect(prisma.automationExecution.findUnique.mock.calls[0][0].where).toEqual({
        integration_eventId: { integration: 'N8N', eventId: 'evt-1' },
      });
    });

    it('rejects a body whose integration disagrees with the route', async () => {
      await expect(
        service.applyCallback('N8N', {
          eventId: 'evt-1',
          integration: 'OTHER' as never,
          status: 'COMPLETED',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('404s an unknown event, indistinguishably from a non-existent one', async () => {
      prisma.automationExecution.findUnique.mockResolvedValue(null);

      await expect(
        service.applyCallback('N8N', {
          eventId: 'evt-nope',
          integration: 'N8N',
          status: 'COMPLETED',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('is IDEMPOTENT: a replayed callback returns the existing outcome and writes nothing', async () => {
      prisma.automationExecution.findUnique.mockResolvedValue({
        id: 'exec-1',
        status: AutomationStatus.COMPLETED,
      });

      const result = await service.applyCallback('N8N', {
        eventId: 'evt-1',
        integration: 'N8N',
        // Note the CONFLICTING outcome: a replay cannot flip a completed execution to
        // failed, which is the §26 "duplicate with incompatible payload" case.
        status: 'FAILED',
      });

      expect(result).toEqual({
        executionId: 'exec-1',
        status: AutomationStatus.COMPLETED,
        duplicate: true,
      });
      expect(prisma.automationExecution.updateMany).not.toHaveBeenCalled();
    });

    it('resolves a concurrent double-callback to ONE winner', async () => {
      prisma.automationExecution.findUnique
        .mockResolvedValueOnce({ id: 'exec-1', status: AutomationStatus.SENT })
        .mockResolvedValueOnce({ status: AutomationStatus.COMPLETED });
      // The loser's conditional update matches zero rows.
      prisma.automationExecution.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.applyCallback('N8N', {
        eventId: 'evt-1',
        integration: 'N8N',
        status: 'FAILED',
      });

      expect(result).toMatchObject({ duplicate: true, status: AutomationStatus.COMPLETED });
    });

    it('never writes to a terminal row, enforced in the UPDATE predicate too', async () => {
      prisma.automationExecution.findUnique.mockResolvedValue({
        id: 'exec-1',
        status: AutomationStatus.RETRYING,
      });

      await service.applyCallback('N8N', {
        eventId: 'evt-1',
        integration: 'N8N',
        status: 'COMPLETED',
      });

      expect(prisma.automationExecution.updateMany.mock.calls[0][0].where.status).toEqual({
        notIn: [AutomationStatus.COMPLETED, AutomationStatus.FAILED],
      });
    });
  });

  describe('listExecutions — tenant isolation', () => {
    it('applies the caller tenant unconditionally', async () => {
      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-1',
        startTime: Date.now(),
        userId: 'user-1',
        tenantId: 'tenant-1',
      });

      await service.listExecutions({});

      expect(prisma.automationExecution.findMany.mock.calls[0][0].where).toEqual({
        tenantId: 'tenant-1',
      });
    });

    it('applies `tenantId: null` for a tenant-less caller instead of dropping the filter', async () => {
      RequestContextService.set({
        requestId: 'req-1',
        correlationId: 'corr-1',
        startTime: Date.now(),
        userId: 'user-1',
        tenantId: null,
      });

      await service.listExecutions({});

      // THE isolation bug this asserts against: omitting the predicate for a null tenant
      // would return every tenant-less execution in the database.
      expect(prisma.automationExecution.findMany.mock.calls[0][0].where).toEqual({
        tenantId: null,
      });
    });

    it('caps the page size rather than honouring an arbitrary limit', async () => {
      await service.listExecutions({ limit: 5000 });
      expect(prisma.automationExecution.findMany.mock.calls[0][0].take).toBe(51);

      await service.listExecutions({ limit: -3 });
      expect(prisma.automationExecution.findMany.mock.calls[1][0].take).toBe(2);
    });

    it('does not project tenantId or actorId', async () => {
      prisma.automationExecution.findMany.mockResolvedValue([executionRow()]);

      const { items } = await service.listExecutions({});

      // The tenant is already the filter, and who triggered what belongs in AuditLog
      // behind `admin.audit.read` — not in a delivery list any read-only holder can see.
      expect(items[0]).not.toHaveProperty('tenantId');
      expect(items[0]).not.toHaveProperty('actorId');
      expect(items[0]).not.toHaveProperty('idempotencyKey');
      expect(items[0].eventId).toBe('evt-1');
    });
  });

  describe('testConnection', () => {
    it('sends the PROBE event type, never a domain event', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      await service.testConnection(actor, 'cfg-1');

      const envelope = provider.send.mock.calls[0][1];
      expect(envelope.eventType).toBe('integration.connection.test');
      expect(envelope.payload).toEqual({ probe: true });
      // No tenant, no actor: a test is infrastructure diagnostics (§10).
      expect(envelope.tenant).toEqual({ id: null });
      expect(envelope.actor).toBeUndefined();
    });

    it('writes NO execution row for a test', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      await service.testConnection(actor, 'cfg-1');

      // A test is not a domain event; recording one would pollute the delivery history.
      expect(prisma.automationExecution.create).not.toHaveBeenCalled();
    });

    it('records the outcome on the config row and audits it either way', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());
      provider.send.mockResolvedValue({ accepted: false, errorCode: 'HTTP_500' });

      const result = await service.testConnection(actor, 'cfg-1');

      expect(result.status).toBe('FAILURE');
      expect(prisma.integrationConfig.update.mock.calls[0][0].data).toMatchObject({
        lastTestStatus: 'FAILURE',
      });

      const testAudit = audit.log.mock.calls.find(
        (call) => call[0].action === 'INTEGRATION_CONNECTION_TESTED',
      );
      expect(testAudit).toBeDefined();
      expect(testAudit![0].success).toBe(false);
    });

    it('returns a message with no upstream detail in it', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());
      provider.send.mockResolvedValue({ accepted: false, errorCode: 'HTTP_401' });

      const result = await service.testConnection(actor, 'cfg-1');

      // A status code would distinguish "no such workflow" from "signature rejected"
      // from "engine down" — a probe for the operator's infrastructure.
      expect(result.message).not.toContain('401');
      expect(result.message).not.toContain('HTTP');
    });

    it('reports FAILURE without dispatching when no secret is stored', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(
        configRow({ secretCiphertext: null, secretIv: null, secretAuthTag: null }),
      );
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      const result = await service.testConnection(actor, 'cfg-1');

      expect(result.status).toBe('FAILURE');
      expect(provider.send).not.toHaveBeenCalled();
    });

    it('reports FAILURE without dispatching when the URL policy refuses the target', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(
        configRow({ baseUrl: 'http://169.254.169.254' }),
      );
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      const result = await service.testConnection(actor, 'cfg-1');

      expect(result.status).toBe('FAILURE');
      expect(provider.send).not.toHaveBeenCalled();
    });
  });
  // ───────────────────────────────────────────────────────────────────────────
  // 49M-2 — the lifecycle timeline
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * WHY THESE ASSERT THE PAYLOAD AND NOT THE CALL COUNT ALONE: the dependency is `@Optional()`,
   * so a spec that forgot to register it would get a silent no-op and a green suite. Every test
   * below reads the emitted `eventType`, `phase` and `detail`, which an absent sink cannot
   * satisfy.
   *
   * `lifecycle.integration` IS THE ASSERTED METHOD, not `lifecycle.record`: the domain facade is
   * what stamps `domain: 'INTEGRATION'` and `subjectType`, so a caller reaching for `record`
   * directly would be free to mislabel the row.
   */
  describe('lifecycle emission', () => {
    const firstCall = () => {
      const [eventType, phase, subject, extra] = lifecycle.integration.mock.calls[0] as [
        string,
        string,
        { id?: string; key?: string },
        { actorType?: string; actorId?: string | null; outcomeCode?: string | null; detail?: Record<string, unknown> },
      ];

      return { eventType, phase, subject, extra };
    };

    it('emits config.created as SUCCEEDED, keyed by BOTH the row id and the engine', async () => {
      prisma.integrationConfig.create.mockResolvedValue(configRow({ enabled: false }));

      await service.createConfig(actor, {
        integration: 'N8N',
        baseUrl: 'https://automation.example.com',
        webhookPath: '/webhook/aria',
        secret: SECRET,
      });

      expect(lifecycle.integration).toHaveBeenCalledTimes(1);

      const { eventType, phase, subject, extra } = firstCall();

      expect(eventType).toBe('integration.config.created');
      expect(phase).toBe('SUCCEEDED');
      // `id` keeps the row joinable with core_db; `key` makes a per-engine timeline readable
      // WITHOUT that join, which is the whole reason both are carried.
      expect(subject).toEqual({ id: 'cfg-1', key: 'N8N' });
      expect(extra.actorType).toBe('USER');
      expect(extra.actorId).toBe(actor);
      expect(extra.detail).toEqual({ integration: 'N8N', enabled: false, hasSecret: true });
    });

    it('emits NOTHING when the create is rejected by the database', async () => {
      prisma.integrationConfig.create.mockRejectedValue(uniqueViolation());

      await expect(
        service.createConfig(actor, {
          integration: 'N8N',
          baseUrl: 'https://automation.example.com',
          webhookPath: '/webhook/aria',
        }),
      ).rejects.toMatchObject({ status: 409 });

      // A timeline that announces a config nobody created is worse than a silent one: the
      // emission sits after the write, inside the try, for exactly this reason.
      expect(lifecycle.integration).not.toHaveBeenCalled();
    });

    it('emits NOTHING when a write path 404s before it mutates anything', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(null);

      await expect(service.updateConfig(actor, 'missing', { enabled: false })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.deleteConfig(actor, 'missing')).rejects.toThrow(NotFoundException);
      await expect(service.rotateSecret(actor, 'missing')).rejects.toThrow(NotFoundException);
      await expect(service.testConnection(actor, 'missing')).rejects.toThrow(NotFoundException);

      expect(lifecycle.integration).not.toHaveBeenCalled();
    });

    it('emits NOTHING for a no-op PATCH, which mutated no state to record', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());

      await service.updateConfig(actor, 'cfg-1', {});

      expect(prisma.integrationConfig.update).not.toHaveBeenCalled();
      expect(lifecycle.integration).not.toHaveBeenCalled();
    });

    it('names an ENABLE as its own transition rather than a generic update', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow({ enabled: false }));
      prisma.integrationConfig.update.mockResolvedValue(configRow({ enabled: true }));

      await service.updateConfig(actor, 'cfg-1', { enabled: true });

      const { eventType, phase, extra } = firstCall();

      expect(eventType).toBe('integration.config.enabled');
      expect(phase).toBe('SUCCEEDED');
      expect(extra.detail).toMatchObject({ enabled: true, secretRotated: false });
    });

    it('names a DISABLE as its own transition', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow({ enabled: true }));
      prisma.integrationConfig.update.mockResolvedValue(configRow({ enabled: false }));

      await service.updateConfig(actor, 'cfg-1', { enabled: false });

      expect(firstCall().eventType).toBe('integration.config.disabled');
    });

    it('reports a PATCH that did not move `enabled` as a generic update', async () => {
      // `enabled: true` on a row already enabled is not a transition, so the specific event
      // name would be a lie: `enabledChanged` compares against the BEFORE row, not `undefined`.
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow({ enabled: true }));
      prisma.integrationConfig.update.mockResolvedValue(configRow({ enabled: true }));

      await service.updateConfig(actor, 'cfg-1', { enabled: true });

      expect(firstCall().eventType).toBe('integration.config.updated');
    });

    it('emits ONE row for an enable that also rotates, with the rotation in detail', async () => {
      // Three audit rows are written for this call. A second lifecycle row would make the
      // timeline claim two transitions where the operator performed one.
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow({ enabled: false }));
      prisma.integrationConfig.update.mockResolvedValue(configRow({ enabled: true }));

      await service.updateConfig(actor, 'cfg-1', { enabled: true, secret: SECRET });

      expect(lifecycle.integration).toHaveBeenCalledTimes(1);

      const { eventType, extra } = firstCall();

      // The enable OUTRANKS the rotation as the event type; the rotation survives in detail.
      expect(eventType).toBe('integration.config.enabled');
      expect(extra.detail).toMatchObject({ secretRotated: true });

      // Three audit actions, one lifecycle row: the two trails answer different questions.
      const actions = audit.log.mock.calls.map((call) => call[0].action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'INTEGRATION_UPDATED',
          'INTEGRATION_ENABLED',
          'INTEGRATION_SECRET_ROTATED',
        ]),
      );
    });

    it('carries changed field NAMES and never the endpoint value', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(
        configRow({ baseUrl: 'https://moved.example.com' }),
      );

      await service.updateConfig(actor, 'cfg-1', { baseUrl: 'https://moved.example.com' });

      const { eventType, extra } = firstCall();

      expect(eventType).toBe('integration.config.updated');
      expect(extra.detail).toMatchObject({ changedFields: ['baseUrl'] });
      // §39 keeps endpoints out of the lifecycle trail; the audit row is where an
      // investigator reads the URL.
      expect(JSON.stringify(extra)).not.toContain('moved.example.com');
    });

    it('records a rotation as a fact and never the generated secret', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      const { secret } = await service.rotateSecret(actor, 'cfg-1');

      const { eventType, phase, extra } = firstCall();

      expect(eventType).toBe('integration.config.secret_rotated');
      expect(phase).toBe('SUCCEEDED');
      expect(extra.detail).toEqual({ integration: 'N8N', generated: true });
      // This table is read by an operator-facing timeline, so a credential here would be a
      // disclosure through a surface DESIGNED to be displayed.
      expect(JSON.stringify(lifecycle.integration.mock.calls[0])).not.toContain(secret);
    });

    it('records a delete WITHOUT the endpoint the audit row keeps', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow({ enabled: true }));
      prisma.integrationConfig.delete.mockResolvedValue(configRow());

      await service.deleteConfig(actor, 'cfg-1');

      const { eventType, extra } = firstCall();

      expect(eventType).toBe('integration.config.deleted');
      expect(extra.detail).toEqual({ integration: 'N8N', wasEnabled: true });
      expect(JSON.stringify(extra)).not.toContain('automation.example.com');

      // The audit trail DOES carry it. The divergence between the two sinks is deliberate.
      const deleted = audit.log.mock.calls.find(
        (call) => call[0].action === 'INTEGRATION_DELETED',
      );
      expect(deleted?.[0].newValue.baseUrl).toBe('https://automation.example.com');
    });

    it('emits a successful connection test as SUCCEEDED, keeping SUCCESS verbatim', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      await service.testConnection(actor, 'cfg-1');

      const { eventType, phase, extra } = firstCall();

      expect(eventType).toBe('integration.connection.tested');
      expect(phase).toBe('SUCCEEDED');
      // `phase` is the normalized answer; `outcomeCode` keeps this domain's own word for it.
      expect(extra.outcomeCode).toBe('SUCCESS');
      expect(extra.detail).toEqual({ integration: 'N8N', enabled: true });
    });

    it('emits a rejected connection test as FAILED, with no upstream detail or UI string', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());
      provider.send.mockResolvedValue({ accepted: false, errorCode: 'HTTP_401' });

      const result = await service.testConnection(actor, 'cfg-1');

      const { phase, extra } = firstCall();

      expect(phase).toBe('FAILED');
      expect(extra.outcomeCode).toBe('FAILURE');

      const emitted = JSON.stringify(lifecycle.integration.mock.calls[0]);
      expect(emitted).not.toContain('HTTP_401');
      // The Persian operator message is a UI string, not timeline content.
      expect(emitted).not.toContain(result.message);
    });

    it('emits a connection test that THREW upstream as FAILED, without the error text', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(configRow());
      prisma.integrationConfig.update.mockResolvedValue(configRow());
      // An `err.message` here can carry the full URL, which is why the emission reads
      // `result.status` rather than the error.
      provider.send.mockRejectedValue(new Error('connect ECONNREFUSED automation.example.com'));

      await expect(service.testConnection(actor, 'cfg-1')).resolves.toMatchObject({
        status: 'FAILURE',
      });

      const { phase, extra } = firstCall();

      expect(phase).toBe('FAILED');
      expect(extra.outcomeCode).toBe('FAILURE');
      expect(JSON.stringify(lifecycle.integration.mock.calls[0])).not.toContain('ECONNREFUSED');
    });

    it('emits a FAILED test when the URL policy refuses the target, without dispatching', async () => {
      prisma.integrationConfig.findUnique.mockResolvedValue(
        configRow({ baseUrl: 'http://169.254.169.254' }),
      );
      prisma.integrationConfig.update.mockResolvedValue(configRow());

      await service.testConnection(actor, 'cfg-1');

      const { phase, extra } = firstCall();

      expect(phase).toBe('FAILED');
      expect(provider.send).not.toHaveBeenCalled();
      // The refused address is NOT in the row: an SSRF probe result that echoed the target
      // would put the operator's internal addressing into a displayed timeline.
      expect(JSON.stringify(extra)).not.toContain('169.254.169.254');
    });

    it('does NOT emit per dispatched event — that is what AutomationExecution is for', async () => {
      prisma.integrationConfig.findFirst.mockResolvedValue(configRow());
      prisma.automationExecution.create.mockResolvedValue({
        id: 'exec-1',
        status: AutomationStatus.PENDING,
      });

      await service.trigger({
        eventType: 'ticket.created',
        source: 'support',
        payload: { ticketId: 't-1' },
      });

      // A lifecycle row per automated event is exactly the high-cardinality noise that put
      // observability in its own database.
      expect(lifecycle.integration).not.toHaveBeenCalled();
    });

    it('never writes into another domain’s timeline', async () => {
      prisma.integrationConfig.create.mockResolvedValue(configRow());

      await service.createConfig(actor, {
        integration: 'N8N',
        baseUrl: 'https://automation.example.com',
        webhookPath: '/webhook/aria',
      });

      // Reaching `record` directly would let this service stamp its own `domain` and
      // `subjectType`, which is how an INTEGRATION row ends up filed under MODULE.
      expect(lifecycle.record).not.toHaveBeenCalled();
      expect(lifecycle.module).not.toHaveBeenCalled();
      expect(lifecycle.provisioning).not.toHaveBeenCalled();
    });

    it('completes the mutation when the emission itself throws', async () => {
      // The facade's `void` return defends against a REJECTED promise; the try/catch in
      // `emitLifecycle` defends against a SYNCHRONOUS throw, which is what this reproduces.
      lifecycle.integration.mockImplementation(() => {
        throw new Error('observability down');
      });
      prisma.integrationConfig.create.mockResolvedValue(configRow());

      await expect(
        service.createConfig(actor, {
          integration: 'N8N',
          baseUrl: 'https://automation.example.com',
          webhookPath: '/webhook/aria',
        }),
      ).resolves.toMatchObject({ id: 'cfg-1' });
    });

    it('completes the mutation when observability is not wired at all', async () => {
      // The `@Optional()` contract asserted rather than assumed: observability is optional
      // infrastructure, and a business mutation must not depend on its presence.
      const trimmed = await Test.createTestingModule({
        providers: [
          IntegrationService,
          IntegrationProviderRegistry,
          { provide: PrismaService, useValue: prisma },
          { provide: CryptoService, useValue: crypto },
          { provide: AuditService, useValue: audit },
          { provide: N8nIntegrationProvider, useValue: provider },
        ],
      }).compile();

      prisma.integrationConfig.create.mockResolvedValue(configRow());

      await expect(
        trimmed.get(IntegrationService).createConfig(actor, {
          integration: 'N8N',
          baseUrl: 'https://automation.example.com',
          webhookPath: '/webhook/aria',
        }),
      ).resolves.toMatchObject({ id: 'cfg-1' });
    });
  });


});







