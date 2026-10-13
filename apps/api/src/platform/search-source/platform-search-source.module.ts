import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { PlatformAIModule } from '../ai/platform-ai.module';
import { SEARCH_SOURCE_PORT } from './search-source.contract';
import { SearchDocumentWriter } from './search-document.writer';
import { SearchEmbeddingService } from './search-embedding.service';
import { SearchSourceService } from './search-source.service';

/**
 * Phase P-SEARCH-SOURCE: the platform's search-source seam, and the module that
 * owns the binding.
 *
 * WHY THIS IS A PLATFORM MODULE AND NOT PART OF `SearchModule`
 * -----------------------------------------------------------
 * A bounded context that contributes searchable projections must depend on this
 * module WITHOUT acquiring anything else. `SearchModule` imports `RbacModule` and
 * exposes the whole query capability; a module importing it would be one
 * `@Inject` away from Core's permission tables. This module imports `PrismaModule`
 * and `PlatformAIModule` for its OWN use (the writer, and the embedding path through
 * the AI gateway contract) and exports the
 * seam — the same shape `PlatformAuditModule` established for the audit port.
 *
 * WHAT IT EXPORTS, AND FOR WHOM
 * -----------------------------
 *   `SEARCH_SOURCE_PORT` — the ONLY thing a bounded context needs: register a
 *       source, then push projections / removals through the returned handle.
 *   `SearchSourceService` — for the PLATFORM's query path (`SearchService` calls
 *       `weightMultiplier` and `authorize`). A business module has no use for it
 *       and must not call it; the eventual Commerce isolation spec makes that a
 *       rule, exactly as `commerce-isolation.spec.ts` makes "no Core Prisma" one.
 *   `SearchDocumentWriter` — for `SearchIndexerService`, which projects the
 *       platform's own sources through the same single write path.
 *
 * WHAT IT DELIBERATELY DOES NOT EXPORT: `PrismaService` reaches importers of this
 * module only if they also import `PrismaModule`, which no consumer does — the
 * module re-exports nothing from `PrismaModule`. There is no HTTP controller here
 * and none is needed: registration is application composition, not an end-user
 * operation.
 */
@Module({
  imports: [PrismaModule, PlatformAIModule],
  providers: [
    SearchEmbeddingService,
    SearchDocumentWriter,
    SearchSourceService,
    // `useExisting` rather than `useClass`, so ONE registry serves the port, the
    // query path and the ingestion boundary; the port cannot be satisfied by a
    // second, divergent instance whose registrations the query path cannot see.
    { provide: SEARCH_SOURCE_PORT, useExisting: SearchSourceService },
  ],
  exports: [SEARCH_SOURCE_PORT, SearchSourceService, SearchDocumentWriter],
})
export class PlatformSearchSourceModule {}
