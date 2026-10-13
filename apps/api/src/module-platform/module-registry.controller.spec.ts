import { Test } from '@nestjs/testing';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ModuleRegistryController } from './module-registry.controller';
import { ModuleRegistryService } from './module-registry.service';
import { ModuleHealthService } from './module-health.service';
import { ModuleClient } from './module-client.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CORE_MODULE_CONTRACT, MODULE_PROTOCOL_VERSION } from './module.contract';
import { Request as ExRequest } from 'express';

/** The verified JWT principal the controller pulls the actor from — never the body. */
interface AuthenticatedExRequest {
  user?: { sub?: string };
}

/**
 * Phase 49M §32: RBAC on the admin surface.
 *
 * Three things are checked here and deliberately nothing else — the business rules live in
 * `module-registry.service.spec.ts` and are not re-asserted through the controller:
 *
 *  1. PERMISSION METADATA PER ROUTE, read back off the prototype. `RolesGuard` is global via
 *     APP_GUARD, so it is not exercised in a unit test; what CAN break silently is a route added or
 *     copied without a `@Roles()` decorator, which would then be authenticated but not AUTHORIZED.
 *     Every route is asserted, including the leaves-nothing-ungated case.
 *  2. THE ACTOR IS TAKEN FROM THE VERIFIED TOKEN, never from the body or a header. An actor read
 *     from user input makes the audit trail forgeable.
 *  3. THE INVOKE ROUTE CANNOT NAME A DESTINATION. §40's anti-pattern is
 *     `POST /modules/call { "url": "…" }`; the assertion is that the controller forwards only
 *     contract fields, so even a body carrying a `url` could not reach the client.
 */

const request = (sub?: string): ExRequest =>
  ({ user: sub ? { sub } : undefined }) as AuthenticatedExRequest as unknown as ExRequest;

