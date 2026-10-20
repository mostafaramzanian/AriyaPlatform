import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MotionPreference, ThemePreference, UIDensity } from '../../generated/core-client';

/**
 * Phase 49K: preference write contract.
 *
 * NO DTO HERE CARRIES A `userId`, `tenantId`, `id` OR ANY TIMESTAMP. The owner is the
 * authenticated subject resolved from the request context, there is no route
 * parameter to point somewhere else, and `createdAt`/`updatedAt` belong to the
 * database. A client therefore cannot write another user's preferences, and cannot
 * claim a change happened at a time it did not.
 *
 * NOTHING HERE IS AUTHORITATIVE. `dashboardLayout` names widgets and `navFavorites`
 * names hrefs; neither grants access to either. Both are re-filtered against the
 * caller's live permissions on every READ, so a layout saved while a permission was
 * held stops resolving the moment it is revoked — without an error and without a
 * migration to clean it up.
 *
 * PATCH SEMANTICS: every field is optional and an omitted field is LEFT UNCHANGED. A
 * client may therefore send only the setting the user just touched. The global
 * ValidationPipe runs with `whitelist` + `forbidNonWhitelisted`, so an unexpected
 * property is rejected rather than silently dropped — which matters here because a
 * typo'd `theeme` that vanished while the response reported success would look
 * exactly like a broken toggle.
 *
 * ENUMS ARE VALIDATED WITH `@IsIn` AGAINST THE GENERATED PRISMA ENUM OBJECTS rather
 * than `@IsEnum`, so the accepted set is derived from the schema instead of restated:
 * adding a member to `ThemePreference` cannot leave this file behind. The literal
 * union types come from the same generated source.
 */

/**
 * The four supported root font-size steps, as percentages.
 *
 * AN ENUMERATED SET, NOT A RANGE, and that is the deliberate part. A `@Min(100)` /
 * `@Max(140)` pair would admit 137%, which no control in the UI produces and no token
 * set renders. Out-of-step values are REFUSED rather than rounded, so what is stored
 * is always a step the stylesheet has a definition for. The same set is enforced at
 * the database level by the `UserPreference_textScale_allowed` CHECK.
 */
export const TEXT_SCALE_STEPS = [100, 110, 125, 140] as const;

export type TextScaleStep = (typeof TEXT_SCALE_STEPS)[number];

/**
 * Bounds for the two navigation lists, matching the
 * `UserPreference_navFavorites_bounded` and `UserPreference_navRecent_bounded`
 * CHECKs exactly. Restating them here means an over-long list is refused with a
 * validation error naming the field rather than surfacing as a database constraint
 * violation.
 */
export const MAX_NAV_FAVORITES = 12;
export const MAX_NAV_RECENT = 10;

/**
 * Longest href accepted into either list. Generous for the real routes
 * (`/admin/directory/<uuid>` is 60 characters) while still bounding what a single
 * entry can cost, since the arrays themselves are bounded only by COUNT in SQL.
 */
export const MAX_NAV_HREF = 200;

/**
 * Upper bound on submitted layout entries.
 *
 * Set to a small multiple of the registry rather than to its exact size on purpose:
 * the registry is code and will grow, and a client that sends one stale id alongside
 * the current set should get a precise "unknown widget" error from the service rather
 * than a size error from validation. Unknown ids are still refused on write — this
 * only stops an unbounded array from reaching that check.
 */
export const MAX_DASHBOARD_LAYOUT_ENTRIES = 40;

/** Longest accepted widget id. Registry ids are short, kebab-case strings. */
export const MAX_WIDGET_ID = 64;

/**
 * One dashboard widget's placement. ORDER IS THE ARRAY ORDER — there is no explicit
 * `order` or `position` field, because two representations of the same thing can
 * disagree, and an index that must be renumbered on every reorder is the harder one
 * to keep correct.
 *
 * `visible` is REQUIRED: an entry that omitted it would leave "is this widget hidden"
 * undecided, and defaulting it silently would make a hide-then-reorder round trip
 * quietly unhide the widget.
 */
