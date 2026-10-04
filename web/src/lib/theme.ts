import { signal } from '@preact/signals';
import { api } from './api';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'cce_theme';

function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function loadTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system';
}

export const themePreference = signal<Theme>(loadTheme());

export const resolvedTheme = signal<'light' | 'dark'>(
  themePreference.value === 'system' ? getSystemTheme() : themePreference.value
);

export function setTheme(t: Theme) {
  themePreference.value = t;
  localStorage.setItem(STORAGE_KEY, t);
  apply();
}

function apply() {
  const resolved = themePreference.value === 'system' ? getSystemTheme() : themePreference.value;
  resolvedTheme.value = resolved;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
  // The brand shades are derived per active theme (see applyBrand), so a
  // light/dark switch has to re-run the derivation for the new mode.
  applyBrand();
}

// apply() now derives brand shades via applyBrand(), which reads the `brand`
// signal declared further down. Defer the initial call until after that signal
// exists (see the apply() invocation below the brand declaration) to avoid a
// temporal-dead-zone access. The `dark` class is still toggled synchronously at
// module load, before the app mounts, so there is no flash of the wrong theme.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themePreference.value === 'system') apply();
});

// ── White-label branding ──────────────────────────────────────────────
// Branding is the LIVE render source the Header (and later the Sidebar) reads.
// It is driven by the active NAMED THEME (see the theme engine below): when a
// theme becomes active, applyTheme() writes its identity into this `brand`
// signal, sets the CSS palette, the document.title, and the favicon. The brand
// values are mirrored into localStorage and applied synchronously at module
// load so there is no flash of the default brand before the app mounts or
// before /api/config resolves, and so the brand renders on screens that exist
// before login. reconcileThemes() pulls the authoritative library once a
// session is available.

export interface Brand {
  companyName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  // The small subtitle under the company name in the sidebar (was the hardcoded
  // "Enterprise"). Null falls back to DEFAULT_COMPANY_TAGLINE so the stock look is
  // preserved when a theme doesn't set one.
  tagline: string | null;
}

// Defaults match index.css: --color-primary (indigo 500) and the accent
// hue used by charts/inputs (--color-info, cyan 500). When a brand field is
// unset we fall back to these exact values so the UI matches today's look.
export const DEFAULT_PRIMARY = '#6366f1';
export const DEFAULT_ACCENT = '#06b6d4';
export const DEFAULT_COMPANY_NAME = 'Netzar OS';
// The sidebar subtitle shown under the company name when a theme doesn't set its
// own tagline. Matches the previously-hardcoded label so the default theme is
// visually unchanged.
export const DEFAULT_COMPANY_TAGLINE = 'Enterprise';
// The stock lobster favicon, identical to the runtime-overridable <link
// rel="icon"> seeded in index.html. Used as the final fallback when neither a
// theme iconUrl nor logoUrl is set, and to restore the icon when the default
// theme is active.
export const DEFAULT_FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🦞</text></svg>";
// The product name shown in the browser tab/title-bar when the default theme is
// active. Kept distinct from DEFAULT_COMPANY_NAME (the header label) because the
// stock title carries the "Enterprise" suffix from index.html.
export const DEFAULT_DOCUMENT_TITLE = 'Netzar OS Enterprise';

const BRAND_KEYS = {
  companyName: 'cce_brand_company_name',
  logoUrl: 'cce_brand_logo_url',
  primaryColor: 'cce_brand_primary_color',
  accentColor: 'cce_brand_accent_color',
  tagline: 'cce_brand_tagline',
} as const;

// Accept #rgb / #rrggbb only. A bad value (e.g. a stray paste) must never be
// written into a CSS variable, or it could break the whole palette.
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isHexColor(v: string | null | undefined): v is string {
  return typeof v === 'string' && HEX_RE.test(v.trim());
}

function loadCachedBrand(): Brand {
  const read = (k: string) => {
    const v = localStorage.getItem(k);
    return v && v.trim() ? v : null;
  };
  return {
    companyName: read(BRAND_KEYS.companyName),
    logoUrl: read(BRAND_KEYS.logoUrl),
    primaryColor: read(BRAND_KEYS.primaryColor),
    accentColor: read(BRAND_KEYS.accentColor),
    tagline: read(BRAND_KEYS.tagline),
  };
}

export const brand = signal<Brand>(loadCachedBrand());

