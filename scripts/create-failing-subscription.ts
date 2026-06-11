/**
 * Dev utility: create a subscription on the connected account whose first
 * charge FAILS (test card 4000 0000 0000 0341 via pm_card_chargeCustomerFail),
 * producing a real subscription-backed invoice.payment_failed event.
 *
 *   npx tsx scripts/create-failing-subscription.ts <acct_...> [customerEmail]
 */
import "dotenv/config";
import Stripe from "stripe";

const stripeAccount = process.argv[2];
if (!stripeAccount?.startsWith("acct_")) {
  console.error("Usage: npx tsx scripts/create-failing-subscription.ts <acct_...> [email]");
  process.exit(1);
}
const email = process.argv[3] ?? "failing-card@dunly.test";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const opts = { stripeAccount };

const product = await stripe.products.create({ name: "Dunly Test Plan" }, opts);
const price = await stripe.prices.create(
  {
    product: product.id,
    unit_amount: 2900,
    currency: "usd",
    recurring: { interval: "month" },
    nickname: "Growth (test)",
  },
  opts,
);

const customer = await stripe.customers.create({ email, name: "Failing Card Customer" }, opts);
const pm = await stripe.paymentMethods.attach(
  "pm_card_chargeCustomerFail",
  { customer: customer.id },
  opts,
);
await stripe.customers.update(
  customer.id,
  { invoice_settings: { default_payment_method: pm.id } },
  opts,
);

// allow_incomplete makes Stripe attempt the charge server-side immediately —
// it fails, and invoice.payment_failed fires.
const subscription = await stripe.subscriptions.create(
  {
    customer: customer.id,
    items: [{ price: price.id }],
    payment_behavior: "allow_incomplete",
  },
  opts,
);

console.log(
  JSON.stringify(
    {
      customer: customer.id,
      subscription: subscription.id,
      subscriptionStatus: subscription.status,
    },
    null,
    2,
  ),
);
