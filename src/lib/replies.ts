import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";
import { prisma } from "./prisma.js";
import { boss, QUEUES, type SendDunningEmailJob } from "./queue.js";
import { Prisma } from "../generated/prisma/client.js";

/**
 * Reply intelligence / stop-on-reply (docs/phase-5-reply-intelligence.md).
 *
 * Address codec, auto-reply filtering and the inbound email.received handler.
 * The forward delivery path lives in jobs/replies.ts (worker side), mirroring
 * the predunning.ts / jobs/expiry.ts split.
 */

/** Reserved stageOrder for REPLY_FORWARD sends (after reactivation's 100 and pre-dunning's 201/202). */
export const REPLY_FORWARD_STAGE_ORDER = 300;

/** Body cap (locked decision #4) — plain text only, hostile HTML never stored. */
const TEXT_BODY_CAP = 10_000;

// ---------------------------------------------------------------------------
// Reply address codec — reply+<caseId>.<sig>@<INBOUND_REPLY_DOMAIN>
// ---------------------------------------------------------------------------

/**
 * SMTP local parts cap at 64 chars, so this is NOT makeCaseToken (too long):
 * raw cuid + 128-bit truncated HMAC (22 base64url chars) under its own
 * purpose string keeps it unforgeable and ≤ 64 (locked decision #1).
 */
function signReplyAddress(caseId: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`reply-address:${caseId}`)
    .digest("base64url")
    .slice(0, 22);
}

/** The rerouted Reply-To, or null when the feature is not configured. */
export function makeReplyAddress(caseId: string): string | null {
  if (!env.INBOUND_REPLY_DOMAIN) return null;
  return `reply+${caseId}.${signReplyAddress(caseId)}@${env.INBOUND_REPLY_DOMAIN}`;
}

/** Returns the caseId, or null if the address is malformed, forged, or foreign. */
export function parseReplyAddress(address: string): string | null {
  if (!env.INBOUND_REPLY_DOMAIN) return null;
  const match = /^reply\+([a-z0-9]+)\.([A-Za-z0-9_-]{22})@(.+)$/i.exec(address.trim());
  if (!match) return null;
  const [, caseId, sig, domain] = match;
  if (!caseId || !sig || domain?.toLowerCase() !== env.INBOUND_REPLY_DOMAIN.toLowerCase()) {
    return null;
  }
  const expected = Buffer.from(signReplyAddress(caseId));
  const provided = Buffer.from(sig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  return caseId;
}

// ---------------------------------------------------------------------------
// Inbound payload (Resend email.received) — parsed defensively: the exact
// field names are re-verified against a live event at launch hardening
// (spec, "Launch-hardening handoff").
// ---------------------------------------------------------------------------

type InboundAddress = string | { email?: string; address?: string; name?: string };

export interface InboundEmailData {
  email_id?: string;
  from?: InboundAddress;
  to?: InboundAddress | InboundAddress[];
  subject?: string;
  text?: string;
  headers?: Array<{ name?: string; value?: string }> | Record<string, string>;
}

function addressToString(addr: InboundAddress | undefined): string | null {
  if (!addr) return null;
  if (typeof addr === "string") return addr;
  return addr.email ?? addr.address ?? null;
}

/** Pull the bare email out of forms like `Jamie Doe <jamie@acme.com>`. */
function bareEmail(value: string): string {
  const angled = /<([^>]+)>/.exec(value);
  return (angled?.[1] ?? value).trim();
}

function normalizeHeaders(headers: InboundEmailData["headers"]): Map<string, string> {
  const map = new Map<string, string>();
  if (!headers) return map;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h.name) map.set(h.name.toLowerCase(), (h.value ?? "").toLowerCase());
    }
  } else {
    for (const [name, value] of Object.entries(headers)) {
      map.set(name.toLowerCase(), String(value).toLowerCase());
    }
  }
  return map;
}

/**
 * The #1 false-positive trap (locked decision #3): out-of-office responders
 * must never pause a case. Header-based only, no content heuristics in v1.
 * Returns the tripped reason, or null for a human reply.
 */
