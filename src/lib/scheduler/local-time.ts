/**
 * Wall-clock scheduling helper. "Brief me every morning at 8" means 8am in
 * the USER's timezone — the historical failure mode was the model doing the
 * UTC conversion itself (and getting it wrong, or ignoring DST). This module
 * does the math with Intl, no dependencies.
 *
 * Note for recurring tasks: callers pair this with a fixed 86400s interval,
 * so the fire time drifts by ±1h across DST transitions until the task is
 * recreated. True cron-in-tz (EventBridge Scheduler cron expressions) is the
 * documented follow-up.
 */

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(timeZone: string, at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  // hourCycle h23 quirk: midnight can format as "24"
  const hour = get('hour') % 24;
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - at.getTime();
}

/**
 * Next occurrence of HH:mm wall-clock time in `timeZone`, as unix SECONDS.
 * If today's occurrence is already past (or within 30s), returns tomorrow's.
 * Throws on a malformed time or an unknown IANA zone.
 */
export function nextOccurrenceUtc(
  hhmm: string,
  timeZone: string,
  now: Date = new Date(),
): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) throw new Error(`invalid time "${hhmm}" — expected HH:mm (24h)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  // Validates the zone (Intl throws on unknown zones).
  new Intl.DateTimeFormat('en-US', { timeZone });

  // Today's date in the target zone.
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, mo, d] = dateFmt.format(now).split('-').map(Number);

  // Candidate instant: treat local wall-clock as UTC, then correct by the
  // zone offset AT THE CANDIDATE (two-pass handles DST boundaries).
  const naive = Date.UTC(y, mo - 1, d, hour, minute, 0);
  let candidate = naive - tzOffsetMs(timeZone, new Date(naive));
  candidate = naive - tzOffsetMs(timeZone, new Date(candidate));

  if (candidate <= now.getTime() + 30_000) {
    const nextNaive = naive + 86_400_000;
    let next = nextNaive - tzOffsetMs(timeZone, new Date(nextNaive));
    next = nextNaive - tzOffsetMs(timeZone, new Date(next));
    return Math.floor(next / 1000);
  }
  return Math.floor(candidate / 1000);
}
