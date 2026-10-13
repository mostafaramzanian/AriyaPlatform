'use client';

import * as React from 'react';

/**
 * Phase 48C: light/dark theme for the Core UI.
 * Phase 49K: `system` becomes a real third state, and the pre-paint script also
 * applies the density / text-scale / motion attributes.
 *
 * OWNERSHIP: this file owns every appearance attribute on <html> and the
 * `localStorage` cache behind it. `PreferenceProvider` owns the SERVER copy and
 * pushes values down through `syncThemeChoice` / `syncAppearance`. Two writers to
 * the same attribute would race on load, so there is exactly one.
 *
 * `localStorage` is a PRE-PAINT CACHE, not the source of truth. The server row is
 * authoritative once it arrives; the cache exists only so a reload paints the
 * right theme before any request completes. A cleared cache is therefore a
 * one-frame cosmetic issue, not a lost preference.
 *
 * THREE-STATE THEME: `choice` is what the user picked (`system` included);
 * `theme` is what was painted (`light`/`dark`, never `system`). Consumers that
 * render an icon want the resolved value, consumers that render a settings
 * control want the choice, and collapsing them is what previously made the first
 * toggle permanently sticky (A2).
 */

/** A paintable theme. Never `system` — `system` is a choice, not an appearance. */
export type Theme = 'light' | 'dark';

/** What the user actually chose, which may defer to the OS. */
export type ThemeChoice = 'system' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'aria-theme';

/**
 * Pre-paint cache keys for the three non-theme appearance settings.
 *
 * Values are stored in their ATTRIBUTE form (lowercase, `100`/`110`/`125`/`140`)
 * rather than the API's enum form, so the inline script can assign them directly
 * without a mapping table it would have to keep in sync.
 */
export const DENSITY_STORAGE_KEY = 'aria-density';
export const TEXT_SCALE_STORAGE_KEY = 'aria-text-scale';
export const MOTION_STORAGE_KEY = 'aria-motion';

/**
 * Phase 49K (user isolation): which account the four cache entries above belong to.
 *
 * The cache exists so the pre-paint script can restore an appearance before the
 * preferences request answers. That makes it a SHARED browser slot, and without an owner
 * the next account to sign in on the same browser paints the previous account's theme,
 * density and text scale until its own read lands — and an account that never signs in
 * keeps looking at them indefinitely.
 *
 * The value is the opaque user id from the token (never the e-mail: this is a plain
 * `localStorage` entry, and it does not need to carry PII to answer "same user?").
 */
export const APPEARANCE_OWNER_STORAGE_KEY = 'aria-pref-owner';

export function readAppearanceOwner(): string | null {
  try {
    return window.localStorage.getItem(APPEARANCE_OWNER_STORAGE_KEY);
  } catch {
    // Storage disabled: treat it as "nobody owns this", which is the safe answer —
    // there is no cache to leak either.
    return null;
  }
}

export function writeAppearanceOwner(owner: string): void {
  writeCache(APPEARANCE_OWNER_STORAGE_KEY, owner);
}

export function clearAppearanceOwner(): void {
  try {
    window.localStorage.removeItem(APPEARANCE_OWNER_STORAGE_KEY);
  } catch {
    // Best-effort, exactly like the writes.
  }
}

/** Attribute-form appearance values, as written to <html>. */
export interface AppearanceAttributes {
  density: 'comfortable' | 'compact';
  textScale: '100' | '110' | '125' | '140';
  motion: 'system' | 'reduced' | 'full';
}

