'use client';

import { Alert } from '@/components/ui/alert';
import { X } from 'lucide-react';
import { usePreferences } from '@/components/providers/PreferenceProvider';
import { pageTitleFor } from './core-nav';
import {
  DENSITY_LABELS,
  MAX_NAV_FAVORITES,
  MOTION_LABELS,
  TEXT_SCALE_LABELS,
  TEXT_SCALE_STEPS,
  THEME_LABELS,
  type MotionPreference,
  type TextScaleStep,
  type ThemePreference,
  type UIDensity,
} from '@/lib/preferences-api';

/**
 * Phase 49K: the appearance controls — theme, density, text scale, motion — plus the
 * navigation favourites the sidebar star writes.
 *
 * WHY NATIVE `<select>` AND NOT A RADIOGROUP: every enumerated choice already in this
 * codebase is a native `<select>` with a `<label htmlFor>` (`CoreSupportView`, the
 * shared `ui/select`), and there is no `role="radiogroup"` anywhere. A hand-rolled
 * radiogroup would mean writing arrow-key handling, `aria-checked` bookkeeping and
 * focus management by hand — for keyboard and screen-reader behaviour the browser
 * already provides correctly, in a Persian RTL context where the native control is
 * also the one the user's assistive technology is configured for.
 *
 * WHY EVERY VALUE COMES FROM `preferences` AND NOT FROM `useTheme()`: the theme has two
 * plausible sources — the persisted row and the painted `ThemeProvider` choice. Reading
 * one field from a different place than the other three is how they drift. The provider
 * converges them (`applyToDocument` pushes the server theme onto the document through
 * the SILENT `syncThemeChoice`), so the row is the honest source for all four.
 *
 * WHY THE FIELDSET IS DISABLED WHILE LOADING: before the first read settles the state
 * still holds built-in defaults, while `<html>` may already be painted from the
 * pre-paint cache. Acting on a control in that window would send a value the user never
 * saw. `<fieldset disabled>` covers every descendant natively, so this needs no
 * per-control prop.
 *
 * NOT A SETTINGS PAGE OF ITS OWN, AND NOT INSIDE `CoreProfileView`: it renders beside
 * that view on `/admin/profile`. Embedding it would have coupled the profile's own
 * fetch/error lifecycle to the preference provider, and would have forced
 * `CoreProfileView`'s existing tests — which mount it with no provider — to grow a
 * provider they do not otherwise need.
 */

/** Explicit order, so the option list never depends on object key iteration. */
const THEME_ORDER: readonly ThemePreference[] = ['SYSTEM', 'LIGHT', 'DARK'];
const DENSITY_ORDER: readonly UIDensity[] = ['COMFORTABLE', 'COMPACT'];
const MOTION_ORDER: readonly MotionPreference[] = ['SYSTEM', 'REDUCED', 'FULL'];

/**
 * `UserPreferences.textScale` is typed `number` because it is a numeric column, but only
 * the four enumerated steps have a stylesheet rule and a label. An off-step value would
 * otherwise select NO option, leaving a control that shows the wrong thing and cannot be
 * used to correct it — so it falls back to the visible default instead.
 */
function resolveTextScale(value: number): TextScaleStep {
  return TEXT_SCALE_STEPS.find((step) => step === value) ?? 100;
}

const SELECT_CLASS =
  'w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

interface SettingSelectProps<T extends string | number> {
  id: string;
  label: string;
  hint: string;
  value: T;
  options: readonly T[];
  labelFor: (option: T) => string;
  onSelect: (raw: string) => void;
}

/**
 * One labelled control. `onSelect` receives the RAW string value: the caller owns the
 * narrowing back to its own union, so a stray value can never be cast blindly into a
 * PATCH the server would reject.
 */
function SettingSelect<T extends string | number>({
  id,
  label,
  hint,
  value,
  options,
  labelFor,
  onSelect,
}: SettingSelectProps<T>) {
  const hintId = `${id}-hint`;

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-foreground">
        {label}
      </label>
      <select
        id={id}
        data-testid={id}
        value={String(value)}
        aria-describedby={hintId}
        onChange={(event) => onSelect(event.target.value)}
        className={SELECT_CLASS}
      >
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {labelFor(option)}
          </option>
        ))}
      </select>
      <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

