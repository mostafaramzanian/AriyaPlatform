/**
 * Phase P-SEARCH-SOURCE: the PLATFORM SEARCH SOURCE contract.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Global Search (49J) indexes `core_db."SearchDocument"` and re-reads every
 * candidate from its authoritative table before returning it. Both halves of that
 * sentence are Core's own: the projection writer reads Core tables, the authorizer
 * reads Core tables. An independent bounded context (Commerce first) owns its data
 * in ANOTHER database and — by design — has no Core Prisma handle, so neither half
 * can be extended to reach it. This contract is the missing boundary: the small,
 * typed seam through which such a context CONTRIBUTES searchable projections and
 * through which the platform, at query time, asks that context whether the current
 * actor may see an entity.
 *
 * THE DIRECTION OF THE DEPENDENCY
 * -------------------------------
 * The port is declared HERE, outside both Core and the contributing module. A
 * bounded context imports the TOKEN (`SEARCH_SOURCE_PORT`) and this file's types;
 * it never imports Core's Prisma service, the `SearchDocument` model, or this
 * database. The platform binding (`SearchSourceService`) is the only writer of
 * external rows, and it is the only side that touches Core persistence. The same
 * idiom `platform/audit/audit.contract.ts` and
 * `platform/user-directory/user-directory.contract.ts` already established.
 *
 * WHAT THIS CONTRACT MUST NOT BECOME
 * ----------------------------------
 *  - NOT a generic query API. There is no `search(...)`, no predicate, no
 *    `findMany(options)`. A source pushes PROJECTIONS and answers BATCH
 *    authorization questions about ids the platform already retrieved.
 *  - NOT a second search engine. Retrieval, normalization, ranking, paging and the
 *    result envelope stay exactly where they are (`src/search/**`); only storage of
 *    the projection and authorization truth change hands.
 *  - NOT a way to inject a route, a weight or an arbitrary object. The descriptor
 *    carries a route TEMPLATE that the platform validates and composes (the entity
 *    id is URL-encoded by the platform, never concatenated by the source), a
 *    weight CLASS whose numeric value is a platform constant, and every object
 *    crossing the boundary is validated key-by-key against a closed allowlist —
 *    unknown keys are REJECTED, not ignored, which is what makes "no arbitrary
 *    projection object" a property of the code rather than a promise.
 *
 * WHO OWNS WHAT (the answer this file fixes)
 * ------------------------------------------
 *   Platform owns: the index (`SearchDocument`), normalization
 *                  (`buildSearchText`), retrieval, ranking, paging, the result
 *                  envelope, source registration, and the authorization
 *                  ORCHESTRATION (which source is asked, in one batch, once).
 *   Source owns:   the entity, its text fields, its route destination, and whether
 *                  a given actor may read a given row (its own rule, evaluated
 *                  against its own database — the platform never copies it).
 */

import {
  EXTERNAL_SEARCH_SOURCE_TYPE,
  INDEX_BATCH_SIZE,
  MAX_MERGED_CANDIDATES,
  SEARCH_WEIGHT_CLASSES,
  type SearchWeightClass,
} from '../../search/search.constants';

/**
 * DI token for the port. A string token, matching `AUDIT_PORT` / `USER_DIRECTORY`
 * rather than introducing a Symbol idiom used nowhere else in this repository.
 */
export const SEARCH_SOURCE_PORT = 'SearchSourcePort';

/**
 * Re-exported so a contributing module imports its whole vocabulary from ONE file.
 * Defined in `search.constants.ts`, where the weights themselves live, because the
 * weight CLASS is a ranking concept: `PRIMARY` and `SUPPORTING` map to the two
 * multipliers the platform already owns.
 */
export type { SearchWeightClass };

/** Longest accepted source key. A key is an identifier, not a sentence. */
export const MAX_SEARCH_SOURCE_KEY_LENGTH = 64;

/**
 * The source-key grammar: lowercase, dot- or hyphen-separated words, e.g.
 * `commerce.purchase-document`.
 *
 * STABLE AND NOT USER-CONTROLLED. The key is chosen by the contributing module at
 * composition time, appears in `SearchDocument.sourceKey`, and — because it is the
 * namespace the source's entity ids live in — must not collide or drift. It is
 * deliberately NOT the human label: labels live in the web client's
 * `SEARCH_SOURCE_LABELS`, exactly where the eight existing sources' labels live,
 * and re-using a label as a key would freeze presentation into storage.
 */
