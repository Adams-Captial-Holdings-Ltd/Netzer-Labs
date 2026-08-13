import { useEffect, useState } from 'preact/hooks';
import { api, setToken } from '../lib/api';

interface VerifyLoginProps {
  // Optional: when App mounts this above the AuthGate it can pass the same
  // onLogin used by the Login page so the session is stored identically. When
  // omitted we fall back to setToken directly — the page works standalone with
  // NO prior session (it's reached from an emailed sign-in link).
  onLogin?: (token: string, remember: boolean) => void;
}

type Phase = 'verifying' | 'success' | 'error';

// Read ?token from the real URL (works before the router/session exists and
// regardless of the /dashboard base path).
function tokenFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('token')?.trim() ?? '';
  } catch {
    return '';
  }
}

// Full navigation to the app root so AuthGate re-reads the stored bearer.
function enterApp(): void {
  window.location.replace('/dashboard/');
}

export function VerifyLogin({ onLogin }: VerifyLoginProps) {
  const [phase, setPhase] = useState<Phase>('verifying');
  const [error, setError] = useState('');

  // Login links are single-use and short-lived (15m): consume immediately on
  // mount. No confirm step — the user already proved intent by clicking the
  // link in their inbox.
  useEffect(() => {
    let cancelled = false;
    const token = tokenFromUrl();
    if (!token) {
      setPhase('error');
      setError('This sign-in link is missing its token. Request a new link from the sign-in page.');
      return;
    }
    api.auth
      .verify(token)
      .then((res) => {
        if (cancelled) return;
        // Magic-link logins are interactive on a shared device; default to a
        // session-scoped (non-persistent) token so closing the browser ends the
        // session, matching the "remember me" default of the token form.
        if (onLogin) onLogin(res.token, false);
        else setToken(res.token, false);
        setPhase('success');
        enterApp();
      })
      .catch(() => {
        if (cancelled) return;
        // Uniform failure: missing / expired / already-used all look the same.
        setPhase('error');
        setError('This sign-in link is invalid, expired, or already used. Request a new one from the sign-in page.');
      });
    return () => {
      cancelled = true;
    };
  }, [onLogin]);

  return (
    <div class="min-h-screen flex items-center justify-center bg-page p-4">
      <div class="absolute inset-0 overflow-hidden pointer-events-none">
        <div class="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-3xl" />
        <div class="absolute bottom-1/4 right-1/4 w-96 h-96 bg-pink-500/5 rounded-full blur-3xl" />
      </div>

      <div class="relative bg-surface border border-border rounded-2xl shadow-xl p-8 w-full max-w-sm">
        <div class="text-center mb-6">
          <div class="w-12 h-12 bg-gradient-to-br from-claw-500 to-purple-600 rounded-xl flex items-center justify-center mb-3 mx-auto">
            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
          </div>
          <h1 class="text-display-sm text-primary font-bold">ClaudeClaw</h1>
          <p class="text-caption text-muted mt-1">Signing you in</p>
        </div>

        {phase === 'error' ? (
          <div class="space-y-4">
            <div class="bg-danger/10 text-danger text-body-sm px-3 py-2.5 rounded-lg border border-danger/20">
              {error}
            </div>
            <a
              href="/dashboard/"
              class="block text-center w-full bg-primary text-inverse py-2.5 rounded-lg text-body-sm font-medium hover:bg-primary-hover transition-colors shadow-sm"
            >
              Back to sign in
            </a>
          </div>
        ) : phase === 'success' ? (
          <div class="text-center space-y-2">
            <div class="w-12 h-12 bg-success/10 rounded-full flex items-center justify-center mx-auto">
              <svg class="w-6 h-6 text-success" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            </div>
            <p class="text-body-sm text-secondary">Signed in. Taking you in...</p>
          </div>
        ) : (
          <div class="text-center space-y-3 py-2">
            <svg class="animate-spin h-6 w-6 mx-auto text-primary" viewBox="0 0 24 24" fill="none">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p class="text-body-sm text-secondary">Verifying your sign-in link...</p>
          </div>
        )}

        <p class="text-center text-overline text-muted mt-6">
          Netzar OS Enterprise v1.0
        </p>
      </div>
    </div>
  );
}
