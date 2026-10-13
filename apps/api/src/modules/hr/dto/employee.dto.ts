import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import { HR_EMPLOYEE_CODE_PATTERN, HR_ISO_DATE_PATTERN } from '../hr.constants';
import { HR_EMPLOYMENT_TYPES, HrEmploymentType } from './hr-query.dto';

/**
 * Phase 51-HR-1: employee DTOs.
 *
 * WHAT IS DELIBERATELY ABSENT FROM EVERY DTO HERE
 * ----------------------------------------------
 *   * `tenantId` — resolved from the request context (`resolveHrActor`);
 *   * `createdAt` / `updatedAt` — database facts;
 *   * any Core identity field (email, passwordHash, roles) — HR does not own
 *     identity. `userId` is a plain opaque identifier and nothing more, and
 *     `EmployeesService` validates it is a member of the actor's tenant through
 *     `UserDirectoryContract` before storing it (§14).
 *
 * The global `ValidationPipe` runs with `whitelist` + `forbidNonWhitelisted`, so an
 * attempt to send any of the above is a 400 rather than a silently ignored field.
 */

/** Upper bound on an employee code, matching `varchar(64)` in `hr_db`. */
export const MAX_EMPLOYEE_CODE_LENGTH = 64;

/**
 * Normalises an employee code to the exact form the unique constraint stores.
 *
 * THE FOUR STEPS ARE THE CONTRACT (they are documented in `prisma/hr/schema.prisma`
 * and asserted by the employee service spec):
 *   1. Unicode NFC, then trim leading/trailing whitespace;
 *   2. reject interior whitespace (returned as-is, so the pattern check fails with a
 *      comprehensible 400 instead of a confusing "does not match");
 *   3. ASCII uppercase, so `e-1042` and `E-1042` are the SAME code and collide on
 *      the unique index rather than creating two records;
 *   4. that is all — the pattern itself is enforced by `@Matches`, in one place.
 *
 * The function lives HERE, beside the DTO that validates it, rather than in the
 * service: the service imports it, so one implementation is shared by validation and
 * persistence and there is no second copy to drift.
 */
export function normalizeEmployeeCode(raw: string): string {
  const nfc = raw.normalize('NFC').trim();
  if (/\s/.test(nfc)) return nfc;
  return nfc.toUpperCase();
}

/** `e-1042` → `E-1042`; `  E-1042 ` → `E-1042`; `E 1042` → unchanged (invalid). */
export const NormalizedEmployeeCode = () =>
  Transform(({ value }) => (typeof value === 'string' ? normalizeEmployeeCode(value) : value));

/**
 * The statuses an ADMINISTRATOR may set DIRECTLY — on create, on update and on the
 * dedicated status route alike. This is the ONE definition of that rule: every DTO in this
 * file that carries a `status` validates against it.
 *
 * WHY `TERMINATED` IS NOT AMONG THEM, IN DOMAIN TERMS. Terminating an employment is not a
 * status edit: it CLOSES the open interval on a chosen effective date and is audited as a
 * termination (`EmploymentService.terminate`). Declaring `TERMINATED` through a status
 * field would produce an employee marked TERMINATED while an interval is still open — a
 * personnel file that contradicts itself, and a state no endpoint can then resolve:
 * `openInterval` refuses to move it ("use the rehire endpoint") and `rehire` has no open
 * interval to append after. `POST /hr/employees`, `PATCH /hr/employees/:id` and
 * `PATCH /hr/employees/:id/status` must not disagree about the same word.
 *
 * `INACTIVE` IS allowed here: it is an administrative label for a record currently out of
 * use (long-term leave, an archived file) and it makes no claim about intervals.
 */
export const HR_MANUAL_EMPLOYEE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

/** One of `HR_MANUAL_EMPLOYEE_STATUSES`. */
export type HrManualEmployeeStatus = (typeof HR_MANUAL_EMPLOYEE_STATUSES)[number];

