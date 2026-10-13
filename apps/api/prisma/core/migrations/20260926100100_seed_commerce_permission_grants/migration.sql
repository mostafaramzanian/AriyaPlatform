-- Phase C1 step J: register the six `commerce.*` permissions in the catalogue and grant
-- them explicitly, in the style of 20260916100100_seed_hr_permission_grants.
--
-- Why this migration exists at all: a permission string that only lives in
-- src/auth/rbac/constants/permissions.ts is not enforceable. RolesGuard resolves a
-- caller's permissions from the "Permission" + "RolePermission" + "Role" tables, so a
-- permission with no catalogue row is a permission NOBODY has — every guarded Commerce
-- route would 403 for every caller, including SUPER_ADMIN. The rows created here are
-- what will make the `@Roles(...)` gates on the Commerce controllers (C1 steps L, M, P)
-- real rather than authorization theatre.
--
-- WHAT IS GATED, AND WHY EXACTLY THIS MUCH (C1 §10's declared list, no more):
--   commerce.read              — purchase read/list/detail, workflow history, commercial
--                                entry reads (§8's read routes);
--   commerce.manage            — purchase create / update / submit (§8 purchase API);
--   commerce.approve           — commercial approval and workflow decision actions
--                                (§8 commercial approval, workflow action endpoints);
--   commerce.configure         — procurement workflow configuration (§6's product
--                                capability, §8's workflow configuration endpoints);
--   commerce.workflow.manage   — workflow definition/version lifecycle: author, validate,
--                                publish, archive (§8 workflow API);
--   commerce.commercial.manage — assignment, quotation entry, confirmation, correction
--                                (§8 commercial API).
--
-- The names are §10's own — "Permissions may include: commerce.read ... commerce.
-- commercial.manage" followed by "Do not blindly create every permission. Each
-- permission must be justified by actual API behavior" and "Register them through a
-- Core migration". The justification for each of the six is the §8 endpoint set above:
-- every string maps to behavior C1 itself requires of this phase. Deliberately ABSENT
-- (the decision, not an omission): any seventh string — no `commerce.use`, no per-line,
-- per-vendor or per-amount scoping permission, no per-workflow-step permission — because
-- no C1 route asks for one, and a permission with no route that would gate on it claims
-- authority before it exists.
--
-- GRANTS ARE NARROW AND ARE NOT "EVERY ADMIN GETS EVERYTHING":
--   SUPER_ADMIN      -> all six. Holds the full catalogue by definition; CROSS JOIN over
--                       "Permission" matches ROLE_PERMISSIONS[SUPER_ADMIN] in
--                       src/auth/rbac/constants/roles.ts — the same shape every earlier
--                       grant migration used.
--   ADMIN            -> all six. The tenant's administrator; the shape the HR grants
--                       (20260916100100) established for a business module's remit.
--   OPERATIONS_ADMIN -> NONE. System operations; not procurement administration.
--   SECURITY_ADMIN   -> NONE. Audit/security scope, not purchasing.
--   every other role -> NONE. Procurement access is opt-in per tenant policy, granted
--                       through the existing role-management surface.
--
-- PERMISSION ≠ ENTITLEMENT: these rows answer "may this USER act", never "may this
-- TENANT hold the module". The tenant-side question is answered only by
-- "ModuleRegistration"/"ModuleFeature" rows (20260926100200 and 20260926100300), and no
-- row written here touches those tables. Holding all six strings still refuses a request
-- whose tenancy is not entitled — the §5 two-layer model.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations alone
-- and a re-run is a no-op.
--
-- NOTE: the 'COMMERCE' PermissionDomain member is added by the PREVIOUS migration
-- (20260926100000). It must not be added here: PostgreSQL forbids USING a newly added
-- enum value inside the same transaction that added it (SQLSTATE 55P04), so the ALTER and
-- these INSERTs must commit in separate transactions.

-- Permission catalogue rows. Ids follow the existing hyphenated convention
-- ('correspondence-manage' -> 'hr-employees-read' -> 'commerce-read'); the `name` column
-- is the unique identity these inserts conflict on.
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('commerce-read',              'commerce.read',              'Read Commerce',              'COMMERCE', 'Read purchase documents, workflow history and commercial entries within the tenant'),
  ('commerce-manage',            'commerce.manage',            'Manage Commerce',            'COMMERCE', 'Create, update and submit purchase documents within the tenant'),
  ('commerce-approve',           'commerce.approve',           'Approve Commerce',           'COMMERCE', 'State approval or rejection decisions on purchases and workflow steps within the tenant'),
  ('commerce-configure',         'commerce.configure',         'Configure Commerce',         'COMMERCE', 'Author, validate, publish and archive procurement workflow configuration within the tenant'),
  ('commerce-workflow-manage',   'commerce.workflow.manage',   'Manage Commerce Workflow',   'COMMERCE', 'Create and version procurement workflow definitions and govern their lifecycle within the tenant'),
  ('commerce-commercial-manage', 'commerce.commercial.manage', 'Manage Commerce Commercial', 'COMMERCE', 'Record assignments, quotations, confirmations and corrections against purchases within the tenant')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the six new permissions.
-- CROSS JOIN over "Permission" matches ROLE_PERMISSIONS[SUPER_ADMIN] in
-- src/auth/rbac/constants/roles.ts and is how the earlier grant migrations did it.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN (
    'commerce.read', 'commerce.manage', 'commerce.approve',
    'commerce.configure', 'commerce.workflow.manage', 'commerce.commercial.manage'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: all six, matching the tenant administrator remit the HR grants established.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN (
    'commerce.read', 'commerce.manage', 'commerce.approve',
    'commerce.configure', 'commerce.workflow.manage', 'commerce.commercial.manage'
  )
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.