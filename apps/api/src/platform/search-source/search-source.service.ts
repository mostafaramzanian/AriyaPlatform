import { Injectable, Logger } from '@nestjs/common';
import { buildSearchText } from '../../search/persian-normalize';
import {
  EXTERNAL_SEARCH_SOURCE_TYPE,
  SEARCH_WEIGHT_CLASS_FACTORS,
  MAX_MERGED_CANDIDATES,
} from '../../search/search.constants';
import { SearchDocumentWriter, type IndexableSearchDocument } from './search-document.writer';
import {
  SearchSourceRegistrationError,
  composeRouteHref,
  externalCandidateKey,
  validateSearchProjectionBatch,
  validateSearchSourceAdapter,
  validateSearchSourceAuthorizationResult,
  validateSearchSourceRemovalIds,
  type AuthorizedExternalSearchSource,
  type RegisteredSearchSource,
  type SearchProjectionRecord,
  type SearchSourceActorContext,
  type SearchSourceAdapter,
  type SearchSourceDescriptor,
  type SearchSourcePort,
  type SearchSourceProjectionResult,
  type SearchSourceRemovalResult,
} from './search-source.contract';

/**
 * Phase P-SEARCH-SOURCE: the platform's search source registry, the ingestion
 * boundary, and the query-time authorization dispatcher — one object, because all
 * three answer questions about the same fact ("which sources are registered in
 * this process"), and splitting them would create two places where that fact can
 * disagree with itself.
 *
 * WHO CALLS WHAT
 * --------------
 *  - A bounded context calls `register(adapter)` once, at composition time, and
 *    uses the returned handle to submit projections and removals. It never sees
 *    Core persistence: the writer it ultimately reaches is inside this module.
 *  - The query path (`SearchService`) calls `weightMultiplier` for ranking and
 *    `authorize` for the candidacy of `EXTERNAL` rows — one batched call per
 *    source, never one per row.
 *
 * WHAT THIS CLASS REFUSES TO DO
 * -----------------------------
 *  - It never reads a source's database. There is no Prisma handle here except the
 *    one held by `SearchDocumentWriter`, which writes the PLATFORM's index.
 *  - It never interprets a source's text. Normalization is `buildSearchText`, the
 *    platform's one pipeline; ranking is `search-ranking`; snippets are built by
 *    the caller from the fields a source returns AFTER authorization.
 *  - It never lets a failure become a partial answer: an adapter that throws, or a
 *    result that fails validation, yields NO rows for that source — logged with
 *    its source key, fail-closed, while every other source and every platform
 *    source keep their results.
 */
@Injectable()
export class SearchSourceService implements SearchSourcePort {
  private readonly logger = new Logger(SearchSourceService.name);

  /**
   * Registered sources, keyed by source key. A `Map` (not an object literal) so
   * every lookup is prototype-safe by construction — the hazard
   * `ProvisioningProviderRegistry` documents for `'constructor'`-style keys
   * cannot arise here.
   */
  private readonly sources = new Map<string, RegisteredSource>();

  constructor(private readonly writer: SearchDocumentWriter) {}

  /**
   * Registers a source. See `SearchSourcePort.register`: this THROWS a typed
   * `SearchSourceRegistrationError` for a malformed descriptor or a duplicate key,
   * because registration is composition — the caller is the code that must fix it,
   * and starting with a half-registered source would be a silent state.
   */
  register(adapter: SearchSourceAdapter): RegisteredSearchSource {
    const validation = validateSearchSourceAdapter(adapter);
    if (!validation.ok) {
      throw new SearchSourceRegistrationError(
        validation.code,
        `Search source rejected: ${validation.code}`
      );
    }

    const { descriptor } = adapter;
    if (this.sources.has(descriptor.key)) {
      throw new SearchSourceRegistrationError(
        'SOURCE_DUPLICATE',
        `Search source ${descriptor.key} is already registered`
      );
    }

    this.sources.set(descriptor.key, { descriptor, adapter });
    this.logger.log(
      `Registered search source ${descriptor.key} (owner ${descriptor.ownerModuleId}, ` +
        `weight ${descriptor.weightClass}, route ${descriptor.routeTemplate})`
    );

    return {
      descriptor,
      project: (records) => this.project(descriptor.key, records),
      remove: (entityIds) => this.remove(descriptor.key, entityIds),
    };
  }

