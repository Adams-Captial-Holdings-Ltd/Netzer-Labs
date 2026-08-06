/**
 * Role-aware onboarding checklist. Replaces the old OnboardingWizard modal
 * (App.tsx redirects first-time sign-ins here instead of overlaying the
 * wizard). Design absorbed from PR #42's GettingStarted, with the step lists
 * rewritten for the shipped product: seat administration + usage attribution,
 * no EC2-workspace steps.
 *
 * Progress is a localStorage convenience keyed per profile+email; nothing
 * here is authoritative and the backend never sees checklist state.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Link, useLocation } from 'wouter-preact';
import { Button } from '../components/Button';
import { currentEmail, currentProfileId, hasCapability } from '../lib/auth';
import { startTour } from '../lib/tour/engine';

export const GETTING_STARTED_SEEN_KEY = 'cce_company_onboarding_seen';

interface Step {
  id: string;
  title: string;
  body: string;
  notes?: string[];
  actionLabel?: string;
  href?: string;
}

function checklistKey(profileId: string | null, email: string | null): string {
  return `cce_company_onboarding_steps:${profileId ?? 'unknown'}:${email ?? 'token'}`;
}

function readChecked(key: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeChecked(key: string, value: Record<string, boolean>) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Checklist state is a convenience only.
  }
}

function adminSteps(): Step[] {
  return [
    {
      id: 'sign-in',
      title: 'Sign in with the dashboard token',
      body: 'The bearer DASHBOARD_TOKEN from setup is the initial way in. Email sign-in (magic links) stays silently inert until CCE_EMAIL_FROM and CCE_DASHBOARD_URL are configured and a user has been invited.',
      notes: [
        'npm run doctor reports this state as the magic-link-email check.',
        'Users come from invites, not self-signup.',
      ],
    },
    {
      id: 'invite-members',
      title: 'Invite your team',
      body: 'Invite members and assign profiles. seat-user is the floor tier (own seat and usage only); org-admin manages the seat plane; admin manages everything except seats and owners.',
      actionLabel: 'Open Members',
      href: '/members',
    },
    {
      id: 'create-policy',
      title: 'Create a seat policy',
      body: 'A policy names what a seat may consume: allowed Bedrock models, allowed tools, and a monthly spend limit.',
      actionLabel: 'Open Seats',
      href: '/seats',
    },
    {
      id: 'create-seats',
      title: 'Create seats',
      body: 'Bind each member to a policy. One seat per user; creating a duplicate is refused loudly rather than silently repointed.',
      actionLabel: 'Open Seats',
      href: '/seats',
    },
    {
      id: 'verify-usage',
      title: 'Verify usage attribution',
      body: 'After a seated member runs a dashboard chat turn, confirm their usage rows appear with model, tokens, cost, and policy outcome.',
      actionLabel: 'Open Seats',
      href: '/seats',
    },
    {
      id: 'cost-cap',
      title: 'Check the daily cost cap',
      body: 'The daily Bedrock spend cap is enforced by the atomic spend ledger when armed. Review the cap and the kill switches so you know where the brakes are.',
      actionLabel: 'Open Cost',
      href: '/cost',
    },
    {
      id: 'take-tour',
      title: 'Take the guided tour',
      body: 'A deterministic walkthrough of every tab you can access, from Overview to Audit.',
    },
  ];
}

function seatSteps(): Step[] {
  return [
    {
      id: 'accept-invite',
      title: 'Accept the company invite',
      body: 'Use the invite or login magic link from your company email. The link signs you in without a password.',
    },
    {
      id: 'review-seat',
      title: 'Review your seat and limits',
      body: 'Open My Seat and check your policy: allowed models, allowed tools, and your monthly spend limit.',
      actionLabel: 'Open My Seat',
      href: '/my-seat',
    },
    {
      id: 'usage-check',
      title: 'Confirm your usage ledger',
      body: 'Run a chat turn, then confirm your usage history reflects only your own seat.',
      actionLabel: 'Open My Seat',
      href: '/my-seat',
    },
  ];
}

function StepCard({
  step,
  checked,
  onToggle,
}: {
  step: Step;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li class="bg-surface border border-border rounded-lg p-4 flex gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        aria-label={`Complete ${step.title}`}
        class="mt-1 h-4 w-4 shrink-0 rounded border-border text-primary focus:ring-primary"
      />
      <div class="min-w-0 flex-1">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <h3 class="text-body font-semibold text-primary">{step.title}</h3>
            <p class="mt-1 text-body-sm text-secondary leading-relaxed">{step.body}</p>
            {step.notes && (
              <ul class="mt-3 space-y-1.5 text-caption text-muted leading-relaxed">
                {step.notes.map((note) => (
                  <li key={note} class="flex gap-2">
                    <span class="mt-[0.45em] h-1.5 w-1.5 rounded-full bg-muted/60 shrink-0" aria-hidden="true" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {step.href && step.actionLabel && (
            <Link
              href={step.href}
              class="inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-surface px-3 py-1.5 text-caption font-medium text-primary transition-colors hover:bg-surface-hover"
            >
              {step.actionLabel}
            </Link>
          )}
        </div>
      </div>
    </li>
  );
}

export function GettingStarted() {
  const [, setLocation] = useLocation();
  const profileId = currentProfileId.value;
  const email = currentEmail.value;
  const isAdmin = hasCapability('seats:write') || hasCapability('members:write');
  const steps = useMemo(() => (isAdmin ? adminSteps() : seatSteps()), [isAdmin]);
  const storageKey = checklistKey(profileId, email);
  const [checked, setChecked] = useState<Record<string, boolean>>(() => readChecked(storageKey));
  const completed = steps.filter((step) => checked[step.id]).length;

  useEffect(() => {
    setChecked(readChecked(storageKey));
  }, [storageKey]);

  function toggle(id: string) {
    const next = { ...checked, [id]: !checked[id] };
    setChecked(next);
    writeChecked(storageKey, next);
  }

  function markSeen(destination: string) {
    localStorage.setItem(GETTING_STARTED_SEEN_KEY, 'true');
    setLocation(destination);
  }

  function takeTour() {
    localStorage.setItem(GETTING_STARTED_SEEN_KEY, 'true');
    setLocation('/');
    // Defer a tick so the Overview mounts before the overlay measures the page.
    setTimeout(() => startTour(), 100);
  }

  return (
    <div class="space-y-6 max-w-5xl">
      <section class="bg-surface border border-border rounded-lg p-5 sm:p-6">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p class="text-overline text-muted uppercase tracking-wider mb-2">
              {isAdmin ? 'Admin onboarding' : 'Getting started'}
            </p>
            <h1 class="text-heading-lg text-primary font-bold">
              {isAdmin ? 'Set up your team on ClaudeClaw' : 'Start with your seat'}
            </h1>
            <p class="mt-3 text-body text-secondary leading-relaxed max-w-3xl">
              {isAdmin
                ? 'From first sign-in through seats, policies, and verified usage attribution.'
                : 'Validate your seat, your policy limits, and your personal usage ledger.'}
            </p>
          </div>
          <div class="shrink-0 rounded-lg border border-border bg-page px-4 py-3">
            <p class="text-overline text-muted uppercase tracking-wider">Progress</p>
            <p class="mt-1 text-heading-md text-primary font-semibold">
              {completed} / {steps.length}
            </p>
          </div>
        </div>
      </section>

      <ol class="space-y-3">
        {steps.map((step) => (
          <StepCard
            key={step.id}
            step={step}
            checked={Boolean(checked[step.id])}
            onToggle={() => toggle(step.id)}
          />
        ))}
      </ol>

      <section class="bg-surface border border-border rounded-lg p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-heading-sm text-primary font-semibold">Ready to continue</h2>
          <p class="mt-1 text-body-sm text-secondary">
            Future sign-ins open the normal dashboard once you continue.
          </p>
        </div>
        <div class="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={takeTour}>
            Take the guided tour
          </Button>
          <Button variant="primary" onClick={() => markSeen('/')}>
            Open dashboard
          </Button>
        </div>
      </section>
    </div>
  );
}
