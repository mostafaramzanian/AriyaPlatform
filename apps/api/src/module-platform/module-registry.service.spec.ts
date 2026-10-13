import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { AuditService } from '../common/audit.service';
import { RequestContextService } from '../common/request-context.service';
import { ObservabilityLifecycleService } from '../observability/observability-lifecycle.service';
import {
  ModuleRegistryService,
  MAX_CAPABILITY_CREDENTIAL_PAGE,
  STALE_SWEEP_BATCH,
} from './module-registry.service';
import { ALLOW_PRIVATE_ENV_VAR } from '../integrations/integration-url.guard';
import {
  CORE_MODULE_CONTRACT,
  MODULE_PROTOCOL_VERSION,
  MODULE_STALE_AFTER_MS,
} from './module.contract';

/**
 * Phase 49M: the domain rules of the module platform.
 *
 * WHAT THIS FILE PROVES, AND WHY EACH ONE IS HERE RATHER THAN ASSUMED:
 *
 *  - NO MODULE IS ASSUMED LOCAL OR REMOTE. The registration path is exercised with all four
 *    deployment modes and asserted to take the SAME decisions in each: same lifecycle, same
 *    health, same audit shape. That is the phase's central requirement, and it is the one a
 *    future edit is most likely to break by adding "just one" special case.
 *  - NO BUSINESS MODULE IS NAMED. Two registrations with different domain-flavoured ids are
 *    asserted to be handled identically.
 *  - THE CREDENTIAL NEVER LEAVES. Every projection is inspected for the three envelope columns.
 *  - A MODULE CANNOT ELEVATE ITSELF. A registration for a DISABLED module yields a DISABLED
 *    instance, and a heartbeat cannot move an INCOMPATIBLE or DISABLED one.
 *  - INCOMPATIBLE IS RECORDED, NOT PARTIALLY ACTIVATED (§18).
 *  - TENANT IS NEVER WIDENED (§21). Resolution is exercised with a null tenant against both
 *    scopes, because dropping a null tenant is how a restricted module becomes global.
 *  - RESOLUTION NEVER THROWS (§27) and never returns a stale, endpoint-less or contract-mismatched
 *    instance.
 */

const CIPHER = { ciphertext: 'ENVELOPE-CIPHERTEXT', iv: 'ENVELOPE-IV', authTag: 'ENVELOPE-TAG' };
const SECRET = 'a'.repeat(64);

const registrationRow = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  moduleId: 'finance',
  displayName: 'Finance',
  moduleType: 'BUSINESS',
  enabled: true,
  tenantScope: 'ALL',
  tenantIds: [],
  protocolVersion: MODULE_PROTOCOL_VERSION,
  secretCiphertext: CIPHER.ciphertext,
  secretIv: CIPHER.iv,
  secretAuthTag: CIPHER.authTag,
  secretUpdatedAt: new Date('2026-09-05T00:00:00.000Z'),
  secretExpiresAt: null,
  createdAt: new Date('2026-09-05T00:00:00.000Z'),
  updatedAt: new Date('2026-09-05T00:00:00.000Z'),
  instances: [],
  ...overrides,
});

const instanceRow = (overrides: Record<string, unknown> = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  registrationId: '11111111-1111-4111-8111-111111111111',
  instanceId: 'finance-prod-01',
  moduleId: 'finance',
  deploymentMode: 'REMOTE',
  version: '1.2.0',
  baseUrl: 'https://finance.example.com',
  healthPath: '/health',
  capabilities: ['invoice.read'],
  apiContracts: [CORE_MODULE_CONTRACT],
  eventContracts: [],
  lifecycle: 'ACTIVE',
  health: 'HEALTHY',
  healthErrorCode: null,
  lastSeenAt: new Date(),
  lastProbedAt: null,
  createdAt: new Date('2026-09-05T00:00:00.000Z'),
  updatedAt: new Date('2026-09-05T00:00:00.000Z'),
  ...overrides,
});

const capabilityCredentialRow = (overrides: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  moduleId: 'finance',
  capability: 'platform.identity@v1',
  secretCiphertext: CIPHER.ciphertext,
  secretIv: CIPHER.iv,
  secretAuthTag: CIPHER.authTag,
  secretUpdatedAt: new Date('2026-09-05T00:00:00.000Z'),
  secretExpiresAt: null,
  createdAt: new Date('2026-09-05T00:00:00.000Z'),
  updatedAt: new Date('2026-09-05T00:00:00.000Z'),
  ...overrides,
});

const registerDto = (overrides: Record<string, unknown> = {}) => ({
  moduleId: 'finance',
  instanceId: 'finance-prod-01',
  version: '1.2.0',
  deploymentMode: 'REMOTE' as const,
  baseUrl: 'https://finance.example.com',
  healthPath: '/health',
  capabilities: ['invoice.read'],
  apiContracts: [CORE_MODULE_CONTRACT],
  eventContracts: [],
  protocolVersion: MODULE_PROTOCOL_VERSION,
  ...overrides,
});

const uniqueViolation = () => Object.assign(new Error('unique'), { code: 'P2002' });

