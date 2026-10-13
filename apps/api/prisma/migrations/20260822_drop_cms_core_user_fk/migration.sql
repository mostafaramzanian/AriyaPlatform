-- DC-CMS-01 (Phase 33E): Remove physical foreign keys from CMS-owned tables to
-- Core's User table. Columns and their values are preserved unchanged; only the
-- physical FK constraint (and its ON DELETE semantics) is dropped. This does not
-- move any data and does not create a second database -- it is a rehearsal for a
-- future CMS/Core persistence boundary.
--
-- Rationale: CMS never queries User/Role/Permission directly, never joins across
-- this relation, and only ever writes these columns with an already-authenticated
-- caller's id (validated by Core's JwtStrategy on every request, before CMS runs).
-- No feature in this repository currently relies on ON DELETE RESTRICT/SET NULL/
-- CASCADE behavior for these columns (there is no user-deletion feature at all).

-- DropForeignKey
ALTER TABLE "Media" DROP CONSTRAINT "Media_uploadedBy_fkey";

-- DropForeignKey
ALTER TABLE "BlogPost" DROP CONSTRAINT "BlogPost_authorId_fkey";

-- DropForeignKey
ALTER TABLE "BlogPost" DROP CONSTRAINT "BlogPost_editorId_fkey";

-- DropForeignKey
ALTER TABLE "CmsUserPermission" DROP CONSTRAINT "CmsUserPermission_userId_fkey";
