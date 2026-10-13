import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Phase 49F: cursor page query for conversations and messages.
 *
 * Mirrors DirectoryQueryDto (49D-1) and NotificationQueryDto (49E) exactly:
 * `{ cursor, limit }` in, `{ items, hasMore }` out.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so
 * any other query parameter — notably `userId`, `senderId` or `tenantId` — is
 * rejected rather than silently honoured. Membership and tenant scope come
 * exclusively from the authenticated identity.
 *
 * `limit` is capped (not rejected) by the service, so an oversized request is
 * bounded instead of failing.
 */
export class ConversationQueryDto {
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
}

/**
 * Message page query. Identical to the conversation page plus `after`, which the
 * reconnect path uses to recover messages missed while the socket was down.
 *
 * `after` is a message id, not a timestamp: a client clock cannot be trusted and
 * an id resolves to an exact, server-known position in the ordering.
 */
export class MessageQueryDto extends ConversationQueryDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(64)
  after?: string;
}
