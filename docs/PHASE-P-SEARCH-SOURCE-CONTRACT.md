# PHASE P-SEARCH-SOURCE — PLATFORM GLOBAL SEARCH SOURCE CONTRACT

**Status:** `PLATFORM SEARCH SOURCE CONTRACT COMPLETE — platform only (no Commerce code, no HTTP API, one justified additive migration)`

**Scope:** the missing platform capability that blocks Commerce GAP-5 global-search participation
(C8 §T/§Y.5): a typed boundary through which an INDEPENDENT bounded context can contribute
searchable projections to the existing `GET /search`, while the source module remains the owner of
its data and its authorization truth. No Commerce implementation, no HR/Finance work, no second
search engine, no public HTTP surface, no frontend change, no new permission, **no new numeric
weight**.

Classification tags used throughout: `[CONFIRMED]` (read directly in source), `[DERIVED]`
(logically follows from confirmed source), `[PROPOSED]` (suggestion, not implemented),
`[UNKNOWN]`, `[DECISION REQUIRED]`.

**Git baseline (§44):** HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`, with the
pre-existing uncommitted work of C1–C8 / UI / P-AUDIT-READ phases recorded in §AG. No commits,
resets, cleans, checkouts, rebases or squashes were performed by this phase.

---

## A. CURRENT GLOBAL SEARCH ARCHITECTURE — the map, from actual source `[CONFIRMED]`

```
HTTP GET /search           src/search/search.controller.ts       (JwtAuthGuard; no @Roles; no tenant parameter)
  ↓
SearchService.search()     src/search/search.service.ts          (scope from RequestContextService + RBAC)
  ↓ normalize              src/search/persian-normalize.ts       (normalizeForQuery === normalizeForIndex, one function)
  ↓ lexical arm (SQL)      src/search/search.repository.ts       (plainto_tsquery('simple'), ts_rank_cd, tenant predicate)
  ↓ semantic arm (SQL)     src/search/search.repository.ts       (pgvector <=> , NULL embeddings excluded)
  ↓ embed the query        src/ai/ai-config.service.ts           (ONE call per search; failure DEGRADES to lexical)
  ↓ merge + rank           src/search/search-ranking.ts          (pure; hybrid score, SOURCE_WEIGHTS, tie-break by sourceId)
  ↓ AUTHORIZE              src/search/search-authorizer.service.ts (re-reads the authoritative Core row per source type)
     … + EXTERNAL          src/platform/search-source/search-source.service.ts (one batched adapter call per source)
  ↓ snippet                src/search/search-snippet.ts          (plain text + offsets, from the row read AFTER authorization)
  ↓ page + envelope        src/search/search.service.ts          (offset paging over the AUTHORIZED list)