// Expand a 3-digit hex (#abc) to 6 digits so the rgba() math below is simple.
function expandHex(hex: string): string {
  const h = hex.trim();
  if (h.length === 4) {
    return `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  return h;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = expandHex(hex);
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

// Nudge a hex toward black (factor < 1) or white (factor > 1) so we can derive
// the primary-hover (darker) and primary-light (lighter) shades the design
// tokens expect from a single brand color.
function shade(hex: string, factor: number): string {
  const { r, g, b } = hexToRgb(hex);
  const adj = (c: number) =>
    factor <= 1
      ? Math.round(c * factor)
      : Math.round(c + (255 - c) * (factor - 1));
  const clamp = (c: number) => Math.max(0, Math.min(255, adj(c)));
  const toHex = (c: number) => clamp(c).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Write the brand colors into the semantic CSS variables.
//
// These variables are set inline on documentElement, which is also where the
// `dark` class lives. Inline styles beat any selector, so an inline value here
// overrides BOTH the :root (light) and .dark blocks in index.css. That is the
// trap dark mode fell into: index.css deliberately uses a *lighter* primary in
// dark (#818cf8) than in light (#6366f1) so it reads on the near-black bg, and
// it inverts the hover/light shade direction. Writing a light-derived value
// inline clobbered that and killed dark contrast.
//
// Keep the stock primary fill in each mode, and choose its text and hover
// shade from WCAG contrast. A customer fill keeps its chosen base in light
// mode; dark mode lifts it before choosing the text and hover shade.
/** WCAG relative luminance chooses the stronger of black and white on a brand fill. */
export function primaryTextFor(hex: string): '#000000' | '#ffffff' {
  const { r, g, b } = hexToRgb(hex);
  const linear = (channel: number) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > 0.179128784747792 ? '#000000' : '#ffffff';
}

export function applyBrand() {
  const root = document.documentElement;
  const isDark = resolvedTheme.value === 'dark';

  const primary = isHexColor(brand.value.primaryColor) ? brand.value.primaryColor.trim() : null;
  const accent = isHexColor(brand.value.accentColor) ? brand.value.accentColor.trim() : null;

  // The base fill follows the active theme. Text and hover track its contrast.
  if (primary === null) {
    const stockFill = isDark ? '#818cf8' : DEFAULT_PRIMARY;
    root.style.setProperty('--color-text-inverse', primaryTextFor(stockFill));
    root.style.setProperty('--color-primary-hover', shade(stockFill, 1.12));
    root.style.removeProperty('--color-primary');
    root.style.removeProperty('--color-primary-light');
    root.style.removeProperty('--color-primary-glow');
    // Clear the alpha mirror with the brand fill so the stock mode wins.
    root.style.removeProperty('--color-primary-rgb');
  } else {
    const base = isDark ? shade(primary, 1.18) : primary;
    root.style.setProperty('--color-primary', base);
    const text = primaryTextFor(base);
    root.style.setProperty('--color-text-inverse', text);
    root.style.setProperty('--color-primary-hover', shade(base, text === '#000000' ? 1.12 : 0.82));
    root.style.setProperty('--color-primary-light', shade(base, isDark ? 1.28 : 1.25));
    // The alpha-capable mirror of --color-primary, as a space-separated RGB
    // triplet for `rgb(var(--color-primary-rgb) / <alpha-value>)` (the
    // `primary-a` Tailwind key). Derived from the SAME per-mode `base` written
    // just above — not from the raw brand hex — or a dark-mode brand tint would
    // sit at a different lightness than the solid it is meant to tint.
    const rgb = hexToRgb(base);
    root.style.setProperty('--color-primary-rgb', `${rgb.r} ${rgb.g} ${rgb.b}`);
    // Glow is a translucent tint; the same brand rgb works in both modes and
    // index.css already bumps the alpha for dark via its own token, but since
    // we override inline we set a slightly stronger alpha in dark to match.
    root.style.setProperty('--color-primary-glow', rgba(primary, isDark ? 0.2 : 0.15));
  }

  // Many components reference var(--color-accent) (charts via BarChart/Sparkline)
  // and var(--color-info) (cyan-keyed UI). Keep them aligned. Accent is a
  // saturated hue that reads on both surfaces, so a single value works in light
  // and dark, mirroring index.css, which keeps --color-info identical across
  // :root and .dark (it never re-tunes it for dark).
  //
  // Unlike the primary family, --color-accent is NOT declared in index.css at
  // all, so there is no cascade to fall back to: removing the inline override
  // would leave var(--color-accent) unresolved and break the charts in BOTH
  // modes. So when unset we explicitly write the documented DEFAULT_ACCENT
  // (which equals index.css's :root --color-info, #06b6d4) rather than clearing
  // it. The --color-info token IS declared in :root and inherited by .dark, so writing the
  // same default keeps the two tokens aligned and matches the stock value in
  // both modes.
  if (accent === null) {
    root.style.setProperty('--color-accent', DEFAULT_ACCENT);
    root.style.setProperty('--color-info', DEFAULT_ACCENT);
  } else {
    root.style.setProperty('--color-accent', accent);
    root.style.setProperty('--color-info', accent);
  }
}

// Initial run: the `brand` signal now exists, so apply() can derive brand
// shades for the active theme and toggle the `dark` class in one pass.
apply();

// Persist + apply a partial brand update. Empty string clears a field back to
// the default. Drives the live `brand` signal (Header consumes it) and the CSS
// palette via applyBrand(). applyTheme() routes the active theme's colors +
// identity through here so the header re-skins without a reload.
export function setBrand(patch: Partial<Brand>) {
  const next: Brand = { ...brand.value, ...patch };
  brand.value = next;
  const write = (k: string, v: string | null) => {
    if (v && v.trim()) localStorage.setItem(k, v.trim());
    else localStorage.removeItem(k);
  };
  write(BRAND_KEYS.companyName, next.companyName);
  write(BRAND_KEYS.logoUrl, next.logoUrl);
  write(BRAND_KEYS.primaryColor, next.primaryColor);
  write(BRAND_KEYS.accentColor, next.accentColor);
  write(BRAND_KEYS.tagline, next.tagline);
  applyBrand();
}

// Pull the authoritative branding from runtime-config and sync the cache.
// Retained for back-compat with the legacy "branding" category. The named-theme
// engine (reconcileThemes) is the primary source going forward; this stays so
// any deployment still holding values under the old category keeps working.
// Safe to call on any authenticated screen; returns the resolved Brand.
export async function refreshBrand(signal?: AbortSignal): Promise<Brand> {
  const res = await api.config.list('branding', signal);
  const v = res.values ?? {};
  const norm = (s: string | undefined) => (s && s.trim() ? s : null);
  setBrand({
    companyName: norm(v.company_name),
    logoUrl: norm(v.logo_url),
    primaryColor: norm(v.primary_color),
    accentColor: norm(v.accent_color),
    tagline: norm(v.tagline),
  });
  return brand.value;
}

// ── Named-theme engine (white-label) ──────────────────────────────────
// A NamedTheme is a saved company brand: an identity (name = the display title,
// logo, favicon) plus the two driving colors. There is a LIBRARY of themes and
// one ACTIVE theme id. Selecting a theme re-skins the WHOLE UI (palette,
// document.title, favicon, header identity) live, in both light and dark.
//
// Persistence: api.config category "themes", key "library" (JSON array of
// NamedTheme) + key "active" (the active id). Reconciled from the backend once
// a session exists. Both are mirrored to localStorage so boot can apply the
// active theme synchronously, before mount, with no flash.

export interface NamedTheme {
  id: string;
  name: string;
  /** Sidebar subtitle under the company name; falls back to "Enterprise" when unset. */
  tagline?: string;
  logoUrl?: string;
  iconUrl?: string;
  primaryColor: string;
  accentColor: string;
}

export const DEFAULT_THEME_ID = 'claudeclaw';

// The built-in default. Always present, never deletable. Its colors are the
// stock indigo/cyan and its favicon is the lobster, so selecting it restores
// today's exact look. name is the company label shown in the header; the
// document.title for this theme is the longer product title (see titleFor).
export const DEFAULT_THEME: NamedTheme = {
  id: DEFAULT_THEME_ID,
  name: DEFAULT_COMPANY_NAME,
  iconUrl: DEFAULT_FAVICON,
  primaryColor: DEFAULT_PRIMARY,
  accentColor: DEFAULT_ACCENT,
};

const THEMES_CATEGORY = 'themes';
const THEMES_LIBRARY_KEY = 'library';
const THEMES_ACTIVE_KEY = 'active';

const THEME_CACHE = {
  library: 'cce_themes_library',
  active: 'cce_themes_active',
} as const;

function isValidUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  // Three accepted shapes: http(s) URLs, data:image URIs (e.g. the inline lobster
  // favicon), and a same-origin branding-asset path served by our own public
  // GET /api/branding/asset/<id> — that path is host-independent, so a logo
  // uploaded in prod still resolves locally and vice-versa. Everything else
  // (javascript:, other relative paths) is rejected so a saved value can't smuggle
  // a script into href.
  return (
    /^https?:\/\//i.test(s) ||
    /^data:image\//i.test(s) ||
    /^\/api\/branding\/asset\/[A-Za-z0-9._-]+$/.test(s)
  );
}

// Parse one untrusted entry into a NamedTheme, dropping it if it lacks the
// required fields or carries bad colors. Optional URL fields are stripped if
// invalid rather than failing the whole theme.
function parseTheme(raw: unknown): NamedTheme | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  const primaryColor = isHexColor(o.primaryColor as string) ? (o.primaryColor as string).trim() : '';
  const accentColor = isHexColor(o.accentColor as string) ? (o.accentColor as string).trim() : '';
  if (!id || !name || !primaryColor || !accentColor) return null;
  const theme: NamedTheme = { id, name, primaryColor, accentColor };
  // Optional subtitle; trimmed and length-capped so a stray paste can't blow out
  // the header. Dropped (falls back to "Enterprise") when empty.
  if (typeof o.tagline === 'string' && o.tagline.trim()) theme.tagline = o.tagline.trim().slice(0, 40);
  if (isValidUrl(o.logoUrl)) theme.logoUrl = (o.logoUrl as string).trim();
  if (isValidUrl(o.iconUrl)) theme.iconUrl = (o.iconUrl as string).trim();
  return theme;
}

// Normalize a library array: parse each entry, drop invalids, and guarantee the
// non-deletable default is present (pinned first). A user copy of the default id
// is ignored in favor of the canonical built-in so it can never be redefined or
// removed.
function normalizeLibrary(raw: unknown): NamedTheme[] {
  const arr = Array.isArray(raw) ? raw : [];
  const parsed: NamedTheme[] = [];
  for (const entry of arr) {
    const t = parseTheme(entry);
    if (t && t.id !== DEFAULT_THEME_ID) parsed.push(t);
  }
  return [DEFAULT_THEME, ...parsed];
}

function loadCachedLibrary(): NamedTheme[] {
  try {
    const raw = localStorage.getItem(THEME_CACHE.library);
    if (!raw) return [DEFAULT_THEME];
    return normalizeLibrary(JSON.parse(raw));
  } catch {
    // Corrupt cache -> fall back to just the default so the UI still skins.
    return [DEFAULT_THEME];
  }
}

function loadCachedActiveId(): string {
  try {
    const v = localStorage.getItem(THEME_CACHE.active);
    return v && v.trim() ? v.trim() : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

// The saved themes and the active id. Hydrated synchronously from localStorage
// so boot can apply without waiting on the network; reconcileThemes() refreshes
// them from the backend once authenticated.
export const themesLibrary = signal<NamedTheme[]>(loadCachedLibrary());
export const activeThemeId = signal<string>(loadCachedActiveId());

// Resolve the active theme object, falling back to the default if the active id
// no longer exists in the library (e.g. it was deleted on another device).
export function getActiveTheme(): NamedTheme {
  return (
    themesLibrary.value.find((t) => t.id === activeThemeId.value) ??
    themesLibrary.value.find((t) => t.id === DEFAULT_THEME_ID) ??
    DEFAULT_THEME
  );
}

// The browser-tab title for a theme. The built-in default keeps the stock
// product title (with the "Enterprise" suffix from index.html); every named
// theme uses its company name verbatim.
function titleFor(theme: NamedTheme): string {
  return theme.id === DEFAULT_THEME_ID ? DEFAULT_DOCUMENT_TITLE : theme.name;
}

// The favicon href for a theme: the explicit favicon, else the logo, else the
// stock lobster. Only validated URLs reach here (parseTheme strips bad ones).
function faviconFor(theme: NamedTheme): string {
  return theme.iconUrl || theme.logoUrl || DEFAULT_FAVICON;
}

// Ensure a runtime-overridable <link rel="icon"> exists and point it at href.
// index.html seeds one, but we create it defensively so applyTheme works even
// if the element was removed.
function setFavicon(href: string) {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  // The default lobster is an SVG data URI; a custom favicon may be any image
  // type, so leave the type attribute to be inferred unless it's the SVG.
  if (/^data:image\/svg/i.test(href)) link.type = 'image/svg+xml';
  else link.removeAttribute('type');
  link.href = href;
}

// Apply a named theme to the WHOLE UI. Idempotent and safe to call at boot and
// on every selection:
//  1. CSS palette via setBrand -> applyBrand (light/dark aware, legible in both)
//  2. document.title
//  3. favicon (<link rel="icon"> href)
//  4. the live `brand` signal (company name + logo) the Header reads
// The default theme passes null colors to setBrand so the stock per-mode
// index.css palette is restored exactly (see applyBrand), rather than baking the
// light-mode indigo inline.
export function applyTheme(theme: NamedTheme) {
  const isDefault = theme.id === DEFAULT_THEME_ID;
  setBrand({
    companyName: isDefault ? null : theme.name,
    logoUrl: theme.logoUrl ?? null,
    primaryColor: isDefault ? null : theme.primaryColor,
    accentColor: isDefault ? null : theme.accentColor,
    // Null for the default (and for any theme without one) so the sidebar shows
    // the stock "Enterprise" via DEFAULT_COMPANY_TAGLINE.
    tagline: isDefault ? null : (theme.tagline ?? null),
  });
  document.title = titleFor(theme);
  setFavicon(faviconFor(theme));
}

// Persist the library + active id to localStorage so boot can re-skin with no
// flash. Best-effort: a quota/private-mode failure still leaves the in-memory
// signals authoritative for this session.
function cacheThemes() {
  try {
    localStorage.setItem(THEME_CACHE.library, JSON.stringify(themesLibrary.value));
    localStorage.setItem(THEME_CACHE.active, activeThemeId.value);
  } catch {
    // localStorage unavailable -> caching is best-effort; the next boot just
    // falls back to the default until reconcileThemes() runs.
  }
}

// Persist a library array to the backend (admin-gated). Returns the write
// promise so callers can surface errors. Only USER themes are sent: the
// built-in default is re-pinned client-side by normalizeLibrary on every read,
// and its inline `<svg>` favicon data URI trips the edge WAF's
// CrossSiteScripting_BODY rule, which 403s the whole POST.
function persistLibrary(library: NamedTheme[], signal?: AbortSignal): Promise<unknown> {
  const userThemes = library.filter((t) => t.id !== DEFAULT_THEME_ID);
  return api.config.set(THEMES_CATEGORY, THEMES_LIBRARY_KEY, JSON.stringify(userThemes), signal);
}

// Persist an active id to the backend (admin-gated).
function persistActive(id: string, signal?: AbortSignal): Promise<unknown> {
  return api.config.set(THEMES_CATEGORY, THEMES_ACTIVE_KEY, id, signal);
}

function genThemeId(): string {
  return `theme_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export interface ThemeInput {
  name: string;
  primaryColor: string;
  accentColor: string;
  tagline?: string | null;
  logoUrl?: string | null;
  iconUrl?: string | null;
}

// A logo/icon a USER theme may persist: http(s) URLs and uploaded branding
// assets only. Stricter than isValidUrl (which also renders data:image URIs for
// the built-in lobster favicon): inline data URIs in the persisted JSON either
// trip the edge WAF's XSS body rule (SVG markup) or blow its 8KB body cap
// (base64 images), so they are rejected at input time with a clear message.
function isPersistableUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) || /^\/api\/branding\/asset\/[A-Za-z0-9._-]+$/.test(s);
}

