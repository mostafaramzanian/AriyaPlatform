import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Phase 49E: Notification Center list query.
 *
 * Mirrors DirectoryQueryDto (Phase 49D-1) exactly: `{ cursor, limit }` in,
 * `{ items, hasMore }` out. The global ValidationPipe runs with `whitelist` +
 * `forbidNonWhitelisted`, so any other query parameter — notably `userId` or
 * `tenantId` — is rejected rather than silently honoured. Recipient and tenant
 * scope come exclusively from the authenticated identity.
 *
 * `limit` is capped (not rejected) at 100 by the service, so an oversized
 * request is bounded instead of failing.
 */
export class NotificationQueryDto {
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

  /**
   * Optional read-state filter. Deliberately a closed set of two values rather
   * than a generic query language.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(['unread', 'read'])
  state?: 'unread' | 'read';
}
