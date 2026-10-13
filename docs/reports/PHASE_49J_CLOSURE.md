# Phase 49J — Global Search + Semantic Search: Closure & Blocker Register

**Status: YELLOW — IMPLEMENTED, SEMANTIC VALIDATION DEFERRED**

This is the durable record for Phase 49J. It exists because the phase closes with
two open items that are **deferred validation blockers, not architecture
defects**, and that distinction must survive past this session.

Closure verified on PostgreSQL 16.15 / pgvector 0.8.6, `master` @
`011c30ab8be8104e5f633ebe0e03e9eab069dbaa`. 49J-A, 49J-0 and 49J are
uncommitted, so phase ownership is taken from the known change set and prior
evidence, **not** from `git status`.

## What is closed as GREEN

| Gate | Evidence |
| --- | --- |
| Implementation | 16 files under `apps/api/src/search`, `apps/web/src/lib/search-api.ts`, `apps/web/src/components/core/CoreGlobalSearch.tsx` |
| Lexical retrieval | `searchVector` = `to_tsvector('simple', "searchText")`, `attgenerated='s'`; GIN reached (`Bitmap Index Scan on "SearchDocument_searchVector_idx"`, `@@` as Index Cond) |
| Persian normalization | `persian-normalize.ts`; generated tsvector from `مرخصی استحقاقی سالانه` → `'استحقاقی':2 'سالانه':3 'مرخصی':1` |
| Authorization | `SearchAuthorizer` — 8 exhaustive per-source rules, `never` guard on the switch, grouped queries (never per-row) |
| Tenant isolation | tenant predicate applied unconditionally including when `NULL`; `USER` returns `[]` for a tenant-less caller |
| API | one route `GET /search`; no `tenantId`/`userId`/`asUser`/`includeInternal` in `SearchQueryDto`, rejected by `whitelist` + `forbidNonWhitelisted` |
| UI | `CoreGlobalSearch` mounted in `CoreHeader`; snippets are text nodes via `splitSnippet(snippet, highlights)`; no `dangerouslySetInnerHTML` |
| Semantic infrastructure | `embedding vector(1536)`, HNSW `vector_cosine_ops` index, `AIConfigService.generateEmbedding` as the single embedding path, width asserted against `EMBEDDING_DIMENSIONS = 1536`, degraded mode reports `degraded: true` and never the reason |

## BLOCKER 1

**Title:** No active embedding credential / no stored embeddings.

**Evidence:**

- `SELECT count(*) FROM "AIProviderConfig"` → `0`
- `SELECT count(embedding) FROM "SearchDocument"` → `0` (also
  `count("embeddingModel") = 0`, `count("embeddedAt") = 0`)
- `OPENAI_API_KEY` absent/empty in `apps/api/.env`;
  `AI_CONFIG_ENCRYPTION_KEY` absent/empty
- `rebuildAll()` reported `embeddingSkipped: true` for every source

**Impact:** Semantic retrieval cannot execute against real indexed content. The
vector arm is reachable and correct — an HNSW `Index Scan … Order By: (embedding
<=> $n)` plans, and a rolled-back probe pair returned cosine `1.0000` / `0.0000`
at 1536 dims — but with zero embedded rows it can only ever return an empty
candidate set. Every live search therefore serves `mode: LEXICAL`,
`degraded: true`.

**Resolution:** Configure an AI provider through Core AI Settings (49J-A) with a
valid embedding credential, then index real authorized source content.

**Not a defect:** the degradation is designed. `SearchService.embedQuery`
catches the missing-credential throw, logs it server-side, and continues
lexically without disclosing provider identity, model name or credential state
to the search caller.

## BLOCKER 2

**Title:** Insufficient authentic semantic corpus.

**Evidence:**

- `SearchDocument` holds 9 rows: 5 `MESSAGE`, 4 `NOTIFICATION`
- all 9 rows have `tenantId IS NULL`
- the `USER` source is unreachable in this corpus: every pre-existing user has
  `tenantId = NULL`, and `projectUsers` only projects `tenantId: { not: null }`
- no content-bearing domain (HR, Documents, Services, Knowledge) exists yet

**Impact:** Semantic relevance / paraphrase recall cannot be honestly measured.
Nine short, machine-adjacent strings cannot demonstrate that a paraphrased query
retrieves a semantically related document; any "pass" from this corpus would be
an artifact of its size.