interface ThemeContextValue {
  /** Resolved and painted. Use this for icons and conditional visuals. */
  theme: Theme;
  /** The stored choice, including `system`. Use this for settings controls. */
  choice: ThemeChoice;
  /** Sets an explicit theme (never `system`). Persists and notifies. */
  setTheme: (theme: Theme) => void;
  /** Sets any choice, `system` included. Persists and notifies. */
  setThemeChoice: (choice: ThemeChoice) => void;
  /** Flips the RESOLVED theme, which turns `system` into an explicit choice. */
  toggleTheme: () => void;
  /**
   * Applies a choice WITHOUT notifying subscribers.
   *
   * This is how the server value lands: notifying would make
   * `PreferenceProvider` PATCH back the value it just read, so a load would look
   * like a user edit and overwrite a concurrent change from another tab.
   */
  syncThemeChoice: (choice: ThemeChoice) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

const DARK_QUERY = '(prefers-color-scheme: dark)';


/**
 * Notification channel for USER-INITIATED theme choices only.
 *
 * `PreferenceProvider` subscribes here to persist a change to the server. A
 * server-driven update calls `syncThemeChoice`, which deliberately does NOT emit,
 * so reading a preference can never be mistaken for setting one and echoed back
 * as a PATCH.
 */
type ChoiceListener = (choice: ThemeChoice) => void;

const choiceListeners = new Set<ChoiceListener>();

export function subscribeThemeChoice(listener: ChoiceListener): () => void {
  choiceListeners.add(listener);
  return () => {
    choiceListeners.delete(listener);
  };
}

function emitChoice(choice: ThemeChoice) {
  choiceListeners.forEach((listener) => {
    try {
      listener(choice);
    } catch {
      // One failing subscriber must not prevent the rest from being told.
    }
  });
}

function systemTheme(): Theme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    // No matchMedia (old browser, some test environments): light is the safe default.
    return 'light';
  }
}

function resolveChoice(choice: ThemeChoice): Theme {
  return choice === 'system' ? systemTheme() : choice;
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

function writeCache(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Persistence is best-effort; the in-memory value still applies.
  }
}

function readStoredChoice(): ThemeChoice | null {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : null;
  } catch {
    // Private mode / disabled storage: fall back to the system preference.
    return null;
  }
}

/**
 * Writes the three non-theme appearance attributes and refreshes their pre-paint
 * cache. Called by `PreferenceProvider` for both the server read and user edits —
 * the PATCH is that provider's job, so nothing is emitted here.
 *
 * Safe to call during SSR: it becomes a no-op instead of throwing.
 */
export function syncAppearance(next: AppearanceAttributes): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.setAttribute('data-density', next.density);
  root.setAttribute('data-text-scale', next.textScale);
  root.setAttribute('data-motion', next.motion);

  writeCache(DENSITY_STORAGE_KEY, next.density);
  writeCache(TEXT_SCALE_STORAGE_KEY, next.textScale);
  writeCache(MOTION_STORAGE_KEY, next.motion);
}

/**
 * Shared theme state. `active` is false for the standalone fallback used by
 * consumers rendered outside the provider, so only one controller ever syncs the
 * document on mount.
 */