  /** Every registered source, for diagnostics. A copy: callers cannot mutate the registry. */
  list(): SearchSourceDescriptor[] {
    return [...this.sources.values()].map((source) => source.descriptor);
  }

  /**
   * The ranking multiplier of a registered EXTERNAL source, or `null` when the key
   * is not registered in this process.
   *
   * Used as `ExternalSourceWeightResolver` by the merge step, where `null` means
   * "exclude the candidate": a row whose owning source is absent has no
   * authorization rule available either, so it must not surface.
   */
  weightMultiplier(sourceKey: string): number | null {
    const source = this.sources.get(sourceKey);
    if (!source) return null;

    return SEARCH_WEIGHT_CLASS_FACTORS[source.descriptor.weightClass];
  }

  /**
   * Authorizes and hydrates `EXTERNAL` candidates: ONE call per source, batched.
   *
   * GROUPS BY SOURCE KEY, exactly as `SearchAuthorizer` groups by source type, so
   * the whole stage costs one adapter call per contributing source regardless of
   * how many candidates arrived. Ids are deduplicated before the call, so a row
   * found by both retrieval arms costs one id, not two.
   *
   * Every failure path here yields NO rows for that source and a log line that
   * names the source: unknown key, over-bound request, adapter throw, malformed or
   * unvalidatable answer. Nothing in this method can surface a row the source did
   * not explicitly return for an id the platform explicitly asked about.
   */
  async authorize(
    actor: SearchSourceActorContext,
    candidates: ReadonlyArray<{ sourceKey: string; entityId: string }>
  ): Promise<Map<string, AuthorizedExternalSearchSource>> {
    const bySource = new Map<string, string[]>();
    for (const candidate of candidates) {
      const ids = bySource.get(candidate.sourceKey);
      if (ids) ids.push(candidate.entityId);
      else bySource.set(candidate.sourceKey, [candidate.entityId]);
    }

    const groups = await Promise.all(
      [...bySource.entries()].map(([sourceKey, entityIds]) =>
        this.authorizeSource(actor, sourceKey, dedupeIds(entityIds))
      )
    );

    const authorized = new Map<string, AuthorizedExternalSearchSource>();
    for (const group of groups) {
      for (const entry of group) {
        authorized.set(externalCandidateKey(entry.sourceKey, entry.entityId), entry);
      }
    }

    return authorized;
  }

  /**
   * One source's authorization round trip.
   *
   * The request is built HERE from the actor and the ids, so a source can never be
   * asked about an id the platform did not retrieve, and `tenantId` is the
   * TRUSTED actor tenant — never a value that arrived with a projection or with
   * the query string.
   */
  private async authorizeSource(
    actor: SearchSourceActorContext,
    sourceKey: string,
    entityIds: readonly string[]
  ): Promise<AuthorizedExternalSearchSource[]> {
    const source = this.sources.get(sourceKey);
    if (!source) {
      this.logger.warn(
        `Search source ${sourceKey} is not registered in this runtime - ${entityIds.length} candidate(s) dropped`
      );
      return [];
    }

    if (entityIds.length > MAX_MERGED_CANDIDATES) {
      // Unreachable through the query path (candidates are truncated before this
      // stage); a real check, not an assertion, because a future caller could
      // otherwise hand a source an unbounded batch.
      this.logger.error(
        `Search source ${sourceKey} was asked about ${entityIds.length} ids, over the ${MAX_MERGED_CANDIDATES} bound - dropped`
      );
      return [];
    }

    let raw: unknown;
    try {
      raw = await source.adapter.authorize({ actor, entityIds: [...entityIds] });
    } catch (error) {
      // §31 failure semantics, the established search reading: a source that cannot
      // answer contributes nothing, and the search still answers correctly for
      // everything else. The cause is logged for an operator and is NOT exposed in
      // the response.
      this.logger.error(
        `Search source ${sourceKey} authorization failed - its candidates are dropped: ${
          error instanceof Error ? error.message : 'unknown error'
        }`
      );
      return [];
    }

    const validation = validateSearchSourceAuthorizationResult(raw, entityIds);
    if (!validation.ok) {
      this.logger.error(
        `Search source ${sourceKey} returned an invalid authorization result (${validation.code}) - its candidates are dropped`
      );
      return [];
    }

    const entries = (raw as { entries: readonly AuthorizedEntryShape[] }).entries;

    return entries.map((entry) => ({
      sourceKey,
      entityId: entry.entityId,
      title: entry.title,
      snippetFields: entry.snippetFields,
      timestamp: entry.timestamp,
      // The href is composed by the PLATFORM from the registered template; the
      // entity id is URL-encoded, so it cannot alter the path it is placed in.
      navigation: { href: composeRouteHref(source.descriptor.routeTemplate, entry.entityId) },
    }));
  }

