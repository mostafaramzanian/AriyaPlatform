# PHASE C8 — COMMERCE-WIDE SEARCH (GAP-5) CONTRACT

**Phase:** C8 · **Repository:** `E:\ERP` · **Gap:** GAP-5 only

**Status:** `COMMERCE BACKEND PARTIALLY COMPLETE — GAP-5`

- **CLOSED (this phase):** every Commerce list surface that PUBLISHES the shared `search`
  parameter and has a confirmed identifying text column now HONOURS it, with the module's
  one matching semantics, structural tenant isolation, the existing permission gates,
  bounded pagination, deterministic ordering and executable proofs (unit + real-HTTP E2E).
- **BLOCKED BY CONTRACT:** participation of Commerce records in the platform's Global
  Search (`GET /search`, Phase 49J) — the meaning UI-0/UI-5 give GAP-5. The exact missing
  decisions are listed in §Y; none was invented here.
- **NOT SEARCHABLE (no contract):** a new `GET /commerce/search` cross-entity endpoint —
  no source asks for one (§J).

**Classification tags** (used on every important claim): `[CONFIRMED]` read directly in
source · `[DERIVED]` logically follows from confirmed source · `[PROPOSED]` a suggestion,
not implemented · `[UNKNOWN]` · `[DECISION REQUIRED]`.

**Git baseline (§AD):** HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`,
81 pre-existing modified/untracked entries (C1–C7/UI/P-AUDIT-READ work), **no commit made
by this phase**.

---

## 0. WHAT THIS DOCUMENT COVERS

`docs/PHASE-C8-COMMERCE-SEARCH-CONTRACT.md` — created new; no previous contract is
overwritten. Earlier gap inventories (C3 §Y, C5 §W, C6/C7 status tables, UI-0 §26,
UI-5 §B/§Y) record GAP-5 as it stood when each phase ran; this document is the C8 answer.

---

## A. SEARCH OBJECTIVE `[CONFIRMED — brief §0]`

> "Define exactly what Commerce search means, what entities are searchable, which fields
> are searchable, how permissions constrain results, how tenant isolation works, how
> ranking/order works, and how the system performs the query without leaking data or
> coupling bounded contexts."

Not "add a search box". Not an enterprise search engine. Existing source, existing
contracts, existing permissions and existing tenant boundaries win.

---

## B. SCOPE

**In (GAP-5, Commerce-side):**

1. Discovery and classification of every search capability that touches Commerce data.
2. Making the published `search` parameter truthful on the lists that ignored it.
3. Executable proof (unit + real-HTTP E2E) of the confirmed search semantics: authentication,
   permission, tenant isolation, result/total isolation, pagination, ordering, query
   validation and regression.

**Out (`[CONFIRMED — brief §34]`, untouched):** GAP-4 Reporting/KPI · GAP-6 Quotation ·
GAP-7 Audit (closed) · GAP-8 identity/seed · GAP-9 Notifications · GAP-ENV · workflow
semantics · purchase lifecycle · payment · receiving · returns · completion policy ·
audit architecture · frontend · migrations · new dependencies.

---

## C. DISCOVERY — THE SEARCH CAPABILITY INVENTORY

### C1. The platform Global Search exists (Phase 49J) `[CONFIRMED]`

| Fact | Source |
|---|---|
| `GET /api/v1/search?q=&limit=&offset=&sourceType=` — one route, JWT only, no `@Roles` | `apps/api/src/search/search.controller.ts` |
| Sources: `TICKET · TICKET_COMMENT · SURVEY · MESSAGE · CONVERSATION · NOTIFICATION · REMINDER · USER` | `prisma/core/schema.prisma` `enum SearchSourceType`; `search.constants.ts`; `dto/search-query.dto.ts` |
| Index: `SearchDocument` in **`core_db`** (tsvector + pgvector) — a cache keyed `(sourceType, sourceId)`, no foreign keys | `prisma/core/schema.prisma` |
| Pipeline: normalize → lexical (`plainto_tsquery('simple')`) → optional semantic → merge/rank → **authorize by re-reading authoritative rows** → snippet → page | `search.service.ts`, `search-authorizer.service.ts` |
| Normalizer: `src/search/persian-normalize.ts` — folds ی/ک, strips ZWNJ/diacritics, folds Arabic+Persian digits to ASCII, attaches closed-set clitics | `persian-normalize.ts` |
| "THE INDEX IS NOT AN AUTHORIZATION BOUNDARY" — each candidate is re-read from its source table and put through that source's own rule | `SearchDocument` model doc, `search-authorizer.service.ts` |
| `SearchModule` is registered in **`core-app.module.ts` AND `app.module.ts`** | `src/core-app.module.ts:24,111`, `src/app.module.ts:28,94` |

### C2. Commerce data lives in a separate database, owned exclusively by Commerce `[CONFIRMED]`

- `COMMERCE_DATABASE_URL` → `commerce_db`: its own Prisma project and client
  (`prisma/commerce/schema.prisma`, `src/generated/commerce-client`), reached only through
  `CommercePrismaService` — "THE ONLY PERSISTENCE HANDLE FOR `commerce_db` … never through
  Core's `PrismaModule`" (`database/commerce-prisma.service.ts`).
- "Nothing outside this bounded context issues a query against `commerce_db`": repositories
  are PROVIDED and NOT EXPORTED; the exported surface is the three gateways
  (`commerce.module.ts`; guards `commerce-gateways.spec.ts`, `commerce-isolation.spec.ts`).
- The Core/CMS/HR runtimes mark `COMMERCE_DATABASE_URL` `not-used` and the architecture
  suite refuses a root that names Commerce there (`runtime-datasources.ts`;
  `architecture-boundaries.spec.ts`, "hosts Commerce in exactly the runtimes whose policy
  instantiates it").

### C3. Module-scoped searches already in the product `[CONFIRMED]`

| Surface | Endpoint | What `search` matches | Status |
|---|---|---|---|
| Purchase register | `GET /commerce/purchase-documents` | `documentNumber` contains, insensitive | honours (pre-existing) |
| Payments | `GET …/purchase-documents/:id/payments` | `payerRef` OR `payeeRef` OR `invoiceRef` OR `externalReference` contains, insensitive | honours (pre-existing) |
| Completion policies | `GET /commerce/completion-policies` | `versionLabel` contains, insensitive | honours (pre-existing) |
| Workflow definitions | `GET /commerce/workflow-definitions` | `code` OR `name` contains, insensitive | honours (pre-existing) |
| Line-routing versions | `GET /commerce/routing-versions` | `versionLabel` contains, insensitive | honours (pre-existing) |
| **Commercial groups** | `GET /commerce/commercial-groups` | **was accepted AND IGNORED → `code` OR `name` (C8)** | **CLOSED by C8** |
| **Commercial config versions** | `GET /commerce/commercial-configurations` | **was accepted AND IGNORED → `versionLabel` (C8)** | **CLOSED by C8** |
| **Workflow definition versions** | `GET …/workflow-definitions/:id/versions` | **was accepted AND IGNORED → `versionLabel` (C8)** | **CLOSED by C8** |
| Workflow instances | `GET /commerce/workflow-instances` | row has no identifying text → still ignored | `DECISION REQUIRED` (§Y.1) |
| Pending decisions inbox | `GET /commerce/pending-decisions` | composite row, no identifying text of its own → still ignored | `DECISION REQUIRED` (§Y.2) |

The shared base that publishes the parameter DEFINES its meaning: "`search` — Free-text
match against the record's own identifying column" (`dto/commerce-query.dto.ts`), and the
DTO is described as "the module's one page/pageSize/search base"
(`workflow-execution.dto.ts`). Accepting it while matching nothing is a defect against the
module's own published contract — the same dishonest parameter C7's `PurchaseTimelineQueryDto`
rationale names ("an honest refusal beats a dishonest parameter"). `[CONFIRMED]`

### C4. Precedents used, not reinvented `[CONFIRMED]`

- **Correspondence** (own DB) ships a module-scoped advanced search that reuses the SHARED
  Persian normalizer and makes its own visibility predicate the filter
  (`correspondence.service.ts` `searchLetters`: "Persian normalization … through the shared
  search module's normalizer (49J)").
- **Directory** search `GET /users/directory?q=` (gated `admin.users.read`);
  **Blog** search `GET /blog/search?q=`.
- Commerce's own slice precedent for a filtered page read: `listPage(tenantId, filter,
  window)` returning `[rows, total]` in ONE array-form transaction —
  `purchase.repository.ts`, `purchase-completion-policy.repository.ts`,
  `workflow-line-routing.repository.ts`. C8 adopts this shape.

### C5. What does NOT exist `[CONFIRMED by absence]`

- No Commerce source in the platform index: no enum member, no projection in
  `search-indexer.service.ts`, no route helper in `search-routes.ts`, no authorizer rule
  (verified directly, matching UI-0 §21.5/§26-GAP-5 and UI-5 §B).
- No `GET /commerce/search`, no `CommerceSearchService`, no second index, no `pg_trgm`,
  no `GIN`/`ILIKE`/raw search SQL anywhere in Commerce.
- No fuzzy matching, stemming, typo tolerance, relevance scores or aliases anywhere in
  Commerce — and none in the product contract.
- The Commerce UI has exactly one search box (the register's) and its honesty gate pins
  `/commerce/search` as a DEFERRED needle (`CommerceFinalHonesty.spec.tsx` §"names no
  still-open gap as if it were an API").

---

## D. WHAT "COMMERCE-WIDE SEARCH" MEANS IN ARIA — THE SCOPE DECISION

Brief §4's questions, answered from source:

1. **Is search PurchaseDocument only / all entities / selected entities / cross-module?**
   → `SELECTED ENTITIES, INSIDE COMMERCE` `[DERIVED from C3 + UI-0 §24.2]`: the entities
   the contract already lets a caller search (documents, payments, completion policies,
   workflow definitions, line-routing versions, and — added by C8 — commercial groups,
   commercial configuration versions and workflow definition versions), each through its
   OWN list endpoint. Not "all Commerce entities" (§E marks the rest NOT SEARCHABLE), and
   not cross-module (brief §22: "Commerce search must remain inside Commerce bounded
   context").
2. **What does "wide" mean?** `[CONFIRMED]` UI-0's own words: GAP-5 = "Global search
   participation … Commerce does NOT appear (GAP-5); in-module search on the register uses
   the server `search` param of the list route — the ONLY search Commerce offers. No
   parallel command palette" (§24.2), and "Commerce items in global search | BACKEND GAP-5
   (not in `search-routes.ts`/indexer)" (§21.5). Two halves therefore exist: the PLATFORM
   half (global participation — §Y) and the COMMERCE half (truthful in-module search —
   implemented here).
3. **Operational lookup or analytical discovery?** Operational lookup (`"Where is this
   Commerce record?"`). Analytics is GAP-4 and stays out (brief §32).
