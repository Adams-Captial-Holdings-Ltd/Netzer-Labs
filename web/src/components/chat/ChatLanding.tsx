/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Landing.tsx` and
 * `client/src/components/Chat/Input/ConversationStarters.tsx`.
 *
 * What is ported: a centred mark, one large greeting naming the entity you are
 * about to talk to, and a row of starter chips — sitting directly above the
 * composer rather than in a boxed empty state.
 *
 * What is NOT ported: the donor's animated SplitText greeting (it pulls
 * @react-spring, which this port does not take as a dependency) and its
 * endpoint iconography. The subline is this product's own: an empty chat is the
 * right moment to say that every turn is metered and attributable, because
 * that is what the buyer is paying for.
 */

interface ChatLandingProps {
  /** Display name of the agent currently selected in the header. */
  agentName: string;
  /** Human label of the model in play ("Agent default" when none is pinned). */
  modelLabel: string;
  /** Drop a starter into the composer (does not send). */
  onStarter: (text: string) => void;
}

const STARTERS = [
  'What can you help me with?',
  'Which tools do you have access to?',
  'Draft a short status update for my team',
];

function ChatMark() {
  return (
    <span
      class="flex h-12 w-12 items-center justify-center rounded-xl border border-primary-a/25
        bg-primary-a/10 text-primary-a shadow-sm"
      aria-hidden="true"
    >
      <svg
        class="h-6 w-6"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    </span>
  );
}

export function ChatLanding({ agentName, modelLabel, onStarter }: ChatLandingProps) {
  return (
    // No horizontal padding of its own: the landing block IS the content
    // column (ChatCanvas already pads it), so the outer starter chips land on
    // exactly the edges the composer below and every reply above will use.
    // Even 8px here would make the empty state disagree with the full one.
    <div class="flex flex-col items-center py-8 text-center sm:py-12">
      <ChatMark />
      <h2 class="mt-5 text-display-sm font-bold tracking-tight text-primary">
        What can {agentName} do for you?
      </h2>
      <p class="mt-2 max-w-md text-body-sm text-secondary">
        Running on <span class="font-medium text-primary">{modelLabel}</span>. Every turn is
        metered and attributed — the model, latency and cost land in a footer under each reply.
      </p>
      {/* The starters are a full-width grid, not a centred pile of pills: they
          are the first thing on an empty canvas, so they are what tells the eye
          where the reading column begins and ends — the outer chips land on
          exactly the left and right edges the composer below and every reply
          above will use. One column on a phone, three side by side from `sm`. */}
      <div class="mt-7 grid w-full gap-2 sm:grid-cols-3">
        {STARTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onStarter(s)}
            class="rounded-xl border border-border bg-surface px-3.5 py-3 text-left text-body-sm
              text-secondary shadow-xs transition-colors duration-fast hover:border-border-strong
              hover:bg-surface-hover hover:text-primary focus-visible:outline-none
              focus-visible:ring-2 focus-visible:ring-primary"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
