-- Phase 49J-0: Core AI Provider Configuration.
--
-- Adds ONE table and TWO enums. Nothing existing is altered: no change to User,
-- Tenant, Role/Permission/RolePermission/UserRole (the two new AI permissions are
-- seeded by the follow-up migration 20260902120500_seed_ai_permission_grants, in
-- the style of 20260830130000_seed_survey_permission_grants), AuditLog/
-- AuditDispatch, Notification, Conversation/Message, Ticket*, Survey*, or the
-- 49I CalendarReminder table. Core schema only: nothing here touches `cms_db`.
--
-- NO pgvector OBJECT IS CREATED. The Postgres image is pgvector-capable and the
-- embedding contract is fixed at 1536 floats, but this phase configures WHICH
-- provider produces vectors, not where they are stored. There is no `vector`
-- column anywhere in the core schema today and this migration does not invent
-- one; a store without a reader or writer would be dead schema.

-- CreateEnum
-- Exactly the four providers implemented in src/ai (OpenAIProvider,
-- AzureOpenAIProvider, ClaudeProvider, LocalLLMProvider). A fifth value would be
-- selectable in the admin UI and unconstructable at runtime.
CREATE TYPE "AIProviderKey" AS ENUM ('OPENAI', 'AZURE_OPENAI', 'ANTHROPIC', 'LOCAL');

-- CreateEnum
-- Embedding and text generation are selected independently; see the model comment.
CREATE TYPE "AICapability" AS ENUM ('TEXT_GENERATION', 'EMBEDDING');

-- CreateTable
CREATE TABLE "AIProviderConfig" (
    "id" TEXT NOT NULL,
    "provider" "AIProviderKey" NOT NULL,
    "capability" "AICapability" NOT NULL,
    -- Provider-side model id. Free text on purpose: vendors add and retire model
    -- names continuously and a migration is the wrong unit of change for that.
    "modelName" TEXT NOT NULL,
    -- Endpoint override (Azure resource, self-hosted gateway, local server).
    -- NULL means "use the provider's own default", i.e. today's env behaviour.
    "baseUrl" TEXT,
    -- Default false: creating a row must never silently redirect live traffic.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    -- AES-256-GCM envelope. All three parts are required together to decrypt AND
    -- to authenticate; ciphertext alone would make tampering undetectable. The
    -- plaintext key is never stored, never logged, never returned by any route.
    "credentialCiphertext" TEXT,
    "credentialIv" TEXT,
    "credentialAuthTag" TEXT,
    "credentialUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AIProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One configuration row per (provider, capability). Two competing OpenAI
-- embedding rows differing only by model would make "the active one" ambiguous.
CREATE UNIQUE INDEX "AIProviderConfig_provider_capability_key"
    ON "AIProviderConfig"("provider", "capability");

-- CreateIndex
-- Serves the only hot read: resolve the enabled default for one capability.
CREATE INDEX "AIProviderConfig_capability_enabled_idx"
    ON "AIProviderConfig"("capability", "enabled");

-- PARTIAL UNIQUE INDEX — not expressible in schema.prisma, which is why it is
-- written by hand here and documented on the model.
--
-- "At most one default per capability" is a database invariant, not a service
-- convention: two defaults would make embedding resolution depend on row order,
-- and a plain UNIQUE(capability, isDefault) would also forbid a second
-- NON-default row, which is the normal case. The predicate restricts uniqueness
-- to the rows that actually compete.
CREATE UNIQUE INDEX "AIProviderConfig_capability_default_key"
    ON "AIProviderConfig"("capability")
    WHERE "isDefault";

-- The credential envelope is all-or-nothing. A row holding ciphertext without its
-- iv/authTag is undecryptable and a row holding an iv without ciphertext is
-- meaningless; both are rejected here rather than discovered at first use.
-- The all-NULL case is legitimate: a LOCAL provider on a trusted network has no
-- credential at all.
ALTER TABLE "AIProviderConfig"
    ADD CONSTRAINT "AIProviderConfig_credential_envelope_complete" CHECK (
        (
            "credentialCiphertext" IS NULL
            AND "credentialIv" IS NULL
            AND "credentialAuthTag" IS NULL
        )
        OR (
            "credentialCiphertext" IS NOT NULL
            AND "credentialIv" IS NOT NULL
            AND "credentialAuthTag" IS NOT NULL
        )
    );

-- A model name is required, and an all-whitespace one is not a model name.
ALTER TABLE "AIProviderConfig"
    ADD CONSTRAINT "AIProviderConfig_modelName_not_blank" CHECK (length(btrim("modelName")) > 0);

-- Same rule for the override: absent is NULL, never an empty string, so
-- `COALESCE(baseUrl, default)` cannot resolve to a blank endpoint.
ALTER TABLE "AIProviderConfig"
    ADD CONSTRAINT "AIProviderConfig_baseUrl_not_blank" CHECK ("baseUrl" IS NULL OR length(btrim("baseUrl")) > 0);

-- A disabled row must not be the default: resolution reads the default and then
-- refuses a disabled provider, so allowing the pair would encode a configuration
-- that is guaranteed to fail at runtime.
ALTER TABLE "AIProviderConfig"
    ADD CONSTRAINT "AIProviderConfig_default_requires_enabled" CHECK (NOT "isDefault" OR "enabled");

-- NO SEED ROW. Which provider and model a deployment uses is an operator
-- decision; inserting a plausible default (OPENAI + text-embedding-3-small) would
-- fabricate configuration nobody chose, and could not carry a credential anyway.
-- Until an administrator saves a row, embedding resolution falls back to the
-- documented OPENAI_API_KEY / EMBEDDING_MODEL environment bootstrap.
