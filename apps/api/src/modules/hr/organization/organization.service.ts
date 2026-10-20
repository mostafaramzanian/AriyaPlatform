import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OrganizationRepository } from './organization.repository';
import { HrActor } from '../hr-actor';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE } from '../hr.constants';
import {
  CreateOrganizationUnitDto,
  ListUnitsQueryDto,
  UpdateOrganizationUnitDto,
} from '../dto/organization.dto';
import { resolvePageWindow } from '../dto/hr-query.dto';
import { evaluateAncestorStep } from '../domain/organization-hierarchy';

/**
 * Phase 51-HR-1: the organization catalogue — `OrganizationUnit` in `hr_db`.
 *
 * WHY HR OWNS THIS AND NOT CORE
 * ----------------------------
 * `User.department` is a free-text label on a Core account. It is NOT an
 * organizational hierarchy: it has no parent, no code, no lifecycle, and a rename
 * silently rewrites the history of everyone who ever had it. `OrganizationUnit` is the
 * source of truth for HR organisation, and the Core label is left alone (§12).
 *
 * TENANCY IS IN THE WHERE CLAUSE OF EVERY QUERY
 * --------------------------------------------
 * No method below reads or writes a unit without `tenantId` first in its predicate.
 * That is the module's central discipline; `OrganizationUnit_tenantId_code_key` and the
 * composite tenant foreign keys make it a database guarantee for anyone who bypasses
 * this service.
 *
 * THE HIERARCHY IS A FOREST, ENFORCED THREE WAYS
 * ---------------------------------------------
 *   1. `assertParentIsUsable` — the service's bounded ancestor walk, which returns a
 *      409 with a readable message for the ordinary API path;
 *   2. `OrganizationUnit_no_self_parent_check` — a Postgres CHECK for the trivial case;
 *   3. `OrganizationUnit_no_cycle_guard` — a recursive BEFORE trigger, which is the
 *      real guarantee, because this service is not the only possible writer.
 */
@Injectable()
export class OrganizationService {
  /** Bounded ancestor walk. The trigger allows depth 100; the service refuses earlier. */
  private static readonly MAX_ANCESTOR_STEPS = 100;

  /** Bounded read of the full tenant tree, so a pathological tenant fails loudly. */
  private static readonly MAX_UNITS_FOR_TREE = 2000;

  constructor(
    private readonly units: OrganizationRepository,
    private readonly audit: HrAuditGateway
  ) {}

  /** One page of the tenant's units, ordered `(code, id)` so paging is deterministic. */
  async list(actor: HrActor, query: ListUnitsQueryDto) {
    const { page, pageSize, skip, take } = resolvePageWindow(query);

    const [items, total] = await this.units.listPage(
      actor.tenantId,
      { parentId: query.parentId, status: query.status, search: query.search },
      { skip, take }
    );

    return { items, total, page, pageSize };
  }

  /**
   * The WHOLE tenant hierarchy in one read, assembled as a nested tree.
   *
   * Built in memory from a single tenant-scoped `findMany` rather than by a recursive
   * SQL query, because a tenant's unit count is small (an organization, not a log) and
   * one round trip is easier to reason about than a recursive CTE.
   */
  async tree(actor: HrActor) {
    const units = await this.units.listForTree(
      actor.tenantId,
      OrganizationService.MAX_UNITS_FOR_TREE
    );

    const byId = new Map<string, OrganizationTreeNode>();
    for (const unit of units) {
      byId.set(unit.id, { ...unit, children: [] });
    }

    const roots: OrganizationTreeNode[] = [];
    for (const unit of units) {
      const node = byId.get(unit.id)!;
      const parent = unit.parentId ? byId.get(unit.parentId) : undefined;
      // A parent outside the page is treated as a root rather than dropped: the row
      // exists and the caller must still see it.
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    return { roots, total: units.length };
  }

  /** The counts the HR home screen renders. Real queries; a zero means zero. */
  async summary(actor: HrActor) {
    const [units, activeUnits, positions, activePositions, employees, activeEmployees] =
      await this.units.summaryCounts(actor.tenantId);

    return { units, activeUnits, positions, activePositions, employees, activeEmployees };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(actor: HrActor, dto: CreateOrganizationUnitDto) {
    if (dto.parentId) {
      await this.assertParentIsUsable(actor, dto.parentId);
    }

    const unit = await this.createUnitOrConflict(actor, dto);

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.ORGANIZATION_UNIT,
      resourceId: unit.id,
      newValue: { code: unit.code, name: unit.name, parentId: unit.parentId },
    });

    return unit;
  }

