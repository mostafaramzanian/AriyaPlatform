'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/providers/ThemeProvider';
import { THEME_LABELS } from '@/lib/preferences-api';

/**
 * Phase 48C: light/dark switch for the Core header.
 * Phase 49K: the stored choice is now three-state, and the change is persisted.
 *
 * STILL A TWO-STATE BUTTON, DELIBERATELY. `choice` can be `system`, but this control
 * does not cycle through it: a single header affordance whose next state is
 * unpredictable ("does one click give me light or my OS setting?") is worse than an
 * unambiguous "switch to the other one". `SYSTEM` is selectable on the appearance
 * settings card, where the three options are visible at once and labelled.
 *
 * `toggleTheme` flips the RESOLVED theme, so the first click out of `system` always
 * produces the opposite of what is on screen, and always writes an explicit
 * `light`/`dark` — never `system`. That is what keeps the painted value and the stored
 * value in agreement, and it is the invariant the 48C browser assertions
 * (`data-theme` + `localStorage.aria-theme` are `'dark'`/`'light'`, lowercase) rest on.
 *
 * PERSISTENCE IS NOT THIS COMPONENT'S JOB. `ThemeProvider` paints and caches, then
 * notifies; `PreferenceProvider` catches that notification and PATCHes. No backend call
 * is made from here, so the toggle keeps working outside a session and outside the
 * provider tree.
 */

/** Choice → label key. Display only; nothing here is ever sent to the API. */
const SYSTEM_LABEL = THEME_LABELS.SYSTEM;

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, choice, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  const action = isDark ? 'روشن کردن حالت روز' : 'فعال کردن حالت شب';

  return (
    <button
      type="button"
      onClick={toggleTheme}
      data-testid="theme-toggle"
      // Exposed so the appearance E2E can distinguish "painted dark" from "chose dark",
      // which is exactly the distinction that made the first toggle sticky before 49K.
      data-theme={theme}
      data-choice={choice}
      aria-label={action}
      // The choice is surfaced in the tooltip rather than the accessible name: the name
      // must describe what the click DOES, while the current state is context.
      title={choice === 'system' ? `${action} (${SYSTEM_LABEL})` : action}
      className={`flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {isDark ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}
