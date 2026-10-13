import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Phase 49H: survey list query.
 *
 * Mirrors DirectoryQueryDto (49D-1), NotificationQueryDto (49E),
 * ConversationQueryDto (49F) and TicketQueryDto (49G) exactly: `{ cursor, limit }`
 * in, `{ items, hasMore }` out.
 *
 * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so any
 * other query parameter — notably `tenantId`, `userId` or `createdById` — is
 * rejected rather than silently honoured. Tenant scope comes exclusively from the
 * authenticated caller.
 *
 * `scope` can only ever NARROW what the caller is already entitled to see:
 *  - `available` (the default for a non-author) restricts to surveys the caller may
 *    actually answer right now — PUBLISHED, inside their availability window.
 *  - `mine` restricts to surveys the caller authored.
 *  - `all` is honoured only for a caller holding `admin.surveys.manage`; for anyone
 *    else the service collapses it back to `available`, because the visibility
 *    predicate is applied unconditionally.
 *
 * `status` is accepted as a facet but, like `scope`, it cannot widen visibility: a
 * non-manager asking for `status=DRAFT` gets an empty page, not someone else's
 * unpublished questionnaire.
 *
 * `limit` is capped (not rejected) by the service, so an oversized request is
 * bounded instead of failing.
 */
export class SurveyQueryDto {
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
  @IsIn(['available', 'mine', 'all'])
  scope?: 'available' | 'mine' | 'all';

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsIn(['DRAFT', 'PUBLISHED', 'CLOSED'])
  status?: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
}
