/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Menus/Endpoints/ModelSelector.tsx` and
 * `client/src/components/Chat/Menus/Endpoints/components/EndpointItem.tsx`.
 *
 * What is ported: the donor's two-level provider→model menu. The root lists
 * groups; a group opens a submenu carrying its own search field; the current
 * model is checked on both levels; and typing at the root abandons the
 * grouping for a flat result list across every group. What is NOT ported: the
 * donor's per-provider API-key dialogs, presets, marketplace and icons — the
 * groups here are Bedrock model FAMILIES, which the /models payload already
 * names, not third-party endpoints this product would have to configure.
 *
 * ── "Agent default" is a policy; the default MODEL is a pin ────────────────
 *
 * `modelId === ''` sends NO `modelOverride` with the turn, so the agent answers
 * on the model its own configuration names — which an administrator can change
 * later, on the agent, without touching this conversation. Picking the model
 * that happens to BE today's default does something different: it pins every
 * subsequent turn of this chat to that exact id, and it keeps pinning it after
 * the default moves.
 *
 * Those two produce identical output today and diverge the moment someone
 * re-points an agent, so the difference cannot be left implicit — and it cannot
 * be left DISCOVERABLE-IF-YOU-DRILL either, which is how the first cut failed.
 * That cut did put a "Default" pill on the default model's row, but the row
 * lived inside a family submenu: the root panel offered "Agent default" beside
 * three unmarked family names, so at the moment of choosing, the marker was on
 * a row nobody had opened yet. A distinction only visible after two clicks into
 * the correct family is not visible.
 *
 * So the default model is now hoisted to the ROOT, one row under the policy it
 * is confusable with, and the two are separated four ways at that spot:
 *
 *   · their own group headings — "Model policy" vs "Pin today's default";
 *   · their badges — "No override" vs "Platform default";
 *   · their descriptions, which state the consequence rather than the fact:
 *     "the agent's own model answers (today X)" vs "stays on it even after the
 *     platform default moves";
 *   · and the check, which sits on exactly one of them.
 *
 * The same "Platform default" badge then rides that model everywhere else it
 * can appear — its family's branch row at the root, its row inside the family
 * submenu, and its row in a cross-family search result — so no path through
 * this menu reaches the default model without seeing it named as such.
 *
 * The trigger distinguishes the two states at rest too, without spending the
 * header width a second line of text would cost: a CPU glyph for the policy, a
 * PIN glyph for a pinned id.
 *
 * ── Grouping by family ─────────────────────────────────────────────────────
 *
 * `family` is a field on the /models payload, not something derived here, so a
 * catalog that grows past today's three families groups itself. The group
 * order follows first appearance in the payload (the deploy-time env order),
 * so the menu does not reshuffle between deployments for cosmetic reasons.
 */
import { Cpu, Pin } from 'lucide-preact';
import type { Model } from '../../lib/chat/types';
import { modelOptionLabel } from '../../lib/chat/helpers';
import { CommandMenu } from './CommandMenu';
import type { MenuPanel, MenuRow } from './CommandMenu';

interface ModelMenuProps {
  models: Model[];
  /** '' means "no modelOverride" — see the header comment. */
  modelId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}

/** Row key for the no-override choice. Never a real model id. */
const AGENT_DEFAULT_KEY = '__agent-default__';
/** Root shortcut to the platform default. Distinct key: the same model also
 *  appears inside its family submenu, and the two rows must not collide. */
const PINNED_DEFAULT_KEY = '__pin-default__';

/** The words that mark the default model itself, wherever its row appears. */
const DEFAULT_BADGE = 'Platform default';
/** The same fact on a FAMILY row, where "platform default" would misread as
 *  "this family is the default" rather than "the default lives in here". */
const FAMILY_BADGE = 'Has default';
/** The words that mark the no-override policy. */
const POLICY_BADGE = 'No override';

/** "sonnet" → "Sonnet". Generic on purpose: the catalog names its own families. */
function familyLabel(family: string): string {
  if (family === '') return 'Other';
  return family.charAt(0).toUpperCase() + family.slice(1);
}

/** Families in payload order, each with its models. */
function byFamily(models: Model[]): Array<{ family: string; models: Model[] }> {
  const out: Array<{ family: string; models: Model[] }> = [];
  for (const m of models) {
    const key = m.family ?? '';
    const bucket = out.find((g) => g.family === key);
    if (bucket) bucket.models.push(m);
    else out.push({ family: key, models: [m] });
  }
  return out;
}

/**
 * True when `q` is someone reaching for the DEFAULT rather than for a model
 * name. Both directions are tested so a half-typed "def" hits and a longer
 * "platform default" hits too.
 */
function meansDefault(q: string): boolean {
  const needle = q.toLowerCase();
  return ['default', 'platform default', 'agent default'].some(
    (t) => t.includes(needle) || needle.includes(t),
  );
}

function matches(m: Model, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  // A search for "default" must return the model that IS the default — its
  // label, id and family never contain the word, so without this the one row
  // the reader was looking for is the one row the search hides.
  if (m.isDefault && meansDefault(needle)) return true;
  return (
    modelOptionLabel(m).toLowerCase().includes(needle) ||
    m.id.toLowerCase().includes(needle) ||
    m.family.toLowerCase().includes(needle) ||
    m.label.toLowerCase().includes(needle)
  );
}

/** The no-override row answers to the words people actually type for it. */
function defaultRowMatches(q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  return ['agent default', 'default', 'agent', 'none', 'no override', 'override', 'auto'].some(
    (t) => t.includes(needle) || needle.includes(t),
  );
}

export function ModelMenu({ models, modelId, onSelect, disabled = false }: ModelMenuProps) {
  const active = models.find((m) => m.id === modelId);
  const platformDefault = models.find((m) => m.isDefault);
  const groups = byFamily(models);

  const defaultRow = (): MenuRow => ({
    type: 'option',
    key: AGENT_DEFAULT_KEY,
    label: 'Agent default',
    badge: POLICY_BADGE,
    // Wrapped, not truncated: this sentence and the one on the row below it are
    // the entire difference between the two choices, and at one line both were
    // being cut off before they got to it.
    wrapDescription: true,
    description:
      platformDefault !== undefined
        ? `No override sent — the agent's own model answers (today ${modelOptionLabel(platformDefault)})`
        : 'No override sent — the agent answers on its own configured model',
    selected: modelId === '',
    onSelect: () => onSelect(''),
  });

  /** The platform default, hoisted to the root as its own pinnable row. */
  const pinnedDefaultRow = (m: Model): MenuRow => ({
    type: 'option',
    key: PINNED_DEFAULT_KEY,
    label: modelOptionLabel(m),
    badge: DEFAULT_BADGE,
    // No family hint: the label already opens with the family name, and the
    // badge needs the width more than a second copy of it does.
    wrapDescription: true,
    description: 'Pins this exact model — stays on it even after the platform default moves',
    selected: m.id === modelId,
    onSelect: () => onSelect(m.id),
  });

  function modelRow(m: Model, withFamilyHint: boolean): MenuRow {
    return {
      type: 'option',
      key: m.id,
      label: modelOptionLabel(m),
      description: m.id,
      ...(m.isDefault ? { badge: DEFAULT_BADGE } : {}),
      ...(withFamilyHint ? { hint: familyLabel(m.family) } : {}),
      selected: m.id === modelId,
      onSelect: () => onSelect(m.id),
    };
  }

  function panel(query: string): MenuPanel {
    const q = query.trim();

    // Typing abandons the grouping and searches every family at once — the
    // donor's `searchResults ? renderSearchResults(...) : <groups>` branch.
    if (q !== '') {
      const hits = models.filter((m) => matches(m, q));
      const rows: MenuRow[] = [];
      if (defaultRowMatches(q)) {
        rows.push({ type: 'group', key: 'policy', label: 'Model policy' });
        rows.push(defaultRow());
      }
      rows.push({
        type: 'group',
        key: 'hits',
        label: `${hits.length} of ${models.length} ${models.length === 1 ? 'model' : 'models'} match`,
      });
      // Each hit keeps its "Platform default" badge here (modelRow adds it), so
      // the flat search path marks the default exactly like the other two do.
      for (const m of hits) rows.push(modelRow(m, true));
      return {
        searchLabel: 'Search models…',
        listLabel: 'Models',
        rows,
        emptyLabel: `No model matches “${q}”.`,
      };
    }

    const rows: MenuRow[] = [
      { type: 'group', key: 'policy', label: 'Model policy' },
      defaultRow(),
    ];
    // The default model sits directly under the policy it is confusable with,
    // which is the only place the two can actually be compared.
    if (platformDefault !== undefined) {
      rows.push({ type: 'group', key: 'pin-default', label: "Pin today's default" });
      rows.push(pinnedDefaultRow(platformDefault));
    }
    if (groups.length > 0) {
      rows.push({ type: 'group', key: 'families', label: 'Pin by family' });
      for (const g of groups) {
        const holdsDefault = g.models.some((m) => m.isDefault);
        rows.push({
          type: 'branch',
          key: g.family,
          label: familyLabel(g.family),
          ...(holdsDefault ? { badge: FAMILY_BADGE } : {}),
          description: g.models.map((m) => modelOptionLabel(m)).join(' · '),
          selected: modelId !== '' && g.models.some((m) => m.id === modelId),
        });
      }
    }
    return {
      searchLabel: 'Search models…',
      listLabel: 'Models',
      rows,
      emptyLabel: 'No models are configured for this deployment.',
    };
  }

  function branchPanel(family: string, query: string): MenuPanel {
    const q = query.trim();
    const all = groups.find((g) => g.family === family)?.models ?? [];
    const hits = all.filter((m) => matches(m, q));
    const name = familyLabel(family);
    return {
      title: `${name} · ${all.length} ${all.length === 1 ? 'model' : 'models'}`,
      searchLabel: `Search ${name} models…`,
      listLabel: `${name} models`,
      rows: hits.map((m) => modelRow(m, false)),
      emptyLabel: `No ${name} model matches “${q}”.`,
    };
  }

  const pinned = modelId !== '';
  const label = pinned ? (active ? modelOptionLabel(active) : modelId) : 'Agent default';

  return (
    <CommandMenu
      menuName="model"
      triggerLabel={label}
      triggerAriaLabel={
        pinned
          ? `Model: pinned to ${label}`
          : 'Model: agent default, no override sent'
      }
      triggerTitle={
        pinned
          ? `Pinned to ${modelId} — this chat stays on this exact model`
          : 'Agent default — no model override is sent with the turn'
      }
      // Cpu = "whatever the agent is configured for"; Pin = "this chat is
      // pinned to one id". The state is legible on the closed control.
      triggerIcon={pinned ? <Pin size={14} /> : <Cpu size={14} />}
      // `w-full` below `sm` is what lets this trigger fill the mobile bar's
      // flexible slot: a button sized to its own content ignores that slot and
      // overruns it (measured at 375: the label ran under the next control
      // instead of truncating, and the chevron was pushed off the button).
      // As of round 6 the slot is a COLUMN below `sm` (ChatHeader), so `w-full`
      // is the whole 171px rather than half of it, and `max-w-[11rem]` (176px)
      // is a cap the slot never reaches there. From `sm` up the row has room
      // again and the trigger sizes to its label, capped exactly as before.
      // `max-sm:rounded-t-none` is the BOTTOM half of the stacked readout below
      // `sm` (ChatHeader): its top border is the hairline shared with the agent
      // trigger above it. Above `sm` the two are side by side again and both
      // keep all four corners.
      triggerClass="w-full max-w-[11rem] max-sm:rounded-t-none sm:w-auto lg:max-w-[15rem]"
      disabled={disabled}
      panel={panel}
      branchPanel={branchPanel}
    />
  );
}