4. **Exact / partial / prefix / case / locale / Persian / normalized forms?** → partial
   (`contains`) + case-insensitive, matching the five shipped searches; Persian digit and
   ی/ک normalization is NOT applied to list search — reasoning and the open decision in §H.

---

## E. SEARCHABLE ENTITIES — THE COVERAGE MATRIX (brief §27)

| Search domain | Exists | User-facing | Confirmed searchable? | Matching semantics | Permission | Endpoint | Classification |
|---|---|---|---|---|---|---|---|
| `PurchaseDocument` | yes | yes | yes — `documentNumber` | contains, insensitive | `commerce.read` | `GET /commerce/purchase-documents?search=` | **CLOSED** (pre-existing, now proven) |
| `PurchaseLine` | yes | yes (inside a document) | **no contract** | — | `commerce.read` (document read) | — | **NOT SEARCHABLE** — the repository states there is "no title or description on a purchase document"; lines are found through their document. Making `technicalDescription`/`itemReference`/`externalRef` searchable is a PRODUCT decision (§Y.3) |
| Commercial Group | yes | yes (`code`, `name`) | **yes** — `code` OR `name` | contains, insensitive | `commerce.read` | `GET /commerce/commercial-groups?search=` | **CLOSED by C8** |
| Commercial config version | yes | yes (`versionLabel`) | **yes** — `versionLabel` | contains, insensitive | `commerce.read` | `GET /commerce/commercial-configurations?search=` | **CLOSED by C8** |
| Commercial assignment / approval | yes | yes | no text identifier of its own (they belong to a document/line) | — | `commerce.read` | document-scoped reads | **NOT SEARCHABLE** — reachable by searching the document |
| Workflow definition | yes | yes (`code`, `name`) | **yes** — `code` OR `name` | contains, insensitive | `commerce.read` | `GET /commerce/workflow-definitions?search=` | **CLOSED** (pre-existing) |
| Workflow definition version | yes | yes (`versionLabel`) | **yes** — `versionLabel` | contains, insensitive | `commerce.read` | `GET …/workflow-definitions/:id/versions?search=` | **CLOSED by C8** |
| Line-routing version | yes | yes (`versionLabel`) | **yes** — `versionLabel` | contains, insensitive | `commerce.read` | `GET /commerce/routing-versions?search=` | **CLOSED** (pre-existing) |
| Completion policy version | yes | yes (`versionLabel`) | **yes** — `versionLabel` | contains, insensitive | `commerce.read` | `GET /commerce/completion-policies?search=` | **CLOSED** (pre-existing) |
| Payment record | yes | yes (4 references) | **yes** — `payerRef`/`payeeRef`/`invoiceRef`/`externalReference` | contains, insensitive | `commerce.read` | `GET …/purchase-documents/:id/payments?search=` | **CLOSED** (pre-existing) |
| Receipt / ReceiptLine | yes | yes | no list search in any contract | — | `commerce.read` | unpaged document read | **NOT SEARCHABLE** (no contract) |
| Return document / line | yes | yes | no list search in any contract | — | `commerce.read` | unpaged document read | **NOT SEARCHABLE** (no contract) |
| Workflow instance / step instance | yes | partially | no identifying text column | — | `commerce.read` | `GET /commerce/workflow-instances?search=` (ignored) | **DECISION REQUIRED** (§Y.1) |
| Pending decisions (inbox) | yes | yes | composite — no own text | — | `commerce.read` | `GET /commerce/pending-decisions?search=` (ignored) | **DECISION REQUIRED** (§Y.2) |
| Workflow step config | yes | yes (`stepKey`, `displayName`) | not exposed by any list (versions are read with their steps) | — | `commerce.read` | version detail read | **NOT SEARCHABLE** (no list contract) |
| Commercial configuration *rows* (rules) | yes | no | configuration payload | — | — | — | **NOT SEARCHABLE** |

