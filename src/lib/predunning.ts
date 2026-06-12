/**
 * Pre-dunning (card-expiry prevention) constants — phase-4 spec §decisions
 * 4, 7. Like reactivation, the two touches are built-in constants in v1, not
 * campaign steps: reserved stage orders keep the EmailSend
 * "never the same touch twice per case" constraint authoritative.
 *
 * Framing rule locked from the product plan §5.3: service-continuity
 * language ("keep your access running"), NEVER charge-reminder language
 * ("you will be billed").
 */

export const EXPIRY_TOUCH_1_STAGE_ORDER = 201;
export const EXPIRY_TOUCH_2_STAGE_ORDER = 202;

export const EXPIRY_TOUCH_1_TEMPLATE_KEY = "card-expiry-1";
export const EXPIRY_TOUCH_2_TEMPLATE_KEY = "card-expiry-2";

export const EXPIRY_TOUCH_1_SUBJECT =
  "Your card on file expires soon — keep {{company_name}} running";
export const EXPIRY_TOUCH_2_SUBJECT =
  "Last call: your card ending {{card_last4}} expires this month";

/** Scan opens a case once the end of the expiry month is this close. */
export const EXPIRY_SCAN_HORIZON_DAYS = 35;
/** Touch send moments, measured back from the end of the expiry month. */
export const EXPIRY_TOUCH_1_LEAD_DAYS = 21;
export const EXPIRY_TOUCH_2_LEAD_DAYS = 7;
/**
 * A card first seen with less than this many days left skips touch 1
 * (visible CANCELED row) — never two near-identical emails 48h apart
 * (locked decision #4).
 */
export const EXPIRY_TOUCH_1_MIN_LEAD_DAYS = 14;
/** Touches send at this hour of the workspace's day (lib/zoned-time.ts). */
export const EXPIRY_SEND_HOUR = 10;

/** Last moment of the card's expiry month (UTC) — "when the card dies". */
export function expiryMoment(expYear: number, expMonth: number): Date {
  // Day 1 of the FOLLOWING month, 00:00 UTC: Date.UTC normalizes month 12+.
  return new Date(Date.UTC(expYear, expMonth, 1));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** (2026, 6) → "June 2026" — the card_expiry merge var / template prop. */
export function formatCardExpiry(expYear: number, expMonth: number): string {
  return `${MONTHS[expMonth - 1] ?? expMonth} ${expYear}`;
}

const CARD_BRANDS: Record<string, string> = {
  amex: "American Express",
  diners: "Diners Club",
  discover: "Discover",
  eftpos_au: "eftpos",
  jcb: "JCB",
  mastercard: "Mastercard",
  unionpay: "UnionPay",
  visa: "Visa",
};

/** Stripe brand slug → display name ("visa" → "Visa"). */
export function formatCardBrand(brand: string | null): string | null {
  if (!brand) return null;
  return CARD_BRANDS[brand] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}
