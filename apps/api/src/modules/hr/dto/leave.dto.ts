import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { HR_EMPLOYEE_CODE_PATTERN, HR_ISO_DATE_PATTERN } from '../hr.constants';
import { LEAVE_REQUEST_STATUSES, type LeaveRequestStatus } from '../domain/leave-status';
import { HR_RECORD_STATUSES, HrPageQueryDto, type HrRecordStatus } from './hr-query.dto';
import { NormalizedEmployeeCode } from './employee.dto';
import { TrimmedReason } from './attendance.dto';

/**
 * Phase 51-HR-3A: leave DTOs — the request register's and the type catalogue's contract.
 *
 * WHAT IS DELIBERATELY ABSENT FROM EVERY DTO HERE
 * ----------------------------------------------
 *   * `tenantId` — resolved from the request context (`resolveHrActor`), never sent. The
 *     global `ValidationPipe` runs `whitelist` + `forbidNonWhitelisted`, so an attempt to
 *     send one is a 400 rather than a silently ignored field;
 *   * `status` on CREATE — the initial state is a DOMAIN constant
 *     (`LEAVE_REQUEST_INITIAL_STATUS`), not a caller's choice: a request born APPROVED, on
 *     the day that member exists, would be a decision nobody made;
 *   * `cancelledAt` — derived from the withdrawal itself, and tied to the status by
 *     `LeaveRequest_cancelled_state_check` in `hr_db`;
 *   * `employeeId` on UPDATE — a request's SUBJECT is not movable. Re-pointing a request at
 *     somebody else is not an edit, it is a different request, and the two would share one
 *     audit trail;
 *   * `code` on the type UPDATE — a catalogue CODE is an identity, exactly as it is on
 *     `OrganizationUnit` (whose update DTO has no `code` either): renaming the key a tenant's
 *     own reports and imports cite is a new entry, not an edit. `name` and `status` move;
 *     `code` does not.
 *
 * WHY TWO HELPERS ARE REUSED FROM SIBLING DTO FILES
 * -----------------------------------------------
 * `NormalizedEmployeeCode` and `TrimmedReason` are the module's ONE spelling of "a code" and
 * "a trimmed value" — the same reason `HrPageQueryDto` and `HR_RECORD_STATUSES` are shared
 * from `hr-query.dto`. A second spelling of normalisation is how `annual` and `ANNUAL` end up
 * coexisting under one unique index, so re-using the helper is the point rather than a
 * convenience: `LeaveType_code_check` in `hr_db` restates the SAME contract an employee code
 * carries.
 */

/** Upper bounds matching the `varchar` widths in `hr_db`, so a 400 precedes a 22001. */
export const MAX_LEAVE_REASON_LENGTH = 500;
export const MAX_LEAVE_TYPE_CODE_LENGTH = 64;
export const MAX_LEAVE_TYPE_NAME_LENGTH = 200;

const DATE_MESSAGE = 'must be a calendar day in YYYY-MM-DD form, e.g. 2026-03-01';

/**
 * Submits a request: `POST /hr/leave-requests`.
 *
 * A request is a WHOLE-DAY, INCLUSIVE range — `startDate = endDate` is the ordinary
 * single-day case, not a special one — and it states WHY. Both facts are the database's as
 * well as this DTO's: `LeaveRequest_period_check` refuses an inverted range and
 * `LeaveRequest_reason_check` refuses a blank reason, so the 400 below is the courtesy and
 * the CHECK is the guarantee.
 *
 * THE RANGE IS NOT ARITHMETIC. No workdays are counted, no holidays are subtracted and no
 * `durationDays` is computed or stored (§13): which days of the range are actually WORKING
 * days is a question for the calendar and the shift, neither of which this phase owns.
 * Storing a verdict here would create a second answer that can disagree with them.
 */
export class CreateLeaveRequestDto {
  /** The person the request is FOR. Must be an employee of the ACTOR's tenant. */
  @IsUUID('4')
  employeeId!: string;

  /** The leave kind asked for. Must be a type of the ACTOR's tenant, and an ACTIVE one. */
  @IsUUID('4')
  leaveTypeId!: string;

  /** The FIRST day covered, inclusive. */
  @Matches(HR_ISO_DATE_PATTERN, { message: `startDate ${DATE_MESSAGE}` })
  startDate!: string;

  /** The LAST day covered, inclusive. Refused if it precedes `startDate`. */
  @Matches(HR_ISO_DATE_PATTERN, { message: `endDate ${DATE_MESSAGE}` })
  endDate!: string;

  /**
   * The requester's own statement of why, trimmed and stored as ONE line exactly as it was
   * typed — this module never re-words a person's statement.
   */
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_REASON_LENGTH)
  reason!: string;
}

/**
 * Restates a PENDING request: `PATCH /hr/leave-requests/:id`.
 *
 * ONLY WHILE PENDING, and that is enforced in the service rather than here: whether a row may
 * still change is a fact about the STORED row (`isLeaveRequestRestatable`), which a DTO cannot
 * see. A withdrawn request is never edited — a correction is a NEW request, which is what
 * keeps the trail of the withdrawal intact.
 *
 * EITHER BOUND MAY BE SENT ALONE, and the effective pair is resolved from the stored row
 * before it is validated: shortening a period by moving one end is the ordinary edit, and
 * refusing it would force a caller to re-state the untouched half. The pair is then checked as
 * a pair, so a combination that INVERTS the range is a 400 rather than a row the database's
 * `LeaveRequest_period_check` would reject as a 500.
 *
 * A body with none of these fields is a 400, not a no-op: it would write an audit event
 * describing an act that did not happen.
 */