describe('ModuleRegistryService', () => {
  let service: ModuleRegistryService;
  let prisma: {
    moduleRegistration: Record<string, jest.Mock>;
    moduleInstance: Record<string, jest.Mock>;
    moduleCapabilityCredential: Record<string, jest.Mock>;
    /** §45.4 item 4 — the membership read `resolve()` makes for `RESTRICTED_MEMBERS`. */
    moduleRegistrationTenant: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };
  let crypto: { encrypt: jest.Mock; decrypt: jest.Mock };
  let audit: { log: jest.Mock };
  /**
   * 49M-2. The FULL facade is stubbed, not only the `module` method this service uses: a partial
   * stub would turn a misdirected emission into a TypeError instead of a failed assertion.
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
      moduleRegistration: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      // §45.4 item 4. Stubbed for the same reason the delegates above are: `resolve()` reads
      // this table for `RESTRICTED_MEMBERS`, and a missing stub must fail a test rather than
      // look like "no membership".
      moduleRegistrationTenant: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      // ADR-0006 A8. Stubbed as a full delegate for the same reason `lifecycle` above is: a
      // missing method must fail a test, not silently produce `undefined`.
      moduleCapabilityCredential: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      moduleInstance: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // Runs the callback against the same mock client, which is what the real
      // `$transaction(async tx => …)` does from the service's point of view.
      $transaction: jest.fn((callback: (tx: unknown) => unknown) => callback(prisma)),
    };

    crypto = {
      encrypt: jest.fn().mockReturnValue(CIPHER),
      decrypt: jest.fn().mockReturnValue(SECRET),
    };

    audit = { log: jest.fn().mockResolvedValue(undefined) };

    lifecycle = {
      record: jest.fn(),
      integration: jest.fn(),
      module: jest.fn(),
      provisioning: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModuleRegistryService,
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: crypto },
        { provide: AuditService, useValue: audit },
        // Registered for the whole file. The service takes this `@Optional()`, so omitting it
        // would make every lifecycle assertion below pass against a silent no-op.
        { provide: ObservabilityLifecycleService, useValue: lifecycle },
      ],
    }).compile();

    service = moduleRef.get(ModuleRegistryService);

    // Public HTTPS endpoints are used throughout, so the flag's value is not what these tests
    // exercise — but it must be deterministic.
    process.env[ALLOW_PRIVATE_ENV_VAR] = 'false';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env[ALLOW_PRIVATE_ENV_VAR];
    else process.env[ALLOW_PRIVATE_ENV_VAR] = originalFlag;

    jest.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Deployment neutrality — the phase's central requirement
  // ─────────────────────────────────────────────────────────────────────────────

  describe('deployment neutrality', () => {
    it('registers identically in ALL FOUR deployment modes', async () => {
      // CASE A..F of the mission, reduced to its essential assertion: the mode changes what is
      // STORED and nothing about what is DECIDED.
      //
      // Private targets are allowed here because the LOCAL leg uses a loopback endpoint, which is
      // the realistic local topology. That flag is a NETWORK policy, and the point of this test is
      // that it is the only thing the mode influences.
      process.env[ALLOW_PRIVATE_ENV_VAR] = 'true';

      for (const mode of ['LOCAL', 'REMOTE', 'CENTRAL', 'HYBRID'] as const) {
        prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
        prisma.moduleInstance.upsert.mockClear();

        const baseUrl = mode === 'LOCAL' ? 'http://localhost:5010' : 'https://finance.example.com';
        const result = await service.registerInstance(
          registerDto({ deploymentMode: mode, baseUrl })
        );

        expect(result.accepted).toBe(true);
        expect(result.lifecycle).toBe('ACTIVE');

        const written = prisma.moduleInstance.upsert.mock.calls[0][0];
        expect(written.create.deploymentMode).toBe(mode);
        // Same lifecycle and same health for every mode: no branch anywhere reads the mode to
        // decide these.
        expect(written.create.lifecycle).toBe('ACTIVE');
        expect(written.create.health).toBe('UNKNOWN');
      }
    });

    it('treats a LOCAL instance with NO endpoint as valid', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      const result = await service.registerInstance(
        registerDto({ deploymentMode: 'LOCAL', baseUrl: undefined })
      );

      expect(result.accepted).toBe(true);
      expect(prisma.moduleInstance.upsert.mock.calls[0][0].create.baseUrl).toBeNull();
    });

    it('refuses an off-host instance whose endpoint the policy rejects', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      const result = await service.registerInstance(
        registerDto({ deploymentMode: 'REMOTE', baseUrl: 'http://finance.example.com' })
      );

      expect(result).toMatchObject({
        accepted: false,
        lifecycle: 'INCOMPATIBLE',
        reason: 'ENDPOINT_REJECTED',
      });

      // NOTHING IS STORED for a rejected endpoint: the policy runs before any write.
      expect(prisma.moduleInstance.upsert).not.toHaveBeenCalled();
    });

    it('handles two differently-named modules identically', async () => {
      // No business-domain special case: `finance` and `sprockets` must take the same path.
      const outcomes: unknown[] = [];

      for (const moduleId of ['finance', 'sprockets']) {
        prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow({ moduleId }));
        prisma.moduleInstance.upsert.mockClear();

        const result = await service.registerInstance(
          registerDto({ moduleId, instanceId: `${moduleId}-01` })
        );

        outcomes.push({
          accepted: result.accepted,
          lifecycle: result.lifecycle,
          stored: prisma.moduleInstance.upsert.mock.calls[0][0].create.lifecycle,
        });
      }

      expect(outcomes[0]).toEqual(outcomes[1]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // §7/§8/§18 — registration cannot elevate, and INCOMPATIBLE is recorded
  // ─────────────────────────────────────────────────────────────────────────────

  describe('registerInstance', () => {
    it('refuses an unknown module rather than creating one', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);

      await expect(service.registerInstance(registerDto())).rejects.toThrow(NotFoundException);
      expect(prisma.moduleInstance.upsert).not.toHaveBeenCalled();
    });

    it('yields a DISABLED instance for a module an administrator has not enabled', async () => {
      // §7: no trusted status without admission. A module cannot bring itself online.
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow({ enabled: false }));

      const result = await service.registerInstance(registerDto());

      expect(result).toMatchObject({
        accepted: true,
        lifecycle: 'DISABLED',
        reason: 'MODULE_DISABLED',
      });
      expect(prisma.moduleInstance.upsert.mock.calls[0][0].create.health).toBe('DISABLED');
    });

    it('records an INCOMPATIBLE instance for a protocol mismatch, without activating it', async () => {
      // §18: no partial activation, and the row EXISTS so an operator can see why.
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      const result = await service.registerInstance(
        registerDto({ protocolVersion: MODULE_PROTOCOL_VERSION + 1 })
      );

      expect(result).toMatchObject({
        accepted: false,
        lifecycle: 'INCOMPATIBLE',
        reason: 'PROTOCOL_MISMATCH',
      });

      const written = prisma.moduleInstance.upsert.mock.calls[0][0].create;
      expect(written.lifecycle).toBe('INCOMPATIBLE');
      expect(written.health).toBe('UNAVAILABLE');
      expect(written.healthErrorCode).toBe('PROTOCOL_MISMATCH');
    });

    it('records INCOMPATIBLE when the base contract is absent', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      const result = await service.registerInstance(registerDto({ apiContracts: ['other@v1'] }));

      expect(result).toMatchObject({ accepted: false, reason: 'CONTRACT_MISSING' });
    });

    it('never reads enabled/tenant scope from the request', async () => {
      // The DTO has no such fields; this asserts the SERVICE does not invent them either, by
      // passing them anyway and checking they reach neither the write nor the decision.
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow({ enabled: false }));

      const smuggled = {
        ...registerDto(),
        enabled: true,
        tenantScope: 'ALL',
        tenantIds: ['tenant-9'],
      } as never;

      const result = await service.registerInstance(smuggled);

      expect(result.lifecycle).toBe('DISABLED');

      const written = prisma.moduleInstance.upsert.mock.calls[0][0].create;
      expect(written).not.toHaveProperty('enabled');
      expect(written).not.toHaveProperty('tenantScope');
      expect(written).not.toHaveProperty('tenantIds');
    });

    it('upserts on instanceId, so a restart does not duplicate the instance', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await service.registerInstance(registerDto());

      expect(prisma.moduleInstance.upsert.mock.calls[0][0].where).toEqual({
        instanceId: 'finance-prod-01',
      });
    });

    it('audits the announcement with no credential in the payload', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await service.registerInstance(registerDto());

      const logged = JSON.stringify(audit.log.mock.calls[0][0]);
      expect(logged).toContain('MODULE_INSTANCE_REGISTERED');
      expect(logged).not.toContain(CIPHER.ciphertext);
      expect(logged).not.toContain(SECRET);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // §11/§12/§21 — discovery
  // ─────────────────────────────────────────────────────────────────────────────

  describe('resolve', () => {
    const resolvable = (instances: unknown[], overrides: Record<string, unknown> = {}) => ({
      enabled: true,
      tenantScope: 'ALL',
      tenantIds: [],
      instances,
      ...overrides,
    });

    it('returns a healthy instance for an enabled module', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(resolvable([instanceRow()]));

      const result = await service.resolve('finance', CORE_MODULE_CONTRACT);

      expect(result.ok).toBe(true);
      expect(result.instance).toMatchObject({ instanceId: 'finance-prod-01', moduleId: 'finance' });
    });

    it('never returns a credential on the resolved instance', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(resolvable([instanceRow()]));

      const result = await service.resolve('finance');

      // Structural, not filtered: `ResolvedModuleInstance` has no secret field at all.
      expect(JSON.stringify(result.instance)).not.toContain(CIPHER.ciphertext);
      expect(result.instance).not.toHaveProperty('secretCiphertext');
    });

    it('does not throw for any failure state', async () => {
      // §27: an unavailable module is a normal state of a distributed system.
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);
      await expect(service.resolve('finance')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_NOT_FOUND',
      });

      prisma.moduleRegistration.findUnique.mockResolvedValue(resolvable([], { enabled: false }));
      await expect(service.resolve('finance')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_DISABLED',
      });

      prisma.moduleRegistration.findUnique.mockResolvedValue(resolvable([]));
      await expect(service.resolve('finance')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_UNAVAILABLE',
      });
    });

    it('skips a STALE instance rather than returning it hopefully', async () => {
      const stale = instanceRow({
        lastSeenAt: new Date(Date.now() - MODULE_STALE_AFTER_MS - 1_000),
      });

      prisma.moduleRegistration.findUnique.mockResolvedValue(resolvable([stale]));

      await expect(service.resolve('finance')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_UNAVAILABLE',
      });
    });

    it('skips an instance that has never been seen', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        resolvable([instanceRow({ lastSeenAt: null })])
      );

      await expect(service.resolve('finance')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_UNAVAILABLE',
      });
    });

    it('skips a transport-requiring instance with no endpoint', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        resolvable([instanceRow({ deploymentMode: 'REMOTE', baseUrl: null })])
      );

      await expect(service.resolve('finance')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_UNAVAILABLE',
      });
    });

    it('distinguishes a contract mismatch from plain unavailability', async () => {
      // Different operator actions: upgrade the module vs restart it.
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        resolvable([instanceRow({ apiContracts: ['module.invoke@v2'] })])
      );

      await expect(service.resolve('finance', CORE_MODULE_CONTRACT)).resolves.toEqual({
        ok: false,
        failure: 'CONTRACT_UNSUPPORTED',
      });
    });

    it('supports SEVERAL instances of one logical module', async () => {
      // §12: the model must not prevent it. Two candidates, and one is chosen.
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        resolvable([
          instanceRow({ instanceId: 'finance-prod-01' }),
          instanceRow({ instanceId: 'finance-prod-02', id: 'other-id' }),
        ])
      );

      const result = await service.resolve('finance');

      expect(result.ok).toBe(true);
      expect(['finance-prod-01', 'finance-prod-02']).toContain(result.instance?.instanceId);
    });
  });

  describe('resolve — tenant scope (§21)', () => {
    const restricted = (instances: unknown[]) => ({
      enabled: true,
      tenantScope: 'RESTRICTED',
      tenantIds: ['tenant-1'],
      instances,
    });

    afterEach(() => {
      RequestContextService.set({
        requestId: 'r',
        correlationId: 'c',
        startTime: Date.now(),
        tenantId: null,
      });
    });

    it('admits a caller whose tenant is in the list', async () => {
      RequestContextService.set({
        requestId: 'r',
        correlationId: 'c',
        startTime: Date.now(),
        tenantId: 'tenant-1',
      });

      prisma.moduleRegistration.findUnique.mockResolvedValue(restricted([instanceRow()]));

      await expect(service.resolve('finance')).resolves.toMatchObject({ ok: true });
    });

    it('refuses a caller from another tenant', async () => {
      RequestContextService.set({
        requestId: 'r',
        correlationId: 'c',
        startTime: Date.now(),
        tenantId: 'tenant-2',
      });

      prisma.moduleRegistration.findUnique.mockResolvedValue(restricted([instanceRow()]));

      await expect(service.resolve('finance')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });
    });

    it('refuses a TENANT-LESS caller against a restricted module', async () => {
      // THE LOAD-BEARING TENANT ASSERTION. `null` is its own value, never "any tenant": treating a
      // missing tenant as a wildcard is how a restricted module silently becomes global.
      RequestContextService.set({
        requestId: 'r',
        correlationId: 'c',
        startTime: Date.now(),
        tenantId: null,
      });

      prisma.moduleRegistration.findUnique.mockResolvedValue(restricted([instanceRow()]));

      await expect(service.resolve('finance')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });
    });

    it('admits a tenant-less caller against an ALL-scoped module', async () => {
      RequestContextService.set({
        requestId: 'r',
        correlationId: 'c',
        startTime: Date.now(),
        tenantId: null,
      });

      prisma.moduleRegistration.findUnique.mockResolvedValue({
        enabled: true,
        tenantScope: 'ALL',
        tenantIds: [],
        instances: [instanceRow()],
      });

      await expect(service.resolve('finance')).resolves.toMatchObject({ ok: true });

      // §45.4 item 3 — "the registry's own one-query property is preserved for every module
      // that has not opted into RESTRICTED_MEMBERS". Asserted rather than asserted-in-prose.
      expect(prisma.moduleRegistrationTenant.findUnique).not.toHaveBeenCalled();
    });

    // ───────────────────────────────────────────────────────────────────────────
    // §45.4 item 3 / §45.8 service spec — RESTRICTED_MEMBERS, the third member
    // ───────────────────────────────────────────────────────────────────────────
    //
    // The member exists because a `RESTRICTED` row cannot enumerate more than 64 tenants,
    // and its whole claim is that membership is read from ONE place. These four tests are
    // that claim: the child table admits, its ABSENCE refuses even when the legacy array
    // names the tenant, a tenant-less caller is refused without a lookup, and the ALL path
    // stays query-free.
    const membershipScoped = (instances: unknown[], tenantIds: string[] = []) => ({
      id: 'reg-hr',
      enabled: true,
      tenantScope: 'RESTRICTED_MEMBERS',
      tenantIds,
      instances,
    });

    const asTenant = (tenantId: string | null) =>
      RequestContextService.set({
        requestId: 'r',
        correlationId: 'c',
        startTime: Date.now(),
        tenantId,
      });

    it('admits a caller with a membership row, and asks by the composite unique key', async () => {
      asTenant('tenant-1');
      prisma.moduleRegistration.findUnique.mockResolvedValue(membershipScoped([instanceRow()]));
      prisma.moduleRegistrationTenant.findUnique.mockResolvedValue({ id: 'membership-1' });

      await expect(service.resolve('hr')).resolves.toMatchObject({ ok: true });

      expect(prisma.moduleRegistrationTenant.findUnique).toHaveBeenCalledWith({
        where: { registrationId_tenantId: { registrationId: 'reg-hr', tenantId: 'tenant-1' } },
        select: { id: true },
      });
    });

    it('refuses a caller with NO membership row even when the legacy array names them', async () => {
      // THE LOAD-BEARING ASSERTION OF D16. `tenantIds` is required to be empty for this scope
      // by `ModuleRegistration_tenantScope_consistent`, so a non-empty one cannot occur in the
      // database — and if it did, it must NOT be a second membership source. The array is
      // ignored for this scope and the missing membership row refuses.
      asTenant('tenant-1');
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        membershipScoped([instanceRow()], ['tenant-1'])
      );
      prisma.moduleRegistrationTenant.findUnique.mockResolvedValue(null);

      await expect(service.resolve('hr')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });

      // The array really does name the caller: the refusal cannot be an accident of a
      // tenant-less context or of a different tenant id.
      expect(prisma.moduleRegistrationTenant.findUnique).toHaveBeenCalledTimes(1);
    });

    it('refuses a TENANT-LESS caller without consulting the membership table', async () => {
      // "No tenant" is not a member of any enumeration, and the lookup is skipped rather than
      // made with a null key: a grant is a per-tenant row and there is no tenant to match.
      asTenant(null);
      prisma.moduleRegistration.findUnique.mockResolvedValue(membershipScoped([instanceRow()]));

      await expect(service.resolve('hr')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });

      expect(prisma.moduleRegistrationTenant.findUnique).not.toHaveBeenCalled();
    });

    it('refuses an UNRECOGNISED scope instead of admitting it', async () => {
      // Unreachable while the enum has three members, and here for the reason §45.4 exists:
      // `resolve()` used to admit any scope it did not recognise. A scope that arrives without
      // a membership rule must close the door, which is what the `default` branch does.
      asTenant('tenant-1');
      prisma.moduleRegistration.findUnique.mockResolvedValue({
        id: 'reg-hr',
        enabled: true,
        tenantScope: 'FUTURE_SCOPE',
        tenantIds: ['tenant-1'],
        instances: [instanceRow()],
      });

      await expect(service.resolve('hr')).resolves.toEqual({
        ok: false,
        failure: 'MODULE_FORBIDDEN',
      });

      expect(prisma.moduleRegistrationTenant.findUnique).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Admin writes, projections and the credential boundary
  // ─────────────────────────────────────────────────────────────────────────────

  describe('admin writes', () => {
    it('creates a registration disabled by default', async () => {
      prisma.moduleRegistration.create.mockResolvedValue(registrationRow({ enabled: false }));

      await service.createRegistration(actor, { moduleId: 'finance', displayName: 'Finance' });

      expect(prisma.moduleRegistration.create.mock.calls[0][0].data).toMatchObject({
        enabled: false,
        tenantScope: 'ALL',
        tenantIds: [],
      });
    });

    it('refuses RESTRICTED with an empty tenant list', async () => {
      await expect(
        service.createRegistration(actor, {
          moduleId: 'finance',
          displayName: 'Finance',
          tenantScope: 'RESTRICTED',
          tenantIds: [],
        })
      ).rejects.toThrow(BadRequestException);

      expect(prisma.moduleRegistration.create).not.toHaveBeenCalled();
    });

    it('clears the tenant list when scope becomes ALL', async () => {
      // The pair invariant: a leftover list under ALL would be silently re-applied by a later
      // scope change.
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ tenantScope: 'RESTRICTED', tenantIds: ['tenant-1'] })
      );
      prisma.moduleRegistration.update.mockResolvedValue(registrationRow());

      await service.updateRegistration(actor, registrationRow().id, { tenantScope: 'ALL' });

      expect(prisma.moduleRegistration.update.mock.calls[0][0].data).toMatchObject({
        tenantScope: 'ALL',
        tenantIds: [],
      });
    });

    it('maps a unique violation to a conflict rather than a 500', async () => {
      prisma.moduleRegistration.create.mockRejectedValue(uniqueViolation());

      await expect(
        service.createRegistration(actor, { moduleId: 'finance', displayName: 'Finance' })
      ).rejects.toThrow(ConflictException);
    });

    it('cascades a DISABLE to every instance, in one transaction', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ enabled: true, instances: [instanceRow()] })
      );
      prisma.moduleRegistration.update.mockResolvedValue(
        registrationRow({ enabled: false, instances: [instanceRow()] })
      );
      prisma.moduleRegistration.findUniqueOrThrow.mockResolvedValue(
        registrationRow({
          enabled: false,
          instances: [instanceRow({ lifecycle: 'DISABLED', health: 'DISABLED' })],
        })
      );

      await service.updateRegistration(actor, registrationRow().id, { enabled: false });

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.moduleInstance.updateMany.mock.calls[0][0].data).toEqual({
        lifecycle: 'DISABLED',
        health: 'DISABLED',
      });
    });

    it('does NOT touch instances when the update is not a disable', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleRegistration.update.mockResolvedValue(registrationRow());

      await service.updateRegistration(actor, registrationRow().id, { displayName: 'New name' });

      expect(prisma.moduleInstance.updateMany).not.toHaveBeenCalled();
    });

    it('returns a rotated credential ONCE and stores only its envelope', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleRegistration.update.mockResolvedValue(registrationRow());

      const { secret } = await service.rotateCredential(actor, registrationRow().id);

      // 32 bytes as hex.
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(crypto.encrypt).toHaveBeenCalledWith(secret);

      const written = prisma.moduleRegistration.update.mock.calls[0][0].data;
      expect(written).toMatchObject({
        secretCiphertext: CIPHER.ciphertext,
        secretIv: CIPHER.iv,
        secretAuthTag: CIPHER.authTag,
      });

      // The audit row records the fact, never the value.
      const logged = JSON.stringify(audit.log.mock.calls[0][0]);
      expect(logged).toContain('MODULE_CREDENTIAL_ROTATED');
      expect(logged).not.toContain(secret);
    });

    it('does not disable the module on rotation', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleRegistration.update.mockResolvedValue(registrationRow());

      await service.rotateCredential(actor, registrationRow().id);

      expect(prisma.moduleRegistration.update.mock.calls[0][0].data).not.toHaveProperty('enabled');
      expect(prisma.moduleInstance.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('projections', () => {
    it('reports credential PRESENCE and never the credential', async () => {
      prisma.moduleRegistration.findMany.mockResolvedValue([registrationRow()]);

      const [projected] = await service.listRegistrations();

      expect(projected.hasCredential).toBe(true);
      expect(projected).not.toHaveProperty('secretCiphertext');
      expect(projected).not.toHaveProperty('secretIv');
      expect(projected).not.toHaveProperty('secretAuthTag');
      expect(JSON.stringify(projected)).not.toContain(CIPHER.ciphertext);
    });

    it('derives DISCOVERED for a module that has never announced itself', async () => {
      prisma.moduleRegistration.findMany.mockResolvedValue([registrationRow({ instances: [] })]);

      const [projected] = await service.listRegistrations();

      expect(projected.derivedLifecycle).toBe('DISCOVERED');
      expect(projected.aggregateHealth).toBe('UNKNOWN');
    });

    it('derives the BEST lifecycle but the WORST health across instances', async () => {
      // Deliberate asymmetry: "can it serve?" vs "is anything wrong?".
      prisma.moduleRegistration.findMany.mockResolvedValue([
        registrationRow({
          instances: [
            instanceRow({ instanceId: 'a-01', lifecycle: 'ACTIVE', health: 'HEALTHY' }),
            instanceRow({
              instanceId: 'a-02',
              lifecycle: 'UNAVAILABLE',
              health: 'UNAVAILABLE',
            }),
          ],
        }),
      ]);

      const [projected] = await service.listRegistrations();

      expect(projected.derivedLifecycle).toBe('ACTIVE');
      expect(projected.aggregateHealth).toBe('UNAVAILABLE');
    });

    it('marks a stale instance stale and reflects it in the aggregate', async () => {
      prisma.moduleRegistration.findMany.mockResolvedValue([
        registrationRow({
          instances: [
            instanceRow({
              health: 'HEALTHY',
              lastSeenAt: new Date(Date.now() - MODULE_STALE_AFTER_MS - 1),
            }),
          ],
        }),
      ]);

      const [projected] = await service.listRegistrations();

      expect(projected.instances[0].stale).toBe(true);
      // A stale-but-formerly-healthy instance must not make the module look healthy.
      expect(projected.aggregateHealth).toBe('UNAVAILABLE');
    });

    it('never reports a DISABLED module as healthy', async () => {
      prisma.moduleRegistration.findMany.mockResolvedValue([
        registrationRow({ enabled: false, instances: [instanceRow({ health: 'HEALTHY' })] }),
      ]);

      const [projected] = await service.listRegistrations();

      expect(projected.derivedLifecycle).toBe('DISABLED');
      expect(projected.aggregateHealth).toBe('DISABLED');
    });

    it('exposes capabilities without any internal detail (§10)', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ instances: [instanceRow()] })
      );

      const described = await service.describeCapabilities('finance');

      expect(described.instances[0].capabilities).toEqual(['invoice.read']);
      // No endpoint, no health path, no credential — the capability view is narrower than the
      // admin view on purpose.
      expect(described.instances[0]).not.toHaveProperty('baseUrl');
      expect(described.instances[0]).not.toHaveProperty('healthPath');
      expect(JSON.stringify(described)).not.toContain(CIPHER.ciphertext);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // §14/§15 — heartbeat, deregistration, staleness, probes
  // ─────────────────────────────────────────────────────────────────────────────

  describe('heartbeat', () => {
    const heartbeatRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'inst-1',
      moduleId: 'finance',
      lifecycle: 'ACTIVE',
      registration: { enabled: true },
      ...overrides,
    });

    it('refreshes lastSeenAt and promotes an unavailable instance back to ACTIVE', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(
        heartbeatRow({ lifecycle: 'UNAVAILABLE' })
      );

      const result = await service.heartbeat('finance', 'finance-prod-01', 'HEALTHY');

      expect(result).toMatchObject({ acknowledged: true, lifecycle: 'ACTIVE' });
      expect(prisma.moduleInstance.update.mock.calls[0][0].data.lastSeenAt).toBeInstanceOf(Date);
    });

    it('cannot promote an INCOMPATIBLE instance', async () => {
      // §18 must not be bypassable one heartbeat at a time.
      prisma.moduleInstance.findUnique.mockResolvedValue(
        heartbeatRow({ lifecycle: 'INCOMPATIBLE' })
      );

      const result = await service.heartbeat('finance', 'finance-prod-01', 'HEALTHY');

      expect(result.lifecycle).toBe('INCOMPATIBLE');

      const written = prisma.moduleInstance.update.mock.calls[0][0].data;
      expect(written).not.toHaveProperty('lifecycle');
      expect(written).not.toHaveProperty('health');
      // lastSeenAt IS still refreshed: the instance is demonstrably alive, just not usable.
      expect(written.lastSeenAt).toBeInstanceOf(Date);
    });

    it('cannot promote an instance whose module an administrator disabled', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(
        heartbeatRow({ lifecycle: 'DISABLED', registration: { enabled: false } })
      );

      const result = await service.heartbeat('finance', 'finance-prod-01', 'HEALTHY');

      expect(result.lifecycle).toBe('DISABLED');
    });

    it('believes a module that reports itself DEGRADED', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(heartbeatRow());

      const result = await service.heartbeat('finance', 'finance-prod-01', 'DEGRADED');

      expect(result.lifecycle).toBe('DEGRADED');
      expect(prisma.moduleInstance.update.mock.calls[0][0].data.health).toBe('DEGRADED');
    });

    it('rejects a heartbeat for an instance belonging to another module', async () => {
      // Reported as unknown, not forbidden: distinguishing them would disclose which instance ids
      // exist.
      prisma.moduleInstance.findUnique.mockResolvedValue(heartbeatRow({ moduleId: 'other' }));

      await expect(service.heartbeat('finance', 'finance-prod-01')).rejects.toThrow(
        NotFoundException
      );
    });

    it('is NOT audited', async () => {
      // §33 is explicit; a 30-second heartbeat would bury every real mutation.
      prisma.moduleInstance.findUnique.mockResolvedValue(heartbeatRow());

      await service.heartbeat('finance', 'finance-prod-01');

      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('deregisterInstance', () => {
    it('keeps the row and clears the staleness clock', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        moduleId: 'finance',
        registrationId: registrationRow().id,
      });

      await service.deregisterInstance('finance', 'finance-prod-01');

      expect(prisma.moduleInstance.update.mock.calls[0][0].data).toEqual({
        lifecycle: 'DEREGISTERED',
        health: 'UNAVAILABLE',
        lastSeenAt: null,
      });

      // The row survives so an operator can tell a clean shutdown from a disappearance.
      expect(audit.log.mock.calls[0][0].action).toBe('MODULE_INSTANCE_DEREGISTERED');
    });
  });

  describe('sweepStaleInstances', () => {
    it('demotes only sweepable lifecycles, in a bounded batch', async () => {
      prisma.moduleInstance.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      prisma.moduleInstance.updateMany.mockResolvedValue({ count: 2 });

      const count = await service.sweepStaleInstances(new Date());

      expect(count).toBe(2);

      const query = prisma.moduleInstance.findMany.mock.calls[0][0];
      // MUST match the partial index predicate in the migration.
      expect(query.where.lifecycle.in).toEqual(['REGISTERED', 'ACTIVE', 'DEGRADED']);
      expect(query.take).toBe(STALE_SWEEP_BATCH);

      expect(prisma.moduleInstance.updateMany.mock.calls[0][0].data).toEqual({
        lifecycle: 'UNAVAILABLE',
        health: 'UNAVAILABLE',
        healthErrorCode: 'HEARTBEAT_STALE',
      });
    });

    it('does nothing, and writes nothing, when there is nothing stale', async () => {
      prisma.moduleInstance.findMany.mockResolvedValue([]);

      await expect(service.sweepStaleInstances()).resolves.toBe(0);
      expect(prisma.moduleInstance.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('recordProbe', () => {
    it('refreshes lastSeenAt for a reachable instance', async () => {
      // A successful probe is evidence of life; without this the sweep would demote a module that
      // only answers probes.
      prisma.moduleInstance.findUnique.mockResolvedValue({ id: 'inst-1', lifecycle: 'ACTIVE' });

      await service.recordProbe('finance-prod-01', 'HEALTHY');

      const written = prisma.moduleInstance.update.mock.calls[0][0].data;
      expect(written.lastSeenAt).toBeInstanceOf(Date);
      expect(written.lifecycle).toBe('ACTIVE');
    });

    it('does not refresh lastSeenAt for an unreachable instance', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue({ id: 'inst-1', lifecycle: 'ACTIVE' });

      await service.recordProbe('finance-prod-01', 'UNAVAILABLE', 'TIMEOUT');

      const written = prisma.moduleInstance.update.mock.calls[0][0].data;
      expect(written).not.toHaveProperty('lastSeenAt');
      expect(written.healthErrorCode).toBe('TIMEOUT');
    });

    it('cannot promote an INCOMPATIBLE instance, even on a successful probe', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        lifecycle: 'INCOMPATIBLE',
      });

      await service.recordProbe('finance-prod-01', 'HEALTHY');

      expect(prisma.moduleInstance.update.mock.calls[0][0].data).not.toHaveProperty('lifecycle');
    });

    it('silently ignores an unknown instance', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(null);

      await expect(service.recordProbe('nope', 'HEALTHY')).resolves.toBeUndefined();
      expect(prisma.moduleInstance.update).not.toHaveBeenCalled();
    });
  });

  describe('resolveSecret', () => {
    it('decrypts a stored credential', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await expect(service.resolveSecret('finance')).resolves.toBe(SECRET);
    });

    it('treats an EXPIRED credential as absent', async () => {
      // §20: refused at this end with a clear cause, rather than producing an unexplained 401 at
      // the far end.
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ secretExpiresAt: new Date(Date.now() - 1_000) })
      );

      await expect(service.resolveSecret('finance')).resolves.toBeUndefined();
    });

    it('returns undefined rather than throwing when decryption fails', async () => {
      crypto.decrypt.mockImplementation(() => {
        throw new Error('bad key');
      });
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await expect(service.resolveSecret('finance')).resolves.toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // ADR-0006 A8 — capability credentials, one per (caller, capability)
  // ─────────────────────────────────────────────────────────────────────────────

  describe('capability credentials', () => {
    const moduleId = 'finance';
    const identity = 'platform.identity@v1';
    const auditCapability = 'platform.audit@v1';

    it('issues a credential ONCE and stores only its envelope', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleCapabilityCredential.upsert.mockResolvedValue(capabilityCredentialRow());

      const { secret } = await service.rotateCapabilityCredential(actor, moduleId, identity);

      // 32 bytes as hex, encrypted by the SAME envelope and the same key as the module-hop
      // credential — A8 forbids a second crypto system.
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
      expect(crypto.encrypt).toHaveBeenCalledWith(secret);

      const written = prisma.moduleCapabilityCredential.upsert.mock.calls[0][0];
      expect(written.create).toMatchObject({
        moduleId,
        capability: identity,
        secretCiphertext: CIPHER.ciphertext,
        secretIv: CIPHER.iv,
        secretAuthTag: CIPHER.authTag,
      });

      // The audit row records the fact, never the value.
      const logged = JSON.stringify(audit.log.mock.calls[0][0]);
      expect(logged).toContain('PLATFORM_CAPABILITY_CREDENTIAL_ROTATED');
      expect(logged).not.toContain(secret);
    });

    it('addresses the write by the pair, so the other capability is untouched', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleCapabilityCredential.upsert.mockResolvedValue(
        capabilityCredentialRow({ capability: auditCapability })
      );

      await service.rotateCapabilityCredential(actor, moduleId, auditCapability);

      // The composite key IS the capability boundary: one rotation cannot reach another pair, so
      // "rotating identity did not break audit" is structural rather than asserted.
      expect(prisma.moduleCapabilityCredential.upsert.mock.calls[0][0].where).toEqual({
        moduleId_capability: { moduleId, capability: auditCapability },
      });

      // And the trail names WHICH credential moved, so the property stays observable later.
      expect(audit.log.mock.calls[0][0].newValue).toEqual({
        capability: auditCapability,
        generated: true,
      });
      expect(audit.log.mock.calls[0][0].resource).toBe('ModuleCapabilityCredential');
    });

    it('uses a DIFFERENT trail from the module-hop credential rotation', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleCapabilityCredential.upsert.mockResolvedValue(capabilityCredentialRow());
      prisma.moduleRegistration.update.mockResolvedValue(registrationRow());

      await service.rotateCapabilityCredential(actor, moduleId, identity);

      expect(audit.log.mock.calls[0][0].action).toBe('PLATFORM_CAPABILITY_CREDENTIAL_ROTATED');
      expect(lifecycle.module.mock.calls[0][0]).toBe('module.capability_credential.rotated');

      audit.log.mockClear();
      lifecycle.module.mockClear();

      await service.rotateCredential(actor, registrationRow().id);

      // One name per key kind. Reusing the module-hop vocabulary would make the two rotations
      // indistinguishable in both trails, which is the ambiguity A8 was written to prevent.
      expect(audit.log.mock.calls[0][0].action).toBe('MODULE_CREDENTIAL_ROTATED');
      expect(lifecycle.module.mock.calls[0][0]).toBe('module.registration.credential_rotated');
    });

    it('never touches an expiry policy it did not set', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleCapabilityCredential.upsert.mockResolvedValue(capabilityCredentialRow());

      await service.rotateCapabilityCredential(actor, moduleId, identity);

      const written = prisma.moduleCapabilityCredential.upsert.mock.calls[0][0];

      // A8 asks for "exactly ModuleRegistration's semantics": an expiry is a POLICY an operator
      // configured, so a rotation must not clear it, and a fresh row leaves it NULL.
      expect(written.update).not.toHaveProperty('secretExpiresAt');
      expect(written.create).not.toHaveProperty('secretExpiresAt');
    });

    it('refuses a module that is not admitted rather than issuing an unresolvable credential', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);

      await expect(
        service.rotateCapabilityCredential(actor, 'nobody', auditCapability)
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.moduleCapabilityCredential.upsert).not.toHaveBeenCalled();
    });

    it('refuses a descriptor that is not name@v<major>, before any write', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await expect(
        service.rotateCapabilityCredential(actor, moduleId, 'platform.audit')
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.moduleCapabilityCredential.upsert).not.toHaveBeenCalled();
    });

    it('maps a registration that vanished mid-write to a 404 rather than a 500', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleCapabilityCredential.upsert.mockRejectedValue(
        Object.assign(new Error('fk'), { code: 'P2003' })
      );

      await expect(
        service.rotateCapabilityCredential(actor, moduleId, identity)
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('reads back PRESENCE for one module and never an envelope column', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleCapabilityCredential.findMany.mockResolvedValue([
        capabilityCredentialRow(),
        // A row may be DECLARED before its envelope exists: the schema's nullable `secret*` set.
        capabilityCredentialRow({
          id: '44444444-4444-4444-8444-444444444444',
          capability: auditCapability,
          secretCiphertext: null,
          secretIv: null,
          secretAuthTag: null,
          secretUpdatedAt: null,
        }),
      ]);

      const projected = await service.listCapabilityCredentials(moduleId);

      expect(projected[0]).toMatchObject({
        moduleId,
        capability: identity,
        hasSecret: true,
        credentialExpiresAt: null,
      });
      expect(projected[1].hasSecret).toBe(false);

      for (const row of projected) {
        expect(row).not.toHaveProperty('secretCiphertext');
        expect(row).not.toHaveProperty('secretIv');
        expect(row).not.toHaveProperty('secretAuthTag');
      }

      const serialised = JSON.stringify(projected);
      expect(serialised).not.toContain(CIPHER.ciphertext);
      expect(serialised).not.toContain(CIPHER.iv);
      expect(serialised).not.toContain(CIPHER.authTag);
    });

    it('answers an unknown module with a 404 rather than an empty list', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);

      await expect(service.listCapabilityCredentials('nobody')).rejects.toBeInstanceOf(
        NotFoundException
      );

      expect(prisma.moduleCapabilityCredential.findMany).not.toHaveBeenCalled();
    });

    it('bounds the read instead of trusting the table to stay small', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await service.listCapabilityCredentials(moduleId);

      const query = prisma.moduleCapabilityCredential.findMany.mock.calls[0][0];

      expect(query.where).toEqual({ moduleId });
      expect(query.take).toBe(MAX_CAPABILITY_CREDENTIAL_PAGE);
    });

    it('records the rotation on the MODULE subject, carrying the capability and not the value', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleCapabilityCredential.upsert.mockResolvedValue(capabilityCredentialRow());

      const { secret } = await service.rotateCapabilityCredential(actor, moduleId, identity);

      const [eventType, phase, subject, extra] = lifecycle.module.mock.calls[0] as [
        string,
        string,
        { id?: string; key?: string },
        { actorType?: string; detail?: Record<string, unknown>; module?: { moduleId?: string } },
      ];

      expect(eventType).toBe('module.capability_credential.rotated');
      expect(phase).toBe('SUCCEEDED');
      // The REGISTRATION is the subject, so the module-hop credential and every capability
      // credential land on the one timeline an operator reads per module.
      expect(subject).toEqual({ id: registrationRow().id, key: moduleId });
      expect(extra.module?.moduleId).toBe(moduleId);
      expect(extra.actorType).toBe('USER');
      expect(extra.detail).toEqual({ capability: identity, generated: true });

      const emitted = JSON.stringify(lifecycle.module.mock.calls[0]);
      expect(emitted).not.toContain(secret);
      expect(emitted).not.toContain(CIPHER.ciphertext);
    });

    describe('resolveCapabilityCredential', () => {
      it('decrypts the credential stored for that pair', async () => {
        prisma.moduleCapabilityCredential.findUnique.mockResolvedValue(capabilityCredentialRow());

        await expect(service.resolveCapabilityCredential(moduleId, identity)).resolves.toBe(SECRET);

        // Keyed by the UNIQUE pair, so the resolver cannot be pointed at another capability.
        expect(prisma.moduleCapabilityCredential.findUnique.mock.calls[0][0].where).toEqual({
          moduleId_capability: { moduleId, capability: identity },
        });
      });

      it('treats an EXPIRED capability credential as absent', async () => {
        prisma.moduleCapabilityCredential.findUnique.mockResolvedValue(
          capabilityCredentialRow({ secretExpiresAt: new Date(Date.now() - 1_000) })
        );

        await expect(
          service.resolveCapabilityCredential(moduleId, auditCapability)
        ).resolves.toBeUndefined();
      });

      it('returns undefined for a pair nobody provisioned, and never throws', async () => {
        prisma.moduleCapabilityCredential.findUnique.mockResolvedValue(null);

        await expect(
          service.resolveCapabilityCredential(moduleId, auditCapability)
        ).resolves.toBeUndefined();
      });

      it('does not query at all for a descriptor that cannot have been stored', async () => {
        await expect(
          service.resolveCapabilityCredential(moduleId, 'PLATFORM.AUDIT@v1')
        ).resolves.toBeUndefined();

        expect(prisma.moduleCapabilityCredential.findUnique).not.toHaveBeenCalled();
      });

      it('returns undefined rather than throwing when decryption fails', async () => {
        crypto.decrypt.mockImplementation(() => {
          throw new Error('bad key');
        });
        prisma.moduleCapabilityCredential.findUnique.mockResolvedValue(capabilityCredentialRow());

        await expect(
          service.resolveCapabilityCredential(moduleId, identity)
        ).resolves.toBeUndefined();
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 49M-2 — the lifecycle timeline
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * `lifecycle.module` IS THE ASSERTED METHOD. Going through the facade is what stamps
   * `domain: 'MODULE'` and `subjectType`, and the `module` context block is what makes a registry
   * row joinable with a provisioning row — which is why these tests read `extra.module` rather
   * than accepting the ids buried in `detail`.
   *
   * THE SUBJECT IS THE REGISTRATION ROW even for instance events, deliberately: an operator
   * reads a timeline per module, and keying instance events by their own id would scatter one
   * module's history across as many subjects as it has instances.
   */
  describe('lifecycle emission', () => {
    const firstCall = () => {
      const [eventType, phase, subject, extra] = lifecycle.module.mock.calls[0] as [
        string,
        string,
        { id?: string; key?: string },
        {
          actorType?: string;
          actorId?: string | null;
          outcomeCode?: string | null;
          module?: {
            moduleId?: string;
            instanceId?: string | null;
            deploymentMode?: string | null;
          };
          detail?: Record<string, unknown>;
        },
      ];

      return { eventType, phase, subject, extra };
    };

    it('emits registration.created as SUCCEEDED, with the tenant COUNT and no tenant ids', async () => {
      prisma.moduleRegistration.create.mockResolvedValue(
        registrationRow({ enabled: false, tenantScope: 'RESTRICTED', tenantIds: ['tenant-7'] })
      );

      await service.createRegistration(actor, {
        moduleId: 'finance',
        displayName: 'Finance',
        tenantScope: 'RESTRICTED',
        tenantIds: ['tenant-7'],
      });

      expect(lifecycle.module).toHaveBeenCalledTimes(1);

      const { eventType, phase, subject, extra } = firstCall();

      expect(eventType).toBe('module.registration.created');
      expect(phase).toBe('SUCCEEDED');
      expect(subject).toEqual({ id: registrationRow().id, key: 'finance' });
      expect(extra.actorType).toBe('USER');
      expect(extra.actorId).toBe(actor);
      expect(extra.detail).toMatchObject({ tenantCount: 1, enabled: false });
      // A RESTRICTED scope's tenant list is CUSTOMER IDENTITY. The count answers the
      // operational question; the ids would be a disclosure through a displayed surface.
      expect(JSON.stringify(extra)).not.toContain('tenant-7');
    });

    it('emits NOTHING when the registration is rejected as a duplicate', async () => {
      prisma.moduleRegistration.create.mockRejectedValue(uniqueViolation());

      await expect(
        service.createRegistration(actor, { moduleId: 'finance', displayName: 'Finance' })
      ).rejects.toThrow(ConflictException);

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('emits NOTHING when a RESTRICTED scope is refused before any write', async () => {
      await expect(
        service.createRegistration(actor, {
          moduleId: 'finance',
          displayName: 'Finance',
          tenantScope: 'RESTRICTED',
          tenantIds: [],
        })
      ).rejects.toThrow(BadRequestException);

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('names an ENABLE as its own transition and agrees with the audit action', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow({ enabled: false }));
      prisma.moduleRegistration.update.mockResolvedValue(registrationRow({ enabled: true }));

      await service.updateRegistration(actor, registrationRow().id, { enabled: true });

      const { eventType, phase, extra } = firstCall();

      expect(eventType).toBe('module.registration.enabled');
      expect(phase).toBe('SUCCEEDED');
      expect(extra.detail).toMatchObject({ enabled: true, instancesAffected: 0 });
      // The two trails cannot disagree about what this call did: same three-way choice.
      expect(audit.log.mock.calls[0][0].action).toBe('MODULE_ENABLED');
    });

    it('reports the CASCADE COUNT on a disable, which is the operationally interesting part', async () => {
      const instances = [instanceRow(), instanceRow({ instanceId: 'finance-prod-02' })];

      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ enabled: true, instances })
      );
      prisma.moduleRegistration.update.mockResolvedValue(
        registrationRow({ enabled: false, instances })
      );
      prisma.moduleRegistration.findUniqueOrThrow.mockResolvedValue(
        registrationRow({ enabled: false, instances })
      );

      await service.updateRegistration(actor, registrationRow().id, { enabled: false });

      const { eventType, extra } = firstCall();

      expect(eventType).toBe('module.registration.disabled');
      expect(extra.detail).toMatchObject({ enabled: false, instancesAffected: 2 });
      expect(audit.log.mock.calls[0][0].action).toBe('MODULE_DISABLED');
    });

    it('emits AFTER the transaction commits, never inside it', async () => {
      // Emitting inside the callback would hold a Core transaction open across an
      // observability write. This asserts the ordering directly: nothing was emitted while
      // the `$transaction` callback was still running.
      let emittedInsideTransaction = false;

      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleRegistration.update.mockResolvedValue(registrationRow());
      prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
        const result = await callback(prisma);
        emittedInsideTransaction = lifecycle.module.mock.calls.length > 0;
        return result;
      });

      await service.updateRegistration(actor, registrationRow().id, { displayName: 'Renamed' });

      expect(emittedInsideTransaction).toBe(false);
      expect(firstCall().eventType).toBe('module.registration.updated');
    });

    it('reports a delete with the number of instances the FK cascade removed', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ instances: [instanceRow()] })
      );
      prisma.moduleRegistration.delete.mockResolvedValue(registrationRow());

      await service.deleteRegistration(actor, registrationRow().id);

      const { eventType, extra } = firstCall();

      expect(eventType).toBe('module.registration.deleted');
      expect(extra.detail).toEqual({ instancesRemoved: 1 });
    });

    it('records a credential rotation as a fact and never the credential', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      prisma.moduleRegistration.update.mockResolvedValue(registrationRow());

      const { secret } = await service.rotateCredential(actor, registrationRow().id);

      const { eventType, extra } = firstCall();

      expect(eventType).toBe('module.registration.credential_rotated');
      expect(extra.detail).toEqual({ generated: true });
      // Read by an operator-facing timeline API, so a credential here is a disclosure through
      // a surface DESIGNED to be displayed — worse than the same leak in an audit row.
      const emitted = JSON.stringify(lifecycle.module.mock.calls[0]);
      expect(emitted).not.toContain(secret);
      expect(emitted).not.toContain(CIPHER.ciphertext);
    });

    it('emits an instance announcement as SUCCEEDED with its distributed identity', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await service.registerInstance(registerDto());

      const { eventType, phase, subject, extra } = firstCall();

      expect(eventType).toBe('module.instance.registered');
      expect(phase).toBe('SUCCEEDED');
      // Keyed by the REGISTRATION, so one module's history stays on one subject.
      expect(subject).toEqual({ id: registrationRow().id, key: 'finance' });
      expect(extra.module).toEqual({
        moduleId: 'finance',
        instanceId: 'finance-prod-01',
        deploymentMode: 'REMOTE',
      });
      expect(extra.detail).toMatchObject({
        lifecycle: 'ACTIVE',
        health: 'UNKNOWN',
        compatible: true,
        version: '1.2.0',
        capabilityCount: 1,
      });
      expect(extra.outcomeCode).toBeNull();
    });

    it('attributes a module-initiated announcement to MODULE, with a null actor', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await service.registerInstance(registerDto());

      const { extra } = firstCall();

      // Claiming SYSTEM would be indistinguishable from a platform cron; claiming a user id
      // would invent an operator who was not there.
      expect(extra.actorType).toBe('MODULE');
      expect(extra.actorId).toBeNull();
    });

    it('never carries an instance endpoint, which §40 keeps out of this table', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await service.registerInstance(registerDto());

      expect(JSON.stringify(lifecycle.module.mock.calls[0])).not.toContain(
        'https://finance.example.com'
      );
    });

    it('emits REFUSED for a protocol mismatch, keeping the specific code', async () => {
      // The row WAS written and the instance was NOT admitted. Normalizing this to SUCCEEDED
      // because the upsert worked would make the timeline claim a module came online when it
      // was turned away.
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await service.registerInstance(registerDto({ protocolVersion: MODULE_PROTOCOL_VERSION + 1 }));

      const { phase, extra } = firstCall();

      expect(phase).toBe('REFUSED');
      expect(extra.outcomeCode).toBe('PROTOCOL_MISMATCH');
      expect(extra.detail).toMatchObject({ lifecycle: 'INCOMPATIBLE', compatible: false });
    });

    it('emits REFUSED with CONTRACT_MISSING when the base contract is absent', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await service.registerInstance(registerDto({ apiContracts: ['other@v1'] }));

      const { phase, extra } = firstCall();

      expect(phase).toBe('REFUSED');
      expect(extra.outcomeCode).toBe('CONTRACT_MISSING');
    });

    it('emits SUCCEEDED for a DISABLED announcement — a decision, not a failure', async () => {
      // The announcement was accepted and correctly pinned by the administrator's decision.
      // REFUSED here would conflate "an operator has not admitted this yet" with "this module
      // is broken", which are different problems with different fixes.
      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow({ enabled: false }));

      await service.registerInstance(registerDto());

      const { phase, extra } = firstCall();

      expect(phase).toBe('SUCCEEDED');
      expect(extra.outcomeCode).toBeNull();
      expect(extra.detail).toMatchObject({ lifecycle: 'DISABLED', compatible: true });
    });

    it('emits NOTHING when the announcement names an unknown module', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);

      await expect(service.registerInstance(registerDto())).rejects.toThrow(NotFoundException);

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('marks an orderly deregistration as such, keyed by the registration', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        moduleId: 'finance',
        registrationId: registrationRow().id,
      });

      await service.deregisterInstance('finance', 'finance-prod-01');

      const { eventType, phase, subject, extra } = firstCall();

      expect(eventType).toBe('module.instance.deregistered');
      expect(phase).toBe('SUCCEEDED');
      expect(subject).toEqual({ id: registrationRow().id, key: 'finance' });
      expect(extra.module).toMatchObject({ instanceId: 'finance-prod-01' });
      // `orderly: true` is the fact this row exists to preserve. A swept, stale instance never
      // reaches this method, so the two disappearances stay distinguishable.
      expect(extra.detail).toEqual({ orderly: true });
      expect(extra.actorType).toBe('MODULE');
    });

    it('emits NOTHING for a deregistration that 404s', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(null);

      await expect(service.deregisterInstance('finance', 'nope')).rejects.toThrow(
        NotFoundException
      );

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('does NOT emit for a heartbeat, the highest-cardinality stream in the phase', async () => {
      // §14 is a heartbeat every 30 s per instance. A lifecycle row each would put the
      // lowest-value stream into the table an operator reads to reconstruct an incident.
      prisma.moduleInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        moduleId: 'finance',
        lifecycle: 'ACTIVE',
        registration: { enabled: true },
      });

      await service.heartbeat('finance', 'finance-prod-01', 'HEALTHY');

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('does NOT emit for a heartbeat that CHANGES health', async () => {
      // Still not emitted: `ModuleHealthService` owns observed health, and duplicating it here
      // would mean two sources for one fact.
      prisma.moduleInstance.findUnique.mockResolvedValue({
        id: 'inst-1',
        moduleId: 'finance',
        lifecycle: 'ACTIVE',
        registration: { enabled: true },
      });

      await service.heartbeat('finance', 'finance-prod-01', 'DEGRADED');

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('does NOT emit for an observed probe result', async () => {
      prisma.moduleInstance.findUnique.mockResolvedValue(instanceRow());

      await service.recordProbe('finance-prod-01', 'DEGRADED');

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('does NOT emit for the staleness sweep', async () => {
      // A sweep is a bounded batch demotion, not a per-subject transition an operator reads
      // one row at a time; the warn log carries the count instead.
      prisma.moduleInstance.findMany.mockResolvedValue([{ id: 'inst-1' }, { id: 'inst-2' }]);
      prisma.moduleInstance.updateMany.mockResolvedValue({ count: 2 });

      await expect(service.sweepStaleInstances()).resolves.toBe(2);

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('does NOT emit for a read-only connection test', async () => {
      // Unlike 49L's integration test, this persists nothing on the registry row, and 49M-2's
      // rule is that a lifecycle row records a TRANSITION.
      await service.recordConnectionTest(actor, registrationRow().id, { result: 'SUCCESS' });

      expect(audit.log).toHaveBeenCalled();
      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('does NOT emit for discovery, which mutates nothing', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ instances: [instanceRow()] })
      );

      await service.resolve('finance');

      expect(lifecycle.module).not.toHaveBeenCalled();
    });

    it('never writes into another domain’s timeline', async () => {
      prisma.moduleRegistration.create.mockResolvedValue(registrationRow());

      await service.createRegistration(actor, { moduleId: 'finance', displayName: 'Finance' });

      expect(lifecycle.record).not.toHaveBeenCalled();
      expect(lifecycle.integration).not.toHaveBeenCalled();
      expect(lifecycle.provisioning).not.toHaveBeenCalled();
    });

    it('completes the mutation when the emission itself throws', async () => {
      lifecycle.module.mockImplementation(() => {
        throw new Error('observability down');
      });
      prisma.moduleRegistration.create.mockResolvedValue(registrationRow());

      await expect(
        service.createRegistration(actor, { moduleId: 'finance', displayName: 'Finance' })
      ).resolves.toMatchObject({ moduleId: 'finance' });
    });

    it('completes the mutation when observability is not wired at all', async () => {
      // The `@Optional()` contract asserted rather than assumed.
      const trimmed = await Test.createTestingModule({
        providers: [
          ModuleRegistryService,
          { provide: PrismaService, useValue: prisma },
          { provide: CryptoService, useValue: crypto },
          { provide: AuditService, useValue: audit },
        ],
      }).compile();

      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());

      await expect(
        trimmed.get(ModuleRegistryService).registerInstance(registerDto())
      ).resolves.toMatchObject({ accepted: true });
    });
  });
});