  /**
   * The ingestion boundary: validate the whole batch, normalize through the
   * platform pipeline, write through the platform writer.
   *
   * The row this produces is an `EXTERNAL` row whose `sourceKey` is the ONE the
   * handle was bound to — there is no parameter through which a caller could write
   * into another source's namespace, and the platform's own source types are not
   * reachable from this method at all.
   *
   * Tenant: `record.tenantId` is the SOURCE's tenant for that row, taken from the
   * source's own data — not from the searcher's request. It is what the retrieval
   * path filters on, in exact-equality form, and it is a snapshot: the source
   * re-checks the actor at query time through `authorize`, so a stale snapshot
   * cannot leak a row the actor may no longer read.
   */
  private async project(
    sourceKey: string,
    records: readonly SearchProjectionRecord[]
  ): Promise<SearchSourceProjectionResult> {
    const validation = validateSearchProjectionBatch(records);
    if (!validation.ok) {
      // Nothing was written: refusal is whole-batch, so a caller can never
      // half-apply a projection and believe it succeeded.
      return { status: 'rejected', code: validation.code };
    }

    const documents: IndexableSearchDocument[] = [];
    const skipped: string[] = [];

    for (const record of records) {
      const searchText = buildSearchText(record.searchContent);

      if (searchText.length === 0) {
        // Legitimately unmatchable (punctuation-only content): not written, and
        // REPORTED — the `searchText_nonblank` CHECK and the writer would both
        // refuse it, and a silent drop would be a projection the caller believes
        // it made.
        skipped.push(record.entityId);
        continue;
      }

      documents.push({
        sourceType: EXTERNAL_SEARCH_SOURCE_TYPE,
        sourceKey,
        sourceId: record.entityId,
        tenantId: record.tenantId,
        searchText,
        sourceUpdatedAt: record.sourceUpdatedAt,
      });
    }

    // A projection call is its own write pass: the embedding latch resets here, so
    // one unavailable-provider batch does not suppress the next call's attempt.
    this.writer.beginPass();
    const result = await this.writer.write(documents);

    return { status: 'indexed', indexed: result.written, embedded: result.embedded, skipped };
  }

  /**
   * Removes rows from the index. Bound to the handle's source key, idempotent, and
   * a no-op for ids that are not there.
   */
  private async remove(
    sourceKey: string,
    entityIds: readonly string[]
  ): Promise<SearchSourceRemovalResult> {
    const validation = validateSearchSourceRemovalIds(entityIds);
    if (!validation.ok) return { status: 'rejected', code: validation.code };

    const removed = await this.writer.remove(
      EXTERNAL_SEARCH_SOURCE_TYPE,
      sourceKey,
      dedupeIds(entityIds)
    );

    return { status: 'removed', removed };
  }
}

/** What the registry stores per source key. */
interface RegisteredSource {
  descriptor: SearchSourceDescriptor;
  adapter: SearchSourceAdapter;
}

/**
 * The shape inside a validated authorization result. Structurally identical to
 * `SearchSourceAuthorizedEntry`; declared once here so the mapping below does not
 * re-import a type it has already validated at runtime.
 */
interface AuthorizedEntryShape {
  entityId: string;
  title: string;
  snippetFields: readonly string[];
  timestamp: Date;
}

/**
 * Removes duplicates and empty values from an id list, preserving order.
 *
 * Deliberately the same rule (and the same reason) as `dedupeIds` in
 * `user-directory.contract.ts`: a retry that sends the same ids twice must cost
 * one lookup, and order is preserved so a log line reads like the caller's list.
 */
function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }

  return unique;
}


