import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Phase 49D-1: Organization Directory list query.
 *
 * Only filters backed by real columns are accepted. The global ValidationPipe
 * runs with `whitelist` + `forbidNonWhitelisted`, so any other query parameter
 * (notably `tenantId`) is rejected rather than silently honoured — tenant scope
 * comes exclusively from the authenticated identity via RequestContextService.
 *
 * Pagination follows the repository convention established by the blog
 * repository: `{ cursor, limit }` in, `{ items, hasMore }` out. `limit` is
 * capped (not rejected) at 100 by the service, so an oversized request is
 * bounded instead of failing.
 */
export class DirectoryQueryDto {
  /** Id of the last item on the previous page. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  /** Free-text search over firstName, lastName, email, phone, extension. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  q?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  department?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  jobTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  managerId?: string;
}
