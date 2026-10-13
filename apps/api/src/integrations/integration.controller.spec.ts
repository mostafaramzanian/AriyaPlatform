import { Test } from '@nestjs/testing';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { AutomationService } from './automation.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request as ExRequest } from 'express';

/** The verified JWT principal the controller pulls the actor from — never the body. */
interface AuthenticatedExRequest {
  user?: { sub?: string };
}

/**
 * Phase 49L §28: RBAC on the admin surface.
 *
 * Three things are checked here and deliberately nothing else — the business rules live
 * in `integration.service.spec.ts` and are not re-asserted through the controller:
 *
 *  1. PERMISSION METADATA PER ROUTE, read back off the prototype. `RolesGuard` is global
 *     via APP_GUARD, so it is not exercised in a unit test; what CAN break silently is a
 *     route added or copied without a `@Roles()` decorator, which would then be
 *     authenticated but not AUTHORIZED. Every route is asserted, including the
 *     leaves-nothing-ungated case, so a new unguarded route fails this file.
 *
 *  2. THE ACTOR IS TAKEN FROM THE VERIFIED TOKEN, never from the body or a header. An
 *     actor read from user input makes the audit trail forgeable.
 *
 *  3. THE MANUAL TRIGGER CANNOT NAME A DESTINATION. §29's anti-pattern is
 *     `POST /automation { "url": "..." }`; the assertion here is that the controller
 *     forwards only contract fields, so even a body carrying a `url` could not reach the
 *     emitter.
 */

const request = (sub?: string): ExRequest =>
  ({ user: sub ? { sub } : undefined }) as AuthenticatedExRequest as unknown as ExRequest;

