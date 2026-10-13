import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoreAppearanceSettings } from '../CoreAppearanceSettings';
import { PreferenceProvider } from '@/components/providers/PreferenceProvider';
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchPreferences, savePreferences, type UserPreferences } from '@/lib/preferences-api';

/**
 * Phase 49K coverage for the appearance card.
 *
 * Mounted over the REAL `PreferenceProvider` with only the HTTP layer mocked, because
 * every risk worth asserting here lives in the seam between the two: which field the
 * control sends, what the select shows after a rejected write, and whether the control
 * still works with no session. A mocked `usePreferences` would assert that the JSX calls
 * a function, which is not the part that breaks.
 *
 * WHAT IS ACTUALLY AT RISK:
 *
 *  1. THE STORED VALUE MUST BE THE SELECTED ONE. A control that renders defaults while
 *     the document is painted from the server row tells the user their choice was lost.
 *  2. ONE FIELD PER PATCH. An omitted field is left untouched server-side, so a
 *     helpfully-completed body would clobber a concurrent edit from another tab.
 *  3. `textScale` MUST LEAVE AS A NUMBER. `<select>` values are strings and the API
 *     rejects `"140"`, so the parse is load-bearing, not cosmetic.
 *  4. A REJECTED WRITE MUST ROLL THE SELECT BACK, or it displays a value the server
 *     refused until the next reload.
 *  5. THE CARD MUST SURVIVE A FAILED READ AND AN ANONYMOUS VISIT. This is the only
 *     place a user can undo an appearance that makes the app unusable.
 */

jest.mock('@/lib/preferences-api', () => ({
  ...jest.requireActual('@/lib/preferences-api'),
  fetchPreferences: jest.fn(),
  savePreferences: jest.fn(),
}));

// SWC-compiled ES module exports are non-configurable, so the module is mocked.
jest.mock('@/components/providers/AuthProvider', () => ({
  ...jest.requireActual('@/components/providers/AuthProvider'),
  useAuth: jest.fn(),
}));

const fetchMock = fetchPreferences as jest.MockedFunction<typeof fetchPreferences>;
const saveMock = savePreferences as jest.MockedFunction<typeof savePreferences>;
const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;

function authState(overrides: Partial<ReturnType<typeof useAuth>> = {}) {
  return {
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: false,
    login: jest.fn(),
    logout: jest.fn(),
    clearError: jest.fn(),
    ...overrides,
  } as ReturnType<typeof useAuth>;
}

/** A row where every field differs from the built-in default, so nothing passes by luck. */
const SERVER: UserPreferences = {
  theme: 'DARK',
  density: 'COMPACT',
  textScale: 125,
  motion: 'REDUCED',
  sidebarCollapsed: true,
  navFavorites: [],
  navRecent: [],
  dashboardLayout: [],
  customized: true,
  updatedAt: '2026-09-03T10:00:00.000Z',
};

const LABELS = {
  theme: 'پوسته',
  density: 'تراکم نمایش',
  textScale: 'اندازه متن',
  motion: 'انیمیشن',
} as const;

const ANONYMOUS_NOTICE = /برای ذخیره شدن این تنظیمات وارد حساب خود شوید/;
const READ_ERROR = 'تنظیمات شخصی‌سازی بارگیری نشد.';
const SAVE_ERROR = 'ذخیره تنظیمات با خطا مواجه شد.';

function renderCard() {
  return render(
    <ThemeProvider>
      <PreferenceProvider>
        <CoreAppearanceSettings />
      </PreferenceProvider>
    </ThemeProvider>,
  );
}

/** Renders and waits for the first read to settle, i.e. for the controls to be enabled. */
async function ready() {
  const user = userEvent.setup();
  renderCard();
  await waitFor(() => expect(screen.getByLabelText(LABELS.density)).toBeEnabled());
  return user;
}

const root = () => document.documentElement;

