import { Module } from '@nestjs/common';
import { PrismaModule } from '../database/prisma.module';
import { RbacModule } from '../auth/rbac/rbac.module';
import { PlatformAIModule } from '../platform/ai/platform-ai.module';
import { PlatformSearchSourceModule } from '../platform/search-source/platform-search-source.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchRepository } from './search.repository';
import { SearchAuthorizer } from './search-authorizer.service';
import { SearchIndexerService } from './search-indexer.service';

/**
 * Phase 49J: Global Search.
 *
 * A CORE capability, registered in CoreAppModule (and AppModule), never in the CMS-only
 * process — it reads eight Core tables and the Core `SearchDocument` projection, none of
 * which exist in `cms_db`.
 *
 * WHY EACH IMPORT IS HERE
 * -----------------------
 * PrismaModule — the repository, the authorizer and the indexer all read Core tables.
 *
 * RbacModule   — `PermissionService`, and ONLY for it: the two flags that decide whether
 *                a caller sees internal ticket comments (`admin.support.manage`) and
 *                draft surveys (`admin.surveys.manage`). No `@Roles(...)` is enforced on
 *                the controller, so RolesGuard has nothing to do here; the permissions
 *                are inputs to the authorization rules, not a gate on the route.
 *
 * PlatformAIModule — the AI GATEWAY contract (`AI_GATEWAY`), the ONLY AI surface
 *                search may use since Phase AI-ARCH-HARDENING. `SearchService`
 *                embeds queries through it; it applies the configured provider
 *                (or the env bootstrap when no row exists) and hands back a
 *                structured result. Nothing here instantiates a provider, reads
 *                `OPENAI_API_KEY`, or touches `AIProviderConfig` — the AI platform
 *                is consumed through its contract, not imported around.
 *
 * NO StorageModule: search never touches attachments. Storage keys are E-class and are
 * not indexed.
 *
 * NO NotificationModule: search creates nothing and notifies nobody.
 *
 * NO MessagingModule / SupportModule / SurveysModule / CalendarModule, and that is the
 * important one. Search does NOT call those services. It re-implements their READ
 * predicates in `SearchAuthorizer`, deliberately: their read methods each throw on the
 * unauthorized case and would mean one call per candidate, i.e. an N+1 that also cannot
 * express "drop this row silently". Every predicate in the authorizer names the service
 * method it mirrors so the two can be diffed by a reader.
 *
 * `SearchIndexerService` is exported so a script or administrative task can trigger a
 * rebuild. It is deliberately NOT a scheduled job in this phase: with no embedding
 * credential configured, a timer would repeatedly rebuild a corpus whose vectors cannot
 * be computed, and pretending otherwise with a cron entry would be dishonest.
 *
 * PHASE P-SEARCH-SOURCE: `PlatformSearchSourceModule` joins the import list. It is how
 * an INDEPENDENT bounded context's rows participate: the query path consults the
 * registry (`SearchSourceService`) for the weight and the authorization of `EXTERNAL`
 * candidates, and the indexer writes the platform's own rows through the same module's
 * `SearchDocumentWriter`. The import is ONE-WAY — this module reaches the platform
 * seam; the seam never reaches back into search's controller, service or authorizer,
 * and no bounded context needs to import anything from `src/search/**`.
 */
@Module({
  imports: [PrismaModule, RbacModule, PlatformAIModule, PlatformSearchSourceModule],
  controllers: [SearchController],
  providers: [SearchService, SearchRepository, SearchAuthorizer, SearchIndexerService],
  exports: [SearchService, SearchIndexerService],
})
export class SearchModule {}
