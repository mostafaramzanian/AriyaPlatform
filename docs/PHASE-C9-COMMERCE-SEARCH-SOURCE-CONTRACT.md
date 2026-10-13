# PHASE C9 — COMMERCE / PLATFORM GLOBAL SEARCH SOURCE ADAPTER (GAP-5)

**Phase:** C9 · **Repository:** `E:\ERP` · **Gap:** GAP-5 (Global Search) only

**Classification tags** (used on every important claim): `[CONFIRMED]` read directly in
source · `[DERIVED]` logically follows from confirmed source · `[PROPOSED]` a suggestion,
not implemented · `[UNKNOWN]` · `[DECISION REQUIRED]`.

**Git baseline (§53):** HEAD `c0fab92c8f5394253353478348feef1edfd4888e`, branch `master`,
with the pre-existing uncommitted C1–C8 / UI / P-AUDIT-READ / P-SEARCH-SOURCE work
recorded at 103 porcelain entries by that phase. C9 started from that state, **made no
commit, no reset, no checkout, no rebase**, and its own footprint is listed in §Y. The
working tree counted **110 porcelain entries** at C9's midpoint (C9's additions included).

---

## A. DISCOVERY — what C9 found before writing a line

| Fact | Source | Tag |
|---|---|---|
| P-SEARCH-SOURCE is complete: `SEARCH_SOURCE_PORT` (`register` → namespace-bound handle → `project`/`remove`), `SearchSourceAdapter`, `SearchProjectionRecord`, `SearchSourceAuthorizationRequest/Result`, `EXTERNAL` marker, `sourceKey` column, two weight CLASSES, composed route hrefs, fail-closed batched authorization | `docs/PHASE-P-SEARCH-SOURCE-CONTRACT.md`, `src/platform/search-source/search-source.contract.ts` | `[CONFIRMED]` |
| C8 closed the Commerce-side **list** search and recorded Global Search participation as BLOCKED BY CONTRACT, with §Y decisions (Y.5 entity set/fields/weight, Y.7 trim, Y.8 permission-via-search) | `docs/PHASE-C8-COMMERCE-SEARCH-CONTRACT.md` §T/§Y | `[CONFIRMED]` |
| The platform left the Commerce decisions TO THIS PHASE: weight class (§AA.1), `commerce.read` reachability (§AA.2), web label (§AA.3), `sourceType=EXTERNAL` filter (§AA.4), multi-source presentation (§AA.5) | `PHASE-P-SEARCH-SOURCE-CONTRACT.md` §AA | `[CONFIRMED]` |
| Platform backfill of external rows is **not applicable today** — the source pushes projections; no platform-side reader of source databases exists | P-SEARCH-SOURCE §Z | `[CONFIRMED]` |
| UI-0 defines GAP-5 as "Commerce items in global search", with "Purchase document search" as the concrete surface; workflow-instance/pending-decision search semantics were never decided (C8 §W2) | `PHASE-UI-0-COMMERCE-UX-CONTRACT.md` §21.5/§26-GAP-5 | `[CONFIRMED]` |
| `PurchaseDocument` has exactly one human-facing identifier: `documentNumber` (`VarChar(64)`, tenant-unique, minted once). Requester/supplier are opaque ids; kind/status are enums; a `PurchaseLine` has its own text (`technicalDescription`, `itemReference`, `externalRef`) but line-level search has no contract | `prisma/commerce/schema.prisma` | `[CONFIRMED]` |
| Every Commerce read route is `@Roles(Permissions.COMMERCE_READ)` + `@RequiresModule/@RequiresFeature` + `ModuleEntitlementGuard`, with `resolveCommerceActor` supplying the tenant | `purchase.controller.ts` and the other 9 controllers | `[CONFIRMED]` |
| The RolesGuard asks `PermissionSource` (`platform/auth/permission-source.contract.ts`); `RbacModule` provides and EXPORTS it; `HrModule` precedent shows a business module importing `RbacModule` | `rbac.module.ts`, `platform-entitlement.module.ts` doc | `[CONFIRMED]` |
| Module policy forbids entitlement references outside controllers and `commerce.module.ts` — services, gateways, repositories and DTOs included | `commerce-entitlement.spec.ts` test H (§14 H) | `[CONFIRMED]` |
| The existing purchase detail route is `/admin/commerce/purchases/[id]` | `apps/web/src/app/admin/commerce/purchases/[id]/page.tsx` | `[CONFIRMED]` |
| Web labels live client-side (`SEARCH_SOURCE_LABELS`, exhaustive over the eight platform sources); `SearchQueryDto` deliberately does NOT accept `sourceType=EXTERNAL` | `apps/web/src/lib/search-api.ts`, `search/dto/search-query.dto.ts` | `[CONFIRMED]` |

