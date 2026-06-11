import { randomBytes } from "node:crypto";
import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { stripe, buildConnectAuthorizeUrl } from "../lib/stripe.js";
import { env } from "../env.js";
import { getWorkspace, requireOwner } from "../middleware/workspace.js";

const STATE_TTL_MS = 15 * 60 * 1000;

// Workspace-scoped Stripe routes. The OAuth callback lives in
// stripe-callback.ts — it authenticates by state token, not session.
export const stripeRouter = Router();

/** Connection status for the "Connect Stripe" card. Never exposes secrets. */
stripeRouter.get("/connection", async (req, res, next) => {
  try {
    const connection = await prisma.stripeConnection.findUnique({
      where: { organizationId: getWorkspace(req).organizationId },
    });
    if (!connection) {
      res.json({ connected: false });
      return;
    }

    res.json({
      connected: connection.status === "CONNECTED",
      status: connection.status,
      businessName: connection.businessName,
      livemode: connection.livemode,
      connectedAt: connection.connectedAt,
      disconnectedAt: connection.disconnectedAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Begin the Connect OAuth flow: mint a single-use state token and hand the
 * SPA the consent-screen URL (JSON, not a 302 — redirects fight CORS in XHR).
 */
stripeRouter.get("/connect", requireOwner, async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);

    const existing = await prisma.stripeConnection.findUnique({
      where: { organizationId },
    });
    if (existing?.status === "CONNECTED") {
      res.status(409).json({ error: "already_connected" });
      return;
    }

    // Opportunistic sweep — no cron needed for expired states.
    await prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });

    const token = randomBytes(32).toString("base64url");
    await prisma.oAuthState.create({
      data: {
        token,
        organizationId,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    res.json({ url: buildConnectAuthorizeUrl(token) });
  } catch (err) {
    next(err);
  }
});

/**
 * Disconnect the workspace's Stripe account. Stripe-side deauthorization is
 * best-effort: if the grant is already gone at Stripe, we still mark the
 * local connection DISCONNECTED.
 */
stripeRouter.post("/disconnect", requireOwner, async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);

    const connection = await prisma.stripeConnection.findUnique({
      where: { organizationId },
    });
    if (!connection || connection.status !== "CONNECTED") {
      res.status(404).json({ error: "not_connected" });
      return;
    }

    try {
      await stripe.oauth.deauthorize({
        client_id: env.STRIPE_CLIENT_ID,
        stripe_user_id: connection.stripeAccountId,
      });
    } catch (err) {
      console.warn(
        `Stripe deauthorize failed for ${connection.stripeAccountId} (continuing with local disconnect):`,
        err,
      );
    }

    await prisma.stripeConnection.update({
      where: { id: connection.id },
      data: { status: "DISCONNECTED", disconnectedAt: new Date() },
    });

    res.json({ disconnected: true });
  } catch (err) {
    next(err);
  }
});