export const SEARCH_SOURCE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** The module-platform id of the owning bounded context, e.g. `commerce`. */
export const MAX_SEARCH_OWNER_MODULE_ID_LENGTH = 64;
export const SEARCH_OWNER_MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Longest accepted route template. Every template corresponds to a real page in
 * `apps/web/src/app`; a template longer than this is not a route.
 */
export const MAX_SEARCH_ROUTE_TEMPLATE_LENGTH = 128;

/**
 * The route-template grammar: an app-absolute path whose LAST segment may be the
 * placeholder `:id`. No scheme, no `//`, no query string, no fragment — the
 * alternatives are what would let a source inject a URL rather than name a page,
 * and they fail here.
 */
export const SEARCH_ROUTE_TEMPLATE_PATTERN =
  /^\/(?:[A-Za-z0-9._-]+\/)*(?:[A-Za-z0-9._-]+|:id)$/;

/** The one placeholder the platform substitutes. Case-sensitive, final segment only. */
export const SEARCH_ROUTE_ID_PLACEHOLDER = ':id';

/** Longest accepted entity id. Ids are opaque; a longer one is not an id. */
export const MAX_SEARCH_ENTITY_ID_LENGTH = 128;

/**
 * Entity-id grammar: non-empty, no whitespace, no control characters.
 *
 * `\S` excludes every Unicode whitespace character (` `, TAB, CR, LF, NBSP, …) and
 * the explicit class excludes C0/C1 controls and DEL, so an id can never carry a
 * newline into a log line, a query string or a route.
 */
export const SEARCH_ENTITY_ID_PATTERN = /^[^\s\p{Cc}]{1,128}$/u;

/**
 * Longest accepted tenant id. Same opaque-id rule; `null` is a real bucket
 * (a tenant-less source row), not "any tenant" — the projection mirrors
 * `SearchRepository`'s exact-equality predicate, which reads `IS NULL` for a
 * null-tenant caller and `= tenant` otherwise.
 */
export const MAX_SEARCH_TENANT_ID_LENGTH = 128;

/** Longest accepted result title. A title is a label, not a body. */
export const MAX_SEARCH_RESULT_TITLE_LENGTH = 200;

/**
 * How many text fields one projection record may carry, and how long each may be.
 *
 * DELIBERATELY SMALL. The projection exists to make identifiers and short human
 * labels findable (a document number, a version label) — not to index documents.
 * The bound is also the index's memory bound: the platform normalizes and stores
 * this text in `searchText`, so an unbounded part is an unbounded row.
 */
export const MAX_SEARCH_CONTENT_FIELDS = 8;
export const MAX_SEARCH_CONTENT_FIELD_LENGTH = 2000;

/**
 * Same shape for the SNIPPET fields a source returns AFTER authorization.
 *
 * The snippet builder reads at most `SNIPPET_LENGTH` (160) characters with a
 * 40-character lead, so 2000 is generous headroom, not a display limit; the bound
 * exists so one authorized result cannot make the platform hold an unbounded
 * string in memory.
 */
export const MAX_SEARCH_SNIPPET_FIELDS = 4;
export const MAX_SEARCH_SNIPPET_FIELD_LENGTH = 2000;

/**
 * The batch bounds, both re-used from the search capability rather than re-typed:
 * a projection batch is one indexer batch (`INDEX_BATCH_SIZE`), and one
 * authorization call can never exceed the merged-candidate cap — the retrieval
 * stage truncates to `MAX_MERGED_CANDIDATES` BEFORE authorization runs, so this is
 * a defensive assertion of an established invariant, not a new limit.
 */
export const MAX_SEARCH_PROJECTION_BATCH = INDEX_BATCH_SIZE;
export const MAX_SEARCH_AUTHORIZATION_BATCH = MAX_MERGED_CANDIDATES;

/**
 * Why a value crossing this boundary was not accepted.
 *
 * A CLOSED SET, and every member names a DIFFERENT operator action: an invalid
 * key means the source is mis-named, a duplicate key means two registrations
 * disagree, a shape violation means a caller is smuggling a field, an id outside
 * the requested set means a source is inventing authorization. Collapsing these
 * into one "invalid" code would make the log line useless at the moment it is
 * needed — the same reasoning `AuditRejectionCode` records.
 */
