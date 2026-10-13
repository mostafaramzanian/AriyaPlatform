import { readFileSync } from 'fs';
import { join } from 'path';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import {
  FEATURE_REQUIREMENT_KEY,
  MODULE_REQUIREMENT_KEY,
} from '../../../platform/entitlement/entitlement.contract';
import { ModuleEntitlementGuard } from '../../../platform/entitlement/module-entitlement.guard';
import { FINANCIAL_FEATURE, FINANCIAL_MODULE_ID } from '../financial.constants';
import { CheckRequestController } from './check-request.controller';
import { CheckProcessController } from './check-process.controller';
import { CheckRequestService } from './check-request.service';
import { CheckAttachmentService } from './check-attachment.service';

/**
 * Phase F1 + CHECK-ISSUATION: the boundary statements on the check-request routes.
 *
 * CHECKED HERE, deliberately: (1) no route is ungated — `RolesGuard` is a global
 * APP_GUARD, so what can break silently is a route added without `@Roles(...)`;
 * (2) each remit gets its own permission — `read` / `manage` / `approve` / the four
 * stage capabilities — never two on one route; (3) the entitlement declaration comes
 * from the constants, once, on each class; (4) every handler resolves the ACTOR — no
 * service call can receive a raw request; (5) the process-definition controller carries
 * the SAME chain as the requests surface. The orchestration lives in
 * `check-request.service.spec.ts` / `check-issuance.service.spec.ts` and is not
 * re-asserted here.
 */

describe('CheckRequestController', () => {
  let requests: Record<string, jest.Mock>;
  let attachments: Record<string, jest.Mock>;

  beforeEach(async () => {
    requests = {
      list: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 }),
      getOne: jest.fn().mockResolvedValue({}),
      getTimeline: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      submit: jest.fn().mockResolvedValue({}),
      decide: jest.fn().mockResolvedValue({}),
      allocate: jest.fn().mockResolvedValue({}),
      reviewDocuments: jest.fn().mockResolvedValue({}),
      executiveDecision: jest.fn().mockResolvedValue({}),
      issue: jest.fn().mockResolvedValue({}),
      deliver: jest.fn().mockResolvedValue({}),
      availableActions: jest.fn().mockResolvedValue({ actions: [] }),
    };
    attachments = {
      list: jest.fn().mockResolvedValue([]),
      upload: jest.fn().mockResolvedValue({}),
      updateMetadata: jest.fn().mockResolvedValue({}),
      remove: jest.fn().mockResolvedValue({ deleted: true, id: 'a' }),
      resolveDownloadUrl: jest.fn().mockResolvedValue({ url: 'u', fileName: 'f', mimeType: 'm' }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [CheckRequestController, CheckProcessController],
      providers: [
        { provide: CheckRequestService, useValue: requests },
        { provide: CheckAttachmentService, useValue: attachments },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ModuleEntitlementGuard)
      .useValue({ canActivate: () => true })
      .compile();

    void moduleRef.get(CheckRequestController);
    void moduleRef.get(CheckProcessController);
  });

  const proto = CheckRequestController.prototype as unknown as Record<string, object>;

  /** Every route handler on the controller, discovered rather than hard-coded. */
  const handlers = (): string[] =>
    Object.getOwnPropertyNames(CheckRequestController.prototype).filter(
      (name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name])
    );

  const rolesOf = (handler: string): string[] | undefined =>
    Reflect.getMetadata('roles', proto[handler]);

  describe('permission gates', () => {
    it('leaves NO route ungated — the discovery itself is sanity-checked', () => {
      const discovered = handlers();
      // Fourteen routes: the eight lifecycle ones plus the six attachment ones.
      expect(discovered.length).toBeGreaterThanOrEqual(14);

      const ungated = discovered.filter((name) => {
        const roles = rolesOf(name);
        return !Array.isArray(roles) || roles.length === 0;
      });
      expect(ungated).toEqual([]);
    });

    it('gates every route on exactly one permission', () => {
      // One permission per route, because `RolesGuard` uses `.some(...)`: a second entry
      // can only WIDEN a route, never narrow it.
      for (const name of handlers()) {
        expect({ name, roles: rolesOf(name) }).toEqual({ name, roles: [rolesOf(name)![0]] });
      }
    });

    it('splits READ / MANAGE / APPROVE / the four stage remits exactly as the routes are drawn', () => {
      for (const name of [
        'list',
        'getOne',
        'getTimeline',
        'listAttachments',
        'getAttachmentUrl',
        'availableActions',
      ]) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.FINANCIAL_CHECK_READ],
        });
      }
      for (const name of [
        'create',
        'update',
        'submit',
        'uploadAttachment',
        'updateAttachmentMetadata',
        'deleteAttachment',
      ]) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.FINANCIAL_CHECK_MANAGE],
        });
      }
      // The deciding remit — deliberately NOT `manage`: an author must not reach a
      // decision route through the permission they already hold. Phase CHECK-ISSUATION
      // keeps the presidency on the SAME capability (the brief's §12 rule: a new
      // permission only for a genuinely separate capability).
      for (const name of ['approve', 'reject', 'requestCorrection', 'executiveApproval']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.FINANCIAL_CHECK_APPROVE],
        });
      }
      // The four STAGE capabilities, one route each — the cheque image upload is the
      // issuer's, the receipt upload the deliverer's, and the deletion routes mirror them.
      expect({ name: 'allocate', roles: rolesOf('allocate') }).toEqual({
        name: 'allocate',
        roles: [Permissions.FINANCIAL_CHECK_ALLOCATE],
      });
      for (const name of ['reviewDocuments']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.FINANCIAL_CHECK_REVIEW],
        });
      }
      for (const name of ['issue', 'uploadChequeImage', 'deleteChequeImage']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.FINANCIAL_CHECK_ISSUE],
        });
      }
      for (const name of ['completeDelivery', 'uploadDeliveryReceipt', 'deleteDeliveryReceipt']) {
        expect({ name, roles: rolesOf(name) }).toEqual({
          name,
          roles: [Permissions.FINANCIAL_CHECK_DELIVER],
        });
      }
    });

    it('draws every gate from the Permissions constants rather than a literal', () => {
      // A hand-typed `'financial.check.aprove'` would still be metadata, still look
      // gated, and match no role — failing closed but invisibly, as a 403 nobody can
      // explain.
      const known = new Set<string>(Object.values(Permissions));
      for (const name of handlers()) {
        expect(known).toContain(rolesOf(name)![0]);
      }
    });
  });

  describe('entitlement declaration', () => {
    it('declares the module and the feature once, on the class, from the constants', () => {
      expect(Reflect.getMetadata(MODULE_REQUIREMENT_KEY, CheckRequestController)).toBe(
        FINANCIAL_MODULE_ID
      );
      expect(Reflect.getMetadata(FEATURE_REQUIREMENT_KEY, CheckRequestController)).toEqual({
        moduleId: FINANCIAL_MODULE_ID,
        featureId: FINANCIAL_FEATURE.CHECK_REQUEST,
      });
    });

    it('declares no tenant scope of its own, which is the platform guard’s job', () => {
      // Financial DECLARES the requirement; the platform DECIDES it. A second mechanism
      // here would be a second answer to the same question.
      const source = readFileSync(join(__dirname, 'check-request.controller.ts'), 'utf8');
      expect(source).not.toMatch(/@RequiresTenant|req\.query\.tenantId|req\.params\.tenantId/);
    });

    it('resolves the ACTOR in every handler — no service call can receive a raw request', () => {
      const source = readFileSync(join(__dirname, 'check-request.controller.ts'), 'utf8');
      // Comments are stripped first: the file header EXPLAINS `resolveFinancialActor(req)`
      // in prose, and a prose mention must not count as a call (the same rule
      // `production-isolation.spec.ts` states for its token scans).
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const handlerCount = (code.match(/async \w+\(/g) ?? []).length;
      const actorCalls = code.match(/resolveFinancialActor\(req\)/g) ?? [];
      // Phase CHECK-ISSUATION grew the surface from 14 to 21 handlers; the EQUALITY is
      // the assertion that matters — every handler, no exception.
      expect(handlerCount).toBeGreaterThanOrEqual(21);
      expect(actorCalls.length).toBe(handlerCount);
    });
  });
});

