/*
 * Adapted from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/hooks/useClockFormat.ts` (13 lines).
 *
 * The donor's reads a user SETTING ("Clock format: system / 12h / 24h") out of
 * a jotai atom and resolves it through `resolveHour12`. This product ships no
 * such setting, so the only branch that exists here is the donor's 'system'
 * one — and that branch is `localeUsesMeridiem(systemLocale())`, both of which
 * are the donor's own code, copied verbatim in ../utils/clock.ts.
 *
 * Kept as a hook rather than inlined so that adding the setting later is an
 * edit to this file and to nothing that calls it.
 */
import { localeUsesMeridiem, systemLocale } from '../utils/clock';

export default function useClockFormat(): boolean {
  return localeUsesMeridiem(systemLocale());
}
