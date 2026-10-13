'use client';

import * as React from 'react';
import { useAuth } from './AuthProvider';
import {
  AppearanceAttributes,
  ThemeChoice,
  clearAppearanceOwner,
  readAppearanceOwner,
  subscribeThemeChoice,
  syncAppearance,
  useTheme,
  writeAppearanceOwner,
} from './ThemeProvider';
import {
  MAX_NAV_FAVORITES,
  MAX_NAV_RECENT,
  MotionPreference,
  PreferenceLayoutEntry,
  PreferencePatch,
  TextScaleStep,
  ThemePreference,
  UIDensity,
  UserPreferences,
  fetchPreferences,
  normalizePreferences,
  savePreferences,
} from '@/lib/preferences-api';
import { WidgetLayoutEntry, resolveWidgetLayout } from '@/components/core/core-widgets';

/**
 * Phase 49K: the single client-side source of truth for user preferences.
 *
 * WHY ONE PROVIDER: before this phase, theme lived in `localStorage` and sidebar
 * collapse lived in `CoreShell`'s `useState`, so a preference's lifetime depended on
 * which component happened to own it (N1: collapse reset on every navigation). Every
 * personalization value now has exactly one owner, one persistence path, and one
 * lifetime.
 *
 * SERVER IS AUTHORITATIVE, DOM IS OPTIMISTIC. A user action updates local state and the
 * document immediately, then PATCHes. If the PATCH fails, local state ROLLS BACK to the
 * last server-confirmed snapshot — a control that silently keeps a value the server
 * rejected is worse than one that visibly snaps back, because the next reload would
 * undo it anyway.
 *
 * NEVER A PERMISSION SOURCE. `navFavorites` / `navRecent` / `dashboardLayout` are
 * re-filtered against live RBAC by the server on every read, so anything here may
 * silently shrink between loads. Rendering from this state is not authorization; every
 * target still enforces its own edge.
 *
 * ANONYMOUS IS A REAL STATE, NOT AN ERROR. `/me/preferences` requires a session, so
 * while unauthenticated the provider serves defaults, does not fetch and does not
 * persist. The marketing pages mount this tree too; a 401 on every visit would be noise
 * that hides real failures.
 */

/** Local state kept beyond the server payload. */
interface PreferenceState {
  preferences: UserPreferences;
  /** True until the first read settles — distinguishes "defaults" from "loaded". */
  loading: boolean;
  /** Set when the last read failed. Never set by an anonymous visit. */
  error: string | null;
}

interface PreferenceContextValue extends PreferenceState {
  /** Whether preferences are being persisted server-side at all. */
  persisted: boolean;
  setTheme: (theme: ThemePreference) => void;
  setDensity: (density: UIDensity) => void;
  setTextScale: (scale: TextScaleStep) => void;
  setMotion: (motion: MotionPreference) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  /** Adds or removes a favourite. Refuses silently past `MAX_NAV_FAVORITES`. */
  toggleFavorite: (href: string) => void;
  isFavorite: (href: string) => boolean;
  /** Records a visit. Fire-and-forget: never blocks or surfaces an error. */
  recordVisit: (href: string) => void;
  /** Full ordered widget registry, resolved so it is always renderable. */
  widgetLayout: WidgetLayoutEntry[];
  setWidgetLayout: (layout: PreferenceLayoutEntry[]) => void;
  moveWidget: (id: string, direction: -1 | 1) => void;
  toggleWidget: (id: string) => void;
  resetWidgetLayout: () => void;
}

/** The value served before a fetch and to anonymous visitors. */
const DEFAULT_PREFERENCES: UserPreferences = normalizePreferences(null);

const PreferenceContext = React.createContext<PreferenceContextValue | undefined>(undefined);

/* --------------------------- enum <-> attribute --------------------------- */

const THEME_TO_CHOICE: Record<ThemePreference, ThemeChoice> = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark',
};

const CHOICE_TO_THEME: Record<ThemeChoice, ThemePreference> = {
  system: 'SYSTEM',
  light: 'LIGHT',
  dark: 'DARK',
};