export function detectAutoReply(
  headers: InboundEmailData["headers"],
  fromEmail: string | null,
): string | null {
  const h = normalizeHeaders(headers);
  const autoSubmitted = h.get("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") return `Auto-Submitted: ${autoSubmitted}`;
  const precedence = h.get("precedence");
  if (precedence && ["auto_reply", "bulk", "junk"].includes(precedence)) {
    return `Precedence: ${precedence}`;
  }
  if (h.has("x-autoreply")) return "X-Autoreply";
  if (h.has("x-autorespond")) return "X-Autorespond";
  if (fromEmail && /^(mailer-daemon|postmaster)@/i.test(fromEmail)) {
    return `from ${fromEmail}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inbound handler
// ---------------------------------------------------------------------------

export type InboundOutcome =
  | "ignored" // no/forged/foreign reply address — Resend must not retry junk
  | "unknown-case"
  | "duplicate"
  | "stored-auto"
  | "paused-and-forwarded"
  | "forwarded"; // human reply, but the case wasn't ACTIVE — forward only

/**
 * email.received → classify → persist → guarded pause → enqueue forward.
 * Inline in the webhook route (DB writes + one enqueue, no external calls).
 * Replay-proof via CaseReply.resendInboundId UNIQUE; a crash after the row
 * is written self-heals on redelivery (the duplicate path re-ensures the
 * forward exists).
 */
export async function handleInboundEmail(data: InboundEmailData): Promise<InboundOutcome> {
  const inboundId = data.email_id;
  if (!inboundId) return "ignored";

  const recipients = (Array.isArray(data.to) ? data.to : data.to ? [data.to] : [])
    .map(addressToString)
    .filter((a): a is string => a !== null)
    .map(bareEmail);
  const caseId = recipients.map(parseReplyAddress).find((id) => id !== null) ?? null;
  if (!caseId) return "ignored";

  const dunningCase = await prisma.dunningCase.findUnique({ where: { id: caseId } });
  if (!dunningCase) return "unknown-case";

  const fromRaw = addressToString(data.from);
  const fromEmail = fromRaw ? bareEmail(fromRaw) : null;
  const autoReason = detectAutoReply(data.headers, fromEmail);

  let reply;
  try {
    reply = await prisma.caseReply.create({
      data: {
        dunningCaseId: dunningCase.id,
        resendInboundId: inboundId,
        fromEmail,
        subject: data.subject ?? null,
        textBody: data.text ? data.text.slice(0, TEXT_BODY_CAP) : null,
        classification: autoReason ? "AUTO" : "HUMAN",
        autoReason,
      },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // Redelivery. Self-heal: a HUMAN reply that never got its forward
    // (crash between create and enqueue) gets one now.
    const existing = await prisma.caseReply.findUnique({
      where: { resendInboundId: inboundId },
      include: { forwardSend: true },
    });
    if (existing && existing.classification === "HUMAN" && !existing.forwardSend) {
      await ensureForward(existing.id);
    }
    return "duplicate";
  }

  if (reply.classification === "AUTO") {
    console.log(`[replies] auto-reply filtered for case ${dunningCase.id} (${autoReason})`);
    return "stored-auto";
  }

  // Guarded pause — pending sends are HELD, not canceled (phase-3 decision
  // #2 machinery): resume re-enqueues them. A non-ACTIVE case pauses
  // nothing but still forwards (locked decision #5).
  const { count } = await prisma.dunningCase.updateMany({
    where: { id: dunningCase.id, status: "ACTIVE" },
    data: { status: "PAUSED" },
  });
  if (count > 0) {
    await prisma.caseReply.update({ where: { id: reply.id }, data: { pausedCase: true } });
  }

  await ensureForward(reply.id);
  console.log(
    `[replies] human reply for case ${dunningCase.id} from ${fromEmail ?? "(unknown)"} — ${count > 0 ? "paused, " : ""}forward enqueued`,
  );
  return count > 0 ? "paused-and-forwarded" : "forwarded";
}

/**
 * Exactly one forward per reply, ever: EmailSend.caseReplyId UNIQUE absorbs
 * races, the send job is singletonKey'd, and Resend dedupes on the send id.
 * dunningCaseId stays null (locked decision #6) so multiple replies per case
 * never collide on the (dunningCaseId, stageOrder) unique.
 */
async function ensureForward(caseReplyId: string): Promise<void> {
  let emailSendId: string;
  try {
    const created = await prisma.emailSend.create({
      data: {
        caseReplyId,
        kind: "REPLY_FORWARD",
        stageOrder: REPLY_FORWARD_STAGE_ORDER,
        scheduledFor: new Date(),
      },
    });
    emailSendId = created.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.emailSend.findUnique({ where: { caseReplyId } });
      if (!existing || existing.status !== "SCHEDULED") return;
      emailSendId = existing.id; // self-heal a possibly lost job
    } else {
      throw err;
    }
  }

  // A dropped forward is worse than not having the feature (candidate spec):
  // more retries than a dunning send, same backoff shape.
  await boss.send(QUEUES.sendDunningEmail, { emailSendId } satisfies SendDunningEmailJob, {
    singletonKey: emailSendId,
    retryLimit: 5,
    retryDelay: 60,
    retryBackoff: true,
  });
}