// Build a NamedTheme from validated input, throwing on bad fields so the Settings
// UI can show a precise message. Optional URLs are normalized to undefined when
// blank; a non-empty URL must be http(s) or an uploaded branding asset.
function buildTheme(id: string, input: ThemeInput): NamedTheme {
  const name = input.name.trim();
  const primaryColor = input.primaryColor.trim();
  const accentColor = input.accentColor.trim();
  if (!name) throw new Error('Theme name is required');
  if (!isHexColor(primaryColor)) throw new Error('Primary color must be a hex value like #6366f1');
  if (!isHexColor(accentColor)) throw new Error('Accent color must be a hex value like #06b6d4');
  const theme: NamedTheme = { id, name, primaryColor, accentColor };
  const tagline = input.tagline?.trim();
  if (tagline) theme.tagline = tagline.slice(0, 40);
  const logo = input.logoUrl?.trim();
  if (logo) {
    if (!isPersistableUrl(logo)) {
      throw new Error('Logo must be an http(s) URL or an uploaded image');
    }
    theme.logoUrl = logo;
  }
  const icon = input.iconUrl?.trim();
  if (icon) {
    if (!isPersistableUrl(icon)) {
      throw new Error('Icon must be an http(s) URL or an uploaded image');
    }
    theme.iconUrl = icon;
  }
  return theme;
}

