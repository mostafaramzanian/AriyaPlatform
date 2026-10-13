-- Phase 54-E: register `hr.leave.approve` in the catalogue and grant it explicitly, in
-- the style of 20260919120000_seed_hr_leave_permission_grants.
--
-- WHY THIS MIGRATION EXISTS AT ALL: the same reason the leave pair's migration gives. A
-- permission string that lives only in src/auth/rbac/constants/permissions.ts is not
-- enforceable — RolesGuard resolves a caller's permissions from "Permission" +
-- "RolePermission" + "Role", so a permission with no catalogue row is one NOBODY has and
-- every approval route would 403 for every caller, SUPER_ADMIN included.
--
-- WHY IT IS A SEPARATE MIGRATION AND NOT AN AMENDMENT
-- ---------------------------------------------------
-- 20260919120000 left `hr.leave.approve` out and said why in writing: there was no
-- APPROVED / REJECTED state to gate, and the authority the readiness audit named was a
-- reporting subtree that does not exist. Phase 54-E brings the state, its transition
-- table, its CHECK, the approval family and this string TOGETHER — which is exactly the
-- arrival condition that note set. The earlier migration is NOT edited: it is history,
-- and a historical migration records what was true when it ran.
--
-- THE STRING IS A CAPABILITY, NOT A DECISION AUTHORITY
-- ---------------------------------------------------
-- `hr.leave.approve` answers "may this actor EVER decide a leave step in this tenant".
-- It does NOT answer "may they decide THIS request". The service requires BOTH, checked
-- separately:
--
--     permission            -> hr.leave.approve
--     flow authorization    -> actor == resolved approver of the ACTIVE step
--
-- "Has hr.leave.approve" therefore never implies "may approve arbitrary leave". A holder
-- who is not the resolved approver of the live step is refused by the flow check, and a
-- resolved approver without the string is refused by the permission check. Neither half
-- can stand in for the other.
--
-- WHY THE AUTHORITY IS THE RESOLVED APPROVER AND NOT A REPORTING SUBTREE
-- ---------------------------------------------------------------------
-- The audit's original sketch ("approve/reject for the reporting subtree") needed a
-- server-side traversal of the reporting line, and risk R6 records that the traversal
-- does not exist. Phase 54-E replaces that guess with something stronger and simpler:
-- authority comes from the CONFIGURED FLOW — a named approver, or a role named on the
-- step, resolved per request and frozen on the step row. Nothing is derived from a line
-- of command, so there is no traversal to be wrong about.
--
-- GRANTS ARE NARROW AND ARE NOT "EVERY ADMIN GETS EVERYTHING":
--   SUPER_ADMIN      -> yes. Holds the full catalogue by definition; CROSS JOIN over
--                       "Permission" matches RolePermissions[SUPER_ADMIN] in
--                       src/auth/rbac/constants/roles.ts.
--   ADMIN            -> yes. The tenant's HR administrator, and the role that will
--                       configure the flow in the first place.
--   OPERATIONS_ADMIN -> NONE. System operations; not personnel administration.
--   SECURITY_ADMIN   -> NONE. Audit/security scope, not personnel records.
--   EMPLOYEE         -> NONE. A named approver still requires the string to be granted
--                       to them; naming them on a step does not confer it, which is what
--                       keeps "who is asked" separate from "who may decide".
--   every other role -> NONE. Approval access is opt-in per tenant policy, granted
--                       through the existing role-management surface.
--
-- Idempotent (ON CONFLICT DO NOTHING) so the Core database can be rebuilt from migrations
-- alone and a re-run is a no-op. The 'HR' PermissionDomain member already exists (added by
-- 20260916100000), so no ALTER is needed here — and none may be: PostgreSQL forbids USING
-- a freshly added enum value inside the transaction that added it (SQLSTATE 55P04).

-- Permission catalogue row. Id follows the existing hyphenated convention
-- ('hr-leave-read' -> 'hr-leave-approve').
INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('hr-leave-approve', 'hr.leave.approve', 'Approve Leave', 'HR', 'Decide leave approval steps for which the actor is the resolved approver')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the new permission.
-- CROSS JOIN over "Permission" matches RolePermissions[SUPER_ADMIN] in
-- src/auth/rbac/constants/roles.ts and is how the earlier grant migrations did it.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name = 'hr.leave.approve'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: yes, matching the tenant HR administrator remit.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name = 'hr.leave.approve'
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / EMPLOYEE /
-- PARTNER / CUSTOMER / VISITOR grants above is the decision, not an omission.
