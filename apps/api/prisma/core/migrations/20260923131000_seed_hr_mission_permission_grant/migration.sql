-- Phase 55: register the Mission permission catalogue entries and grant them to
-- SUPER_ADMIN and ADMIN only.
--
-- Four permissions:
--   hr.mission.read   -> see mission requests, reports and configuration
--   hr.mission.manage -> create, update, submit, resubmit and cancel mission requests
--   hr.mission.approve -> decide approval steps for which the actor is the resolved approver
--   hr.mission.policy -> author, validate, publish and archive Mission policy versions
--
-- GRANTS ARE NARROW: only SUPER_ADMIN and ADMIN receive the strings by default.
-- A named approver must still be granted `hr.mission.approve` explicitly through the
-- existing role-management surface; being named on a step does not confer it.
--
-- Idempotent (ON CONFLICT DO NOTHING) so the Core database can be rebuilt from
-- migrations alone and a re-run is a no-op.

INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('hr-mission-read', 'hr.mission.read', 'Read Mission', 'HR', 'Read mission requests, reports and configuration'),
  ('hr-mission-manage', 'hr.mission.manage', 'Manage Mission', 'HR', 'Create, update, submit, resubmit and cancel mission requests'),
  ('hr-mission-approve', 'hr.mission.approve', 'Approve Mission', 'HR', 'Decide mission approval steps for which the actor is the resolved approver'),
  ('hr-mission-policy', 'hr.mission.policy', 'Mission Policy', 'HR', 'Author, validate, publish and archive mission policy versions')
ON CONFLICT (name) DO NOTHING;

INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('hr.mission.read', 'hr.mission.manage', 'hr.mission.approve', 'hr.mission.policy')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('hr.mission.read', 'hr.mission.manage', 'hr.mission.approve', 'hr.mission.policy')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;
