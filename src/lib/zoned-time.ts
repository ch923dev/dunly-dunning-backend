/**
 * Calendar-boundary helpers in an IANA timezone, Intl-based like
 * lib/send-window.ts — never offset arithmetic, so DST can't drift them.
 * Used by the dashboard metrics ("this month", weekly trend buckets).
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
      hourCycle: "h23",
    });
    partsCache.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock date parts of `date` as seen in `timeZone`. */
export function wallClock(date: Date, timeZone: string) {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 1, // 1-12
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24, // h23 still yields 24 for midnight on some ICU builds
    minute: parts.minute ?? 0,
  };
}

/**
 * The instant at which `timeZone`'s clock reads Y-M-D 00:00. Two correction
 * passes converge for any fixed offset; on a DST gap where midnight doesn't
 * exist this lands at the closest existing instant — fine for report
 * boundaries.
 */
export function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  const want = Date.UTC(year, month - 1, day);
  let ts = want;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(ts), timeZone);
    const have = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    ts += want - have;
  }
  return new Date(ts);
}

/** Start of `date`'s calendar month in `timeZone`. */
export function startOfMonthInZone(date: Date, timeZone: string): Date {
  const w = wallClock(date, timeZone);
  return zonedMidnight(w.year, w.month, 1, timeZone);
}

/** Start of `date`'s calendar day in `timeZone`. */
export function startOfDayInZone(date: Date, timeZone: string): Date {
  const w = wallClock(date, timeZone);
  return zonedMidnight(w.year, w.month, w.day, timeZone);
}
