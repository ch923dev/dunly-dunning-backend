/** Dev utility: mark an invoice paid (out of band) to trigger invoice.paid. */
import "dotenv/config";
import Stripe from "stripe";

const [, , stripeAccount, invoiceId] = process.argv;
if (!stripeAccount?.startsWith("acct_") || !invoiceId?.startsWith("in_")) {
  console.error("Usage: npx tsx scripts/pay-invoice.ts <acct_...> <in_...>");
  process.exit(1);
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const invoice = await stripe.invoices.pay(invoiceId, { paid_out_of_band: true }, { stripeAccount });
console.log(JSON.stringify({ id: invoice.id, status: invoice.status }, null, 2));
