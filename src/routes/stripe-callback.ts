import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { stripe } from "../lib/stripe.js";
import { env } from "../env.js";

/**
 * Stripe Connect OAuth callback. Mounted OUTSIDE requireWorkspace: the
 * browser arrives here from Stripe, and the single-use, expiring,
 * workspace-bound state token is the authentication. Every outcome ends in
 * a browser redirect with a machine-readable query param.
 */
export const stripeCallbackRouter = Router();

stripeCallbackRouter.get("/", async (req, res) => {
  const redirect = (params: string) =>
    res.redirect(`${env.APP_URL}/app/settings?${params}`);

  const { code, state, error } = req.query;

  // User clicked "deny" on the consent screen (or Stripe-side error).
  if (typeof error === "string") {
    redirect(error === "access_denied" ? "error=denied" : "error=stripe_error");
    return;
  }
  if (typeof code !== "string" || typeof state !== "string") {
    redirect("error=invalid_callback");
    return;
  }

  // Atomic single-use consumption — a replayed callback loses this race.
  const consumed = await prisma.oAuthState.updateMany({
    where: { token: state, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) {
    redirect("error=invalid_state");
    return;
  }
  const stateRow = await prisma.oAuthState.findUnique({ where: { token: state } });
  if (!stateRow) {
    redirect("error=invalid_state");
    return;
  }

  try {
    const tokenResponse = await stripe.oauth.token({
      grant_type: "authorization_code",
      code,
    });
    const stripeAccountId = tokenResponse.stripe_user_id;
    if (!stripeAccountId) {
      redirect("error=exchange_failed");
      return;
    }

    // Best-effort enrichment — a failure here must not fail the connect.
    let businessName: string | null = null;
    let defaultCurrency: string | null = null;
    try {
      const account = await stripe.accounts.retrieve(stripeAccountId);
      businessName =
        account.business_profile?.name ??
        account.settings?.dashboard?.display_name ??
        null;
      defaultCurrency = account.default_currency ?? null;
    } catch (err) {
      console.warn(`Could not retrieve account details for ${stripeAccountId}:`, err);
    }

    await prisma.stripeConnection.upsert({
      where: { organizationId: stateRow.organizationId },
      create: {
        organizationId: stateRow.organizationId,
        stripeAccountId,
        scope: tokenResponse.scope ?? null,
        livemode: tokenResponse.livemode ?? false,
        status: "CONNECTED",
        businessName,
        defaultCurrency,
      },
      update: {
        stripeAccountId,
        scope: tokenResponse.scope ?? null,
        livemode: tokenResponse.livemode ?? false,
        status: "CONNECTED",
        businessName,
        defaultCurrency,
        connectedAt: new Date(),
        disconnectedAt: null,
      },
    });

    redirect("connected=1");
  } catch (err) {
    // Unique violation on stripeAccountId: this Stripe account already
    // powers another workspace. One Stripe account, one workspace.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      redirect("error=account_in_use");
      return;
    }
    console.error("Connect OAuth token exchange failed:", err);
    redirect("error=exchange_failed");
  }
});
