-- Phase 49K: Core Experience Platform — user-scoped preferences.
--
-- Adds ONE table and THREE enums. No change to any existing table's columns,
-- constraints or indexes: "User" gains only a new INBOUND foreign key, exactly as
-- it did in 49E ("Notification") and 49I ("Reminder"). Nothing here touches
-- "Tenant", Role/Permission/RolePermission/UserRole (RBAC), "AuditLog"/
-- "AuditDispatch", "Notification" (49E), "Conversation"/"Message" (49F),
-- "Ticket*" (49G), "Survey*" (49H), "Reminder" (49I), "AIProviderConfig" (49J-0)
-- or "SearchDocument" (49J). Core schema only: nothing here touches `cms_db`.
--
-- NON-DESTRUCTIVE BY CONSTRUCTION: no DROP, no ALTER of an existing column, no
-- data backfill and no seed row. Every column is either NOT NULL WITH A DEFAULT
-- or nullable, so the table is complete the moment it is created and a rollback
-- is a single DROP TABLE.
--
-- NO new permission row and NO new grant, for the same reason 49I and 49J
-- introduced none: setting one's own theme, density or sidebar state is an
-- ordinary authenticated-user capability, enforced by OWNERSHIP in the service.
-- Inventing 'preferences.write' would imply a revocable-per-role model this phase
-- does not build — and would make it possible to revoke a user's ability to
-- enlarge their own text, which is an accessibility accommodation, not a
-- privilege.
--
-- RBAC REMAINS THE AUTHORITY. "dashboardLayout" and "navFavorites" store widget
-- ids and navigation hrefs, and neither grants anything: both are re-filtered
-- against the caller's LIVE permissions on every read. A layout saved while a
-- permission was held silently stops resolving the moment it is revoked, with no
-- error and no cleanup migration.

-- ============================================================================
-- ENUMS
-- ============================================================================

-- CreateEnum
-- SYSTEM is a first-class member, not a synonym for LIGHT. The current pre-paint
-- script consults `prefers-color-scheme` only while nothing is stored, so today
-- the FIRST toggle makes the choice permanently sticky with no way back to
-- "follow the OS". SYSTEM is that way back, and it is the DEFAULT so an untouched
-- account keeps behaving exactly as it does now.
CREATE TYPE "ThemePreference" AS ENUM ('SYSTEM', 'LIGHT', 'DARK');

-- CreateEnum
-- Two members only, matching the two spacing token sets the shell defines. A
-- third would name a density no stylesheet implements, turning a settings save
-- into a no-op the user cannot see.
CREATE TYPE "UIDensity" AS ENUM ('COMFORTABLE', 'COMPACT');

-- CreateEnum
-- SYSTEM defers to `prefers-reduced-motion`, REDUCED forces reduction regardless
-- of the OS, FULL forces animation regardless of it.
--
-- FULL exists because the OS switch is GLOBAL: a user who enabled it for one
-- hostile application should not be left unable to opt back in here. SYSTEM is
-- the default, so an untouched account honours the OS preference — which the Core
-- shell currently fails to do at all (`usePrefersReducedMotion` already exists in
-- apps/web/src/hooks/useMediaQuery.ts and no Core component calls it).
CREATE TYPE "MotionPreference" AS ENUM ('SYSTEM', 'REDUCED', 'FULL');

