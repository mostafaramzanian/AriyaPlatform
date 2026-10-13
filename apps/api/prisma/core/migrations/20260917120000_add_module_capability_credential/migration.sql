-- Phase 51-HR-ARCH-3B (ADR-0006 A8): the capability-scoped service credential store.
--
-- WHY THIS TABLE EXISTS AT ALL. A7 requires one service credential per (caller,
-- capability): "one shared secret accepted by several platform endpoints collapses every
-- capability's blast radius into one: leaking it would authenticate identity reads *and*
-- audit ingest, and rotating it would break both." Reading the baseline showed Core had
-- nowhere to put such a credential:
--
--   * "ModuleRegistration" is keyed by `moduleId` ALONE — `moduleId` is UNIQUE, one row
--     per module — and carries exactly ONE secret envelope
--     ("secretCiphertext"/"secretIv"/"secretAuthTag" behind one "secretExpiresAt");
--   * `ModuleRegistryService.resolveSecret(moduleId)` is the only resolver, keyed by
--     `moduleId` by itself;
--   * `moduleSignatureMaterial` signs method, path, timestamp, `<moduleId>:<requestId>`
--     and the tenant slot — it has NO capability field.
--
-- So capability was representable nowhere: not in the signature, and not in the store. It
-- can only be expressed by WHICH secret verifies, which is what
-- UNIQUE("moduleId", "capability") encodes.
--
-- WHY NOT A SECOND ROW OF "ModuleRegistration". `moduleId` is the stable registry identity
-- that `resolve`, `resolveSecret`, `registerInstance` and every signed request key on, and
-- it is UNIQUE precisely so that one module is one credential. Registering HR twice
-- (`hr` + `hr.audit`) would manufacture a module principal that never registers, never
-- heartbeats and has no release, purely to hold a secret — and the same runtime would still
-- hold both secrets, so the blast radius A7 forbids would still be one leak wide.
-- "ModuleRegistration" is therefore UNCHANGED by this migration: its single secret remains
-- the module-hop credential and is never reinterpreted as a capability credential.
--
-- `capability` HOLDS A CONTRACT DESCRIPTOR (`platform.identity@v1`), NOT a
-- `ModuleCapabilityId`: the descriptor carries the major version, so a `@v2` is a new
-- credential by construction rather than a reused one. The CHECK below mirrors the existing
-- `CONTRACT_PATTERN` / `MAX_CONTRACT_LENGTH` in src/module-platform/module.contract.ts
-- exactly, so the table and the code cannot disagree about what a capability is.
--
-- ENCRYPTION IS THE EXISTING ENVELOPE, not a second scheme: the same AES-256-GCM
-- three-column shape, encrypted by the same CryptoService under the same
-- AI_CONFIG_ENCRYPTION_KEY that 20260905120000_add_module_platform established.
CREATE TABLE "ModuleCapabilityCredential" (
    "id" TEXT NOT NULL,

    -- The module that HOLDS the credential. The FK target is the UNIQUE column
    -- "ModuleRegistration"."moduleId" rather than its "id": `moduleId` is the identity every
    -- resolution uses, so keying the credential on it makes "credential for module X" and
    -- "resolution for module X" the same key by construction.
    "moduleId" TEXT NOT NULL,

    -- Contract descriptor, e.g. 'platform.identity@v1'. UNIQUE per module (index below).
    "capability" TEXT NOT NULL,

    -- AES-256-GCM envelope; three columns because GCM must both decrypt and authenticate.
    -- Nullable as a SET: a row may exist before its secret is issued, and resolution then
    -- refuses rather than authenticating with nothing.
    "secretCiphertext" TEXT,
    "secretIv" TEXT,
    "secretAuthTag" TEXT,
    "secretUpdatedAt" TIMESTAMP(3),

    -- NULL means "no expiry configured" and is never read as "expired".
    "secretExpiresAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModuleCapabilityCredential_pkey" PRIMARY KEY ("id")
);

-- THE CAPABILITY BOUNDARY. Not merely an index for lookup speed: it is what makes
-- "one credential for two capabilities" unstorable, which is the property A7 needs.
CREATE UNIQUE INDEX "ModuleCapabilityCredential_moduleId_capability_key"
  ON "ModuleCapabilityCredential"("moduleId", "capability");

-- CASCADE: a credential for a module that no longer exists is unresolvable by definition,
-- the same reasoning "ModuleInstance_registrationId_fkey" already follows.
ALTER TABLE "ModuleCapabilityCredential" ADD CONSTRAINT "ModuleCapabilityCredential_moduleId_fkey"
  FOREIGN KEY ("moduleId") REFERENCES "ModuleRegistration"("moduleId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Mirrors CONTRACT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*@v[0-9]+$/ and
-- MAX_CONTRACT_LENGTH = 120. The DTO protects the HTTP surface; this protects the table
-- from a direct write installing a descriptor the resolver and the signature
-- canonicalisation would disagree about. POSIX regex spells the non-capturing group `(...)`.
ALTER TABLE "ModuleCapabilityCredential" ADD CONSTRAINT "ModuleCapabilityCredential_capability_format"
  CHECK (
    "capability" ~ '^[a-z0-9]+([._-][a-z0-9]+)*@v[0-9]+$'
    AND char_length("capability") <= 120
  );

-- The three GCM columns are meaningful only TOGETHER, exactly as
-- "ModuleRegistration_secret_complete" already enforces on the module credential:
-- all-NULL (not issued) and all-present (issued) are the only legal states, and two of
-- three would decrypt to garbage or throw at the first authenticated call.
ALTER TABLE "ModuleCapabilityCredential" ADD CONSTRAINT "ModuleCapabilityCredential_secret_complete"
  CHECK (
    ("secretCiphertext" IS NULL AND "secretIv" IS NULL AND "secretAuthTag" IS NULL)
    OR ("secretCiphertext" IS NOT NULL AND "secretIv" IS NOT NULL AND "secretAuthTag" IS NOT NULL)
  );
