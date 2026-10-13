import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { buildSearchText } from './persian-normalize';
import { INDEX_BATCH_SIZE, type PlatformSearchSourceType } from './search.constants';
import { SearchDocumentWriter } from '../platform/search-source/search-document.writer';

/**
 * Phase 49J: the projection writer for the PLATFORM'S OWN sources.
 *
 * Reads Core business rows, projects an ALLOWLISTED subset of their text through
 * the Persian normalizer, and hands the result to the platform's one
 * `SearchDocumentWriter` (Phase P-SEARCH-SOURCE moved the SQL and the embedding
 * call there, so the platform's indexer and the external ingestion boundary write
 * identical rows through identical rules).
 *
 * WHAT REMAINS THIS FILE'S RESPONSIBILITY
 * ---------------------------------------
 * 1. ONLY ALLOWLISTED FIELDS ARE PROJECTED. Each `project*` method lists the exact
 *    columns it reads, and every one is content a user typed. No `passwordHash`, no
 *    `tokenVersion`, no storage key, no audit row, no `AIProviderConfig` column, no
 *    credential — E-class data has no path into this table because no method selects
 *    it.
 * 2. NO AUTHORIZATION DATA IS DENORMALIZED. `ownerId`, `authorId`, `isInternal` and
 *    `conversationId` are read to find and tenant-stamp rows, and then DISCARDED.
 *    Storing them would create a de-facto ACL in a cache that goes stale the moment
 *    membership changes.
 * 3. PLATFORM ROWS ONLY. Every row written here is one of the eight
 *    `PlatformSearchSourceType` sources with `sourceKey = ''`; `EXTERNAL` is
 *    outside this file's type and is written only through the platform search
 *    source port.
 *
 * `SearchDocumentWriter` enforces the write-side rules (the conflict target, the
 * embedding COALESCE, the nonblank skip) exactly once for both callers.
 */

/** One row ready to be written. Deliberately carries no owner/member field. */
interface Projection {
  sourceType: PlatformSearchSourceType;
  sourceId: string;
  tenantId: string | null;
  searchText: string;
  sourceUpdatedAt: Date;
}

/** What one indexing pass did. Returned so a rebuild can be reported honestly. */
export interface IndexResult {
  sourceType: PlatformSearchSourceType;
  projected: number;
  embedded: number;
  /**
   * True when embeddings were skipped because the provider was unavailable. Rows are
   * still written; they are lexical-only.
   */
  embeddingSkipped: boolean;
}

@Injectable()
export class SearchIndexerService {
  private readonly logger = new Logger(SearchIndexerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: SearchDocumentWriter
  ) {}

  /**
   * Rebuilds every source, one at a time.
   *
   * SEQUENTIAL, not parallel: a rebuild is a bulk background operation, and eight
   * concurrent table scans plus eight concurrent embedding streams would compete with
   * live traffic for both the connection pool and the provider rate limit.
   */
  async rebuildAll(): Promise<IndexResult[]> {
    // One pass, one embedding latch: the first provider failure in a pass latches
    // off for the remainder of it, so a missing credential costs one attempt per
    // pass rather than one per row. `rebuildSource` alone does NOT reset it —
    // unchanged from 49J.
    this.writer.beginPass();

    const results: IndexResult[] = [];
    for (const sourceType of SEARCH_SOURCE_ORDER) {
      results.push(await this.rebuildSource(sourceType));
    }

    return results;
  }

  /**
   * Rebuilds one source in `INDEX_BATCH_SIZE` batches.
   *
   * Paged by `id` cursor rather than `skip`/`take`: an OFFSET scan re-reads and
   * discards every earlier row, so a large table gets quadratically slower, and rows
   * inserted mid-rebuild shift the window and cause skips.
   */
  async rebuildSource(sourceType: PlatformSearchSourceType): Promise<IndexResult> {
    let cursor: string | undefined;
    let projected = 0;
    let embedded = 0;

    for (;;) {
      const batch = await this.loadBatch(sourceType, cursor);
      if (batch.length === 0) break;

      embedded += await this.writeBatch(batch);
      projected += batch.length;
      cursor = batch[batch.length - 1].sourceId;

      if (batch.length < INDEX_BATCH_SIZE) break;
    }

    const result: IndexResult = {
      sourceType,
      projected,
      embedded,
      embeddingSkipped: projected > 0 && embedded < projected,
    };

    this.logger.log(
      `Indexed ${projected} ${sourceType} rows, ${embedded} embedded${
        result.embeddingSkipped ? ' (embedding unavailable — rows are lexical-only)' : ''
      }`
    );

    return result;
  }

