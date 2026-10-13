20260822_drop_cms_core_user_fk

Implements DC-CMS-01 (Phase 33E — CMS Persistence Boundary Rehearsal): removes the
physical foreign-key constraints from CMS-owned tables (`BlogPost`, `Media`,
`CmsUserPermission`) to Core's `User` table. Columns (`authorId`, `editorId`,
`uploadedBy`, `userId`) and their existing values are preserved unchanged; only the
DB-enforced FK constraint (and its `ON DELETE` semantics) is removed. This does not
split the database and does not move any data.

This SQL was generated via `prisma migrate diff --from-schema-datamodel <old> \
--to-schema-datamodel <new> --script`, comparing the previous committed
`schema.prisma` against the post-DC-CMS-01 `schema.prisma`, because no live
PostgreSQL/shadow-database instance was reachable in the working environment to run
`prisma migrate dev`. It has NOT been applied against or validated against a real
PostgreSQL instance in this environment. Before this migration is deployed to any
environment with real data, it must be verified against a database copy: confirm
`Media_uploadedBy_fkey`, `BlogPost_authorId_fkey`, `BlogPost_editorId_fkey`, and
`CmsUserPermission_userId_fkey` are the actual constraint names present (they match
the names created in `20260728_initial_schema/migration.sql`), and confirm the
migration applies cleanly.

Note: `prisma/migrations/migration_lock.toml` (provider = "postgresql") was added in
this same change because it was missing from the repository, which otherwise
prevents Prisma's own CLI from resolving the migrations directory at all (e.g. for
`prisma migrate diff --from-migrations`). This is a pre-existing repository gap
unrelated to CMS/Core boundary work, fixed here only because it blocked generating
this migration through Prisma's own tooling.
