import { Inject, Injectable, Logger } from '@nestjs/common';
import { Permissions } from '../../../auth/rbac/constants/permissions';
import { PermissionSource } from '../../../platform/auth/permission-source.contract';
import {
  SEARCH_SOURCE_PORT,
  type RegisteredSearchSource,
  type SearchProjectionRecord,
  type SearchSourceActorContext,
  type SearchSourceAdapter,
  type SearchSourceAuthorizationRequest,
  type SearchSourceAuthorizationResult,
  type SearchSourceDescriptor,
  type SearchSourcePort,
  type SearchWeightClass,
} from '../../../platform/search-source/search-source.contract';
import { COMMERCE_MODULE_ID } from '../commerce.constants';
import { PurchaseRepository } from '../purchase/purchase.repository';


/**
 * PHASE C9 (GAP-5): the Commerce Search Source Adapter — Commerce's participation in the
 * PLATFORM's Global Search (`GET /search`), through the P-SEARCH-SOURCE contract and
 * nothing else.
 *
 * WHAT THIS FILE IS, IN ONE SENTENCE. It registers ONE source
 * (`commerce.purchase-document`) with the platform port, it PUSHES the one projection
 * Commerce owns (a purchase document's NUMBER) from the write path that mints it, and it
 * answers the platform's batch authorization question by RE-READING the authoritative
 * Commerce rows through `PurchaseRepository` under the caller's own rule.
 *
 * WHAT IT DELIBERATELY IS NOT
 * ---------------------------
 *  * NOT a second search engine, query API or ranking: there is no `search(...)` here.
 *    Retrieval, normalization, ranking, paging and the result envelope stay in
 *    `src/search/**`, and the projection carries RAW text — the platform's one
 *    `buildSearchText` pipeline normalizes it, so Commerce never re-implements
 *    normalization.
 *  * NOT a Core consumer: this module imports the PORT TOKEN and the contract's types.
 *    There is no Core Prisma, no `SearchDocument`, no `core_db` and no search table
 *    anywhere in this file — the platform's binding is the only writer of the index.
 *  * NOT an authorization cache: the index is not an authorization boundary (the
 *    platform says so and this adapter behaves accordingly), so every candidate is
 *    re-read from `commerce_db` and every answer is derived from the ACTUAL row.
 *  * NOT a route builder: the descriptor carries a TEMPLATE
 *    (`/admin/commerce/purchases/:id`, the real web route), and the platform composes
 *    and URL-encodes the href. Commerce never emits a URL string.
 *  * NOT an entitlement decision point: module policy (`commerce-entitlement.spec.ts`
 *    §14 H) allows entitlement to be referenced only at the module boundary and in a
 *    controller, so this surface does not ask the entitlement question — the HTTP gate
 *    already answers it for the detail route a result navigates to.
 *
 * THE PERMISSION QUESTION, ANSWERED ONCE (C8 §Y.8 / platform §AA.2)
 * ----------------------------------------------------------------
 * "May a caller without `commerce.read` reach a Commerce result?" NO — and that answer
 * is the module's OWN rule, mirrored rather than re-invented: every Commerce read route
 * carries `@Roles(Permissions.COMMERCE_READ)`, so the adapter asks the SAME seam the
 * `RolesGuard` asks (`PermissionSource`), with `claims: null` because the platform's
 * actor context carries no claims — in the combined runtime Core is the authority, which
 * is exactly the guard's legacy-token path. An actor that does not hold `commerce.read`
 * gets NO rows (fail-closed), and NO new permission (`commerce.search` or similar) is
 * invented for search.
 *
 * WHAT IS SEARCHABLE, AND WHY ONLY THAT (C8 §Y.5)
 * -----------------------------------------------
 * A `PurchaseDocument` has exactly one human-facing identifier: `documentNumber`. The
 * requester and supplier are OPAQUE identity references (never a person's name, never a
 * supplier row), the kind and status are enum vocabulary, and the money columns are not
 * text. So `searchContent` is `[documentNumber]` — nothing else — and the authorized
 * result returns the number as the title and as the snippet field, plus the row's own
 * `updatedAt` as the timestamp, all read from the authoritative row at query time.
 *
 * THE WEIGHT CLASS (platform §AA.1 — the choice platform left to this phase)
 * --------------------------------------------------------------------------
 * `PRIMARY`, by the platform's OWN published definitions rather than by preference:
 * 49J reserves the optional multiplier for "low-signal, high-volume" and
 * "machine-generated" text (notifications, reminders) and for labels that `ts_rank_cd`
 * flatters (conversation names), and gives full weight to AUTHORED, INTENTIONAL records
 * (tickets, surveys, messages). A purchase document number is authored, intentional,
 * tenant-scoped and low-volume, and searching it is the literal "where is this record?"
 * question Global Search exists to answer — so it participates at full weight. No
 * number is chosen here and no platform weight is touched: the descriptor names a
 * CLASS, and `SEARCH_WEIGHT_CLASS_FACTORS` maps it to the multiplier 49J already owns.
 *
 * THE LIFECYCLE, AND WHY IT IS THIS SMALL (contract §24)
 * -----------------------------------------------------
 * `projectDocument` is called from the ONE write that creates a document — the only act
 * that can change anything the projection depends on:
 *  * the NUMBER is minted once, inside the create transaction, and no method in this
 *    module can rewrite it (`updateEditableDocument` cannot name the column);
 *  * the TITLE and TIMESTAMP of a result are not read from the index at all — they come
 *    from the authoritative row at authorization time, so an update needs no projection
 *    write to stay truthful;
 *  * the ROUTE is a constant, and READABILITY depends on permission and tenant
 *    membership, none of which the index stores.
 * There is also NO removal path: this database deletes no purchase document ("no
 * lifecycle deletion path exists anywhere in this database" — the schema's own words),
 * so `remove` is deliberately never called and no deletion semantics are invented.
 * A row that disappears anyway (drift, a manual delete) simply fails the authoritative
 * re-read and is dropped — the platform's documented handling of a stale projection.
 *
 * FAILURE SEMANTICS (contract §28)
 * --------------------------------
 * The index is a REBUILDABLE CACHE, so a projection failure must not fail the business
 * write that succeeded: `projectDocument` logs the refusal/failure and returns — the
 * same "never change the answer" rule the audit gateway and the notification gateway
 * follow for their own best-effort outputs. Authorization failures go the OTHER way:
 * a throw here is caught by the platform and drops EVERY candidate from this source
 * (fail-closed), and a missing row/permission/tenant yields no entry — never an
 * unauthorized one.
 */
