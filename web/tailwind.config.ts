import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        claw: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          950: '#1e1b4b',
        },
        surface: 'var(--color-surface)',
        'surface-elevated': 'var(--color-surface-elevated)',
        'surface-hover': 'var(--color-surface-hover)',
        // The two row-state grounds (index.css). Separate keys rather than an
        // alpha of `surface`, because the ladder runs DOWN from the panel in
        // light mode and UP from it in dark, and one alpha cannot be both.
        'row-hover': 'var(--color-row-hover)',
        'row-active': 'var(--color-row-active)',
        // The left-edge marker on a filled row, brand-tracked but tuned per
        // theme so it reads against `row-active` in both (index.css).
        'accent-bar': 'var(--color-accent-bar)',
        // The picker menus' KEYBOARD-FOCUS marker. A separate key from
        // `accent-bar` on purpose: that one is brand indigo and means "the
        // conversation you are in", this one tracks the text ramp and means
        // "where the arrow keys are". Same hue for both was one colour
        // carrying two meanings (index.css).
        'focus-bar': 'var(--color-focus-bar)',
        bg: 'var(--color-bg)',
        'bg-elevated': 'var(--color-bg-elevated)',
        'bg-sunken': 'var(--color-bg-sunken)',
        border: 'var(--color-border)',
        'border-strong': 'var(--color-border-strong)',
        primary: 'var(--color-primary)',
        'primary-hover': 'var(--color-primary-hover)',
        'primary-light': 'var(--color-primary-light)',
        danger: 'var(--color-danger)',
        'danger-text': 'var(--color-danger-text)',
        success: 'var(--color-success)',
        warning: 'var(--color-warning)',
        // ── Alpha-capable siblings (additive; nothing above changes) ──
        // The semantic keys above are raw `var()` strings, so Tailwind has
        // nowhere to inject an alpha channel and an opacity modifier silently
        // emits NO CSS — `bg-primary/10` is a no-op today. These `-a` keys read
        // the RGB-triplet custom properties from index.css instead, so
        // `bg-primary-a/10`, `border-danger-a/40`, `from-bg-a` and friends work,
        // and follow light/dark plus any white-label brand.
        'primary-a': 'rgb(var(--color-primary-rgb) / <alpha-value>)',
        'bg-a': 'rgb(var(--color-bg-rgb) / <alpha-value>)',
        'surface-a': 'rgb(var(--color-surface-rgb) / <alpha-value>)',
        'danger-a': 'rgb(var(--color-danger-rgb) / <alpha-value>)',
        'border-a': 'rgb(var(--color-border-rgb) / <alpha-value>)',
        // ── DONOR TOKEN BRIDGE (additive; nothing above changes) ──────────
        // Ported donor files under src/components/chat/lc/ are copied VERBATIM,
        // class strings included, so they name LibreChat's palette
        // (`bg-surface-tertiary`, `text-text-primary`, …). Tailwind emits NO CSS
        // for a class it cannot resolve and reports no error, so an unbridged
        // donor token is an invisible element that still typechecks and still
        // builds — the worst failure available here.
        //
        // Every entry below is an ALIAS onto a custom property this app already
        // ships (index.css). No new colour is introduced, no hex is written, and
        // both themes follow automatically because the variables do.
        'surface-primary': 'var(--color-bg)',
        'surface-primary-alt': 'var(--color-bg-sunken)',
        'surface-secondary': 'var(--color-surface)',
        'surface-tertiary': 'var(--color-surface-elevated)',
        'surface-active-alt': 'var(--color-row-active)',
        'surface-chat': 'var(--color-bg)',
        'surface-overlay': 'var(--color-text-primary)',
        'border-light': 'var(--color-border)',
        'border-medium': 'var(--color-border)',
        'border-heavy': 'var(--color-border-strong)',
        // Donor `text-*` names live in `colors` (not `textColor`) on purpose:
        // that is what makes `ring-text-primary`, `stroke-text-primary` and
        // `bg-surface-hover` resolve as well as `text-text-primary`, which the
        // donor's focus rings and SVG strokes all depend on.
        'text-primary': 'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
        // Donor splits `secondary` from `secondary-alt` (a step quieter). This
        // app has one secondary ink, so both land on it rather than inventing a
        // colour to satisfy a name.
        'text-secondary-alt': 'var(--color-text-secondary)',
        'text-tertiary': 'var(--color-text-muted)',
        'token-text-tertiary': 'var(--color-text-muted)',
        'status-error': 'var(--color-danger)',
        'brand-purple': 'var(--color-primary)',
        jarvis: {
          blue: 'var(--jarvis-blue)',
          bright: 'var(--jarvis-blue-bright)',
          deep: 'var(--jarvis-blue-deep)',
          purple: 'var(--jarvis-purple)',
          amber: 'var(--jarvis-amber)',
          void: 'var(--jarvis-void)',
          text: 'var(--jarvis-text)',
          mono: 'var(--jarvis-text-mono)',
        },
      },
      textColor: {
        // Donor bridge: `text-token-text-tertiary` (MenuItem) and friends. The
        // `text-*` colour names are declared in `colors` above so every utility
        // family reaches them; these two exist only because the donor writes
        // them with the `token-` prefix in one place.
        'token-text-primary': 'var(--color-text-primary)',
        'token-text-secondary': 'var(--color-text-secondary)',
        primary: 'var(--color-text-primary)',
        secondary: 'var(--color-text-secondary)',
        muted: 'var(--color-text-muted)',
        inverse: 'var(--color-text-inverse)',
      },
      backgroundColor: {
        page: 'var(--color-bg)',
      },
      borderColor: {
        DEFAULT: 'var(--color-border)',
        strong: 'var(--color-border-strong)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        glow: 'var(--shadow-glow)',
      },
      borderRadius: {
        // Donor bridge. LibreChat's own values are `--theme-surface-radius: 1rem`
        // and `--theme-control-radius: 0.75rem` (donor style.css:235-237); this
        // app already ships exactly 16px and 12px, so the aliases are equal by
        // value, not merely close.
        'theme-surface': 'var(--radius-xl)',
        'theme-control': 'var(--radius-lg)',
        'theme-round-control': '9999px',
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      fontFamily: {
        // Donor bridge: `font-theme-ui` is the donor's one UI face. Ours is the
        // sans stack — the donor hard-codes Inter, which this app already lists
        // first in `--font-sans`.
        'theme-ui': ['var(--font-sans)'],
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      fontSize: {
        'display-lg': ['36px', { lineHeight: '1.1', fontWeight: '800' }],
        'display-sm': ['28px', { lineHeight: '1.2', fontWeight: '700' }],
        'heading-lg': ['22px', { lineHeight: '1.3', fontWeight: '700' }],
        'heading-sm': ['16px', { lineHeight: '1.4', fontWeight: '600' }],
        'body': ['15px', { lineHeight: '1.7', fontWeight: '400' }],
        'body-sm': ['14px', { lineHeight: '1.6', fontWeight: '400' }],
        'caption': ['13px', { lineHeight: '1.5', fontWeight: '500' }],
        'overline': ['11px', { lineHeight: '1.4', fontWeight: '700' }],
      },
      spacing: {
        // Donor bridge: `px-theme-normal` / `p-theme-compact` (donor style.css
        // `--theme-space-normal: 0.75rem`, `--theme-space-compact: 0.375rem`).
        // Copied by value so a ported row keeps the donor's rhythm.
        'theme-normal': '0.75rem',
        'theme-compact': '0.375rem',
        'sidebar': 'var(--sidebar-width)',
        'sidebar-collapsed': 'var(--sidebar-width-collapsed)',
        'header': 'var(--header-height)',
      },
      transitionDuration: {
        // Donor bridge: `duration-theme-normal` / `duration-theme-fast` (donor
        // style.css `--theme-motion-normal: 200ms`, `--theme-motion-fast: 150ms`).
        // `theme-normal` maps onto this app's own 200ms token — same number, one
        // declaration — while `theme-fast` takes our 100ms rather than inventing
        // a third speed for a 50ms difference nobody can see.
        'theme-normal': 'var(--duration-normal)',
        'theme-fast': 'var(--duration-fast)',
        fast: 'var(--duration-fast)',
        normal: 'var(--duration-normal)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        'out': 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
      },
    },
  },
  plugins: [],
} satisfies Config;
