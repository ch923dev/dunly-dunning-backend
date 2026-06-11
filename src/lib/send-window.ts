/**
 * Send-window math (phase-2 spec, locked decision #3): windows are
 * hour-of-day ranges in the WORKSPACE timezone. start > end means an
 * overnight window (e.g. 22–6). All checks re-derive the zone hour via Intl
 * per instant — no offset arithmetic, so DST transitions can't drift us.
 */

/** Hour-of-day (0–23) of `date` in IANA `timeZone`. */
export function hourInZone(date: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
      hourCycle: "h23",
    }).format(date),
  );
}

/** Is `hour` inside [start, end)? Overnight windows wrap midnight. */
export function isInWindow(hour: number, start: number, end: number): boolean {
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Earliest instant ≥ `date` whose zone-hour falls inside the window.
 * In-window dates pass through untouched; outside ones advance to the next
 * top-of-hour that lands in the window (≤ 25 hour-steps covers any window
 * plus a DST jump).
 */
export function clampToWindow(date: Date, timeZone: string, start: number, end: number): Date {
  if (isInWindow(hourInZone(date, timeZone), start, end)) return date;
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  for (let i = 0; i < 26; i++) {
    d.setTime(d.getTime() + 3_600_000);
    if (isInWindow(hourInZone(d, timeZone), start, end)) return d;
  }
  return date; // unreachable: every 26h span contains any non-empty window
}
