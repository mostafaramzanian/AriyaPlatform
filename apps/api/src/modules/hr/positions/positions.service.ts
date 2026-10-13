import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PositionRepository } from './positions.repository';
import { HrActor } from '../hr-actor';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE } from '../hr.constants';
import {
  CreatePositionDto,
  ListPositionsQueryDto,
  UpdatePositionDto,
} from '../dto/organization.dto';
import { resolvePageWindow } from '../dto/hr-query.dto';
import { OrganizationService } from '../organization/organization.service';

/**
 * Phase 51-HR-1: the position catalogue — `Position` in `hr_db`.
 *
 * A Position is a SLOT DEFINITION ("کارشناس ارشد حسابداری"), not a person and not a
 * headcount. It belongs to exactly one OrganizationUnit of the same tenant.
 *
 * THREE RULES THAT ARE DELIBERATELY NOT ENFORCED HERE
 * --------------------------------------------------
 *   1. NO UNIQUE TITLE. "کارشناس" is a legitimate title in several units, so only
 *      `code` is unique — and only per tenant, exactly like `OrganizationUnit.code`.
 *      A global unique on `title` would make two units collide, which is a tenancy bug.
 *   2. NO "ONE EMPLOYEE PER POSITION". Nothing in the domain forbids two people
 *      sharing a position (job-sharing, back-to-back shifts). A VACANCY is a position
 *      with no current EmploymentRecord — a state, not a row to delete.
 *   3. NO PAYROLL LINK. Salary bands, grades and payroll are out of scope for 51-HR-1.
 *
 * CROSS-TENANT SAFETY has two layers, and the second is the one that matters:
 * `OrganizationService.assertUnitIsUsable` rejects a unit from another tenant on the
 * ordinary path, and the composite foreign key `Position_tenant_unit_fkey`
 * (`(tenant_id, organization_unit_id) -> OrganizationUnit(tenant_id, id)`) makes a
 * cross-tenant position IMPOSSIBLE to write, even by a future writer that bypasses
 * this service entirely.
 */
@Injectable()
export class PositionsService {
  constructor(
    private readonly positions: PositionRepository,
    private readonly organization: OrganizationService,
    private readonly audit: HrAuditGateway
  ) {}

  async list(actor: HrActor, query: ListPositionsQueryDto) {
    const { page, pageSize, skip, take } = resolvePageWindow(query);

    const [items, total] = await this.positions.listPage(
      actor.tenantId,
      {
        organizationUnitId: query.organizationUnitId,
        status: query.status,
        search: query.search,
      },
      { skip, take }
    );

    return { items, total, page, pageSize };
  }

  async getOne(actor: HrActor, id: string) {
    const position = await this.positions.findById(actor.tenantId, id);
    if (!position) throw new NotFoundException('Position not found');
    return position;
  }

  async create(actor: HrActor, dto: CreatePositionDto) {
    await this.organization.assertUnitIsUsable(actor, dto.organizationUnitId);

    const position = await this.createPositionOrConflict(actor, dto);

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.POSITION,
      resourceId: position.id,
      newValue: {
        code: position.code,
        title: position.title,
        organizationUnitId: position.organizationUnitId,
      },
    });

    return position;
  }

  /**
   * The INSERT, with a duplicate `code` translated to 409 — the same fix as
   * `OrganizationService.createUnitOrConflict`, for the same measured defect.
   *
   * `Position_tenantId_code_key` is the arbiter: a position code is unique PER TENANT and
   * the `title` deliberately is not (see the class header). Before this method existed, a
   * second `POST /hr/positions` with an existing code escaped as a raw Prisma `P2002`,
   * which no filter in this runtime maps to a status, so the client saw a 500 for a
   * conflict it could have resolved.
   *
   * The read is the friendly path, the catch is the guarantee: two concurrent creates both
   * pass the read, and only the INSERT can lose that race.
   */
  private async createPositionOrConflict(actor: HrActor, dto: CreatePositionDto) {
    const clash = await this.positions.findIdByCode(actor.tenantId, dto.code);

    if (clash) {
      throw new ConflictException('A position with this code already exists in this tenant');
    }

    try {
      return await this.positions.create(actor.tenantId, {
        organizationUnitId: dto.organizationUnitId,
        code: dto.code,
        title: dto.title,
        status: dto.status,
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('A position with this code already exists in this tenant');
      }
      throw err;
    }
  }

  /**
   * True for a Prisma unique-constraint violation, by CODE and never by message text.
   *
   * A structural check, not `instanceof`: importing the generated HR client here would
   * break §6d (one importer, `hr-prisma.service.ts`) and fail the module's isolation
   * guard. Core's `integration.service.ts` uses the identical shape.
   */
  private isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2002';
  }

  /**
   * Renames, moves or (de)activates a position.
   *
   * A MOVE DOES NOT REWRITE ANYONE'S HISTORY: employment intervals reference the
   * POSITION, so re-parenting the slot re-labels it and every past interval keeps
   * pointing at the same position id. That is why `organizationUnitId` is editable here
   * while an employee's unit is not.
   */
  async update(actor: HrActor, id: string, dto: UpdatePositionDto) {
    const before = await this.getOne(actor, id);

    if (dto.organizationUnitId && dto.organizationUnitId !== before.organizationUnitId) {
      await this.organization.assertUnitIsUsable(actor, dto.organizationUnitId);
    }

    const position = await this.positions.update(id, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.organizationUnitId !== undefined
        ? { organizationUnitId: dto.organizationUnitId }
        : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.POSITION,
      resourceId: position.id,
      oldValue: {
        title: before.title,
        organizationUnitId: before.organizationUnitId,
        status: before.status,
      },
      newValue: {
        title: position.title,
        organizationUnitId: position.organizationUnitId,
        status: position.status,
      },
    });

    return position;
  }

  /** No DELETE: employment intervals reference positions, so a position is retired. */
  async setStatus(actor: HrActor, id: string, status: 'ACTIVE' | 'INACTIVE') {
    const before = await this.getOne(actor, id);
    if (before.status === status) return before;

    const position = await this.positions.setStatus(id, status);

    await this.audit.record(actor, {
      action: status === 'ACTIVE' ? HR_AUDIT_ACTION.REACTIVATE : HR_AUDIT_ACTION.DEACTIVATE,
      resource: HR_AUDIT_RESOURCE.POSITION,
      resourceId: position.id,
      oldValue: { status: before.status },
      newValue: { status: position.status },
    });

    return position;
  }

  /**
   * The guard Employees and Employment call before writing an interval.
   *
   * It answers TWO questions at once, because the pair is what an interval means:
   * "is this position mine and active?" AND "does it belong to the unit I am about to
   * record?". A position from another unit would produce an interval saying the person
   * held a Finance position while sitting in the Engineering unit — internally
   * contradictory, and no constraint in `hr_db` can see it, because both references are
   * individually legal.
   */
  async assertPositionIsUsable(
    actor: HrActor,
    positionId: string,
    expectedUnitId: string
  ): Promise<void> {
    const position = await this.positions.findUsabilityById(actor.tenantId, positionId);

    if (!position) throw new NotFoundException('Position not found');
    if (position.status !== 'ACTIVE') throw new ConflictException('Position is not active');
    if (position.organizationUnitId !== expectedUnitId) {
      throw new ConflictException('Position does not belong to the given organization unit');
    }
  }
}