`PurchaseDocument`/`PaymentRecord`/… identifiers marked "confirmed" because the wire
contract and/or the repository comment states them: "The ONE text column a caller can
quote" (`purchase.repository.ts`), "The row's own references are the ONLY text a payment
carries" (`payment-history.repository.ts`), "the column that IDENTIFIES a routing version —
its `versionLabel`, the only text a caller could quote"
(`workflow-line-routing.repository.ts`).

---

## F. SEARCHABLE FIELDS — THE EXACT SET

**C8 added (the three previously-ignored parameters):**

| Endpoint | Field(s) | Why these are the identifying columns |
|---|---|---|
| `GET /commerce/commercial-groups` | `CommercialGroup.code` (unique per tenant), `CommercialGroup.name` (the rendered label) | mirror: the workflow-definition list matches the same pair for the same shape of entity |
| `GET /commerce/commercial-configurations` | `CommercialConfigurationVersion.versionLabel` (unique per tenant) | mirror: completion-policy and line-routing lists match exactly this column |
| `GET /commerce/workflow-definitions/:id/versions` | `WorkflowDefinitionVersion.versionLabel` (the natural key `findVersionByLabel` addresses a version by) | mirror: same column, same family |

**Deliberately NOT searchable, even though they exist:** `tenantId`, all UUID `id`s, all
`*Id` opaque references (requester, supplier, liaison, approver, actor), `status` enums,
money columns, timestamps, `routeRules`/`assignmentRules` payloads, `applicabilityCondition`,
`PurchaseLine` free text. Rationale: brief §24 ("Do not expose UUID technical ids … as
search terms"), C3's wording ("a search can never match a route rule or a trigger nobody
stored in that column"), and "do not search fields merely because they exist".

---

## G. MATCHING SEMANTICS `[CONFIRMED — one convention, no exceptions]`

Every Commerce `search` filter, old and new, is **exactly**:

```ts
{ <identifying column>: { contains: <raw query string>, mode: 'insensitive' } }
// OR-joined when the entity has more than one identifying column
```

- **Partial match** (`contains`, i.e. SQL `LIKE '%…%'` semantics with case folding) —
  confirmed by all five shipped searches.
- **Case-insensitive** — `mode: 'insensitive'` (Postgres `ILIKE` under Prisma).
- **Raw string, untrimmed** — `CommercePageQueryDto.search` has no `@Transform`; the query
  is passed through unchanged (identical to the pre-C8 lists; a surrounding space simply
  narrows to nothing, it never widens).
- **No multi-token semantics, no OR of tokens, no AND-of-terms, no phrase handling** — the
  whole string is one needle. (`correspondence` splits tokens; that is ITS contract, not
  Commerce's, and adopting it here would change five shipped searches.)
- **No fuzzy matching, no stemming, no prefix mode, no relevance scoring, no highlighting**
  anywhere in Commerce — none is contracted (brief §9).

---

## H. TEXT NORMALIZATION `[CONFIRMED: a mechanism exists] [DECISION REQUIRED to apply it]`

- The platform owns ONE normalizer, `apps/api/src/search/persian-normalize.ts`, with the
  invariant "the index path and the query path MUST apply the identical transformation".
  C8 did NOT create a second normalizer and did NOT modify this one (brief §8).
- `normalizeSearchText` folds ی/ک, strips ZWNJ and diacritics, folds Persian/Arabic digits
  to ASCII, **replaces punctuation with spaces**, lowercases and attaches clitics. Applied
  to an identifier-shaped query it would turn `PR-1405-00012` into `pr 1405 00012`, which
  matches no stored value — i.e. naively "normalizing" a list search would BREAK the
  document search that already works. `[DERIVED]`
- Therefore C8 applies NO normalization change to any existing search: matching semantics
  are preserved exactly (brief C8-H: existing behaviour unchanged), and no divergence
  between a normalized query and an unnormalized stored column is introduced.
- **Open decision (§Y.4):** should list `search` accept Persian digits (`۱۴۰۵`) and ی/ک
  variants? The platform normalizer's own digits rule argues yes for identifiers; it needs a
  shared *identifier* folding helper (digit-set folding only, NOT the full text pipeline)
  applied consistently — a product/UX decision, not a guess C8 may make.

---

## I. RANKING / ORDER `[CONFIRMED — no relevance exists, none invented]`

There is no relevance ordering in Commerce search: a search is a FILTER on a list, and the
list's own order is preserved (brief §17's first choice: "deterministic technical ordering
based on current list conventions").

| List | Order | Source |
|---|---|---|
| purchase documents | `createdAt desc, id asc` | `purchase.repository.ts` |
| commercial groups | `code asc` | `commercial-configuration.repository.ts` |
| commercial config versions | `createdAt desc` | same |
| workflow definitions | `createdAt desc, id asc` (unchanged) | `workflow-configuration.repository.ts` |
| workflow definition versions | `createdAt desc, id asc` | same |
| completion policies / routing versions | `createdAt desc, id asc` | their repositories |

`id asc` breaks `createdAt` ties so a paging client never sees a row twice. No "best
result", no weights, no scores (the platform's `SOURCE_WEIGHTS` belong to the global
search and are deliberately NOT extended — §Y).

---

## J. ENDPOINT — THE ARCHITECTURE DECISION `[CONFIRMED]`

Brief §28 offered three alternatives and asked to choose on source:

| Option | Verdict | Why (source) |
|---|---|---|
| **A. reuse the specialized list querying (`…?search=`)** | **CHOSEN** | It is what the architecture already does: the list endpoints each publish `search` with one defined meaning, UI-0 §24.2 calls the register search "the ONLY search Commerce offers", and brief §28 says "Do NOT add a global search endpoint if current architecture clearly prefers specialized list querying" |
| B. `GET /commerce/search?q=…` | **REJECTED — no contract** | No source asks for it: UI-0 §24.2 ("No parallel command palette"); the entity set, cross-type ordering, result shape and routes would all have to be invented (brief §2); the frontend gate still pins `/commerce/search` as a deferred needle |
| C. join the platform `GET /search` | **BLOCKED BY CONTRACT** — §Y.5 | Structurally unable to read `commerce_db` without new platform capability (§U) |

So "one endpoint for Commerce" does not exist by design: search is the shared list
parameter, and C8's contribution is making that parameter truthful on the three lists that
ignored it, plus proving the whole surface executable.

---

## K. REQUEST CONTRACT `[CONFIRMED]`

```
GET /api/v1/commercial-groups?page&pageSize&search
GET /api/v1/commercial-configurations?page&pageSize&search
GET /api/v1/workflow-definitions/:id/versions?page&pageSize&status&search
GET /api/v1/purchase-documents?page&pageSize&status&requesterId&search      (unchanged)
… payments / completion-policies / workflow-definitions / routing-versions — unchanged
```

| Parameter | Bound | Validation | On violation |
|---|---|---|---|
| `search` | string ≤ 200 chars (`MaxLength(200)` on `CommercePageQueryDto.search`) | global pipe `whitelist` + `forbidNonWhitelisted` | **422** `VALIDATION_FAILED` |
| `page` | int ≥ 1 | same | 422 |
| `pageSize` | int ≥ 1, ≤ `COMMERCE_MAX_PAGE_SIZE` | `@Max(...)` on the DTO **and** `Math.min` in the service | 422 (DTO) / clamped (internal caller) |
| anything else (`tenantId`, `companyId`, `actor`, `q`, …) | — | not declared → rejected | 422 |
| missing/empty `search` | — | `@IsOptional()` | unfiltered list (valid) |

There is **no** `q`, no `tenantId`, no cursor, no `sort`, no `fields`, no operators and no
raw predicate anywhere in the contract (brief §19).

---

## L. RESPONSE CONTRACT `[CONFIRMED — unchanged envelope]`

```jsonc
{ "items": [ … ], "page": 1, "pageSize": 20, "total": 3 }
```

- The **same** `{items, page, pageSize, total}` envelope every Commerce list already uses;
  `page`/`pageSize` echo the RESOLVED window (defaults applied server-side).
- `total` counts the **filtered, tenant-scoped** set — C8's one structural guarantee: rows
  and count are cut by the same `where` inside one `$transaction`.
- Items are that list's repository rows (unchanged projection). **C8 exposes no new field**
  and adds no `tenantId`; the pre-existing presence of `tenantId` in commercial rows is the
  UI-0 §R3 "backend hygiene" observation, recorded before C8 and not widened by it.
- Empty result: `items: []`, `total: 0` — a valid 200, never an error (brief §20).
- No `hasNext`/`count`/`mode`/`score` — those belong to the global search envelope and are
  deliberately not imitated.

---

## M. PERMISSIONS `[CONFIRMED]`

- The three C8 routes keep their EXISTING gates unchanged: `@Roles(Permissions.COMMERCE_READ)`
  plus `@RequiresModule(COMMERCE_MODULE_ID)` + `@RequiresFeature(COMMERCE_MODULE_ID, PURCHASE)`
  + `ModuleEntitlementGuard` + `JwtAuthGuard` (`commercial.controller.ts`,
  `workflow-configuration.controller.ts`).
- No permission is added, renamed or widened; `commerce.read` keeps its exact semantic
  (read procurement) — C8 only honours a parameter on a route that already answers to it.
- Search cannot bypass anything: it runs INSIDE the same repository call the list already
  made, under the same tenant predicate — there is no separate "search path" to guard.
- Document-/session-scoped reads (assignments, approvals, inbox) are untouched; nothing
  became reachable that was not reachable before.

---

## N. ACTOR `[CONFIRMED]`

`resolveCommerceActor(req)` → `{ tenantId, userId, requestId, ip, userAgent }` — the ONLY
source of identity, read from `RequestContextService`/`req.user`. No query parameter, header
or body field can state an actor, a tenant or a filter identity; a request with no
resolvable tenant fails closed with 403 before any query (the exact message is pinned by the
tenant suite). Search adds no identity surface at all.

---

## O. TENANT ISOLATION `[CONFIRMED — structural]`

```
request → JwtAuthGuard → TenantContextGuard → RolesGuard → ModuleEntitlementGuard
        → resolveCommerceActor (fails closed) → service(tenantId = actor.tenantId)
        → repository where = { tenantId, …filter }
```

- The tenant is the FIRST argument of every repository method and the first key of every
  `where` (enforced module-wide by `workflow-configuration.repository.spec.ts` rule C and
  `commerce-schema.spec.ts`); C8's predicates keep that shape and those suites pass
  unchanged.
- `search` can only ADD a narrowing clause BESIDE `tenantId`; there is no code path where
  it replaces or drops the tenant predicate — unit-pinned by the `where` deep-equality
  assertions in `commercial-configuration.search.spec.ts`.
- No client-controlled `tenantId` exists on these routes (§K: unknown params → 422).

---

## P. PAGINATION `[CONFIRMED — one protocol, no second one]`

`page` (≥1) + `pageSize` (default `COMMERCE_DEFAULT_PAGE_SIZE`, ceiling
`COMMERCE_MAX_PAGE_SIZE` from `commerce.constants.ts`), `skip = (page - 1) * pageSize`.
Enforced twice: the DTO (422 above the ceiling) and the service (`Math.min`) — "the DTO
bound is the CONTRACT; the service bound is the GUARANTEE" (`commerce-query.dto.ts`).
No cursor, no offset/limit, no `hasNext`: Commerce lists have never had one and search does
not invent one (brief §18).

---

## Q. PERFORMANCE `[CONFIRMED]`

- **Tenant predicate first, then the filter** — the `where` is `{ tenantId, …search }`, so
  the search never widens a scan beyond one tenant.
- **One statement pair per request**: the page and its `total` are read inside ONE
  array-form `$transaction` (`listGroupPage`, `listConfigurationPage`,
  `listPage`/`listVersionPage`), never a page query plus a separate count computed from a
  different predicate, and never a per-row follow-up.
- **No N+1, no joins**: each search touches exactly the one table the list already read
  (documents, payments, groups, configuration versions, definitions, versions). No
  per-result repository or directory call exists anywhere in the surface (brief §16/§23).
- **Bounded result set**: `skip/take` from the caller's window; the ceiling is 100 rows.
  There is no unbounded read.
- **The `contains` predicate is not index-accelerated** (see §R) and that is the same
  behaviour the five shipped searches have had since step L; C8 adds no new table, no new
  join and no new scan dimension.
- **No search-side caching, no denormalized copy, no second write path** — the filter is a
  pure read predicate, so there is no staleness window to reason about.

---

## R. INDEX STRATEGY `[CONFIRMED — no new index is proven necessary]`

- `contains`/`insensitive` compiles to `ILIKE '%…%'`, which a B-tree index cannot serve, so
  adding one would be a write cost with **no reader** — the exact argument P-AUDIT-READ
  recorded for refusing a speculative index.
- The tables C8 filters are tenant-small: commercial groups, configuration versions and
  workflow versions are per-tenant CONFIGURATION rows (tens, not millions), and their reads
  are already tenant-filtered by `(tenantId, …)` indexes/unique keys that exist in the
  schema (`CommercialGroup_tenantId_code_key`, `CommercialConfigurationVersion_tenantId_status_idx`,
  the definition/version uniques). The purchase document lookup keeps the tenant-first
  index the list already uses.
- `pg_trgm`/GIN/FTS were evaluated for the COMMERCE lists and **rejected**: they would be new
  database extensions and novel matching semantics (trigram similarity, tokenization) that
  no Commerce contract establishes — the shipped semantics are `contains`, and changing
  five working searches to satisfy a phase would be scope creep, not closure.
- **No migration accompanies C8** (brief §35): `git status` shows no new file under
  `prisma/commerce/migrations/`, and `prisma validate` is green.

---

## S. SECURITY `[CONFIRMED — executable]`

What C8 adds is one narrowing predicate inside an existing, already-guarded read path, and
the suite proves the security envelope did not move:

| Property | How it is proven |
|---|---|
| **Authentication** (401) | `C8-E`, `C8-N.4` — an anonymous `?search=` request is refused by `JwtAuthGuard` |
| **Permission** (403) | `C8-E`, `C8-N.4` — a tenant member with NO grant is refused by `RolesGuard`; a read-only member (`commerce.read` only) SUCCEEDS, so the permission is necessary AND sufficient |
| **Entitlement** | route decorators unchanged; `ModuleEntitlementGuard` runs before the handler (the suite's fake allows; the real gate is untouched) |
| **Tenant/actor isolation** | `C8-D`, `C8-N.1..3` — the same identifier in two tenants; each side sees exactly its own row, and `total` never counts the other tenant's |
| **No client-controlled tenant** | `C8-G` — `?tenantId=x` is 422 (undeclared parameter) |
| **Result + total isolation** | `C8-D` — the foreign tenant's number returns `items: []`, `total: 0` |
| **Pagination isolation** | `C8-F` — pages partition the filtered set; `total` is the filtered, tenant-scoped count on every page, including past the end |
| **Sensitive-field exclusion** | no field is added by C8; the search predicate reads only the table's identifying text column (and the projections are the pre-existing ones — §L) |
| **Injection / raw query** | impossible by construction: the filter is a Prisma object literal with a parameterised value; there is no raw SQL, no field name from the request, no operator from the request (brief §19), and `forbidNonWhitelisted` refuses unknown parameters (`C8-G`) |
| **Query-length bound** | `C8-G` — 201 characters is 422 (`MaxLength(200)`) |
| **No Core/HR access** | the repositories reach `commerce_db` only; no file in the change touches another owner's client (the module-wide guards `commerce-isolation.spec.ts` / `workflow-configuration.repository.spec.ts` still pass) |

---

## T. CROSS-MODULE BOUNDARY — AND WHY GLOBAL PARTICIPATION IS BLOCKED

C8 is Commerce-only (brief §22) and did NOT couple bounded contexts. The platform half of
GAP-5 — Commerce records in `GET /search` — is BLOCKED, and the chain is executable
evidence, not an opinion:

1. **The index cannot hold the data where it lives.** `SearchDocument` is a `core_db`
   table (`prisma/core/schema.prisma`) holding `sourceType/sourceId/tenantId/searchText/
   searchVector/embedding`; Commerce rows live in `commerce_db`. Only Commerce's Prisma
   client may read `commerce_db` ("THE ONLY PERSISTENCE HANDLE", repositories not exported,
   guard-pinned). `[CONFIRMED]`
2. **The search pipeline cannot be extended from either side without new platform
   infrastructure.** `SearchIndexerService` projects Core tables with Core's Prisma client;
   `SearchAuthorizer` RE-READS each candidate's authoritative row because "THE INDEX IS NOT
   AN AUTHORIZATION BOUNDARY". For a Commerce source, both would have to reach
   `commerce_db` — which requires a new cross-context port and a composition-root binding,
   i.e. a PLATFORM capability that does not exist today (the repository has done this before
   as its own phase: `PHASE-P-AUDIT-READ` preceded C7's Commerce timeline). `[CONFIRMED]`
3. **The runtime matrix forbids the naive version of it.** `SearchModule` is registered in
   `core-app.module.ts` (Core-only) AND `app.module.ts` (combined), while the Core/CMS
   runtimes mark `COMMERCE_DATABASE_URL` `not-used` and `architecture-boundaries.spec.ts`
   fails any root that names Commerce in those runtimes. A static
   `SearchModule → Commerce` dependency is therefore a build failure by design. `[CONFIRMED]`
4. **The source vocabulary is Core's schema.** Adding a source means adding a member to
   `enum SearchSourceType` in `core_db` — a migration on ANOTHER owner's database, from a
   Commerce phase. `[CONFIRMED]`
5. **Ranking for a new source is an undecided business priority.** `search.constants.ts`
   weights every source by hand (`PRIMARY_SOURCE_WEIGHT` / `OPTIONAL_SOURCE_WEIGHT`) with a
   written rationale per source; C8 may not invent Commerce's weight, and brief §2 forbids
   inventing business priority ordering. `[CONFIRMED]`
6. **The client union would change too.** `apps/web/src/lib/search-api.ts` declares the
   8-member `SearchSourceType` union and an exhaustive `SEARCH_SOURCE_LABELS` record; a new
   server source needs the matching label entry — a frontend change this phase does not make
   (§U). `[CONFIRMED]`

Recorded as a FUTURE PLATFORM CAPABILITY: "search-source federation" — a platform port
(inverted dependency: Commerce supplies projections + an authorization callback, the
platform owns the index, the ranking and the endpoint), plus the Core enum migration and the
web label entries. It is deliberately NOT started here.

---

## U. FRONTEND COMPATIBILITY `[CONFIRMED — no frontend change]`

- The register's search box, the API client (`apps/web/src/lib/commerce-api.ts`) and the
  wire shape are untouched: the response envelope, the field names and the status codes a
  screen consumes are identical, so no UI behaviour changes.
- `CommerceFinalHonesty.spec.tsx` is untouched and still passes item for item: no
  `/commerce/search` call exists, no `tenantId` appears outside a comment, no gap
  vocabulary is rendered. C8 does not need that gate relaxed because it added no UI.
- The register's search contract ("`search` matches `documentNumber` only",
  `CommercePurchaseListView.tsx` header) remains exactly true.
- A future minimal search UI may consume the three C8-closed parameters without a backend
  change; the web gate must be updated in that later phase, not this one.

---

## V. LIMITATIONS `[CONFIRMED]`

1. Search is available only where a Commerce LIST exists; there is no cross-entity search,
   no cross-entity result ranking and no navigation contract for mixed results (none is
   contracted — §J).
2. Matching is `contains` on identifying text only: a Persian-digit or ی/ک variant of a
   document number does NOT match today (§H — an open decision, not an oversight).
3. `search` is matched verbatim (untrimmed): a surrounding space narrows to nothing.
4. Two lists still publish `search` without honouring it (`workflow-instances`,
   `pending-decisions` — §Y.1/§Y.2); C8 reports them rather than guessing a semantic.
5. Global search still does not return Commerce records (§T) — the product half of GAP-5
   that remains blocked.
6. Commerce search is not fuzzy and has no relevance ranking (§G/§I) — by contract.

---

## W. UNKNOWN `[UNKNOWN — stated, not guessed]`

| # | Unknown | Why it stays unknown |
|---|---|---|
| W1 | Whether the PRODUCT wants Commerce records in the global search box, and with what snippet/semantics | UI-0/UI-5 call it GAP-5, but no source states the entity set, the text a Commerce snippet would be cut from (a `PurchaseDocument` has no free text) or the ranking weight |
| W2 | Whether `workflow-instances` / `pending-decisions` should refuse `search` or search their subject's document number | Both are plausible; each needs a product decision (§Y.1/§Y.2) |
| W3 | Whether identifier search should accept Persian digits (`۱۴۰۵`) | The platform normalizer's own digits rule argues yes; the lists' raw `contains` says no. A UX decision (§Y.4) |
| W4 | Whether `PurchaseLine.technicalDescription`/`itemReference`/`externalRef` should be searchable | They exist and are user-facing, but NO contract makes them searchable and the register's read is document-scoped (§Y.3) |
| W5 | Whether an exact-match (non-`contains`) mode is wanted for identifiers | Nothing in the product asks for one; `contains` is what five shipped searches do |

---

## X. REJECTED ASSUMPTIONS (brief §2/§9/§14/§15/§34)

1. **"Add Commerce to the platform search index"** — rejected (not merely deferred): it needs
   a Core-DB enum migration, a new tenant of the platform's authorizer (a source whose
   authoritative row is in another database) and a decidable ranking weight — none of which
   this phase may invent (§T).
2. **"`GET /commerce/search` returning typed mixed results"** — rejected: no consumer, no
   entity set, no cross-type ordering, no route contract; UI-0 §24.2 explicitly rules out a
   parallel command palette, and the frontend gate pins the path as deferred.
3. **"Normalize list search with `normalizeSearchText`"** — rejected: it replaces punctuation
   with spaces and would stop `PR-1405-00012` from matching itself (§H). A second,
   identifier-only folding helper is a decision, not a convenience.
4. **"Fuzzy matching / typo tolerance / trigram similarity"** — rejected: no source, and it
   would change five shipped searches' semantics.
5. **"Relevance scores (exact > prefix > contains, 100/50/10)"** — rejected: no contract
   states a score, and brief §9 forbids inventing one; ordering stays each list's own.
6. **"Search every Commerce table"** — rejected: the coverage matrix (§E) marks what is NOT
   searchable and why; "do not search fields merely because they exist".
7. **"Add a GIN/pg_trgm index for search"** — rejected: no reader for it under `contains`
   semantics, and it would be an extension plus a migration (§R).
8. **"Return the whole tenant's matches in one page"** — rejected: bounded windows only
   (brief §16); the ceiling is 100.
9. **"Enrich results with the requester's name via the directory port"** — rejected: brief
   §23 forbids per-result user lookups, and a Commerce list has never enriched a row; N+1
   directory calls are exactly the pattern the platform search's own authorizer refuses.
10. **"Make the paid/free or status enums searchable"** — rejected: a status word is not an
    identifier; matching it would return rows whose "match" exists only in the query.
11. **"Silently keep the ignored `search` parameters"** — rejected: this module's own DTOs
    call that dishonest (C7 recorded the rule), and three of the five could be honoured
    immediately, which is what C8 did.
12. **"Touch the frontend so the register's box sends the new parameters"** — rejected:
    brief §31 (no frontend phase), the UI contract already declares the register search, and
    the honesty gate would have to be rewritten for no product benefit.

---

## Y. DECISION REQUIRED `[DECISION REQUIRED — listed, not guessed]`

Nine items, in the order they block work. Each names the exact question and the evidence
needed to answer it; none is answered in code by C8.

**Y.1 — `GET /commerce/workflow-instances?search=` is still ignored.** A `WorkflowInstance`
row has no identifying text of its own (it is `subjectType = PURCHASE_DOCUMENT` +
`subjectId`). Two resolutions exist and both are product decisions: (a) refuse the parameter
by giving the route its own DTO without `search` (the C7 `PurchaseTimelineQueryDto`
precedent), or (b) search the SUBJECT document's `documentNumber` (a join the slice already
has, but a semantic nobody has stated). C8 did neither.