## B. PLATFORM PREREQUISITE — consumed, not re-created

`P-SEARCH-SOURCE` is consumed **exactly**: the adapter imports only
`SEARCH_SOURCE_PORT` + the contract's types; registration happens once at composition
(the port's own rule: a malformed registration fails the boot); projections are pushed
through the namespace-bound handle; authorization answers the platform's ONE batched
question with the platform's result shape, re-read from `commerce_db`. No Core Prisma,
no `SearchDocument`, no `core_db`, no search table, no enum migration, no new weight
value, no platform switch case — all asserted by `commerce-gateways.spec.ts` (§Y) and
by the architecture suites. `[CONFIRMED]`

## C. COMMERCE SOURCE KEY

**`commerce.purchase-document`** `[DERIVED]`

Evidence: the platform contract's own key grammar
(`SEARCH_SOURCE_KEY_PATTERN = ^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`) and its documented
example shape `commerce.purchase-document` (P-SEARCH-SOURCE §E/§W literally show a
`commerce.<entity>` key with the hyphen separator). The Commerce entity is
`PurchaseDocument`; the module's dotted vocabulary for it elsewhere is
`commerce.purchase_document` (the audit resource), but the underscore form is INVALID as
a source key, so the hyphen spelling is the one the grammar permits. One source, one
key: no second Commerce key exists or is planned. The key is stable, source-owned, never
user-controlled, and never a label (labels live in the web client). `[CONFIRMED — grammar,
example shape in P-SEARCH-SOURCE]`

## D. SEARCHABLE ENTITIES

Exactly ONE: **`PurchaseDocument`**. Classification of the whole inventory:

| Entity | Class | Why |
|---|---|---|
| PurchaseDocument | **CLOSED** | The one entity UI-0 names for GAP-5 ("Purchase document search"); contract, permission, route, projection and lifecycle all established below |
| Commercial Group / Commercial Configuration | **NOT A SEARCH SOURCE** | Configuration vocabulary, reachable from Settings; no source asks for Global Search participation (C8 §J: no cross-entity endpoint, no global-search ask) |
| Workflow Definition Version | **NOT A SEARCH SOURCE** | Configuration; same reasoning |
| Workflow Instance | **DECISION REQUIRED (out of scope)** | C8 §W2: search semantics never decided; brief §20 forbids adding it without an authoritative contract |
| Pending Decision | **DECISION REQUIRED (out of scope)** | Inbox ≠ Global Search (brief §20); C8 §Y.1 still open |
| Line Routing Version / Completion Policy Version | **NOT A SEARCH SOURCE** | Configuration versions, same reasoning as workflow versions |
| Payment / Receipt / Return rows | **NOT A SEARCH SOURCE** | Append-only evidence hung off a document; the document is the searchable unit; exposing them would be scope creep (brief §48–§51) |
| Quotation surfaces | **BLOCKED BY CONTRACT** (GAP-6) | Untouched |

`[CONFIRMED for PurchaseDocument; DECISION REQUIRED marks the two items the brief
explicitly forbids inventing]`

## E. SEARCHABLE FIELDS

`searchContent = [documentNumber]`, verbatim. NOTHING else: no `requesterId`,
`supplierId`, `currency`, amounts, `status`, `kind`, no line text, no UUID as content.
C8 §Y.5 states it plainly — "a `PurchaseDocument` has only `documentNumber`" — and the
schema confirms there is no free text on the document. Line-level text
(`technicalDescription`, `itemReference`, `externalRef`) is EXCLUDED: brief §21 forbids
indexing every line without an explicit contract, and document-level search answers
"where is this record?". `[CONFIRMED]`


## F. SOURCE CLASS — PRIMARY

The descriptor declares `weightClass: 'PRIMARY'` — a CLASS, never a number.
`SEARCH_WEIGHT_CLASS_FACTORS.PRIMARY = 1` (49J's own constant) is the only magnitude
that can result, and Commerce chose no value. `[DERIVED — applying 49J's published class
definitions, because platform §AA.1 delegates the choice to this phase]`

Rationale, from `search.constants.ts` rather than preference: the optional (0.6)
multiplier exists for "low-signal, high-volume" and "machine-generated" text
(NOTIFICATION, REMINDER) and for labels `ts_rank_cd` flatters (CONVERSATION); full
weight belongs to AUTHORED, INTENTIONAL records (TICKET, SURVEY, MESSAGE, COMMENT). A
purchase document number is authored, intentional, tenant-scoped and low-volume, and
searching it is exactly the "where is this record?" question Global Search exists to
answer. SUPPORTING's definition does not fit it; PRIMARY's does. No platform constant,
formula or ordering was touched. E2E `C9-G` proves the multiplier actually served is 1.

## G. PERMISSION — `commerce.read`, required, through the RolesGuard's own seam

Answering C8 §Y.8 / platform §AA.2: **NO — a caller without `commerce.read` may not reach
a Commerce result.** `[DERIVED]`

- Every Commerce read route is `@Roles(Permissions.COMMERCE_READ)`; the search result
  navigates to such a route, so search can be neither a broader nor a different door.
- The adapter asks `PermissionSource.getEffectivePermissions(userId, null)` — the SAME
  port `RolesGuard` consults, so there is exactly one permission authority for
  `commerce.read` and no second implementation of the catalogue. `claims: null` means
  "Core is the authority" (the port's documented meaning); in the combined runtime —
  the only runtime Commerce ships in — this is the same answer the guard's
  legacy-token path gets.
- NO new permission: `commerce.search`, `commerce.global-search` and friends do not
  exist anywhere in the change; the module's six `commerce.*` names are unchanged.
- The check runs ONCE per authorization call, BEFORE any row is read (no database work
  for an actor who cannot read), fail-closed to `{ entries: [] }`.

## H. ACTOR

`SearchSourceActorContext { userId, tenantId }`, built by the platform from the
authenticated request and passed trusted — the contract's explicit rule (§"the platform
never tells a source what its authorization is"). Commerce treats `userId` as the
subject for its own permission rule and `tenantId` as the tenant boundary; no client
field can state either (`SearchQueryDto` carries only `q/limit/offset/sourceType`).
E2E proves identity comes from the session: 401 without a principal. `[CONFIRMED]`

## I. TENANT

Structural, not conventional: the ONLY row source is
`PurchaseRepository.findDocumentSearchRowsByIds(tenantId, ids)`, whose FIRST parameter
is the actor's tenant and whose `where` names it — the repository-wide rule C that
`workflow-configuration.repository.spec.ts` C-test scans for. An id from another tenant,
a stale id and a non-existent id are indistinguishable to the adapter (absent from the
Map) and all answer "nothing". The index row's `tenantId` is additionally stamped by
the platform from the projection record, and retrieval itself applies the scope's tenant
predicate — but neither is trusted: authorization re-reads. E2E `C9-B` mints the SAME
document number in two tenants and proves results, `count` and `sourceCounts` never
cross. `[CONFIRMED]`

## J. PROJECTION

```ts
{ entityId: id, tenantId, searchContent: [documentNumber], sourceUpdatedAt: updatedAt }
```

Source-owned, exact-key (`SearchProjectionRecord`), validated by the platform's own
`validateSearchProjectionRecord` in the unit gate. No raw Prisma object crosses; the
record is built by the pure `purchaseSearchProjection()` from a narrow structural
input. The authorized ENTRY (query time) carries `entityId`, `title = documentNumber`,
`snippetFields = [documentNumber]`, `timestamp = updatedAt` — all four keys, nothing
else, validated against `validateSearchSourceAuthorizationResult`. No subtitle exists in
the envelope (platform §44: "subtitle if supported" — it is not), no tenant id, no
requester/supplier, no money, no status. `[CONFIRMED]`

## K. SEARCH TEXT

Verbatim `documentNumber`. Commerce performs NO normalization — no trim, no case fold,
no Persian-digit translation, no stemming. The projection is raw text and the PLATFORM's
one pipeline (`buildSearchText` → `normalizeForQuery === normalizeForIndex`) normalizes
it, which is what makes query and index unable to disagree. The unit gate asserts
whitespace in the source string survives into the record untouched. `[CONFIRMED]`

## L. NORMALIZATION (C8 §W3 / §Y.4, brief §22/§23)

Nothing invented, nothing changed:
- **Persian digits:** if the platform normalizer folds them (it does — C8 §C measured
  the fold), a query in Persian digits matches a Latin-digit document through the
  platform's existing behavior; Commerce added no preprocessing of its own. The
  open PRODUCT question (should identifier search accept `۱۴۰۵`?) stays recorded as
  C8 §Y.4 — unchanged, not resolved by C9.
- **Trim:** `SearchQueryDto` already trims `q` platform-side; projections are stored
  untrimmed and normalized by the platform. Commerce neither trims stored data nor
  search input (C8 §Y.7 unchanged).
`[CONFIRMED — reuse; DECISION REQUIRED remains the two C8 UX questions]`

## M. ROUTE TARGET

Descriptor template: **`/admin/commerce/purchases/:id`** — the EXISTING detail route
(`apps/web/src/app/admin/commerce/purchases/[id]`). The platform validates the template
at registration (`validateSearchSourceRouteTemplate`) and composes the href with
`encodeURIComponent(id)`; Commerce never emits a URL. E2E `C9-A` asserts the exact
composed href; the unit gate proves an id containing `/ ? #` becomes opaque text. No new
page, no new destination. `[CONFIRMED]`


## N. AUTHORIZATION ADAPTER

`CommerceSearchSourceService implements SearchSourceAdapter` (`search/commerce-search-source.service.ts`):

1. `actor.tenantId === null` or an empty id list → `{ entries: [] }`, zero calls.
2. `commerce.read` via `PermissionSource` → deny answers `[]` before any row is read.
3. ONE `findDocumentSearchRowsByIds(actor.tenantId, entityIds)` — batch, tenant-first,
   no N+1 (a single query regardless of candidate count; the platform's batch cap is
   `MAX_MERGED_CANDIDATES = 150`).
4. Map lookup per requested id (deduplicated — a repeated id must not be able to
   invalidate the whole answer), entries in requested order.

A repository failure is NOT swallowed: the throw reaches the platform, which drops every
candidate from this source and logs it under the source key — fail-closed, never an
"empty = healthy" lie. Entitlement is deliberately NOT consulted here: module policy
§14 H confines entitlement to controllers + the module definition, and the detail route
a result opens enforces it at the boundary. No Commerce rule is copied into Search, no
request per result, no directory lookup per result. `[CONFIRMED — brief §13/§14/§30/§31]`

## O. INDEXING LIFECYCLE (brief §24)

`PurchaseService.create` → `await this.search.projectDocument(document)` — AFTER the
write commits, beside the audit row, with the WRITTEN row (never the intent). This is
the only act that can change anything the projection depends on:

- `documentNumber` is minted once, inside the create transaction; `updateEditableDocument`
  cannot name the column, so no UPDATE can change searchable text;
- title/timestamp are read from the AUTHORITY at authorization time, not from the index;
- the route is a constant; readability depends on permission + tenant, neither stored.

Therefore update/submit/close/completion push NOTHING (an update would rewrite the same
record — a no-op the platform neither needs nor benefits from), and the unit gate pins
"exactly one projection" for the created document. Indexing is synchronous within the
create request (awaited, then failure-logged) — no queue, worker, cron or polling was
created, per brief §27. Backfill of pre-existing rows: NOT done, and not required —
platform §Z states there is no platform-side reader of source databases and the source
pushes projections; C9 records it under §AB for a future decision. `[CONFIRMED for the
create-hook; backfill → §AB]`

## P. REMOVAL (brief §25)

No removal path exists: this database deletes no purchase document ("no lifecycle
deletion path exists anywhere in this database" — the schema's own comment), no Commerce
route deletes one, and status transitions (SUBMITTED/CLOSED/CANCELLED-style states) are
NOT removal — documents of every status stay readable under `commerce.read`. So
`RegisteredSearchSource.remove` is deliberately never called and no removal semantics
were invented; the unit gate asserts `handle.remove` is never touched. If Commerce ever
gains a real deletion path, the same handle already provides namespace-scoped idempotent
removal. `[CONFIRMED]`

## Q. STALE BEHAVIOR (brief §26)

The index row can outlive the row (drift, manual delete). Because authorization
re-reads, the stale candidate simply yields no entry and disappears from results,
`count` and `sourceCounts` alike — proven end to end by E2E `C9-E`, which asserts the
index row is STILL PRESENT while the result is gone. A Commerce-specific cache was not
created; the authoritative re-read was not weakened. `[CONFIRMED]`

## R. RANKING COMPATIBILITY (brief §34)

Commerce supplies projection data only. `SOURCE_WEIGHTS`, `SEARCH_WEIGHT_CLASS_FACTORS`,
the merge formula, tie-breaks and truncation are untouched; the descriptor names a CLASS
and the platform maps it (`weightMultiplier('commerce.purchase-document') === 1`, E2E
`C9-G`). No Commerce relevance score exists anywhere in the change. `[CONFIRMED]`

## S. PAGINATION COMPATIBILITY (brief §33)

No Commerce page size: `DEFAULT_SEARCH_LIMIT`/`MAX_SEARCH_LIMIT` and offset paging over
the AUTHORIZED list apply unchanged; `count`/`hasMore` are computed by the platform from
the authorized set. E2E asserts `count === results.length` for the tested windows and
the 41-test `search.e2e` suite re-runs the platform's own pagination contract.
`[CONFIRMED]`

## T. WEB LABELS (brief §18/§38) — minimal compatibility only

- `apps/web/src/lib/search-api.ts`: `'EXTERNAL'` joins the wire union;
  `SEARCH_SOURCE_LABELS` stays exhaustive over `PlatformSearchSourceType` (the eight);
  a new `SEARCH_EXTERNAL_SOURCE_LABELS` maps source KEYS to labels —
  `'commerce.purchase-document' → «سند درخواست خرید»`, the canonical document term of
  UI-0 §33 / UI-5-C (never «سند خرید»); `searchSourceLabel(result)` resolves any badge
  (platform label / key label / «سایر» fallback, all existing vocabulary).
- `CoreGlobalSearch.tsx`: the result badge calls `searchSourceLabel(result)` — ONE line.
  Nothing else changed: same component, same RTL layout, same states, no new screen.
- The facet chip list is unchanged (§U). Tests: `search-api.spec.ts` (labels + helper)
  and `CoreGlobalSearch.spec.tsx` (EXTERNAL badge + composed-href navigation).
`[CONFIRMED — terminology; PROPOSED nothing]`

## U. FACET BEHAVIOR (brief §39)

No EXTERNAL facet chip and no filter change. Reason, not preference: `SearchQueryDto`
validates `sourceType` against the eight platform literals — a platform decision
P-SEARCH-SOURCE §AA.4 explicitly deferred — so a chip for `EXTERNAL` would be a control
that 422s. External results appear under the default "همه" view with their own badge;
`sourceCounts.EXTERNAL` is served (facet-ready) but the UI does not offer it. E2E `C9-I`
pins the 422 so a future platform change to the allowlist is a conscious act.
No platform code change was made solely to support external filtering (documented here
as required by brief §39). `[CONFIRMED]`


## V. E2E — REAL HTTP (brief §43)

`apps/api/test/commerce-search-source.e2e-spec.ts` — real `GET /search` + real
`POST /commerce/purchase-documents`, real `commerce_db` + real `core_db`, production
boundary stack (probe strategy is the suite's identity seam; Commerce platform ports are
in-memory exactly as every C1–C8 suite; `SearchModule`, `PlatformSearchSourceModule`,
Core `PrismaModule` and the adapter are REAL):

| Test | Asserts |
|---|---|
| fixtures | three tenant-A documents + one tenant-B document mint the SAME number (fresh per-run tenants); a Core reminder (real `User` FK) is indexed by the EXISTING `SearchIndexerService` |
| C9-A | EXTERNAL result with `sourceKey`, `sourceId`, number-as-title, snippet, timestamp, score ∈ (0,1], exact composed href `/admin/commerce/purchases/:id`, envelope shape, `sourceCounts.EXTERNAL === 1`, NO forbidden field/tenant id/identity on the wire, index row exists with tenant stamp + only the number in `searchText` |
| C9-B | same number in two tenants: each actor sees exactly its own row; `count` and `sourceCounts` never leak the other tenant; the other document's id never appears in the raw response |
| C9-C | revoking `commerce.read` (mutable grant table, the seam RolesGuard asks) removes an already-indexed result while the index row REMAINS; restoring brings it back |
| C9-D | a DRAFT edit keeps matching, keeps exactly ONE projection, and the supplier value is not searchable |
| C9-E | direct row deletion (simulated drift — Commerce has no deletion path) leaves the index row present while the result disappears |
| C9-F | a platform REMINDER result still returns, with its previous wire shape (`sourceKey` absent), coexisting with Commerce results in one response |
| C9-G | `weightMultiplier('commerce.purchase-document') === 1`; all scores ∈ (0,1] |
| C9-H | `commerce.read`-only principal sees the result; zero-grant principal gets 200 with NO Commerce result; no principal is 401 |
| C9-I | `sourceType=EXTERNAL` → 422 `VALIDATION_FAILED` (the documented platform allowlist) |

Result: **1 suite / 10 tests pass**. Regression battery (same run):
`commerce-search` (C8) + `search.e2e` (49J) + `search-source` (P-SEARCH-SOURCE) +
`commerce-integration` + `commerce-lifecycle` + `commerce-tenant` = **6 suites /
142 tests pass**, total **7/152**. `[CONFIRMED]`

## W. SECURITY (brief §41/§44/§57)

- Authorization is authoritative: readable row → result; unreadable (no grant, wrong
  tenant, gone row) → absent. E2E covers each; unit covers tenant-less actor, empty
  batch, dedupe and the "no swallow" failure rule.
- No forbidden field anywhere: projection keys are exact; entries are exact; the raw
  response JSON is scanned for `tenantId/requesterId/supplierId/passwordHash/embedding/
  searchText/documentNumber"` and for the tenant/user UUIDs themselves.
- No arbitrary URL: template-only descriptor, platform-composed + encoded href.
- No new permission, no `@Public`, no gate removed; `commerce-gateways.spec.ts` pins
  the ONE surface holding `SEARCH_SOURCE_PORT` and the module's import of the seam.
- Fail-closed everywhere: permission deny → `[]`; row absent → `[]`; adapter throw →
  whole-source drop; registration error → boot failure. `[CONFIRMED]`

## X. PERFORMANCE (brief §31/§32)

- Authorization: 1 permission call + 1 batched repository query per search, regardless
  of candidate count (≤150 ids, deduped). No N+1, no directory call, no detail endpoint.
- Retrieval: unchanged platform SQL (tenant predicate, `ts_rank_cd`, existing indexes);
  `documentNumber` is indexed by the tenant-unique key `PurchaseDocument_tenantId_documentNumber_key`,
  and reads filter `tenantId, id IN (…)` — no table scan, no OR across text columns.
- Write path: one awaited `project` per create (one platform write pass; embedding
  latches on missing credentials as the platform already does). No second search engine,
  no queue, no polling. `[CONFIRMED]`

## Y. FILES

**Created (4 + 1 doc):**

| File | Role |
|---|---|
| `apps/api/src/modules/commerce/search/commerce-search-source.service.ts` | The adapter: descriptor, registration, projection push, authoritative re-read |
| `apps/api/src/modules/commerce/search/commerce-search-source.service.spec.ts` | 13 unit tests against the platform's OWN validators |
| `apps/api/test/commerce-search-source.e2e-spec.ts` | C9-A…C9-I real-HTTP e2e (10 tests) |
| `docs/PHASE-C9-COMMERCE-SEARCH-SOURCE-CONTRACT.md` | This document |

**Modified by C9 (12):** `commerce.module.ts` (imports `PlatformSearchSourceModule` +
`RbacModule`, provides the adapter) · `purchase.service.ts` (inject + create-hook) ·
`purchase.service.spec.ts` (mock + 2 tests) · `purchase.repository.ts` (the one batch
read) · `commerce-gateways.spec.ts` (fourth ONE-surface rule) ·
`commerce-isolation.spec.ts` (D7 accounting + measured silence) ·
`apps/api/test/commerce-{search,integration,lifecycle,tenant}.e2e-spec.ts` (fake port +
provider) · `apps/web/src/lib/search-api.ts` (+spec) ·
`apps/web/src/components/core/CoreGlobalSearch.tsx` (+spec).

**Pre-existing files untouched:** no migration, no Prisma schema edit, no platform
`src/search/**` or `src/platform/search-source/**` change, no search algorithm change,
no Settings/Reporting/Quotation/Audit/Notification code. (The working tree still carries
the pre-existing C1–C8/P-* modifications recorded in the baseline.)

## Z. REMAINING COMMERCE GAPS

GAP-4 Reporting/KPI **DEFERRED** · GAP-6 Quotation **BLOCKED BY CONTRACT** · GAP-7 Audit
**CLOSED (C7)** · GAP-8 Member/seed **PARTIAL** · GAP-9 Notifications **OPEN** ·
GAP-ENV Deployment **OPEN**. Within GAP-5 itself: workflow-instance and pending-decision
global-search participation remain **DECISION REQUIRED** (§AB) — implemented none of them
by design. `[CONFIRMED]`


## AA. UNKNOWN

None blocking. The previously-unknown items that C9 RESOLVED are recorded above (entity
set, fields, class, permission, route, lifecycle). Residual unknowns are the two C8 UX
questions (Persian-digit acceptance, trim UX — §L) and how a future UI phase may want to
regroup multiple external sources under the one `EXTERNAL` facet (platform §AA.5) — none
of them a C9 contract gap.

## AB. DECISION REQUIRED (recorded, not taken)

1. **Workflow Instance / Pending Decision as Global Search sources** — semantics never
   decided (C8 §W2/§Y.1). C9 implemented neither, per brief §20. Owner: a product phase.
2. **Backfill of pre-existing `PurchaseDocument` rows** — C9 projects at create, so rows
   minted before the deployment are not in the index until they are next written (they
   are NOT stale — authorize would return them, they simply were never pushed). Platform
   §Z says no platform-side backfill exists for external sources; a Commerce-side one-shot
   projection stream is a deliberate follow-up, not invented here. Owner: a small
   Commerce phase or an operational script.
3. **`sourceType=EXTERNAL` as a query filter + an EXTERNAL facet chip** — platform
   product decision (§AA.4/§AA.5); pinning test `C9-I` keeps the current answer visible.
4. **Persian-digit / trim UX on identifier search** — C8 §Y.4/§Y.7, unchanged.
5. **Weight-class re-assignment** — if the product ever wants Commerce results ranked as
   SUPPORTING, it is a one-line descriptor change (`'PRIMARY' → 'SUPPORTING'`) with no
   platform edit; the mechanism is P-SEARCH-SOURCE's, the choice documented in §F.

## AC. REJECTED ASSUMPTIONS

- ❌ "Register every list-searchable entity as a source" — rejected: Global Search is a
  different product capability (brief §7/§19); only PurchaseDocument has a contract.
- ❌ "`commerce.purchase_document` as the source key" — rejected: the underscore fails
  `SEARCH_SOURCE_KEY_PATTERN`; the platform's hyphen example shape wins (§C).
- ❌ "Index supplier, requester, line text or status because the lists search them" —
  rejected: C8's list semantics authorize no Global Search field (brief §8); only
  `documentNumber` (§E).
- ❌ "Add a Commerce normalizer for Persian digits/case/trim" — rejected: one platform
  pipeline, or the query and the index disagree (brief §9/§22/§23).
- ❌ "Check entitlement inside the adapter" — rejected by module policy §14 H
  (entitlement lives at controllers + the module definition), with the boundary gate
  still enforcing the detail route.
- ❌ "Invent `commerce.search`, a numeric weight, a relevance score or a removal path" —
  rejected: none exists in any contract (§F/§G/§P/§R).
- ❌ "Push projections on update/submit/close, or build a queue/cron/worker" — rejected:
  nothing those acts change is stored in the index (§O); brief §27 forbids new
  scheduling infrastructure.
- ❌ "Add an EXTERNAL facet/filter now" — rejected: the DTO's allowlist is a platform
  decision (§U, `C9-I`).
- ❌ "Modify `SearchQueryDto`, `SOURCE_WEIGHTS`, the ranking formula or any
  `src/search/**` file" — rejected and verified untouched (§Y).
- ❌ "Commerce → SearchDocument/Core Prisma" — rejected by construction and by scan
  (§N/§W).


## ACCEPTANCE CRITERIA (brief §57)

- [x] P-SEARCH-SOURCE contract consumed exactly (§B)
- [x] Commerce Search Source Adapter exists (§Y)
- [x] no direct Core Prisma / no SearchDocument Prisma / no Core DB access (§W, scans)
- [x] stable source key (§C)
- [x] source class confirmed (§F — PRIMARY, rationale from the platform's definitions)
- [x] searchable entity set confirmed (§D — PurchaseDocument only)
- [x] searchable fields confirmed (§E — `documentNumber` only)
- [x] safe projection implemented (§J)
- [x] existing Platform normalization reused; no custom Commerce normalizer (§K/§L)
- [x] authorization adapter implemented; authoritative Commerce re-read (§N)
- [x] tenant isolation structural (§I)
- [x] correct Commerce permission — `commerce.read` via `PermissionSource` (§G)
- [x] safe route target; no arbitrary URLs (§M)
- [x] indexing lifecycle integrated (§O — create-hook, awaited, failure-logged)
- [x] removal/stale behavior correct (§P/§Q — no removal path; stale proven dropped)
- [x] no N+1 (§X)
- [x] no speculative schema/index changes (§52: no migration)
- [x] real `GET /search` E2E passes (§V: C9-A)
- [x] tenant isolation E2E passes (C9-B)
- [x] authorization E2E passes (C9-C)
- [x] stale/update E2E passes (C9-D, C9-E)
- [x] existing Global Search regression green (§V: 49J 41 + P 13)
- [x] existing Commerce regression green (C8 14 + integration/lifecycle/tenant 74)
- [x] architecture/isolation/policy green (§VALIDATION item 3)
- [x] TypeScript green (API + web, §VALIDATION)
- [x] Prisma valid (both schemas) + generate run
- [x] Web changed only minimally, and only for labels (§T)
- [x] documentation complete (this file; C8 and P-SEARCH-SOURCE untouched)
- [x] no Reporting work · no Quotation work · no Audit work · no Notification work (§54)


## VALIDATION (brief §59) — exact counts

| # | Gate | Command (shape) | Result |
|---|---|---|---|
| 1 | New adapter spec + extended purchase spec | `jest modules/commerce/search/commerce-search-source.service.spec.ts modules/commerce/purchase/purchase.service.spec.ts` | **2/2 suites, 53/53 tests** (13 new adapter tests, 2 new purchase tests) |
| 2 | Module guards: gateways + isolation + entitlement | `jest modules/commerce/commerce-{gateways,isolation,entitlement}.spec.ts` | **3/3 suites, 54/54 tests** |
| 3 | Commerce + platform search-source + search + architecture + policy | `jest src/modules/commerce src/platform/search-source src/search src/architecture-boundaries.spec.ts src/runtime-policy.spec.ts` | **51/51 suites, 933/933 tests** |
| 4 | Full API unit suite | `jest --runInBand` | **208/208 suites, 3469/3469 tests**, 47.5 s (baseline 207/3454 → **+1 suite, +15 tests**) |
| 5 | TypeScript (API) | `tsc --noEmit -p tsconfig.json` | **clean** |
| 6 | Prisma validate | core + commerce schemas | **both valid** |
| 7 | Prisma generate | core + commerce | **both regenerated** (git-ignored output) |
| 8 | Migration / migrate deploy | — | **NOT APPLIED — none exists** (default: no migration, brief §52) |
| 9 | C9 real-HTTP E2E (new) | `jest-e2e --testPathPattern commerce-search-source` | **1/1 suite, 10/10 tests** |
| 10 | E2E regression battery (7 suites in one run) | `jest-e2e` (commerce-search-source · commerce-search · search-source · search.e2e · commerce-integration · commerce-lifecycle · commerce-tenant) | **7/7 suites, 152/152 tests** — of which the 6 pre-existing suites keep their baseline counts (41 + 13 + 14 + 74) |
| 11 | Targeted web tests | `jest search-api.spec.ts CoreGlobalSearch.spec.tsx` | **2/2 suites, 43/43 tests** |
| 12 | Full frontend suite | `jest` (apps/web) | **90/90 suites, 1624/1624 tests** |
| 13 | Web TypeScript | `tsc --noEmit -p tsconfig.json` | **clean** |
| 14 | `next build` | `next build` (apps/web) | **✓ Compiled successfully**; “✓ Generating static pages (58/58)”; full route table emitted. One NON-FATAL pre-existing environment warning (`[blog-api] fetch failed`, an external fetch during prerender) — build completed, no “Failed to compile” |
| 15 | Browser QA | — | **Not run, deliberately**: no new screen, layout, interaction or navigation surface — the only visible change is one badge label for EXTERNAL results, rendered by a unit-tested component against a composed href (brief: QA only when an actual UI behavior changes) |
| 16 | Prettier | `prettier --check` | **baseline condition** (the repo is CRLF while prettier defaults LF; recorded as environment by P-SEARCH-SOURCE §V, unchanged by C9) |

**Separation of concerns in the numbers:** baseline failures = none found; C9
regressions = none (items 1–14 all green); environment = item 14's non-fatal blog fetch
warning, item 16's pre-existing formatting state, and the pre-existing “Jest did not
exit one second after…” open-handle notice after item 4 (the suite completed with every
test passing; the notice is documented repo behaviour).

## FINAL STATUS

**COMMERCE BACKEND GAP CLOSURE COMPLETE — GAP-5 GLOBAL SEARCH**

Commerce now participates in the EXISTING Platform Global Search through
`SEARCH_SOURCE_PORT` and nothing else: one source (`commerce.purchase-document`), one
searchable field (`documentNumber`), one class (PRIMARY), one permission
(`commerce.read`), one route (`/admin/commerce/purchases/:id`), one create-hook — with
Commerce retaining ownership of its data and its authoritative authorization, and the
platform retaining ownership of the index, normalization, ranking, pagination and the
result envelope.

### Per-source classification (brief §60)

| Source | Status |
|---|---|
| `commerce.purchase-document` (PurchaseDocument) | **CLOSED** |
| Workflow Instance | **DECISION REQUIRED** (§AB.1 — not implemented, by contract) |
| Pending Decision | **DECISION REQUIRED** (§AB.1 — not implemented, by contract) |
| Commercial groups/versions, workflow versions, routing/completion versions, payment/receipt/return rows, quotation | **NOT A SEARCH SOURCE** (§D) |

**END OF DOCUMENT —** `COMMERCE BACKEND GAP CLOSURE COMPLETE — GAP-5 GLOBAL SEARCH`