// Create a new theme, persist, and append it to the library. Does NOT activate
// it (call selectTheme for that). Returns the created theme. Persist-FIRST:
// committing to the signal/cache before the write once left a phantom theme in
// the UI when the edge WAF blocked the POST, while the backend had nothing.
export async function createTheme(input: ThemeInput, signal?: AbortSignal): Promise<NamedTheme> {
  const theme = buildTheme(genThemeId(), input);
  const next = [...themesLibrary.value, theme];
  await persistLibrary(next, signal);
  themesLibrary.value = next;
  cacheThemes();
  return theme;
}

// Update an existing theme in place and persist. The built-in default cannot be
// edited (its colors/identity are the canonical stock look). If the edited theme
// is currently active, re-apply it live so the UI re-skins immediately.
export async function updateTheme(
  id: string,
  input: ThemeInput,
  signal?: AbortSignal,
): Promise<NamedTheme> {
  if (id === DEFAULT_THEME_ID) throw new Error('The default theme cannot be edited');
  const idx = themesLibrary.value.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error('Theme not found');
  const theme = buildTheme(id, input);
  const next = themesLibrary.value.slice();
  next[idx] = theme;
  await persistLibrary(next, signal);
  themesLibrary.value = next;
  cacheThemes();
  if (activeThemeId.value === id) applyTheme(theme);
  return theme;
}

