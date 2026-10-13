import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { MAX_QUERY_LENGTH, MIN_QUERY_LENGTH } from '../search.constants';

/**
 * Phase 49J: the Global Search query contract.
 *
 * Modelled on `DirectoryQueryDto` (49D-1), including the reason its shape is
 * restrictive: the global ValidationPipe runs with `whitelist` +
 * `forbidNonWhitelisted`, so any parameter not declared here is REJECTED rather
 * than ignored.
 *
 * THERE IS NO `tenantId`, `userId` OR `asUser` PARAMETER, and their absence is the
 * security boundary, not an omission. Identity and tenant come exclusively from the
 * authenticated request (`req.user.sub` and `RequestContextService`), so no caller
 * can search another tenant or impersonate another user by editing a query string.
 *
 * There is also no `includeInternal`, `includeDrafts` or `includeUnpublished`
 * switch: what a caller may see is decided by each source's own rule, never by a
 * request parameter.
 */
export class SearchQueryDto {
  /**
   * The raw query. Trimmed here; NORMALIZED in the service, because normalization
   * is a search concern and this DTO must not diverge from the indexer's rules.
   *
   * `MinLength(MIN_QUERY_LENGTH)` on the RAW value is a cheap guard only — the real
   * check is on the NORMALIZED length in the service, since a query of pure
   * punctuation or ZWNJ normalizes to nothing regardless of how long it looked.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(MIN_QUERY_LENGTH)
  @MaxLength(MAX_QUERY_LENGTH)
  q!: string;

  /**
   * Page size. CAPPED by the service rather than rejected, matching
   * `DirectoryQueryDto`: an oversized request is bounded, not turned into a 400.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  /**
   * Zero-based offset, in units of already-RETURNED results.
   *
   * OFFSET, NOT A CURSOR, and the reason is worth stating: the other Core lists page
   * by `(sortColumn, id)` cursor because their order is a stable column ordering. A
   * search result order is a computed relevance score that is not stored anywhere,
   * so there is no column to resume from — a cursor here would have to encode the
   * score, and the score changes the moment the underlying documents change.
   *
   * The honest consequence, which the API documents rather than hides: paging deep
   * into a result set re-runs retrieval and re-applies authorization, so a page
   * boundary can shift if the corpus changes between requests. Offsets are bounded
   * by the candidate cap, so a caller cannot walk the whole corpus this way.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /**
   * Optional single-source filter.
   *
   * Validated against the SAME literal list the projection enum declares. Written
   * out rather than derived from the generated Prisma enum on purpose:
   * `class-validator` needs a runtime array, and `@IsIn(Object.values(...))` over a
   * generated type would silently start accepting a new member the moment one is
   * added to the schema — before any indexer or authorization rule exists for it.
   *
   * NARROWS, NEVER WIDENS: it restricts which sources are consulted and cannot grant
   * access to anything the caller could not already see.
   */
  @IsOptional()
  @IsString()
  @IsIn([
    'TICKET',
    'TICKET_COMMENT',
    'SURVEY',
    'MESSAGE',
    'CONVERSATION',
    'NOTIFICATION',
    'REMINDER',
    'USER',
  ])
  sourceType?: string;
}
