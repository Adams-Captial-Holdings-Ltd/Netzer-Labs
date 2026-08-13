import { useState } from 'preact/hooks';
import { api } from '../lib/api';

interface LoginProps {
  onLogin: (token: string, remember: boolean) => void;
}

// Light client-side shape check only. The backend is the authority and never
// reveals whether an address maps to an account (no enumeration), so this is
// purely to stop an obviously-empty submit.
function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

export function Login({ onLogin }: LoginProps) {
  // ── Magic-link (primary) ──────────────────────────────────────────────
  const [email, setEmail] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkSent, setLinkSent] = useState(false);
  const [linkError, setLinkError] = useState('');

  // ── Raw-token entry (advanced / fallback) ─────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [shaking, setShaking] = useState(false);

  function triggerShake() {
    setShaking(true);
    setTimeout(() => setShaking(false), 400);
  }

  async function handleMagicLink(e: Event) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    if (!looksLikeEmail(trimmed)) {
      setLinkError('Enter a valid email address.');
      return;
    }

    setLinkLoading(true);
    setLinkError('');

    try {
      // ALWAYS resolves 202 regardless of whether the account exists. We show
      // the same neutral confirmation either way so the page never reveals
      // which addresses are registered.
      await api.auth.login(trimmed);
      setLinkSent(true);
    } catch {
      // The endpoint is constant-work and never errors on a valid request, so a
      // failure here means the network/server is unreachable — surface that
      // without implying anything about the account.
      setLinkError('Unable to reach the server. Check your connection and try again.');
    }
    setLinkLoading(false);
  }

  async function handleTokenSubmit(e: Event) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/tier', {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (res.status === 401) {
        setError('Invalid token. Check that you have the correct dashboard token.');
        triggerShake();
      } else if (!res.ok) {
        setError('Server unreachable. Please try again in a moment.');
        triggerShake();
      } else {
        onLogin(trimmed, remember);
      }
    } catch {
      setError('Unable to connect to server. Check your network connection.');
      triggerShake();
    }
    setLoading(false);
  }

  return (
    <div class="min-h-screen flex items-center justify-center bg-page p-4">
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
        <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-pink-500/5 rounded-full blur-3xl" />
      </div>

      <div class={`relative bg-surface border border-border rounded-2xl shadow-xl p-8 w-full max-w-sm ${shaking ? 'shake' : ''}`}>
        <div class="text-center mb-8">
          <div class="w-12 h-12 bg-gradient-to-br from-claw-500 to-purple-600 rounded-xl flex items-center justify-center mb-3 mx-auto">
            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
          </div>
          <h1 class="text-display-sm text-primary font-bold">ClaudeClaw</h1>
          <p class="text-caption text-muted mt-1">Enterprise AI Agent Platform</p>
        </div>

        {linkSent ? (
          <div class="space-y-4">
            <div class="w-12 h-12 bg-success/10 rounded-full flex items-center justify-center mx-auto">
              <svg class="w-6 h-6 text-success" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 6l-10 7L2 6" />
                <rect x="2" y="4" width="20" height="16" rx="2" />
              </svg>
            </div>
            <div class="text-center space-y-1">
              <h2 class="text-body text-primary font-semibold">Check your email</h2>
              <p class="text-body-sm text-secondary">
                If an account matches that address, a sign-in link is on its way. The link expires in 15 minutes.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setLinkSent(false); setEmail(''); }}
              class="w-full text-body-sm text-secondary hover:text-primary underline-offset-2 hover:underline transition-colors"
            >
              Use a different email
            </button>
          </div>
        ) : (
          <form onSubmit={handleMagicLink} class="space-y-4">
            <div>
              <label class="block text-caption text-secondary font-medium mb-1.5" for="email-input">
                Email
              </label>
              <input
                id="email-input"
                type="email"
                value={email}
                onInput={(e) => { setEmail((e.target as HTMLInputElement).value); setLinkError(''); }}
                placeholder="you@company.com"
                autoFocus
                autoComplete="email"
                inputMode="email"
                class="w-full px-3 py-2.5 bg-bg-elevated border border-border rounded-lg text-body-sm
                  focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none transition-colors
                  placeholder:text-muted"
              />
            </div>

            {linkError && (
              <div class="bg-danger/10 text-danger text-body-sm px-3 py-2.5 rounded-lg border border-danger/20">
                {linkError}
              </div>
            )}

            <button
              type="submit"
              disabled={linkLoading || !email.trim()}
              class="w-full bg-primary text-inverse py-2.5 rounded-lg text-body-sm font-medium
                hover:bg-primary-hover transition-colors shadow-sm
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {linkLoading ? (
                <span class="inline-flex items-center gap-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Sending link...
                </span>
              ) : (
                'Email me a sign-in link'
              )}
            </button>
          </form>
        )}

        {/* Advanced / fallback: paste a raw dashboard bearer token directly.
            Kept for break-glass / root-token operators and CI, hidden by default
            so the magic-link path is the obvious one. */}
        <div class="mt-6 pt-5 border-t border-border">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            class="w-full flex items-center justify-center gap-1.5 text-overline text-muted hover:text-secondary transition-colors"
          >
            <span>Sign in with a dashboard token</span>
            <svg class={`w-3.5 h-3.5 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showAdvanced && (
            <form onSubmit={handleTokenSubmit} class="space-y-4 mt-4">
              <div>
                <label class="block text-caption text-secondary font-medium mb-1.5" for="token-input">
                  Dashboard Token
                </label>
                <div class="relative">
                  <input
                    id="token-input"
                    type={showToken ? 'text' : 'password'}
                    value={token}
                    onInput={(e) => { setToken((e.target as HTMLInputElement).value); setError(''); }}
                    placeholder="Enter your bearer token"
                    autoComplete="current-password"
                    class="w-full px-3 py-2.5 pr-10 bg-bg-elevated border border-border rounded-lg text-body-sm font-mono
                      focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none transition-colors
                      placeholder:text-muted"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-secondary"
                    aria-label={showToken ? 'Hide token' : 'Show token'}
                  >
                    {showToken ? (
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L3 3m6.878 6.878L21 21" />
                      </svg>
                    ) : (
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <div class="bg-danger/10 text-danger text-body-sm px-3 py-2.5 rounded-lg border border-danger/20">
                  {error}
                </div>
              )}

              <label class="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember((e.target as HTMLInputElement).checked)}
                  class="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                />
                <span class="text-body-sm text-secondary">Remember me</span>
              </label>

              <button
                type="submit"
                disabled={loading || !token.trim()}
                class="w-full bg-bg-elevated text-primary border border-border py-2.5 rounded-lg text-body-sm font-medium
                  hover:bg-surface transition-colors
                  disabled:opacity-50 disabled:cursor-not-allowed
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
                {loading ? (
                  <span class="inline-flex items-center gap-2">
                    <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Authenticating...
                  </span>
                ) : (
                  'Sign in with token'
                )}
              </button>
            </form>
          )}
        </div>

        <p class="text-center text-overline text-muted mt-6">
          Netzar OS Enterprise v1.0
        </p>
      </div>
    </div>
  );
}