@Injectable()
export class CommerceSearchSourceService implements SearchSourceAdapter {
  private readonly logger = new Logger(CommerceSearchSourceService.name);

  /**
   * The writer handle `register` returned. Bound to this source's key by the platform,
   * so `project` cannot name another source's namespace even by accident.
   */
  private readonly handle: RegisteredSearchSource;

  /**
   * WHAT COMMERCE DECLARES ABOUT ITSELF, ONCE (`SearchSourceDescriptor`).
   *
   * The key is a STABLE, source-owned identifier in the platform's key grammar
   * (`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$` — the platform's own documented example shape,
   * `commerce.purchase-document`), naming the entity this module owns. It is not a label
   * (labels live in the web client), not user-controlled and not derived from a request.
   * The template is the EXISTING purchase detail route; the platform composes and
   * encodes the href, so this file never builds a URL.
   */
  readonly descriptor: SearchSourceDescriptor = {
    key: COMMERCE_SEARCH_SOURCE_KEY,
    ownerModuleId: COMMERCE_MODULE_ID,
    weightClass: COMMERCE_SEARCH_SOURCE_WEIGHT_CLASS,
    routeTemplate: COMMERCE_SEARCH_SOURCE_ROUTE_TEMPLATE,
  };

  constructor(
    // The port — the ONLY platform dependency of this module's search participation.
    // `register` THROWS on a malformed descriptor or a duplicate key, and the throw is
    // deliberately NOT caught: registration is composition, and a process that cannot
    // register its source must fail at boot rather than start with a silent half-source.
    @Inject(SEARCH_SOURCE_PORT) port: SearchSourcePort,
    private readonly repository: PurchaseRepository,
    // The same seam `RolesGuard` asks for `@Roles(Permissions.COMMERCE_READ)`.
    private readonly permissions: PermissionSource
  ) {
    this.handle = port.register(this);
  }