**Y.2 — `GET /commerce/pending-decisions?search=` is still ignored.** The inbox merges two
decision systems; a row is an approval/step, not a text-bearing record. Same two options as
Y.1 — refuse, or search the subject document's number in BOTH constituent queries.

**Y.3 — line-level text is not searchable.** `PurchaseLine.technicalDescription`,
`itemReference`, `externalRef` exist and are user-facing, but no Commerce list exposes a
line search and the register's read is document-scoped. Making them searchable is a new
product capability (which endpoint? which fields? document hit or line hit?) — not a fix.

**Y.4 — Persian-digit / ی-ک tolerance for identifier search.** Decide whether `search`
should accept «۱۴۰۵» for `1405`, and ZWNJ/ی-ک variants for labels. If yes, the platform
normalizer needs a companion *identifier* folding helper (digit/letter folding only — NOT the
full text pipeline, which would break `PR-1405-00012`) applied consistently on all seven
lists; if no, the current verbatim behaviour is documented as intended.

**Y.5 — global-search participation (the platform half of GAP-5).** Requires: the entity
set to index; the text to project per entity (a `PurchaseDocument` has only
`documentNumber`); a snippet source; a `SOURCE_WEIGHTS` value for each new source; a
platform port for projections AND authorized re-reads; a `core_db` enum migration; web
label entries. Owner: a platform phase (see §T), then a UI phase for the labels.