describe('ModuleRegistryController', () => {
  let controller: ModuleRegistryController;
  let registry: Record<string, jest.Mock>;
  let health: { probeInstance: jest.Mock };
  let client: { call: jest.Mock };

  const actor = 'user-admin-1';
  const rowId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    registry = {
      listRegistrations: jest.fn(),
      getRegistration: jest.fn(),
      createRegistration: jest.fn(),
      updateRegistration: jest.fn(),
      deleteRegistration: jest.fn(),
      rotateCredential: jest.fn(),
      describeCapabilities: jest.fn(),
      listCapabilityCredentials: jest.fn().mockResolvedValue([]),
      rotateCapabilityCredential: jest.fn().mockResolvedValue({ secret: 's' }),
      recordConnectionTest: jest.fn(),
    };

    health = { probeInstance: jest.fn().mockResolvedValue({ state: 'HEALTHY' }) };
    client = { call: jest.fn().mockResolvedValue({ ok: true }) };

    const moduleRef = await Test.createTestingModule({
      controllers: [ModuleRegistryController],
      providers: [
        { provide: ModuleRegistryService, useValue: registry },
        { provide: ModuleHealthService, useValue: health },
        { provide: ModuleClient, useValue: client },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(ModuleRegistryController);
  });

  describe('permission gates', () => {
    const rolesOf = (handler: keyof ModuleRegistryController) =>
      Reflect.getMetadata('roles', ModuleRegistryController.prototype[handler]);

    /** Every route handler on the controller, discovered rather than hard-coded. */
    const handlers = () =>
      Object.getOwnPropertyNames(ModuleRegistryController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.hasMetadata(
            METHOD_METADATA,
            ModuleRegistryController.prototype[name as keyof ModuleRegistryController],
          ),
      );

    it('gates every READ route on admin.modules.read', () => {
      // OPERATIONS_ADMIN holds this and not manage, so it can diagnose reachability without being
      // able to admit a module or rotate its credential.
      expect(rolesOf('platform')).toEqual(['admin.modules.read']);
      expect(rolesOf('list')).toEqual(['admin.modules.read']);
      expect(rolesOf('getOne')).toEqual(['admin.modules.read']);
      expect(rolesOf('capabilities')).toEqual(['admin.modules.read']);
      // ADR-0006 A8: whether a module HOLDS a capability credential is a read.
      expect(rolesOf('capabilityCredentials')).toEqual(['admin.modules.read']);
    });

    it('gates every WRITE route on admin.modules.manage', () => {
      expect(rolesOf('create')).toEqual(['admin.modules.manage']);
      expect(rolesOf('update')).toEqual(['admin.modules.manage']);
      expect(rolesOf('remove')).toEqual(['admin.modules.manage']);
      // ADR-0006 A8: ISSUING a capability credential grants a module a cross-runtime authority,
      // so it is a write even though the row it writes looks like configuration.
      expect(rolesOf('rotateCapabilityCredential')).toEqual(['admin.modules.manage']);
    });

    it('gates credential rotation, the connection test and invoke at WRITE level', () => {
      // Rotation replaces a credential; the test sends a real request to operator infrastructure;
      // invoke causes a side effect inside another module. None is a read.
      expect(rolesOf('rotateCredential')).toEqual(['admin.modules.manage']);
      expect(rolesOf('testInstance')).toEqual(['admin.modules.manage']);
      expect(rolesOf('invoke')).toEqual(['admin.modules.manage']);
    });

    it('leaves NO route ungated', () => {
      // The check that survives future edits: a route added without @Roles() is authenticated but
      // unauthorised, and nothing else in the suite would notice.
      const ungated = handlers().filter(
        (name) =>
          !Reflect.getMetadata(
            'roles',
            ModuleRegistryController.prototype[name as keyof ModuleRegistryController],
          ),
      );

      expect(ungated).toEqual([]);
    });

    it('declares no permission that names a business module (§32)', () => {
      // A per-module permission would make adding a module a change to Core's catalogue.
      const declared = handlers().flatMap(
        (name) =>
          (Reflect.getMetadata(
            'roles',
            ModuleRegistryController.prototype[name as keyof ModuleRegistryController],
          ) ?? []) as string[],
      );

      expect([...new Set(declared)].sort()).toEqual(['admin.modules.manage', 'admin.modules.read']);
    });
  });

  describe('actor identity', () => {
    it('takes the actor from the verified token on every write', async () => {
      await controller.create(request(actor), { moduleId: 'finance', displayName: 'Finance' });
      expect(registry.createRegistration).toHaveBeenCalledWith(actor, expect.anything());

      await controller.update(request(actor), rowId, { displayName: 'x' });
      expect(registry.updateRegistration).toHaveBeenCalledWith(actor, rowId, expect.anything());

      await controller.remove(request(actor), rowId);
      expect(registry.deleteRegistration).toHaveBeenCalledWith(actor, rowId);

      await controller.rotateCredential(request(actor), rowId);
      expect(registry.rotateCredential).toHaveBeenCalledWith(actor, rowId);

      // ADR-0006 A8: issuing a capability credential is a write, and the actor is the verified
      // token's subject here too — the trail is only worth having if it cannot be forged.
      await controller.rotateCapabilityCredential(
        request(actor),
        'hr',
        'platform.identity@v1',
      );
      expect(registry.rotateCapabilityCredential).toHaveBeenCalledWith(
        actor,
        'hr',
        'platform.identity@v1',
      );
    });

    it('never reads an actor from the body', async () => {
      // An actor read from user input makes the audit trail forgeable.
      await controller.create(request(actor), {
        moduleId: 'finance',
        displayName: 'Finance',
        actorId: 'someone-else',
      } as never);

      expect(registry.createRegistration.mock.calls[0][0]).toBe(actor);
    });
  });

  describe('platform descriptor', () => {
    it('reports the protocol, the base contract and the future foundations', () => {
      const descriptor = controller.platform();

      expect(descriptor.protocolVersion).toBe(MODULE_PROTOCOL_VERSION);
      expect(descriptor.baseContract).toBe(CORE_MODULE_CONTRACT);

      // §36/§38: declared, NOT implemented — and the response says so rather than implying
      // capability the phase does not have.
      expect(descriptor.foundations.syncImplemented).toBe(false);
      expect(descriptor.foundations.provisioningImplemented).toBe(false);
      expect(descriptor.foundations.defaultConflictPolicy).toBe('OWNER_WINS');
    });

    it('names no business module anywhere in the descriptor', () => {
      const serialised = JSON.stringify(controller.platform()).toLowerCase();

      for (const forbidden of ['hr', 'finance', 'employee', 'invoice', 'payroll']) {
        expect(serialised).not.toContain(`"${forbidden}"`);
      }
    });
  });

  describe('invoke', () => {
    it('forwards ONLY contract fields, so a url in the body cannot reach the client', async () => {
      await controller.invoke({
        moduleId: 'finance',
        contract: CORE_MODULE_CONTRACT,
        operation: 'invoice.read',
        payload: { id: 'x' },
        // The DTO rejects this under `forbidNonWhitelisted`; the assertion is that even if it got
        // here, the controller has no line that would pass it on.
        url: 'http://169.254.169.254/latest/meta-data',
        baseUrl: 'http://redis:6379',
        instanceId: 'finance-prod-99',
      } as never);

      expect(client.call).toHaveBeenCalledWith({
        moduleId: 'finance',
        contract: CORE_MODULE_CONTRACT,
        operation: 'invoice.read',
        payload: { id: 'x' },
        timeoutMs: undefined,
      });

      const forwarded = client.call.mock.calls[0][0];
      expect(forwarded).not.toHaveProperty('url');
      expect(forwarded).not.toHaveProperty('baseUrl');
      expect(forwarded).not.toHaveProperty('instanceId');
      // And no tenant: the client derives it from the request context (§21).
      expect(forwarded).not.toHaveProperty('tenantId');
    });
  });

  describe('connection test', () => {
    it('probes by instance id and audits the outcome', async () => {
      health.probeInstance.mockResolvedValue({
        registryKnown: true,
        endpointReachable: true,
        applicationHealthy: false,
        state: 'DEGRADED',
        errorCode: 'NO_HEALTH_STATE',
      });

      const verdict = await controller.testInstance(request(actor), rowId, 'finance-prod-01');

      expect(health.probeInstance).toHaveBeenCalledWith('finance-prod-01');
      expect(verdict.state).toBe('DEGRADED');

      expect(registry.recordConnectionTest).toHaveBeenCalledWith(actor, rowId, {
        instanceId: 'finance-prod-01',
        state: 'DEGRADED',
        endpointReachable: true,
        applicationHealthy: false,
        errorCode: 'NO_HEALTH_STATE',
      });
    });
  });

  describe('capability credentials (ADR-0006 A8)', () => {
    /** The envelope and plaintext property names that must never reach a READ response. */
    const FORBIDDEN_IN_READ = [
      'secretCiphertext',
      'secretIv',
      'secretAuthTag',
      'secret',
      'hasCredential',
    ];

    const publicRow = {
      id: '22222222-2222-4222-8222-222222222222',
      moduleId: 'hr',
      capability: 'platform.identity@v1',
      hasSecret: true,
      credentialUpdatedAt: new Date('2026-09-18T00:00:00.000Z'),
      credentialExpiresAt: null,
      createdAt: new Date('2026-09-18T00:00:00.000Z'),
      updatedAt: new Date('2026-09-18T00:00:00.000Z'),
    };

    it('serialises a read response with no envelope and no plaintext property (§4)', async () => {
      // THE RUNTIME ASSERTION, not a Swagger exclusion: the object handed to the controller carries
      // the envelope columns, exactly as a careless future edit would produce it, and the response
      // must be free of them by CONSTRUCTION rather than by coincidence.
      registry.listCapabilityCredentials.mockResolvedValue([
        { ...publicRow, secretCiphertext: 'cipher', secretIv: 'iv', secretAuthTag: 'tag' },
      ]);

      const response = await controller.capabilityCredentials('hr');

      expect(response).toEqual([publicRow]);

      const serialised = JSON.stringify(response);
      for (const forbidden of FORBIDDEN_IN_READ) {
        expect(serialised).not.toContain(forbidden);
      }
    });

    it('passes a declared-but-unissued credential through with hasSecret false', async () => {
      // A capability declared before it can be minted is a real state, not an error: the read
      // answers 200 with the projection, and `hasSecret` is the fact.
      registry.listCapabilityCredentials.mockResolvedValue([
        { ...publicRow, hasSecret: false, credentialUpdatedAt: null },
      ]);

      const [only] = await controller.capabilityCredentials('hr');

      expect(only.hasSecret).toBe(false);
      expect(only.credentialUpdatedAt).toBeNull();
    });

    it('returns the plaintext from the write route and NOWHERE else', async () => {
      registry.rotateCapabilityCredential.mockResolvedValue({ secret: 'generated-once' });

      const issued = await controller.rotateCapabilityCredential(
        request(actor),
        'hr',
        'platform.audit@v1',
      );

      expect(issued).toEqual({ secret: 'generated-once' });
      // One field, so nothing can ride along on a provisioning response.
      expect(Object.keys(issued)).toEqual(['secret']);

      // And no read can reconstruct it: the projection has no field for it and the value never
      // appears in a list body.
      registry.listCapabilityCredentials.mockResolvedValue([publicRow]);
      const read = await controller.capabilityCredentials('hr');

      expect(JSON.stringify(read)).not.toContain('generated-once');
    });

    it('addresses the credential by (moduleId, capability), so one rotation cannot move both', async () => {
      registry.rotateCapabilityCredential.mockResolvedValue({ secret: 's' });

      await controller.rotateCapabilityCredential(request(actor), 'hr', 'platform.identity@v1');

      // The pair is in the URL, so there is no body a later edit could widen into a bulk rotate.
      expect(registry.rotateCapabilityCredential).toHaveBeenCalledWith(
        actor,
        'hr',
        'platform.identity@v1',
      );
      expect(registry.rotateCapabilityCredential).toHaveBeenCalledTimes(1);
    });
  });
});

