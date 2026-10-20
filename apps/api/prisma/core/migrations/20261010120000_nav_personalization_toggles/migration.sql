-- ui-redesign: opt-in navigation personalization toggles.
--
-- Adds TWO boolean columns to "UserPreference", both NOT NULL DEFAULT false so
-- an untouched account — and every existing row — gets the features OFF. No data
-- change, no index, no enum; a rollback is a pair of DROP COLUMNs.
--
-- These gate presentation only: "navFavorites" and "navRecent" keep their stored
-- values while a feature is disabled, so re-enabling restores the user's pinned
-- or recorded hrefs instead of wiping them.
ALTER TABLE "UserPreference"
  ADD COLUMN "navFavoritesEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "navRecentEnabled"    BOOLEAN NOT NULL DEFAULT false;
