/** Dev utility: run the event processor on one stored event, with tracing. */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { processWebhookEvent } from "../src/jobs/process-events.js";

const stripeEventId = process.argv[2];
if (!stripeEventId) {
  console.error("Usage: npx tsx scripts/process-one.ts <evt_...>");
  process.exit(1);
}

const before = await prisma.webhookEvent.findUnique({ where: { stripeEventId } });
console.log("before:", before?.status ?? "NOT FOUND");

await processWebhookEvent(stripeEventId);

const after = await prisma.webhookEvent.findUnique({ where: { stripeEventId } });
console.log("after:", after?.status ?? "NOT FOUND");

await prisma.$disconnect();
process.exit(0);