export class UpdateLeaveRequestDto {
  @IsOptional()
  @IsUUID('4')
  leaveTypeId?: string;

  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `startDate ${DATE_MESSAGE}` })
  startDate?: string;

  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `endDate ${DATE_MESSAGE}` })
  endDate?: string;

  @IsOptional()
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_REASON_LENGTH)
  reason?: string;
}

/**
 * Withdraws a request: `POST /hr/leave-requests/:id/cancel`.
 *
 * THE REASON IS REQUIRED AND IS NOT STORED ON THE ROW, which is a decision rather than an
 * oversight. `LeaveRequest` has no `cancellation_reason` column — by design, since a
 * withdrawal is an EVENT (it stamps `cancelled_at`) and not a property of the request — and
 * the audit trail is where an act's stated reason belongs. It is written to the platform trail
 * through `HrAuditGateway`, so "why was this withdrawn, and by whom" is answered by
 * `core_db."AuditLog"`, the ONE trail §49 requires.
 *
 * Its precedent in this module is `AdjustAttendanceDto.reason`: an act that overrides
 * somebody's own record states why, and the statement travels with the act.
 */
export class CancelLeaveRequestDto {
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_REASON_LENGTH)
  reason!: string;
}

/**
 * The register filter.
 *
 * `from` / `to` are GREGORIAN `YYYY-MM-DD` days and mean INTERSECTION with the request's own
 * range, not containment: `from` keeps requests whose LAST day is on or after that day, and
 * `to` keeps requests whose FIRST day is on or before it. "What leave touches this window" is
 * the question a roster screen asks, and a containment filter would silently hide a request
 * that starts before the window and runs through it — the very rows the question is about.
 * Both bounds land on the stored `start_date` / `end_date` columns, so the indexes on
 * `(tenant_id, status, start_date)` and `(tenant_id, employee_id, start_date)` stay usable.
 *
 * `status` is the register's own filter, and `PENDING` is what a screen showing "what is still
 * open" sends.
 */
export class ListLeaveRequestsQueryDto extends HrPageQueryDto {
  @IsOptional()
  @IsUUID('4')
  employeeId?: string;

  @IsOptional()
  @IsUUID('4')
  leaveTypeId?: string;

  @IsOptional()
  @IsIn(LEAVE_REQUEST_STATUSES)
  status?: LeaveRequestStatus;

  /** Inclusive lower bound on the request's LAST day. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `from ${DATE_MESSAGE}` })
  from?: string;

  /** Inclusive upper bound on the request's FIRST day. Refused if it precedes `from`. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: `to ${DATE_MESSAGE}` })
  to?: string;
}

/**
 * Adds an entry to the tenant's OWN leave catalogue: `POST /hr/leave-types`.
 *
 * NOTHING IS SEEDED, ANYWHERE, WHICH IS WHY THIS DTO EXISTS AT ALL. Which leave kinds an
 * organization grants — annual, sick, unpaid, and what each one ENTITLES a person to — is that
 * organization's own policy; a taxonomy invented in a migration would be worn as a default by
 * every tenant that did not replace it, and a default that affects somebody's pay is not a
 * convenience.
 *
 * `code` is the stable machine key, normalised on the same four steps as an employee code
 * (NFC, trimmed, no interior whitespace, ASCII uppercase) and checked against the same
 * alphabet, because `LeaveType_tenantId_code_key` makes it unique PER TENANT on the NORMALISED
 * value — a global unique index would make two tenants collide, which is a tenancy bug rather
 * than a data-integrity win. `name` is whatever the tenant calls its own leave: trimmed, and
 * otherwise untouched, because Persian names are the norm.
 */
export class CreateLeaveTypeDto {
  @NormalizedEmployeeCode()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_TYPE_CODE_LENGTH)
  @Matches(HR_EMPLOYEE_CODE_PATTERN, {
    message:
      'code must start with a letter or digit and contain only A-Z, 0-9, ".", "_", "/" or "-"',
  })
  code!: string;

  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_TYPE_NAME_LENGTH)
  name!: string;
}

/**
 * Retires or renames a catalogue entry: `PATCH /hr/leave-types/:id`.
 *
 * `status` is how an entry LEAVES USE without leaving the database: `INACTIVE` makes it
 * unavailable for a NEW request while every request already recorded against it keeps
 * rendering its name. Deleting the row is not an option on either side of that sentence —
 * `LeaveRequest_tenant_leave_type_fkey` is `ON DELETE RESTRICT`, which is what a type that has
 * ever been requested looks like when history is never erased (§10).
 *
 * A body with neither field is a 400, the same rule the request update states.
 */
export class UpdateLeaveTypeDto {
  @IsOptional()
  @TrimmedReason()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEAVE_TYPE_NAME_LENGTH)
  name?: string;

  @IsOptional()
  @IsIn(HR_RECORD_STATUSES)
  status?: HrRecordStatus;
}

/** The catalogue filter: the request form sends `status=ACTIVE` and nothing else. */
export class ListLeaveTypesQueryDto extends HrPageQueryDto {
  @IsOptional()
  @IsIn(HR_RECORD_STATUSES)
  status?: HrRecordStatus;
}
