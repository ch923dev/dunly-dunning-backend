/**
 * Dev utility (phase 4): update an attached card's expiry in place — exactly
 * what Stripe's network card updater does (same PM id, new exp date).
 *
 *   npx tsx scripts/update-card-expiry.ts <acct_...> <pm_...> <expMonth> <expYear>
 */
import "dotenv/config";
import Stripe from "stripe";

const [stripeAccount, paymentMethodId, expMonth, expYear] = process.argv.slice(2);
if (!stripeAccount?.startsWith("acct_") || !paymentMethodId?.startsWith("pm_") || !expMonth || !expYear) {
  console.error("Usage: npx tsx scripts/update-card-expiry.ts <acct_...> <pm_...> <expMonth> <expYear>");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const pm = await stripe.paymentMethods.update(
  paymentMethodId,
  { card: { exp_month: Number(expMonth), exp_year: Number(expYear) } },
  { stripeAccount },
);
console.log(
  JSON.stringify(
    { paymentMethod: pm.id, cardExpires: `${pm.card?.exp_month}/${pm.card?.exp_year}` },
    null,
    2,
  ),
);
