import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Phase 49G: ticket list query.
 *
 * Mirrors DirectoryQueryDto (49D-1), NotificationQueryDto (49E) and
 * ConversationQueryDto (49F) exactly: `{ cursor, limit }` in, `{ items, hasMore }`
 * out.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so any
 * other query parameter — notably `requesterId`, `userId` or `tenantId` — is
 * rejected rather than silently honoured. Requester identity and tenant scope come
 * exclusively from the authenticated caller.
 *
 * `scope` is the only visibility knob and it can only ever NARROW what the caller
 * is already entitled to see: `mine` restricts to the caller's own tickets, and
 * `all` is honoured only for a caller holding `admin.support.manage` — for anyone
 * else it collapses back to `mine` in the service.
 *
 * `limit` is capped (not rejected) by the service, so an oversized request is
 * bounded instead of failing.
 */
export class TicketQueryDto {
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

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(['mine', 'assigned', 'all'])
  scope?: 'mine' | 'assigned' | 'all';

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(['NEW', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_REQUESTER', 'RESOLVED', 'CLOSED'])
  status?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(['BUG', 'SUPPORT', 'SUGGESTION', 'CRITICISM', 'COMPLAINT', 'FEATURE_REQUEST'])
  type?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
  priority?: string;
}

/** Comment page query. Same cursor contract, no extra filters. */
export class TicketCommentQueryDto {
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
