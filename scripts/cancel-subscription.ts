/** Dev utility: cancel a subscription on a connected account (voluntary). */
import "dotenv/config";
import Stripe from "stripe";

const [, , stripeAccount, subscriptionId] = process.argv;
if (!stripeAccount?.startsWith("acct_") || !subscriptionId?.startsWith("sub_")) {
  console.error("Usage: npx tsx scripts/cancel-subscription.ts <acct_...> <sub_...>");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const sub = await stripe.subscriptions.cancel(subscriptionId, undefined, { stripeAccount });
console.log(
  JSON.stringify(
    { id: sub.id, status: sub.status, cancellationReason: sub.cancellation_details?.reason },
    null,
    2,
  ),
);