describe('IntegrationController', () => {
  let controller: IntegrationController;
  let integrations: Record<string, jest.Mock>;
  let automation: { emit: jest.Mock };

  const actor = 'user-admin-1';
  const configId = '11111111-1111-4111-8111-111111111111';

  beforeEach(async () => {
    integrations = {
      listConfigs: jest.fn(),
      getConfig: jest.fn(),
      createConfig: jest.fn(),
      updateConfig: jest.fn(),
      deleteConfig: jest.fn(),
      rotateSecret: jest.fn(),
      testConnection: jest.fn(),
      listExecutions: jest.fn(),
    };

    automation = { emit: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [IntegrationController],
      providers: [
        { provide: IntegrationService, useValue: integrations },
        { provide: AutomationService, useValue: automation },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(IntegrationController);
  });

  describe('permission gates', () => {
    const rolesOf = (handler: keyof IntegrationController) =>
      Reflect.getMetadata('roles', IntegrationController.prototype[handler]);

    /** Every route handler on the controller, discovered rather than hard-coded. */
    const handlers = () =>
      Object.getOwnPropertyNames(IntegrationController.prototype).filter(
        (name) =>
          name !== 'constructor' &&
          Reflect.hasMetadata(
            METHOD_METADATA,
            IntegrationController.prototype[name as keyof IntegrationController],
          ),
      );

    it('gates the READ routes on admin.integrations.read', () => {
      // OPERATIONS_ADMIN holds this and not manage, so it can diagnose delivery without
      // being able to repoint the destination or rotate the secret.
      expect(rolesOf('list')).toEqual(['admin.integrations.read']);
      expect(rolesOf('getOne')).toEqual(['admin.integrations.read']);
      expect(rolesOf('executions')).toEqual(['admin.integrations.read']);
    });

    it('gates every WRITE route on admin.integrations.manage', () => {
      expect(rolesOf('create')).toEqual(['admin.integrations.manage']);
      expect(rolesOf('update')).toEqual(['admin.integrations.manage']);
      expect(rolesOf('remove')).toEqual(['admin.integrations.manage']);
    });

    it('gates the secret rotation, the test and the manual trigger at WRITE level', () => {
      // Rotation replaces a credential; the test sends a real signed request to operator
      // infrastructure; the trigger causes an outbound side effect. None is a read.
      expect(rolesOf('rotateSecret')).toEqual(['admin.integrations.manage']);
      expect(rolesOf('test')).toEqual(['admin.integrations.manage']);
      expect(rolesOf('trigger')).toEqual(['admin.integrations.manage']);
    });

    it('leaves NO route ungated', () => {
      // The check that survives future edits: a route added without @Roles() is
      // authenticated but unauthorised, and nothing else in the suite would notice.
      const ungated = handlers().filter(
        (name) =>
          !Reflect.getMetadata(
            'roles',
            IntegrationController.prototype[name as keyof IntegrationController],
          ),
      );

      expect(ungated).toEqual([]);
    });

    it('uses only the two seeded integration permissions, never an invented string', () => {
      // A typo'd permission is a permission nobody holds: the route becomes unreachable
      // for every role, including SUPER_ADMIN.
      const used = new Set(
        handlers().flatMap(
          (name) =>
            (Reflect.getMetadata(
              'roles',
              IntegrationController.prototype[name as keyof IntegrationController],
            ) ??
              []) as string[],
        ),
      );

      expect([...used].sort()).toEqual(['admin.integrations.manage', 'admin.integrations.read']);
    });
  });

  describe('actor resolution', () => {
    it('passes the JWT subject as the actor on every write', async () => {
      await controller.create(request(actor), {
        integration: 'N8N',
        baseUrl: 'https://automation.example.com',
        webhookPath: '/webhook/aria',
      });
      await controller.update(request(actor), configId, { enabled: false });
      await controller.remove(request(actor), configId);
      await controller.rotateSecret(request(actor), configId);
      await controller.test(request(actor), configId);

      expect(integrations.createConfig.mock.calls[0][0]).toBe(actor);
      expect(integrations.updateConfig.mock.calls[0][0]).toBe(actor);
      expect(integrations.deleteConfig.mock.calls[0][0]).toBe(actor);
      expect(integrations.rotateSecret.mock.calls[0][0]).toBe(actor);
      expect(integrations.testConnection.mock.calls[0][0]).toBe(actor);
    });

    it('takes the trigger actor from the token, not from the body', async () => {
      // Cast on the WHOLE object: a body-supplied `actor` would make the execution trail
      // forgeable, so the DTO has no such field and the controller never reads one. The
      // cast is what lets the test send the field the type system refuses.
      await controller.trigger(request(actor), {
        eventType: 'ticket.created',
        source: 'support',
        payload: { ticketId: 't-1' },
        actor: { type: 'user', id: 'someone-else' },
      } as never);

      expect(automation.emit.mock.calls[0][0].actor).toEqual({ type: 'user', id: actor });
    });
  });

  describe('manual trigger shape', () => {
    it('forwards ONLY contract fields — no destination can be smuggled through', async () => {
      // `url`, `integration` and `timeoutMs` are not in the DTO, so `forbidNonWhitelisted`
      // would already 400 them. This asserts the second layer: even if they arrived, the
      // controller enumerates the forwarded fields explicitly and they never reach the
      // emitter.
      await controller.trigger(request(actor), {
        eventType: 'ticket.created',
        source: 'support',
        payload: { ticketId: 't-1' },
        eventId: 'evt-1',
        url: 'http://169.254.169.254/',
        integration: 'N8N',
        timeoutMs: 999_999,
      } as never);

      expect(Object.keys(automation.emit.mock.calls[0][0]).sort()).toEqual([
        'actor',
        'eventId',
        'eventType',
        'payload',
        'source',
      ]);
    });
  });

  describe('response pass-through', () => {
    it('returns the service result unchanged, so no route can reshape a projection', async () => {
      // The secret-masking guarantee is a property of the service's single projection; a
      // controller that spread or mapped the result could reintroduce a field.
      const listResult = { configs: [], integrations: [] };
      const oneResult = { id: configId, hasSecret: true };

      integrations.listConfigs.mockResolvedValue(listResult);
      integrations.getConfig.mockResolvedValue(oneResult);

      await expect(controller.list()).resolves.toBe(listResult);
      await expect(controller.getOne(configId)).resolves.toBe(oneResult);
    });

    it('parses the execution page parameters without inventing defaults of its own', async () => {
      await controller.executions('10', 'cursor-1');
      expect(integrations.listExecutions).toHaveBeenCalledWith({ limit: 10, cursor: 'cursor-1' });

      await controller.executions(undefined, undefined);
      expect(integrations.listExecutions).toHaveBeenLastCalledWith({
        limit: undefined,
        cursor: undefined,
      });

      // An empty cursor string is not a cursor.
      await controller.executions(undefined, '');
      expect(integrations.listExecutions).toHaveBeenLastCalledWith({
        limit: undefined,
        cursor: undefined,
      });
    });
  });
});

