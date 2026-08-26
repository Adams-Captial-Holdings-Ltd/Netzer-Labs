/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/components/Chat/Menus/Endpoints/components/EndpointItem.tsx`
 * (its searchable, checked, single-level model list).
 *
 * What is ported: a searchable list of things you can be, rendered as rows
 * with a check on the current one. What is NOT ported: the donor's per-row
 * settings buttons, marketplace entry, virtualisation and icons — this list is
 * agents, not endpoints, and it carries the two facts that matter here.
 *
 * ── Why this is a searchable menu and not a <select> ───────────────────────
 *
 * The platform ships seventeen agent templates and a deployment stands up its
 * own on top of them, so the realistic length of this list is "more than fits
 * on screen". A native select at that length is a scroll-and-squint exercise,
 * and it can show exactly one line per row — which forces a choice between
 * showing the agent's NAME and showing what the agent IS. This menu shows
 * both, plus the agent id, because the id is the key the transcript, the cost
 * ledger and the audit rows are filed under: it is the value an operator
 * quotes in a ticket, so it belongs in the picker rather than only in a
 * support tool.
 *
 * Search matches the display name, the description AND the id, so both ways a
 * person refers to an agent get them to it.
 *
 * ── Only active agents ─────────────────────────────────────────────────────
 *
 * Filtering to `status === 'active'` is NOT done here. Chat.tsx does it once,
 * on load, and also uses that filtered list to pick the default agent — the
 * two must not disagree, or the picker offers an agent the page will not route
 * to (a documented bug fix that this component must not re-open).
 */
import { Bot } from 'lucide-preact';
import type { Agent } from '../../lib/chat/types';
import { CommandMenu } from './CommandMenu';
import type { MenuPanel, MenuRow } from './CommandMenu';

interface AgentMenuProps {
  /** Already filtered to status === 'active' by Chat.tsx. */
  agents: Agent[];
  agentId: string;
  onSelect: (id: string) => void;
  /** A turn in flight pins the agent — switching mid-stream would orphan it. */
  disabled?: boolean;
}

function matches(a: Agent, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return (
    a.displayName.toLowerCase().includes(needle) ||
    a.id.toLowerCase().includes(needle) ||
    (a.description ?? '').toLowerCase().includes(needle)
  );
}

export function AgentMenu({ agents, agentId, onSelect, disabled = false }: AgentMenuProps) {
  const selected = agents.find((a) => a.id === agentId);

  function panel(query: string): MenuPanel {
    const q = query.trim();
    const hits = agents.filter((a) => matches(a, q));
    const rows: MenuRow[] = [
      {
        type: 'group',
        key: 'agents',
        label:
          q === ''
            ? `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`
            : `${hits.length} of ${agents.length} match`,
      },
      ...hits.map(
        (a): MenuRow => ({
          type: 'option',
          key: a.id,
          label: a.displayName,
          hint: a.id,
          description: a.description,
          selected: a.id === agentId,
          onSelect: () => onSelect(a.id),
        }),
      ),
    ];
    return {
      searchLabel: 'Search agents…',
      listLabel: 'Agents',
      rows,
      emptyLabel: q === '' ? 'No active agents.' : `No agent matches “${q}”.`,
    };
  }

  return (
    <CommandMenu
      menuName="agent"
      // "Select..." is deliberate for the pre-load frame: it is the string the
      // capture harness waits to STOP seeing before it shoots the header, so a
      // friendlier placeholder here would make that wait pass against an empty
      // roster. It is on screen only until /agents resolves.
      triggerLabel={selected?.displayName ?? 'Select...'}
      triggerAriaLabel={`Agent: ${selected?.displayName ?? 'none selected'}`}
      triggerTitle={
        selected ? `${selected.displayName} (${selected.id})` : 'Choose which agent answers'
      }
      triggerIcon={<Bot size={14} />}
      triggerClass="max-w-[11rem] lg:max-w-[15rem]"
      disabled={disabled}
      panel={panel}
    />
  );
}