**Y.6 — should the two remaining C2 routes (Y.1/Y.2) ever be searched at all?** Answering
"no" is a one-line DTO each; answering "yes" is a new semantic. Silence keeps a parameter
that does nothing.

**Y.7 — is `trim()` wanted on `search`?** The shipped lists pass the raw string (a leading
space narrows to nothing). Trimming would be a UX improvement applied to ALL lists at once —
a deliberate change, not a search-phase side effect.

**Y.8 — should Commerce search results ever be returned for a caller WITHOUT
`commerce.read` via the global search (i.e. is global search allowed to be a second door to
Commerce)?** Today the global search has no Commerce source, so the question does not arise;
it must be answered before Y.5 is built, because the platform search deliberately has no
`@Roles` gate of its own.

**Y.9 — the pre-existing `tenantId` in commercial list rows (UI-0 §R3).** C8 does not
widen it, but it remains in the payload of the two lists C8 touched. Removing it is a
backend hygiene change with its own regression surface (the e2e suites read it via the DB,
not the wire) — recorded here so the decision is not lost.

---

## Z. EXECUTABLE PROOF — HOW THE BRIEF'S E2E LIST (§26) MAPS TO TESTS

`apps/api/test/commerce-search.e2e-spec.ts` — real HTTP, real `commerce_db`, two tenants,
production guards, supertest:

