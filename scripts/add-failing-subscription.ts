/**
 * Dev utility (phase 4): add a FAILING subscription to an EXISTING customer
 * — the sub pins pm_card_chargeCustomerFail as its own default payment
 * method, so the customer's default card stays untouched. Produces a real
 * invoice.payment_failed and opens a dunning case for the customer
 * (no-overlap proof: pre-dunning must back off).
 *
 *   npx tsx scripts/add-failing-subscription.ts <acct_...> <cus_...>
 */
import "dotenv/config";
import Stripe from "stripe";

const [stripeAccount, customerId] = process.argv.slice(2);
if (!stripeAccount?.startsWith("acct_") || !customerId?.startsWith("cus_")) {
  console.error("Usage: npx tsx scripts/add-failing-subscription.ts <acct_...> <cus_...>");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const opts = { stripeAccount };

const pm = await stripe.paymentMethods.attach(
  "pm_card_chargeCustomerFail",
  { customer: customerId },
  opts,
);
const product = await stripe.products.create({ name: "Dunly Failing Add-on" }, opts);
const price = await stripe.prices.create(
  {
    product: product.id,
    unit_amount: 9900,
    currency: "usd",
    recurring: { interval: "month" },
    nickname: "Failing add-on (test)",
  },
  opts,
);
const subscription = await stripe.subscriptions.create(
  {
    customer: customerId,
    items: [{ price: price.id }],
    default_payment_method: pm.id,
    payment_behavior: "allow_incomplete",
  },
  opts,
);

console.log(
  JSON.stringify(
    { customer: customerId, subscription: subscription.id, status: subscription.status },
    null,
    2,
  ),
);
