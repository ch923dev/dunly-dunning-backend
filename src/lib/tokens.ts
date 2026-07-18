import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

/**
 * HMAC-signed, login-free case tokens for email footer links
 * (phase-1 spec "Email layer"). Purpose-scoped so an unsubscribe token can
 * never be replayed against the portal route. No expiry on purpose: footer
 * links must keep working for as long as the email sits in an inbox.
 *
 * The expiry-* purposes (phase 4) carry a CardExpiryCase id instead of a
 * DunningCase id — the purpose string in the HMAC keeps the namespaces
 * mutually unforgeable.
 *
 * case-resume / case-stop (phase 5) are the one-tap action links in the
 * reply-forward email — merchant-facing, but the same login-free doctrine.
 *
 * Considered and deferred (audit B3): a soft expiry or per-case nonce for
 * the destructive purposes (case-stop). Rejected for now because (a) stop
 * and resume mutate only behind an explicit confirm-page POST (audit B4),
 * (b) rate limiting bounds abuse of a leaked token, and (c) an expiring
 * link in a merchant's inbox that stops working days later is worse UX
 * than the residual risk. Revisit if tokens ever guard customer-destructive
 * actions beyond suppression.
 */
export type CaseTokenPurpose =
  | "unsubscribe"
  | "portal"
  | "expiry-unsubscribe"
  | "expiry-portal"
  | "case-resume"
  | "case-stop";

function sign(caseId: string, purpose: CaseTokenPurpose): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`case-token:${purpose}:${caseId}`)
    .digest("base64url");
}

export function makeCaseToken(caseId: string, purpose: CaseTokenPurpose): string {
  return `${Buffer.from(caseId, "utf8").toString("base64url")}.${sign(caseId, purpose)}`;
}

/** Returns the caseId, or null if the token is malformed or forged. */
export function verifyCaseToken(token: string, purpose: CaseTokenPurpose): string | null {
  const [idPart, sig] = token.split(".");
  if (!idPart || !sig) return null;
  let caseId: string;
  try {
    caseId = Buffer.from(idPart, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!caseId) return null;
  const expected = Buffer.from(sign(caseId, purpose));
  const provided = Buffer.from(sig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return caseId;
}
