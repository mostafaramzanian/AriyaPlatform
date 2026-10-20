import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmployeeRepository } from './employees.repository';
import {
  EMPLOYEES_XLSX_MIME,
  renderEmployeesXlsx,
} from './employees-export';
import { gregorianToJalali, jalaliToday } from '../../../calendar/jalali.util';
import { ImportEmployeeRowDto } from '../dto/employee-import.dto';
import { HrActor } from '../hr-actor';
import { HrAuditGateway } from '../hr-audit.gateway';
import {
  HR_AUDIT_ACTION,
  HR_AUDIT_RESOURCE,
  HR_EMPLOYEE_CODE_PATTERN,
  HR_EMPLOYEE_CODE_PREFIX,
  HR_EMPLOYEE_CODE_SEQUENCE_PAD,
  HR_EMPLOYEE_CODE_SEQUENCE_START,
} from '../hr.constants';
import { CreateEmployeeDto, UpdateEmployeeDto, normalizeEmployeeCode } from '../dto/employee.dto';
import { ListEmployeesQueryDto, resolvePageWindow } from '../dto/hr-query.dto';
import { OrganizationRepository } from '../organization/organization.repository';
import { PositionRepository } from '../positions/positions.repository';
import { EmploymentService, EmploymentRecordView } from '../employment/employment.service';
import { HrIdentityGateway } from '../hr-identity.gateway';
import type { DirectoryUserProfile } from '../hr-identity.gateway';

/** The export window — one round trip answers «this filter, whole file». */
const EXPORT_TAKE = 2000;

const HR_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'فعال',
  INACTIVE: 'غیرفعال',
  TERMINATED: 'خاتمه‌یافته',
};

const HR_EMPLOYMENT_LABELS: Record<string, string> = {
  FULL_TIME: 'تمام‌وقت',
  PART_TIME: 'پاره‌وقت',
  CONTRACT: 'قراردادی',
  TEMPORARY: 'موقت',
  INTERNSHIP: 'کارورز',
};

function hrStatusLabel(status: string): string {
  return HR_STATUS_LABELS[status] ?? status;
}

function hrEmploymentLabel(type: string): string {
  return HR_EMPLOYMENT_LABELS[type] ?? type;
}

/** `YYYY-MM-DD` (the API's date-only contract) rendered as a Jalali `jy/mm/dd` label. */
function jalaliDateLabel(isoDate: string): string {
  const [gy, gm, gd] = isoDate.split('-').map(Number);
  const j = gregorianToJalali(gy, gm, gd);
  return `${j.jy}/${String(j.jm).padStart(2, '0')}/${String(j.jd).padStart(2, '0')}`;
}

