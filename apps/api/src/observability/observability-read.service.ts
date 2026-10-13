import { BadRequestException, Injectable } from '@nestjs/common';
import { ObservabilityPrismaService } from '../database/observability-prisma.service';
import { LOG_LEVEL_SEVERITY, LogLevelValue } from './observability.contract';
import {
  ApplicationLogQueryDto,
  AuditEventQueryDto,
  DEFAULT_PAGE_SIZE,
  LifecycleEventQueryDto,
  MAX_PAGE_SIZE,
  MAX_RANGE_DAYS,
  ObservabilityQueryDto,
  SecurityEventQueryDto,
} from './dto/observability-query.dto';

/**
 * Phase 49M-2: the bounded read side.
 *
 * EVERY QUERY IN THIS FILE IS BOUNDED THREE WAYS, and none of the three is optional:
 *   1. A MANDATORY TIME RANGE, validated here as well as in the DTO — see `resolveRange`.
 *   2. A CAPPED PAGE SIZE (`MAX_PAGE_SIZE`), so no caller can ask for 100,000 rows.
 *   3. AN `ORDER BY "occurredAt" DESC` THAT MATCHES THE §21 INDEX PREFIX, so the planner
 *      does an index range scan rather than sorting a large intermediate result.
 * Drop any one and this becomes the endpoint that takes the database down during the
 * incident it was built to diagnose.
 *
 * `count` IS NOT RETURNED. `SELECT count(*)` over a multi-million-row range is as expensive
 * as the page itself and gets slower as the table grows, so the response carries `hasMore` —
 * derived by fetching `limit + 1` rows and discarding the extra. An exact total for a table
 * that is being appended to continuously is stale before it reaches the browser anyway.
 *
 * NO `select` NARROWING ON PURPOSE for detail-bearing columns: the whole row is what an
 * operator reads. The privacy work happened at WRITE time — bodies, headers, query strings
 * and credentials were never stored — so there is nothing here that needs hiding at read
 * time. That is the payoff of expressing privacy as absence rather than as a read filter
 * someone can forget to apply.
 */

export interface PagedResult<T> {
  items: T[];
  limit: number;
  offset: number;
  hasMore: boolean;
  range: { from: string; to: string };
}

@Injectable()
export class ObservabilityReadService {
  constructor(private readonly prisma: ObservabilityPrismaService) {}