| Brief item | Test | What it asserts |
|---|---|---|
| C8-A purchase search | `C8-A` | exact `documentNumber` + case-insensitive form, `total` 1 |
| C8-B partial search | `C8-B` | `contains` over a shared prefix; `total` = DB count under the same predicate |
| C8-C no result | `C8-C` | 200, `items: []`, `total: 0`, window echoed |
| C8-D tenant isolation | `C8-D` | the SAME number in A and B (DB proves two rows exist); each read returns its own and `total` 1, never 2 |
| C8-E permission | `C8-E`, `C8-N.4` | 401 anonymous; 403 no-grant; 403 no-tenant (exact message); 200 for `commerce.read`-only |
| C8-F pagination | `C8-F` | 3 pages over 5 rows: partition, no duplicate/loss, stable order on re-read, `total` on every page, empty page past the end |
| C8-G query validation | `C8-G` | 422 for 201-char `search`, unknown `tenantId`, `pageSize=101` — on the documents list AND the C8 surfaces |
| C8-H regression | `C8-H` | unfiltered list, `status` filter, document detail unchanged |
| C8-N (the closed surfaces) | `C8-N.1..4` | groups `code`/`name`; configuration `versionLabel`; workflow-version `versionLabel`; each case-insensitive, tenant-isolated with identical literals in both tenants, `total` from the DB, and `commerce.read`-gated |

