/*
 * VERBATIM COPY from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/utils/clock.ts`, lines 4-52.
 *
 * 49 lines, byte-for-byte, no edits. Lines 1-3 are two type imports from the
 * donor's settings store, which nothing below uses. Lines 54+ are
 * `resolveHour12` (it takes the donor's `ClockFormatPreference` union -- there
 * is no clock-format SETTING in this product, so ../hooks/useClockFormat.ts
 * resolves the 'system' branch directly) and the week-start machinery, which
 * nothing here uses.
 *
 * The two functions below are why this file is worth taking rather than
 * writing. `systemLocale` reads the RUNTIME locale rather than a translation
 * bundle -- the comment it carries is the reason, and it is the same reason
 * MessageTimestamp.tsx now asks this instead of `i18n.language`. Both answers
 * are cached, because every rendered message timestamp asks, and an uncached
 * answer builds a fresh Intl formatter per row.
 */
/**
 * The locale "System" means: the runtime's own, NOT the app's translation locale.
 * `i18n.language` is normalized down to a translation bundle (`en-GB` and `en-AU`
 * both become `en`, `fr-CA` becomes `fr`), which drops exactly the regional part
 * these two settings read, and would tell a British user their clock is 12-hour.
 * Returns undefined when the runtime cannot say, which every caller below already
 * treats as "let Intl pick its own default": the same answer by a shorter route.
 */
let cachedSystemLocale: string | undefined;
let systemLocaleResolved = false;

export const systemLocale = (): string | undefined => {
  // Resolved once: the runtime locale cannot change without a reload, and every
  // message timestamp mounts a hook that asks, so an uncached answer builds a
  // formatter per rendered message.
  if (systemLocaleResolved) {
    return cachedSystemLocale;
  }
  systemLocaleResolved = true;
  try {
    cachedSystemLocale = new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    cachedSystemLocale = globalThis.navigator?.language;
  }
  return cachedSystemLocale;
};

/** Whether a locale shows a meridiem, which is what "System" resolves to. Asked of
 *  `Intl` rather than kept as a region list, because that is the same question every
 *  date this app formats already answers for itself. Defaults to a 12-hour clock when
 *  the runtime cannot say, matching `Intl`'s own behaviour for an unknown locale. */
const meridiemCache = new Map<string, boolean>();

export const localeUsesMeridiem = (locale?: string): boolean => {
  const cacheKey = locale ?? '';
  const cached = meridiemCache.get(cacheKey);
  if (cached != null) {
    return cached;
  }
  let usesMeridiem = true;
  try {
    usesMeridiem =
      new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === true;
  } catch {
    usesMeridiem = true;
  }
  meridiemCache.set(cacheKey, usesMeridiem);
  return usesMeridiem;
};
