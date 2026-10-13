import { IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { HR_ISO_DATE_PATTERN, HR_MAX_PAGE_SIZE } from '../hr/hr.constants';
import { MISSION_REQUEST_STATUSES, type MissionRequestStatus } from '../hr/domain/mission-status';
import { MISSION_DURATION_MODES } from '../hr/domain/mission-date-time';
/**
 * Phase REPORTING-HR-MISSION-REQUEST: the Reporting-side wire contract for
 * «گزارش وضعیت درخواست‌های مأموریت».
 *
 * ONLY the filters the mission register supports — `employeeId` (the person the
 * request is FOR), `status` (the closed seven-member lifecycle set), `durationMode`
 * (HOURLY/DAILY) and the `from`/`to` intersection window (Gregorian `YYYY-MM-DD`
 * days) — plus the repository's own page window.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and the
 *    global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one into a 4xx.
 *  * NO `search` — `ListMissionRequestsQueryDto` declares none; a parameter the
 *    source never answers would silently match everything.
 *  * NO location/engagement/destination filter — the register declares none, even
 *    though it STORES those columns; a filter the domain cannot answer would be a lie
 *    on the wire.
 *  * NO duration / rate / KPI field — the HR schema stores none of them, and a query
 *    parameter the domain cannot answer would be a lie on the wire.
 *
 * `@IsIn(MISSION_REQUEST_STATUSES)` is read from `domain/mission-status.ts`, the
 * lifecycle's ONE authority. An unknown member is a 4xx at the boundary rather than
 * a filter the database silently matches nothing with.
 */
export class ListHrMissionReportQueryDto {
  @IsOptional()
  @IsUUID('4')
  employeeId?: string;

  @IsOptional()
  @IsIn(MISSION_REQUEST_STATUSES)
  status?: MissionRequestStatus;

  @IsOptional()
  @IsIn(MISSION_DURATION_MODES)
  durationMode?: 'HOURLY' | 'DAILY';

  /** Inclusive lower bound on the mission's LAST day (intersection). */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  /** Inclusive upper bound on the mission's FIRST day. Refused if it precedes `from`. */
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
export class HrMissionReportTimelineQueryDto {
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
export const REPORTING_HR_MISSION_STATUSES: readonly string[] = [...MISSION_REQUEST_STATUSES];