export type SearchSourceRejectionCode =
  | 'SOURCE_KEY_INVALID'
  | 'SOURCE_OWNER_INVALID'
  | 'SOURCE_WEIGHT_CLASS_INVALID'
  | 'SOURCE_ROUTE_TEMPLATE_INVALID'
  | 'SOURCE_DUPLICATE'
  | 'PROJECTION_BATCH_INVALID'
  | 'PROJECTION_SHAPE_INVALID'
  | 'PROJECTION_ENTITY_ID_INVALID'
  | 'PROJECTION_TENANT_INVALID'
  | 'PROJECTION_CONTENT_INVALID'
  | 'PROJECTION_TIMESTAMP_INVALID'
  | 'REMOVAL_IDS_INVALID'
  | 'AUTHORIZATION_RESULT_INVALID';

/** The result of a pure validation. Validators never throw. */
export type SearchSourceValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SearchSourceRejectionCode };

/**
 * What a contributing module declares about itself, ONCE, at composition time.
 *
 * Four fields, and each is required by code that exists:
 *   `key`         — the namespace of its rows and the dispatch key at query time;
 *   `ownerModuleId` — which module a registered source belongs to, so a failure
 *                   can name an owner (module-platform ids, e.g. `commerce`);
 *   `weightClass` — which of the platform's TWO existing ranking multipliers the
 *                   source participates under (see `search.constants.ts`);
 *   `routeTemplate` — the page an authorized result navigates to. A template,
 *                   never a concrete URL: the platform composes the href and
 *                   URL-encodes the entity id itself.
 *
 * NOT here, deliberately: a display label (labels live in the web client, where
 * the eight existing sources' labels live), a numeric weight (a value the source
 * may not choose), an entity-type vocabulary (the platform does not model another
 * module's business fields), and a version (the contract is validated on every
 * crossing, so an incompatible projection fails closed rather than drifting).
 */
export interface SearchSourceDescriptor {
  readonly key: string;
  readonly ownerModuleId: string;
  readonly weightClass: SearchWeightClass;
  readonly routeTemplate: string;
}

/**
 * One entity the source wants searchable.
 *
 * `searchContent` is the RAW text fields the source has decided are searchable —
 * typically identifiers and short human labels. The PLATFORM joins and normalizes
 * them through its one pipeline (`buildSearchText` → `normalizeSearchText`); a
 * source never normalizes text itself, so a second normalization implementation
 * cannot exist, and the query path cannot disagree with the index about what a
 * word is.
 *
 * There is NO title here. A title is content, and the index stores no raw content:
 * presentation data is returned at AUTHORIZATION time, for rows the actor may
 * actually read. Storing it would make the index a second, less-guarded copy of
 * private text — the same rule `SearchDocument` documents as "NO RAW TEXT".
 */
export interface SearchProjectionRecord {
  readonly entityId: string;
  /** `null` is a real bucket (a tenant-less source row), never "any tenant". */
  readonly tenantId: string | null;
  readonly searchContent: readonly string[];
  /** The source row's own `updatedAt` (or `createdAt` when immutable). */
  readonly sourceUpdatedAt: Date;
}

/**
 * The authenticated actor, resolved SERVER-SIDE by the platform.
 *
 * Built from the request context and nothing else — no query parameter, header or
 * body field can state an actor or a tenant. A source must treat `tenantId` as
 * the tenant boundary and evaluate `userId` against ITS OWN rules; the platform
 * never tells a source what its authorization is.
 */
export interface SearchSourceActorContext {
  readonly userId: string;
  readonly tenantId: string | null;
}

/**
 * A batch authorization question about ids the platform ALREADY retrieved.
 *
 * BATCHED BY CONSTRUCTION: the platform groups candidates by source and issues
 * ONE call per source — never one call per row (the phase brief's no-N+1 rule,
 * mirrored all the way from `SearchAuthorizer`, which groups by source type for
 * the same reason).
 */
export interface SearchSourceAuthorizationRequest {
  readonly actor: SearchSourceActorContext;
  readonly entityIds: readonly string[];
}