  /**
   * The INSERT, with the one failure a duplicate `code` produces translated to 409.
   *
   * WHY A PRE-CHECK *AND* A CATCH, WHEN EITHER ALONE LOOKS SUFFICIENT
   * ---------------------------------------------------------------
   * `OrganizationUnit_tenantId_code_key` is the arbiter of uniqueness, not this read.
   * The read exists so the ordinary, sequential case gets a message that names the
   * problem ("this code is already taken in this tenant") instead of a database error;
   * the catch exists because the read cannot be the enforcement — two concurrent creates
   * both pass it, and the second INSERT is what Postgres rejects.
   *
   * WHY THE CATCH IS NOT COSMETIC. HR runs on `AppModule`, which registers NO global
   * exception filter (`StandardExceptionFilter` is applied by `@UseFilters` on the blog
   * controller alone), so a raw Prisma `P2002` escaping here reached the client as a
   * **500**. That is wrong twice over: it is a conflict, and a 500 tells the caller to
   * retry the very request that can never succeed. Measured before this change: a second
   * `POST /hr/organization/units` with an existing code answered
   * `500 {code: "DATABASE_ERROR"}`.
   *
   * ONLY `P2002` IS TRANSLATED. Every other failure is rethrown untouched — reporting a
   * dropped connection or a different constraint as "code taken" would hide a real
   * incident behind a plausible, wrong message.
   */
  private async createUnitOrConflict(actor: HrActor, dto: CreateOrganizationUnitDto) {
    const clash = await this.units.findIdByCode(actor.tenantId, dto.code);

    if (clash) {
      throw new ConflictException(
        'An organization unit with this code already exists in this tenant'
      );
    }

    try {
      // Optional profile fields are forwarded only when present, so a minimal
      // create keeps the INSERT it always had — a missing label stays NULL.
      return await this.units.create(actor.tenantId, {
        code: dto.code,
        name: dto.name,
        parentId: dto.parentId ?? null,
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(dto.managerName !== undefined ? { managerName: dto.managerName } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.monthlyBudget !== undefined ? { monthlyBudget: dto.monthlyBudget } : {}),
        ...(dto.responsibility !== undefined ? { responsibility: dto.responsibility } : {}),
      });
    } catch (err) {
      // The concurrent loser lands here. Same refusal as the pre-check above, because to
      // the caller the two cases are one fact: the code is taken.
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          'An organization unit with this code already exists in this tenant'
        );
      }
      throw err;
    }
  }

  /**
   * True for a Prisma unique-constraint violation, by CODE and never by message text.
   *
   * A STRUCTURAL CHECK ON PURPOSE. `instanceof Prisma.PrismaClientKnownRequestError` would
   * require importing the generated HR client here, and §6d keeps that import in exactly
   * one file (`hr-prisma.service.ts`) — the module's isolation guard fails the build if a
   * second one appears. The same shape is used by `integration.service.ts` and
   * `module-registry.service.ts` in Core, so HR is not inventing a convention.
   */
  private isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2002';
  }

  async update(actor: HrActor, id: string, dto: UpdateOrganizationUnitDto) {
    const before = await this.getOne(actor, id);

    if (dto.parentId !== undefined && dto.parentId !== null) {
      await this.assertParentIsUsable(actor, dto.parentId, id);
    }

    const unit = await this.units.update(id, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.parentId !== undefined ? { parentId: dto.parentId } : {}),
      ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
      // `null` CLEARS a profile label — the same present-but-null semantics as
      // `parentId`: absence means "leave it", null means "remove it".
      ...(dto.managerName !== undefined ? { managerName: dto.managerName } : {}),
      ...(dto.location !== undefined ? { location: dto.location } : {}),
      ...(dto.monthlyBudget !== undefined ? { monthlyBudget: dto.monthlyBudget } : {}),
      ...(dto.responsibility !== undefined ? { responsibility: dto.responsibility } : {}),
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.ORGANIZATION_UNIT,
      resourceId: unit.id,
      oldValue: { name: before.name, parentId: before.parentId },
      newValue: { name: unit.name, parentId: unit.parentId },
    });

    return unit;
  }

  /**
   * Activates or deactivates a unit.
   *
   * THERE IS NO DELETE, deliberately. An employment interval points at the unit it was
   * served in, so deleting one would either cascade-destroy history (forbidden by §10)
   * or leave a dangling reference. A unit that no longer exists operationally becomes
   * INACTIVE and keeps its history intact.
   */
  async setStatus(actor: HrActor, id: string, status: 'ACTIVE' | 'INACTIVE') {
    const before = await this.getOne(actor, id);
    if (before.status === status) return before;

    const unit = await this.units.setStatus(id, status);

    await this.audit.record(actor, {
      action: status === 'ACTIVE' ? HR_AUDIT_ACTION.REACTIVATE : HR_AUDIT_ACTION.DEACTIVATE,
      resource: HR_AUDIT_RESOURCE.ORGANIZATION_UNIT,
      resourceId: unit.id,
      oldValue: { status: before.status },
      newValue: { status: unit.status },
    });

    return unit;
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  /** One unit, or 404 — a unit of ANOTHER tenant is indistinguishable from absent. */
  async getOne(actor: HrActor, id: string) {
    const unit = await this.units.findById(actor.tenantId, id);
    if (!unit) throw new NotFoundException('Organization unit not found');
    return unit;
  }

  /**
   * A unit must exist, belong to the actor's tenant, and must not be `childId` itself or
   * one of its descendants.
   *
   * THE ANCESTOR WALK IS THE POINT. Checking only `parentId !== id` catches the trivial
   * cycle and misses `A → B → C → A`, where every individual edge looks legal. Walking UP
   * from the proposed parent and stopping if we reach the row being moved is the same
   * rule the `OrganizationUnit_no_cycle_guard` trigger enforces — the service version
   * exists so the ordinary API returns 409 with a message rather than a raw Postgres
   * exception.
   */
  async assertParentIsUsable(actor: HrActor, parentId: string, childId?: string): Promise<void> {
    if (childId && parentId === childId) {
      throw new ConflictException('An organization unit cannot be its own parent');
    }

    const parent = await this.units.findIdById(actor.tenantId, parentId);

    if (!parent) {
      throw new NotFoundException('Parent organization unit not found');
    }

    if (!childId) return;

    let walk: string | null = parentId;
    let steps = 0;

    while (walk) {
      // The comparison itself lives in `domain/organization-hierarchy.ts`; this loop keeps
      // the bounded fetch that needs the repository. Order is part of the behaviour: the
      // cycle test runs BEFORE the bound is incremented, so a genuine cycle is never
      // reported as a depth failure — the same two 409s, with the same messages, as before.
      const decision = evaluateAncestorStep(
        { childId, steps, maxSteps: OrganizationService.MAX_ANCESTOR_STEPS },
        walk
      );

      if (decision.kind === 'found-child') {
        throw new ConflictException(
          'Re-parenting would create a cycle in the organization hierarchy'
        );
      }
      if (decision.kind === 'too-deep') {
        throw new ConflictException('Organization hierarchy is too deep to re-parent');
      }

      steps = decision.steps;

      const next: { parentId: string | null } | null = await this.units.findParentIdById(
        actor.tenantId,
        walk
      );
      walk = next?.parentId ?? null;
    }
  }

  /**
   * The unit-usability guard used by Positions and Employees.
   *
   * A public method rather than a copy: "is this unit mine and usable?" must have
   * exactly one answer, and a second implementation in `PositionsService` is how the
   * two drift until one of them forgets the tenant predicate.
   */
  async assertUnitIsUsable(actor: HrActor, unitId: string): Promise<void> {
    const unit = await this.units.findUsabilityById(actor.tenantId, unitId);

    if (!unit) throw new NotFoundException('Organization unit not found');
    if (unit.status !== 'ACTIVE') {
      throw new ConflictException('Organization unit is not active');
    }
  }
}

/** A unit plus its children, as `tree()` returns it. */
export interface OrganizationTreeNode {
  id: string;
  tenantId: string;
  parentId: string | null;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  kind: 'OPERATIONAL' | 'STAFF';
  managerName: string | null;
  location: string | null;
  /** DECIMAL(20,0) at rest; Prisma's Decimal serialises to a digit string on the wire. */
  monthlyBudget: { toString(): string } | null;
  responsibility: string | null;
  /** Live count of ACTIVE employment records pointing at this unit. */
  headcount: number;
  /** Live count of position slots defined inside this unit. */
  positionsCount: number;
  createdAt: Date;
  updatedAt: Date;
  children: OrganizationTreeNode[];
}