-- ============================================================================
-- TABLE
-- ============================================================================
--
-- ONE TABLE, NOT FIVE. Every column is read together on exactly one occasion —
-- the first render of the Core shell — so splitting appearance, accessibility,
-- navigation and dashboard across four tables would turn a single-row lookup into
-- four joins to reconstruct one object, with four rows to keep consistent and
-- four chances for a partial write. The grouping is expressed in column names.
--
-- THE ROW IS OPTIONAL. A user who has never changed a setting has NO row: the
-- service returns code-level defaults instead, because a GET must not write. The
-- row appears on the first PATCH (upsert), so this table's size tracks users who
-- actually personalised something rather than the user count.
--
-- NO "tenantId" SNAPSHOT, unlike "Notification" (49E) and "Reminder" (49I). Those
-- two carry one because they have LIST reads that must stay tenant-consistent. A
-- preference read is a single-row lookup on a UNIQUE "userId" that is always the
-- authenticated caller's own id, so a tenant column would participate in no
-- predicate and no index — and a user who moves between tenants should keep their
-- own theme rather than silently lose it.
--
-- NO "locale" COLUMN, and that is the most deliberate omission here.
-- apps/web/src/lib/i18n.ts is a `t()` helper consumed by exactly ONE marketing
-- component (PageSections.tsx); every Core string is hardcoded Persian in the
-- component that renders it, and there is no locale provider and no locale
-- routing. A persisted locale would be a value nothing reads — a switch that
-- changes a column and not the interface. It arrives when localization does.
--
-- DELIBERATELY ABSENT: per-widget refresh intervals, dashboard sharing or
-- templates, saved filters, keyboard-shortcut remapping, notification channel
-- preferences (49E has no channel model), and any role- or tenant-level default.
-- Each is a product decision this phase has no contract for.
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,

    -- The owner, and the only predicate any query uses. UNIQUE below.
    "userId" TEXT NOT NULL,

    -- ── Appearance ──────────────────────────────────────────────────────────
    "theme" "ThemePreference" NOT NULL DEFAULT 'SYSTEM',
    "density" "UIDensity" NOT NULL DEFAULT 'COMFORTABLE',

    -- ── Accessibility ───────────────────────────────────────────────────────
    -- Root font-size percentage. An INTEGER rather than an enum because it is a
    -- numeric quantity the stylesheet divides by 100, and because widening the
    -- supported set later must not require an enum migration. The four supported
    -- steps are pinned by the CHECK below.
    "textScale" INTEGER NOT NULL DEFAULT 100,

    "motion" "MotionPreference" NOT NULL DEFAULT 'SYSTEM',

    -- ── Navigation ──────────────────────────────────────────────────────────
    -- Whether the desktop rail starts collapsed. Today this is React state in
    -- CoreShell, so it resets on every reload; persisting it is the entire fix.
    "sidebarCollapsed" BOOLEAN NOT NULL DEFAULT false,

    -- Pinned navigation hrefs in USER-CHOSEN DISPLAY ORDER, which is why this is
    -- an ordered TEXT[] and not a set or a join table. DEFAULT '{}' so "no
    -- favorites" has exactly one representation.
    --
    -- Bounded to 12 entries and to hrefs that exist in core-nav.ts. The LENGTH
    -- bound is asserted below; whether an entry is a real navigation href is
    -- decided in the service, because a CHECK cannot know the navigation tree.
    "navFavorites" TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- Most-recently-visited hrefs, newest first, trimmed to 10 by the service on
    -- every write so the column cannot grow without limit.
    --
    -- SECURITY-SENSITIVE ROUTES ARE NEVER RECORDED HERE. Security events and
    -- login history are AUDIT surfaces, not navigation history: a "recent" entry
    -- pointing at them would turn a convenience list into a second, unaudited
    -- trace of who inspected the audit trail. Enforced in the service.
    "navRecent" TEXT[] DEFAULT ARRAY[]::TEXT[],

    -- ── Dashboard ───────────────────────────────────────────────────────────
    -- Widget order and visibility: [{"id":"notifications","visible":true}, …].
    --
    -- JSONB, following "AuditLog"."oldValue"/"newValue"/"changes" — the existing
    -- precedent in this schema for a shape the database does not need to query.
    -- It is only ever read as a whole for one user and never filtered, sorted or
    -- joined on, so a relational widget-instance table would add a join and a
    -- second write path for a value with exactly one consumer.
    --
    -- NULL means "never customised" and resolves to the registry's default order.
    -- That is NOT the same as '[]', "every widget hidden": both are legal states,
    -- kept distinguishable on purpose so a user who hides everything is not
    -- silently reset to the defaults on the next load.
    --
    -- The WIDGET CATALOGUE IS CODE, NOT DATA. There is no "DashboardWidget"
    -- table: a widget exists only if a React component renders it, so such a
    -- table could never hold a row the frontend did not already declare, while a
    -- write could save an id nothing renders. Unknown ids found here are IGNORED
    -- on read rather than rejected, so removing a widget in a later release
    -- cannot make a saved layout unloadable.
    "dashboardLayout" JSONB,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- CONSTRAINTS AND INDEXES
-- ============================================================================

-- CreateIndex
-- UNIQUE, not a plain index: one row per user is the invariant that makes the
-- write a single upsert rather than a find-then-branch, and it is what stops two
-- concurrent first-PATCHes from creating two preference rows for one user. It is
-- also the ONLY index this table needs — there is no list read, no tenant filter
-- and no sort, so any further index would be written on every PATCH and read by
-- nothing.
CREATE UNIQUE INDEX "UserPreference_userId_key" ON "UserPreference"("userId");

-- AddForeignKey
-- Cascade: preferences are personal, so deleting the owner deletes them. Same
-- rule as "Notification"."userId" (49E) and "Reminder"."userId" (49I).
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- CHECK constraints. Prisma does not emit these from the schema, so they are
-- hand-written here and documented in the model as the source of the rule.
-- ----------------------------------------------------------------------------

-- The four steps are ENUMERATED rather than expressed as a BETWEEN range: a range
-- would admit 137%, a value no UI control can produce and no token set renders.
-- An out-of-step value is refused rather than silently rounded, so what is stored
-- is always a step the interface can actually display.
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_textScale_allowed"
  CHECK ("textScale" IN (100, 110, 125, 140));

-- Array bounds. These assert only what SQL CAN know — the LENGTH of each list.
-- Whether an entry is a real navigation href, and whether the caller may still
-- see it, is decided in the service against core-nav.ts and live RBAC, because
-- neither the navigation tree nor the permission catalogue is visible from here.
--
-- The `array_length(...) IS NULL` arm is not redundant: Postgres returns NULL for
-- an EMPTY array, and a CHECK evaluating to NULL passes, but writing the arm out
-- keeps the intent explicit rather than resting on that coincidence.
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_navFavorites_bounded"
  CHECK ("navFavorites" IS NULL OR array_length("navFavorites", 1) IS NULL OR array_length("navFavorites", 1) <= 12);

ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_navRecent_bounded"
  CHECK ("navRecent" IS NULL OR array_length("navRecent", 1) IS NULL OR array_length("navRecent", 1) <= 10);

-- The layout must be a JSON ARRAY when present, never an object or a scalar.
-- Cheap to assert here and it removes a class of defect from the read path: the
-- service can iterate the value without first re-checking its shape. The
-- PER-ENTRY shape ({id, visible}) is validated by the DTO, which knows the widget
-- registry; SQL does not.
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_dashboardLayout_is_array"
  CHECK ("dashboardLayout" IS NULL OR jsonb_typeof("dashboardLayout") = 'array');

