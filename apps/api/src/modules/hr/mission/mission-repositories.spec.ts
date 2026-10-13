import { MissionApprovalRepository } from './mission-approval.repository';
import { MissionPolicyRepository } from './mission-policy.repository';
import { MissionRepository } from './mission.repository';
import type { HrPrismaService } from '../database/hr-prisma.service';

const TENANT_A = 'tenant-a';

/**
 * Phase 55: repository tenant scoping and persistence shape, tested without a database.
 *
 * WHY A HAND-BUILT FAKE
 * ---------------------
 * The assertions pin the `where` and `data` the database would receive. A full Prisma fake
 * would be machinery asserting itself; a handful of `jest.fn()`s state exactly which calls
 * a repository may issue.
 */

function makePrisma(partial: Record<string, unknown>): HrPrismaService {
  return partial as unknown as HrPrismaService;
}

describe('Mission repositories', () => {
  describe('MissionRepository', () => {
    it('findRequestById scopes by tenant', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const repo = new MissionRepository(makePrisma({ missionRequest: { findFirst } }));

      await repo.findRequestById(TENANT_A, 'req-1');

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'req-1', tenantId: TENANT_A },
        })
      );
    });

    it('createRequest writes the tenant and default status fields', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'req-1' });
      const repo = new MissionRepository(makePrisma({ missionRequest: { create } }));

      await repo.createRequest(TENANT_A, {
        employeeId: 'emp-1',
        durationMode: 'DAILY',
        locationType: 'IN_CITY',
        engagementType: 'PROJECT',
        startDate: new Date('2026-09-20'),
        endDate: new Date('2026-09-21'),
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_A,
            employeeId: 'emp-1',
            durationMode: 'DAILY',
          }),
        })
      );
    });

    it('markApproved uses the compound tenant key', async () => {
      const update = jest.fn().mockResolvedValue({});
      const repo = new MissionRepository(makePrisma({ missionRequest: { update } }));

      const approvedAt = new Date('2026-09-21T10:00:00.000Z');
      await repo.markApproved(TENANT_A, 'req-1', approvedAt);

      expect(update).toHaveBeenCalledWith({
        where: { tenantId_id: { tenantId: TENANT_A, id: 'req-1' } },
        data: { status: 'APPROVED', approvedAt },
      });
    });

    it('listRequestPage is bounded and tenant-scoped', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const count = jest.fn().mockResolvedValue(0);
      const $transaction = jest.fn(async (arg: unknown) => Promise.all(arg as Promise<unknown>[]));
      const repo = new MissionRepository(
        makePrisma({ missionRequest: { findMany, count }, $transaction })
      );

      await repo.listRequestPage(TENANT_A, {}, { skip: 0, take: 20 });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_A },
          take: 20,
          skip: 0,
        })
      );
    });

    it('replaceOptionSelections deletes only this tenant/request then recreates', async () => {
      const deleteMany = jest.fn().mockResolvedValue(undefined);
      const createMany = jest.fn().mockResolvedValue(undefined);
      const findMany = jest.fn().mockResolvedValue([]);
      const $transaction = jest.fn(async (fn: unknown) => {
        const callback = fn as (tx: {
          missionRequestOptionSelection: {
            deleteMany: jest.Mock;
            createMany: jest.Mock;
            findMany: jest.Mock;
          };
        }) => Promise<unknown>;
        return callback({ missionRequestOptionSelection: { deleteMany, createMany, findMany } });
      });
      const repo = new MissionRepository(makePrisma({ $transaction }));

      await repo.replaceOptionSelections(TENANT_A, 'req-1', [
        { optionGroupId: 'group-1', missionOptionId: 'opt-1' },
      ]);

      expect(deleteMany).toHaveBeenCalledWith({
        where: { tenantId: TENANT_A, missionRequestId: 'req-1' },
      });
      expect(createMany).toHaveBeenCalledWith({
        data: [
          {
            tenantId: TENANT_A,
            missionRequestId: 'req-1',
            optionGroupId: 'group-1',
            missionOptionId: 'opt-1',
          },
        ],
      });
    });

    it('findOptionGroupById scopes by tenant', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const repo = new MissionRepository(makePrisma({ missionOptionGroup: { findFirst } }));

      await repo.findOptionGroupById(TENANT_A, 'group-1');

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'group-1', tenantId: TENANT_A },
        })
      );
    });

    it('createReport writes the tenant', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'report-1' });
      const repo = new MissionRepository(makePrisma({ missionReport: { create } }));

      await repo.createReport(TENANT_A, {
        missionRequestId: 'req-1',
        employeeId: 'emp-1',
        content: 'completed',
      });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId: TENANT_A }),
        })
      );
    });
  });

  describe('MissionApprovalRepository', () => {
    it('findDefinitionById scopes by tenant and includes ordered steps', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const repo = new MissionApprovalRepository(
        makePrisma({ missionApprovalDefinition: { findFirst } })
      );

      await repo.findDefinitionById(TENANT_A, 'def-1');

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'def-1', tenantId: TENANT_A },
          include: expect.objectContaining({
            steps: expect.objectContaining({ orderBy: expect.any(Array) }),
          }),
        })
      );
    });

    it('findLiveInstance scopes by tenant and ACTIVE', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const repo = new MissionApprovalRepository(
        makePrisma({ missionApprovalInstance: { findFirst } })
      );

      await repo.findLiveInstance(TENANT_A, 'req-1');

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_A, missionRequestId: 'req-1', status: 'ACTIVE' },
        })
      );
    });

    it('recordStepDecision scopes by tenant, instance and step order', async () => {
      const updateMany = jest.fn().mockResolvedValue({ count: 1 });
      const repo = new MissionApprovalRepository(
        makePrisma({ missionApprovalStepInstance: { updateMany } })
      );

      const decidedAt = new Date('2026-09-21T10:00:00.000Z');
      await repo.recordStepDecision({
        tenantId: TENANT_A,
        approvalInstanceId: 'inst-1',
        stepOrder: 1,
        decision: 'APPROVED',
        decidedByEmployeeId: 'emp-1',
        decisionReason: null,
        decidedAt,
      });

      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_A, approvalInstanceId: 'inst-1', order: 1, status: 'ACTIVE' },
          data: expect.objectContaining({ decision: 'APPROVED', decidedByEmployeeId: 'emp-1' }),
        })
      );
    });

    it('listDefinitionSteps is tenant-scoped and ordered', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const repo = new MissionApprovalRepository(
        makePrisma({ missionApprovalDefinitionStep: { findMany } })
      );

      await repo.listDefinitionSteps(TENANT_A, 'def-1');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_A, approvalDefinitionId: 'def-1' },
          orderBy: expect.any(Array),
        })
      );
    });
  });

  describe('MissionPolicyRepository', () => {
    it('findVersionById scopes by tenant', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const repo = new MissionPolicyRepository(makePrisma({ missionPolicyVersion: { findFirst } }));

      await repo.findVersionById(TENANT_A, 'ver-1');

      expect(findFirst).toHaveBeenCalledWith({ where: { id: 'ver-1', tenantId: TENANT_A } });
    });

    it('findPublishedVersion is tenant and rule-set scoped', async () => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const repo = new MissionPolicyRepository(makePrisma({ missionPolicyVersion: { findFirst } }));

      await repo.findPublishedVersion(TENANT_A, 'hr.mission.approval');

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: TENANT_A, ruleSetId: 'hr.mission.approval', status: 'PUBLISHED' },
        })
      );
    });

    it('createVersion writes tenant and starts as DRAFT', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'ver-1' });
      const repo = new MissionPolicyRepository(makePrisma({ missionPolicyVersion: { create } }));

      await repo.createVersion(TENANT_A, { version: 1, configuration: { rules: [] } });

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_A,
            status: 'DRAFT',
            ruleSetId: 'hr.mission.approval',
          }),
        })
      );
    });
  });
});
