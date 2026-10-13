import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EmploymentRepository } from './employment.repository';
import type { EmploymentIntervalCreateData } from './employment.repository';
import { HrActor } from '../hr-actor';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE, HR_MIN_EMPLOYMENT_YEAR } from '../hr.constants';
import { CreateEmploymentRecordDto, TerminateEmploymentDto } from '../dto/employee.dto';
import { OrganizationService } from '../organization/organization.service';
import { PositionsService } from '../positions/positions.service';
import {
  formatIsoDate,
  parseIsoDateValue,
  startsAfterPreviousStart,
} from '../domain/employment-interval';

/**
 * Phase 51-HR-1: effective-dated employment history — `EmploymentRecord` in `hr_db`.
 *
 * WHY THIS IS A SEPARATE SERVICE FROM `EmployeesService`
 * ----------------------------------------------------
 * `Employee` is WHO a person is in HR (a personnel record with a tenant-scoped code
 * and a lifecycle). `EmploymentRecord` is WHERE and AS WHAT they worked, DURING A
 * SPECIFIC INTERVAL. Those are different lifetimes: terminating employment does not
 * delete the employee, rehiring does not edit it, and a transfer appends an interval.
 * Splitting them is what makes "the current assignment is the ONE open interval" a
 * derived fact instead of a mutable column.
 *
 * THE ONE INVARIANT THIS SERVICE EXISTS TO KEEP
 * --------------------------------------------
 * AT MOST ONE OPEN INTERVAL PER EMPLOYEE. Two open intervals would make "where does
 * this person work?" have two answers, which is not a rendering problem but a
 * correctness problem: pay, seniority and audit queries would all have to guess.
 * It is kept four ways, and only the first is this service's own code:
 *
 *   1. `$transaction` — the close and the open are one unit; there is no observable
 *      moment where the employee has none;
 *   2. `assertNoOverlap` — a bounded pre-check that returns 409 with a message;
 *   3. `EmploymentRecord_no_overlapping_intervals_excl` — the real guarantee, an
 *      `EXCLUDE USING gist` over `daterange(start_date, end_date, '[]')` per employee,
 *      because a partial unique index cannot express "at most one row with a NULL
 *      end_date" correctly;
 *   4. `assertStartAfterCurrent` — a new interval must start strictly after the open
 *      one began, so a backdated second interval is refused rather than silently
 *      creating a zero-length history.
 *
 * DATE-ONLY ARITHMETIC. `startDate`/`endDate` are `@db.Date`. Every conversion in this
 * module goes through `parseIsoDate` / `toIsoDate`, which pin the day at UTC midnight
 * and read it back with `toISOString().slice(0, 10)`. Using `new Date('2026-03-01')`
 * in one place and `getDate()` in another is exactly how an interval shifts by a day
 * for callers in a positive-offset timezone, so neither is permitted here.
 */

/**
 * `'2026-03-01'` → a `Date` at UTC midnight, which is the day Postgres will store.
 *
 * The parsing RULE now lives in `domain/employment-interval.ts`; this function keeps the
 * name, the signature and the two exceptions the API contract already ships, so every
 * existing caller and every existing test sees the same behaviour. The decision is
 * returned framework-free and turned into HTTP here, where the transport belongs.
 */
export function parseIsoDate(iso: string): Date {
  const parsed = parseIsoDateValue(iso, HR_MIN_EMPLOYMENT_YEAR);

  if (parsed.ok) return parsed.date;

  if (parsed.reason === 'invalid-format') {
    throw new ConflictException(`"${iso}" is not a valid YYYY-MM-DD date`);
  }

  throw new ConflictException(`Dates before ${HR_MIN_EMPLOYMENT_YEAR}-01-01 are not accepted`);
}

/** A stored `@db.Date` → `'2026-03-01'`. Never a timestamp, never a timezone shift. */
export function toIsoDate(value: Date | null | undefined): string | null {
  return formatIsoDate(value);
}

/**
 * Day arithmetic on the UTC timeline.
 *
 * Used for exactly one thing: closing an interval the day BEFORE the successor starts.
 * Doing it with `setDate(getDate() - 1)` would move the local calendar day and could
 * produce a one-day gap or overlap for a server east of UTC, which the exclusion
 * constraint would then reject at the wrong moment.
 */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** The shape every employment endpoint emits: dates as `YYYY-MM-DD`, never instants. */
