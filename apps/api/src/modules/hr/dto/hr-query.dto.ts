import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { HR_DEFAULT_PAGE_SIZE, HR_MAX_PAGE_SIZE } from '../hr.constants';

/**
 * Phase 51-HR-1: the shared pagination envelope of every HR list endpoint.
 *
 * `HR_MAX_PAGE_SIZE` is enforced HERE (a 400 for an absurd page size) and again in
 * the service (`Math.min`, so an internal caller cannot exceed it either). The DTO
 * bound is the contract; the service bound is the guarantee.
 *
 * There is no `tenantId` field and there never will be: the tenant comes from
 * `resolveHrActor`, so a client cannot widen its own scope. `whitelist` +
 * `forbidNonWhitelisted` on the global pipe means an attempt to send one is a 400.
 */
export class HrPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HR_MAX_PAGE_SIZE)
  pageSize?: number;

  /** Free-text match against the record's own identifying columns. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Resolves the effective page window for a list query, clamped to the ceiling. */
export function resolvePageWindow(query: HrPageQueryDto): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(HR_MAX_PAGE_SIZE, Math.max(1, query.pageSize ?? HR_DEFAULT_PAGE_SIZE));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** The employee-record lifecycle, as the API accepts it. Matches `EmployeeStatus`. */
export const HR_EMPLOYEE_STATUSES = ['ACTIVE', 'INACTIVE', 'TERMINATED'] as const;
/** Matches `EmploymentType` in `prisma/hr/schema.prisma`. */
export const HR_EMPLOYMENT_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'CONTRACT',
  'TEMPORARY',
  'INTERNSHIP',
] as const;
/** Matches `EmploymentStatus` — the lifecycle of ONE effective-dated interval. */
export const HR_EMPLOYMENT_STATUSES = ['ACTIVE', 'ENDED'] as const;
/** Matches `HrRecordStatus` — the catalogue lifecycle of a unit or a position. */
export const HR_RECORD_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
/** Matches `AttendanceSource` — where an attendance row came from (Phase 51-HR-3). */
export const HR_ATTENDANCE_SOURCES = ['DEVICE', 'MANUAL'] as const;

export type HrEmployeeStatus = (typeof HR_EMPLOYEE_STATUSES)[number];
export type HrEmploymentType = (typeof HR_EMPLOYMENT_TYPES)[number];
export type HrEmploymentStatus = (typeof HR_EMPLOYMENT_STATUSES)[number];
export type HrRecordStatus = (typeof HR_RECORD_STATUSES)[number];
export type HrAttendanceSource = (typeof HR_ATTENDANCE_SOURCES)[number];

/**
 * The employee list filter.
 *
 * `organizationUnitId` / `positionId` filter on the CURRENT (open) interval, not on
 * history: "who is in Finance now" is the question the screen asks. History is
 * reachable per employee through `GET /hr/employees/:id/employment-records`, which is
 * where a "who was in Finance in 1402" question belongs.
 */
export class ListEmployeesQueryDto extends HrPageQueryDto {
  @IsOptional()
  @IsIn(HR_EMPLOYEE_STATUSES)
  status?: HrEmployeeStatus;

  @IsOptional()
  @IsUUID('4')
  organizationUnitId?: string;

  @IsOptional()
  @IsUUID('4')
  positionId?: string;
}
