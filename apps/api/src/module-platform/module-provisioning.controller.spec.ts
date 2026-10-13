import { Test } from '@nestjs/testing';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModuleProvisioningController } from './module-provisioning.controller';
import { ModuleProvisioningService } from './module-provisioning.service';
import { ProvisioningProviderRegistry } from './provisioning-provider.registry';
import { LocalProvisioningProvider } from './local-provisioning.provider';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MODULE_OPERATIONAL_STATES } from './module-operational-state';

/**
 * Phase 49M-1 §2.7: the admin provisioning surface.
 *
 * WHAT THIS FILE PROVES. The service's rules are NOT re-asserted here — they live in
 * `module-provisioning.service.spec.ts`. This file is about the seam:
 *
 *  1. NO ROUTE IS UNGATED, and NO NEW PERMISSION was introduced. The declared set is exactly
 *     `admin.modules.read` and `admin.modules.manage`, both of which already exist and are
 *     already granted. A route added later without `@Roles()` would be authenticated but not
 *     authorised, and nothing else in the suite would notice.
 *  2. READS AND ACTIONS ARE SPLIT CORRECTLY. `run` changes what is running, so it is
 *     manage-level even though it looks like a poll.
 *  3. `capabilities` IS DECLARED BEFORE ANY `:executionId` ROUTE. Nest matches in declaration
 *     order, so the reverse order would send `GET .../capabilities` into a UUID pipe.
 *  4. THE ACTOR COMES FROM THE VERIFIED TOKEN, never the body — an actor read from user input
 *     makes the audit trail forgeable.
 *  5. NO ROUTE FORWARDS A URL, A HOST, A COMMAND OR A STATE, even when the body carries one.
 */

const request = (sub?: string) => ({ user: sub ? { sub } : undefined }) as never;

