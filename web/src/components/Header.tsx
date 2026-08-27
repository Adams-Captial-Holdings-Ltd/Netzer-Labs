import { useLocation } from 'wouter-preact';
import { clearToken } from '../lib/api';
import { themePreference, setTheme, resolvedTheme, brand, DEFAULT_COMPANY_NAME } from '../lib/theme';
import { toggleMobileMenu, pageOwnsTopBar } from './Sidebar';
import { NotificationBell } from './NotificationBell';

const BREADCRUMB_LABELS: Record<string, string> = {
  '/': 'Overview',
  '/agents': 'Agents',
  '/chat': 'Chat',
  '/sessions': 'Sessions',
  '/settings': 'Settings',
  '/usage': 'Usage',
  '/audit': 'Audit Log',
  '/kill-switches': 'Kill Switches',
  '/vectors': 'Knowledge Base',
  '/missions': 'Missions',
  '/memories': 'Memories',
  '/hive': 'Hive Mind',
  '/scheduled': 'Scheduled Tasks',
  '/warroom': 'War Room',
};

function getBreadcrumbs(location: string): { label: string; href: string }[] {
  const crumbs = [{ label: 'Home', href: '/' }];
  if (location === '/') return crumbs;

  const segments = location.split('/').filter(Boolean);
  let path = '';
  for (const seg of segments) {
    path += `/${seg}`;
    crumbs.push({ label: BREADCRUMB_LABELS[path] ?? seg, href: path });
  }
  return crumbs;
}

export function Header() {
  const [location] = useLocation();
  const crumbs = getBreadcrumbs(location);
  const dark = resolvedTheme.value === 'dark';
  // White-label brand. Falls back to the default company name when unset; the
  // logo only renders when an explicit logo_url is configured.
  const companyName = brand.value.companyName?.trim() || DEFAULT_COMPANY_NAME;
  const logoUrl = brand.value.logoUrl?.trim() || null;

  function cycleTheme() {
    const order = ['light', 'dark', 'system'] as const;
    const idx = order.indexOf(themePreference.value);
    setTheme(order[(idx + 1) % order.length]);
  }

  // ── ONE BAR, AT EVERY WIDTH ────────────────────────────────
  // The chat surface draws its own top bar (ChatHeader), and the donor's chat
  // header IS the app bar — `Chat/Header.tsx` is a single 52px row and there is
  // nothing above it. Stacking this 56px header on top of it spent 108 CSS px
  // of a 812px viewport on chrome before the first word of an answer, and put a
  // bare 32x32 hamburger at the top-left corner 245px from the 44x44 pill that
  // opens the conversation drawer — two openers, and the wrong one on top.
  //
  // Round 5 fixed that BELOW `lg` and left the desktop alone, on the reasoning
  // that a wide viewport can afford a second bar. It cannot, and the same critic
  // measured the same defect one breakpoint up: at 1280 this header's ink ran
  // y 20.0-35.5, the chat plate 56.5-122.5, and the first content line landed at
  // y=131.5 against the donor's 57.0 — two bars, 2.3x the donor's chrome, at the
  // breakpoint E1's own framing ("fix the economy, not the symptoms") points at.
  // A thinner second bar is still a second bar, and so is a second bar on a
  // bigger screen.
  //
  // So on these routes this header stands down at EVERY width and the page owns
  // the top of the viewport. Nothing is removed, and nothing new had to be
  // invented to hold what it carried: the brand is already the first thing in
  // the rail (Sidebar's own `h-[var(--header-height)]` head), the current page is
  // already the marked row in that rail's nav, and the three account controls
  // move into the rail's foot — which is exactly where they already were below
  // `lg`, so this is one relocation applied a breakpoint wider rather than a new
  // one. The breadcrumb is the single thing the chat route gives up; on a
  // surface whose location is "Chat", the marked nav row states it.
  //
  // `hidden` rather than a conditional render, so the bell keeps polling and the
  // theme signal keeps its subscriber on every route, exactly as before.
  const standDown = pageOwnsTopBar(location);

  return (
    <header
      class={`sticky top-0 z-30 h-[var(--header-height)] bg-surface/80 backdrop-blur-lg border-b border-border flex items-center gap-4 px-6 ${standDown ? 'hidden' : ''}`}
    >
      <button
        onClick={toggleMobileMenu}
        class="lg:hidden p-1.5 rounded-md hover:bg-surface-hover text-secondary"
        aria-label="Toggle navigation menu"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      <div class="flex items-center gap-2 shrink-0" aria-label="Workspace brand">
        {logoUrl && (
          <img
            src={logoUrl}
            alt={`${companyName} logo`}
            class="h-6 w-auto max-w-[120px] object-contain rounded-sm"
          />
        )}
        <span class="text-body-sm font-semibold text-primary truncate max-w-[160px]">{companyName}</span>
        <span class="hidden sm:block w-px h-5 bg-border" aria-hidden="true" />
      </div>

      <nav class="hidden sm:flex items-center gap-1.5 text-caption text-muted overflow-hidden" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={c.href} class="flex items-center gap-1.5 shrink-0">
            {i > 0 && <span class="text-muted">/</span>}
            <span class={i === crumbs.length - 1 ? 'text-primary font-medium' : 'hover:text-secondary'}>
              {c.label}
            </span>
          </span>
        ))}
      </nav>

      <div class="flex-1" />

      <NotificationBell />

      <button
        onClick={cycleTheme}
        class="p-2 rounded-lg hover:bg-surface-hover text-secondary transition-colors"
        title={`Theme: ${themePreference.value}`}
        aria-label={`Switch theme (current: ${themePreference.value})`}
      >
        {dark ? (
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
        ) : (
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        )}
      </button>

      <button
        onClick={() => { clearToken(); window.location.reload(); }}
        class="text-caption text-muted hover:text-danger transition-colors px-3 py-1.5 rounded-lg hover:bg-surface-hover whitespace-nowrap shrink-0"
      >
        Sign out
      </button>
    </header>
  );
}
