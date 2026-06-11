import Stripe from "stripe";
import { env } from "../env.js";

export const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
  appInfo: { name: "Dunly", url: env.APP_URL },
});

/** Stripe Connect OAuth consent-screen URL for a given CSRF state token. */
export function buildConnectAuthorizeUrl(stateToken: string) {
  const url = new URL("https://connect.stripe.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.STRIPE_CLIENT_ID);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("redirect_uri", env.CONNECT_REDIRECT_URL);
  url.searchParams.set("state", stateToken);
  return url.toString();
}

/** Create a Stripe Billing customer portal session link for an end-customer. */
export async function createPortalLink(opts: {
  stripeCustomerId: string;
  stripeAccountId: string;
  returnUrl?: string;
}) {
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: opts.stripeCustomerId,
      return_url: opts.returnUrl ?? env.APP_URL,
    },
    { stripeAccount: opts.stripeAccountId },
  );
  return session.url;
}