/**
 * One authorized result's presentation data.
 *
 * A source returns an entry ONLY for an entity the actor may read; an entity it
 * omits is silently dropped by the platform — omitted is the shape of
 * "unauthorized", exactly as `SearchAuthorizer` drops a candidate whose
 * authoritative row is gone. `snippetFields` are plain text (never HTML), read
 * from the source's own row at authorization time; the platform builds the
 * snippet and the match offsets from them with the SAME builder every platform
 * source uses.
 */
export interface SearchSourceAuthorizedEntry {
  readonly entityId: string;
  readonly title: string;
  readonly snippetFields: readonly string[];
  readonly timestamp: Date;
}

/** A source's answer. A subset of the requested ids, or empty. */
export interface SearchSourceAuthorizationResult {
  readonly entries: readonly SearchSourceAuthorizedEntry[];
}

/**
 * What a bounded context implements and registers.
 *
 * ONE method, and that is the whole interactive surface: the platform asks about
 * ids, the source answers with the rows it permits. Projection submission is not
 * a callback the source implements — it is a call the source MAKES on the handle
 * `register` returns (see `RegisteredSearchSource`), which is what binds writes to
 * the registered key and makes a cross-namespace write structurally impossible.
 */
export interface SearchSourceAdapter {
  readonly descriptor: SearchSourceDescriptor;
  authorize(request: SearchSourceAuthorizationRequest): Promise<SearchSourceAuthorizationResult>;
}

/**
 * What one `project(...)` call did.
 *
 * `skipped` lists records whose content normalized to nothing: they are
 * legitimately unmatchable (a field of punctuation), so they are not written —
 * the same rule the indexer applies and the `searchText_nonblank` CHECK enforces —
 * and they are REPORTED rather than silently dropped.
 *
 * A rejected call wrote NOTHING. Validation is whole-batch, before any write:
 * a batch containing one malformed record is refused in full, so a caller can
 * never half-apply a projection and believe it succeeded.
 */
export type SearchSourceProjectionResult =
  | {
      readonly status: 'indexed';
      readonly indexed: number;
      readonly embedded: number;
      readonly skipped: readonly string[];
    }
  | { readonly status: 'rejected'; readonly code: SearchSourceRejectionCode };

/** What one `remove(...)` call did. Idempotent: removing absent rows is `removed: 0`. */
export type SearchSourceRemovalResult =
  | { readonly status: 'removed'; readonly removed: number }
  | { readonly status: 'rejected'; readonly code: SearchSourceRejectionCode };

/**
 * The writer handle `register` returns — BOUND to one source key.
 *
 * The key is not a parameter of `project`/`remove`, and that is the point: a
 * registered source physically cannot write into another source's namespace
 * (`project` cannot name someone else's key) and cannot reach a platform source's
 * rows at all (the platform's own sources are written by the indexer, never
 * through this port). Every call is validated and answered; none throws for bad
 * DATA — a throw here would be a storage failure, not a refusal.
 */
export interface RegisteredSearchSource {
  readonly descriptor: SearchSourceDescriptor;
  project(records: readonly SearchProjectionRecord[]): Promise<SearchSourceProjectionResult>;
  remove(entityIds: readonly string[]): Promise<SearchSourceRemovalResult>;
}

/** The port a bounded context depends on. */
export interface SearchSourcePort {
  /**
   * Registers a source and returns its writer handle.
   *
   * THROWS `SearchSourceRegistrationError` — rather than returning a refusal —
   * because this is a COMPOSITION call made once at startup by the same code that
   * must fix it: a malformed descriptor or a duplicate key means the process was
   * assembled wrong, and starting up with a source half-registered would be a
   * silent, unsearchable state. Registration is application composition, not an
   * end-user operation: there is no HTTP route for it and no permission.
   */
  register(adapter: SearchSourceAdapter): RegisteredSearchSource;
}

/** The typed registration failure. Carries one closed rejection code. */
export class SearchSourceRegistrationError extends Error {
  constructor(
    readonly code: SearchSourceRejectionCode,
    message?: string
  ) {
    super(message ?? code);
    this.name = 'SearchSourceRegistrationError';
  }
}

/**
 * One authorized EXTERNAL row, as the query path consumes it.
 *
 * `navigation` is composed by the platform from the registered template — never
 * returned by the source — so a result can never point anywhere the descriptor
 * did not name at registration time.
 */
