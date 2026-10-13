-- Phase 50: register the three correspondence permissions in the catalogue and
-- grant them explicitly, in the style of 20260830130000_seed_survey_permission_grants.
--
-- Why this migration exists at all: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from the "Permission" + "RolePermission" + "Role" tables, so
-- a permission with no catalogue row is a permission NOBODY has — every guarded
-- correspondence route would 403 for every caller, including SUPER_ADMIN.
--
-- THE PERSONAL WORKFLOW IS NOT GATED. Creating drafts, sending, being a recipient,
-- referring letters you may see, and archiving into your own folders are ordinary
-- authenticated-user capabilities, bounded by ownership/recipient edges and tenant
-- scope in CorrespondenceService — the same doctrine 49H applied to survey
-- participation and 49G applied to support tickets. That is why no
-- 'correspondence.use' row is created: inventing one would imply a revocable
-- per-role participation model this phase does not build.
--
-- What IS gated, and why:
--   correspondence.manage              — tenant-wide correspondence administration:
--                                        read any letter in the tenant (including
--                                        BCC identities), and change a SENT
--                                        letter's classification.
--   correspondence.confidential.manage — author (or refer) CONFIDENTIAL/SECRET
--                                        letters at all. Normal creation is ungated.
--   correspondence.confidential.read   — see confidential letters one is NOT a
--                                        participant of (manager views + search).
--                                        Participants never need this: a letter
--                                        addressed TO you implies need-to-know.
--
-- Grants are deliberately narrow and are NOT "every ADMIN gets everything":
--   SUPER_ADMIN      -> all three (it holds the full catalogue by definition)
--   ADMIN            -> all three (the tenant's correspondence administrator)
--   OPERATIONS_ADMIN -> NEITHER. Support and system operations; nothing in its
--                       documented remit is correspondence administration.
--   SECURITY_ADMIN   -> NEITHER. Audit/security scope, not correspondence content.
--   every other role -> NEITHER. Confidential authoring is opt-in per tenant policy,
--                       granted through the existing role-management surface.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations
-- alone and a re-run is a no-op.
--
-- NOTE: the 'CORRESPONDENCE' PermissionDomain member is added by the PREVIOUS
-- migration (20260912120500). It must not be added here: PostgreSQL forbids USING
-- a newly added enum value inside the same transaction that added it (SQLSTATE
-- 55P04), so the ALTER and these INSERTs must commit in separate transactions.

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('admin-surveys-manage' -> 'correspondence-manage').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('correspondence-manage', 'correspondence.manage', 'Manage Correspondence', 'CORRESPONDENCE', 'Tenant-wide correspondence administration: read any letter, change classification after send'),
  ('correspondence-confidential-read', 'correspondence.confidential.read', 'Read Confidential Correspondence', 'CORRESPONDENCE', 'Read confidential/sealed letters one is not a participant of'),
  ('correspondence-confidential-manage', 'correspondence.confidential.manage', 'Manage Confidential Correspondence', 'CORRESPONDENCE', 'Create and refer confidential/sealed letters')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the three new permissions.
-- CROSS JOIN over "Permission" matches ROLE_PERMISSIONS[SUPER_ADMIN] in
-- src/auth/rbac/constants/roles.ts and is how the earlier grant migration did it.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('correspondence.manage', 'correspondence.confidential.read', 'correspondence.confidential.manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: all three, matching the tenant correspondence administrator remit.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('correspondence.manage', 'correspondence.confidential.read', 'correspondence.confidential.manage')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.