// Delete a theme and persist. The built-in default is non-deletable. If the
// deleted theme was active, fall back to the default and re-skin live.
export async function deleteTheme(id: string, signal?: AbortSignal): Promise<void> {
  if (id === DEFAULT_THEME_ID) throw new Error('The default theme cannot be deleted');
  if (!themesLibrary.value.some((t) => t.id === id)) throw new Error('Theme not found');
  const next = themesLibrary.value.filter((t) => t.id !== id);
  // Persist the library always; persist the active id only if it changed.
  await persistLibrary(next, signal);
  themesLibrary.value = next;
  const wasActive = activeThemeId.value === id;
  if (wasActive) activeThemeId.value = DEFAULT_THEME_ID;
  cacheThemes();
  if (wasActive) {
    applyTheme(getActiveTheme());
    await persistActive(DEFAULT_THEME_ID, signal);
  }
}

// Make a theme active: re-skin the UI live and persist the active id. Throws if
// the id is unknown so the caller never sets an active id that resolves to the
// fallback silently.
export async function selectTheme(id: string, signal?: AbortSignal): Promise<NamedTheme> {
  const theme = themesLibrary.value.find((t) => t.id === id);
  if (!theme) throw new Error('Theme not found');
  await persistActive(id, signal);
  activeThemeId.value = id;
  cacheThemes();
  applyTheme(theme);
  return theme;
}

