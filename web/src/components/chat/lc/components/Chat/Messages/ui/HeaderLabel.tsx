/*
 * VERBATIM COPY from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/components/Chat/Messages/ui/HeaderLabel.tsx`.
 *
 * Copied byte-for-byte below this header: 81 lines, ZERO edits. Both of its
 * imports -- `useLocalize` from `~/hooks` and `cn` from `~/utils` -- resolve
 * through the ported tree, and the one i18n key it asks for
 * (`com_ui_message_model`) is in the key table.
 *
 * WIRED. This app has a fact the donor's header wants and our hand-written
 * author line was throwing away: `message.meta.modelId`, the model that
 * actually answered. The crossfade below shows the AGENT name at rest and the
 * MODEL on hover or keyboard focus, both in one grid cell so the slot is sized
 * by the longer of the two and neither reflows the header as they cross. The
 * model is additionally carried in never-hidden `sr-only` text, so a screen
 * reader that never moves the visual focus still gets it.
 */
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type HeaderLabelProps = {
  label: string;
  hoverLabel?: string | null;
};

/** Agents and assistants are keyed by document id, and a message's `model`
 *  carries that id rather than a model name, so neither prefix may reach the
 *  header. */
const DOCUMENT_ID_PREFIXES = ['agent_', 'asst_'];

/** Skip document ids so the hover label is a real model name. */
export function getHeaderModelName(
  ...candidates: Array<string | null | undefined>
): string | undefined {
  return candidates.find(
    (value): value is string =>
      value != null &&
      value !== '' &&
      !DOCUMENT_ID_PREFIXES.some((prefix) => value.startsWith(prefix)),
  );
}

/** Both names occupy one grid cell so the slot is sized by the longer of the
 *  two and neither reflows the header as they cross over.
 *
 *  Timed off the same motion role as the timestamp and the footer actions, so a
 *  keyboard focus that reveals all three lands them together instead of staggering
 *  across the card-resize spring this used to borrow. */
const labelSlot =
  '[grid-area:1/1] truncate transition-[opacity,transform,filter] duration-theme-normal ease-out motion-reduce:transition-none motion-reduce:transform-none motion-reduce:blur-none';

/** Provider name that crossfades to the model name. A pointer swaps it on the
 *  label itself; keyboard focus landing on the message row swaps it too, so a
 *  sighted keyboard user reaches the model the same way they reach the
 *  timestamp. The model is additionally carried in text that never hides, for
 *  screen readers that never move the visual focus at all.
 *
 *  The focus condition is the row-wide one documented on
 *  `revealOnRowHoverClasses` in `../styles`: the row itself or a descendant
 *  that is not a text-entry control. Both halves matter here for the same
 *  reasons they matter to the timestamp and the footer actions. */
export default function HeaderLabel({ label, hoverLabel }: HeaderLabelProps) {
  const localize = useLocalize();

  if (!hoverLabel || hoverLabel === label) {
    return <span className="min-w-0 truncate">{label}</span>;
  }

  return (
    <span className="group/label inline-grid min-w-0 max-w-full">
      <span
        className={cn(
          labelSlot,
          'group-hover/label:-translate-y-1 group-hover/label:opacity-0 group-hover/label:blur-[2px]',
          'group-focus-visible:-translate-y-1 group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]:-translate-y-1',
          'group-focus-visible:opacity-0 group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]:opacity-0',
          'group-focus-visible:blur-[2px] group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]:blur-[2px]',
        )}
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          labelSlot,
          'translate-y-1 opacity-0 blur-[2px]',
          'group-hover/label:translate-y-0 group-hover/label:opacity-100 group-hover/label:blur-0',
          'group-focus-visible:translate-y-0 group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]:translate-y-0',
          'group-focus-visible:opacity-100 group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]:opacity-100',
          'group-focus-visible:blur-0 group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]:blur-0',
        )}
      >
        {hoverLabel}
      </span>
      <span className="sr-only">{localize('com_ui_message_model', { 0: hoverLabel })}</span>
    </span>
  );
}