export class CreateEmployeeDto {
  /**
   * The tenant-scoped personnel number. Normalised then pattern-checked, so the value
   * that reaches the database is exactly the value the unique index is defined on.
   */
  @NormalizedEmployeeCode()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_EMPLOYEE_CODE_LENGTH)
  @Matches(HR_EMPLOYEE_CODE_PATTERN, {
    message:
      'employeeCode must start with a letter or digit and contain only A-Z, 0-9, ".", "_", "/" or "-"',
  })
  employeeCode!: string;

  /**
   * OPTIONAL Core identity link. Omitted when the person is employed before they are
   * given a login — a normal, supported state (§16), not an error.
   */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  /**
   * Validates against `HR_MANUAL_EMPLOYEE_STATUSES`, NOT the list filter's
   * `HR_EMPLOYEE_STATUSES`: a record may be CREATED as INACTIVE (an archived personnel
   * file, someone on long-term leave), but never as TERMINATED — that word means "the
   * open interval was closed on an effective date" and is only ever produced by
   * `POST /hr/employees/:id/terminate`.
   */
  @IsOptional()
  @IsIn(HR_MANUAL_EMPLOYEE_STATUSES)
  status?: HrManualEmployeeStatus;

  // -- the FIRST employment interval ---------------------------------------
  //
  // An Employee with no EmploymentRecord would have no unit, no position and no start
  // date — i.e. no answer to "where do they work and since when". The schema
  // deliberately keeps the current assignment OUT of `Employee`, so a record is created
  // with its first interval in the same transaction. These fields are therefore
  // required on create and absent from `UpdateEmployeeDto`.

  @IsIn(HR_EMPLOYMENT_TYPES)
  employmentType!: HrEmploymentType;

  /** `YYYY-MM-DD`. The first day of employment. */
  @Matches(HR_ISO_DATE_PATTERN, { message: 'startDate must be a YYYY-MM-DD date' })
  startDate!: string;

  @IsUUID('4')
  organizationUnitId!: string;

  @IsUUID('4')
  positionId!: string;

  /** Optional direct manager, as an EMPLOYEE id — never a Core user id (§13). */
  @IsOptional()
  @IsUUID('4')
  managerEmployeeId?: string;
}

/**
 * The mutable fields of an Employee.
 *
 * `employeeCode` IS mutable and is re-normalised on every write, because the unique
 * index is on the normalised value: permitting an update without re-running
 * normalisation would let `e-1042` coexist with `E-1042`.
 *
 * Employment facts are NOT here — a transfer or a promotion is a NEW
 * `EmploymentRecord` (`POST /hr/employees/:id/employment-records`), never an edit.
 * Moving the current assignment by an update would erase history, which §10 forbids.
 */
export class UpdateEmployeeDto {
  @IsOptional()
  @NormalizedEmployeeCode()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_EMPLOYEE_CODE_LENGTH)
  @Matches(HR_EMPLOYEE_CODE_PATTERN, {
    message:
      'employeeCode must start with a letter or digit and contain only A-Z, 0-9, ".", "_", "/" or "-"',
  })
  employeeCode?: string;

  /** `null` explicitly UNLINKS the identity; omitting the field leaves it as it was. */
  @IsOptional()
  @IsUUID('4')
  userId?: string | null;

  @IsOptional()
  @IsIn(HR_MANUAL_EMPLOYEE_STATUSES)
  status?: HrManualEmployeeStatus;
}

/**
 * A new effective-dated interval (transfer, promotion, contract renewal).
 *
 * The service CLOSES the currently-open interval the day before `startDate` and opens
 * this one, in a single transaction. That is why this is a POST to a history
 * collection and not a PATCH to the employee: the previous assignment must survive,
 * which is what makes "who was in Finance in 1402" answerable later.
 */
export class CreateEmploymentRecordDto {
  @IsIn(HR_EMPLOYMENT_TYPES)
  employmentType!: HrEmploymentType;

  @Matches(HR_ISO_DATE_PATTERN, { message: 'startDate must be a YYYY-MM-DD date' })
  startDate!: string;

  @IsUUID('4')
  organizationUnitId!: string;

  @IsUUID('4')
  positionId!: string;

  @IsOptional()
  @IsUUID('4')
  managerEmployeeId?: string;
}

/**
 * Ends employment — or ends the CURRENT interval, when `status` is left `ACTIVE`.
 *
 * `endDate` is required and must not precede the open interval's start. The service
 * refuses to close an interval that is already closed rather than silently doing
 * nothing, so a double terminate is a 409 instead of an apparent success.
 */
export class TerminateEmploymentDto {
  @Matches(HR_ISO_DATE_PATTERN, { message: 'endDate must be a YYYY-MM-DD date' })
  endDate!: string;

  /** Free-text reason. Recorded in the audit row; never on the employee record. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * The dedicated status route.
 *
 * It validates against `HR_MANUAL_EMPLOYEE_STATUSES` declared ONCE above — the same
 * constant `CreateEmployeeDto` and `UpdateEmployeeDto` use. That single declaration is
 * the point: "POST /hr/employees, PATCH /hr/employees/:id and PATCH
 * /hr/employees/:id/status must not disagree about the same word", and a second copy of
 * the list here is exactly how they would start to.
 */
export class SetEmployeeStatusDto {
  @IsIn(HR_MANUAL_EMPLOYEE_STATUSES)
  status!: HrManualEmployeeStatus;
}