describe('CoreAppearanceSettings', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(SERVER);
    saveMock.mockImplementation(async (patch) => ({ ...SERVER, ...patch }) as UserPreferences);
    useAuthMock.mockReturnValue(authState({ isAuthenticated: true }));
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    for (const attribute of ['data-theme', 'data-density', 'data-text-scale', 'data-motion']) {
      root().removeAttribute(attribute);
    }
  });

  describe('reflecting the stored row', () => {
    it('shows the saved value in every control, not the defaults', async () => {
      await ready();

      // Each control must agree with the row the document was painted from; showing a
      // default over a stored value reads as "my choice was lost".
      expect(screen.getByLabelText(LABELS.theme)).toHaveValue('DARK');
      expect(screen.getByLabelText(LABELS.density)).toHaveValue('COMPACT');
      expect(screen.getByLabelText(LABELS.textScale)).toHaveValue('125');
      expect(screen.getByLabelText(LABELS.motion)).toHaveValue('REDUCED');
    });

    it('offers SYSTEM for theme and motion but never as a painted theme', async () => {
      await ready();

      // `SYSTEM` is only selectable here — the header toggle always writes an explicit
      // light/dark, which is what the 48C browser assertions depend on.
      expect(
        Array.from(screen.getByLabelText(LABELS.theme).querySelectorAll('option')).map(
          (option) => option.value,
        ),
      ).toEqual(['SYSTEM', 'LIGHT', 'DARK']);
      expect(
        Array.from(screen.getByLabelText(LABELS.motion).querySelectorAll('option')).map(
          (option) => option.value,
        ),
      ).toEqual(['SYSTEM', 'REDUCED', 'FULL']);
    });

    it('offers exactly the four enumerated text-scale steps', async () => {
      await ready();

      // A fifth value has no stylesheet rule and is refused by the API CHECK, so the
      // option list IS the contract.
      expect(
        Array.from(screen.getByLabelText(LABELS.textScale).querySelectorAll('option')).map(
          (option) => option.value,
        ),
      ).toEqual(['100', '110', '125', '140']);
    });

    it('disables the controls until the first read settles', async () => {
      let release!: (value: UserPreferences) => void;
      fetchMock.mockReturnValue(
        new Promise<UserPreferences>((resolve) => {
          release = resolve;
        }),
      );

      renderCard();

      // Acting in this window would send a value the user never actually saw, because
      // the state still holds defaults while <html> is painted from the cache.
      expect(screen.getByLabelText(LABELS.density)).toBeDisabled();

      await act(async () => {
        release(SERVER);
      });

      expect(screen.getByLabelText(LABELS.density)).toBeEnabled();
    });
  });

  describe('writing a change', () => {
    it('sends only the field that changed', async () => {
      const user = await ready();

      await user.selectOptions(screen.getByLabelText(LABELS.density), 'COMFORTABLE');

      // One field per PATCH: an omitted field is left untouched server-side, so a
      // completed body would overwrite a concurrent edit from another tab.
      await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
      expect(saveMock).toHaveBeenCalledWith({ density: 'COMFORTABLE' });
    });

    it('sends textScale as a number, never the select string', async () => {
      const user = await ready();

      await user.selectOptions(screen.getByLabelText(LABELS.textScale), '140');

      // `<select>` values are strings; the API CHECK rejects `"140"`. This parse is the
      // whole reason the control does not hand `event.target.value` straight through.
      await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
      expect(saveMock).toHaveBeenCalledWith({ textScale: 140 });
      expect(typeof saveMock.mock.calls[0][0].textScale).toBe('number');
    });

    it('paints the change onto <html> before the request settles', async () => {
      const user = await ready();
      // Never resolved: proves the attribute is optimistic, not a post-response effect.
      saveMock.mockReturnValue(new Promise<UserPreferences>(() => undefined));

      await user.selectOptions(screen.getByLabelText(LABELS.textScale), '110');

      // Waiting for the round-trip would leave the control visibly lagging the click.
      expect(root()).toHaveAttribute('data-text-scale', '110');
      expect(screen.getByLabelText(LABELS.textScale)).toHaveValue('110');
    });

    it('sends the theme enum, not the lowercase document value', async () => {
      const user = await ready();

      await user.selectOptions(screen.getByLabelText(LABELS.theme), 'SYSTEM');

      // The API takes `SYSTEM|LIGHT|DARK`; `data-theme` carries lowercase `light|dark`.
      // Sending the painted form would 400, and `system` is not a paintable value.
      await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ theme: 'SYSTEM' }));
      expect(root().getAttribute('data-theme')).toMatch(/^(light|dark)$/);
    });

    it('sends the motion enum for a forced FULL choice', async () => {
      const user = await ready();

      await user.selectOptions(screen.getByLabelText(LABELS.motion), 'FULL');

      // FULL is an override of the OS switch, so it must be stored explicitly rather
      // than collapsed into "no preference".
      await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ motion: 'FULL' }));
      expect(root()).toHaveAttribute('data-motion', 'full');
    });
  });

  describe('a rejected write', () => {
    /**
     * A PATCH the test settles by hand.
     *
     * `userEvent.selectOptions` flushes microtasks, so an already-rejected mock rolls
     * back before control returns — the optimistic phase would be unobservable and the
     * assertion would silently test the post-rollback state instead.
     */
    function gate() {
      let fail!: (reason: unknown) => void;
      saveMock.mockReturnValue(
        new Promise<UserPreferences>((_resolve, reject) => {
          fail = reject;
        }),
      );
      return { fail };
    }

    it('rolls the select and the document back, and says so', async () => {
      const user = await ready();
      const patch = gate();

      await user.selectOptions(screen.getByLabelText(LABELS.density), 'COMFORTABLE');
      expect(screen.getByLabelText(LABELS.density)).toHaveValue('COMFORTABLE');

      await act(async () => {
        patch.fail(new Error('boom'));
      });

      // A select still showing the refused value lies until the next reload, so it must
      // return to the last server-confirmed state — and the failure must be stated.
      expect(screen.getByLabelText(LABELS.density)).toHaveValue('COMPACT');
      expect(root()).toHaveAttribute('data-density', 'compact');
      expect(screen.getByRole('alert')).toHaveTextContent(SAVE_ERROR);
    });

    it('restores the text scale rather than leaving an unsaved size', async () => {
      const user = await ready();
      const patch = gate();

      await user.selectOptions(screen.getByLabelText(LABELS.textScale), '140');
      expect(root()).toHaveAttribute('data-text-scale', '140');

      await act(async () => {
        patch.fail(new Error('boom'));
      });

      // Text scale reflows the whole page, so a value that was not saved must not
      // survive: the next reload would undo it anyway.
      expect(screen.getByLabelText(LABELS.textScale)).toHaveValue('125');
      expect(root()).toHaveAttribute('data-text-scale', '125');
    });

    it('adopts the server response over the optimistic value', async () => {
      const user = await ready();
      // The server clamped the request — e.g. a policy the client does not model.
      saveMock.mockResolvedValue({ ...SERVER, density: 'COMPACT' });

      await user.selectOptions(screen.getByLabelText(LABELS.density), 'COMFORTABLE');

      // The response is authoritative, so the control must end up on what was STORED,
      // not on what was asked for.
      await waitFor(() => expect(screen.getByLabelText(LABELS.density)).toHaveValue('COMPACT'));
    });
  });

  describe('degraded states', () => {
    it('stays usable when the read fails, and reports it', async () => {
      // Pre-paint cache state, as ThemeScript would have left it.
      root().setAttribute('data-text-scale', '140');
      fetchMock.mockRejectedValue(new Error('boom'));

      const user = userEvent.setup();
      renderCard();

      await waitFor(() => expect(screen.getByText(READ_ERROR)).toBeInTheDocument());

      // This card is the only way to undo an appearance that makes the app unusable, so
      // a broken read must not hide the controls — and must not repaint the document.
      expect(root()).toHaveAttribute('data-text-scale', '140');
      expect(screen.getByLabelText(LABELS.density)).toBeEnabled();

      await user.selectOptions(screen.getByLabelText(LABELS.density), 'COMPACT');
      await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ density: 'COMPACT' }));
    });

    it('works anonymously, sends nothing, and says the change is local', async () => {
      useAuthMock.mockReturnValue(authState({ isAuthenticated: false }));
      const user = userEvent.setup();
      renderCard();

      await waitFor(() => expect(screen.getByLabelText(LABELS.density)).toBeEnabled());

      // Anonymous is a real state, not an error: `/me/preferences` has no caller to
      // attribute a row to, so the honest thing is a working control plus a notice.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByText(ANONYMOUS_NOTICE)).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText(LABELS.density), 'COMPACT');

      expect(screen.getByLabelText(LABELS.density)).toHaveValue('COMPACT');
      expect(root()).toHaveAttribute('data-density', 'compact');
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('does not show the sign-in notice to a signed-in user', async () => {
      await ready();

      // The notice is about persistence, not about defaults: showing it to a user whose
      // row exists would tell them their saved settings are not being saved.
      expect(screen.queryByText(ANONYMOUS_NOTICE)).not.toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('names every control and describes what it does', async () => {
      await ready();

      // Four labelled controls under one group: without the label association the
      // options are four unnamed lists of Persian words with no stated effect.
      for (const label of Object.values(LABELS)) {
        const control = screen.getByLabelText(label);
        expect(control.tagName).toBe('SELECT');
        expect(control).toHaveAccessibleDescription();
      }
    });

    it('groups the controls under a named fieldset', async () => {
      await ready();

      // `<fieldset disabled>` is what makes the loading gate cover every descendant
      // natively, and its `<legend>` is what names the group for a screen reader.
      expect(screen.getByRole('group', { name: 'تنظیمات ظاهر' })).toBeInTheDocument();
    });
  });

/*
 * The navigation block. It manages the SAME preference the sidebar star writes, and it is
 * the only place a favourite can be removed without hunting for its row in the rail.
 */
describe('CoreAppearanceSettings navigation favourites', () => {
  beforeEach(() => {
    saveMock.mockImplementation(async (patch) => ({ ...SERVER, ...patch }) as UserPreferences);
    useAuthMock.mockReturnValue(authState({ isAuthenticated: true }));
  });

  afterEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
  });

  it('lists the saved favourites under their catalogue labels', async () => {
    fetchMock.mockResolvedValue({
      ...SERVER,
      navFavorites: ['/admin/calendar', '/admin/notifications'],
    });

    await ready();

    const entries = await screen.findAllByTestId('favorite-entry');
    // The label is the nav catalogue's own, so settings and the rail cannot disagree about
    // what a favourite is called.
    expect(entries.map((node) => node.textContent?.trim())).toEqual(['تقویم', 'اعلان‌ها']);
    expect(screen.queryByTestId('favorites-empty')).toBeNull();
  });

  it('says so when there are none, instead of rendering an empty box', async () => {
    await ready();

    expect(await screen.findByTestId('favorites-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('favorites-list')).toBeNull();
  });

  it('removes one and persists only that field', async () => {
    fetchMock.mockResolvedValue({
      ...SERVER,
      navFavorites: ['/admin/calendar', '/admin/notifications'],
    });

    const user = await ready();
    await screen.findAllByTestId('favorite-entry');

    await user.click(
      screen.getByRole('button', { name: 'حذف «تقویم» از پیوندهای دلخواه' }),
    );

    // Only `navFavorites`, and only without the removed entry: a helpfully-completed body
    // would clobber a concurrent change from another tab.
    expect(saveMock).toHaveBeenCalledWith({ navFavorites: ['/admin/notifications'] });
    await waitFor(() => expect(screen.getAllByTestId('favorite-entry')).toHaveLength(1));
  });
});

});
