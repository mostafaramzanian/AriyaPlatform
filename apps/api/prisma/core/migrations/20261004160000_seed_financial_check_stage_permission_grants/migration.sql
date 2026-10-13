-- Phase CHECK-ISSUATION: register the FOUR stage permissions that gate states 3/4/6/7
-- of the check-issuance process, in the style of 20261003160100_seed_financial_permission_grants.
--
-- WHAT IS GATED, AND WHY EXACTLY THIS MUCH: the Preflight §17 candidate list, minus the
-- executive string the brief's §12 rule declines to create (stage 5 rides on the existing
-- `financial.check.approve` — see src/auth/rbac/constants/permissions.ts for the reasoning):
--
--   financial.check.allocate — stage 3 «صدور فرم تخصیص»: the allocation form;
--   financial.check.review    — stage 4 «بررسی اسناد»: the document-review decision;
--   financial.check.issue     — stage 6 «صدور چک»: cheque image + issuance confirm;
--   financial.check.deliver   — stage 7 «دریافت رسید تحویل»: receipt + completion.
--
-- A permission with no route that would gate on it claims authority before it exists —
-- F1's rule — and each of these four arrives WITH its route in the same phase, which is
-- the mirror image of that rule and equally deliberate.
--
-- GRANTS ARE NARROW (same shape as F1):
--   SUPER_ADMIN -> all four (the whole catalogue by definition; matches
--                  RolePermissions[SUPER_ADMIN] in src/auth/rbac/constants/roles.ts);
--   ADMIN       -> all four (the tenant's administrator; F1's three + these four);
--   every other role -> NONE. Financial stage access is opt-in per tenant policy.
--
-- PERMISSION ≠ ENTITLEMENT: these rows answer "may this USER act", never "may this TENANT
-- hold the module" — that question stays with ModuleRegistration / ModuleFeature rows.
--
-- Idempotent (ON CONFLICT DO NOTHING) so core_db can be rebuilt from migrations alone.

INSERT INTO "Permission" (id, name, "displayName", domain, description)
VALUES
  ('financial-check-allocate',
   'financial.check.allocate',
   'Allocate Financial Check Requests',
   'FINANCIAL',
   'Record the allocation form (stage 3) on a check request within the tenant'),
  ('financial-check-review',
   'financial.check.review',
   'Review Financial Check Request Documents',
   'FINANCIAL',
   'Record the document-review decision (stage 4) on a check request within the tenant'),
  ('financial-check-issue',
   'financial.check.issue',
   'Issue Financial Checks',
   'FINANCIAL',
   'Upload the cheque image and confirm issuance (stage 6) on a check request within the tenant'),
  ('financial-check-deliver',
   'financial.check.deliver',
   'Complete Financial Check Delivery',
   'FINANCIAL',
   'Upload the delivery receipt and complete the flow (stage 7) on a check request within the tenant')
ON CONFLICT (name) DO NOTHING;

-- SUPER_ADMIN: the full catalogue, which now includes the four stage permissions.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'SUPER_ADMIN'
  AND p.name IN ('financial.check.allocate', 'financial.check.review', 'financial.check.issue', 'financial.check.deliver')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- ADMIN: all four, matching the tenant administrator remit F1's three established.
INSERT INTO "RolePermission" (id, "roleId", "permissionId")
SELECT gen_random_uuid()::text, r.id, p.id
FROM "Role" r
CROSS JOIN "Permission" p
WHERE r.name = 'ADMIN'
  AND p.name IN ('financial.check.allocate', 'financial.check.review', 'financial.check.issue', 'financial.check.deliver')
ON CONFLICT ("roleId", "permissionId") DO NOTHING;

-- No further INSERT. The absence of OPERATIONS_ADMIN / SECURITY_ADMIN / PARTNER /
-- CUSTOMER / EMPLOYEE / VISITOR grants above is the decision, not an omission.
