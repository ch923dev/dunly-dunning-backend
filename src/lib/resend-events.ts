import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "./prisma.js";

/**
 * Resend event webhooks (phase-1 spec "Email layer"). Resend signs with
 * Svix; verification is implemented directly (no SDK needed): the signed
 * content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the
 * base64-decoded secret (after the whsec_ prefix), compared against the
 * space-delimited `v1,<base64>` entries in the svix-signature header.
 */
export function verifySvixSignature(opts: {
  id: string;
  timestamp: string;
  signature: string;
  payload: string;
  secret: string;
  toleranceSeconds?: number;
}): boolean {
  // Defense in depth (audit B19): an empty secret would HMAC over an empty
  // key and "verify" anything. The route already 503s when unconfigured.
  if (!opts.secret) return false;
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts)) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > tolerance) return false;

  const secretBytes = Buffer.from(opts.secret.replace(/^whsec_/, ""), "base64");
  const expected = Buffer.from(
    createHmac("sha256", secretBytes)
      .update(`${opts.id}.${opts.timestamp}.${opts.payload}`)
      .digest("base64"),
  );

  return opts.signature.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) return false;
    const provided = Buffer.from(sig);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
}

export interface ResendWebhookEvent {
  type: string;
  created_at?: string;
  data?: { email_id?: string };
}

/**
 * Applies a Resend delivery event to its EmailSend. The status ladder is
 * monotonic (SENT → DELIVERED → OPENED → CLICKED) and events can arrive out
 * of order, so each transition only upgrades. BOUNCED is terminal and
 * auto-suppresses the address (phase-1 spec stop conditions).
 */
export async function applyResendEvent(
  event: ResendWebhookEvent,
): Promise<"applied" | "ignored" | "unknown-email"> {
  const emailId = event.data?.email_id;
  if (!emailId) return "ignored";

  const send = await prisma.emailSend.findFirst({
    where: { resendEmailId: emailId },
    include: {
      dunningCase: { include: { connection: true } },
      cardExpiryCase: { include: { connection: true } },
    },
  });
  if (!send) return "unknown-email";

  switch (event.type) {
    case "email.delivered": {
      await prisma.emailSend.updateMany({
        where: { id: send.id, status: "SENT" },
        data: { status: "DELIVERED" },
      });
      return "applied";
    }
    case "email.opened": {
      await prisma.emailSend.updateMany({
        where: { id: send.id, openedAt: null },
        data: { openedAt: new Date() },
      });
      await prisma.emailSend.updateMany({
        where: { id: send.id, status: { in: ["SENT", "DELIVERED"] } },
        data: { status: "OPENED" },
      });
      return "applied";
    }
    case "email.clicked": {
      await prisma.emailSend.updateMany({
        where: { id: send.id, clickedAt: null },
        data: { clickedAt: new Date() },
      });
      await prisma.emailSend.updateMany({
        where: { id: send.id, status: { in: ["SENT", "DELIVERED", "OPENED"] } },
        data: { status: "CLICKED" },
      });
      return "applied";
    }
    case "email.bounced": {
      await prisma.emailSend.updateMany({
        where: { id: send.id, status: { not: "CANCELED" } },
        data: { status: "BOUNCED" },
      });
      // A bounced REPLY_FORWARD is merchant-bound mail (phase-5, locked
      // decision #8): never suppress the merchant's address into the
      // customer suppression list, never touch the case.
      if (send.kind === "REPLY_FORWARD") {
        console.warn(`[resend] reply forward ${send.id} bounced (merchant address unreachable)`);
        return "applied";
      }
      // Hard bounce → suppress the address workspace-wide. upsert update:{}
      // keeps an earlier UNSUBSCRIBED reason intact. The send's parent is
      // either a dunning case or an expiry case (phase 4) — same doctrine.
      const organizationId =
        send.dunningCase?.connection.organizationId ??
        send.cardExpiryCase?.connection.organizationId;
      if (send.toEmail && organizationId) {
        await prisma.suppressionEntry.upsert({
          where: {
            organizationId_email: { organizationId, email: send.toEmail },
          },
          create: {
            organizationId,
            email: send.toEmail,
            reason: "BOUNCED",
          },
          update: {},
        });
      }
      if (send.dunningCaseId) {
        await prisma.dunningCase.updateMany({
          where: { id: send.dunningCaseId, status: "ACTIVE" },
          data: { status: "SUPPRESSED" },
        });
        await prisma.emailSend.updateMany({
          where: { dunningCaseId: send.dunningCaseId, status: "SCHEDULED" },
          data: { status: "CANCELED", error: "email bounced" },
        });
      }
      if (send.cardExpiryCaseId) {
        // Expiry case stays OPEN (suppression ≠ resolution) — just kill the
        // remaining touch; the send guard would catch it anyway.
        await prisma.emailSend.updateMany({
          where: { cardExpiryCaseId: send.cardExpiryCaseId, status: "SCHEDULED" },
          data: { status: "CANCELED", error: "email bounced" },
        });
      }
      console.warn(`[resend] hard bounce → suppressed ${send.toEmail ?? "(unknown)"}`);
      return "applied";
    }
    default:
      return "ignored";
  }
}
