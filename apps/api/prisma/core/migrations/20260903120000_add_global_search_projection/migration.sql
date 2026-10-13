-- Phase 49J: Global Search projection.
--
-- Adds ONE table, ONE enum and the `vector` extension. No change to "User",
-- "Tenant", RBAC (Role/Permission/UserRole), "AuditLog"/"AuditDispatch",
-- "Notification" (49E), "Conversation"/"Message" (49F), "Ticket*" (49G),
-- "Survey*" (49H), "Reminder" (49I) or "AIProviderConfig" (49J-0). Core schema
-- only: nothing here touches `cms_db`.
--
-- NO new permission row and NO new grant. Global Search is an ordinary
-- authenticated-user capability, exactly like reading one's own notifications
-- (49E) or reminders (49I): every result is filtered by the SOURCE's own
-- authorization edge (conversation membership, ticket participation,
-- `admin.support.manage`, survey publication, ownership), so a `search.read`
-- permission would be a second, weaker gate in front of gates that already exist.
-- Inventing one would also imply a revocable-per-role model this phase does not
-- build.
--
-- ============================================================================
-- WHY A UNIFIED PROJECTION TABLE, AND NOT PER-SOURCE tsvector COLUMNS
-- ============================================================================
-- Per-source generated columns on "Ticket", "Message", "Survey", … were the
-- alternative. They lose on three counts:
--
--  1. THE NORMALIZER IS JAVASCRIPT. Persian search requires folding ARABIC YEH
--     to FARSI YEH, deleting ZWNJ, folding Arabic-Indic digits and attaching the
--     closed-set clitics (see src/search/persian-normalize.ts). None of that is
--     expressible in SQL here: `unaccent` and `pg_trgm` are deliberately NOT
--     installed, and a hand-written `translate()` chain in a generated-column
--     expression could not perform the token-level clitic attachment at all.
--     A generated column can therefore only index RAW text, which would leave
--     `مرخصي` unable to find `مرخصی` — the exact defect this phase exists to fix.
--     Because the expression cannot live in the database, the projection cannot
--     be maintained by a trigger either: SYNC IS SERVICE-LEVEL BY NECESSITY,
--     not by preference.
--  2. ONE QUERY INSTEAD OF EIGHT. Ranking across sources needs a single ordered
--     candidate set. Eight per-source queries UNIONed by the application cannot
--     use one bounded index scan, and adding a source would change the query
--     shape every time.
--  3. THE VECTOR HAS NOWHERE ELSE TO LIVE. `vector(1536)` on eight business
--     tables means eight HNSW indexes and eight nullable embedding columns on
--     rows whose lifecycle has nothing to do with embeddings.
--
-- This table is A CACHE, NOT A SOURCE OF TRUTH. It is keyed by
-- ("sourceType","sourceId"), it is fully rebuildable from the business tables,
-- and it holds NO foreign key — so it can be truncated and rebuilt at any time,
-- and deleting a ticket can never be blocked by a stale search row.
--
-- ============================================================================
-- WHAT IS DELIBERATELY *NOT* STORED HERE
-- ============================================================================
-- NO RAW TEXT. There is no `title`/`body` column holding a copy of
-- "Message"."body" or "Ticket"."subject". Snippets are built from the
-- AUTHORITATIVE row, AFTER that row has passed its source's authorization check,
-- which has two consequences that a cached copy could not offer: a snippet can
-- never be stale, and this table never becomes a second, less-guarded copy of
-- private message content.
--
-- NO OWNER/MEMBER/PARENT COLUMN. There is no "ownerId", "authorId",
-- "conversationId" or "isInternal" here, and their absence is the point: THE
-- INDEX IS NEVER AN AUTHORIZATION BOUNDARY. Access is decided by re-reading the
-- source row and applying that source's own rule. A denormalised `ownerId` would
-- become a de-facto ACL that silently goes stale when membership changes.
--
-- NO E-CLASS DATA (never indexed, per the phase's source classification):
-- "AuditLog", "AIProviderConfig" (including credentialCiphertext/Iv/AuthTag),
-- attachment/storage object keys, refresh-token / password-reset /
-- email-verification records, "User"."passwordHash", "User"."tokenVersion" and
-- "Tenant" internals.

-- ============================================================================
-- EXTENSION
-- ============================================================================
-- pgvector, for the semantic half of hybrid retrieval. The image is
-- pgvector-capable (verified: `vector` 0.8.6, with both `hnsw` and `ivfflat`
-- access methods available to `aria_user`), and 49J-0 deliberately created no
-- vector object — it configured the PROVIDER, not the storage. This is where the
-- storage appears.
--
-- IF NOT EXISTS, so `prisma migrate deploy` is idempotent and re-running against
-- an already-prepared database is a no-op.
--
-- NOT created, deliberately: `pg_trgm` and `unaccent`. Trigram similarity would
-- be a THIRD ranking signal nobody asked for, and `unaccent` operates on Latin
-- diacritics — it does nothing for Persian, whose folding is already done in
-- JavaScript before the text arrives.
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- ENUM
-- ============================================================================
-- The indexable sources. An enum rather than free text so a typo in an indexer
-- is a write-time error instead of a silently unsearchable row, and so the
-- per-source authorization switch in SearchService is exhaustive at compile time.
--
-- Contains exactly the A-class (lexical + semantic) and B-class (lexical-only)
-- sources. C-class (CMS "BlogPost", "SurveyQuestion"."text",
-- "SurveyAnswer"."textValue") and D-class ("Lead", "Meeting") members are NOT
-- declared: an enum member with no indexer is a promise the code does not keep.
CREATE TYPE "SearchSourceType" AS ENUM (
  'TICKET',
  'TICKET_COMMENT',
  'SURVEY',
  'MESSAGE',
  'CONVERSATION',
  'NOTIFICATION',
  'REMINDER',
  'USER'
);

-- ============================================================================
-- TABLE
-- ============================================================================
CREATE TABLE "SearchDocument" (
    "id" TEXT NOT NULL,

    -- Identity of the authoritative row. ("sourceType","sourceId") is UNIQUE
    -- below, which makes the indexer a plain upsert and makes dedupe in the query
    -- path a property of the data rather than of the merge code.
    "sourceType" "SearchSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,

    -- Tenant snapshot, copied from whatever the source treats as its isolation
    -- key ("Ticket"."tenantId", "Conversation"."tenantId" for a message, …).
    --
    -- NULLABLE, WITH EXACT-EQUALITY SEMANTICS: `NULL` IS ITS OWN BUCKET, not a
    -- wildcard. Every tenant column in Core is nullable because "User"."tenantId"
    -- is, so a null-tenant caller must see null-tenant rows and NOTHING ELSE. The
    -- query path uses `IS NULL` for a null caller and `= $tenant` otherwise —
    -- never `IS NULL OR = $tenant`, which would be a cross-tenant leak.
    "tenantId" TEXT,

    -- The NORMALIZED searchable text produced by src/search/persian-normalize.ts
    -- (`buildSearchText`). Not raw content: this is folded, ZWNJ-stripped,
    -- clitic-attached, lowercased text whose only purpose is to feed
    -- `to_tsvector`. It is a lossy derivative — it is never rendered back to a
    -- user and the snippet path never reads it.
    "searchText" TEXT NOT NULL,

    -- Generated, STORED tsvector over "searchText".
    --
    -- STORED, not an expression index and not a per-query `to_tsvector`: lexeme
    -- extraction happens ONCE at write time, so the read path is a pure GIN
    -- lookup. `to_tsvector` in the WHERE clause of every search would re-tokenize
    -- the candidate set on every request.
    --
    -- 'simple'::regconfig, and the cast is REQUIRED: a generated column must be
    -- IMMUTABLE, and one-argument `to_tsvector(text)` depends on
    -- `default_text_search_config`, which is only STABLE. The explicit regconfig
    -- is what makes this legal, and it pins the configuration into the schema so
    -- no session GUC can change what was indexed.
    --
    -- WHY 'simple' AND NOT 'arabic': `arabic` has a stemmer and over-stems
    -- Persian (`to_tsvector('arabic','کارکنان')` → `'کارکن'`), collapsing plurals
    -- into stems no Persian reader would recognise. `simple` applies no stemming
    -- and no stopword list, which is exactly right once normalization has already
    -- happened in the application. PostgreSQL has no Persian configuration.
    "searchVector" tsvector GENERATED ALWAYS AS (
      to_tsvector('simple'::regconfig, "searchText")
    ) STORED,

    -- The embedding, 1536 dimensions to match the contract of the only embedding
    -- provider wired in 49J-A (`text-embedding-3-small`). A fixed dimension is
    -- required: `vector(1536)` can carry an HNSW index, a bare `vector` cannot.
    --
    -- NULLABLE, AND NULL IS MEANINGFUL: it means "no embedding exists for this
    -- row", which is the state of every row while no provider credential is
    -- configured. There is no zero vector and no random vector anywhere in this
    -- feature — a zero vector has a defined cosine distance to everything and
    -- would produce confident nonsense. A row with a NULL embedding is lexically
    -- searchable and semantically invisible, and the API reports that honestly as
    -- DEGRADED LEXICAL mode.
    "embedding" vector(1536),

    -- Which model produced "embedding", e.g. `text-embedding-3-small`. Free text,
    -- matching "AIProviderConfig"."model". Its purpose is invalidation: vectors
    -- from two different models are not comparable, so a model change must
    -- re-embed rather than mix. NULL exactly when "embedding" is NULL.
    "embeddingModel" TEXT,

    -- When the vector was written. NULL exactly when "embedding" is NULL.
    "embeddedAt" TIMESTAMP(3),

    -- "updatedAt" of the source row at projection time. Lets a rebuild skip
    -- unchanged rows and makes a stale projection detectable by comparison rather
    -- than by guesswork. Sources with no `updatedAt` ("Message", "Notification",
    -- "TicketComment") supply their `createdAt` — correct, because those rows are
    -- immutable by design.
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchDocument_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- CONSTRAINTS
-- ============================================================================
-- One projection row per source row. This is the dedupe key the query path
-- relies on ("sourceType" + "sourceId"), and it is what makes the indexer an
-- upsert instead of a delete-then-insert.
CREATE UNIQUE INDEX "SearchDocument_sourceType_sourceId_key"
  ON "SearchDocument"("sourceType", "sourceId");

-- The three embedding columns move together or not at all. Without this, a row
-- could carry a vector with no model, which would make invalidation on a model
-- change impossible, or a model with no vector, which would make the API claim a
-- semantic capability it does not have.
ALTER TABLE "SearchDocument" ADD CONSTRAINT "SearchDocument_embedding_complete"
  CHECK (
    ("embedding" IS NULL AND "embeddingModel" IS NULL AND "embeddedAt" IS NULL)
    OR
    ("embedding" IS NOT NULL AND "embeddingModel" IS NOT NULL AND "embeddedAt" IS NOT NULL)
  );

-- A row with empty normalized text is unreachable by any query and would only
-- inflate the index. The indexer skips such sources rather than writing a row
-- that can never match; this constraint makes that a database invariant.
ALTER TABLE "SearchDocument" ADD CONSTRAINT "SearchDocument_searchText_nonblank"
  CHECK (char_length("searchText") >= 1);

-- ============================================================================
-- INDEXES
-- ============================================================================
-- The lexical index. GIN over the stored tsvector — the only index type that can
-- answer `@@` efficiently. Not GiST: GiST tsvector indexes are lossy and require
-- a recheck of every candidate heap tuple, which is the wrong trade for a
-- read-heavy search.
CREATE INDEX "SearchDocument_searchVector_idx"
  ON "SearchDocument" USING GIN ("searchVector");

-- The semantic index. HNSW with `vector_cosine_ops`, matching the distance
-- operator the query path uses (`<=>`), because an index built for one operator
-- class cannot serve another — `vector_l2_ops` here would silently leave the
-- semantic query doing a sequential scan.
--
-- HNSW, not IVFFlat: IVFFlat must be built on populated data to choose its lists
-- and needs rebuilding as the corpus grows, while HNSW is incremental and
-- correct on an empty table. That matters concretely here, because this table IS
-- empty at migration time and — with no embedding credential configured — its
-- "embedding" column stays entirely NULL. NULL vectors are simply not indexed by
-- HNSW, so the index is created, valid, and empty. It is not decoration: it is
-- the storage half of the semantic path, and it is the half that can be built
-- and verified without a credential.
--
-- Build parameters (m, ef_construction) are deliberately left at pgvector's
-- defaults. Tuning them against an empty table would be numerology.
CREATE INDEX "SearchDocument_embedding_idx"
  ON "SearchDocument" USING hnsw ("embedding" vector_cosine_ops);

-- Tenant-scoped filtering. Every query carries a tenant predicate, and the
-- optional `sourceType` facet is applied in the same WHERE clause, so the two
-- columns are indexed together in that order.
CREATE INDEX "SearchDocument_tenantId_sourceType_idx"
  ON "SearchDocument"("tenantId", "sourceType");

-- Serves the indexer's staleness scan and the per-source rebuild: "which rows of
-- this type were projected before their source last changed".
CREATE INDEX "SearchDocument_sourceType_sourceUpdatedAt_idx"
  ON "SearchDocument"("sourceType", "sourceUpdatedAt");

-- Serves the backfill worker: "which rows still need an embedding". PARTIAL, so
-- it contains only rows that are actually pending — with no credential
-- configured that is every row, and once a corpus is embedded the index shrinks
-- to nothing rather than duplicating the whole table. Prisma cannot express a
-- partial index, so it is declared here and documented in the model, exactly as
-- "Reminder_pending_dueAt_idx" (49I) is.
CREATE INDEX "SearchDocument_pending_embedding_idx"
  ON "SearchDocument"("sourceType", "sourceUpdatedAt")
  WHERE "embedding" IS NULL;

-- ============================================================================
-- NO FOREIGN KEYS, AND NO TRIGGERS — both deliberate.
-- ============================================================================
-- NO FOREIGN KEY: "sourceId" points at one of eight different tables, so a
-- single FK is not expressible; eight nullable FK columns would be worse, since a
-- cache must never be able to block or cascade a delete on a business row. A
-- deleted source leaves an orphan row, which the indexer removes and which the
-- query path cannot surface anyway — every candidate is re-read from its
-- authoritative table before it can appear in a result, and a missing row is
-- dropped there.
--
-- NO TRIGGER: the normalization this table depends on is JavaScript (see the
-- header). A trigger could only normalize with SQL string functions, which cannot
-- perform the token-level clitic attachment, so a trigger-maintained
-- "searchText" would silently diverge from the query path's normalization —
-- the one failure mode this design must not have. Sync is therefore performed by
-- the application, in the same transaction as the business write where the
-- source's service already owns one.