describe('CheckProcessController', () => {
  const proto = CheckProcessController.prototype as unknown as Record<string, object>;

  it('declares the module and the feature once, on the class, from the constants', () => {
    expect(Reflect.getMetadata(MODULE_REQUIREMENT_KEY, CheckProcessController)).toBe(
      FINANCIAL_MODULE_ID
    );
    expect(Reflect.getMetadata(FEATURE_REQUIREMENT_KEY, CheckProcessController)).toEqual({
      moduleId: FINANCIAL_MODULE_ID,
      featureId: FINANCIAL_FEATURE.CHECK_REQUEST,
    });
  });

  it('gates its one route on `financial.check.read` — and resolves the actor like every sibling', () => {
    const roles = Reflect.getMetadata('roles', proto.getProcess);
    expect(roles).toEqual([Permissions.FINANCIAL_CHECK_READ]);

    const source = readFileSync(join(__dirname, 'check-process.controller.ts'), 'utf8');
    expect(source).toContain('@UseGuards(ModuleEntitlementGuard)');
    expect(source).toContain('@UseGuards(JwtAuthGuard)');
    expect(source).toContain('resolveFinancialActor(req)');
  });

  it('serves the FROZEN published definition — the wizard renders exactly what ships', async () => {
    const { CHECK_ISSUANCE_DEFINITION_V1 } = await import('../process/check-issuance.definition');
    class RequestStub {
      headers: Record<string, string> = {};
    }
    const controller = new CheckProcessController();
    // A tenant-less request must fail closed (403) — the same actor resolution as every
    // Financial route, exercised here without a Nest container.
    await expect(
      Promise.resolve(
        controller.getProcess(new RequestStub() as unknown as import('express').Request)
      )
    ).rejects.toThrow(/tenant context|Forbidden/i);

    // And with a context it returns the frozen definition ITSELF (Object.freeze survives
    // serialization as the same object here; Nest serializes it for the wire).
    const { RequestContextService } = await import('../../../common/request-context.service');
    RequestContextService.set({
      requestId: 'req-process-1',
      correlationId: 'corr-process-1',
      startTime: Date.now(),
      tenantId: 'tenant-a',
    });
    const definition = await controller.getProcess(
      new RequestStub() as unknown as import('express').Request
    );
    expect(definition).toBe(CHECK_ISSUANCE_DEFINITION_V1);
  });
});
