/**
 * Phase KPI-RUNTIME — the wire contract of `GET /api/v1/kpis` and `GET /api/v1/kpis/:key`.
 *
 * TWO OPTIONAL INTEGERS, AND NOTHING ELSE. `jy`/`jm` name the Jalali month the values are
 * cohorted on; omit either and the server fills it from the current month, so a screen that
 * never thinks about periods still gets a well-defined one.
 *
 * WHAT IS DELIBATELY ABSENT, AND WHY:
 *  * NO `tenantId` — it comes from the request context, and the global pipe's `whitelist` +
 *    `forbidNonWhitelisted` turns sending one into a 422 rather than a filter. The same rule
 *    every report DTO in this repository records, for the same reason.
 *  * NO `statuses` / `search` / `page` / `pageSize` — this surface computes a SUMMARISED
 *    figure, not a register. A whitelisted `?status=…` accepted and silently ignored would be
 *    exactly the dishonest parameter these DTOs refuse: it would promise a filter that
 *    changes nothing about the number.
 *  * NO `period=ALL` / `since=` — no approved definition has a period-less window (all five
 *    cohort on a Jalali month), so an "everything" flag would compute a figure the catalog
 *    never defined.
 *
 * The bounds are READ from the calendar module (`KPI_PERIOD_BOUNDS`) rather than restated,
 * so a change to the accepted year window cannot leave the DTO disagreeing with the parser.
 */

import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { KPI_PERIOD_BOUNDS } from './kpi-runtime.period';

export class KpiPeriodQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(KPI_PERIOD_BOUNDS.minYear)
  @Max(KPI_PERIOD_BOUNDS.maxYear)
  jy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(KPI_PERIOD_BOUNDS.minMonth)
  @Max(KPI_PERIOD_BOUNDS.maxMonth)
  jm?: number;
}

/**
 * Phase KPI-HISTORICAL-INTELLIGENCE — the wire contract of `GET /kpis/:key/history`.
 *
 * TWO SHAPES, ONE BOUND: either `periodCount` (last N months ending at the current
 * month) or an explicit `from`/`to` month pair — never both half-stated. Every field
 * is optional so the web default (last 6) is the empty query; the service fills the
 * anchor from its own clock.
 *
 * WHY `periodCount` HAS NO `@Max` HERE: the ceiling belongs to the RANGE RESOLVER, so
 * an oversized ask fails with the deterministic `HISTORY_RANGE_EXCEEDS_LIMIT` code
 * (400) rather than a generic validation error that cannot say WHICH rule refused it.
 * The resolver refuses before any seam is reached, so a huge integer costs nothing.
 * Month fields keep their calendar bounds here — an impossible month is a malformed
 * request (422), not a range question.
 */
export class KpiHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  periodCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(KPI_PERIOD_BOUNDS.minYear)
  @Max(KPI_PERIOD_BOUNDS.maxYear)
  fromJy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(KPI_PERIOD_BOUNDS.minMonth)
  @Max(KPI_PERIOD_BOUNDS.maxMonth)
  fromJm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(KPI_PERIOD_BOUNDS.minYear)
  @Max(KPI_PERIOD_BOUNDS.maxYear)
  toJy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(KPI_PERIOD_BOUNDS.minMonth)
  @Max(KPI_PERIOD_BOUNDS.maxMonth)
  toJm?: number;
}
