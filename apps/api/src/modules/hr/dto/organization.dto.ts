import {
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { HR_RECORD_STATUSES, HrRecordStatus, HrPageQueryDto } from './hr-query.dto';

/**
 * Phase 51-HR-1: organization-unit and position DTOs.
 *
 * Both catalogues share the same shape of rule, which is why they live together:
 *
 *   * `code` is unique PER TENANT and is normalised on the same four steps as an
 *     employee code — a global unique would make two tenants collide, which is a
 *     tenancy bug rather than a data-integrity win (see the schema notes);
 *   * `parentId` / `organizationUnitId` are validated by the SERVICE to live in the
 *     actor's tenant, and by a composite foreign key in `hr_db` as the real guarantee.
 *     The DTO can only say "this is a UUID"; whether it is MY uuid is a tenancy
 *     question the DTO has no business answering.
 */

/** Upper bounds matching the `varchar` widths in `hr_db`, so a 400 precedes a 22001. */
export const MAX_UNIT_CODE_LENGTH = 64;
export const MAX_UNIT_NAME_LENGTH = 200;
export const MAX_POSITION_CODE_LENGTH = 64;
export const MAX_POSITION_TITLE_LENGTH = 200;

/**
 * Codes accept the same alphabet as an employee code: `A-Z 0-9 . _ / -`.
 *
 * Persian unit names are the norm and are fully allowed in `name`; the CODE is a
 * stable machine key, which is why it is restricted to characters that survive a CSV
 * export, a URL and a log line without escaping.
 */
export const HR_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]{0,63}$/;

/** The chart-profile kinds a unit may carry — عملیاتی / ستادی on screen. */
export const ORGANIZATION_UNIT_KINDS = ['OPERATIONAL', 'STAFF'] as const;
export type OrganizationUnitKind = (typeof ORGANIZATION_UNIT_KINDS)[number];

/**
 * The optional profile fields every unit write shares: the create accepts them at
 * birth, the update accepts them — including an explicit `null` that CLEARS one —
 * afterward. A field omitted from the body is left untouched, exactly like
 * `name`; only `null` says "remove this label".
 */
class OrganizationUnitProfileFields {
  @IsOptional()
  @IsIn(ORGANIZATION_UNIT_KINDS)
  kind?: OrganizationUnitKind;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  managerName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string | null;

  /** Whole tomans as a digit string — DECIMAL(20,0) at rest, never a float. */
  @IsOptional()
  @IsNumberString()
  @MaxLength(20)
  monthlyBudget?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  responsibility?: string | null;
}

export class CreateOrganizationUnitDto extends OrganizationUnitProfileFields {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_UNIT_CODE_LENGTH)
  @Matches(HR_CODE_PATTERN, {
    message:
      'code must start with a letter or digit and contain only A-Z, 0-9, ".", "_", "/" or "-"',
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_UNIT_NAME_LENGTH)
  name!: string;

  /** Omitted for a root unit. Cycle-freedom is enforced by trigger AND by the service. */
  @IsOptional()
  @IsUUID('4')
  parentId?: string;
}

export class UpdateOrganizationUnitDto extends OrganizationUnitProfileFields {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_UNIT_NAME_LENGTH)
  name?: string;

  /**
   * `null` detaches the unit to the root; a UUID re-parents it. The service refuses a
   * re-parent that would create a cycle with a 409 rather than a raw trigger error.
   */
  @IsOptional()
  @IsUUID('4')
  parentId?: string | null;
}

export class CreatePositionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_POSITION_CODE_LENGTH)
  @Matches(HR_CODE_PATTERN, {
    message:
      'code must start with a letter or digit and contain only A-Z, 0-9, ".", "_", "/" or "-"',
  })
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_POSITION_TITLE_LENGTH)
  title!: string;

  @IsUUID('4')
  organizationUnitId!: string;

  @IsOptional()
  @IsIn(HR_RECORD_STATUSES)
  status?: HrRecordStatus;
}

/**
 * `organizationUnitId` is updatable because a position can be MOVED between units
 * without changing identity. Employees are not moved by this: their own current
 * assignment is an `EmploymentRecord`, and it keeps pointing at the position, so a
 * move re-labels the slot and never rewrites anyone's history.
 */
export class UpdatePositionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_POSITION_TITLE_LENGTH)
  title?: string;

  @IsOptional()
  @IsUUID('4')
  organizationUnitId?: string;

  @IsOptional()
  @IsIn(HR_RECORD_STATUSES)
  status?: HrRecordStatus;
}

export class ListPositionsQueryDto extends HrPageQueryDto {
  @IsOptional()
  @IsUUID('4')
  organizationUnitId?: string;

  @IsOptional()
  @IsIn(HR_RECORD_STATUSES)
  status?: HrRecordStatus;
}

/**
 * The statistics header of `GET /hr/organization` and `GET /hr/positions`.
 *
 * It is a real query result (a count over the tenant's own rows), never a placeholder:
 * the HR home screen shows "تعداد کارکنان" and a zero has to mean zero.
 */
export class ListUnitsQueryDto extends HrPageQueryDto {
  @IsOptional()
  @IsUUID('4')
  parentId?: string;

  @IsOptional()
  @IsIn(HR_RECORD_STATUSES)
  status?: HrRecordStatus;
}

/**
 * The (de)activation body shared by units and positions.
 *
 * There is no DELETE counterpart anywhere in this module: both catalogues are referenced
 * by employment history, so their lifecycle ends at INACTIVE and their rows are retained.
 */
export class SetRecordStatusDto {
  @IsIn(HR_RECORD_STATUSES)
  status!: HrRecordStatus;
}
