/*
 * `useLocalize` — the donor's i18n accessor, stood in for.
 *
 * The donor's returns `react-i18next`'s `t`, over ~4,000 keys in 30 locales.
 * This product ships no localizer and no translation bundles, so a faithful
 * shim is impossible and a fake one would be worse: `t('com_ui_copy')` falling
 * through to the raw key is a UI that prints `com_ui_copy` at the user.
 *
 * So this is a KEY TABLE, holding exactly the keys the ported tree asks for,
 * with the English strings this product already uses elsewhere. A key that is
 * not in the table is a bug — it returns the key itself, which is ugly ON
 * PURPOSE, because an untranslated string that looks fine is one nobody fixes.
 *
 * Interpolation follows the donor's call shape: `localize(key, { 0: value })`
 * for a positional slot, `{ name: value }` for a named one, both written `{{0}}`
 * / `{{name}}` in the string.
 */
const STRINGS: Record<string, string> = {
  com_ui_copy_to_clipboard: 'Copy',
  com_ui_copied_to_clipboard: 'Copied',
  com_ui_message_model: 'Model: {{0}}',
  com_ui_regenerate: 'Regenerate',
  com_ui_untitled: 'Untitled',
};

export type LocalizeValues = Record<string, string | number>;

export function localize(key: string, values?: LocalizeValues): string {
  const template = STRINGS[key];
  if (template === undefined) {
    return key;
  }
  if (!values) {
    return template;
  }
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

export default function useLocalize() {
  return localize;
}
