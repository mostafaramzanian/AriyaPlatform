import { Injectable } from '@nestjs/common';
import { HrPrismaService } from '../database/hr-prisma.service';
import type { HrEmploymentType } from '../dto/hr-query.dto';
import type { HrAuditOutboxPayload } from '../hr-audit.gateway';

/**
 * Phase 51-HR-ARCH-1: the `EmploymentRecord` PERSISTENCE boundary.
 *
 * WHAT THIS FILE OWNS. Every Prisma statement of the effective-dated employment history: the
 * interval reads, the bounded overlap probe, the manager-chain step, and the three
 * transactions that append, close or reopen an interval. `EmploymentService` keeps the
 * invariants that make those statements mean something — at most ONE open interval per
 * employee, a new interval must start after the current one began, a manager edge must not
 * create a cycle, a terminated employee is rehired rather than reactivated.
 *
 * WHY THE EMPLOYEE ROW IS TOUCHED HERE, AND WHY THAT IS NOT A LEAK
 * ---------------------------------------------------------------
 * `terminate` and `rehire` each flip `Employee.status` in the SAME transaction that closes or
 * opens the interval, so the two facts commit together or not at all. The employee rows read
 * here (`findEmployeeById`) are read for the same reason: the interval transition is gated on
 * the employee's lifecycle, and a gate read through a different connection at a different
 * moment would be a gate on a different fact. Everything else about the employee — the list,
 * the create, the code uniqueness, the administrative status change — belongs to
 * `EmployeeRepository` and is not duplicated here.
 *
 * THE TENANT IS AN ARGUMENT, NEVER AN AMBIENT FACT. `tenantId` is the first parameter of every
 * method and appears in the `where` of every query; the writes that target a row by `id` alone
 * follow a read that was already tenant-scoped, which is the only shape the module allows.
 * No `findUnique` anywhere: it cannot carry a tenant predicate.
 */
@Injectable()
export class EmploymentRepository {
  /**
   * Bounded walk, so a pathological manager chain fails loudly instead of looping.
   *
   * `EmploymentService` reads THIS constant rather than repeating `100`: the schema's cycle
   * trigger allows depth 100 and this is the depth the readable 409 is raised at, so a second
   * copy of the number would be a second answer to "how deep is too deep".
   */
  static readonly MAX_MANAGER_STEPS = 100;

  constructor(private readonly prisma: HrPrismaService) {}

  // ---------------------------------------------------------------------------
  // Employee rows that gate an interval transition
  // ---------------------------------------------------------------------------

  /** The tenant-scoped employee row, or `null` — another tenant's employee is absent. */
  async findEmployeeById(tenantId: string, employeeId: string) {
    return this.prisma.employee.findFirst({ where: { id: employeeId, tenantId } });
  }

  /** Existence alone, for the manager and reference guards. */
  async employeeExists(tenantId: string, employeeId: string) {
    const row = await this.prisma.employee.findFirst({
      where: { id: employeeId, tenantId },
      select: { id: true },
    });
    return row !== null;
  }

  // ---------------------------------------------------------------------------
  // Interval reads
  // ---------------------------------------------------------------------------