HTTP response              src/search/search.types.ts            (SearchResponseDto)
```

Ownership is unchanged by this phase: `SearchModule` remains a CORE capability registered in
`core-app.module.ts` and `app.module.ts`; it now imports `PlatformSearchSourceModule` (one-way).

## B. `SearchDocument` OWNERSHIP `[CONFIRMED]`

- The index table is **Core/platform-owned** (`prisma/core/schema.prisma` →
  `core_db."SearchDocument"`), written by the platform only. `[CONFIRMED]`
- It is a **cache**: keyed by (`sourceType`, `sourceKey`, `sourceId`), no relations, fully
  rebuildable, and it is **not an authorization boundary** — the model comment and
  `SearchAuthorizer` both say so and this phase preserved that. `[CONFIRMED]`
- This phase added, additively: the `EXTERNAL` enum member and the `sourceKey` column (one
  migration, §T). The table did **not** move, no per-module table was created, and platform
  rows keep their exact previous identity (`sourceKey = ''`). `[CONFIRMED — migration
  20261001120000_add_external_search_source]`

## C. EXISTING SOURCE INVENTORY `[CONFIRMED]`

Eight platform sources, each with a projection (`search-indexer.service.ts`), an authorization
rule (`search-authorizer.service.ts`), a weight (`search.constants.ts` `SOURCE_WEIGHTS`) and a
route constant (`search-routes.ts`): `TICKET`, `TICKET_COMMENT`, `SURVEY`, `MESSAGE`,
`CONVERSATION`, `NOTIFICATION`, `REMINDER`, `USER`. Nothing about them changed: `SOURCE_WEIGHTS`
still declares exactly these eight keys (its spec pins the list), `SEARCH_SOURCE_ORDER` still
rebuilds exactly these eight, the authorizer's switch is still exhaustive over exactly these
eight, and every route builder is untouched.

## D. THE SEARCH SOURCE CONCEPT — validated against source `[DERIVED]`

> A bounded context contributes a safe searchable projection to Platform Search, while the
> bounded context remains the owner of the underlying business entity, its presentation text and
> its authorization truth.

Validated against the existing architecture, field by field:

| Concept | Platform owns | Source owns |
|---|---|---|
| index row (`SearchDocument`) | ✔ writer (`SearchDocumentWriter`) | — |
| searchable text | ✔ normalization (`buildSearchText`) | the raw fields it submits |
| retrieval, ranking, paging, envelope | ✔ `src/search/**` | — |
| source registration | ✔ `SearchSourceService` | the descriptor it declares |
| authorization truth | orchestration only | ✔ its adapter, its rules, its database |
| presentation text (title/snippet) | snippet cutting | ✔ returned only AFTER authorization |
| navigation | href composition from a validated template | the template it registered |

## E. THE EXACT PORT / INTERFACE `[CONFIRMED — implemented]`

```ts
// apps/api/src/platform/search-source/search-source.contract.ts
export const SEARCH_SOURCE_PORT = 'SearchSourcePort';

export interface SearchSourcePort {
  register(adapter: SearchSourceAdapter): RegisteredSearchSource;   // throws SearchSourceRegistrationError
}

export interface SearchSourceAdapter {
  readonly descriptor: SearchSourceDescriptor;
  authorize(request: SearchSourceAuthorizationRequest): Promise<SearchSourceAuthorizationResult>;
}

export interface RegisteredSearchSource {
  readonly descriptor: SearchSourceDescriptor;
  project(records: readonly SearchProjectionRecord[]): Promise<SearchSourceProjectionResult>;
  remove(entityIds: readonly string[]): Promise<SearchSourceRemovalResult>;
}

export interface SearchSourceDescriptor {
  readonly key: string;            // ^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$, ≤ 64
  readonly ownerModuleId: string;  // ^[a-z][a-z0-9-]*$, ≤ 64
  readonly weightClass: 'PRIMARY' | 'SUPPORTING';
  readonly routeTemplate: string;  // app-absolute, last segment `:id` or plain
}
```

**Who writes `SearchDocument`?** The platform — `SearchDocumentWriter`, the same single write path
the indexer now uses. **Who owns projection generation?** The source (its text fields). **Who
triggers index updates?** The source, by calling `project(...)`/`remove(...)` on its handle; the
platform owns everything after that. **Who performs the authorization re-read?** The source's
adapter at query time, once per source per search (batched). **Where is source metadata?** In
process memory, in the registry — composition state, not a table. `[CONFIRMED]`

## F. SOURCE REGISTRATION `[CONFIRMED]`

- Mechanism: **application composition**. A module calls `register(adapter)` at startup and keeps
  the returned handle. There is no DB table, no admin UI, no filesystem discovery, no HTTP route
  and no permission — matching §15/§26/§39/§40 of the brief. `[CONFIRMED]`
- Duplicate keys and malformed descriptors **throw** `SearchSourceRegistrationError` with one
  closed code (`SOURCE_DUPLICATE`, `SOURCE_KEY_INVALID`, `SOURCE_OWNER_INVALID`,
  `SOURCE_WEIGHT_CLASS_INVALID`, `SOURCE_ROUTE_TEMPLATE_INVALID`). A half-registered source cannot
  be started silently. `[CONFIRMED]`
- The handle is **namespace-scoped**: `project`/`remove` take no key, so a source cannot write
  another source's rows and cannot reach platform rows at all. `[CONFIRMED]`

## G. THE PROJECTION CONTRACT `[CONFIRMED]`

```ts
export interface SearchProjectionRecord {
  readonly entityId: string;                    // opaque id, no whitespace/controls, not '.'/'..', ≤ 128
  readonly tenantId: string | null;             // exact-equality bucket; null is a real tenant
  readonly searchContent: readonly string[];    // ≤ 8 raw fields, each ≤ 2000 chars
  readonly sourceUpdatedAt: Date;               // the source row's own timestamp
}
```

- **No title, no snippet, no route, no weight, no arbitrary JSON.** The index stores no raw text;
  presentation data is returned only at authorization time. Unknown keys are REJECTED
  (`PROJECTION_SHAPE_INVALID`) — that is how "secrets are not indexed" and "no arbitrary
  projection object" became a property of the boundary rather than a promise. `[CONFIRMED]`
- Validation is **whole-batch and pre-write**: one malformed record refuses the call and writes
  nothing. Empty batches are accepted no-ops. Batch bound = `INDEX_BATCH_SIZE` (200). `[CONFIRMED]`
- Blank-normalizing content is skipped and REPORTED in `skipped`, never silently dropped — the
  same rule the indexer applies (`searchText_nonblank` CHECK). `[CONFIRMED]`

## H. THE AUTHORIZATION CONTRACT `[CONFIRMED]`

- The platform asks; the source answers:
  `authorize({ actor: { userId, tenantId }, entityIds }) → { entries: [{ entityId, title,
  snippetFields, timestamp }] }`. One call per source per search (grouped by key, ids deduped) —
  no N+1, by construction. `[CONFIRMED]`
- Omission is "unauthorized" (dropped silently, exactly like `SearchAuthorizer` drops a vanished
  row). An id outside the requested set, a duplicate entry, an empty/oversized title, a wrong
  shape or an invalid timestamp **fails the whole answer for that source**
  (`AUTHORIZATION_RESULT_INVALID`, fail-closed, logged with the source key). `[CONFIRMED]`
- The platform never copies a source's rules and never lets the index decide: the index row is
  re-authorized on every search. `[CONFIRMED]`
- `SearchAuthorizer` still handles exactly the eight platform sources (type-narrowed), so a
  platform rule cannot be half-rewritten for an external one. `[CONFIRMED]`

## I. TENANT CONTRACT `[CONFIRMED]`

- Query side: the actor's tenant comes from `RequestContextService` (never from the request), and
  retrieval filters `SearchDocument` by **exact equality** (`IS NULL` for null, `= tenant`
  otherwise) — unchanged from 49J. `[CONFIRMED — search.repository.ts]`
- Projection side: `record.tenantId` is the SOURCE's tenant for that row, taken from its own data.
  A client-supplied tenant can never reach the index: there is no query parameter, header or body
  field for it anywhere in this contract. `[CONFIRMED]`
- At query time the source receives the TRUSTED actor (`userId`, `tenantId`) and applies its own
  rule; the platform's tenant snapshot on the row is a second, redundant cut. `[CONFIRMED]`

## J. NORMALIZATION `[CONFIRMED — one pipeline, no second implementation]`

`buildSearchText` (`src/search/persian-normalize.ts`) is applied by the INGESTION BOUNDARY to the
source's raw `searchContent` — the same single function the indexer and the query path use. There
is no `CommerceSearchNormalizer`, no per-module folding and no module-level tokenizer; a source
submits text and the platform decides what a word is. The service spec asserts the exact
normalized text a projection produces (`searchText: buildSearchText(content)`).

## K. RESULT ROUTE CONTRACT `[CONFIRMED]`

- A source registers ONE route TEMPLATE (`/admin/<area>/<page>/:id` or a plain page), never a
  concrete URL. The platform validates it at registration: must start with `/`, no scheme, no
  `//`, no query string, no fragment, no `.`/`..` segment, `:id` only as the final segment, ≤ 128
  chars. `[CONFIRMED]`
- The href of a result is composed BY THE PLATFORM (`composeRouteHref`) with
  `encodeURIComponent(entityId)`, so an id can never add path structure. A source cannot inject a
  URL — it names a page once, at composition time, where its choice is reviewable. `[CONFIRMED]`
- No `anchor` is part of the external contract (the platform's own sources use anchors where a
  detail route does not exist). Adding one later is an additive change; it was not needed by any
  requirement here. `[DERIVED]`

## L. RANKING / WEIGHTS `[CONFIRMED — no new value, no guessing]`

- The platform has exactly two multipliers today, with written rationale per source:
  `PRIMARY_SOURCE_WEIGHT` (1) and `OPTIONAL_SOURCE_WEIGHT` (0.6). `SOURCE_WEIGHTS` maps the eight
  platform sources; its spec still pins exactly those eight keys. `[CONFIRMED]`
- An external source declares a CLASS, never a number:
  `PRIMARY → PRIMARY_SOURCE_WEIGHT`, `SUPPORTING → OPTIONAL_SOURCE_WEIGHT`
  (`SEARCH_WEIGHT_CLASS_FACTORS`). The mechanism introduces **no new magnitude**, and a module
  cannot promote itself above platform content by editing its own descriptor — it chooses between
  the two values the platform already owns. Adding a third class would be a PLATFORM decision.
  `[CONFIRMED — implemented]`
- A candidate whose source is not registered in this runtime resolves to `null` and is EXCLUDED
  before truncation: no guessed default weight, and no candidate slot consumed by a row that
  could never be authorized. `[CONFIRMED]`
- **This is the answer C8 §Y.5 recorded as missing** ("a `SOURCE_WEIGHTS` value for each new
  source"): the value is not per source and not invented — it is per CLASS, one of the two
  existing constants. Which class a FUTURE Commerce source declares remains that phase's explicit
  decision, documented per source, exactly as 49J documented its eight. `[DERIVED]`

## M. ORDERING `[CONFIRMED — unchanged]`

`b.score − a.score`, then `a.sourceId.localeCompare(b.sourceId)` — the existing deterministic
tie-break, and the only one. External candidates participate in exactly the same ordering with
exactly the same tie-break; the e2e proves a PRIMARY-class source outranks a SUPPORTING-class one
over IDENTICAL searchable text (identical lexical rank — only the class can separate them).
No recency term, no "best result" per source, no per-source quota.

## N. PAGINATION `[CONFIRMED — unchanged]`

Offset paging over the AUTHORIZED result list (`limit` capped at 50, `offset` ≥ 0), exactly as
49J: authorization runs BEFORE paging, so a page can never contain an unauthorized row and its
size never reflects what the caller may not see. External rows flow through the same slice; the
e2e walks three pages plus an empty tail over five external rows and asserts no duplicate and no
lost result.

## O. TOTALS `[CONFIRMED — no new counter]`

There is no corpus total and no per-source index count in the response (49J's design: `count` is
the page's authorized size, `hasMore` is derived from the authorized list, `sourceCounts` counts
AUTHORIZED results). External rows changed none of that: facet counts and `hasMore` are computed
after the source's own authorization answer, so an external source cannot inflate or leak a
number the actor is not entitled to see. `[CONFIRMED]`

## P. STALE SEARCH DOCUMENTS `[CONFIRMED]`

A projection can outlive its entity, and the platform handles it with the EXISTING model, not a
new one: the query path re-asks the owning source about every candidate, and a source that no
longer has the row simply omits it (e2e: a projected-but-unseeded row is dropped while its
siblings appear; a source that throws contributes nothing). There is no cache invalidation system,
no TTL and no background cleanup — a stale row is a candidate that authorization discards, and
`remove(...)` is how a source keeps the index small. `[CONFIRMED]`

## Q. DELETE / ARCHIVE `[CONFIRMED]`

`RegisteredSearchSource.remove(entityIds)` deletes only rows in the caller's own namespace,
idempotently (`removed: 0` for absent ids), bounded to the same batch size, with no cross-source
reach. The platform never invents a lifecycle event: the source decides when a row should
disappear, exactly as `SearchIndexerService.remove` does for platform rows. `[CONFIRMED]`

## R. FAILURE SEMANTICS `[CONFIRMED]`

| Failure | Behavior |
|---|---|
| malformed projection batch | whole call `rejected` with one closed code; NOTHING written |
| storage failure during `project` | the error propagates to the caller (never swallowed); re-projecting the same batch is idempotent and completes it |
| source adapter throws at query time | that source contributes NOTHING, logged by key; other sources and platform results unaffected; the response stays 200 |
| malformed authorization answer | whole answer for that source dropped (`AUTHORIZATION_RESULT_INVALID`), fail-closed |
| source not registered in this runtime | candidates excluded (merge) and dropped (authorization); logged |
| embedding provider unavailable | rows written with NULL embeddings (lexical-only) — the 49J rule, unchanged; `embedded` count reports it |
| duplicate/malformed registration | typed exception at startup — the process does not start half-registered |

No new queue, retry loop or scheduler exists; the ingestion boundary inherits the indexer's
"eventually consistent cache" semantics rather than inventing a delivery guarantee. `[DERIVED]`

## S. SECURITY `[CONFIRMED — each claim is a test]`

- unauthorized rows cannot appear: omission at the adapter = dropped (service spec + e2e P-S-B);
- an id the platform never asked about cannot be injected into the result set
  (`AUTHORIZATION_RESULT_INVALID`, fail-closed);
- tenant isolation on results, facets and paging (e2e P-S-C / P-S-D; the row IS in the index and
  still invisible to the other tenant);
- sensitive/unknown projection fields are refused, not dropped silently (contract spec, service
  spec, e2e P-S-H — the row count proves nothing was written);
- routes: no injected URL (grammar + traversal + `encodeURIComponent`), enforced at registration
  and asserted in P-S-G;
- weights: the source chooses a CLASS from a closed set, never a number;
- namespace: `project`/`remove` are bound to the registered key; no API takes another key;
- no arbitrary SQL: nothing in the contract accepts SQL, a predicate, a column name or a `where`;
  the only statements are the platform's own parameterised upsert/delete;
- no arbitrary object: every inbound shape is validated key-by-key, and an unknown key is an
  error rather than a silently ignored value.

## T. DATABASE BOUNDARY `[CONFIRMED]`

- The only schema change is additive and justified: `ALTER TYPE "SearchSourceType" ADD VALUE
  IF NOT EXISTS 'EXTERNAL'`, `ADD COLUMN "sourceKey" TEXT NOT NULL DEFAULT ''`, and the unique
  index replaced by (`sourceType`, `sourceKey`, `sourceId`) — the old 2-column key cannot coexist
  with it, because two external sources may legitimately hold the same entity id. No row is read,
  rewritten or deleted; platform rows keep `sourceKey = ''`, so their uniqueness is exactly what
  it was. `[CONFIRMED]`
- One write path exists (`SearchDocumentWriter`), used by the platform indexer AND the ingestion
  boundary; the upsert targets the new unique key and keeps the 49J `COALESCE` embedding rule.
  `[CONFIRMED]`
- The source module never receives Core Prisma, the `SearchDocument` client type or credentials:
  it depends on the string token `SEARCH_SOURCE_PORT` and this file's types. `[CONFIRMED — and
  structurally enforced for future modules by the same pattern the audit port uses]`
- No per-module table, no second index table, no cross-database query anywhere. `[CONFIRMED]`

## U. TEST FAKE `[CONFIRMED]`

`apps/api/test/fixtures/fake-search-source.ts` — the reusable, CONTRACT-DRIVEN fake:
`createFakeSearchSourcePort()` returns a port that validates through the SAME `validate*`
functions, refuses with the SAME typed error codes, and an `adapter(descriptor)` whose
authorization truth is a SEEDED ENTITY SET (kept deliberately apart from its projections, so the
stale-index scenario is expressible). Deterministic: insertion order, a fixed clock, no I/O.
It is exercised by the e2e (which registers its adapters with the REAL port), so it cannot drift
into a fake that only the fake agrees with.

## V. TEST CONTRACT — brief §34/§35 mapped to executable tests `[CONFIRMED]`

| Brief §34 item | Where it is pinned |
|---|---|
| A — source registration | contract spec (descriptor grammar) + service spec (accept/list) + e2e "registration rules at the REAL port" |
| B — duplicate rejection | service spec + e2e `SOURCE_DUPLICATE` |
| C — malformed source rejected | service spec `it.each` (4 codes) + e2e malformed descriptor |
| D — safe projection validation | contract spec (record/batch rules) + service spec (whole-batch refusal, no write) |
| E — tenant isolation | contract spec (null bucket rule) + e2e P-S-C (results + facets + index evidence) |
| F — authorization re-read | service spec (trusted actor passed, batched per source, deduped) + e2e P-S-A |
| G — unauthorized exclusion | service spec (omission dropped; unknown id refused) + e2e P-S-B |
| H — unauthorized totals | e2e P-S-B (`sourceCounts` counts authorized rows only) |
| I — source weight handling | ranking spec (class → constant, `null` → exclude) + e2e P-S-E (0.6 ratio, order) |
| J — deterministic ordering | ranking spec (identical order from reversed input, tie-break `sourceId`) |
| K — route target validation | contract spec (13 rejected shapes + composition/encoding) + e2e P-S-G |
| L — sensitive field rejection | contract spec + service spec + e2e P-S-H (row count = 0) |
| M — no arbitrary query support | the contract has no query API at all — only `register/project/remove/authorize` exist |
| N — source failure behavior | service spec (throw → nothing, others intact) + e2e P-S-J |
| O — stale document behavior | contract/service semantics (omission = drop) + e2e P-S-B + removal e2e |
| P — existing source regression | `search.e2e-spec.ts` (41 tests) + full unit suite + `commerce-search.e2e-spec.ts` (14) |

Brief §35 e2e mapping: **P-S-A** register→project→`GET /search` result appears ·
**P-S-B** authorization rejects one → absent (+facets) · **P-S-C** tenant A/B cross-check ·
**P-S-D** pagination no-duplicate/no-loss + `hasMore` + empty tail · **P-S-E** weight classes
over identical text · **P-S-F** invalid projection rejected whole, nothing indexed ·
**P-S-G** invalid route refused at registration · **P-S-H** sensitive field rejected, zero rows ·
**P-S-I** existing platform search regression green (separate suite) · **P-S-J** source failure →
200 without its rows, others intact.

## W. FUTURE COMMERCE COMPATIBILITY — the phase's one acceptance test `[DERIVED — proven]`

> "The platform contract is sufficient for a future Commerce adapter without requiring Commerce
> to access Core SearchDocument or core_db directly." — MET.

A future Commerce phase needs only in-process work inside `src/modules/commerce/**`:
`@Inject(SEARCH_SOURCE_PORT)`; `register({ descriptor: { key: 'commerce.…', ownerModuleId:
'commerce', weightClass: <decided per C8 §Y.5, documented>, routeTemplate:
'/admin/commerce/…/:id' } })`; push `project(...)`/`remove(...)` from its own write paths;
`authorize` implemented against `commerce_db` through its OWN repositories. No Core Prisma, no
`SearchDocument` client, no Core credentials, no enum migration per entity (the `EXTERNAL` marker
already exists), no new weight value (the class comes from the existing two), no platform switch
case. The remaining decisions are Commerce's own and are listed in §AA. The e2e exercises exactly
this shape with a test source, which is what "proven" means here.

## X. FUTURE HR / FINANCE COMPATIBILITY `[DERIVED]`

Identical shape: HR registers `hr.…` with a descriptor and an adapter reading `hr_db` through its
own client; Finance likewise. The platform adds no per-module code at registration time, no
schema change, and no source vocabulary — the only shared surface is this contract. Where a
module needs a different RANKING story than the two classes, that is a platform decision (§AA),
not a module override.

## Z. UNKNOWN `[UNKNOWN]`

- Whether external rows should also be re-indexed/rebuilt by a platform-side backfill (like
  `SearchIndexerService.rebuildAll` does for platform sources): **not applicable today** — the
  source pushes projections and there is no platform-side reader of source databases to rebuild
  from. A future rebuild-participation shape (the source exporting a full projection stream) is
  NOT specified here because no requirement asked for it yet.
- Whether the semantic arm will ever run against external rows depends on the embedding
  credential being configured (a pre-existing environment fact, not specific to this phase): in
  the current environment every row — platform or external — is lexical-only. `[CONFIRMED as
  environment, UNKNOWN as future]`
- How the web UI will present `sourceKey` (facet chips, labels keyed by source) — deliberately
  left to the future UI phase that introduces the first real source; the identifier is already on
  the wire for external results.

## AA. DECISION REQUIRED `[DECISION REQUIRED — none taken by this phase]`

1. **Which weight CLASS the future Commerce sources declare** (`PRIMARY` vs `SUPPORTING`), with a
   written rationale per source, exactly as 49J documented its eight. The MECHANISM exists; the
   choice does not, and this phase did not make it for Commerce.
2. **Whether a Commerce result is reachable by a caller without `commerce.read`** (C8 §Y.8) —
   global search has no `@Roles` gate of its own, so a source's `authorize` MUST encode whatever
   permission question Commerce decides (the contract passes the trusted actor, not permissions;
   the source owns the rule). Must be answered in the Commerce phase, before its first source is
   registered.
3. **The web label entry/entries** for the first external source(s) — a frontend phase, not this
   one.
4. **`sourceType=EXTERNAL` as a client query filter** — deliberately NOT added to
   `SearchQueryDto`'s allowlist (the DTO's comment explains why a new value must not be accepted
   before its rules exist). Whether the filter should ever accept it is a product decision.
5. **How multiple external sources are presented under the one `EXTERNAL` facet** — the response
   carries `sourceKey`, so the client can regroup; how it should is a UI decision.

## AB. EXPLICITLY REJECTED ASSUMPTIONS `[CONFIRMED]`

- ❌ "The platform should add one `SearchSourceType` enum member per future source." — rejected:
  it makes every participant a Core migration plus a platform switch case plus an undefined
  weight (C8 §T.4/§T.5); one `EXTERNAL` marker + `sourceKey` keeps the vocabulary in the
  contract where it belongs.
- ❌ "Commerce can project by handing the platform a `where` clause, SQL or a `findMany` options
  object." — rejected: the contract has no predicate surface of any kind (§S).
- ❌ "The index can decide visibility, or store an `ownerId`/`isInternal` snapshot to speed up
  authorization." — rejected: the index is not an authorization boundary; external rows are
  re-asked on every search exactly like platform rows.
- ❌ "A source may supply its numeric weight." — rejected: class only, from the platform's two
  constants (§L).
- ❌ "A source may supply the final href/URL." — rejected: template + platform composition (§K).
- ❌ "Write directly into `core_db."SearchDocument"` from Commerce, or give Commerce Core
  Prisma." — rejected by construction: the only external dependency is the `SEARCH_SOURCE_PORT`
  token (§T).
- ❌ "A second search engine / Elasticsearch / a queue-backed ingestion pipeline." — rejected:
  no such infrastructure exists in this repository and none was introduced; the existing index,
  the existing query and the existing cache semantics are reused.
- ❌ "Normalize search text in the source." — rejected: one pipeline (`buildSearchText`), §J.
- ❌ "Add `search.read` or a source-registration permission." — rejected: registration is
  composition; the existing `GET /search` behavior is untouched.

## FILES CREATED BY THIS PHASE (10 + 1 doc)

| File | Role |
|---|---|
| `apps/api/src/platform/search-source/search-source.contract.ts` | THE contract: token, bounds, closed rejection codes, types, validators, `composeRouteHref`, `externalCandidateKey` |
| `apps/api/src/platform/search-source/search-source.service.ts` | registry + ingestion boundary + query-time authorization dispatcher (`SearchSourceService`) |
| `apps/api/src/platform/search-source/search-document.writer.ts` | THE single write path into `SearchDocument` (moved out of the indexer, `sourceKey`-aware) |
| `apps/api/src/platform/search-source/search-embedding.service.ts` | THE single embedding path (moved out of the indexer, latch preserved) |
| `apps/api/src/platform/search-source/platform-search-source.module.ts` | binds `SEARCH_SOURCE_PORT` (`useExisting`), exports the seam |
| `apps/api/src/platform/search-source/search-source.contract.spec.ts` | 74 tests: grammars, bounds, fail-closed rules, encoding |
| `apps/api/src/platform/search-source/search-source.service.spec.ts` | 25 tests: registration, weights, whole-batch refusal, namespace, batched/fail-closed authorization |
| `apps/api/prisma/core/migrations/20261001120000_add_external_search_source/migration.sql` | the one migration (3 statements) |
| `apps/api/test/fixtures/fake-search-source.ts` | the reusable contract-driven fake (§U) |
| `apps/api/test/search-source.e2e-spec.ts` | P-S-A…P-S-J real-HTTP e2e (13 tests) |
| `docs/PHASE-P-SEARCH-SOURCE-CONTRACT.md` | this document |

## FILES MODIFIED BY THIS PHASE (10)

| File | Change |
|---|---|
| `apps/api/prisma/core/schema.prisma` | `EXTERNAL` enum member, `sourceKey` column, `@@unique([sourceType, sourceKey, sourceId])` + doc comments |
| `apps/api/src/search/search.constants.ts` | `EXTERNAL_SEARCH_SOURCE_TYPE`, `PlatformSearchSourceType`, `SEARCH_WEIGHT_CLASSES`, `SEARCH_WEIGHT_CLASS_FACTORS` |
| `apps/api/src/search/search-ranking.ts` | `sourceKey` on candidates, `weightCandidate`, external resolver, external dedupe key |
| `apps/api/src/search/search.repository.ts` | both arms SELECT `sourceKey` and return it |
| `apps/api/src/search/search-authorizer.service.ts` | type narrowed to `PlatformSearchSourceType` (behavior untouched) |
| `apps/api/src/search/search-indexer.service.ts` | delegates writes to `SearchDocumentWriter`, projection rebuilt via `PLATFORM_SOURCE_KEY`, narrowed types (behavior untouched) |
| `apps/api/src/search/search.service.ts` | candidate partition, batched external authorization, external scoring, `sourceKey` on external results |
| `apps/api/src/search/search.module.ts` | imports `PlatformSearchSourceModule` (+doc) |
| `apps/api/src/search/search.types.ts` | `SearchResultDto.sourceKey?` (present only on external results) |
| `apps/api/src/search/search-ranking.spec.ts` | helper `sourceKey`, 9 new EXTERNAL cases (41 total; all existing cases unchanged) |

Regenerated (git-ignored per `.gitignore:56`): `apps/api/src/generated/core-client/**` —
`prisma generate` output, not committed.

## UNTOUCHED `[CONFIRMED — verified by git status]`

`docs/PHASE-C8-COMMERCE-SEARCH-CONTRACT.md` and every other doc · all `apps/web/**` · all
`apps/api/src/modules/commerce/**` · all other `prisma/*` schemas · `SearchController`,
`search-routes.ts`, `search-snippet.ts`, `persian-normalize.ts`, `dto/search-query.dto.ts`
(so the client query is unchanged byte-for-byte) · `scripts/search-reindex.ts` (its
`rebuildAll`/`rebuildSource` signatures still compile — verified by tsc) · permissions/roles/
seeds · CI · dependencies (none added).

## GIT STATUS (§44)

- HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`, **no commit made**.
- 89 porcelain entries at phase start (pre-existing C1–C8 / UI / P-AUDIT-READ work) → 103 now:
  **+14 = this phase's footprint** — 10 modified (`prisma/core/schema.prisma` + the nine
  `src/search/**` files) + 4 new entries (the migration directory, `src/platform/search-source/`,
  `test/search-source.e2e-spec.ts`, this doc; `test/fixtures/` was already untracked and now also
  contains `fake-search-source.ts`).
- No `reset`, `clean`, `checkout`, `revert`, `rebase` or `squash` was executed; no pre-existing
  line was reverted.

## VALIDATION EXECUTED (§48) — exact results

Commands run from `apps/api` (or repo root where noted); `npx` is blocked by this machine's
PowerShell policy (recorded by earlier phases), so tools are invoked as
`node ../../node_modules/...` / `cmd /c` redirection.

| # | Gate | Command (shape) | Result |
|---|---|---|---|
| 1–3 | Search Source specs + Search ranking spec | `jest --runInBand src/platform/search-source src/search/search-ranking.spec.ts` | **3/3 suites, 140/140 tests** |
| 4 | Phase's own contract+service specs | `jest --runInBand src/platform/search-source` | **2/2 suites, 99/99 tests** (74 + 25) |
| 5 | Search service/authorizer/normalizer/snippet regressions | included in the full suite below (all green) | green |
| 6 | SearchDocument / projection / registry / tenant / route / pagination / failure coverage | items 1–4 above + e2e rows below | green |
| 7 | Full API unit suite | `jest --runInBand` | **207/207 suites, 3454/3454 tests**, 48.5 s |
| 8 | Architecture boundaries + runtime policy | `jest --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` | **2/2 suites, 56/56 tests** |
| 9 | New P-S e2e (real HTTP + real `core_db`) | `jest --config ./jest-e2e.json search-source` | **1/1 suite, 13/13 tests** |
| 10 | Existing Global Search e2e (P-S-I regression) | `jest --config ./jest-e2e.json test/search.e2e` | **1/1 suite, 41/41 tests** |
| 11 | C8 commerce-search e2e (baseline file, untouched) | `jest --config ./jest-e2e.json commerce-search` | **1/1 suite, 14/14 tests** |
| 12 | TypeScript | `tsc -p tsconfig.json --noEmit` | **0 errors** |
| 13 | Prisma validate | `prisma validate --schema=prisma/core/schema.prisma` | **valid** |
| 14 | Prisma generate | `prisma generate --schema=prisma/core/schema.prisma` | generated (git-ignored output) |
| 15 | migrate deploy | `prisma migrate deploy --schema=prisma/core/schema.prisma` | **applied** — 47 migrations found, `20261001120000_add_external_search_source` applied |
| 16 | Drift check | `prisma migrate diff --from-url $CORE_DATABASE_URL --to-schema-datamodel` | **no drift for this change**: zero differences mentioning `sourceKey`/the new unique key/the enum; the remaining `SearchDocument` entries are the PRE-EXISTING documented ones (indexes on `Unsupported` columns and the generated `searchVector` expression, which Prisma cannot model) and the same kind of entry appears for other pre-existing tables |
| 17 | Format | `prettier --check` (scope files) | **fails — as does the repository at baseline**: the working tree is CRLF while prettier defaults to LF; a prior full-repo run failed on **401 files**, including untouched files inside `src/search/**` (`search-routes.ts`, `search-snippet.ts`, `persian-normalize.ts`, `search.controller.ts`). Files were kept in the repository's actual CRLF style rather than reformatting pre-existing files the phase does not own. Recorded as baseline/environment, not a phase regression. |

Separation of concerns in the numbers above: **baseline** = item 11 (+ the pre-existing 89 git
entries and the 401-file prettier baseline); **phase regression** = items 7–10; **phase's own
new tests** = items 1/4/9 (140 + 13, of which 99 unit + 13 e2e are entirely new); **environment**
= item 17 and the "Jest did not exit" open-handle warning after item 7 (the suite completed in
48.5 s with every test passing; the open handle is a pre-existing condition of this repo's runs).

Frontend: not run, not modified (no file changed by necessity).

## ACCEPTANCE CRITERIA (§47)

- [x] Current Global Search architecture fully documented (§A)
- [x] SearchDocument ownership confirmed (§B)
- [x] Search Source contract defined (§D–§J)
- [x] Typed port exists (§E)
- [x] Source registration mechanism exists (§F)
- [x] Safe projection contract exists (§G)
- [x] Authorization adapter contract exists (§H)
- [x] Tenant isolation contract exists (§I)
- [x] Existing authorization re-read model preserved (§H, and the platform authorizer's tests/e2e)
- [x] Sensitive fields excluded (§S — contract spec + service spec + e2e P-S-H)
- [x] Route targets safe (§K — grammar + composition + e2e P-S-G)
- [x] No arbitrary SQL/query predicates (§S — the contract exposes none)
- [x] Source weights defined or explicitly documented as a decision (§L mechanism + §AA decision)
- [x] Existing search ordering preserved (§M; full suite + search e2e green)
- [x] Existing pagination preserved (§N; search e2e green)
- [x] Existing totals remain safe (§O; facet assertion in e2e P-S-B)
- [x] Existing sources regression green (items 7/10)
- [x] Reusable contract fake exists (§U)
- [x] Platform tests green (items 1–7)
- [x] Integration/e2e tests green (items 9–11)
- [x] TypeScript green (item 12)
- [x] Prisma valid (item 13)
- [x] Migrations only if justified (one, 3 statements, justified in-line + §T)
- [x] No Commerce implementation (nothing under `src/modules/commerce/**` changed)
- [x] No direct cross-database Prisma access (§T)
- [x] Documentation complete (this file; C8 untouched)
- [x] Future Commerce adapter compatibility proven (§W + e2e with the contract fake)
- [x] No Reporting/Search UI redesign, no Quotation/Audit/Notification work

---

**END OF DOCUMENT —** `PLATFORM SEARCH SOURCE CONTRACT COMPLETE`








