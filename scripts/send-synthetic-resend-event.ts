/**
 * Dev utility: deliver a Svix-signed Resend event to the local webhook —
 * the only way to test delivery events deterministically (Resend has no CLI
 * tunnel à la `stripe listen`).
 *
 * Usage: npx tsx scripts/send-synthetic-resend-event.ts <type> <resendEmailId> [url]
 *   type: email.delivered | email.opened | email.clicked | email.bounced
 */
import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";

const [, , type, emailId, url = "http://localhost:4000/webhooks/resend"] = process.argv;
const secret = process.env.RESEND_WEBHOOK_SECRET;
if (!type?.startsWith("email.") || !emailId || !secret) {
  console.error(
    "Usage: npx tsx scripts/send-synthetic-resend-event.ts <email.*> <resendEmailId> [url]\n" +
      "Requires RESEND_WEBHOOK_SECRET in .env",
  );
  process.exit(1);
}

const payload = JSON.stringify({
  type,
  created_at: new Date().toISOString(),
  data: { email_id: emailId },
});
const id = `msg_${randomUUID().replaceAll("-", "")}`;
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
  .update(`${id}.${timestamp}.${payload}`)
  .digest("base64");

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