  /**
   * The platform's ONE batched authorization question, answered from `commerce_db`.
   *
   * ORDER IS THE DESIGN: (1) a tenant-less actor has no Commerce rows to read, and an
   * empty id list has nothing to answer, so neither costs a query; (2) the permission
   * question is asked BEFORE any row is read, because an unreadable candidate must not
   * cause a database read the caller has no licence for; (3) ONE tenant-scoped batch
   * read answers all remaining ids — never a query per candidate.
   */
  async authorize(
    request: SearchSourceAuthorizationRequest
  ): Promise<SearchSourceAuthorizationResult> {
    const { actor, entityIds } = request;

    if (actor.tenantId === null || entityIds.length === 0) {
      return { entries: [] };
    }

    if (!(await this.canRead(actor))) {
      return { entries: [] };
    }

    const rows = await this.repository.findDocumentSearchRowsByIds(actor.tenantId, entityIds);

    // Requested order, one entry per id, absent ids simply absent. Deduplicated because
    // the platform refuses a duplicate `entityId` for the WHOLE answer: a repeated id
    // must not be able to make every Commerce row unauthorized.
    const seen = new Set<string>();
    const entries = [];

    for (const entityId of entityIds) {
      if (seen.has(entityId)) continue;
      seen.add(entityId);

      const row = rows.get(entityId);
      if (!row) continue; // Stale projection, another tenant's id, or a row that is gone.

      entries.push({
        entityId,
        title: row.documentNumber,
        snippetFields: [row.documentNumber],
        timestamp: row.updatedAt,
      });
    }

    return { entries };
  }

  /**
   * Pushes (or refreshes) one document's search projection through the registered
   * handle. Called by `PurchaseService.create` — the one write that can change anything
   * the projection carries (see the file header's lifecycle note).
   *
   * NEVER THROWS, and never reports success it did not have: a refusal, a skip and a
   * storage failure are each logged with the document id, and the business write that
   * already committed stands. The projection is a cache; the ROW is the truth, and the
   * authoritative re-read is what the platform trusts at query time.
   */
  async projectDocument(document: SearchablePurchaseDocument): Promise<void> {
    try {
      const result = await this.handle.project([purchaseSearchProjection(document)]);

      if (result.status === 'rejected') {
        this.logger.error(
          `Search projection refused for purchase document ${document.id}: ${result.code}`
        );
        return;
      }

      if (result.skipped.length > 0) {
        this.logger.warn(
          `Search projection skipped purchase document ${document.id}: nothing indexable`
        );
      }
    } catch (error) {
      this.logger.error(
        `Search projection failed for purchase document ${document.id}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`
      );
    }
  }

  /** `commerce.read`, the module's own read rule — asked through the platform's seam. */
  private async canRead(actor: SearchSourceActorContext): Promise<boolean> {
    const permissions = await this.permissions.getEffectivePermissions(actor.userId, null);
    return permissions.includes(Permissions.COMMERCE_READ);
  }
}


/**
 * The stable source key. Exported because the WEB label map is keyed by it (as a literal
 * there, like every other client-side identifier: `SEARCH_EXTERNAL_SOURCE_LABELS`) and
 * the tests compare the two — a rename must fail a test, not silently unlabel a result.
 * It is a key, never a label.
 */
export const COMMERCE_SEARCH_SOURCE_KEY = 'commerce.purchase-document';

/**
 * The EXISTING purchase detail route (`apps/web/src/app/admin/commerce/purchases/[id]`).
 * A template with exactly one `:id` placeholder; the platform validates it at
 * registration and substitutes a URL-encoded id — Commerce supplies no href.
 */
export const COMMERCE_SEARCH_SOURCE_ROUTE_TEMPLATE = '/admin/commerce/purchases/:id';

/**
 * The ranking CLASS this source participates under. See the file header: 49J's own
 * definitions put an authored, intentional, low-volume business identifier at full
 * weight. The numeric value is the platform's (`SEARCH_WEIGHT_CLASS_FACTORS`).
 */
export const COMMERCE_SEARCH_SOURCE_WEIGHT_CLASS: SearchWeightClass = 'PRIMARY';

/**
 * One document as the projection needs it — the narrow structural shape
 * `PurchaseRepository.createDocument` already returns, so the caller passes the row it
 * wrote without this module widening its repository contract.
 */
export interface SearchablePurchaseDocument {
  readonly id: string;
  readonly tenantId: string;
  readonly documentNumber: string;
  readonly updatedAt: Date;
}

/**
 * The projection record, built from the row VERBATIM — pure, exported and testable.
 *
 * `searchContent` is `[documentNumber]` and nothing else: no supplier id, no requester
 * id, no currency, no amounts, no status. Raw text on purpose — the platform normalizes
 * it through the one pipeline, so no Commerce-side normalization (Persian digits, trim,
 * case) exists to drift from the query path's.
 */
export function purchaseSearchProjection(
  document: SearchablePurchaseDocument
): SearchProjectionRecord {
  return {
    entityId: document.id,
    tenantId: document.tenantId,
    searchContent: [document.documentNumber],
    sourceUpdatedAt: document.updatedAt,
  };
}

