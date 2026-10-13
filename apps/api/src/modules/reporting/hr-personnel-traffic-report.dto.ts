import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import {
  HR_ISO_DATE_PATTERN,
  HR_JALALI_DATE_KEY_PATTERN,
  HR_MAX_PAGE_SIZE,
} from '../hr/hr.constants';
import {
  HR_PERSONNEL_TRAFFIC_SOURCES,
  type HrPersonnelTrafficSource,
} from '../hr/attendance/hr-attendance-source';

/**
 * Phase REPORTING-HR-PERSONNEL-TRAFFIC: the Reporting-side wire contract for
 * «گزارش تردد پرسنل».
 *
 * ONLY the filters the attendance register supports — the day window (`from`/`to` as
 * Gregorian `YYYY-MM-DD`, `dateKey` as one Jalali `YYYY/MM/DD` day), `source` (the
 * closed two-member set) and `search` (the employee CODE — the register's one free-text
 * question) — plus the repository's own page window. The format of each parameter is
 * checked HERE; the DATE itself (a well-shaped but impossible day, the `dateKey`+`from`
 * exclusivity) is validated by the register's own `attendance-window.ts` inside the HR
 * seam, so both surfaces refuse the same window with the same 400.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY:
 *  * NO `tenantId` — the scope comes from the authenticated request context, and the
 *    global pipe's `whitelist` + `forbidNonWhitelisted` turns sending one into a 4xx.
 *  * NO `employeeId` — a raw personnel uuid with no display contract and no reporting
 *    navigation target; `search` presses on the employee CODE, the person key an
 *    operator actually knows (the same reason the sibling report DTOs refuse an
 *    actor-id filter).
 *  * NO attendance status, lateness, overtime or duration field — the HR schema stores
 *    none of them (§13), and a query parameter the domain cannot answer would be a
 *    filter that silently matches nothing.
 *
 * `@IsIn(HR_PERSONNEL_TRAFFIC_SOURCES)` is read from `hr-attendance-source.ts`, the
 * register's OWN closed vocabulary — the same trick the sibling DTOs use with their
 * closed sets. An unknown member is a 4xx at the boundary rather than a filter the
 * database silently matches nothing with.
 *
 * THE PAGE CEILING IS HR'S, NOT ANOTHER CONTEXT'S. An HR list and a report over HR must
 * answer «how big may a page be?» identically (`HR_MAX_PAGE_SIZE`), because two bounded
 * contexts disagreeing on that makes the answer depend on which route a client calls.
 */
export class ListHrPersonnelTrafficReportQueryDto {
  /** Inclusive lower bound on `work_date`, Gregorian. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: 'from must be a YYYY-MM-DD date' })
  from?: string;

  /** Inclusive upper bound on `work_date`, Gregorian. Refused if it precedes `from`. */
  @IsOptional()
  @Matches(HR_ISO_DATE_PATTERN, { message: 'to must be a YYYY-MM-DD date' })
  to?: string;

  /** One Jalali day, `YYYY/MM/DD` — mutually exclusive with `from`/`to`. */
  @IsOptional()
  @Matches(HR_JALALI_DATE_KEY_PATTERN, {
    message: 'dateKey must be a Jalali YYYY/MM/DD date',
  })
  dateKey?: string;

  @IsOptional()
  @IsIn(HR_PERSONNEL_TRAFFIC_SOURCES)
  source?: HrPersonnelTrafficSource;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

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

/**
 * The timeline window — page + pageSize only, like every sibling list.
 *
 * Its own class rather than a reuse of `ListHrPersonnelTrafficReportQueryDto`: a
 * timeline has nothing to filter by source or day, and a whitelisted `?source=…` that
 * was accepted and silently ignored is exactly the dishonest parameter this module's
 * DTOs refuse.
 */
export class HrPersonnelTrafficReportTimelineQueryDto {
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
