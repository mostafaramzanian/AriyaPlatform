import type { Config } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';
import plugin from 'tailwindcss/plugin';
import animatePlugin from 'tailwindcss-animate';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      /*
       * Typography — mirror the lovable reference's font stack. The lovable
       * theme sets `--font-sans: "Vazirmatn", ui-sans-serif, system-ui, sans-serif`
       * and applies it on <html>. We keep a single source of truth in
       * `globals.css` (`--font-sans` / `--font-mono`) and resolve both families
       * from those tokens, so `font-sans`, `font-vazirmatn` and `font-mono`
       * all render with the same stacked faces.
       */
      fontFamily: {
        sans: ['var(--font-sans)', ...defaultTheme.fontFamily.sans as string[]],
        vazirmatn: ['var(--font-sans)', ...defaultTheme.fontFamily.sans as string[]],
        mono: ['var(--font-mono)', ...defaultTheme.fontFamily.mono as string[]],
      },
      colors: {
        background: 'oklch(var(--background) / <alpha-value>)',
        foreground: 'oklch(var(--foreground) / <alpha-value>)',
        surface: 'oklch(var(--surface) / <alpha-value>)',
        'surface-muted': 'oklch(var(--surface-muted) / <alpha-value>)',
        card: {
          DEFAULT: 'oklch(var(--card) / <alpha-value>)',
          foreground: 'oklch(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'oklch(var(--popover) / <alpha-value>)',
          foreground: 'oklch(var(--popover-foreground) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'oklch(var(--primary) / <alpha-value>)',
          foreground: 'oklch(var(--primary-foreground) / <alpha-value>)',
          glow: 'oklch(var(--primary-glow) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'oklch(var(--secondary) / <alpha-value>)',
          foreground: 'oklch(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'oklch(var(--muted) / <alpha-value>)',
          foreground: 'oklch(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'oklch(var(--accent) / <alpha-value>)',
          foreground: 'oklch(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'oklch(var(--destructive) / <alpha-value>)',
          foreground: 'oklch(var(--destructive-foreground) / <alpha-value>)',
        },
        /* Border: alpha modifiers are used widely (`border-border/70`, ...), so
           the placeholder stays; in dark mode `--border-alpha` (lovable `1 0 0 / 8%`)
           is resolved via the var() fallback. Input/sidebar-border bake their
           alpha inside the var (lovable `1 0 0 / 10%`, `1 0 0 / 6%`) and are
           never used with modifiers, so they carry no placeholder. */
        border: 'oklch(var(--border) / var(--border-alpha, <alpha-value>))',
        input: 'oklch(var(--input))',
        ring: 'oklch(var(--ring) / <alpha-value>)',
        success: 'oklch(var(--success) / <alpha-value>)',
        warning: 'oklch(var(--warning) / <alpha-value>)',
        info: 'oklch(var(--info) / <alpha-value>)',
        sidebar: {
          DEFAULT: 'oklch(var(--sidebar) / <alpha-value>)',
          foreground: 'oklch(var(--sidebar-foreground) / <alpha-value>)',
          accent: 'oklch(var(--sidebar-accent) / <alpha-value>)',
          border: 'oklch(var(--sidebar-border))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      /*
       * Phase 49K: density-aware spacing aliases.
       *
       * These resolve to CSS variables declared in `src/styles/globals.css` and
       * re-declared under `:root[data-density='compact']`, so `h-core-row` is one
       * class whose value changes with the user's density preference. A component
       * therefore never needs a `data-density` variant of its own — which is what
       * keeps density from turning into a per-component override sprawl.
       */
      height: {
        'core-row': 'var(--core-row-h)',
        /* Nested nav rows. A second token, not `h-9`: if the parent row shrank at
           COMPACT while the child stayed literal, the two would end up identical
           and the sub-tree would stop reading as nested. */
        'core-row-sm': 'var(--core-row-sm-h)',
        'core-header': 'var(--core-header-h)',
      },
      minHeight: {
        'core-row': 'var(--core-row-h)',
      },
      spacing: {
        'core-card': 'var(--core-card-pad)',
        'core-card-lg': 'var(--core-card-pad-lg)',
        'core-gap': 'var(--core-gap)',
      },
      boxShadow: {
        soft: 'var(--shadow-soft)',
        card: 'var(--shadow-card)',
        elevated: 'var(--shadow-elevated)',
        glow: 'var(--shadow-glow)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        /*
         * Shared enter motion for dropdown panels and expandable lists. A soft
         * fade with a small lift and scale, on an ease-out-expo curve, so a
         * list opens smoothly instead of popping in. Reduced-motion users are
         * covered by the global rule in `styles/globals.css`.
         */
        'dropdown-in': {
          '0%': { opacity: '0', transform: 'translateY(-6px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'dropdown-in': 'dropdown-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) both',
      },
    },
  },
  plugins: [
    animatePlugin,
    plugin(function ({ addUtilities }) {
      addUtilities({
        '.scrollbar-hide': {
          '-ms-overflow-style': 'none',
          'scrollbar-width': 'none',
          '&::-webkit-scrollbar': {
            display: 'none',
          },
        },
      });
    }),
  ],
  darkMode: ['class'],
};

export default config;