export interface AuthorizedExternalSearchSource {
  readonly sourceKey: string;
  readonly entityId: string;
  readonly title: string;
  readonly snippetFields: readonly string[];
  readonly timestamp: Date;
  readonly navigation: { readonly href: string };
}

/**
 * The candidate identity of an external row: (`sourceKey`, `entityId`) under the
 * `EXTERNAL` marker — the same triple the unique index keys on, spelled the way
 * the merge and dispatch code needs it.
 *
 * Separate from `candidateKey(sourceType, sourceId)` in `search-ranking.ts` on
 * purpose: that function's shape is pinned by its spec and by every platform
 * source, and an external row's identity is NOT `(sourceType, sourceId)` — two
 * sources may both hold `abc`.
 */
export function externalCandidateKey(sourceKey: string, entityId: string): string {
  return `${EXTERNAL_SEARCH_SOURCE_TYPE}:${sourceKey}:${entityId}`;
}

/**
 * Composes a result's href from the REGISTERED template and an entity id.
 *
 * The template is validated at registration (`SEARCH_ROUTE_TEMPLATE_PATTERN` plus
 * the dot-segment rule in `validateSearchSourceRouteTemplate`), and the id is
 * URL-ENCODED here, by the platform — so `/`, `?`, `#` and every other
 * path-significant character an id might contain becomes opaque text rather than
 * structure. A source never builds a URL; it names a page once and the platform
 * fills in one encoded segment.
 */
export function composeRouteHref(template: string, entityId: string): string {
  const at = template.lastIndexOf(SEARCH_ROUTE_ID_PLACEHOLDER);
  if (at === -1) return template;

  return (
    template.slice(0, at) +
    encodeURIComponent(entityId) +
    template.slice(at + SEARCH_ROUTE_ID_PLACEHOLDER.length)
  );
}

/** A plain object: not null, not an array, prototype `Object.prototype` or `null`. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * True when `value` carries no key outside `allowed`.
 *
 * THE ALLOWLIST IS ENFORCED, NOT ASSUMED, and that is what turns "do not index
 * secrets" and "no arbitrary projection object" into properties of the boundary:
 * an extra field is a REJECTION code, not something silently dropped, so a source
 * that tries to smuggle a credential, an audit blob or an entity snapshot learns
 * about it at the call it made rather than discovering it in a JSON response
 * months later.
 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isValidEntityId(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value !== '.' &&
    value !== '..' &&
    SEARCH_ENTITY_ID_PATTERN.test(value) &&
    value.length <= MAX_SEARCH_ENTITY_ID_LENGTH
  );
}

function isValidTenantId(value: unknown): value is string | null {
  if (value === null) return true;
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SEARCH_TENANT_ID_LENGTH &&
    SEARCH_ENTITY_ID_PATTERN.test(value)
  );
}

function isValidTimestamp(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Validates one descriptor.
 *
 * Pure and exported: the registry calls it, but the spec pins it directly, and a
 * contributing module's own tests can call it without booting Nest — the same
 * reason `validateAuditReadQuery` is a plain function.
 */
export function validateSearchSourceDescriptor(descriptor: unknown): SearchSourceValidation {
  if (!isPlainRecord(descriptor)) return { ok: false, code: 'SOURCE_KEY_INVALID' };
  if (!hasOnlyKeys(descriptor, ['key', 'ownerModuleId', 'weightClass', 'routeTemplate'])) {
    return { ok: false, code: 'SOURCE_KEY_INVALID' };
  }

  const { key, ownerModuleId, weightClass, routeTemplate } = descriptor;

  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_SEARCH_SOURCE_KEY_LENGTH ||
    !SEARCH_SOURCE_KEY_PATTERN.test(key)
  ) {
    return { ok: false, code: 'SOURCE_KEY_INVALID' };
  }

  if (
    typeof ownerModuleId !== 'string' ||
    ownerModuleId.length === 0 ||
    ownerModuleId.length > MAX_SEARCH_OWNER_MODULE_ID_LENGTH ||
    !SEARCH_OWNER_MODULE_ID_PATTERN.test(ownerModuleId)
  ) {
    return { ok: false, code: 'SOURCE_OWNER_INVALID' };
  }

  if (
    typeof weightClass !== 'string' ||
    !(SEARCH_WEIGHT_CLASSES as readonly string[]).includes(weightClass)
  ) {
    return { ok: false, code: 'SOURCE_WEIGHT_CLASS_INVALID' };
  }

  return validateSearchSourceRouteTemplate(routeTemplate);
}