// Apply the active theme synchronously from the localStorage cache. Called at
// boot (main.tsx) BEFORE mount so the palette, title, favicon, and header
// identity are correct on first paint — no flash of the default brand. Safe to
// call before any session exists.
export function bootTheme() {
  applyTheme(getActiveTheme());
}

// Reconcile the in-memory library + active id with the authoritative backend
// values once a session exists, then re-apply if the active theme changed.
// Hydrates the cache so the next boot reflects server state. Failures are
// surfaced to the caller (no empty catch); the cached/boot values stay live.
export async function reconcileThemes(signal?: AbortSignal): Promise<void> {
  const res = await api.config.list(THEMES_CATEGORY, signal);
  const values = res.values ?? {};

  let library = themesLibrary.value;
  if (typeof values[THEMES_LIBRARY_KEY] === 'string' && values[THEMES_LIBRARY_KEY].trim()) {
    try {
      library = normalizeLibrary(JSON.parse(values[THEMES_LIBRARY_KEY]));
    } catch (err) {
      // A malformed server value must not blank the UI: keep the cached library
      // and report it via the rejected promise so the caller can log/toast.
      throw new Error(
        `Stored theme library is malformed: ${err instanceof Error ? err.message : 'parse error'}`,
      );
    }
  }

  const serverActive = values[THEMES_ACTIVE_KEY]?.trim();
  const nextActive =
    serverActive && library.some((t) => t.id === serverActive) ? serverActive : DEFAULT_THEME_ID;

  themesLibrary.value = library;
  activeThemeId.value = nextActive;
  cacheThemes();
  applyTheme(getActiveTheme());
}
