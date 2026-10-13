-- Phase 49M-2: register the observability read permission in the catalogue and grant it,
-- in the style of 20260905120500_seed_module_permission_grants (49M) and
-- 20260904120500_seed_integration_permission_grants (49L).
--
-- WHY THIS MIGRATION EXISTS: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from "Permission" ⨝ "RolePermission" ⨝ "Role", so a permission
-- with no catalogue row is a permission NOBODY has — every guarded observability route
-- would 403 for every caller, including SUPER_ADMIN.
--
-- ONE PERMISSION, NOT TWO, breaking the pattern of 49L/49M deliberately: there is nothing
-- here to `manage`. Levels, queue sizes, flush cadence and the four retention windows are
-- environment variables read once at startup, and every row in observability_db is written
-- by the platform itself, never by an administrator. An `admin.observability.manage`
-- string would gate an empty set of operations.
--
-- WHY IT IS NOT `admin.audit.read`, WHICH ALREADY EXISTS: that permission gates
-- core_db."AuditLog" and is held by ADMIN. Reading the new tables through it would
-- silently widen ADMIN's reach to "SecurityEvent", whose failed-login and
-- permission-denial rows belong to the SUPER_ADMIN/SECURITY_ADMIN audience that
-- `admin.security.read` already describes.
--
-- THIS PERMISSION DOES NOT GRANT SECURITY EVENTS. GET /admin/observability/security-events
-- is gated by `admin.security.read` INSTEAD of this permission, not in addition to it:
-- RolesGuard resolves @Roles(...) with `.some(...)`, so naming two permissions grants
-- access to holders of EITHER and would WIDEN the route to OPERATIONS_ADMIN. Substitution
-- is the only way to express a narrower audience under OR semantics. This permission alone
-- covers application logs, audit events, lifecycle events, health and metrics.

--
-- core_db."AuditLog" AND ITS PERMISSIONS ARE UNCHANGED (§51 KEEP). `admin.audit.read` and
-- `admin.audit.export` keep gating the existing audit endpoints; nothing here revokes,
-- renames or re-grants them.
--
-- Grants are deliberately narrow:
--   SUPER_ADMIN      → yes (it holds the full catalogue by definition)
--   ADMIN            → yes (platform administration includes reading platform logs)
--   OPERATIONS_ADMIN → yes. This is the role that diagnoses incidents; it already holds
--                      admin.system.read, admin.ai.read, admin.integrations.read and
--                      admin.modules.read. Withholding log access from the diagnostic
--                      role would make the permission useless in practice.
--   SECURITY_ADMIN   → yes. Unlike 49M, where it was granted NEITHER module permission
--                      because the credential is never returned anyway, security events
--                      are precisely its remit — and the security route is gated on
--                      admin.security.read, which it already holds, so this grant gives it
--                      the application-log and lifecycle context around an incident.

--   every other role → no. These tables contain user ids, IP addresses, user agents and
--                      redacted before/after values across every tenant.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations alone and
-- a re-run is a no-op.

-- Permission catalogue row. Id follows the existing hyphenated convention
-- ('admin-modules-read' → 'admin-observability-read'). Domain is ADMIN because
-- "PermissionDomain" has no OBSERVABILITY member and adding one would be an enum change
-- with a single occupant.
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('admin-observability-read', 'admin.observability.read', 'Read Observability', 'ADMIN', 'View application logs, audit events, security events and lifecycle events with their retention history')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the observability permission.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name = 'admin.observability.read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: platform administration includes reading the platform's own logs.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name = 'admin.observability.read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- OPERATIONS_ADMIN: the diagnostic role. This is the grant that makes the feature useful.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'OPERATIONS_ADMIN'
  AND p.name = 'admin.observability.read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- SECURITY_ADMIN: security events are its remit, and it already holds admin.security.read
-- which gates the security route itself; this grant adds the surrounding log context.

INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SECURITY_ADMIN'
  AND p.name = 'admin.observability.read'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. PARTNER / CUSTOMER / EMPLOYEE / VISITOR hold no observability access.