/** Projects the stored enums onto the attribute forms `<html>` actually carries. */
function appearanceOf(preferences: UserPreferences): AppearanceAttributes {
  return {
    density: preferences.density === 'COMPACT' ? 'compact' : 'comfortable',
    textScale: String(preferences.textScale) as AppearanceAttributes['textScale'],
    motion:
      preferences.motion === 'REDUCED'
        ? 'reduced'
        : preferences.motion === 'FULL'
          ? 'full'
          : 'system',
  };
}

const READ_ERROR = 'تنظیمات شخصی‌سازی بارگیری نشد.';
const SAVE_ERROR = 'ذخیره تنظیمات با خطا مواجه شد.';

export function PreferenceProvider({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { syncThemeChoice } = useTheme();

  /*
   * Who owns the pre-paint cache. The opaque token id, never the e-mail.
   *
   * `null` means "nobody" — anonymous. A token without either field cannot be attributed,
   * so the owner check is skipped rather than guessed at: resetting on a guess would wipe
   * a legitimate appearance on every reload.
   */
  const identity = isAuthenticated ? (user?.userId ?? user?.sub ?? null) : null;

  const [state, setState] = React.useState<PreferenceState>({
    preferences: DEFAULT_PREFERENCES,
    loading: true,
    error: null,
  });

  // Read inside callbacks and subscribers without making every one of them depend on
  // the current preferences (which would re-subscribe on each keystroke of a change).
  // The ref is declared in render (never written there — `react-hooks/refs`) and
  // synced by this effect (`react-hooks/set-state-in-effect` does not apply to
  // ref writes in effects, which is exactly where React puts them). Every consumer
  // runs post-effect, so no read can observe a stale value on first paint — and
  // because the rule recognises a DIRECT useRef as stable, none of the callbacks
  // below need this ref in their dependency arrays (the whole point of the design).
  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const persisted = isAuthenticated;
  const persistedRef = React.useRef(persisted);
  React.useEffect(() => {
    persistedRef.current = persisted;
  }, [persisted]);

  /**
   * Pushes a snapshot onto the document.
   *
   * Called only from paths that KNOW the values are real — the settled server read, an
   * optimistic user edit, or a rollback. It is deliberately not an effect on
   * `state.preferences`: on first mount that state still holds the built-in defaults,
   * so an effect would overwrite the pre-paint cache with `SYSTEM`/`100`/`comfortable`
   * before the fetch resolved, visibly resetting the appearance of every reload.
   */
  const applyToDocument = React.useCallback(
    (next: UserPreferences) => {
      syncAppearance(appearanceOf(next));
      // Silent by design: `syncThemeChoice` does not notify, so applying the server's
      // theme cannot be mistaken for a user action and echoed straight back as a PATCH.
      syncThemeChoice(THEME_TO_CHOICE[next.theme]);
    },
    [syncThemeChoice],
  );

  /* ------------------------------- server read ------------------------------- */

  // The two state writes this effect used to make in its body now ride a
  // render-time key adjustment mirroring the effect's own gate: the anonymous
  // branch resets to the defaults (also the sign-out path), and the signed-in
  // branch arms `loading` for the fetch the effect issues. prev starts as
  // `null` so the FIRST settled auth key is detected — including an auth
  // session that is already settled on mount (a test harness, or a future
  // synchronous provider).
  const serverReadKey = `${authLoading ? 1 : 0}|${isAuthenticated ? 1 : 0}|${identity ?? ''}`;
  const [prevServerReadKey, setPrevServerReadKey] = React.useState<string | null>(null);
  if (prevServerReadKey !== serverReadKey) {
    setPrevServerReadKey(serverReadKey);
    if (!authLoading) {
      if (!isAuthenticated) {
        setState({ preferences: DEFAULT_PREFERENCES, loading: false, error: null });
      } else {
        setState((prev) => ({ ...prev, loading: true, error: null }));
      }
    }
  }

  React.useEffect(() => {
    // Wait for the session to settle: fetching mid-hydration would 401 on a user who
    // is in fact signed in and is about to have a token.
    if (authLoading) return;

    if (!isAuthenticated) {
      // The state reset happened during render (adjustment above); what is left
      // here is document work, which an effect is the right place for.

      /*
       * USER ISOLATION. This branch is also the sign-out path, so a cache still owned by
       * the account that just left is wiped here — document and `localStorage` both.
       *
       * This deliberately DOES repaint, unlike the earlier behaviour of leaving the
       * document alone on sign-out: keeping one account's dark/compact/140% on the login
       * screen of a shared machine is the leak this rule exists to close. An appearance
       * the user set while never signed in has no owner, so it is left untouched.
       */
      if (readAppearanceOwner() !== null) {
        clearAppearanceOwner();
        applyToDocument(DEFAULT_PREFERENCES);
      }
      return;
    }

    /*
     * Signed in: claim the cache before the read resolves.
     *
     * A mismatch means the cached appearance belongs to a DIFFERENT account — the previous
     * user closed the browser without signing out, or two accounts share this profile.
     * Painting defaults now is a visible flash for the arriving user, which is the correct
     * trade: the alternative is showing them another person's settings until the request
     * answers, and then only if it answers.
     */
    if (identity && readAppearanceOwner() !== identity) {
      applyToDocument(DEFAULT_PREFERENCES);
      writeAppearanceOwner(identity);
    }

    let cancelled = false;

    void fetchPreferences()
      .then((preferences) => {
        // A response that arrives after logout or after a newer read must not be
        // applied: it would restore the previous user's preferences into this session.
        if (cancelled) return;
        setState({ preferences, loading: false, error: null });
        applyToDocument(preferences);
        // Claimed again on the settled read, so a session that started before this key
        // existed still ends up attributed.
        if (identity) writeAppearanceOwner(identity);
      })
      .catch(() => {
        if (cancelled) return;
        // Keep the defaults and say so. The document is untouched, so a failed read
        // leaves the pre-paint appearance in place rather than snapping to defaults.
        setState({ preferences: DEFAULT_PREFERENCES, loading: false, error: READ_ERROR });
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated, identity, applyToDocument]);

  /* -------------------------------- mutations -------------------------------- */

  /**
   * Optimistic write: apply locally, persist, roll back on failure.
   *
   * `next` is a full local snapshot rather than a merge of the response, because the
   * server returns a RE-FILTERED object — a favourite whose permission was revoked
   * simply will not come back. Replacing local state with the response is therefore the
   * correct resolution, and it is what makes a shrinking list visible instead of leaving
   * a stale entry on screen.
   *
   * ANONYMOUS: local-only. The appearance still changes so the control is not dead, but
   * nothing is sent — `/me/preferences` has no caller to attribute the row to.
   */
  const commit = React.useCallback(
    (next: UserPreferences, patch: PreferencePatch, options?: { silent?: boolean }) => {
      const previous = stateRef.current.preferences;

      setState((prev) => ({ ...prev, preferences: next, error: null }));
      applyToDocument(next);

      if (!persistedRef.current) return;

      void savePreferences(patch)
        .then((confirmed) => {
          setState((prev) => ({ ...prev, preferences: confirmed, error: null }));
          applyToDocument(confirmed);
        })
        .catch(() => {
          // Roll back rather than keep a value the server refused: the next reload would
          // undo it anyway, and a control that lies about what was saved is worse than
          // one that visibly snaps back.
          setState((prev) => ({
            ...prev,
            preferences: previous,
            error: options?.silent ? prev.error : SAVE_ERROR,
          }));
          applyToDocument(previous);
        });
    },
    [applyToDocument],
  );

  const setTheme = React.useCallback(
    (theme: ThemePreference) => {
      commit({ ...stateRef.current.preferences, theme }, { theme });
    },
    [commit],
  );

  /**
   * Persists a theme change made through `ThemeProvider` (the header `ThemeToggle`).
   *
   * The toggle predates this provider and stays the paint-path owner, so instead of
   * rewriting it, the choice it emits is caught here and forwarded. Only USER actions
   * emit — `syncThemeChoice` is silent — so this cannot loop with `applyToDocument`.
   */
  React.useEffect(
    () =>
      subscribeThemeChoice((choice) => {
        const theme = CHOICE_TO_THEME[choice];
        const current = stateRef.current.preferences;
        if (current.theme === theme) return;

        // The document is already correct: ThemeProvider painted it before emitting.
        setState((prev) => ({ ...prev, preferences: { ...prev.preferences, theme } }));
        if (!persistedRef.current) return;

        void savePreferences({ theme })
          .then((confirmed) => {
            setState((prev) => ({ ...prev, preferences: confirmed, error: null }));
          })
          .catch(() => {
            // Deliberately quiet: the user sees the theme they asked for, and a banner
            // over a working screen would be more confusing than the lost persistence.
          });
      }),
    [],
  );

  const setDensity = React.useCallback(
    (density: UIDensity) => {
      commit({ ...stateRef.current.preferences, density }, { density });
    },
    [commit],
  );

  const setTextScale = React.useCallback(
    (textScale: TextScaleStep) => {
      commit({ ...stateRef.current.preferences, textScale }, { textScale });
    },
    [commit],
  );

  const setMotion = React.useCallback(
    (motion: MotionPreference) => {
      commit({ ...stateRef.current.preferences, motion }, { motion });
    },
    [commit],
  );

  const setSidebarCollapsed = React.useCallback(
    (sidebarCollapsed: boolean) => {
      // `silent` — collapsing is a layout gesture, not a form submission. A failure
      // rolls the rail back, which is feedback enough; an error banner would be noise.
      commit(
        { ...stateRef.current.preferences, sidebarCollapsed },
        { sidebarCollapsed },
        { silent: true },
      );
    },
    [commit],
  );

  const toggleSidebar = React.useCallback(() => {
    setSidebarCollapsed(!stateRef.current.preferences.sidebarCollapsed);
  }, [setSidebarCollapsed]);

  /* ---------------------------- nav personalization ---------------------------- */

  const isFavorite = React.useCallback(
    (href: string) => stateRef.current.preferences.navFavorites.includes(href),
    [],
  );

  const toggleFavorite = React.useCallback(
    (href: string) => {
      const current = stateRef.current.preferences;
      const removing = current.navFavorites.includes(href);

      // Past the cap, do nothing rather than send a request the DTO's `ArrayMaxSize`
      // would reject: the star simply does not engage, which is the same outcome without
      // an error banner for a limit the user cannot see.
      if (!removing && current.navFavorites.length >= MAX_NAV_FAVORITES) return;

      const navFavorites = removing
        ? current.navFavorites.filter((entry) => entry !== href)
        : [...current.navFavorites, href];

      commit({ ...current, navFavorites }, { navFavorites });
    },
    [commit],
  );

  /**
   * Records a visit, newest-first.
   *
   * FIRE-AND-FORGET AND NEVER USER-VISIBLE. This fires on navigation, not on a click the
   * user thinks of as "saving" anything, so a failure must stay silent: an error banner
   * on an unrelated page would be inexplicable.
   *
   * The server drops entries the caller may not open (and audit surfaces) instead of
   * refusing the write, so visiting a gated route can neither corrupt history nor make a
   * restricted page detectable through a 400. Local trimming mirrors that; the server's
   * response is still authoritative.
   */
  const recordVisit = React.useCallback((href: string) => {
    const current = stateRef.current.preferences;
    if (current.navRecent[0] === href) return; // Already the newest — nothing to record.

    const navRecent = [href, ...current.navRecent.filter((entry) => entry !== href)].slice(
      0,
      MAX_NAV_RECENT,
    );

    setState((prev) => ({ ...prev, preferences: { ...prev.preferences, navRecent } }));
    if (!persistedRef.current) return;

    void savePreferences({ navRecent })
      .then((confirmed) => {
        setState((prev) => ({ ...prev, preferences: confirmed }));
      })
      .catch(() => {
        // Silent: history is a convenience, and the next visit will try again.
      });
  }, []);

  /* ------------------------------ widget layout ------------------------------ */

  /**
   * The layout to render.
   *
   * Always resolved through `resolveWidgetLayout`, so it is the full ordered registry
   * even before the first response and even if a stored layout predates a widget added in
   * this release.
   *
   * An absent or empty layout resolves to "every widget, visible" — hiding everything is
   * stored as six explicit `visible: false` entries, never as `[]`, so the two cases can
   * never be confused.
   */
  const widgetLayout = React.useMemo(
    () => resolveWidgetLayout(state.preferences.dashboardLayout),
    [state.preferences.dashboardLayout],
  );

  const setWidgetLayout = React.useCallback(
    (layout: PreferenceLayoutEntry[]) => {
      const current = stateRef.current.preferences;
      commit({ ...current, dashboardLayout: layout }, { dashboardLayout: layout });
    },
    [commit],
  );

  const moveWidget = React.useCallback(
    (id: string, direction: -1 | 1) => {
      const layout = resolveWidgetLayout(stateRef.current.preferences.dashboardLayout);
      const from = layout.findIndex((entry) => entry.id === id);
      const to = from + direction;

      // Out of range is a no-op, not a clamp: clamping would report success for a move
      // that visibly did not happen.
      if (from < 0 || to < 0 || to >= layout.length) return;

      const next = [...layout];
      [next[from], next[to]] = [next[to], next[from]];
      setWidgetLayout(next);
    },
    [setWidgetLayout],
  );

  const toggleWidget = React.useCallback(
    (id: string) => {
      const layout = resolveWidgetLayout(stateRef.current.preferences.dashboardLayout);
      if (!layout.some((entry) => entry.id === id)) return;

      setWidgetLayout(
        layout.map((entry) => (entry.id === id ? { ...entry, visible: !entry.visible } : entry)),
      );
    },
    [setWidgetLayout],
  );

  /**
   * Returns to the default layout.
   *
   * Sends `resetDashboardLayout: true`, never `dashboardLayout: null`: only SQL NULL is
   * the "never customised" state the server's `resolveLayout` recognises, and the two
   * fields are mutually exclusive in one request. Locally the field is set to `[]` —
   * which `resolveWidgetLayout` expands back to the full visible registry — so the reset
   * is visible before the response lands.
   */
  const resetWidgetLayout = React.useCallback(() => {
    const current = stateRef.current.preferences;
    commit(
      { ...current, dashboardLayout: [], customized: current.customized },
      { resetDashboardLayout: true },
    );
  }, [commit]);

  const value = React.useMemo<PreferenceContextValue>(
    () => ({
      ...state,
      persisted,
      setTheme,
      setDensity,
      setTextScale,
      setMotion,
      setSidebarCollapsed,
      toggleSidebar,
      toggleFavorite,
      isFavorite,
      recordVisit,
      widgetLayout,
      setWidgetLayout,
      moveWidget,
      toggleWidget,
      resetWidgetLayout,
    }),
    [
      state,
      persisted,
      setTheme,
      setDensity,
      setTextScale,
      setMotion,
      setSidebarCollapsed,
      toggleSidebar,
      toggleFavorite,
      isFavorite,
      recordVisit,
      widgetLayout,
      setWidgetLayout,
      moveWidget,
      toggleWidget,
      resetWidgetLayout,
    ],
  );

  return <PreferenceContext.Provider value={value}>{children}</PreferenceContext.Provider>;
}

/**
 * Preferences for a component inside `PreferenceProvider`.
 *
 * THROWS when used outside the provider, unlike `useTheme`'s inert fallback. A silent
 * fallback here would be a second, unpersisted copy of the state — exactly the N1 bug
 * (collapse in a component's `useState`) this provider exists to remove. Failing at
 * mount makes the wiring mistake obvious instead of shipping a control that appears to
 * work and quietly forgets.
 */
export function usePreferences(): PreferenceContextValue {
  const context = React.useContext(PreferenceContext);
  if (!context) {
    throw new Error('usePreferences must be used inside PreferenceProvider');
  }
  return context;
}

/**
 * Preferences for components that may render outside the provider (marketing pages,
 * isolated unit tests).
 *
 * Returns `null` instead of throwing, so a shared component can degrade to its
 * unpersonalized default rather than crash a tree that has no session anyway.
 */
export function useOptionalPreferences(): PreferenceContextValue | null {
  return React.useContext(PreferenceContext) ?? null;
}