export interface EmploymentRecordView {
  id: string;
  employeeId: string;
  tenantId: string;
  employmentType: string;
  status: string;
  startDate: string;
  endDate: string | null;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Maps a stored row to the wire shape. Exported so the specs can pin it directly. */
export function serializeEmploymentRecord(record: {
  id: string;
  employeeId: string;
  tenantId: string;
  employmentType: string;
  status: string;
  startDate: Date;
  endDate: Date | null;
  organizationUnitId: string;
  positionId: string;
  managerEmployeeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): EmploymentRecordView {
  return {
    id: record.id,
    employeeId: record.employeeId,
    tenantId: record.tenantId,
    employmentType: record.employmentType,
    status: record.status,
    startDate: toIsoDate(record.startDate)!,
    endDate: toIsoDate(record.endDate),
    organizationUnitId: record.organizationUnitId,
    positionId: record.positionId,
    managerEmployeeId: record.managerEmployeeId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

@Injectable()
export class EmploymentService {
  /**
   * REFERENCE VALIDATION IS DELEGATED, NEVER RE-IMPLEMENTED: `OrganizationService`
   * answers "is this unit real, in MY tenant, and usable?" and `PositionsService`
   * answers "is this position real, in THAT unit?" — including its own call to
   * `assertUnitIsUsable`. `validateIntervalReferences` therefore composes two
   * tenant-scoped guards instead of duplicating their queries, so there is exactly one
   * definition per rule. (The composite foreign keys in `hr_db` are the second layer,
   * for a writer that bypasses this service entirely.)
   *
   * PERSISTENCE IS DELEGATED TOO. `EmploymentRepository` issues every Prisma statement of
   * this aggregate; this service decides WHICH statement is the right one — "close the day
   * before the successor", "at most one open interval", "a rehire appends rather than
   * reactivates" are rules, and a rule is not a `where` clause. The repository takes
   * `tenantId` as an ordinary argument rather than the actor, so "which rows can this call
   * see?" is answerable from its signature alone.
   */
  constructor(
    private readonly records: EmploymentRepository,
    private readonly organization: OrganizationService,
    private readonly positions: PositionsService,
    private readonly audit: HrAuditGateway
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The tenant-scoped employee row, or 404 — another tenant's employee is absent. */
  private async requireEmployee(actor: HrActor, employeeId: string) {
    const employee = await this.records.findEmployeeById(actor.tenantId, employeeId);
    if (!employee) throw new NotFoundException('Employee not found');
    return employee;
  }

  /**
   * The ONE open interval, or `null`.
   *
   * "Open" is `endDate IS NULL`, and that is the whole definition. The service always
   * sets `endDate` and `status` together, and `EmploymentRecord_interval_order_check`
   * plus the exclusion constraint leave no legal way to produce the contradictory
   * combination.
   *
   * `orderBy startDate desc` keeps the read deterministic even if history were to
   * contain two open rows from a pre-existing data defect.
   */
  async currentRecord(actor: HrActor, employeeId: string) {
    await this.requireEmployee(actor, employeeId);

    const record = await this.records.findOpenRecord(actor.tenantId, employeeId);

    return record ? serializeEmploymentRecord(record) : null;
  }

  /**
   * Whether an open interval exists at all — the precondition `EmployeesService.setStatus`
   * asks before it reactivates a personnel record.
   *
   * A BOOLEAN, NOT THE ROW: the caller's question is "may this person be ACTIVE at all?", and
   * a method that handed back the interval would invite it to reason about the interval's
   * contents, which is a different decision that belongs here.
   *
   * It deliberately does not re-read the employee. The one caller has just read that row
   * through its own tenant-scoped `findById`, and a second SELECT of the same row inside the
   * same request would be a round trip bought with nothing; the interval read is
   * tenant-scoped regardless, so a foreign employee id answers `false` rather than leaking.
   */
  async hasOpenInterval(actor: HrActor, employeeId: string): Promise<boolean> {
    return this.records.hasOpenRecord(actor.tenantId, employeeId);
  }

  /**
   * Every interval this person has ever had, NEWEST FIRST.
   *
   * Nothing is filtered out and nothing is deleted: terminated employment, closed
   * transfers and the gap before a rehire are all present, which is what makes §10's
   * "terminating employment does not erase history" observable through the API rather
   * than merely true in storage.
   */
  async history(actor: HrActor, employeeId: string) {
    await this.requireEmployee(actor, employeeId);

    const records = await this.records.listRecords(actor.tenantId, employeeId);

    return records.map(serializeEmploymentRecord);
  }

  /**
   * The CURRENT assignment projected for a LIST, keyed by employee id.
   *
   * One batched query for the whole page rather than N+1 per row: the employee list
   * screen renders "واحد / سمت" for every row, and a per-row read would turn a 20-row
   * page into 21 round trips. Employees with no open interval are absent from the map
   * — they are the "no current assignment" state, not an error.
   */
  async currentRecordsByEmployee(
    actor: HrActor,
    employeeIds: readonly string[]
  ): Promise<Map<string, EmploymentRecordView>> {
    const unique = [...new Set(employeeIds)].filter((id) => id.length > 0);
    const result = new Map<string, EmploymentRecordView>();
    if (unique.length === 0) return result;

    const records = await this.records.listOpenRecordsForEmployees(actor.tenantId, unique);

    for (const record of records) {
      // Newest-first ordering means the first row seen for an employee is the one to keep.
      if (!result.has(record.employeeId)) {
        result.set(record.employeeId, serializeEmploymentRecord(record));
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Reference validation
  // -------------------------------------------------------------------------

  /**
   * Validates every reference an interval is about to carry.
   *
   * Called by `EmployeesService` (first interval, inside its own transaction) and by
   * `openInterval` / `rehire` below (subsequent intervals). It is one method rather than
   * inlined validation at three call sites, because "is this unit + position + manager
   * combination legal FOR THIS TENANT?" must have exactly one answer.
   *
   * THE MANAGER CYCLE CHECK IS SKIPPED ONLY WHEN THERE IS NO EMPLOYEE YET. On create,
   * the new employee is in nobody's chain, so a cycle is impossible by construction and
   * the walk would be provably empty. `employeeId` being optional is that fact, not a
   * convenience.
   */
  async validateIntervalReferences(
    actor: HrActor,
    references: {
      organizationUnitId: string;
      positionId: string;
      managerEmployeeId?: string | null;
    },
    employeeId?: string
  ): Promise<void> {
    await this.organization.assertUnitIsUsable(actor, references.organizationUnitId);
    await this.positions.assertPositionIsUsable(
      actor,
      references.positionId,
      references.organizationUnitId
    );

    if (references.managerEmployeeId) {
      if (employeeId) {
        await this.assertManagerIsUsable(actor, references.managerEmployeeId, employeeId);
      } else {
        const managerExists = await this.records.employeeExists(
          actor.tenantId,
          references.managerEmployeeId
        );
        if (!managerExists) throw new NotFoundException('Manager employee not found');
      }
    }
  }

  /**
   * The Prisma `create` payload for one interval.
   *
   * Returned rather than written, because the FIRST interval must be inserted in the
   * same transaction as the `Employee` row it belongs to: an Employee that exists for
   * even a moment with no interval would be visible to a concurrent list read as a
   * person with no unit and no start date.
   */
  buildIntervalData(
    actor: HrActor,
    employeeId: string,
    dto: CreateEmploymentRecordDto
  ): EmploymentIntervalCreateData {
    return {
      tenantId: actor.tenantId,
      employeeId,
      employmentType: dto.employmentType,
      status: 'ACTIVE',
      startDate: parseIsoDate(dto.startDate),
      endDate: null,
      organizationUnitId: dto.organizationUnitId,
      positionId: dto.positionId,
      managerEmployeeId: dto.managerEmployeeId ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  /**
   * A manager edge must not point at the employee themselves, nor at a person whose own
   * chain of managers already contains this employee.
   *
   * The self-edge is also a Postgres CHECK and the longer cycle is also a BEFORE trigger,
   * so this walk is the readable 409 in front of a guarantee that does not depend on it.
   * It walks UP the manager chain from the proposed manager, following the CURRENT (open)
   * interval at each step, and refuses when it meets the employee being edited.
   */
  async assertManagerIsUsable(
    actor: HrActor,
    managerEmployeeId: string,
    employeeId: string
  ): Promise<void> {
    if (managerEmployeeId === employeeId) {
      throw new ConflictException('An employee cannot be their own manager');
    }

    const managerExists = await this.records.employeeExists(actor.tenantId, managerEmployeeId);
    if (!managerExists) throw new NotFoundException('Manager employee not found');

    let walk: string | null = managerEmployeeId;
    let steps = 0;

    while (walk) {
      if (walk === employeeId) {
        throw new ConflictException('This manager assignment would create a cycle');
      }
      steps += 1;
      if (steps > EmploymentRepository.MAX_MANAGER_STEPS) {
        throw new ConflictException('Manager chain is too deep to validate');
      }

      const next = await this.records.findManagerOfCurrentRecord(actor.tenantId, walk);
      walk = next?.managerEmployeeId ?? null;
    }
  }

  /**
   * The bounded overlap pre-check.
   *
   * It answers the question the exclusion constraint answers anyway, but in a way the
   * API can explain: `daterange(start, COALESCE(end, 'infinity'), '[]')` is inclusive on
   * both ends, so a new interval beginning the very day a previous one ended IS an
   * overlap. A 409 naming the colliding interval is strictly more useful than a raw
   * Postgres error, and the constraint still exists for every writer that is not this
   * service.
   */
  async assertNoOverlap(
    actor: HrActor,
    employeeId: string,
    startDate: Date,
    endDate: Date | null,
    excludeRecordId?: string
  ): Promise<void> {
    const colliding = await this.records.findOverlappingRecord(
      actor.tenantId,
      employeeId,
      startDate,
      endDate,
      excludeRecordId
    );

    if (colliding) {
      throw new ConflictException(
        `Employment interval overlaps an existing record (${toIsoDate(colliding.startDate)} → ${
          toIsoDate(colliding.endDate) ?? 'open'
        })`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Opens a NEW interval — a transfer, a promotion or a contract renewal.
   *
   * THE OLD INTERVAL IS CLOSED, NEVER EDITED AWAY. The sequence is:
   *
   *   1. the employee must exist in this tenant, and must not be TERMINATED (a
   *      terminated person is rehired through `rehire`, which is a different act with a
   *      different audit action — collapsing the two would make the history unable to
   *      tell a transfer from a return);
   *   2. the new interval must start STRICTLY AFTER the open one began, so a backdated
   *      second interval with no room for the first is refused;
   *   3. every reference is validated for this tenant;
   *   4. inside ONE transaction: the open interval is closed the day before the new
   *      start, and the new interval is inserted.
   *
   * STEP 4'S ORDER IS NOT COSMETIC. `EmploymentRecord_no_overlapping_intervals_excl` is
   * a non-deferrable `EXCLUDE` constraint, so Postgres evaluates it on every row
   * modification: closing FIRST leaves no instant at which two open intervals exist.
   * Inserting first would be rejected by the constraint, and would also be wrong even
   * if it were deferred, because a reader could observe two "current" assignments.
   */
  async openInterval(actor: HrActor, employeeId: string, dto: CreateEmploymentRecordDto) {
    const employee = await this.requireEmployee(actor, employeeId);

    if (employee.status === 'TERMINATED') {
      throw new ConflictException(
        'This employee is terminated; use the rehire endpoint to start a new engagement'
      );
    }

    const current = await this.records.findOpenRecordForTransition(actor.tenantId, employeeId);

    const startDate = parseIsoDate(dto.startDate);

    if (current && startDate <= current.startDate) {
      throw new ConflictException(
        `The new interval must start after the current one began (${toIsoDate(current.startDate)})`
      );
    }

    await this.validateIntervalReferences(actor, dto, employeeId);
    await this.assertNoOverlap(actor, employeeId, startDate, null, current?.id);

    const intervalData = this.buildIntervalData(actor, employeeId, dto);
    const created = await this.records.closeThenOpenInterval(
      current?.id ?? null,
      addDays(startDate, -1),
      intervalData,
      (createdId) =>
        this.audit.buildOutboxPayload(actor, {
          action: HR_AUDIT_ACTION.TRANSFER,
          resource: HR_AUDIT_RESOURCE.EMPLOYMENT_RECORD,
          resourceId: createdId,
          oldValue: current
            ? {
                id: current.id,
                organizationUnitId: current.organizationUnitId,
                positionId: current.positionId,
              }
            : null,
          newValue: {
            id: createdId,
            employmentType: intervalData.employmentType,
            startDate: dto.startDate,
            organizationUnitId: intervalData.organizationUnitId ?? null,
            positionId: intervalData.positionId ?? null,
          },
        }),
    );

    return serializeEmploymentRecord(created);
  }

  /**
   * Ends employment — `Employee.status = TERMINATED`, the open interval closed.
   *
   * NOTHING IS DELETED, AND NOTHING IS OVERWRITTEN. The interval that was open gets an
   * `endDate` and `status = ENDED`; every earlier interval is untouched. That is what
   * makes "where did this person work, and when" answerable after they leave, and it is
   * why the `endDate` is a REQUIRED argument rather than `now()`: a termination is
   * effective on a date the organization chose, and a server clock is not that date.
   *
   * The employee row survives with `status = TERMINATED`. `hr_db` has no FK to Core, so
   * deleting the Core user later cannot cascade here — the personnel file outlives the
   * login, which is the intended behaviour (§16).
   */
  async terminate(actor: HrActor, employeeId: string, dto: TerminateEmploymentDto) {
    const employee = await this.requireEmployee(actor, employeeId);

    const current = await this.records.findOpenRecordForTransition(actor.tenantId, employeeId);

    if (!current) {
      throw new ConflictException('This employee has no open employment record to end');
    }

    const endDate = parseIsoDate(dto.endDate);

    if (endDate < current.startDate) {
      throw new ConflictException(
        `endDate cannot precede the current interval start (${toIsoDate(current.startDate)})`
      );
    }

    const outbox = this.audit.buildOutboxPayload(actor, {
      action: HR_AUDIT_ACTION.TERMINATE,
      resource: HR_AUDIT_RESOURCE.EMPLOYEE,
      resourceId: employeeId,
      oldValue: { status: employee.status, openInterval: toIsoDate(current.startDate) },
      newValue: { status: 'TERMINATED', endDate: toIsoDate(endDate) },
      changedFields: ['status', 'endDate'],
      reason: dto.reason ?? null,
    });

    const [, updatedEmployee] = await this.records.closeIntervalAndTerminate(
      current.id,
      endDate,
      employeeId,
      outbox,
    );

    return {
      employee: updatedEmployee,
      closedRecord: serializeEmploymentRecord({
        ...current,
        endDate,
        status: 'ENDED',
      }),
    };
  }

  /**
   * Starts a NEW engagement for a previously terminated employee.
   *
   * A REHIRE APPENDS; IT DOES NOT REACTIVATE. The old interval keeps its `endDate`, so
   * the gap between the two engagements remains visible and auditable. Reactivating the
   * closed interval would erase that gap and would also be impossible to express
   * honestly: the person's unit or position has usually changed in between, and only a
   * new interval can record the new pair with a new start date.
   *
   * The employee must currently be TERMINATED. That is the whole difference between this
   * method and `openInterval`, and it is why the two are separate endpoints with separate
   * audit actions: a transfer and a return are not the same event, and merging them would
   * make the history unable to say which happened.
   */
  async rehire(actor: HrActor, employeeId: string, dto: CreateEmploymentRecordDto) {
    const employee = await this.requireEmployee(actor, employeeId);

    if (employee.status !== 'TERMINATED') {
      throw new ConflictException(
        'Only a terminated employee can be rehired; use the transfer endpoint for an active one'
      );
    }

    const alreadyOpen = await this.records.hasOpenRecord(actor.tenantId, employeeId);

    if (alreadyOpen) {
      throw new ConflictException('This employee already has an open employment record');
    }

    const startDate = parseIsoDate(dto.startDate);

    await this.validateIntervalReferences(actor, dto, employeeId);

    const lastRecord = await this.records.findLatestRecordStart(actor.tenantId, employeeId);

    if (lastRecord && !startsAfterPreviousStart(startDate, lastRecord.startDate)) {
      throw new ConflictException(
        `A rehire must start after the previous engagement began (${toIsoDate(lastRecord.startDate)})`
      );
    }

    await this.assertNoOverlap(actor, employeeId, startDate, null);

    const outbox = this.audit.buildOutboxPayload(actor, {
      action: HR_AUDIT_ACTION.REHIRE,
      resource: HR_AUDIT_RESOURCE.EMPLOYEE,
      resourceId: employeeId,
      oldValue: { status: employee.status },
      newValue: { status: 'ACTIVE', startDate: dto.startDate },
      changedFields: ['status', 'employmentRecord'],
    });

    const [created, updatedEmployee] = await this.records.openIntervalAndReactivate(
      this.buildIntervalData(actor, employeeId, dto),
      employeeId,
      outbox,
    );

    return {
      employee: updatedEmployee,
      record: serializeEmploymentRecord(created),
    };
  }
}
