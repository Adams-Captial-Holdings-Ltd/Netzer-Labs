import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type PostureCard, type PostureResponse } from '../lib/api';
import { Badge } from '../components/Badge';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { DataMeta } from '../components/DataMeta';
import { IamCopilot } from '../components/IamCopilot';
import { InfoTooltip } from '../components/InfoTooltip';
import { hasCapability } from '../lib/auth';

// The four read-only posture tabs. Each maps to a GET /api/posture/* endpoint
// that returns { cards: PostureCard[] } with an identical shape, so they all
// render through the same card list below.
type TabId = 'network' | 'security' | 'iam' | 'observability';

interface TabDef {
  id: TabId;
  label: string;
  fetch: (signal?: AbortSignal) => Promise<PostureResponse>;
}

const TABS: TabDef[] = [
  { id: 'network', label: 'Network & WAF', fetch: (s) => api.posture.network(s) },
  { id: 'security', label: 'Encryption & Secrets', fetch: (s) => api.posture.security(s) },
  { id: 'iam', label: 'IAM', fetch: (s) => api.posture.iam(s) },
  { id: 'observability', label: 'Observability', fetch: (s) => api.posture.observability(s) },
];

// Map a posture status to its dot color and a matching badge variant. 'unknown'
// is a grey/neutral signal: the backend could not determine the state (for
// example a describe call was denied) and degraded gracefully.
const DOT_COLOR: Record<PostureCard['status'], string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  crit: 'bg-danger',
  unknown: 'bg-gray-300 dark:bg-gray-600',
};

const BADGE_VARIANT: Record<PostureCard['status'], 'success' | 'warning' | 'danger' | 'muted'> = {
  ok: 'success',
  warn: 'warning',
  crit: 'danger',
  unknown: 'muted',
};

const STATUS_LABEL: Record<PostureCard['status'], string> = {
  ok: 'OK',
  warn: 'Warn',
  crit: 'Critical',
  unknown: 'Unknown',
};

// Acronyms a non-technical reader will not know, matched against a card's
// backend-driven label. The first card whose label mentions a term gets a help
// tooltip next to it (tracked by the caller via `tipTerm`), so the explanation
// appears once rather than on every occurrence.
const POSTURE_JARGON: { term: string; test: RegExp }[] = [
  { term: 'pitr', test: /\bPITR\b/i },
  { term: 'waf', test: /\bWAF\b/i },
  { term: 'cmk', test: /\bCMK\b/i },
];

/** The first un-seen jargon term mentioned in a label, marking it seen. */
function jargonTermFor(label: string, seen: Set<string>): string | undefined {
  for (const j of POSTURE_JARGON) {
    if (!seen.has(j.term) && j.test.test(label)) {
      seen.add(j.term);
      return j.term;
    }
  }
  return undefined;
}

function PostureCardRow({ card, tipTerm }: { card: PostureCard; tipTerm?: string }) {
  return (
    <div class="bg-surface border border-border rounded-xl p-4 flex items-start gap-3">
      <span class={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT_COLOR[card.status]}`} aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-body-sm text-primary font-medium inline-flex items-center gap-1">
            {card.label}
            {tipTerm && <InfoTooltip term={tipTerm} />}
          </span>
          <Badge variant={BADGE_VARIANT[card.status]}>{STATUS_LABEL[card.status]}</Badge>
          {card.value && (
            <span class="text-caption font-mono text-secondary truncate">{card.value}</span>
          )}
        </div>
        <p class="text-caption text-muted mt-1">{card.detail}</p>
      </div>
    </div>
  );
}

function TabPanel({ tab }: { tab: TabDef }) {
  const [cards, setCards] = useState<PostureCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Freshness stamp for the posture cards, which read from live describe APIs and
  // can be up to ~45s stale. Set on each successful load so a reader can tell how
  // current the posture is and refresh on demand (no auto-refresh here).
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback((signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    tab.fetch(signal)
      .then((d) => { setCards(d.cards ?? []); setUpdatedAt(Date.now()); })
      .catch((err) => {
        if (signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load posture');
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
  }, [tab.id]);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  if (loading) {
    return (
      <div class="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} height="64px" width="100%" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div class="bg-surface border border-border rounded-xl p-5">
        <div class="flex items-center gap-2 mb-1">
          <span class="h-2.5 w-2.5 rounded-full bg-danger" aria-hidden="true" />
          <span class="text-body-sm text-primary font-medium">Could not load posture</span>
        </div>
        <p class="text-caption text-muted">{error}</p>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <EmptyState
        title="No posture checks reported"
        description="This area returned no status cards. The backend may not have any resources to inspect yet."
      />
    );
  }

  // Track which jargon acronyms have already been explained so the tooltip
  // attaches only to the FIRST card that mentions each term, not every one.
  const seenJargon = new Set<string>();
  return (
    <div class="space-y-3">
      <div class="flex justify-end">
        <DataMeta
          updatedAt={updatedAt ?? undefined}
          onRefresh={() => { const ac = new AbortController(); load(ac.signal); }}
        />
      </div>
      {cards.map((card) => (
        <PostureCardRow key={card.id} card={card} tipTerm={jargonTermFor(card.label, seenJargon)} />
      ))}
    </div>
  );
}

export function SecurityPosture() {
  const [active, setActive] = useState<TabId>('network');
  const activeTab = TABS.find((t) => t.id === active) ?? TABS[0];

  return (
    <div>
      <div class="mb-6">
        <h1 data-tour="posture-title" class="text-display-sm text-primary font-bold">Security Posture</h1>
        <p class="text-body-sm text-secondary mt-1">
          Read-only view of AWS network, encryption, IAM, and observability posture.
          Cards refresh from live describe APIs and degrade to grey when a check cannot be read.
        </p>
      </div>

      <div data-tour="posture-tabs" class="border-b border-border mb-6" role="tablist" aria-label="Security posture areas">
        <div class="flex gap-1 -mb-px overflow-x-auto">
          {TABS.map((tab) => {
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => setActive(tab.id)}
                class={`px-4 py-2.5 text-body-sm font-medium border-b-2 transition-colors duration-fast whitespace-nowrap
                  ${isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-secondary hover:text-primary'}`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <section data-tour="posture-cards" role="tabpanel" aria-label={activeTab.label}>
        <TabPanel tab={activeTab} />
        {/* The IAM copilot drafts AND can apply IAM policies + arms the
            iam/apply_enabled config — a security mutation. Old gate was admin;
            security:write is admin/owner-only, so the same principals pass
            (equivalent, never wider). The backend re-checks every apply. */}
        {active === 'iam' && hasCapability('security:write') && <IamCopilot />}
      </section>
    </div>
  );
}
