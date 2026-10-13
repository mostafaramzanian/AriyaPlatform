import { Test } from '@nestjs/testing';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { AIConfigController } from './ai-config.controller';
import { AIConfigService } from './ai-config.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/**
 * Phase 49J-0: HTTP surface for AI provider configuration.
 *
 * Three things are checked here, and deliberately nothing else — the business
 * rules live in ai-config.service.spec.ts and are not re-asserted through the
 * controller:
 *
 *  1. RBAC METADATA PER ROUTE, read back off the prototype. `RolesGuard` is global
 *     via APP_GUARD, so it is not exercised in a unit test; what CAN break silently
 *     is a route added or copied without a `@Roles()` decorator, which would then be
 *     authenticated but not authorised. Every route is asserted, including the
 *     absence-of-decorator case, so a new unguarded route fails this file.
 *
 *  2. THE ACTOR IS TAKEN FROM THE VERIFIED TOKEN, never from the body or a header.
 *     An actor read from user input makes the audit trail forgeable.
 *
 *  3. NO ROUTE RESHAPES THE SERVICE RESPONSE. The masking guarantee is a property of
 *     the service's single projection; a controller that mapped or spread the result
 *     could reintroduce a field, so each route is asserted to pass the object
 *     straight through.
 */

/** The verified JWT principal the controller pulls the actor from — never the body. */
interface AuthenticatedExRequest {
  user?: { sub?: string };
}

const request = (sub?: string): ExRequest =>
  ({ user: sub ? { sub } : undefined }) as AuthenticatedExRequest as unknown as ExRequest;