export function CoreAppearanceSettings() {
  const {
    preferences,
    loading,
    error,
    persisted,
    setTheme,
    setDensity,
    setTextScale,
    setMotion,
    toggleFavorite,
  } = usePreferences();

  return (
    <section className="core-card p-core-card md:p-core-card-lg" aria-labelledby="appearance-heading">
      <h2 id="appearance-heading" className="text-base font-semibold text-foreground">
        ظاهر و دسترس‌پذیری
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        این تنظیمات به حساب شما وابسته است و در همه دستگاه‌ها اعمال می‌شود.
      </p>

      {/*
        A failed READ is reported but not blocking: the pre-paint appearance is still on
        screen and the controls still work, so hiding them would remove the only way to
        fix an appearance the user dislikes.
      */}
      {error ? <Alert type="warning" message={error} className="mt-4" /> : null}

      {/*
        Anonymous is a real state, not an error (the provider serves defaults and sends
        nothing). Saying so is honest; pretending the change was saved is not.
      */}
      {!persisted && !loading ? (
        <Alert
          type="info"
          message="برای ذخیره شدن این تنظیمات وارد حساب خود شوید. تغییرات فعلاً فقط در این مرورگر اعمال می‌شود."
          className="mt-4"
        />
      ) : null}

      <fieldset
        disabled={loading}
        data-testid="appearance-fieldset"
        className="mt-5 grid gap-core-gap border-0 p-0 md:grid-cols-2"
      >
        <legend className="sr-only">تنظیمات ظاهر</legend>

        <SettingSelect
          id="appearance-theme"
          label="پوسته"
          hint="«هماهنگ با سیستم» از تنظیم روشن/تیره دستگاه پیروی می‌کند و با تغییر آن به‌روز می‌شود."
          value={preferences.theme}
          options={THEME_ORDER}
          labelFor={(option) => THEME_LABELS[option]}
          onSelect={(raw) => {
            const next = THEME_ORDER.find((option) => option === raw);
            if (next) setTheme(next);
          }}
        />

        <SettingSelect
          id="appearance-density"
          label="تراکم نمایش"
          hint="حالت فشرده ارتفاع ردیف‌ها و فاصله‌ها را کم می‌کند تا اطلاعات بیشتری در یک صفحه جا شود."
          value={preferences.density}
          options={DENSITY_ORDER}
          labelFor={(option) => DENSITY_LABELS[option]}
          onSelect={(raw) => {
            const next = DENSITY_ORDER.find((option) => option === raw);
            if (next) setDensity(next);
          }}
        />

        <SettingSelect
          id="appearance-text-scale"
          label="اندازه متن"
          hint="اندازه پایه متن را نسبت به تنظیم مرورگر شما بزرگ می‌کند؛ تنظیم خود مرورگر بازنویسی نمی‌شود."
          value={resolveTextScale(preferences.textScale)}
          options={TEXT_SCALE_STEPS}
          labelFor={(option) => `${TEXT_SCALE_LABELS[option]} (${option}٪)`}
          onSelect={(raw) => {
            // Parsed, then matched against the enumerated steps — never rounded. The
            // server refuses an off-step value, so offering only these four is the
            // contract, not a convenience.
            const parsed = Number(raw);
            const next = TEXT_SCALE_STEPS.find((option) => option === parsed);
            if (next) setTextScale(next);
          }}
        />

        <SettingSelect
          id="appearance-motion"
          label="انیمیشن"
          hint="«کاهش انیمیشن» حتی اگر دستگاه چنین تنظیمی نداشته باشد اعمال می‌شود، و «انیمیشن کامل» تنظیم سراسری دستگاه را برای این پلتفرم لغو می‌کند."
          value={preferences.motion}
          options={MOTION_ORDER}
          labelFor={(option) => MOTION_LABELS[option]}
          onSelect={(raw) => {
            const next = MOTION_ORDER.find((option) => option === raw);
            if (next) setMotion(next);
          }}
        />
      </fieldset>

      {/*
        NAVIGATION. The same preference the sidebar star writes, shown here because the
        star is the ONLY place it could be managed from until now — and a favourite whose
        row scrolled out of the rail, or that was added by mistake, had no other exit.
        There is no "add" control on purpose: adding needs a nav target to point at, which
        is what the rail already provides. A free-text field here would be a way to store
        an arbitrary URL, which the server refuses anyway.

        The list is already permission-filtered: the server re-filters `navFavorites`
        against live RBAC on every read, so a revoked target never reaches this render.
      */}
      <div className="mt-6 border-t border-border pt-5">
        <h3 id="navigation-favorites-heading" className="text-sm font-semibold text-foreground">
          پیوندهای دلخواه ناوبری
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {`با ستاره کنار هر ردیف در نوار کناری می‌توانید حداکثر ${MAX_NAV_FAVORITES} پیوند را بالای منو سنجاق کنید (${preferences.navFavorites.length} از ${MAX_NAV_FAVORITES}).`}
        </p>

        {preferences.navFavorites.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="favorites-empty">
            هنوز پیوند دلخواهی انتخاب نکرده‌اید.
          </p>
        ) : (
          <ul
            className="mt-3 space-y-1.5"
            aria-labelledby="navigation-favorites-heading"
            data-testid="favorites-list"
          >
            {preferences.navFavorites.map((href) => (
              <li
                key={href}
                data-testid="favorite-entry"
                className="flex min-h-core-row items-center justify-between gap-3 rounded-xl border border-border px-3"
              >
                {/*
                  `pageTitleFor` is the nav catalogue's own label lookup, so the name here is
                  the name in the rail. Its generic fallback is unreachable in practice: the
                  server only stores hrefs that exist in `NAV_TARGETS`, so every entry that
                  reaches this list has a catalogue label.
                */}
                <span className="min-w-0 truncate text-sm text-foreground">
                  {pageTitleFor(href)}
                </span>
                <button
                  type="button"
                  data-testid="favorite-remove"
                  aria-label={`حذف «${pageTitleFor(href)}» از پیوندهای دلخواه`}
                  onClick={() => toggleFavorite(href)}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
