import {
  MAX_NAV_FAVORITES,
  MAX_NAV_RECENT,
  PREFERENCE_DEFAULTS,
  TEXT_SCALE_STEPS,
  fetchPreferences,
  normalizePreferences,
  savePreferences,
  type UserPreferences,
} from '../preferences-api';
import { coreGet, corePatch } from '../core-http';

/**
 * Phase 49K coverage for the preferences client.
 *
 * THREE INVARIANTS ARE UNDER TEST, and the first two carry security weight:
 *
 *  1. NEITHER CALL CAN BE SHAPED TO REACH ANOTHER USER'S ROW. The path is a literal
 *     `/me/preferences` with no interpolation, and the API runs `forbidNonWhitelisted`
 *     so an extra body key is a 400 rather than an ignored field. Every assertion below
 *     inspects the EXACT path and the EXACT body that is sent.
 *
 *  2. `savePreferences` SENDS ONLY WHAT IT WAS GIVEN. An omitted field is left unchanged
 *     server-side, so a client that helpfully filled in the rest of the object would
 *     overwrite a value changed in another tab a moment earlier.
 *
 *  3. `normalizePreferences` NEVER PRODUCES AN UNRENDERABLE VALUE. These fields are
 *     written to attributes on `<html>`, so `undefined` leaking through would be a
 *     visible layout defect rather than a missing list.
 */

jest.mock('../core-http', () => ({
  coreGet: jest.fn(),
  corePatch: jest.fn(),
}));

const getMock = coreGet as jest.MockedFunction<typeof coreGet>;
const patchMock = corePatch as jest.MockedFunction<typeof corePatch>;

/** A full, valid server payload — every field explicitly non-default. */
const FULL: UserPreferences = {
  theme: 'DARK',
  density: 'COMPACT',
  textScale: 125,
  motion: 'REDUCED',
  sidebarCollapsed: true,
  navFavorites: ['/admin/blog'],
  navRecent: ['/admin', '/admin/blog'],
  dashboardLayout: [
    { id: 'identity', visible: true },
    { id: 'access', visible: false },
  ],
  customized: true,
  updatedAt: '2026-09-03T10:00:00.000Z',
};

describe('preferences-api — request shape', () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
    getMock.mockResolvedValue(FULL);
    patchMock.mockResolvedValue(FULL);
  });

  it('reads from the literal /me/preferences path with no parameters', async () => {
    await fetchPreferences();

    expect(getMock).toHaveBeenCalledTimes(1);
    // No query string and no id segment: there is nothing to point at another user.
    expect(getMock).toHaveBeenCalledWith('/me/preferences');
  });

  it('writes to the same literal path', async () => {
    await savePreferences({ theme: 'DARK' });

    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock.mock.calls[0][0]).toBe('/me/preferences');
  });

  it('sends only the fields it was given', async () => {
    await savePreferences({ density: 'COMPACT' });

    // Exact equality, not `objectContaining`: an extra key would be a 400 from
    // `forbidNonWhitelisted`, and a helpfully-filled one would clobber a concurrent edit.
    expect(patchMock.mock.calls[0][1]).toEqual({ density: 'COMPACT' });
  });

  it('sends resetDashboardLayout on its own, never alongside a layout', async () => {
    await savePreferences({ resetDashboardLayout: true });

    const body = patchMock.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toEqual({ resetDashboardLayout: true });
    // The server refuses both fields in one request, so the pair must never co-occur.
    expect(body).not.toHaveProperty('dashboardLayout');
  });

  it('returns the normalized server response, not the patch it sent', async () => {
    const result = await savePreferences({ theme: 'LIGHT' });

    // The response is authoritative and re-filtered, so the caller must see DARK here
    // even though it asked for LIGHT — that is how a rejected/adjusted value surfaces.
    expect(result.theme).toBe('DARK');
  });
});

describe('normalizePreferences', () => {
  it('returns every default for a null body', () => {
    const result = normalizePreferences(null);

    expect(result).toEqual({
      ...PREFERENCE_DEFAULTS,
      navFavorites: [],
      navRecent: [],
      dashboardLayout: [],
      customized: false,
      updatedAt: null,
    });
  });

  it('preserves a full valid payload unchanged', () => {
    expect(normalizePreferences(FULL)).toEqual(FULL);
  });

  it('falls back to a default for each out-of-range enum independently', () => {
    const result = normalizePreferences({
      theme: 'NEON' as never,
      density: 'ROOMY' as never,
      motion: 'FAST' as never,
      textScale: 200 as never,
      // A valid neighbour must survive a corrupt sibling, so one bad field cannot
      // silently reset the whole appearance.
      sidebarCollapsed: true,
    });

    expect(result.theme).toBe(PREFERENCE_DEFAULTS.theme);
    expect(result.density).toBe(PREFERENCE_DEFAULTS.density);
    expect(result.motion).toBe(PREFERENCE_DEFAULTS.motion);
    expect(result.textScale).toBe(PREFERENCE_DEFAULTS.textScale);
    expect(result.sidebarCollapsed).toBe(true);
  });

  it('accepts every enumerated text-scale step', () => {
    for (const step of TEXT_SCALE_STEPS) {
      expect(normalizePreferences({ textScale: step }).textScale).toBe(step);
    }
  });

  it('drops non-string href entries instead of rendering undefined', () => {
    const result = normalizePreferences({
      navFavorites: ['/admin', 42, null, undefined, { href: '/x' }] as never,
      navRecent: 'not-an-array' as never,
    });

    expect(result.navFavorites).toEqual(['/admin']);
    expect(result.navRecent).toEqual([]);
  });

  it('drops malformed layout entries and defaults a non-boolean visible to visible', () => {
    const result = normalizePreferences({
      dashboardLayout: [
        { id: 'identity', visible: true },
        { id: 'access', visible: 'yes' },
        { id: 42, visible: true },
        null,
        'access',
        { visible: false },
      ] as never,
    });

    // `visible: 'yes'` reads as visible: showing a widget on a corrupt entry is
    // recoverable by the user, silently hiding one is not.
    expect(result.dashboardLayout).toEqual([
      { id: 'identity', visible: true },
      { id: 'access', visible: true },
    ]);
  });

  it('treats a missing customized flag as not customized', () => {
    // `customized: false` must never be inferred from the presence of defaults, and a
    // truthy-but-not-true value must not read as a saved choice.
    expect(normalizePreferences({}).customized).toBe(false);
    expect(normalizePreferences({ customized: 'yes' as never }).customized).toBe(false);
    expect(normalizePreferences({ updatedAt: 42 as never }).updatedAt).toBeNull();
  });
});

describe('client-side bounds mirror the server', () => {
  it('matches the API constants and CHECK constraints', () => {
    expect(MAX_NAV_FAVORITES).toBe(12);
    expect(MAX_NAV_RECENT).toBe(10);
    expect(TEXT_SCALE_STEPS).toEqual([100, 110, 125, 140]);
  });
});