describe('AIConfigController', () => {
  let controller: AIConfigController;
  let configs: {
    listConfigs: jest.Mock;
    getConfig: jest.Mock;
    createConfig: jest.Mock;
    updateConfig: jest.Mock;
    deleteConfig: jest.Mock;
    testConnection: jest.Mock;
  };

  const actor = 'user-admin-1';
  const configId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AIConfigController],
      providers: [
        {
          provide: AIConfigService,
          useValue: {
            listConfigs: jest.fn(),
            getConfig: jest.fn(),
            createConfig: jest.fn(),
            updateConfig: jest.fn(),
            deleteConfig: jest.fn(),
            testConnection: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<AIConfigController>(AIConfigController);
    configs = moduleRef.get(AIConfigService);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // RBAC metadata
  // ─────────────────────────────────────────────────────────────────────────────

  describe('permission gates', () => {
    const rolesOf = (handler: keyof AIConfigController) =>
      Reflect.getMetadata('roles', AIConfigController.prototype[handler]);

    /** Every route handler on the controller, discovered rather than hard-coded. */
    const handlers = () =>
      Object.getOwnPropertyNames(AIConfigController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.hasMetadata(
            METHOD_METADATA,
            AIConfigController.prototype[name as keyof AIConfigController],
          ),
      );

    it('gates the two READ routes on admin.ai.read', () => {
      // OPERATIONS_ADMIN holds this and not manage, so it can see which provider is
      // live without being able to submit a credential.
      expect(rolesOf('list')).toEqual(['admin.ai.read']);
      expect(rolesOf('getOne')).toEqual(['admin.ai.read']);
    });

    it('gates every WRITE route on admin.ai.manage', () => {
      expect(rolesOf('create')).toEqual(['admin.ai.manage']);
      expect(rolesOf('update')).toEqual(['admin.ai.manage']);
      expect(rolesOf('remove')).toEqual(['admin.ai.manage']);
    });

    it('gates the connection test at WRITE level despite mutating nothing', () => {
      // It spends money against the operator's provider account and accepts an
      // unsaved credential; read-only roles must not be able to submit keys for
      // validation.
      expect(rolesOf('test')).toEqual(['admin.ai.manage']);
    });

    it('leaves NO route ungated', () => {
      // The check that survives future edits: a route added without @Roles() is
      // authenticated but unauthorised, and nothing else in the suite would notice.
      const ungated = handlers().filter(
        (name) =>
          !Reflect.getMetadata('roles', AIConfigController.prototype[name as keyof AIConfigController]),
      );

      expect(ungated).toEqual([]);
    });

    it('uses only the two seeded AI permissions, never an invented string', () => {
      // A typo'd permission is a permission nobody holds: the route becomes
      // unreachable for every role, including SUPER_ADMIN.
      const used = new Set(
        handlers().flatMap(
          (name) =>
            (Reflect.getMetadata(
              'roles',
              AIConfigController.prototype[name as keyof AIConfigController],
            ) ?? []) as string[],
        ),
      );

      expect([...used].sort()).toEqual(['admin.ai.manage', 'admin.ai.read']);
    });

    it('applies JwtAuthGuard at the CLASS level, so authentication cannot be missed per route', () => {
      const guards = Reflect.getMetadata('__guards__', AIConfigController) ?? [];
      expect(guards).toContain(JwtAuthGuard);
    });

    it('mounts every route under the admin/ai/providers prefix', () => {
      expect(Reflect.getMetadata(PATH_METADATA, AIConfigController)).toBe('admin/ai/providers');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Delegation and actor identity
  // ─────────────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns the service payload UNCHANGED, matrix and all', async () => {
      const payload = {
        configs: [
          {
            id: configId,
            provider: 'OPENAI',
            capability: 'EMBEDDING',
            modelName: 'text-embedding-3-small',
            hasCredential: true,
          },
        ],
        providers: [{ key: 'OPENAI', capabilities: ['EMBEDDING'] }],
      };
      configs.listConfigs.mockResolvedValue(payload);

      const result = await controller.list();

      // Identity, not deep equality: a controller that mapped or spread the result
      // could reintroduce a masked field, and toEqual would not notice.
      expect(result).toBe(payload);
      expect(configs.listConfigs).toHaveBeenCalledWith();
    });
  });

  describe('getOne', () => {
    it('passes the id through and returns the service row unchanged', async () => {
      const config = { id: configId, hasCredential: false };
      configs.getConfig.mockResolvedValue(config);

      const result = await controller.getOne(configId);

      expect(result).toBe(config);
      expect(configs.getConfig).toHaveBeenCalledWith(configId);
    });
  });

  describe('create', () => {
    it('takes the actor from the TOKEN and forwards the DTO untouched', async () => {
      const dto = {
        provider: 'OPENAI' as const,
        capability: 'EMBEDDING' as const,
        modelName: 'text-embedding-3-small',
        credential: 'sk-new',
      };
      const created = { id: configId, hasCredential: true };
      configs.createConfig.mockResolvedValue(created);

      const result = await controller.create(request(actor), dto);

      expect(result).toBe(created);
      expect(configs.createConfig).toHaveBeenCalledWith(actor, dto);
    });

    it('does not read the actor from the request BODY', async () => {
      // An actor sourced from user input makes the audit trail forgeable.
      configs.createConfig.mockResolvedValue({ id: configId });

      await controller.create(request(actor), {
        provider: 'OPENAI',
        capability: 'EMBEDDING',
        modelName: 'm',
        userId: 'user-someone-else',
        actorId: 'user-someone-else',
      } as unknown as Parameters<AIConfigService['createConfig']>[1]);

      expect(configs.createConfig.mock.calls[0][0]).toBe(actor);
    });
  });

  describe('update', () => {
    it('forwards actor, id and patch in that order', async () => {
      const dto = { modelName: 'text-embedding-3-large' };
      const updated = { id: configId, hasCredential: true };
      configs.updateConfig.mockResolvedValue(updated);

      const result = await controller.update(request(actor), configId, dto);

      expect(result).toBe(updated);
      expect(configs.updateConfig).toHaveBeenCalledWith(actor, configId, dto);
    });
  });

  describe('remove', () => {
    it('forwards actor and id and returns the deletion receipt', async () => {
      configs.deleteConfig.mockResolvedValue({ id: configId, deleted: true });

      const result = await controller.remove(request(actor), configId);

      expect(result).toEqual({ id: configId, deleted: true });
      expect(configs.deleteConfig).toHaveBeenCalledWith(actor, configId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Connection test — HTTP status semantics
  // ─────────────────────────────────────────────────────────────────────────────

  describe('test', () => {
    it('returns 200 for a FAILED probe as well as a successful one', async () => {
      // A failed probe is not an HTTP error: the request itself succeeded. Mapping it
      // to 4xx/5xx would make "the upstream key is wrong" indistinguishable from
      // "this endpoint is broken", and the UI needs to render a message either way.
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, AIConfigController.prototype.test)).toBe(200);

      configs.testConnection.mockResolvedValue({ status: 'FAILURE', message: 'اتصال برقرار نشد.' });

      const failure = await controller.test(request(actor), configId, {});
      expect(failure.status).toBe('FAILURE');

      configs.testConnection.mockResolvedValue({ status: 'SUCCESS', message: 'اتصال برقرار شد.' });

      const success = await controller.test(request(actor), configId, {});
      expect(success.status).toBe('SUCCESS');
    });

    it('forwards a submitted credential so a key can be verified before saving', async () => {
      configs.testConnection.mockResolvedValue({ status: 'SUCCESS', message: 'ok' });

      await controller.test(request(actor), configId, { credential: 'sk-candidate' });

      expect(configs.testConnection).toHaveBeenCalledWith(actor, configId, {
        credential: 'sk-candidate',
      });
    });

    it('returns only status and message, never upstream detail', async () => {
      const outcome = { status: 'FAILURE' as const, message: 'اتصال برقرار نشد.' };
      configs.testConnection.mockResolvedValue(outcome);

      const result = await controller.test(request(actor), configId, {});

      expect(result).toBe(outcome);
      expect(Object.keys(result).sort()).toEqual(['message', 'status']);
    });

    it('is a POST, not a GET, so a credential never lands in a URL or an access log', async () => {
      expect(Reflect.getMetadata(METHOD_METADATA, AIConfigController.prototype.test)).toBe(
        RequestMethod.POST
      );
      expect(Reflect.getMetadata(PATH_METADATA, AIConfigController.prototype.test)).toBe(
        ':id/test'
      );
    });
  });

  describe('created resources', () => {
    it('answers 201 on create and the framework default elsewhere', async () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, AIConfigController.prototype.create)).toBe(
        201
      );
      // Patch and Delete carry no override, so Nest's 200 applies; asserting the
      // absence keeps a stray @HttpCode(204) from silently emptying a response body
      // the UI reads.
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, AIConfigController.prototype.update)
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, AIConfigController.prototype.remove)
      ).toBeUndefined();
    });
  });
});