  /**
   * The ONE open interval, or `null`.
   *
   * "Open" is `endDate IS NULL`, and that is the whole definition. `orderBy startDate desc`
   * then `id desc` keeps the read deterministic even if history were to contain two open rows
   * from a pre-existing data defect.
   */
  async findOpenRecord(tenantId: string, employeeId: string) {
    return this.prisma.employmentRecord.findFirst({
      where: { tenantId, employeeId, endDate: null },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * The open interval as seen by a TRANSITION, newest start first.
   *
   * Ordered on the start date alone, deliberately: it is the interval whose `startDate` the
   * transition compares against, and `id desc` would order by something the comparison does
   * not use. Kept separate from `findOpenRecord` so a read for display and a read for a
   * decision keep their own (already-different) orderings instead of being merged into one
   * "close enough" query.
   */
  async findOpenRecordForTransition(tenantId: string, employeeId: string) {
    return this.prisma.employmentRecord.findFirst({
      where: { tenantId, employeeId, endDate: null },
      orderBy: [{ startDate: 'desc' }],
    });
  }

  /** Whether any open interval exists — the rehire precondition, without fetching the row. */
  async hasOpenRecord(tenantId: string, employeeId: string) {
    const row = await this.prisma.employmentRecord.findFirst({
      where: { tenantId, employeeId, endDate: null },
      select: { id: true },
    });
    return row !== null;
  }

  /** Every interval this person has ever had, NEWEST FIRST. Nothing is filtered out. */
  async listRecords(tenantId: string, employeeId: string) {
    return this.prisma.employmentRecord.findMany({
      where: { tenantId, employeeId },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    });
  }

  /**
   * The CURRENT intervals of a page of employees, in ONE query.
   *
   * Batched rather than per row: the list screen renders a current assignment for every row,
   * and a per-row read would turn a 20-row page into 21 round trips. Employees with no open
   * interval are simply absent from the result — that is the "no current assignment" state,
   * not an error.
   */
  async listOpenRecordsForEmployees(tenantId: string, employeeIds: readonly string[]) {
    return this.prisma.employmentRecord.findMany({
      where: { tenantId, employeeId: { in: [...employeeIds] }, endDate: null },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
    });
  }

  /** The start date of the latest interval, whatever its state — the rehire ordering rule. */
  async findLatestRecordStart(tenantId: string, employeeId: string) {
    return this.prisma.employmentRecord.findFirst({
      where: { tenantId, employeeId },
      orderBy: [{ startDate: 'desc' }],
      select: { startDate: true },
    });
  }

  /** One step of the manager-chain walk: the manager of the CURRENT interval of an employee. */
  async findManagerOfCurrentRecord(tenantId: string, employeeId: string) {
    return this.prisma.employmentRecord.findFirst({
      where: { tenantId, employeeId, endDate: null },
      orderBy: [{ startDate: 'desc' }],
      select: { managerEmployeeId: true },
    });
  }

  /**
   * The bounded overlap pre-check.
   *
   * It answers the question the exclusion constraint answers anyway, but in a way the API can
   * explain: `daterange(start, COALESCE(end, 'infinity'), '[]')` is inclusive on both ends, so
   * a new interval beginning the very day a previous one ended IS an overlap. The open-ended
   * probe uses `9999-12-31` as "no later date", the same sentinel the constraint's `infinity`
   * stands for.
   */
  async findOverlappingRecord(
    tenantId: string,
    employeeId: string,
    startDate: Date,
    endDate: Date | null,
    excludeRecordId?: string
  ) {
    return this.prisma.employmentRecord.findFirst({
      where: {
        tenantId,
        employeeId,
        ...(excludeRecordId ? { id: { not: excludeRecordId } } : {}),
        startDate: { lte: endDate ?? new Date('9999-12-31T00:00:00.000Z') },
        OR: [{ endDate: null }, { endDate: { gte: startDate } }],
      },
      orderBy: [{ startDate: 'asc' }],
      select: { id: true, startDate: true, endDate: true },
    });
  }

  /**
   * Phase 54-G (§16.6): the employment interval COVERING a requested range, for a limit's
   * employment-type scope.
   *
   * WHY A DEDICATED READ RATHER THAN `findOpenRecord`. §16.6 makes scope matching TEMPORAL: a
   * limit naming an employment type applies only when "the employment interval covering the
   * requested range declares that type", and `EmploymentRecord.employmentType` is effective-dated.
   * The OPEN interval answers "what is true today", which is a different question from "what was
   * declared across `[from, to]`" — an employee who moved FULL_TIME → CONTRACT mid-year has one
   * open interval and a requested range that may straddle the change. This read answers the range
   * question, and `null` (no interval covering the whole range) is the §16.6 insufficient-context
   * signal the caller REFUSES on rather than resolving by assuming a type.
   *
   * THE RANGE MUST BE COVERED CONTIGUOUSLY, and this is stated rather than assumed: a single row
   * whose own `[startDate, endDate]` spans the requested range is the only shape returned. A range
   * straddling two intervals therefore yields `null` — the context cannot state ONE interval for
   * the whole range, which is exactly the refusal §16.6 names. Detecting contiguity across rows is
   * deliberately NOT done here: stitching intervals into a coverage answer would be a second
   * employment-rule implementation, and the honest answer for an unstitched range is "cannot state".
   *
   * TENANT IS FIRST, and the read is bounded to one employee — the boundary guard
   * (`hr-isolation.spec.ts`) requires tenant-first on every repository read, so this cannot be
   * called across tenants by accident.
   */
  async findIntervalCoveringRange(
    tenantId: string,
    employeeId: string,
    from: Date,
    to: Date
  ): Promise<HrEmploymentType | null> {
    const record = await this.prisma.employmentRecord.findFirst({
      where: {
        tenantId,
        employeeId,
        startDate: { lte: from },
        // `null` endDate is the OPEN interval — it covers everything from its start onward, which
        // is the same sentinel `findOverlappingRecord` uses for "no later date".
        OR: [{ endDate: null }, { endDate: { gte: to } }],
      },
      // Latest start wins: if two intervals could each span the range (they cannot — the EXCLUDE
      // constraint forbids overlap), the most recent declaration is the one in force.
      orderBy: [{ startDate: 'desc' }],
      select: { employmentType: true },
    });

    return record === null ? null : (record.employmentType as HrEmploymentType);
  }

  // ---------------------------------------------------------------------------
  // Transactions: the writes that must commit together
  // ---------------------------------------------------------------------------

  /**
   * The transfer: CLOSE the current interval, then OPEN the new one.
   *
   * ONE TRANSACTION, and the ORDER inside it is not cosmetic.
   * `EmploymentRecord_no_overlapping_intervals_excl` is a non-deferrable `EXCLUDE` constraint,
   * so Postgres evaluates it on every row modification: closing FIRST leaves no instant at
   * which two open intervals exist. Inserting first would be rejected by the constraint, and
   * would also be wrong even if it were deferred, because a reader could observe two "current"
   * assignments.
   */
  async closeThenOpenInterval(
    closeRecordId: string | null,
    closeEndDate: Date,
    next: EmploymentIntervalCreateData,
    buildOutbox?: (createdId: string) => HrAuditOutboxPayload,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (closeRecordId) {
        await tx.employmentRecord.update({
          where: { id: closeRecordId },
          data: { endDate: closeEndDate, status: 'ENDED' },
        });
      }

      const created = await tx.employmentRecord.create({ data: next });

      if (buildOutbox) {
        await tx.auditOutbox.create({ data: buildOutbox(created.id) });
      }

      return created;
    });
  }

  /**
   * The termination: the interval is CLOSED and the employee becomes TERMINATED, together.
   *
   * The two updates are one fact — "this engagement ended on this date" — so they are one
   * batch. The record comes first so a caller destructuring the result reads
   * `[closedRecord, employee]`, the order the audit row describes.
   */
  async closeIntervalAndTerminate(
    recordId: string,
    endDate: Date,
    employeeId: string,
    outbox?: HrAuditOutboxPayload,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const closedRecord = await tx.employmentRecord.update({
        where: { id: recordId },
        data: { endDate, status: 'ENDED' },
      });
      const updatedEmployee = await tx.employee.update({
        where: { id: employeeId },
        data: { status: 'TERMINATED' },
      });

      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }

      return [closedRecord, updatedEmployee] as const;
    });
  }

  /**
   * The rehire: a NEW interval is appended and the employee becomes ACTIVE again, together.
   *
   * The closed interval is deliberately not touched. Reactivating it in place would erase the
   * gap between the two engagements, which is the fact a rehire exists to record.
   */
  async openIntervalAndReactivate(
    next: EmploymentIntervalCreateData,
    employeeId: string,
    outbox?: HrAuditOutboxPayload,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.employmentRecord.create({ data: next });
      const updatedEmployee = await tx.employee.update({
        where: { id: employeeId },
        data: { status: 'ACTIVE' },
      });

      if (outbox) {
        await tx.auditOutbox.create({ data: outbox });
      }

      return [created, updatedEmployee] as const;
    });
  }
}

/**
 * The `create` payload of one interval.
 *
 * Declared HERE, beside the statements that consume it, so the persistence layer says what
 * shape it accepts and `EmploymentService.buildIntervalData` says it produces exactly that —
 * one definition, checked by the compiler at the call site, with no import of the generated
 * client (which only `hr-prisma.service.ts` may touch, §6d).
 */
export interface EmploymentIntervalCreateData {
  tenantId: string;
  employeeId: string;
  employmentType: HrEmploymentType;
  status: 'ACTIVE';
  startDate: Date;
  endDate: null;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId: string | null;
}