/**
 * Validates a route template.
 *
 * THREE RULES, and each refuses a class of injected URL rather than a spelling:
 *   1. the grammar (`SEARCH_ROUTE_TEMPLATE_PATTERN`): an app-absolute path whose
 *      last segment is a plain segment or `:id` — no scheme, no `//`, no `?`,
 *      no `#`, no `:` anywhere else;
 *   2. no `.` or `..` SEGMENT — the two dot-only paths are path traversal once
 *      the template is resolved, and the pattern above cannot exclude them
 *      because `.` is a legal filename character;
 *   3. the length bound.
 */
export function validateSearchSourceRouteTemplate(template: unknown): SearchSourceValidation {
  if (typeof template !== 'string' || template.length === 0) {
    return { ok: false, code: 'SOURCE_ROUTE_TEMPLATE_INVALID' };
  }

  if (template.length > MAX_SEARCH_ROUTE_TEMPLATE_LENGTH) {
    return { ok: false, code: 'SOURCE_ROUTE_TEMPLATE_INVALID' };
  }

  if (!SEARCH_ROUTE_TEMPLATE_PATTERN.test(template)) {
    return { ok: false, code: 'SOURCE_ROUTE_TEMPLATE_INVALID' };
  }

  const segments = template.split('/').slice(1);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, code: 'SOURCE_ROUTE_TEMPLATE_INVALID' };
    }
  }

  return { ok: true };
}

/**
 * Validates a whole adapter at registration time: the descriptor AND the one
 * method the platform will call.
 *
 * DELIBERATELY LOOSER THAN THE DATA VALIDATORS. The strict key allowlist applies
 * to DATA that crosses the boundary at runtime (projections, authorization
 * results) — that is where "no arbitrary object" is enforced. An ADAPTER is a
 * composition-time dependency: a `class CommerceSearchSource implements
 * SearchSourceAdapter` (prototype methods, class fields, test-double helpers)
 * must be registrable, so this check only asserts what the platform will
 * actually touch — a non-null object with a valid descriptor and a callable
 * `authorize`. A mis-wired provider fails HERE, at startup, instead of at the
 * first search.
 */
export function validateSearchSourceAdapter(adapter: unknown): SearchSourceValidation {
  if (typeof adapter !== 'object' || adapter === null || Array.isArray(adapter)) {
    return { ok: false, code: 'SOURCE_KEY_INVALID' };
  }

  const candidate = adapter as Record<string, unknown>;
  if (typeof candidate.authorize !== 'function') {
    return { ok: false, code: 'SOURCE_KEY_INVALID' };
  }

  return validateSearchSourceDescriptor(candidate.descriptor);
}

/** Exactly the keys one projection record may carry. Nothing else is projected. */
const PROJECTION_RECORD_KEYS = ['entityId', 'tenantId', 'searchContent', 'sourceUpdatedAt'];

/** Validates ONE projection record. Exported so the spec pins each rule alone. */
export function validateSearchProjectionRecord(record: unknown): SearchSourceValidation {
  if (!isPlainRecord(record)) return { ok: false, code: 'PROJECTION_SHAPE_INVALID' };
  if (!hasOnlyKeys(record, PROJECTION_RECORD_KEYS)) {
    return { ok: false, code: 'PROJECTION_SHAPE_INVALID' };
  }

  if (!('entityId' in record) || !('tenantId' in record) || !('searchContent' in record)) {
    return { ok: false, code: 'PROJECTION_SHAPE_INVALID' };
  }

  if (!isValidEntityId(record.entityId)) {
    return { ok: false, code: 'PROJECTION_ENTITY_ID_INVALID' };
  }

  if (!isValidTenantId(record.tenantId)) {
    return { ok: false, code: 'PROJECTION_TENANT_INVALID' };
  }

  if (!isValidTimestamp(record.sourceUpdatedAt)) {
    return { ok: false, code: 'PROJECTION_TIMESTAMP_INVALID' };
  }

  const content = record.searchContent;
  if (
    !Array.isArray(content) ||
    content.length === 0 ||
    content.length > MAX_SEARCH_CONTENT_FIELDS
  ) {
    return { ok: false, code: 'PROJECTION_CONTENT_INVALID' };
  }

  for (const part of content) {
    if (typeof part !== 'string' || part.length > MAX_SEARCH_CONTENT_FIELD_LENGTH) {
      return { ok: false, code: 'PROJECTION_CONTENT_INVALID' };
    }
  }

  return { ok: true };
}

