import { coreGet, corePatch } from './core-http';

/**
 * Phase 49K: unified personalization client.
 *
 * Mirrors the backend contract exactly (`GET /me/preferences`,
 * `PATCH /me/preferences`) and mirrors it NARROWLY.
 *
 * NO FUNCTION HERE ACCEPTS A `userId` OR A TENANT IDENTIFIER, and no path is
 * parameterised: the API has only `me/preferences` routes, derives the owner from the
 * authenticated identity, and runs `UpdatePreferenceDto` under `whitelist` +
 * `forbidNonWhitelisted`, so an extra property is REJECTED rather than ignored. The
 * client is therefore structurally incapable of reading or writing someone else's
 * preferences — and a typo like `theeme` fails loudly instead of looking like a broken
 * toggle.
 *
 * PATCH SEMANTICS: every field is optional and an omitted field is left UNCHANGED
 * server-side, so `savePreferences` sends only what the user just touched. The response
 * is always the FULL, re-filtered object, which is why no caller here merges a partial
 * response into local state.
 *
 * NOTHING RETURNED HERE IS AUTHORITATIVE. `navFavorites` and `dashboardLayout` name
 * routes and widgets; neither grants access to either. The server re-filters both
 * against live RBAC on every read, so a favourite whose permission was revoked simply
 * stops coming back. Rendering a link from this data is never a substitute for the
 * backend's own 403.
 */

/** Stored theme. `SYSTEM` is a real third state, not a synonym for `LIGHT`. */
export type ThemePreference = 'SYSTEM' | 'LIGHT' | 'DARK';

/** Two members only, matching the two spacing token sets the stylesheet defines. */
export type UIDensity = 'COMFORTABLE' | 'COMPACT';

/**
 * `SYSTEM` defers to `prefers-reduced-motion`, `REDUCED` forces reduction regardless
 * of the OS, `FULL` forces animation regardless of it. `FULL` exists because the OS
 * switch is global.
 */
export type MotionPreference = 'SYSTEM' | 'REDUCED' | 'FULL';

/**
 * The four supported root font-size steps, as percentages.
 *
 * An ENUMERATED SET, not a range, mirroring `TEXT_SCALE_STEPS` in the API DTO and the
 * `UserPreference_textScale_allowed` CHECK. An out-of-step value is refused by the
 * server rather than rounded, so the UI must only ever offer these four.
 */
export const TEXT_SCALE_STEPS = [100, 110, 125, 140] as const;

export type TextScaleStep = (typeof TEXT_SCALE_STEPS)[number];

/**
 * Backend list bounds, mirroring `MAX_NAV_FAVORITES` / `MAX_NAV_RECENT` and the two
 * `*_bounded` CHECKs. Restated here so the UI can refuse a 13th favourite locally
 * instead of discovering the limit through a validation error.
 */
export const MAX_NAV_FAVORITES = 12;
export const MAX_NAV_RECENT = 10;

export interface PreferenceLayoutEntry {
  id: string;
  visible: boolean;
}

/** Exactly the fields the backend projection returns. */
export interface UserPreferences {
  theme: ThemePreference;
  density: UIDensity;
  textScale: number;
  motion: MotionPreference;
  sidebarCollapsed: boolean;
  /** Already filtered to targets the caller may currently open. */
  navFavorites: string[];
  /** Already filtered, and never contains an audit surface. */
  navRecent: string[];
  /** Always the full widget registry, ordered; hidden widgets carry `visible: false`. */
  dashboardLayout: PreferenceLayoutEntry[];
  /**
   * False when no row exists and every value above is a server-side default. Lets the
   * UI say "using defaults" honestly instead of implying a saved choice.
   */
  customized: boolean;
  /** Null while `customized` is false — there is nothing to have been updated. */
  updatedAt: string | null;
}

/**
 * The write contract. Every field optional; an omitted one is left untouched.
 *
 * `resetDashboardLayout` is a separate flag rather than an in-band
 * `dashboardLayout: null` because an optional nullable field cannot distinguish "sent
 * as null" from "not sent" — "reset it" and "leave it alone" would be the same request.
 * The server REFUSES both fields in one request, so they can never be resolved by
 * whichever branch happens to run first.
 */
export interface PreferencePatch {
  theme?: ThemePreference;
  density?: UIDensity;
  textScale?: TextScaleStep;
  motion?: MotionPreference;
  sidebarCollapsed?: boolean;
  navFavorites?: string[];
  navRecent?: string[];
  dashboardLayout?: PreferenceLayoutEntry[];
  resetDashboardLayout?: boolean;
}