**Resolution:** When a real content-bearing domain exists, index authentic
authorized content and rerun semantic relevance E2E.

**Explicitly refused during closure:** no synthetic documents, no fabricated
leave/HR records, no manually inserted search-only rows, no promotion of unit or
e2e fixtures to production proof. All four database probes ran inside
`BEGIN … ROLLBACK`; `core_db` still holds 9 rows, unchanged.

## Future unblock procedure

A **Semantic Validation Gate**, not a redesign of 49J. No Search code change is
anticipated by any step below.

1. Configure an embedding provider in Core AI Settings (`AIProviderConfig`,
   capability `EMBEDDING`, `enabled` + `isDefault`).
2. Ensure the credential is active — `AI_CONFIG_ENCRYPTION_KEY` must be set
   before a credential can be stored or read, then verify with the existing
   `testConnection` probe.
3. Run a controlled reindex over approved real content:
   `npx ts-node scripts/search-reindex.ts` from `apps/api`.
4. Verify `SELECT count(embedding) FROM "SearchDocument"` > 0 and that
   `embeddingSkipped` is `false` for the indexed sources.
5. Run a semantic query against the real authorized corpus and confirm the
   response reports `mode: HYBRID`, `degraded: false`.
6. Demonstrate paraphrase retrieval: a query sharing no lexical token with the
   target document still retrieves it.
7. Re-run the authorization and tenant checks on the vector path specifically —
   cross-tenant, membership, internal comments, unpublished surveys,
   notification/reminder ownership. Authorization runs after retrieval, so it is
   arm-independent by construction, but it must be proven on the vector arm.
8. Record the evidence in this file.
9. If all pass: close both blockers and promote 49J to GREEN.

## Verification evidence at closure

Changed-scope suites, all passing:

- `apps/api` unit `src/search` — 88/88, 3 suites
- `apps/api` full unit — 735/735, 42 suites
- `apps/api` e2e `search.e2e-spec.ts` — 41/41
- `apps/api` e2e, other 9 specs (49I regression) — 275/275
- `apps/web` search tests — 40/40 (`CoreGlobalSearch.spec.tsx` 17 +
  `search-api.spec.ts` 23)
- `apps/web` full jest `--runInBand` — 579/579, 34 suites
- `apps/api` / `apps/web` `tsc --noEmit` — EXIT=0 both
- `apps/api` `nest build` — EXIT=0; `apps/web` `next build` — compiled
  successfully

`apps/web` jest must run `--runInBand`: `CoreSurveyDetailView.spec.tsx` flakes
under parallel workers. Pre-existing isolation issue, unrelated to 49J.

## Pre-existing repo defects — NOT introduced by 49J, NOT fixed here

Recorded so that no future reader mistakes them for 49J regressions, and so no
claim of repo-wide lint cleanliness is made:

- `apps/web` ESLint cannot run at all: `TypeError: Converting circular structure
  to JSON` from `eslint-config-next` under ESLint 8.57.1. Reproduced on an
  untouched file (`CoreNotificationBell.tsx`). `next lint` is also broken in this
  Next 16 setup — it parses `lint` as a directory argument.
- `@typescript-eslint/no-explicit-any` at `search.controller.ts:43` — the
  codebase-wide `(req as any).user?.sub` accessor. The same pattern lints as an
  error in `support`, `notifications` and `calendar` controllers (13 occurrences
  in that scope alone). Changing it is a cross-cutting refactor, out of scope for
  a closure pass.
- Untracked artifacts predating this phase remain untouched:
  `ERP_Structure_v12.xml`, `api-mounts.json`, `apps/api/.rid`, `apps/api/.tok`,
  `apps/api/tmp-jest.txt`, `apps/web/srv-out.txt`, `apps/web/srv-err.txt`,
  `ws-install2.txt`, `ws-install3.txt`.

## Environment note

The e2e run path depends on `aria-erp-e2e-dbproxy` (alpine/socat) publishing
port 5544 and forwarding to `postgres:5432`. `aria-erp-postgres` itself publishes
5433. Both `.env.e2e` and `.env.local` target 5544, so the proxy container is
load-bearing for every e2e run and for `prisma migrate status`.

