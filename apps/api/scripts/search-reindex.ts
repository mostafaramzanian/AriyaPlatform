import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CoreAppModule } from '../src/core-app.module';
import { SearchIndexerService } from '../src/search/search-indexer.service';
import { PrismaService } from '../src/database/prisma.service';

/**
 * Phase 49J: one-off full reindex.
 *
 * A SCRIPT, NOT AN HTTP ROUTE AND NOT A CRON JOB. A full rebuild is a table scan over
 * eight sources plus one embedding call per row, i.e. a provider-billed operation; putting
 * it behind `POST /search/reindex` would expose that cost to anyone holding a token, and a
 * timer would repeatedly rebuild a corpus whose vectors cannot be computed while no
 * embedding credential is configured.
 *
 * Bootstraps `CoreAppModule` with `NestFactory.createApplicationContext` — no HTTP
 * listener, no guards, no interceptors: this process authenticates nobody and serves
 * nothing. `SearchModule` exports `SearchIndexerService` precisely so this is possible
 * without reaching into the module's internals.
 *
 * Reports honestly. `embeddingSkipped` is printed per source, and the closing summary
 * counts rows with and without a vector, so a lexical-only index is visible rather than
 * implied.
 */
async function main() {
  const app = await NestFactory.createApplicationContext(CoreAppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const indexer = app.get(SearchIndexerService);
    const prisma = app.get(PrismaService);

    const started = Date.now();
    const results = await indexer.rebuildAll();
    const elapsedMs = Date.now() - started;

    console.log('\n=== 49J REINDEX ===');
    for (const result of results) {
      console.log(
        `${result.sourceType.padEnd(15)} projected=${String(result.projected).padStart(5)} ` +
          `embedded=${String(result.embedded).padStart(5)} ` +
          `embeddingSkipped=${result.embeddingSkipped}`
      );
    }

    // Read the table back rather than trusting the in-process counters: the CHECK
    // constraints and the ON CONFLICT upsert are the authority on what was actually
    // stored.
    const rows = await prisma.$queryRaw<
      Array<{ sourceType: string; total: bigint; withVector: bigint }>
    >`
      SELECT "sourceType"::text AS "sourceType",
             COUNT(*)                                        AS total,
             COUNT(*) FILTER (WHERE "embedding" IS NOT NULL)  AS "withVector"
      FROM "SearchDocument"
      GROUP BY "sourceType"
      ORDER BY 1
    `;

    console.log('\n--- stored rows (read back from SearchDocument) ---');
    for (const row of rows) {
      console.log(
        `${row.sourceType.padEnd(15)} rows=${String(row.total).padStart(5)} ` +
          `withEmbedding=${String(row.withVector).padStart(5)}`
      );
    }

    const [totals] = await prisma.$queryRaw<
      Array<{ total: bigint; withVector: bigint; blank: bigint }>
    >`
      SELECT COUNT(*)                                                AS total,
             COUNT(*) FILTER (WHERE "embedding" IS NOT NULL)          AS "withVector",
             COUNT(*) FILTER (WHERE char_length("searchText") < 1)    AS blank
      FROM "SearchDocument"
    `;

    console.log(
      `\nTOTAL rows=${totals.total} withEmbedding=${totals.withVector} blankSearchText=${totals.blank} in ${elapsedMs}ms`
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('[49J REINDEX FAILED]', error);
  process.exit(1);
});
