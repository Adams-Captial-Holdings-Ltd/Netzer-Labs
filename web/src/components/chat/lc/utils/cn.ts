/*
 * `cn` — the class-name joiner every donor file imports from `~/utils`.
 *
 * The donor's is `twMerge(clsx(inputs))`: 11 lines over two dependencies
 * (`clsx` ~0.5 kB gzip, `tailwind-merge` ~7 kB). Neither is installed here, and
 * the chat chunk carries a gzip budget that already cost us the donor's
 * markdown parser (111 kB vs 12.87 kB shipping), so this is the join without
 * the merge.
 *
 * ── The one behavioural difference, stated plainly ─────────────────────────
 *
 * `twMerge` resolves CONFLICTS: `cn('px-4', 'px-2')` yields `px-2` because the
 * later class wins. This does not — it emits both, and the cascade decides,
 * which for two utilities of equal specificity means whichever Tailwind wrote
 * later in the stylesheet, not whichever the caller wrote later in the call.
 *
 * That difference is invisible in every ported file here, because none of them
 * passes a `className` that contradicts a class the component already sets. It
 * would stop being invisible the moment one does, so: when overriding a donor
 * component's own utility from a caller, change the donor line instead of
 * layering a second value on top of it, or this function will silently keep
 * both.
 */
export type ClassValue = string | number | null | undefined | false;

export function cn(...inputs: ClassValue[]): string {
  let out = '';
  for (const value of inputs) {
    if (!value && value !== 0) continue;
    out = out ? `${out} ${value}` : String(value);
  }
  return out;
}

export default cn;
