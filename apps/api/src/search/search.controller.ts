import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import type { SearchResponseDto } from './search.types';

/**
 * Phase 49J: the Global Search HTTP surface.
 *
 * ONE ROUTE. `GET /search?q=…`, authenticated, with the actor always taken from
 * `req.user.sub`. There is no tenant, user or impersonation parameter anywhere in the
 * contract, so no request can be shaped to search as somebody else.
 *
 * NO `@Roles(...)` GATE, AND NO NEW PERMISSION — the same decision `CalendarController`
 * (49I) and `NotificationController` (49E) made, for a stronger reason here: every
 * result has ALREADY passed its own source's authorization rule (conversation
 * membership, ticket participation or `admin.support.manage`, survey publication,
 * notification/reminder ownership, the Directory tenant policy). A `search.read`
 * permission would be a second, weaker gate in front of gates that already exist, and
 * revoking it would not prevent anyone from reading the same rows through the ticket,
 * message and survey APIs they already have.
 *
 * NO WRITE ROUTE, AND NO REINDEX ROUTE. Indexing is a server-side operation; exposing
 * `POST /search/reindex` would put a full-corpus, provider-billed table scan behind an
 * HTTP verb. Reindexing is done through `SearchIndexerService` from a script or an
 * administrative task.
 *
 * NO `GET /search/suggest` and no autocomplete route: a suggest endpoint that ran the
 * same authorization stage would cost the same as a search, and one that skipped it
 * would leak titles. The UI debounces this route instead.
 */
@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  /**
   * Named `searchService` rather than `search`: the handler below is also `search`, and
   * a property and a method cannot share a name on the same class.
   */
  constructor(private readonly searchService: SearchService) {}

  private subject(req: ExRequest): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub as string;
  }

  /**
   * `GET /search?q=…&limit=…&offset=…&sourceType=…`
   *
   * `q` is validated by the DTO (length-bounded — it is also the embedding input, so an
   * unbounded string would be an unbounded provider call) and normalized in the service.
   * `limit` is CAPPED rather than rejected. `sourceType` narrows and can never widen.
   *
   * The global ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so any
   * parameter not declared on `SearchQueryDto` is REJECTED rather than ignored — which
   * is what makes the absence of a `tenantId` parameter a boundary rather than an
   * omission.
   */
  @Get()
  async search(
    @Request() req: ExRequest,
    @Query() query: SearchQueryDto
  ): Promise<SearchResponseDto> {
    return this.searchService.search(this.subject(req), query);
  }
}
