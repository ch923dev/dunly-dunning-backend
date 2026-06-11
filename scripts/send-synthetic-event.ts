/**
 * Dev utility: POST a signed Stripe webhook payload to a local endpoint.
 *
 * Reads the raw event JSON from stdin, signs it with the given secret using
 * Stripe's test-header helper, and prints the response status + body.
 *
 *   Get-Content event.json -Raw | npx tsx scripts/send-synthetic-event.ts [url] [secret]
 *
 * Defaults: url = http://localhost:4000/webhooks/stripe,
 *           secret = STRIPE_WEBHOOK_SECRET from .env
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import Stripe from "stripe";

const url = process.argv[2] ?? "http://localhost:4000/webhooks/stripe";
const secret = process.argv[3] ?? process.env.STRIPE_WEBHOOK_SECRET;
if (!secret) {
  console.error("No webhook secret (arg 2 or STRIPE_WEBHOOK_SECRET)");
  process.exit(1);
}

const payload = readFileSync(0, "utf8").trim();
JSON.parse(payload); // fail fast on malformed input

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "sk_test_dummy");
const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });

const res = await fetch(url, {
  method: "POST",
  headers: { "stripe-signature": signature, "content-type": "application/json" },
  body: payload,
});
console.log(res.status, await res.text());