/**
 * The defaults an untouched account sees, matching `PREFERENCE_DEFAULTS` in
 * `preference.service.ts` and the `@default(...)` annotations on `UserPreference`.
 *
 * Restated here for the render BEFORE the first response arrives — not as a second
 * source of truth. The server's answer always replaces this.
 */
export const PREFERENCE_DEFAULTS: Readonly<
  Pick<UserPreferences, 'theme' | 'density' | 'textScale' | 'motion' | 'sidebarCollapsed'>
> = {
  theme: 'SYSTEM',
  density: 'COMFORTABLE',
  textScale: 100,
  motion: 'SYSTEM',
  sidebarCollapsed: false,
};

const THEMES: readonly ThemePreference[] = ['SYSTEM', 'LIGHT', 'DARK'];
const DENSITIES: readonly UIDensity[] = ['COMFORTABLE', 'COMPACT'];
const MOTIONS: readonly MotionPreference[] = ['SYSTEM', 'REDUCED', 'FULL'];

/** Keeps only strings, so a malformed array cannot put `undefined` into an href list. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function layoutList(value: unknown): PreferenceLayoutEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

    const { id, visible } = raw as { id?: unknown; visible?: unknown };
    if (typeof id !== 'string') return [];

    // A non-boolean `visible` reads as visible: showing a widget on a corrupt entry is
    // recoverable by the user, silently hiding one is not.
    return [{ id, visible: visible !== false }];
  });
}

/**
 * Normalises the response so a partial or malformed body degrades to defaults instead
 * of rendering `undefined` into an attribute on `<html>`.
 *
 * This is the same defensive shape `fetchMyRbac` applies, and it matters more here:
 * these values are written to the document element, so one bad field would otherwise
 * become a visible layout defect rather than a missing list.
 */
export function normalizePreferences(raw: Partial<UserPreferences> | null): UserPreferences {
  const theme = THEMES.includes(raw?.theme as ThemePreference)
    ? (raw!.theme as ThemePreference)
    : PREFERENCE_DEFAULTS.theme;

  const density = DENSITIES.includes(raw?.density as UIDensity)
    ? (raw!.density as UIDensity)
    : PREFERENCE_DEFAULTS.density;

  const motion = MOTIONS.includes(raw?.motion as MotionPreference)
    ? (raw!.motion as MotionPreference)
    : PREFERENCE_DEFAULTS.motion;

  const textScale = (TEXT_SCALE_STEPS as readonly number[]).includes(raw?.textScale as number)
    ? (raw!.textScale as number)
    : PREFERENCE_DEFAULTS.textScale;

  return {
    theme,
    density,
    textScale,
    motion,
    sidebarCollapsed:
      typeof raw?.sidebarCollapsed === 'boolean'
        ? raw.sidebarCollapsed
        : PREFERENCE_DEFAULTS.sidebarCollapsed,
    navFavorites: stringList(raw?.navFavorites),
    navRecent: stringList(raw?.navRecent),
    dashboardLayout: layoutList(raw?.dashboardLayout),
    customized: raw?.customized === true,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export async function fetchPreferences(): Promise<UserPreferences> {
  return normalizePreferences(await coreGet<Partial<UserPreferences>>('/me/preferences'));
}

/**
 * Applies a partial update and returns the full, re-filtered result.
 *
 * The server rejects an EMPTY patch with a 400 (`At least one preference field must be
 * provided`), so callers must not send `{}` — the provider guards that by only calling
 * this from an explicit user action.
 */
export async function savePreferences(patch: PreferencePatch): Promise<UserPreferences> {
  return normalizePreferences(
    await corePatch<Partial<UserPreferences>>('/me/preferences', patch),
  );
}

/* -------------------------------------------------------------------------- */
/* Presentation helpers. Display-only: nothing below is ever sent to the API.  */
/* -------------------------------------------------------------------------- */

export const THEME_LABELS: Record<ThemePreference, string> = {
  SYSTEM: 'هماهنگ با سیستم',
  LIGHT: 'روشن',
  DARK: 'تیره',
};

export const DENSITY_LABELS: Record<UIDensity, string> = {
  COMFORTABLE: 'استاندارد',
  COMPACT: 'فشرده',
};

export const MOTION_LABELS: Record<MotionPreference, string> = {
  SYSTEM: 'هماهنگ با سیستم',
  REDUCED: 'کاهش انیمیشن',
  FULL: 'انیمیشن کامل',
};

export const TEXT_SCALE_LABELS: Record<TextScaleStep, string> = {
  100: 'عادی',
  110: 'بزرگ',
  125: 'بزرگ‌تر',
  140: 'حداکثر',
};
