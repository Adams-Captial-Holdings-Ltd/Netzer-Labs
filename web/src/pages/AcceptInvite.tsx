import { useEffect, useState } from 'preact/hooks';
import { api, setToken } from '../lib/api';

interface AcceptInviteProps {
  // Optional: when App mounts this above the AuthGate it can pass the same
  // onLogin used by the Login page so the session is stored identically. When
  // omitted we fall back to setToken directly — the page works standalone with
  // NO prior session, which is the contract (it's reached from an email link).
  onLogin?: (token: string, remember: boolean) => void;
}

type Phase = 'loading' | 'accepting' | 'success' | 'error';

// Read ?token from the real URL. We use window.location.search rather than a
// router hook so this works before the router/session is established and
// regardless of the /dashboard base path.
function tokenFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get('token')?.trim() ?? '';
  } catch {
    return '';
  }
}

// After the session token is stored, do a full navigation to the app root so
// the AuthGate re-reads the freshly-stored bearer and renders the shell. A hard
// navigation (not a router push) guarantees the token is picked up even when
// this page renders outside the authenticated tree.
function enterApp(): void {
  window.location.replace('/dashboard/');
}

export function AcceptInvite({ onLogin }: AcceptInviteProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [inviteEmail, setInviteEmail] = useState<string | null>(null);
  const [token] = useState(tokenFromUrl);

  // Preview the invite (read-only, does NOT consume the token) so we can show
  // the invitee which address they're activating before they commit.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setPhase('error');
      setError('This invitation link is missing its token. Ask your administrator to resend the invite.');
      return;
    }
    api.auth
      .inviteInfo(token)
      .then((info) => {
        if (cancelled) return;
        setInviteEmail(info.email);
        setPhase('loading');
      })
      .catch(() => {
        if (cancelled) return;
        // Uniform failure: missing / expired / already-used all surface the same
        // way (the backend returns an identical 404, no enumeration).
        setPhase('error');
        setError('This invitation link is invalid or has expired. Ask your administrator to send a new one.');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function accept() {
    setPhase('accepting');
    setError('');
    try {
      const res = await api.auth.acceptInvite(token);
      // Store through the existing auth/onLogin flow. Invites default to a
      // persistent ("remember") session so the new member isn't logged out the
      // moment they close the tab right after activating.
      if (onLogin) onLogin(res.token, true);
      else setToken(res.token, true);
      setPhase('success');
      enterApp();
    } catch {
      setPhase('error');
      setError('We could not activate your account. The link may have just expired. Ask your administrator to resend the invite.');
    }
  }

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
          <p class="text-caption text-muted mt-1">Accept your invitation</p>
        </div>

        {phase === 'error' ? (
          <div class="space-y-4">
            <div class="bg-danger/10 text-danger text-body-sm px-3 py-2.5 rounded-lg border border-danger/20">
              {error}
            </div>
            <a
              href="/dashboard/"
              class="block text-center w-full bg-bg-elevated text-primary border border-border py-2.5 rounded-lg text-body-sm font-medium hover:bg-surface transition-colors"
            >
              Go to sign in
            </a>
          </div>
        ) : phase === 'success' ? (
          <div class="text-center space-y-2">
            <div class="w-12 h-12 bg-success/10 rounded-full flex items-center justify-center mx-auto">
              <svg class="w-6 h-6 text-success" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
            </div>
            <p class="text-body-sm text-secondary">Account activated. Taking you in...</p>
          </div>
        ) : (
          <div class="space-y-4">
            <p class="text-body-sm text-secondary text-center">
              {inviteEmail
                ? <>You're activating the account for <span class="font-medium text-primary">{inviteEmail}</span>. This is a passwordless account — accepting signs you in.</>
                : 'Validating your invitation...'}
            </p>
            <button
              type="button"
              onClick={accept}
              disabled={phase === 'accepting' || !inviteEmail}
              class="w-full bg-primary text-inverse py-2.5 rounded-lg text-body-sm font-medium
                hover:bg-primary-hover transition-colors shadow-sm
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
            >
              {phase === 'accepting' ? (
                <span class="inline-flex items-center gap-2">
                  <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Activating...
                </span>
              ) : (
                'Accept invitation & sign in'
              )}
            </button>
          </div>
        )}

        <p class="text-center text-overline text-muted mt-6">
          ClaudeClaw Enterprise v1.0
        </p>
      </div>
    </div>
  );
}
