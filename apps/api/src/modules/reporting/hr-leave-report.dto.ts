import { IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { HR_ISO_DATE_PATTERN, HR_MAX_PAGE_SIZE } from '../hr/hr.constants';
import { LEAVE_REQUEST_STATUSES, type LeaveRequestStatus } from '../hr/domain/leave-status';
/**
 * Phase REPORTING-HR-LEAVE-REQUEST: the Reporting-side wire contract for
 * «گزارش وضعیت درخواست‌های مرخصی».
 *
 * ONLY the filters the leave register supports — `employeeId` (the person the request
 * is FOR), `leaveTypeId` (the tenant's own catalogue entry), `status` (the closed
 * four-member lifecycle set) and the `from`/`to` intersection window (Gregorian
 * `YYYY-MM-DD` days) — plus the repository's own page window.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and the
 *    global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one into a 4xx.
 *  * NO `search` — `ListLeaveRequestsQueryDto` declares one, but `LeaveService.list`
 *    deliberately IGNORES it: the register's own filter is employee, type, state and
 *    window, and a Reporting parameter the source never answers would be a filter that
 *    silently matches everything. The web's own contract test pins this absence.
 *  * NO duration / balance / rate field — the HR schema stores none of them (§13), and
 *    a query parameter the domain cannot answer would be a lie on the wire.
 *
 * `@IsIn(LEAVE_REQUEST_STATUSES)` is read from `domain/leave-status.ts`, the
 * lifecycle's ONE authority. An unknown member is a 4xx at the boundary rather than
 * a filter the database silently matches nothing with.
 */
export class ListHrLeaveReportQueryDto {
  @IsOptional()
  @IsUUID('4')
  employeeId?: string;

  @IsOptional()
  @IsUUID('4')
  leaveTypeId?: string;

  @IsOptional()
  @IsIn(LEAVE_REQUEST_STATUSES)
  status?: LeaveRequestStatus;

  /** Inclusive lower bound on the request's LAST day (intersection). */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  /** Inclusive upper bound on the request's FIRST day. Refused if it precedes `from`. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

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
}

/** The timeline window — page + pageSize only, like every sibling list. */
export class HrLeaveReportTimelineQueryDto {
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
}

/** The closed lifecycle set this report counts over — re-exported for callers. */
export const REPORTING_HR_LEAVE_STATUSES: readonly string[] = [...LEAVE_REQUEST_STATUSES];