Unit-level proof:

| Spec | What it pins |
|---|---|
| `commercial-configuration.search.spec.ts` (new) | the exact `where` for both C8 page methods (`tenantId` first, `contains`/`insensitive` on the identifying columns); page and count share ONE `where` OBJECT (`toBe`); ordering/window unchanged; the service forwards `{ search }` + the resolved window and returns the unchanged envelope |
| `workflow-configuration.service.spec.ts` (extended) | `listVersions` forwards `{ status, search }`; with no query the filter keys are present-but-undefined and the window is unchanged |
| `workflow-configuration.repository.spec.ts` | module-wide guard (rule C) still passes: every public repository method takes `tenantId` first and every `where` fragment names the tenant — including C8's new hoisted `const where` |
| `commerce-isolation.spec.ts`, `commerce-schema.spec.ts`, `commerce-gateways.spec.ts` | the ownership/route/schema/gateway bounds are untouched by C8 |

---

## AA. FILES — CREATED, MODIFIED, UNTOUCHED

**Created by C8 (3):**

1. `docs/PHASE-C8-COMMERCE-SEARCH-CONTRACT.md` — this document.
2. `apps/api/src/modules/commerce/commercial/commercial-configuration.search.spec.ts` — the
   new unit spec for the two commercial searches.
3. `apps/api/test/commerce-search.e2e-spec.ts` — the real-HTTP C8 suite.

No other file was created: **no migration** (no schema change), no frontend file, no platform
file, no dependency added.

**Modified by C8 (5):**

1. `apps/api/src/modules/commerce/commercial/commercial-configuration.repository.ts` —
   `CommercialGroupFilter` / `CommercialConfigurationFilter` declared; `listGroups` +
   `countGroups` replaced by `listGroupPage(tenantId, filter, window)` and
   `listConfigurations` + `countConfigurations` by `listConfigurationPage(...)`, each with a
   hoisted `const where` carrying `tenantId` plus the optional search predicate, read as one
   `$transaction` snapshot (the shape `purchase.repository.listPage` already uses).
2. `apps/api/src/modules/commerce/commercial/commercial-configuration.service.ts` — the two
   list methods pass `{ search: query.search }` and the resolved window to the page methods.
3. `apps/api/src/modules/commerce/workflow/workflow-configuration.repository.ts` —
   `WorkflowVersionFilter.search` + the `versionLabel` predicate in `listVersionPage`'s
   shared `where`.
4. `apps/api/src/modules/commerce/workflow/workflow-configuration.service.ts` —
   `listVersions` forwards `search` in the filter object.
5. `apps/api/src/modules/commerce/workflow/workflow-configuration.service.spec.ts` — two new
   C8 tests.