/**
 * Validates a projection BATCH as a unit — bounds and every record.
 *
 * WHOLE-BATCH, matching `project`'s all-or-nothing refusal: one malformed record
 * yields ONE code and NO write. An empty batch is valid and a no-op.
 */
export function validateSearchProjectionBatch(records: unknown): SearchSourceValidation {
  if (!Array.isArray(records)) return { ok: false, code: 'PROJECTION_BATCH_INVALID' };
  if (records.length > MAX_SEARCH_PROJECTION_BATCH) {
    return { ok: false, code: 'PROJECTION_BATCH_INVALID' };
  }

  for (const record of records) {
    const validation = validateSearchProjectionRecord(record);
    if (!validation.ok) return validation;
  }

  return { ok: true };
}

/**
 * Validates a removal id list: same id rule, same batch bound, empty allowed.
 *
 * NO SILENT DEDUPE HERE — the caller's list is validated as given; the service
 * dedupes before the delete, because "remove the same id twice" is a legitimate
 * retry and must be a no-op rather than an error.
 */
export function validateSearchSourceRemovalIds(entityIds: unknown): SearchSourceValidation {
  if (!Array.isArray(entityIds)) return { ok: false, code: 'REMOVAL_IDS_INVALID' };
  if (entityIds.length > MAX_SEARCH_PROJECTION_BATCH) {
    return { ok: false, code: 'REMOVAL_IDS_INVALID' };
  }

  for (const id of entityIds) {
    if (!isValidEntityId(id)) return { ok: false, code: 'REMOVAL_IDS_INVALID' };
  }

  return { ok: true };
}

/** Exactly the keys one authorization result may carry. Nothing else crosses back. */
const AUTHORIZATION_RESULT_KEYS = ['entries'];
const AUTHORIZED_ENTRY_KEYS = ['entityId', 'title', 'snippetFields', 'timestamp'];

/**
 * Validates what a source's `authorize` returned.
 *
 * THE UNTRUSTED DIRECTION OF THE BOUNDARY. A source may return only ids the
 * platform asked about — an id outside `requested` is refused as
 * `AUTHORIZATION_RESULT_INVALID` rather than tolerated, because accepting it would
 * make the result set a place a source could inject rows the index never
 * retrieved. Duplicates are refused for the same reason: one id, one entry.
 *
 * A refusal drops the WHOLE answer for that source (the caller treats it as "no
 * authorized rows"), which is the fail-closed reading: a malformed answer must
 * never resolve to a partially trusted result.
 */
export function validateSearchSourceAuthorizationResult(
  result: unknown,
  requested: readonly string[]
): SearchSourceValidation {
  if (!isPlainRecord(result)) return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
  if (!hasOnlyKeys(result, AUTHORIZATION_RESULT_KEYS)) {
    return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
  }

  const { entries } = result;
  if (!Array.isArray(entries) || entries.length > requested.length) {
    return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
  }

  const asked = new Set(requested);
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!isPlainRecord(entry)) return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
    if (!hasOnlyKeys(entry, AUTHORIZED_ENTRY_KEYS)) {
      return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
    }

    const { entityId, title, snippetFields, timestamp } = entry;

    if (typeof entityId !== 'string' || !asked.has(entityId) || seen.has(entityId)) {
      return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
    }
    seen.add(entityId);

    if (
      typeof title !== 'string' ||
      title.trim().length === 0 ||
      title.length > MAX_SEARCH_RESULT_TITLE_LENGTH
    ) {
      return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
    }

    if (!Array.isArray(snippetFields) || snippetFields.length > MAX_SEARCH_SNIPPET_FIELDS) {
      return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
    }

    for (const field of snippetFields) {
      if (typeof field !== 'string' || field.length > MAX_SEARCH_SNIPPET_FIELD_LENGTH) {
        return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
      }
    }

    if (!isValidTimestamp(timestamp)) {
      return { ok: false, code: 'AUTHORIZATION_RESULT_INVALID' };
    }
  }

  return { ok: true };
}