  /**
   * Loads and projects one batch of one source, after `cursor`.
   *
   * The switch is EXHAUSTIVE over `PlatformSearchSourceType` — the `never`
   * assignment makes a new PLATFORM source a compile error, so no source can be
   * added to the projection without someone writing the fields it may expose.
   * `EXTERNAL` is outside this type: those rows are contributed through the
   * platform search source port, never projected here.
   */
  private loadBatch(
    sourceType: PlatformSearchSourceType,
    cursor: string | undefined
  ): Promise<Projection[]> {
    switch (sourceType) {
      case 'TICKET':
        return this.projectTickets(cursor);
      case 'TICKET_COMMENT':
        return this.projectTicketComments(cursor);
      case 'SURVEY':
        return this.projectSurveys(cursor);
      case 'MESSAGE':
        return this.projectMessages(cursor);
      case 'CONVERSATION':
        return this.projectConversations(cursor);
      case 'NOTIFICATION':
        return this.projectNotifications(cursor);
      case 'REMINDER':
        return this.projectReminders(cursor);
      case 'USER':
        return this.projectUsers(cursor);
      default: {
        const exhaustive: never = sourceType;
        throw new Error(`No projection for search source ${String(exhaustive)}`);
      }
    }
  }

  /** Keyset page: `id > cursor`, ordered by `id`. Bounded to `INDEX_BATCH_SIZE`. */
  private page(cursor: string | undefined) {
    return {
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: 'asc' as const },
      take: INDEX_BATCH_SIZE,
    };
  }

  /**
   * TICKET — `trackingNumber`, `subject`, `body`, `category`.
   *
   * `trackingNumber` is included because quoting it back is the single most common
   * way a user looks for a ticket. `requesterId`/`assigneeId` are NOT projected: they
   * are authorization data, and the authorizer re-reads them.
   */
  private async projectTickets(cursor: string | undefined): Promise<Projection[]> {
    const rows = await this.prisma.ticket.findMany({
      ...this.page(cursor),
      select: {
        id: true,
        tenantId: true,
        trackingNumber: true,
        subject: true,
        body: true,
        category: true,
        updatedAt: true,
      },
    });

    return rows.map((row) => ({
      sourceType: 'TICKET' as const,
      sourceId: row.id,
      tenantId: row.tenantId,
      searchText: buildSearchText([
        row.trackingNumber,
        row.subject,
        row.body,
        row.category,
      ]),
      sourceUpdatedAt: row.updatedAt,
    }));
  }

  /**
   * TICKET_COMMENT — `body` only.
   *
   * `isInternal` IS READ AND DISCARDED: internal notes ARE indexed, because an agent
   * must be able to find them, and hiding them at index time would make the index a
   * per-role artifact. The authorizer excludes them for a non-agent, which is the
   * boundary that actually holds.
   *
   * The tenant comes from the PARENT TICKET — `TicketComment` has no `tenantId`, so
   * without this join the row would be stamped null and become visible to
   * tenant-less callers.
   *
   * `createdAt` is the source timestamp: a comment is immutable, so there is no
   * `updatedAt` to use.
   */
  private async projectTicketComments(cursor: string | undefined): Promise<Projection[]> {
    const rows = await this.prisma.ticketComment.findMany({
      ...this.page(cursor),
      select: {
        id: true,
        body: true,
        createdAt: true,
        ticket: { select: { tenantId: true } },
      },
    });

    return rows.map((row) => ({
      sourceType: 'TICKET_COMMENT' as const,
      sourceId: row.id,
      tenantId: row.ticket.tenantId,
      searchText: buildSearchText([row.body]),
      sourceUpdatedAt: row.createdAt,
    }));
  }

  /**
   * SURVEY — `title` and `description`.
   *
   * DRAFTS ARE INDEXED, deliberately: a manager must be able to find their own
   * unpublished questionnaire. The publication rule is applied by the authorizer, so
   * a participant never sees a draft.
   *
   * `SurveyQuestion.text` is NOT projected — the schema comment defers it, and
   * question text is answer-adjacent content whose exposure rules are unsettled.
   */
  private async projectSurveys(cursor: string | undefined): Promise<Projection[]> {
    const rows = await this.prisma.survey.findMany({
      ...this.page(cursor),
      select: { id: true, tenantId: true, title: true, description: true, updatedAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'SURVEY' as const,
      sourceId: row.id,
      tenantId: row.tenantId,
      searchText: buildSearchText([row.title, row.description]),
      sourceUpdatedAt: row.updatedAt,
    }));
  }

  /**
   * MESSAGE — `body` only.
   *
   * The tenant comes from the CONVERSATION, which is the only place messaging stores
   * one; `Message` has no `tenantId` column. `senderId` and `conversationId` are not
   * projected — membership is re-checked by the authorizer against the live
   * `ConversationMember` rows, which is the only correct source for it.
   */
  private async projectMessages(cursor: string | undefined): Promise<Projection[]> {
    const rows = await this.prisma.message.findMany({
      ...this.page(cursor),
      select: {
        id: true,
        body: true,
        createdAt: true,
        conversation: { select: { tenantId: true } },
      },
    });

    return rows.map((row) => ({
      sourceType: 'MESSAGE' as const,
      sourceId: row.id,
      tenantId: row.conversation.tenantId,
      searchText: buildSearchText([row.body]),
      sourceUpdatedAt: row.createdAt,
    }));
  }

  /**
   * CONVERSATION — the group `name` only.
   *
   * `WHERE name IS NOT NULL` excludes DIRECT conversations by construction: a 1:1
   * conversation has no stored name (the UI titles it after the other participant), so
   * a projection row for one would violate the `searchText_nonblank` CHECK. Filtering
   * on `type` instead would rely on a correlation the schema does not guarantee.
   */
  private async projectConversations(cursor: string | undefined): Promise<Projection[]> {
    const rows = await this.prisma.conversation.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        name: { not: null },
      },
      orderBy: { id: 'asc' },
      take: INDEX_BATCH_SIZE,
      select: { id: true, tenantId: true, name: true, updatedAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'CONVERSATION' as const,
      sourceId: row.id,
      tenantId: row.tenantId,
      searchText: buildSearchText([row.name]),
      sourceUpdatedAt: row.updatedAt,
    }));
  }

  /**
   * NOTIFICATION — `title` and `body`.
   *
   * `sourceType`/`sourceId` on the notification are NOT projected: they are an
   * internal back-reference to whatever produced the notification, they are not text
   * a user typed, and indexing them would let a user find rows by guessing internal
   * identifiers.
   */
  private async projectNotifications(cursor: string | undefined): Promise<Projection[]> {
    const rows = await this.prisma.notification.findMany({
      ...this.page(cursor),
      select: { id: true, tenantId: true, title: true, body: true, createdAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'NOTIFICATION' as const,
      sourceId: row.id,
      tenantId: row.tenantId,
      searchText: buildSearchText([row.title, row.body]),
      sourceUpdatedAt: row.createdAt,
    }));
  }

  /**
   * REMINDER — `title` and `note`.
   *
   * DISABLED AND ALREADY-DELIVERED REMINDERS ARE INDEXED. `enabled` governs whether
   * the dispatcher fires it and `deliveredAt` records that it fired; neither says the
   * reminder should become unfindable to the person who wrote it.
   */
  private async projectReminders(cursor: string | undefined): Promise<Projection[]> {
    const rows = await this.prisma.reminder.findMany({
      ...this.page(cursor),
      select: { id: true, tenantId: true, title: true, note: true, updatedAt: true },
    });

    return rows.map((row) => ({
      sourceType: 'REMINDER' as const,
      sourceId: row.id,
      tenantId: row.tenantId,
      searchText: buildSearchText([row.title, row.note]),
      sourceUpdatedAt: row.updatedAt,
    }));
  }

  /**
   * USER — the DIRECTORY allowlist and nothing else.
   *
   * `firstName`, `lastName`, `jobTitle`, `department`, `extension`, `email`, `phone` —
   * the same fields `DirectoryService` already exposes to a same-tenant colleague.
   *
   * NEVER: `passwordHash`, `tokenVersion`, `status`, `emailVerified`, `avatarUrl`,
   * `managerId`, or any token table. Those are E-class or authorization data.
   *
   * `email` and `phone` ARE indexed — searching for a colleague by email address is a
   * primary directory use case — but the authorizer's `snippetFields` deliberately
   * exclude them, so they are findable without a result becoming a contact-detail
   * dump.
   *
   * Only users WITH a tenant are projected: `DirectoryService` throws for a
   * tenant-less caller, so a tenant-less user has no directory to appear in and a
   * row for them could never be authorized.
   */
  private async projectUsers(cursor: string | undefined): Promise<Projection[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        ...(cursor ? { id: { gt: cursor } } : {}),
        tenantId: { not: null },
      },
      orderBy: { id: 'asc' },
      take: INDEX_BATCH_SIZE,
      select: {
        id: true,
        tenantId: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        department: true,
        extension: true,
        email: true,
        phone: true,
        updatedAt: true,
      },
    });

    return rows.map((row) => ({
      sourceType: 'USER' as const,
      sourceId: row.id,
      tenantId: row.tenantId,
      searchText: buildSearchText([
        row.firstName,
        row.lastName,
        row.jobTitle,
        row.department,
        row.extension,
        row.email,
        row.phone,
      ]),
      sourceUpdatedAt: row.updatedAt,
    }));
  }

  /**
   * Writes one batch and returns how many rows got an embedding.
   *
   * The blank-skip rule lives in the writer (one implementation for both write
   * paths); everything else about this call — sequential, bounded, latch-reset per
   * pass — is unchanged from 49J.
   */
  private async writeBatch(batch: readonly Projection[]): Promise<number> {
    const result = await this.writer.write(
      batch.map((row) => ({ ...row, sourceKey: PLATFORM_SOURCE_KEY }))
    );

    return result.embedded;
  }

  /**
   * Removes the projection of a deleted source row.
   *
   * Idempotent, and never an error when the row is absent — a cache entry that is
   * already gone is the desired state. Not strictly required for correctness (the
   * authorizer drops candidates whose authoritative row has vanished), but it keeps the
   * index from growing without bound.
   *
   * `PLATFORM_SOURCE_KEY` — the platform's own rows are keyed by `sourceType`
   * alone; the empty `sourceKey` is what the writer's delete expects for them.
   */
  async remove(sourceType: PlatformSearchSourceType, sourceId: string): Promise<void> {
    await this.writer.remove(sourceType, PLATFORM_SOURCE_KEY, [sourceId]);
  }
}

/**
 * `SearchDocument.sourceKey` for the platform's OWN sources.
 *
 * Empty — identity is `sourceType` alone — and spelled out rather than left to the
 * column default, so every platform write states which namespace it belongs to
 * exactly as every external write states its registered key.
 */
const PLATFORM_SOURCE_KEY = '';

/**
 * Rebuild order. Explicit rather than `Object.values(...)` over the generated enum,
 * so adding an enum member is a compile error here until someone writes its
 * projection. `EXTERNAL` is deliberately not in this list: external rows are
 * contributed through the platform search source port and never rebuilt from Core
 * tables, because this process cannot read their databases.
 */
const SEARCH_SOURCE_ORDER: readonly PlatformSearchSourceType[] = [
  'TICKET',
  'TICKET_COMMENT',
  'SURVEY',
  'MESSAGE',
  'CONVERSATION',
  'NOTIFICATION',
  'REMINDER',
  'USER',
];
