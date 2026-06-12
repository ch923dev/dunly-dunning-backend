/**
 * Dev utility (phase 4): create a HEALTHY subscription on the connected
 * account whose default card expires soon — pre-dunning scanner bait.
 * The card number is the always-succeeds 4242 test card with a custom
 * expiry, so the first invoice charges fine and no dunning case opens.
 *
 *   npx tsx scripts/create-expiring-card-customer.ts <acct_...> [email] [monthsFromNow=1] [--extra-sub]
 *
 * --extra-sub creates a SECOND subscription on the same card (acceptance
 * criterion #2: one case per human, protectedAmount sums both).
 */
import "dotenv/config";
import Stripe from "stripe";

const stripeAccount = process.argv[2];
if (!stripeAccount?.startsWith("acct_")) {
  console.error(
    "Usage: npx tsx scripts/create-expiring-card-customer.ts <acct_...> [email] [monthsFromNow=1] [--extra-sub]",
  );
  process.exit(1);
}
const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"));
const email = positional[0] ?? "expiring-card@dunly.test";
const monthsFromNow = Number(positional[1] ?? 1);
const extraSub = process.argv.includes("--extra-sub");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const opts = { stripeAccount };

// Expiry month N months from now (calendar math, day-independent).
const base = new Date();
const expMonth = ((base.getMonth() + monthsFromNow) % 12) + 1;
const expYear = base.getFullYear() + Math.floor((base.getMonth() + monthsFromNow) / 12);

const product = await stripe.products.create({ name: "Dunly Expiry Test Plan" }, opts);
const price = await stripe.prices.create(
  {
    product: product.id,
    unit_amount: 4900,
    currency: "usd",
    recurring: { interval: "month" },
    nickname: "Scale (expiry test)",
  },
  opts,
);

const customer = await stripe.customers.create({ email, name: "Expiring Card Customer" }, opts);

// Raw card numbers are blocked by default (even in test mode), but updating
// an attached card's expiry is a normal API operation — attach the stock
// visa fixture, then set the expiry we need.
const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id }, opts);
await stripe.paymentMethods.update(pm.id, { card: { exp_month: expMonth, exp_year: expYear } }, opts);
await stripe.customers.update(
  customer.id,
  { invoice_settings: { default_payment_method: pm.id } },
  opts,
);

const subscription = await stripe.subscriptions.create(
  { customer: customer.id, items: [{ price: price.id }], payment_behavior: "allow_incomplete" },
  opts,
);

let secondSubscription: Stripe.Subscription | null = null;
if (extraSub) {
  const price2 = await stripe.prices.create(
    {
      product: product.id,
      unit_amount: 1900,
      currency: "usd",
      recurring: { interval: "month" },
      nickname: "Add-on (expiry test)",
    },
    opts,
  );
  secondSubscription = await stripe.subscriptions.create(
    { customer: customer.id, items: [{ price: price2.id }], payment_behavior: "allow_incomplete" },
    opts,
  );
}

console.log(
  JSON.stringify(
    {
      customer: customer.id,
      email,
      paymentMethod: pm.id,
      cardExpires: `${expMonth}/${expYear}`,
      subscription: subscription.id,
      subscriptionStatus: subscription.status,
      ...(secondSubscription
        ? {
            secondSubscription: secondSubscription.id,
            secondSubscriptionStatus: secondSubscription.status,
          }
        : {}),
    },
    null,
    2,
  ),
);