export class DashboardLayoutEntryDto {
  @IsString()
  @MaxLength(MAX_WIDGET_ID)
  id!: string;

  @IsBoolean()
  visible!: boolean;
}

export class UpdatePreferenceDto {
  // ── Appearance ──────────────────────────────────────────────────────────────
  /**
   * SYSTEM is a real, storable value — not the absence of one. That is the entire fix
   * for A2: today the pre-paint script consults `prefers-color-scheme` only while
   * nothing is stored, so the first toggle makes the choice permanently sticky with no
   * way back to "follow the OS".
   */
  @IsOptional()
  @IsIn(Object.values(ThemePreference))
  theme?: ThemePreference;

  @IsOptional()
  @IsIn(Object.values(UIDensity))
  density?: UIDensity;

  // ── Accessibility ───────────────────────────────────────────────────────────
  /**
   * Root font-size percentage. `enableImplicitConversion` on the global pipe turns a
   * numeric string into a number, so `"110"` from a `<select>` is accepted while
   * `"large"` is not.
   */
  @IsOptional()
  @IsIn(TEXT_SCALE_STEPS as readonly number[])
  textScale?: TextScaleStep;

  @IsOptional()
  @IsIn(Object.values(MotionPreference))
  motion?: MotionPreference;

  // ── Navigation ──────────────────────────────────────────────────────────────
  @IsOptional()
  @IsBoolean()
  sidebarCollapsed?: boolean;

  /**
   * Opt-in switches for the two navigation personalization features. Both default
   * OFF — the user turns them on under «تنظیمات». Disabling hides the feature but
   * keeps the stored lists, so re-enabling restores rather than wipes.
   */
  @IsOptional()
  @IsBoolean()
  navFavoritesEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  navRecentEnabled?: boolean;

  /**
   * Pinned hrefs in user-chosen display order, so this is an ordered list and not a
   * set. Shape and size are checked here; whether each href EXISTS in the navigation
   * tree and whether the CALLER may open it are decided by the service, the only layer
   * that can see the catalogue and the permission set.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_NAV_FAVORITES)
  @IsString({ each: true })
  @MaxLength(MAX_NAV_HREF, { each: true })
  navFavorites?: string[];

  /**
   * Most-recently-visited hrefs, newest first.
   *
   * Accepted as a whole list rather than as a single "I just visited X" push: the
   * client already knows the order it wants, a full replace is idempotent under retry,
   * and a push endpoint would need its own de-duplication and trimming rules on top of
   * the ones the service already applies here.
   *
   * The service additionally REFUSES audit surfaces (security events, login history)
   * regardless of what is submitted — see `RECENT_EXCLUDED_PREFIXES`.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_NAV_RECENT)
  @IsString({ each: true })
  @MaxLength(MAX_NAV_HREF, { each: true })
  navRecent?: string[];

  // ── Dashboard ───────────────────────────────────────────────────────────────
  /**
   * Widget order and visibility.
   *
   * AN EMPTY ARRAY IS LEGAL and means "every widget hidden" — distinct from omitting
   * the field, which leaves the stored layout untouched, and from the stored NULL that
   * means "never customised, use the registry default". All three states are reachable
   * and none is a synonym for another: `[]` is a choice, NULL is the absence of one,
   * and omission is silence.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DASHBOARD_LAYOUT_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => DashboardLayoutEntryDto)
  dashboardLayout?: DashboardLayoutEntryDto[];

  /**
   * Explicit reset of the dashboard layout to the registry default.
   *
   * A separate flag rather than an in-band `dashboardLayout: null`, for the same reason
   * `clearCredential` is separate from `credential` in 49J-0's
   * `UpdateAIProviderConfigDto`: with `@IsOptional()` a nullable field cannot
   * distinguish "sent as null" from "not sent", so "reset" and "leave alone" would be
   * the same request. The service refuses this flag in the same request as
   * `dashboardLayout`, so "reset it" and "set it" can never arrive together and be
   * resolved by whichever branch happens to run first.
   */
  @IsOptional()
  @IsBoolean()
  resetDashboardLayout?: boolean;
}