  /**
   * Validates and normalizes the window.
   *
   * THE DTO CANNOT DO THIS. `@IsDateString()` proves each bound parses; it cannot prove that
   * `from` precedes `to`, nor that the span is under `MAX_RANGE_DAYS`. Both are relational
   * facts about two fields, so they belong here — and both are the difference between an
   * index range scan and a scan of the whole table.
   */
  private resolveRange(query: ObservabilityQueryDto): { from: Date; to: Date } {
    const from = new Date(query.from);
    const to = query.to ? new Date(query.to) : new Date();

    if (Number.isNaN(from.getTime())) throw new BadRequestException('`from` is not a valid date');
    if (Number.isNaN(to.getTime())) throw new BadRequestException('`to` is not a valid date');
    if (from >= to) throw new BadRequestException('`from` must be earlier than `to`');

    const spanDays = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
    if (spanDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Time range must not exceed ${MAX_RANGE_DAYS} days (requested ${Math.ceil(spanDays)})`,
      );
    }

    return { from, to };
  }

  private resolvePaging(query: ObservabilityQueryDto): { take: number; skip: number } {
    const take = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    return { take, skip: query.offset ?? 0 };
  }

  /** Trims the sentinel row and reports whether more exist. */
  private page<T>(
    rows: T[],
    take: number,
    skip: number,
    range: { from: Date; to: Date },
  ): PagedResult<T> {
    const hasMore = rows.length > take;
    return {
      items: hasMore ? rows.slice(0, take) : rows,
      limit: take,
      offset: skip,
      hasMore,
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
    };
  }

  /**
   * Application logs.
   *
   * `minLevel` BECOMES AN `in` OVER AN EXPLICIT LIST rather than a `gte` comparison, because
   * `LogLevel` is a Postgres enum whose declaration order happens to be ascending — relying
   * on that would make correctness depend on the order enum members were written in the
   * schema. Expanding to a value list keeps the semantics in TypeScript where
   * `LOG_LEVEL_SEVERITY` defines them.
   */
  async findApplicationLogs(query: ApplicationLogQueryDto): Promise<PagedResult<unknown>> {
    const range = this.resolveRange(query);
    const { take, skip } = this.resolvePaging(query);

    const where: Record<string, unknown> = {
      occurredAt: { gte: range.from, lt: range.to },
    };

    if (query.level) where.level = query.level;
    else if (query.minLevel) {
      const floor = LOG_LEVEL_SEVERITY[query.minLevel as LogLevelValue];
      where.level = {
        in: (Object.keys(LOG_LEVEL_SEVERITY) as LogLevelValue[]).filter(
          (level) => LOG_LEVEL_SEVERITY[level] >= floor,
        ),
      };
    }

    if (query.source) where.source = query.source;
    if (query.messageCode) where.messageCode = query.messageCode;
    if (query.requestId) where.requestId = query.requestId;
    if (query.correlationId) where.correlationId = query.correlationId;
    if (query.traceId) where.traceId = query.traceId;
    if (query.route) where.route = query.route;
    if (query.statusCode !== undefined) where.statusCode = query.statusCode;
    if (query.userId) where.userId = query.userId;
    if (query.moduleId) where.moduleId = query.moduleId;

    const rows = await this.prisma.applicationLog.findMany({
      where: where as never,
      // `id` as the tiebreaker makes the order TOTAL. Without it, rows sharing a millisecond
      // can be returned in different positions on different pages, so an operator paging
      // through a burst would see one line twice and another never.
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      skip,
    });

    return this.page(rows, take, skip, range);
  }

  /** Audit events from observability_db. core_db."AuditLog" is read by its own endpoints. */
  async findAuditEvents(query: AuditEventQueryDto): Promise<PagedResult<unknown>> {
    const range = this.resolveRange(query);
    const { take, skip } = this.resolvePaging(query);

    const where: Record<string, unknown> = {
      occurredAt: { gte: range.from, lt: range.to },
    };

    if (query.action) where.action = query.action;
    if (query.resourceType) where.resourceType = query.resourceType;
    if (query.resourceId) where.resourceId = query.resourceId;
    if (query.actorId) where.actorId = query.actorId;
    if (query.outcome) where.outcome = query.outcome;
    if (query.correlationId) where.correlationId = query.correlationId;

    const rows = await this.prisma.auditEvent.findMany({
      where: where as never,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      skip,
    });

    return this.page(rows, take, skip, range);
  }

  /**
   * Security events.
   *
   * `succeeded` IS COMPARED AS A STRING, matching the DTO: a query string carries `"false"`,
   * and `Boolean("false")` is `true`. Parsing it here rather than trusting a transform keeps
   * the inversion impossible for the one filter where getting it backwards would hide every
   * failed attempt in the window.
   *
   * `attemptedIdentifier` COMES BACK ALREADY MASKED — it was masked before insert, so there
   * is no unmasked copy to leak. Nothing at read time has to remember to hide it.
   */
  async findSecurityEvents(query: SecurityEventQueryDto): Promise<PagedResult<unknown>> {
    const range = this.resolveRange(query);
    const { take, skip } = this.resolvePaging(query);

    const where: Record<string, unknown> = {
      occurredAt: { gte: range.from, lt: range.to },
    };

    if (query.eventType) where.eventType = query.eventType;
    if (query.severity) where.severity = query.severity;
    if (query.succeeded !== undefined) where.succeeded = query.succeeded === 'true';
    if (query.ipAddress) where.ipAddress = query.ipAddress;
    if (query.actorId) where.actorId = query.actorId;

    const rows = await this.prisma.securityEvent.findMany({
      where: where as never,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      skip,
    });

    return this.page(rows, take, skip, range);
  }

  /** Lifecycle events: the interleaved integration / module / provisioning timeline. */
  async findLifecycleEvents(query: LifecycleEventQueryDto): Promise<PagedResult<unknown>> {
    const range = this.resolveRange(query);
    const { take, skip } = this.resolvePaging(query);

    const where: Record<string, unknown> = {
      occurredAt: { gte: range.from, lt: range.to },
    };

    if (query.domain) where.domain = query.domain;
    if (query.phase) where.phase = query.phase;
    if (query.eventType) where.eventType = query.eventType;
    if (query.subjectId) where.subjectId = query.subjectId;
    if (query.correlationId) where.correlationId = query.correlationId;
    if (query.moduleId) where.moduleId = query.moduleId;

    const rows = await this.prisma.lifecycleEvent.findMany({
      where: where as never,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
      skip,
    });

    return this.page(rows, take, skip, range);
  }

  /**
   * The last N retention runs.
   *
   * NO TIME RANGE REQUIRED, and this is the one exception in the file. `RetentionRun` grows
   * by four rows per pass — a few thousand a year — so it is the only table here where an
   * unfiltered recent-rows query is bounded by the data itself rather than by the query.
   * It answers "is retention actually running", which a mandatory window would obstruct.
   */
  async findRetentionRuns(limit = 40): Promise<unknown[]> {
    return this.prisma.retentionRun.findMany({
      orderBy: [{ startedAt: 'desc' }],
      take: Math.min(Math.max(limit, 1), MAX_PAGE_SIZE),
    });
  }
}
