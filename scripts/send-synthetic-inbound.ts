/**
 * Dev utility (phase 5): deliver a Svix-signed synthetic `email.received`
 * to the local webhook — the inbound-reply equivalent of
 * send-synthetic-resend-event.ts. Real inbound needs a public URL (launch
 * hardening); this is how stop-on-reply is verified locally.
 *
 * Usage: npx tsx scripts/send-synthetic-inbound.ts --case <dunningCaseId> [flags]
 *   --case <id>       target dunning case (or --to to pass a raw address)
 *   --to <address>    explicit recipient (overrides --case; for forged-address tests)
 *   --from <email>    sender            (default jamie@customer.test)
 *   --text <body>     reply text        (default a refund request)
 *   --subject <s>     reply subject     (default "Re: Your payment didn't go through")
 *   --auto            mark as out-of-office (Auto-Submitted: auto-replied)
 *   --inbound-id <id> stable inbound id (default random — pass to test redelivery)
 *   --url <url>       webhook URL       (default http://localhost:4000/webhooks/resend)
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";
import { makeReplyAddress } from "../src/lib/replies.js";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const secret = process.env.RESEND_WEBHOOK_SECRET;
if (!secret) {
  console.error("Requires RESEND_WEBHOOK_SECRET in .env");
  process.exit(1);
}

const caseId = flag("case");
let to = flag("to");
if (!to && caseId) {
  const addr = makeReplyAddress(caseId);
  if (!addr) {
    console.error("INBOUND_REPLY_DOMAIN is not set in .env — the codec can't mint an address");
    process.exit(1);
  }
  to = addr;
}
if (!to) {
  console.error("Usage: npx tsx scripts/send-synthetic-inbound.ts --case <dunningCaseId> [--auto] [--from ...] [--text ...]");
  process.exit(1);
}

const payload = JSON.stringify({
  type: "email.received",
  created_at: new Date().toISOString(),
  data: {
    email_id: flag("inbound-id") ?? `inbound_${randomUUID().replaceAll("-", "")}`,
    from: flag("from") ?? "jamie@customer.test",
    to: [to],
    subject: flag("subject") ?? "Re: Your payment didn't go through",
    text:
      flag("text") ??
      "Hey — I want a refund, please stop charging me.\n\nJamie",
    headers: has("auto")
      ? [
          { name: "Auto-Submitted", value: "auto-replied" },
          { name: "X-Autoreply", value: "yes" },
        ]
      : [],
  },
});

const id = `msg_${randomUUID().replaceAll("-", "")}`;
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
  .update(`${id}.${timestamp}.${payload}`)
  .digest("base64");

const url = flag("url") ?? "http://localhost:4000/webhooks/resend";
console.log(`→ ${url}\n  to: ${to}`);
const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  },
  body: payload,
});
console.log(JSON.stringify({ status: res.status, body: await res.text() }, null, 2));
