import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeToggle } from '../ThemeToggle';
import { ThemeProvider, THEME_STORAGE_KEY } from '@/components/providers/ThemeProvider';

/**
 * Phase 49K coverage for the header theme toggle.
 *
 * THE INVARIANT UNDER TEST: a user-initiated toggle writes an explicit `light`/`dark`,
 * lowercase, to both `data-theme` and `localStorage` — never `system`. The Phase 48C
 * browser validation asserts exactly those two values, so a three-state control that
 * cycled through `system` would break it while every unit test still passed.
 *
 * The provider is mounted for real. Mocking `useTheme` would leave the paint path — the
 * part that actually regressed in A2 — untested.
 */

const root = () => document.documentElement;

/** Forces `matchMedia` to report dark, so `system` resolves to something identifiable. */
function systemPrefersDark(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe('ThemeToggle', () => {
  afterEach(() => {
    window.localStorage.clear();
    root().removeAttribute('data-theme');
    root().classList.remove('dark');
    systemPrefersDark(false);
  });

  function renderToggle() {
    return render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
  }

  it('turns an unstored SYSTEM choice into an explicit theme on the first click', async () => {
    systemPrefersDark(false);
    const user = userEvent.setup();
    renderToggle();

    // Nothing stored yet: the choice is `system`, painted light.
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-choice', 'system');

    await user.click(screen.getByTestId('theme-toggle'));

    // A2: the first toggle must produce the opposite of what is ON SCREEN and store it
    // explicitly. Writing `system` here is what previously left the button inert.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(root()).toHaveAttribute('data-theme', 'dark');
    expect(root().classList.contains('dark')).toBe(true);
  });

  it('flips the resolved theme when SYSTEM already resolves to dark', async () => {
    systemPrefersDark(true);
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByTestId('theme-toggle'));

    // The user sees dark, so one click must give light — not `dark` again just because
    // that is the stored-choice default.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(root()).toHaveAttribute('data-theme', 'light');
  });

  it('never stores or paints the string "system" from a click', async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByTestId('theme-toggle'));
    await user.click(screen.getByTestId('theme-toggle'));

    // Both values stay in the lowercase light/dark alphabet the 48C E2E asserts on.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toMatch(/^(light|dark)$/);
    expect(root().getAttribute('data-theme')).toMatch(/^(light|dark)$/);
  });

  it('adopts a stored explicit choice instead of re-reading the OS', async () => {
    systemPrefersDark(true);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');

    renderToggle();

    // An explicit choice outranks the OS: otherwise a user who picked light would be
    // overridden on every reload by a dark-mode desktop.
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-choice', 'light');
    expect(root()).toHaveAttribute('data-theme', 'light');
  });

  it('names the action rather than the current state', async () => {
    const user = userEvent.setup();
    renderToggle();

    // The accessible name must say what the click DOES; a name that reported state
    // would leave a screen-reader user guessing at the outcome.
    expect(screen.getByRole('button', { name: 'فعال کردن حالت شب' })).toBeInTheDocument();

    await user.click(screen.getByTestId('theme-toggle'));

    expect(screen.getByRole('button', { name: 'روشن کردن حالت روز' })).toBeInTheDocument();
  });
});
