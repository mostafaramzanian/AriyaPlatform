-- Phase 51-HR-1: register the HR domain member on PermissionDomain.
--
-- WHY THIS IS ITS OWN MIGRATION (and why the seed is a separate, later one):
-- PostgreSQL allows `ALTER TYPE ... ADD VALUE` inside a transaction (12+), but the new
-- value CANNOT BE USED until the transaction that added it commits (SQLSTATE 55P04,
-- "unsafe use of new value"). Phase 50 hit exactly this with CORRESPONDENCE and had to
-- split the ALTER from the INSERTs; the same split is applied here so the HR seed can
-- reference 'HR' at all. The enum member is therefore added HERE, committed by this
-- migration, and consumed by the INSERTs in 20260916100100.
--
-- This member is required because "Permission".domain is the PermissionDomain enum
-- (prisma/core/schema.prisma), which is mirrored by PermissionDomain in
-- src/auth/rbac/constants/permissions.ts. HR permissions are stored against their own
-- domain rather than being folded into ADMIN: the role-management UI groups permissions
-- by domain, and filing personnel access under ADMIN would make an HR-only role
-- indistinguishable from a system administrator in that screen.
--
-- Idempotent: IF NOT EXISTS makes a re-run a no-op.

ALTER TYPE "PermissionDomain" ADD VALUE IF NOT EXISTS 'HR';