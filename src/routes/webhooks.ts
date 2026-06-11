import { Router, raw, type Request, type Response } from "express";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { ingestStripeEvent, InvalidSignatureError } from "../lib/ingest.js";
import {
  applyResendEvent,
  verifySvixSignature,
  type ResendWebhookEvent,
} from "../lib/resend-events.js";

/**
 * Webhook ingestion — two entry points, one processor
 * (docs/phase-0-foundation.md §3, locked decision #2).
 *
 * Signature verification is the ONLY authentication. URL identifiers on the
 * per-workspace route are routing hints; unknown ids 404 before any
 * signature work.
 */
export const webhooksRouter = Router();

webhooksRouter.use(raw({ type: "application/json" }));

async function handleIngest(
  req: Request,
  res: Response,
  secret: string,
  fallbackAccountId?: string,
) {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    res.status(400).send("Missing stripe-signature header");
    return;
  }

  const startedAt = Date.now();
  try {
    const { event, duplicate } = await ingestStripeEvent({
      rawBody: req.body,
      signature,
      secret,
      ...(fallbackAccountId ? { fallbackAccountId } : {}),
    });
    console.log(
      `[ingest] ${event.id} ${event.type} account=${event.account ?? fallbackAccountId ?? "-"} duplicate=${duplicate} ${Date.now() - startedAt}ms`,
    );
    res.json({ received: true });
  } catch (err) {
    if (err instanceof InvalidSignatureError) {
      res.status(400).send("Invalid signature");
      return;
    }
    // 500 → Stripe redelivers; the duplicate insert will be absorbed.
    console.error("[ingest] failed:", err);
    res.status(500).send("Ingestion failed");
  }
}

/** Platform Connect endpoint — events arrive with event.account set. */
webhooksRouter.post("/stripe", async (req, res) => {
  await handleIngest(req, res, env.STRIPE_WEBHOOK_SECRET);
});

/**
 * Resend delivery events (delivered / opened / clicked / bounced) — Svix
 * signature is the only authentication. Applied inline (pure DB updates,
 * no external calls); a 500 makes Svix redeliver, and applyResendEvent is
 * idempotent under redelivery.
 */
webhooksRouter.post("/resend", async (req, res) => {
  if (!env.RESEND_WEBHOOK_SECRET) {
    res.status(503).send("Resend webhook not configured");
    return;
  }
  const id = req.headers["svix-id"];
  const timestamp = req.headers["svix-timestamp"];
  const signature = req.headers["svix-signature"];
  if (typeof id !== "string" || typeof timestamp !== "string" || typeof signature !== "string") {
    res.status(400).send("Missing svix headers");
    return;
  }
  const payload = (req.body as Buffer).toString("utf8");
  if (
    !verifySvixSignature({ id, timestamp, signature, payload, secret: env.RESEND_WEBHOOK_SECRET })
  ) {
    res.status(400).send("Invalid signature");
    return;
  }

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(payload) as ResendWebhookEvent;
  } catch {
    res.status(400).send("Invalid JSON");
    return;
  }

  try {
    const outcome = await applyResendEvent(event);
    console.log(`[resend] ${event.type} → ${outcome}`);
    res.json({ received: true, outcome });
  } catch (err) {
    console.error("[resend] event failed:", err);
    res.status(500).send("Event processing failed");
  }
});

/**
 * Per-workspace endpoint (routing hint only). Verified with the connection's
 * own stored webhookSecret. Unknown/unprovisioned ids are a 404 BEFORE any
 * signature check — an unprovisioned endpoint shouldn't reveal it exists.
 */
webhooksRouter.post("/:workspaceId/:connectionId", async (req, res) => {
  const { workspaceId, connectionId } = req.params;

  const connection = await prisma.stripeConnection.findUnique({
    where: { id: connectionId },
  });
  if (
    !connection ||
    connection.organizationId !== workspaceId ||
    !connection.webhookSecret
  ) {
    res.status(404).send("Not found");
    return;
  }

  await handleIngest(req, res, connection.webhookSecret, connection.stripeAccountId);
});
