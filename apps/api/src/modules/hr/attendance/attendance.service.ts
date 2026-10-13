import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AttendanceRepository } from './attendance.repository';
import { EmployeeRepository } from '../employees/employees.repository';
import { HrActor } from '../hr-actor';
import { HrAuditGateway } from '../hr-audit.gateway';
import { HR_AUDIT_ACTION, HR_AUDIT_RESOURCE } from '../hr.constants';
import {
  AdjustAttendanceDto,
  ClockInDto,
  ClockOutDto,
  ListAttendanceQueryDto,
} from '../dto/attendance.dto';
import { resolvePageWindow } from '../dto/hr-query.dto';
import {
  APP_TIME_ZONE,
  formatJalaliDateKey,
  instantToJalaliDate,
  jalaliToGregorian,
} from '../../../calendar/jalali.util';
import { attendanceWorkDateKey, resolveAttendanceDayBounds } from './attendance-window';

/**
 * Phase 51-HR-3: the attendance register — `Attendance` in `hr_db`.
 *
 * WHAT THE REGISTER IS, AND WHAT THIS SERVICE REFUSES TO INVENT
 * ------------------------------------------------------------
 * ONE ROW PER EMPLOYEE PER WORK DAY: the day's punch window and nothing derived. There
 * is no `status` field, no late/absent computation and no hours arithmetic, because
 * §13 requires "present | late | absent | leave | mission | holiday | weekend" to be
 * COMPUTED from the punch, the shift and the calendar — and this phase owns only the
 * first of those three. A service that stored its own verdict would produce a second
 * answer that can disagree with the facts it came from, which is the exact defect the
 * audit forbids. What it produces instead is the pair of facts that computation needs:
 * `workDate` (Gregorian) and `dateKey` (Jalali), DERIVED SERVER-SIDE from `clockIn`.
 *
 * THE FOUR RULES THIS SERVICE DOES OWN, EACH WITH A DATABASE GUARANTEE BEHIND IT
 * ----------------------------------------------------------------------------
 *   1. A DAY IS DERIVED, NEVER SUPPLIED. `workDate` and `dateKey` come from `clockIn`
 *      in `APP_TIME_ZONE` (`§8`'s rule: Jalali handling is `jalali.util`, and the zone
 *      is named, never inherited), so a row cannot claim a day that contradicts its own
 *      timestamp — there is no DTO field that could say otherwise.
 *   2. ONE `DEVICE` ROW PER DAY. A second clock-in for the same employee-day is a 409
 *      naming the adjustment route, not a second row: the register answers "was this
 *      person here that day, from when to when" with ONE window.
 *   3. A DAY CANNOT CLOSE BEFORE IT OPENS, and a CLOSED day cannot close again — both
 *      409s here, and `Attendance_punch_order_check` refuses the first in `hr_db` even
 *      for a writer that bypasses this service.
 *   4. A CORRECTION IS A ROW, NOT AN EDIT (§13). `adjust` writes the one `MANUAL` row
 *      for that employee-day and can NEVER touch the `DEVICE` row: `source` is part of
 *      the unique key the upsert presses on, so the statement cannot address the
 *      evidence at all.
 *
 * WHAT THIS SERVICE DELIBERATELY DOES NOT DO — WITH THE PHASE THAT WILL
 * -------------------------------------------------------------------
 *   * NO SELF-SERVICE. There is no "my own attendance" route: that needs an
 *     authoritative employee→login link, which the module stores (`Employee.userId`) but
 *     deliberately does not treat as a licence to expose a surface (`hr-actor.ts`, and
 *     the note in the Core seed migration).
 *   * NO TEAM SCOPE. `managerEmployeeId` on the open interval is a start, not a
 *     traversal; subtree-scoped reads arrive with the report (51-HR-4) and their risk
 *     (audit R6).
 *   * NO DEVICE INGEST, NO SCHEDULER, NO MATERIALISATION JOB. Nothing here is
 *     time-triggered and nothing runs outside the request that asked for it, which is
 *     what keeps the audit entry, the tenant scope and the HTTP status describing the
 *     same event.
 *
 * TENANCY. Every query begins with `actor.tenantId`, the employee referenced by a write
 * is verified to be the actor's own (`EmployeeRepository.findById` is tenant-scoped),
 * and `Attendance_tenant_employee_fkey` — a composite `(tenant_id, employee_id)` key —
 * makes a cross-tenant row impossible to write even for a writer that bypasses this
 * class entirely.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly attendance: AttendanceRepository,
    private readonly employees: EmployeeRepository,
    private readonly audit: HrAuditGateway
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * The register page, newest day first.
   *
   * The day filter is resolved HERE rather than in the repository, because it is a
   * CALENDAR question (a Jalali day, a Gregorian range) and the persistence layer must
   * stay a layer that only knows how to press on `work_date`. `dateKey` and
   * `from`/`to` both end as the same inclusive bounds, so the day view and the range
   * view cannot mean different things.
   */
  async list(actor: HrActor, query: ListAttendanceQueryDto) {
    const { page, pageSize, skip, take } = resolvePageWindow(query);
    const { from, to } = AttendanceService.resolveDayBounds(query);

    const [items, total] = await this.attendance.listPage(
      actor.tenantId,
      {
        employeeId: query.employeeId,
        from,
        to,
        source: query.source,
        search: query.search,
      },
      { skip, take }
    );

    return { items: items.map((row) => AttendanceService.serialize(row)), total, page, pageSize };
  }

  /** One row, or 404 — another tenant's row is indistinguishable from a missing one. */
  async getOne(actor: HrActor, id: string) {
    const row = await this.attendance.findById(actor.tenantId, id);
    if (!row) throw new NotFoundException('Attendance record not found');
    return AttendanceService.serialize(row);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Opens a day: the punch.
   *
   * ORDER OF OPERATIONS IS THE CONTRACT. The employee is verified first (404 for a
   * foreign or unknown id, 409 for a terminated one), then the day is derived, then the
   * duplicate is checked, and only then is anything written — so a refusal never leaves
   * a row behind, and the caller is told the FIRST thing that is wrong rather than the
   * last.
   */
  async clockIn(actor: HrActor, dto: ClockInDto) {
    const employee = await this.resolveEmployee(actor, dto.employeeId);

    const clockIn = AttendanceService.parseInstant(dto.clockIn, 'clockIn');
    const { workDate, dateKey } = AttendanceService.resolveWorkDay(clockIn);

    const existing = await this.attendance.findDayBySource(
      actor.tenantId,
      employee.id,
      workDate,
      'DEVICE'
    );
    if (existing) {
      throw new ConflictException(
        `This employee already has a recorded clock-in for ${dateKey}; correct that day through the adjustment route instead of opening a second one.`
      );
    }

    const row = await this.createPunch(actor, {
      employeeId: employee.id,
      workDate,
      dateKey,
      clockIn,
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.CREATE,
      resource: HR_AUDIT_RESOURCE.ATTENDANCE,
      resourceId: row.id,
      newValue: {
        employeeId: row.employeeId,
        dateKey: row.dateKey,
        workDate: AttendanceService.toDateKey(row.workDate),
        clockIn: row.clockIn.toISOString(),
        source: row.source,
      },
    });

    return AttendanceService.serialize(row);
  }

  /**
   * Closes an open day.
   *
   * ONLY A `DEVICE` ROW IS CLOCKED OUT. A `MANUAL` correction already states its own
   * window (and its reason), so clocking one out would be a second way to write the same
   * field — and a second way to write a field is how two answers start. The caller is
   * told to adjust instead.
   */
  async clockOut(actor: HrActor, id: string, dto: ClockOutDto) {
    const before = await this.getOne(actor, id);

    if (before.source !== 'DEVICE') {
      throw new ConflictException(
        'Only a punch can be clocked out; a manual correction states its own window — adjust it instead.'
      );
    }
    if (before.clockOut) {
      throw new ConflictException('This day is already closed.');
    }

    const clockOut = AttendanceService.parseInstant(dto.clockOut, 'clockOut');
    if (clockOut <= before.clockIn) {
      throw new ConflictException('clockOut must be later than the recorded clockIn.');
    }

    const row = await this.attendance.close(id, clockOut);

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.UPDATE,
      resource: HR_AUDIT_RESOURCE.ATTENDANCE,
      resourceId: row.id,
      oldValue: { clockOut: null, open: true },
      newValue: {
        clockOut: row.clockOut ? row.clockOut.toISOString() : null,
        dateKey: row.dateKey,
      },
      changedFields: ['clockOut'],
    });

    return AttendanceService.serialize(row);
  }

  /**
   * Records — or restates — the ONE manual correction for an employee-day (§13).
   *
   * IT CANNOT EDIT THE PUNCH. The statement it drives is keyed on
   * `(tenantId, employeeId, workDate, MANUAL)`, so the `DEVICE` row for that day is not
   * addressable from this path at all. A first correction creates the `MANUAL` row; a
   * second correction of the SAME day sets it, and the audit trail keeps both acts. That
   * is the difference between correcting a register and rewriting it.
   *
   * `reason` is written to the row AND carried on the audit event, because §13 asks a
   * correction to carry "actor + sanitized reason + audit event": the actor and the
   * event identity are stamped by `HrAuditGateway` from the actor, and the reason is
   * stated once by the caller and recorded in both places it is needed.
   */
  async adjust(actor: HrActor, dto: AdjustAttendanceDto) {
    const employee = await this.resolveEmployee(actor, dto.employeeId);

    const clockIn = AttendanceService.parseInstant(dto.clockIn, 'clockIn');
    const clockOut = dto.clockOut ? AttendanceService.parseInstant(dto.clockOut, 'clockOut') : null;

    // 400, not 409: this is an incoherent PAYLOAD (a window that runs backwards), not a
    // contradiction with what is already stored. `Attendance_punch_order_check` refuses
    // it in the database as well, so a future writer cannot introduce one either.
    if (clockOut && clockOut <= clockIn) {
      throw new BadRequestException('clockOut must be later than clockIn.');
    }

    const { workDate, dateKey } = AttendanceService.resolveWorkDay(clockIn);

    const existing = await this.attendance.findDayBySource(
      actor.tenantId,
      employee.id,
      workDate,
      'MANUAL'
    );

    const row = await this.attendance.upsertManual(actor.tenantId, employee.id, workDate, {
      dateKey,
      clockIn,
      clockOut,
      reason: dto.reason,
    });

    await this.audit.record(actor, {
      action: HR_AUDIT_ACTION.ADJUST,
      resource: HR_AUDIT_RESOURCE.ATTENDANCE,
      resourceId: row.id,
      oldValue: existing
        ? {
            clockIn: existing.clockIn.toISOString(),
            clockOut: existing.clockOut ? existing.clockOut.toISOString() : null,
          }
        : null,
      newValue: {
        employeeId: row.employeeId,
        dateKey: row.dateKey,
        workDate: AttendanceService.toDateKey(row.workDate),
        clockIn: row.clockIn.toISOString(),
        clockOut: row.clockOut ? row.clockOut.toISOString() : null,
        source: row.source,
        reason: row.reason,
      },
      reason: dto.reason,
    });

    return AttendanceService.serialize(row);
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  /**
   * The INSERT, with the loser of a concurrent clock-in translated to the same 409 the
   * pre-check produces.
   *
   * The pre-check makes the ordinary case a comprehensible error; the unique index
   * `Attendance_tenantId_employeeId_workDate_source_key` is the ARBITER, and a race must
   * not surface as a 500 for a caller who did nothing wrong. The same fix as
   * `PositionsService.createPositionOrConflict`, for the same reason.
   */
  private async createPunch(
    actor: HrActor,
    punch: { employeeId: string; workDate: Date; dateKey: string; clockIn: Date }
  ) {
    try {
      return await this.attendance.create({
        tenantId: actor.tenantId,
        employeeId: punch.employeeId,
        workDate: punch.workDate,
        dateKey: punch.dateKey,
        clockIn: punch.clockIn,
        clockOut: null,
        source: 'DEVICE',
      });
    } catch (err) {
      if (AttendanceService.isUniqueViolation(err)) {
        throw new ConflictException(
          `This employee already has a recorded clock-in for ${punch.dateKey}; correct that day through the adjustment route instead of opening a second one.`
        );
      }
      throw err;
    }
  }

  /**
   * The employee a register row may be written for, or a refusal.
   *
   * `EmployeeRepository.findById` is tenant-scoped, so another tenant's employee is a 404
   * — the same answer a nonexistent id gets, which is what keeps the two
   * indistinguishable to a caller probing for ids.
   *
   * A TERMINATED employee is a 409: their employment has ended, so a punch for them is
   * not a fact about the organization's work — it is a data-entry error. `INACTIVE` is
   * allowed on purpose: it is an administrative label for a record currently out of use
   * (long-term leave, an archived file), and an inactive person can still be at work.
   */
  private async resolveEmployee(actor: HrActor, employeeId: string) {
    const employee = await this.employees.findById(actor.tenantId, employeeId);
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.status === 'TERMINATED') {
      throw new ConflictException(
        'Attendance cannot be recorded for a terminated employee; rehire the person first.'
      );
    }
    return employee;
  }

  /**
   * The day a punch belongs to — DERIVED, in ONE place (§8/§13).
   *
   * `APP_TIME_ZONE` is named rather than inherited: `TZ` is empty in the api container,
   * so an ambient default would make the stored day depend on the deployment. The Jalali
   * date comes from `instantToJalaliDate`, the Gregorian civil date from the round trip
   * through `jalaliToGregorian`, and the wire key from `formatJalaliDateKey` — three
   * calls into the ONE implementation of the calendar
   * (`src/calendar/jalali.util.ts`, reused by correspondence for the same reason), so HR
   * cannot drift from the rest of the platform on a month or year boundary.
   *
   * An overnight shift is attributed to the day it CLOCKED IN on: that is the shift's
   * day, and it is what keeps one work day to one row.
   */
  private static resolveWorkDay(clockIn: Date): { workDate: Date; dateKey: string } {
    const jalali = instantToJalaliDate(clockIn, APP_TIME_ZONE);
    const { gy, gm, gd } = jalaliToGregorian(jalali.jy, jalali.jm, jalali.jd);

    return {
      workDate: new Date(Date.UTC(gy, gm - 1, gd)),
      dateKey: formatJalaliDateKey(jalali),
    };
  }

  /**
   * The register's day filter, resolved once — now DELEGATED to
   * `attendance-window.ts` (Phase REPORTING-HR-PERSONNEL-TRAFFIC).
   *
   * The arithmetic moved because the personnel-traffic reporting seam must resolve the
   * exact same «which days?» question, and a second copy inside the reader would be a
   * second opinion about it: a register and its own report could then disagree. The
   * semantics — including every 400 message the resolver raises — are unchanged and
   * still proven by this service's own spec; only the ownership of the implementation
   * moved, so one file answers the question for both readers.
   */
  private static resolveDayBounds(query: ListAttendanceQueryDto): {
    from?: Date;
    to?: Date;
  } {
    return resolveAttendanceDayBounds(query);
  }

  /**
   * An instant, or the server's `now` when the caller supplied none (the punch path).
   *
   * The DTO already requires an explicit offset (`HR_ISO_INSTANT_PATTERN`); this guards
   * the remaining hole in that regex — a well-shaped but nonexistent date such as
   * `2026-02-31T08:00:00+03:30`, which `Date` resolves to `NaN` rather than accepting.
   */
  private static parseInstant(value: string | undefined, field: string): Date {
    if (value === undefined) return new Date();

    const instant = new Date(value);
    if (Number.isNaN(instant.getTime())) {
      throw new BadRequestException(`${field} must be a real ISO-8601 instant`);
    }
    return instant;
  }

  /**
   * The wire view of a register row: `workDate` is a DAY, not an instant.
   *
   * A `@db.Date` column IS a calendar day; its `Date` object is an artifact of the driver, and
   * emitting it as `2026-09-18T00:00:00.000Z` would hand the caller a timestamp that means
   * "midnight UTC" to a reader in Tehran — the exact ambiguity the Jalali `dateKey` exists to
   * remove. The module's other date-only columns already read this way (`EmploymentRecord
   * .startDate`/`.endDate` through `serializeEmploymentRecord`), so a register reads the same as
   * a personnel file. `clockIn` and `clockOut` stay ISO INSTANTS: they are moments, and a moment
   * stripped of its offset is a different moment.
   *
   * Applied at the BOUNDARY only — the five returns below. The rules, the repository and the
   * audit payloads keep working with the stored `Date`, so nothing that compares or writes DAYS
   * can be handed a string.
   */
  private static serialize<T extends { workDate: Date }>(row: T) {
    return { ...row, workDate: AttendanceService.toDateKey(row.workDate) };
  }

  /** `YYYY-MM-DD` for a stored `@db.Date` — the shared day-key reader (attendance-window). */
  private static toDateKey(workDate: Date): string {
    return attendanceWorkDateKey(workDate);
  }

  /**
   * The Prisma unique-constraint code.
   *
   * Read structurally rather than by importing a Prisma error type: this module reaches
   * its database through `HrPrismaService` and deliberately imports nothing from the
   * generated client, which is what keeps a Core client from being reachable here at all
   * (see `hr-isolation.spec.ts`). Core's `integration.service.ts` uses the same shape.
   */
  private static isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string })?.code === 'P2002';
  }
}