describe('ModuleProvisioningController', () => {
  let controller: ModuleProvisioningController;
  let provisioning: Record<string, jest.Mock>;

  const actor = 'user-admin-1';
  const execId = '33333333-3333-4333-8333-333333333333';

  beforeEach(async () => {
    provisioning = {
      request: jest.fn().mockResolvedValue({ accepted: true, executionId: execId }),
      runExecution: jest.fn().mockResolvedValue('OK'),
      getExecution: jest.fn().mockResolvedValue({ id: execId }),
      listExecutions: jest.fn().mockResolvedValue([]),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ModuleProvisioningController],
      providers: [
        { provide: ModuleProvisioningService, useValue: provisioning },
        {
          provide: ProvisioningProviderRegistry,
          useValue: new ProvisioningProviderRegistry(
            new LocalProvisioningProvider({ probeInstance: jest.fn() } as never),
          ),
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(ModuleProvisioningController);
  });

  describe('permission gates', () => {
    const proto = ModuleProvisioningController.prototype as unknown as Record<string, object>;

    const rolesOf = (handler: string) => Reflect.getMetadata('roles', proto[handler]);

    const handlers = () =>
      Object.getOwnPropertyNames(proto).filter(
        (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name]),
      );

    it('gates the three reads on admin.modules.read', () => {
      expect(rolesOf('capabilities')).toEqual(['admin.modules.read']);
      expect(rolesOf('execution')).toEqual(['admin.modules.read']);
      expect(rolesOf('history')).toEqual(['admin.modules.read']);
    });

    it('gates request and run on admin.modules.manage', () => {
      // `run` is manage-level because it changes what is running, despite reading like a poll.
      expect(rolesOf('request')).toEqual(['admin.modules.manage']);
      expect(rolesOf('run')).toEqual(['admin.modules.manage']);
    });

    it('leaves NO route ungated', () => {
      expect(handlers().filter((name) => !Reflect.getMetadata('roles', proto[name]))).toEqual([]);
    });

    it('introduces NO new permission', () => {
      // A `admin.provisioning.*` permission would have meant a new seed migration and three
      // new role grants for a capability the existing pair already describes exactly.
      const declared = handlers().flatMap(
        (name) => (Reflect.getMetadata('roles', proto[name]) ?? []) as string[],
      );

      expect([...new Set(declared)].sort()).toEqual(['admin.modules.manage', 'admin.modules.read']);
    });

    it('exposes exactly five routes, two of them mutating', () => {
      // A sixth route appearing without a corresponding assertion above is the drift this
      // catches.
      expect(handlers()).toHaveLength(5);

      const mutating = handlers().filter(
        (name) =>
          (Reflect.getMetadata('roles', proto[name]) as string[])?.[0] === 'admin.modules.manage',
      );

      expect(mutating.sort()).toEqual(['request', 'run']);
    });
  });

  describe('route ordering', () => {
    it('declares capabilities BEFORE any :executionId route', () => {
      // Nest matches in declaration order. Reversed, `GET .../capabilities` would be captured
      // by `executions/:executionId` and rejected by its UUID pipe — the same shadowing hazard
      // ModuleRegistryController documents for `GET /platform`.
      const proto = ModuleProvisioningController.prototype as unknown as Record<string, object>;

      const paths = Object.getOwnPropertyNames(proto)
        .filter(
          (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name]),
        )
        .map((name) => Reflect.getMetadata(PATH_METADATA, proto[name]) as string);

      const parameterised = paths.findIndex((path) => path.includes(':'));

      expect(paths.indexOf('capabilities')).toBe(0);
      expect(parameterised).toBeGreaterThan(0);
    });
  });

  describe('actor identity', () => {
    it('takes the actor from the verified token, never from the body', async () => {
      await controller.request(request(actor), {
        moduleId: 'finance',
        action: 'PROVISION',
        targetKey: 'local-primary',
        requestKey: 'req-1',
        releaseVersion: '1.0.0',
      } as never);

      expect(provisioning.request).toHaveBeenCalledWith(actor, expect.anything());
    });

    it('passes an empty actor rather than inventing one when the token has no subject', async () => {
      // Fabricating 'system' would put a false actor in the audit trail.
      await controller.request(request(), {
        moduleId: 'finance',
        action: 'PROVISION',
        targetKey: 'local-primary',
        requestKey: 'req-1',
        releaseVersion: '1.0.0',
      } as never);

      expect(provisioning.request).toHaveBeenCalledWith('', expect.anything());
    });
  });

  describe('what the request route refuses to forward', () => {
    it('forwards ONLY the six contract fields, dropping url, host, command and state', async () => {
      // §40's anti-pattern is `POST /modules/call { "url": … }`. The equivalent here is a
      // provisioning request naming a host or a shell command. Even a body carrying them
      // cannot reach the service, because the controller re-builds the payload field by field.
      await controller.request(request(actor), {
        moduleId: 'finance',
        action: 'PROVISION',
        targetKey: 'local-primary',
        requestKey: 'req-1',
        releaseVersion: '1.0.0',
        instanceKey: 'finance-prod-01',
        baseUrl: 'https://attacker.example.com',
        host: '10.0.0.5',
        command: 'rm -rf /',
        operationalState: 'ACTIVE',
        artifactKey: 'modules/other/evil.tgz',
        credentialRef: 'stolen',
      } as never);

      const forwarded = provisioning.request.mock.calls[0][1];

      expect(Object.keys(forwarded).sort()).toEqual([
        'action',
        'instanceKey',
        'moduleId',
        'releaseVersion',
        'requestKey',
        'targetKey',
      ]);
    });
  });

  describe('capabilities', () => {
    it('reports the control plane as implemented and REMOTE_AGENT as unavailable', async () => {
      const body = await controller.capabilities();

      // Scoped precisely: this is NOT the same claim as `foundations.provisioningImplemented`
      // on GET /admin/modules/platform, which reports 49M's ModuleProvisioner extension point
      // and stays false because nothing implements that interface.
      expect(body.controlPlaneImplemented).toBe(true);

      const remote = body.targets.find((t) => t.targetType === 'REMOTE_AGENT');

      expect(remote?.available).toBe(false);
      expect(remote?.unsupportedActions).toHaveLength(9);
    });

    it('projects the whole transition table so the UI keeps no second copy', async () => {
      const body = await controller.capabilities();

      expect(Object.keys(body.transitions).sort()).toEqual([...MODULE_OPERATIONAL_STATES].sort());

      // Terminal states are present as keys with NO outgoing edges, rather than absent.
      // Absence would be indistinguishable from "state unknown to this build".
      for (const terminal of body.terminalStates) {
        expect(body.transitions[terminal]).toEqual([]);
      }
    });

    it('never exposes a credential reference or an artifact key', async () => {
      const body = await controller.capabilities();

      expect(JSON.stringify(body)).not.toMatch(/credentialRef|artifactKey/);
    });
  });

  describe('history', () => {
    it('parses take, and passes undefined for a non-numeric value rather than NaN', async () => {
      await controller.history('finance', '25');
      expect(provisioning.listExecutions).toHaveBeenCalledWith('finance', 25);

      await controller.history('finance', 'all');
      expect(provisioning.listExecutions).toHaveBeenLastCalledWith('finance', undefined);

      await controller.history('finance');
      expect(provisioning.listExecutions).toHaveBeenLastCalledWith('finance', undefined);
    });

    it('leaves the ceiling to the service instead of trusting the query string', async () => {
      // Parsed here, CLAMPED there. Asserting the raw value reached the service is what makes
      // the service's clamp the single place that bounds the read.
      await controller.history('finance', '999999');

      expect(provisioning.listExecutions).toHaveBeenCalledWith('finance', 999999);
    });
  });

  describe('run', () => {
    it('returns the outcome code alongside the id, never a bare 200', async () => {
      provisioning.runExecution.mockResolvedValue('CHECKSUM_MISMATCH');

      await expect(controller.run(execId)).resolves.toEqual({
        executionId: execId,
        code: 'CHECKSUM_MISMATCH',
      });
    });
  });
});