**Pre-existing files untouched by C8 (the working tree's other 80+ entries):** every C1–C7 /
UI / P-AUDIT-READ file, all `apps/web/**`, all `prisma/**` (no migration), the platform
search module (`apps/api/src/search/**` — not one line), `commerce.module.ts`,
`commerce-query.dto.ts` (the parameter is documented there, unchanged), the three other
search services, CI configuration and dependencies.

---

## AB. GIT STATUS `[CONFIRMED]`

- HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`, **no commit, no reset, no
  clean, no checkout, no rebase** — only file edits, exactly as the brief requires.
- 89 porcelain entries now: 81 pre-existing (C1–C7 / UI / P-AUDIT-READ work) + C8's 8
  (3 created `??`, 5 modified ` M`). The two pre-existing C1-M files C8 touched
  (`workflow-configuration.*`) were already carriers of the earlier work; C8's edits sit on
  top of them and nothing else in those files changed.
- No `prisma/commerce/migrations/**` entry was added or edited; the two untracked migration
  directories are C4-R's and C2's, untouched.

---

## AC. VALIDATION EXECUTED (brief §40)

All commands run from `apps/api`; `npx` is blocked by this machine's PowerShell execution
policy (an environment fact recorded by earlier phases), so the tools are invoked through
`node node_modules/...` / the hoisted root install.

| # | Gate | Command | Result |
|---|---|---|---|
| 1 | C8 unit spec | `jest src/modules/commerce/commercial/commercial-configuration.search.spec.ts` | **1 suite / 7 tests pass** |
| 2 | Workflow service spec (extended) | `jest src/modules/commerce/workflow/workflow-configuration.service.spec.ts` | pass (31 tests in the two-suite run above) |
| 3 | Full commerce module suite | `jest --runInBand src/modules/commerce` | **43 suites / 666 tests pass** (baseline 42/657 → +1 suite, +9 tests) |
| 4 | Architecture + policy + isolation | `jest --runInBand src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts src/modules/commerce/commerce-isolation.spec.ts` | **3 suites / 90 tests pass** |
| 5 | C8 real-HTTP E2E | `jest --config ./jest-e2e.json --testPathPattern commerce-search` | **1 suite / 14 tests pass** |
| 6 | Existing Commerce E2E (regression) | `jest --config ./jest-e2e.json --testPathPattern 'commerce-(integration\|lifecycle\|tenant)'` | **3 suites / 74 tests pass** |
| 7 | Full API unit suite | `jest --runInBand --silent` | **205 suites / 3346 tests pass** (baseline before C8: 3337 → +9, the C8 tests) |
| 8 | TypeScript | `tsc --noEmit -p tsconfig.json` | **clean, no output** |
| 9 | Prisma validate | `prisma validate --schema=prisma/commerce/schema.prisma` and `… core …` | **both valid** |
| 10 | Prisma generate / migrate deploy | not run | **no schema changed and no migration exists** — regenerating clients that cannot differ and deploying nothing would be theatre, and `tsc` green already proves the generated clients still match the code |
| 11–24 | frontend gates | not run | **no frontend file was touched** (brief §31 default) |

Baseline vs C8 vs environment: the baseline is `HEAD c0fab92` + the pre-existing uncommitted
work; C8's delta is the +1 suite/+9 tests above; no result in this table depends on the
deployment/runtime state beyond a reachable Postgres for the two E2E rows.

---

## AD. ACCEPTANCE CRITERIA (brief §38)

| Criterion | State | Evidence |
|---|---|---|
| Search scope explicitly defined | ✅ | §D — "selected entities, inside Commerce", both halves stated |
| Searchable entities source-backed | ✅ | §E matrix, per-row citations |
| Searchable fields source-backed | ✅ | §F — `code`/`name`, `versionLabel`, `documentNumber`, payment refs |
| Matching semantics explicit | ✅ | §G — `contains`, `insensitive`, verbatim, single needle |
| No arbitrary fuzzy/relevance logic invented | ✅ | §G/§I, §X.4/§X.5 |
| Correct endpoint architecture chosen | ✅ | §J — specialized lists; B/C rejected/blocked |
| Authentication enforced | ✅ | C8-E (401), C8-N.4 |
| Commerce entitlement enforced | ✅ | route decorators unchanged; suite boots `ModuleEntitlementGuard` |
| Existing permission semantics preserved | ✅ | §M; C8-E/C8-N.4 (403 without `commerce.read`, 200 with only it) |
| Tenant isolation structural | ✅ | §O; C8-D, C8-N.1–3; unit-pinned `where = { tenantId, … }` |
| No `tenantId` client input | ✅ | C8-G (422 on `?tenantId=`), §K |
| Safe result projection | ✅ | §L — no field added; pre-existing projections only |
| Sensitive fields excluded | ✅ | §F (opaque ids/enums/payloads not searchable), §S |
| Pagination bounded | ✅ | C8-F, §P; ceiling 100 |
| Ordering deterministic | ✅ | C8-F (repeat read identical; `createdAt desc, id asc`) |
| Query limits enforced | ✅ | C8-G (201 chars → 422) |
| Database/query strategy justified | ✅ | §Q |
| Required indexes proven | ✅ | §R — none proven necessary; no index added |
| No N+1 | ✅ | §Q — one page+count snapshot per request |
| No cross-module DB access | ✅ | §T; guards green |
| No enterprise search engine invented | ✅ | §J/§X — nothing new was built; the platform index is untouched |
| Real HTTP E2E passes | ✅ | C8-A…H, C8-N.1–4 (14/14) |
| Tenant isolation E2E passes | ✅ | C8-D, C8-N.1–3 |
| Permission E2E passes | ✅ | C8-E, C8-N.4 |
| Pagination E2E passes | ✅ | C8-F |
| Existing Commerce regressions green | ✅ | 43/666 module suite + 3 suites/74 tests of existing E2E |
| Architecture/isolation/policy green | ✅ | 3 suites / 90 tests |
| TypeScript green | ✅ | `tsc --noEmit` clean |
| Prisma valid | ✅ | commerce + core schemas valid; no migration |
| Documentation complete | ✅ | this document |
| No Reporting/Quotation/Notification work | ✅ | §B, §AA — none touched |

**Not achieved, and classified rather than faked:** global-search participation (§T — blocked
by contract, exact decisions listed in §Y) and the two still-unhonoured C2 parameters (§Y.1/§Y.2).

---

## FINAL STATUS

**`COMMERCE BACKEND PARTIALLY COMPLETE — GAP-5`**

- **Commerce-side search: CLOSED and proven.** Every Commerce list that publishes `search`
  and has a confirmed identifying column now honours it (`documentNumber`; payment refs;
  `versionLabel` ×3; `code`/`name` ×2), tenant-structurally, permission-gated, bounded and
  deterministic — with 14 real-HTTP tests, 7 new unit tests and the module's whole 666-test
  suite green.
- **Platform-side search (the other half of UI-0's GAP-5): BLOCKED BY CONTRACT** — §T gives
  the six-point executable chain and §Y.5 names what a platform phase must decide; nothing
  was invented and nothing was coupled.
- **No further phase was started.** GAP-4 / GAP-6 / GAP-8 / GAP-9 / GAP-ENV are untouched.

---

**END OF DOCUMENT — `PHASE C8 · GAP-5 · COMMERCE BACKEND PARTIALLY COMPLETE`**