function displayName(
  identity: { firstName: string | null; lastName: string | null } | null,
  fallback: string
): string {
  if (!identity) return fallback;
  const name = [identity.firstName, identity.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : fallback;
}

/**
 * Phase 51-HR-1: the personnel record — `Employee` in `hr_db`.
 *
 * WHAT AN EMPLOYEE IS, AND WHAT IT IS NOT
 * --------------------------------------
 * An `Employee` is HR's personnel record of a person. It is NOT a Core `User`:
 *
 *   * `userId` is an OPTIONAL, plain identifier. There is no foreign key, because
 *     PostgreSQL cannot express one across databases and HR must not try to. A person
 *     must be employable BEFORE they are given a login, and a login can exist for
 *     someone with no personnel record — requiring the link would make the first case
 *     impossible.
 *   * HR stores NO credential-adjacent column. No password, no token version, no roles,
 *     no permissions, no login status. Those live in `core_db` and are reachable only
 *     through `UserDirectoryContract`.
 *   * `Employee.status` (ACTIVE / INACTIVE / TERMINATED) and Core's `User.status` are
 *     INDEPENDENT lifecycles on purpose (§16). An employee may be INACTIVE while their
 *     login is ACTIVE, and terminating an employment does not disable a login.
 *
 * WHERE THE CURRENT ASSIGNMENT LIVES
 * ----------------------------------
 * NOT HERE. There is deliberately no `organizationUnitId`, `positionId` or
 * `managerEmployeeId` column on `Employee`: the current assignment is the ONE OPEN
 * `EmploymentRecord`, derived by `EmploymentService.currentRecord`. Storing it here as
 * well would give a transfer two places to update, and the first missed update would make
 * the personnel file claim a unit the person left years ago.
 *
 * TENANCY
 * -------
 * Every query below begins with `tenantId: actor.tenantId`, and the tenant on write is
 * always `actor.tenantId` — never a DTO field, because no HR DTO has one.
 * `Employee_tenantId_employeeCode_key` makes the code unique PER TENANT.
 *
 * IDENTITY GOES THROUGH `HrIdentityGateway`, NOT THROUGH THE PORT DIRECTLY
 * ----------------------------------------------------------------------
 * This service used to inject the platform identity port itself. §6d requires the
 * cross-boundary surface to be ONE file, so both identity needs — the write-time
 * membership check and the read-time name projection — are now the gateway's methods.
 * The gateway's header says why; `hr-isolation.spec.ts` fails the build if a second
 * injection appears.
 */
@Injectable()
export class EmployeesService {
  /**
   * PERSISTENCE IS NOT THIS FILE'S JOB. `EmployeeRepository` issues every statement against
   * `Employee`; `OrganizationRepository` and `PositionRepository` supply the batched labels a
   * page renders. What remains here is the set of rules that make those statements mean
   * something: the code is normalised before it is compared, a duplicate is a 409 rather than
   * a 500, an identity link must be a member of the actor's tenant, a terminated person is
   * rehired rather than reactivated, and the current assignment is DERIVED from history
   * instead of stored. None of those is a `where` clause, and keeping them out of the file
   * that writes `where` clauses is the reason for the split.
   */
  constructor(
    private readonly employees: EmployeeRepository,
    private readonly units: OrganizationRepository,
    private readonly positions: PositionRepository,
    private readonly employment: EmploymentService,
    private readonly audit: HrAuditGateway,
    private readonly identity: HrIdentityGateway
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The employee list, each row carrying its CURRENT assignment.
   *
   * The assignment is NOT a Prisma relation on `Employee` and cannot be: it is "the open
   * interval", which is a filter over a history table rather than a nullable column. The
   * list therefore runs ONE batched `currentRecordsByEmployee` read for the whole page —
   * not one query per row, which is what an N+1 loop would have produced.
   *
   * `status`, `organizationUnitId` and `positionId` filters apply to the OPEN interval,
   * because "who is in Finance now" is the question this screen asks. History is per
   * employee (`GET /hr/employees/:id/employment-records`), which is where
   * "who was in Finance in 1402" belongs. The predicate those filters become is built in
   * `EmployeeRepository.listPage` — it is a `where` clause, and this service no longer writes
   * any. `status` and `search` are passed through unchanged, so the filter the screen sends
   * is still the filter the database applies.
   */
  async list(actor: HrActor, query: ListEmployeesQueryDto) {
    const { page, pageSize, skip, take } = resolvePageWindow(query);

    const [rows, total] = await this.employees.listPage(
      actor.tenantId,
      {
        status: query.status,
        search: query.search,
        organizationUnitId: query.organizationUnitId,
        positionId: query.positionId,
        linked:
          query.linked === 'true' ? true : query.linked === 'false' ? false : undefined,
      },
      { skip, take }
    );

    const assignments = await this.employment.currentRecordsByEmployee(
      actor,
      rows.map((row) => row.id)
    );

    const [units, positions, profiles] = await Promise.all([
      this.loadUnits(
        actor,
        [...assignments.values()].map((a) => a.organizationUnitId)
      ),
      this.loadPositions(
        actor,
        [...assignments.values()].map((a) => a.positionId)
      ),
      this.loadProfiles(rows.map((row) => row.userId)),
    ]);

    const unitById = new Map(units.map((u) => [u.id, u]));
    const positionById = new Map(positions.map((p) => [p.id, p]));

    return {
      items: rows.map((row) =>
        this.toView(row, assignments.get(row.id) ?? null, unitById, positionById, profiles)
      ),
      total,
      page,
      pageSize,
    };
  }

  /** One employee with its current assignment, its identity projection and its history. */
  async getOne(actor: HrActor, id: string) {
    const employee = await this.employees.findById(actor.tenantId, id);
    if (!employee) throw new NotFoundException('Employee not found');

    const [current, history, profiles] = await Promise.all([
      this.employment.currentRecord(actor, id),
      this.employment.history(actor, id),
      this.loadProfiles([employee.userId]),
    ]);

    const [units, positions] = await Promise.all([
      this.loadUnits(actor, current ? [current.organizationUnitId] : []),
      this.loadPositions(actor, current ? [current.positionId] : []),
    ]);

    return this.toView(
      employee,
      current,
      new Map(units.map((u) => [u.id, u])),
      new Map(positions.map((p) => [p.id, p])),
      profiles,
      history
    );
  }

  /** Historical read for the detail screen: every interval, newest first. */
  async history(actor: HrActor, id: string) {
    return this.employment.history(actor, id);
  }

  /**
   * The KPI strip of the redesigned directory (ui-redesign) — `GET /hr/employees/summary`.
   *
   * EVERY NUMBER IS THE TABLE'S OWN COUNT: `Employee` rows of THIS tenant plus the
   * organization catalogue's unit/position totals. «حساب‌های سامانه» is the count of
   * rows with a Core-identity link — not a Core-side query, so the identity allowlist
   * is untouched and the number means exactly what the screen's «متصل» pill means.
   * `monthlyHires` is gap-filled to the last six calendar months, oldest first.
   */
  async summary(actor: HrActor) {
    const [directory, catalogue] = await Promise.all([
      this.employees.directorySummary(actor.tenantId),
      this.units.summaryCounts(actor.tenantId),
    ]);

    // Gap-fill the last six calendar months so the sparkline has a slot for every
    // month — including the zero-hire ones the GROUP BY does not emit.
    const byMonth = new Map(directory.monthlyHires.map((row) => [row.month, row.count]));
    const monthlyHires: number[] = [];
    const cursor = new Date();
    cursor.setDate(1);
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthlyHires.push(byMonth.get(key) ?? 0);
    }

    return {
      total: directory.total,
      active: directory.active,
      linkedAccounts: directory.linked,
      missingAccounts: directory.unlinked,
      withoutAssignment: directory.withoutOpenInterval,
      hiredLast90Days: directory.hiredLast90Days,
      monthlyHires,
      // summaryCounts order: [units, activeUnits, positions, activePositions, employees, activeEmployees]
      units: catalogue[0],
      activeUnits: catalogue[1],
      positions: catalogue[2],
      activePositions: catalogue[3],
    };
  }

  /**
   * «خروجی اکسل» — the SAME filtered directory as a workbook (ui-redesign).
   *
   * The export reads through the very same `listPage` predicate as the screen, so the
   * file cannot disagree with the table it was exported from. The window is widened
   * to `EXPORT_TAKE` rows rather than the page size — a filtered export is a report,
   * not a page — and `total` is written into the sheet so an honest file says when it
   * is truncated. The identity allowlist still applies: the export carries the same
   * fields the screen sees (name + job title through the gateway), never an email.
   */
  async exportXlsx(actor: HrActor, query: ListEmployeesQueryDto) {
    // The page window clamps at HR_MAX_PAGE_SIZE; an export is a report, not a page,
    // so it reads through the same `listPage` predicate with the wider EXPORT_TAKE.
    const [rows, total] = await this.employees.listPage(
      actor.tenantId,
      {
        status: query.status,
        search: query.search,
        organizationUnitId: query.organizationUnitId,
        positionId: query.positionId,
        linked:
          query.linked === 'true' ? true : query.linked === 'false' ? false : undefined,
      },
      { skip: 0, take: EXPORT_TAKE }
    );

    const assignments = await this.employment.currentRecordsByEmployee(
      actor,
      rows.map((row) => row.id)
    );

    const [units, positions, profiles] = await Promise.all([
      this.loadUnits(
        actor,
        [...assignments.values()].map((a) => a.organizationUnitId)
      ),
      this.loadPositions(
        actor,
        [...assignments.values()].map((a) => a.positionId)
      ),
      this.loadProfiles(rows.map((row) => row.userId)),
    ]);

    const unitById = new Map(units.map((u) => [u.id, u]));
    const positionById = new Map(positions.map((p) => [p.id, p]));

    const page = rows.map((row) =>
      this.toView(row, assignments.get(row.id) ?? null, unitById, positionById, profiles)
    );

    const exportRows = page.map((item) => ({
      employeeCode: item.employeeCode,
      name: displayName(item.identity, item.employeeCode),
      unit: item.currentAssignment?.organizationUnit?.name ?? null,
      position: item.currentAssignment?.position?.title ?? null,
      employmentType: item.currentAssignment?.employmentType ?? null,
      startDate: item.currentAssignment?.startDate ?? null,
      status: item.status,
      hasAccount: item.userId !== null,
    }));

    const buffer = await renderEmployeesXlsx({
      rows: exportRows,
      total,
      generatedAt: new Date(),
      statusLabel: hrStatusLabel,
      employmentTypeLabel: hrEmploymentLabel,
      dateLabel: jalaliDateLabel,
    });

    return { buffer, mimeType: EMPLOYEES_XLSX_MIME, fileName: 'employees.xlsx' };
  }

  /**
   * «بارگذاری گروهی» — a bounded batch create driven by the SCREEN's parsed CSV rows
   * (ui-redesign). Each row is resolved to the real `create` path, so duplicate codes
   * are 409s per row, code-lookup misses are per-row errors, and every successful row
   * is audited exactly like the single-create form — there is no lower-privilege bulk
   * back door. A row failure never aborts the batch; the report names every rejected
   * row with its reason.
   *
   * `unitCode`/`positionCode`/`managerEmployeeCode` are resolved to ids HERE rather
   * than trusting client-sent ids, because the CSV a user prepares names codes, not
   * UUIDs — resolving by code keeps the file human-readable AND keeps the write on
   * the same tenant-scoped lookups the single-create path uses.
   */
  async importRows(actor: HrActor, rows: ImportEmployeeRowDto[]) {
    const results: Array<{ row: number; employeeCode: string; ok: boolean; message?: string }> = [];

    for (const [index, row] of rows.entries()) {
      const rowNo = index + 1;
      try {
        const unitId = await this.units.findIdByCode(actor.tenantId, row.unitCode.trim());
        if (!unitId) {
          results.push({ row: rowNo, employeeCode: row.employeeCode, ok: false, message: `واحد سازمانی «${row.unitCode}» یافت نشد.` });
          continue;
        }
        const positionId = await this.positions.findIdByCode(actor.tenantId, row.positionCode.trim());
        if (!positionId) {
          results.push({ row: rowNo, employeeCode: row.employeeCode, ok: false, message: `سمت «${row.positionCode}» یافت نشد.` });
          continue;
        }
        const managerId = row.managerEmployeeCode?.trim()
          ? await this.employees.findIdByCode(actor.tenantId, row.managerEmployeeCode.trim())
          : null;
        if (row.managerEmployeeCode?.trim() && !managerId) {
          results.push({ row: rowNo, employeeCode: row.employeeCode, ok: false, message: `کارمند مدیر «${row.managerEmployeeCode}» یافت نشد.` });
          continue;
        }

        await this.create(actor, {
          employeeCode: row.employeeCode,
          employmentType: row.employmentType,
          startDate: row.startDate,
          organizationUnitId: unitId.id,
          positionId: positionId.id,
          ...(managerId ? { managerEmployeeId: managerId.id } : {}),
          ...(row.userId?.trim() ? { userId: row.userId.trim() } : {}),
        });
        results.push({ row: rowNo, employeeCode: row.employeeCode, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'ثبت ردیف با خطا مواجه شد.';
        results.push({ row: rowNo, employeeCode: row.employeeCode, ok: false, message });
      }
    }

    return {
      total: rows.length,
      created: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * «تولید‌خودکار» — the next free personnel code, for the create form's auto-generate chip.
   *
   * THE SHAPE IS A CONTRACT, NOT A SUGGESTION: `EMP-<jalali-year>-<4-digit sequence>`,
   * where the year is TODAY'S Jalali year taken from the server's own calendar
   * (`jalaliToday`, never a client clock) and the sequence is one above the highest
   * sequence that already exists under the same prefix, floored at
   * `HR_EMPLOYEE_CODE_SEQUENCE_START`. The result is always a candidate, never a
   * reservation: two concurrent generators may receive the same code, and the create
   * path's uniqueness pre-check plus the unique index remain the arbiter — this method
   * removes guesswork for the operator, it does not guarantee availability.
   *
   * Codes that do not parse (hand-authored ones like `EMP-1404-EXTERNAL`) are ignored
   * rather than treated as sequence zero, so a single odd code cannot drag the generator
   * backwards.
   */
  async suggestEmployeeCode(actor: HrActor): Promise<{ employeeCode: string }> {
    const { jy } = jalaliToday();
    const prefix = `${HR_EMPLOYEE_CODE_PREFIX}-${jy}-`;

    const codes = await this.employees.listCodesWithPrefix(actor.tenantId, prefix);

    let highest = HR_EMPLOYEE_CODE_SEQUENCE_START - 1;
    for (const code of codes) {
      const suffix = code.slice(prefix.length);
      if (!/^\d+$/.test(suffix)) continue;
      highest = Math.max(highest, Number.parseInt(suffix, 10));
    }

    const sequence = String(highest + 1).padStart(HR_EMPLOYEE_CODE_SEQUENCE_PAD, '0');
    return { employeeCode: `${prefix}${sequence}` };
  }

  /**
   * Creates a personnel record AND its first employment interval, atomically.
   *
   * WHY THEY ARE ONE OPERATION. An `Employee` with no `EmploymentRecord` has no unit, no
   * position, no employment type and no start date — there is no honest way to render it
   * and no answer to "where does this person work". Splitting the two writes into
   * two requests would make that state reachable and permanent if the second call failed,
   * so the schema keeps the assignment out of `Employee` and this method puts both rows in
   * one transaction.
   *
   * NO OVERLAP CHECK IS NEEDED: the person has no other interval, so nothing can collide.
   * The `EXCLUDE` constraint still applies and would reject a defect, and
   * `buildIntervalData` supplies exactly the shape the constraint is defined on.
   *
   * THE CODE IS NORMALISED BEFORE THE UNIQUENESS PRE-CHECK, not after. Checking the raw
   * value first would let `e-1042` pass and then collide with `E-1042` at the unique
   * index — a 500 where a 409 belongs.
   */
  async create(actor: HrActor, dto: CreateEmployeeDto) {
    const employeeCode = normalizeEmployeeCode(dto.employeeCode);

    if (!HR_EMPLOYEE_CODE_PATTERN.test(employeeCode)) {
      throw new BadRequestException(
        'employeeCode must start with a letter or digit and contain only A-Z, 0-9, ".", "_", "/" or "-"'
      );
    }

    await this.assertUserIdIsMember(actor, dto.userId);

    await this.employment.validateIntervalReferences(actor, {
      organizationUnitId: dto.organizationUnitId,
      positionId: dto.positionId,
      managerEmployeeId: dto.managerEmployeeId,
    });

    const existing = await this.employees.findIdByCode(actor.tenantId, employeeCode);
    if (existing) {
      throw new ConflictException('An employee with this code already exists in this tenant');
    }

    const employee = await this.insertEmployeeOrConflict(actor, dto, employeeCode);

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.EMPLOYEE,
      resourceId: employee.id,
      newValue: {
        employeeCode: employee.employeeCode,
        status: employee.status,
        userId: employee.userId,
        firstInterval: {
          employmentType: dto.employmentType,
          startDate: dto.startDate,
          organizationUnitId: dto.organizationUnitId,
          positionId: dto.positionId,
        },
      },
    });

    return this.getOne(actor, employee.id);
  }

  /**
   * The two rows of a new employee — the personnel record and its first interval —
   * inserted in one transaction, with a duplicate code translated to 409.
   *
   * THE PRE-CHECK ABOVE ALREADY ANSWERS THE COMMON CASE; THIS METHOD ANSWERS THE OTHER
   * ONE. `Employee_tenantId_employeeCode_key` is the arbiter, so two concurrent creates
   * both pass the read in `create` and the second one's INSERT is rejected. That loser
   * used to surface as a raw Prisma `P2002`: this runtime registers no global exception
   * filter, so the client received a **500**, which is both the wrong status and the
   * wrong instruction (a retry of a request that cannot succeed).
   *
   * The check is on the CODE, so the `EXCLUDE` constraint that guards overlapping
   * intervals — a different failure with a different meaning — still surfaces unchanged
   * rather than being reported as a duplicate code.
   */
  private async insertEmployeeOrConflict(
    actor: HrActor,
    dto: CreateEmployeeDto,
    employeeCode: string
  ) {
    try {
      return await this.employees.createWithFirstInterval(
        {
          tenantId: actor.tenantId,
          userId: dto.userId ?? null,
          employeeCode,
          status: dto.status ?? null,
        },
        (employeeId) => this.employment.buildIntervalData(actor, employeeId, dto)
      );
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('An employee with this code already exists in this tenant');
      }
      throw err;
    }
  }

  /**
   * True for a Prisma unique-constraint violation, by CODE and never by message text.
   *
   * Structural rather than `instanceof`: the generated HR client is imported by exactly
   * one file (`hr-prisma.service.ts`, §6d) and the module's isolation guard enforces it.
   */
  private isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2002';
  }

  /**
   * The UPDATE, with the same duplicate-code translation as the insert path.
   *
   * A PATCH that renames an employee's code races the same way a create does: the clash
   * read in `update` and the UPDATE are two statements, so `Employee_tenantId_employeeCode_key`
   * is again the only thing that can settle it.
   */
  private async updateEmployeeOrConflict(
    id: string,
    data: {
      employeeCode?: string;
      userId?: string | null;
      status?: UpdateEmployeeDto['status'];
    }
  ) {
    try {
      return await this.employees.updateFields(id, data);
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException('An employee with this code already exists in this tenant');
      }
      throw err;
    }
  }

  /**
   * Updates the mutable employee fields.
   *
   * WHAT CANNOT BE CHANGED HERE, AND WHY: the current assignment. Moving someone to
   * another unit is `POST /hr/employees/:id/employment-records`, because it must close the
   * previous interval and open a new one. A PATCH that "moved" an employee would have to
   * either rewrite the open interval in place — erasing where they worked before — or
   * silently create an interval, which is not what a PATCH means.
   */
  async update(actor: HrActor, id: string, dto: UpdateEmployeeDto) {
    const employee = await this.employees.findById(actor.tenantId, id);
    if (!employee) throw new NotFoundException('Employee not found');

    const employeeCode =
      dto.employeeCode !== undefined ? normalizeEmployeeCode(dto.employeeCode) : undefined;

    if (employeeCode !== undefined) {
      if (!HR_EMPLOYEE_CODE_PATTERN.test(employeeCode)) {
        throw new BadRequestException(
          'employeeCode must start with a letter or digit and contain only A-Z, 0-9, ".", "_", "/" or "-"'
        );
      }

      if (employeeCode !== employee.employeeCode) {
        const clash = await this.employees.findIdByCodeExcludingId(
          actor.tenantId,
          employeeCode,
          id
        );
        if (clash) {
          throw new ConflictException('An employee with this code already exists in this tenant');
        }
      }
    }

    if (dto.userId !== undefined && dto.userId !== null) {
      await this.assertUserIdIsMember(actor, dto.userId);
    }

    const updated = await this.updateEmployeeOrConflict(id, {
      ...(employeeCode !== undefined ? { employeeCode } : {}),
      ...(dto.userId !== undefined ? { userId: dto.userId } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.EMPLOYEE,
      resourceId: updated.id,
      oldValue: {
        employeeCode: employee.employeeCode,
        status: employee.status,
        userId: employee.userId,
      },
      newValue: {
        employeeCode: updated.employeeCode,
        status: updated.status,
        userId: updated.userId,
      },
      changedFields: ['employeeCode', 'status', 'userId'].filter((field) => {
        if (field === 'employeeCode') return employeeCode !== undefined;
        if (field === 'status') return dto.status !== undefined;
        return dto.userId !== undefined;
      }),
    });

    return this.getOne(actor, id);
  }

  /**
   * ACTIVE ⇄ INACTIVE for a personnel record.
   *
   * INACTIVE means "the record is retained but not currently active" — long unpaid leave,
   * suspension, unpaid absence. It is NOT a synthetic "delete": `hr_db` has no delete path
   * for an employee, because the employment history points at the employee and deleting
   * one would either cascade-destroy history (impossible across the boundary by design) or
   * orphan every interval.
   *
   * TWO TRANSITIONS ARE REFUSED:
   *   * reactivating a TERMINATED employee — that is a REHIRE, a different act with a
   *     different audit action, and it must open a new interval;
   *   * activating an employee with no open interval, which would claim they are employed
   *     while no assignment exists.
   *
   * The Core login is deliberately NOT touched. `Employee.status` and `User.status` are
   * independent (§16): HR must not be able to enable or disable a login, and Core must
   * not be able to terminate an employment.
   */
  async setStatus(actor: HrActor, id: string, status: 'ACTIVE' | 'INACTIVE') {
    const employee = await this.employees.findById(actor.tenantId, id);
    if (!employee) throw new NotFoundException('Employee not found');

    if (employee.status === status) return this.getOne(actor, id);

    if (status === 'ACTIVE') {
      if (employee.status === 'TERMINATED') {
        throw new ConflictException(
          'A terminated employee is rehired, not reactivated: use the rehire endpoint'
        );
      }

      const hasOpenInterval = await this.employment.hasOpenInterval(actor, id);
      if (!hasOpenInterval) {
        throw new ConflictException('Cannot activate an employee with no open employment record');
      }
    }

    const updated = await this.employees.setStatus(id, status);

    await this.audit.record(actor, {
      action: status === 'ACTIVE' ? HR_AUDIT_ACTION.REACTIVATE : HR_AUDIT_ACTION.DEACTIVATE,
      resource: HR_AUDIT_RESOURCE.EMPLOYEE,
      resourceId: updated.id,
      oldValue: { status: employee.status },
      newValue: { status: updated.status },
      changedFields: ['status'],
    });

    return this.getOne(actor, id);
  }

  // -------------------------------------------------------------------------
  // Projection helpers
  // -------------------------------------------------------------------------
  //
  // These exist so that the API's response SHAPE is defined in one place. The list and
  // the detail read must agree on what a "current assignment" looks like, and the way
  // that silently diverges is by building the object twice.

  /** Units for a batch of ids, tenant-scoped. One query, never one per employee. */
  private async loadUnits(actor: HrActor, ids: readonly string[]) {
    const unique = [...new Set(ids)].filter((id) => typeof id === 'string' && id.length > 0);
    if (unique.length === 0) return [];

    return this.units.listLabels(actor.tenantId, unique);
  }

  /** Positions for a batch of ids, tenant-scoped. */
  private async loadPositions(actor: HrActor, ids: readonly string[]) {
    const unique = [...new Set(ids)].filter((id) => typeof id === 'string' && id.length > 0);
    if (unique.length === 0) return [];

    return this.positions.listLabels(actor.tenantId, unique);
  }

  /**
   * The identity projection for a batch of `userId`s, through the module's ONE
   * cross-boundary surface.
   *
   * The dedupe and the empty-batch short-circuit live in `HrIdentityGateway.profilesFor`
   * — this method used to duplicate them, which is exactly the drift the gateway exists
   * to prevent: two copies of "which ids do we actually ask Core about?" is one copy too
   * many once a third caller arrives.
   */
  private async loadProfiles(
    userIds: readonly (string | null)[]
  ): Promise<Map<string, DirectoryUserProfile>> {
    return this.identity.profilesFor(userIds);
  }

  /**
   * The wire shape of one employee.
   *
   * `currentAssignment` is DERIVED from the open interval, and the unit and position are
   * resolved names rather than raw ids, so the UI does not need three more requests to
   * render a row. `employmentHistory` is attached only by the detail read — the list does
   * not ship every interval of every row.
   */
  private toView(
    employee: {
      id: string;
      tenantId: string;
      userId: string | null;
      employeeCode: string;
      status: string;
      createdAt: Date;
      updatedAt: Date;
    },
    current: EmploymentRecordView | null,
    unitById: Map<string, { id: string; code: string; name: string }>,
    positionById: Map<string, { id: string; code: string; title: string }>,
    profiles: Map<string, DirectoryUserProfile>,
    history?: EmploymentRecordView[]
  ) {
    const unit = current ? (unitById.get(current.organizationUnitId) ?? null) : null;
    const position = current ? (positionById.get(current.positionId) ?? null) : null;

    return {
      id: employee.id,
      tenantId: employee.tenantId,
      userId: employee.userId,
      employeeCode: employee.employeeCode,
      status: employee.status,
      createdAt: employee.createdAt,
      updatedAt: employee.updatedAt,
      identity: employee.userId ? (profiles.get(employee.userId) ?? null) : null,
      currentAssignment: current
        ? {
            id: current.id,
            employmentType: current.employmentType,
            status: current.status,
            startDate: current.startDate,
            organizationUnitId: current.organizationUnitId,
            positionId: current.positionId,
            managerEmployeeId: current.managerEmployeeId,
            organizationUnit: unit,
            position,
          }
        : null,
      ...(history ? { employmentHistory: history } : {}),
    };
  }

  /**
   * A Core identity may only be linked if it is a member of the ACTOR'S tenant.
   *
   * The rule itself now lives in `HrIdentityGateway.assertMember`, because
   * `EmploymentService` — and every later HR phase that references a login — needs the
   * same check. Two copies of a tenant-membership rule is how one of them eventually
   * forgets `filterTenantMembers`. The reason it answers with IDs only, and why the
   * failure is a generic BadRequest rather than a 404/403, is documented on that method.
   */
  private async assertUserIdIsMember(actor: HrActor, userId: string | undefined): Promise<void> {
    await this.identity.assertMember(actor, userId);
  }
}
