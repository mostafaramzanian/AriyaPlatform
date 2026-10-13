import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { COMMERCE_DEFAULT_PAGE_SIZE, COMMERCE_MAX_PAGE_SIZE } from '../commerce.constants';

/**
 * Phase C1 Step L: the shared pagination envelope of every Commerce list endpoint.
 *
 * WHY THIS FILE IS SHARED AND NOT WRITTEN PER SLICE. Steps L through S each expose a
 * list, and a page window re-derived beside each one is how the fourth list ends up
 * with an off-by-one `skip` or a different ceiling. `hr/dto/hr-query.dto.ts` is the
 * precedent, adopted rather than reinvented: one base DTO, one window resolver, and
 * the module constants carrying the numbers.
 *
 * `COMMERCE_MAX_PAGE_SIZE` is enforced HERE (a 400 for an absurd page size) and again
 * in each service (`Math.min`, so an internal caller that builds its own query object
 * cannot exceed it either). The DTO bound is the CONTRACT; the service bound is the
 * GUARANTEE.
 *
 * THERE IS NO `tenantId` FIELD AND THERE NEVER WILL BE. The tenant comes from
 * `resolveCommerceActor(req)`, so a client cannot widen its own scope by asking for
 * another tenant's page. The global pipe's `whitelist` + `forbidNonWhitelisted` means
 * an attempt to send one is a 400 rather than a silently ignored field.
 *
 * THIS FILE DECIDES NOTHING ABOUT WHO MAY READ. Pagination is not authorization: what
 * a caller may see is decided at the boundary, never by how many rows are returned.
 */
export class CommercePageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(COMMERCE_MAX_PAGE_SIZE)
  pageSize?: number;

  /**
   * Free-text match against the record's own identifying column.
   *
   * A purchase document has exactly one such column (`documentNumber`), which is what
   * a support call quotes — so a search that matched a description nobody stores would
   * be a route that always returns everything.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

/** Resolves the effective page window for a list query, clamped to the ceiling. */
export function resolveCommercePageWindow(query: CommercePageQueryDto): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(
    COMMERCE_MAX_PAGE_SIZE,
    Math.max(1, query.pageSize ?? COMMERCE_DEFAULT_PAGE_SIZE)
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