function useThemeController(active: boolean): ThemeContextValue {
  // Server render and first client render must agree; the real value is read
  // from the document (already set by ThemeScript) as soon as the controller
  // activates — during render, guarded by a one-shot flag
  // (`react-hooks/set-state-in-effect` bars the effect-body mirror this used
  // to be). Both readers below are try/catch-guarded and SSR-safe, and on the
  // server their answers equal the initial states, so nothing diverges.
  const [theme, setThemeState] = React.useState<Theme>('light');
  const [choice, setChoiceState] = React.useState<ThemeChoice>('system');
  const [hasSyncedInitialChoice, setHasSyncedInitialChoice] = React.useState(false);
  if (active && !hasSyncedInitialChoice) {
    setHasSyncedInitialChoice(true);
    // The document already carries the resolved theme from ThemeScript, so an
    // unstored choice reads back as `system` rather than as whatever was painted.
    const stored = readStoredChoice() ?? 'system';
    setChoiceState(stored);
    setThemeState(stored === 'system' ? systemTheme() : stored);
  }

  React.useEffect(() => {
    if (!active) return;

    // The DOM half of the initial sync (the state half rides the render
    // adjustment above): re-apply the stored/resolved theme so class, data
    // attribute and color-scheme are owned by this controller.
    const stored = readStoredChoice() ?? 'system';
    applyTheme(stored === 'system' ? systemTheme() : stored);
  }, [active]);

  /**
   * Follows later OS changes, but only while the choice is `system` — this is the
   * half of A2 that a one-shot paint-time fallback could never provide.
   */
  React.useEffect(() => {
    if (!active || choice !== 'system') return;

    let query: MediaQueryList;
    try {
      query = window.matchMedia(DARK_QUERY);
    } catch {
      return;
    }

    const onChange = () => {
      const resolved = systemTheme();
      setThemeState(resolved);
      applyTheme(resolved);
    };

    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [active, choice]);

  /** Applies + caches a choice. Shared by the notifying and silent paths. */
  const applyChoice = React.useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    const resolved = resolveChoice(next);
    setThemeState(resolved);
    applyTheme(resolved);
    writeCache(THEME_STORAGE_KEY, next);
  }, []);

  const setThemeChoice = React.useCallback(
    (next: ThemeChoice) => {
      applyChoice(next);
      emitChoice(next);
    },
    [applyChoice],
  );

  const setTheme = React.useCallback(
    (next: Theme) => {
      setThemeChoice(next);
    },
    [setThemeChoice],
  );

  const toggleTheme = React.useCallback(() => {
    // Flips the RESOLVED theme, so the first toggle out of `system` goes to the
    // opposite of what the user is currently looking at rather than to a value
    // that would leave the screen unchanged.
    setThemeChoice(theme === 'dark' ? 'light' : 'dark');
  }, [setThemeChoice, theme]);

  const syncThemeChoice = React.useCallback(
    (next: ThemeChoice) => {
      applyChoice(next);
    },
    [applyChoice],
  );

  // Keeps a standalone fallback controller in step with the provider, so a
  // ThemeToggle mounted outside the tree does not display a stale icon.
  React.useEffect(() => subscribeThemeChoice(applyChoice), [applyChoice]);

  return React.useMemo(
    () => ({ theme, choice, setTheme, setThemeChoice, toggleTheme, syncThemeChoice }),
    [theme, choice, setTheme, setThemeChoice, toggleTheme, syncThemeChoice],
  );
}


export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext);
  // Presentational consumers (ThemeToggle) must stay renderable outside the
  // provider — e.g. shell unit tests that mount only a subtree. The fallback is
  // inert whenever a provider is present.
  const standalone = useThemeController(context === undefined);
  return context ?? standalone;
}

/**
 * Inline pre-paint script. Rendered in <head> so every appearance attribute
 * exists before the first paint. Kept in sync with `readStoredChoice` and
 * `syncAppearance` above.
 *
 * WHY INLINE AND SYNCHRONOUS: a text scale or density applied after paint is a
 * visible reflow of the whole page, which is worse than the theme flash this
 * script originally existed to prevent. It must run before the browser paints, so
 * it cannot be an effect and cannot wait for the preferences request.
 *
 * Each value is read INDEPENDENTLY and defaults on its own, so a corrupt density
 * entry cannot suppress a stored text scale. A stored `system` theme falls through
 * to `matchMedia` — the same branch as no stored value at all, which is exactly
 * what `system` means.
 */
export function ThemeScript() {
  const script = `(function(){try{var r=document.documentElement;var s=localStorage.getItem('${THEME_STORAGE_KEY}');var t=(s==='dark'||s==='light')?s:(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');if(t==='dark'){r.classList.add('dark')}r.setAttribute('data-theme',t);r.style.colorScheme=t;var d=localStorage.getItem('${DENSITY_STORAGE_KEY}');r.setAttribute('data-density',d==='compact'?'compact':'comfortable');var x=localStorage.getItem('${TEXT_SCALE_STORAGE_KEY}');r.setAttribute('data-text-scale',(x==='110'||x==='125'||x==='140')?x:'100');var m=localStorage.getItem('${MOTION_STORAGE_KEY}');r.setAttribute('data-motion',(m==='reduced'||m==='full')?m:'system')}catch(e){}})();`;

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const value = useThemeController(true);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
