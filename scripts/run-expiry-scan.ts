/**
 * Dev utility (phase 4): run the daily pre-dunning scan + sweep right now,
 * in-process — same code path the 03:00 UTC cron triggers.
 *
 *   npx tsx scripts/run-expiry-scan.ts
 */
import "dotenv/config";
import { boss } from "../src/lib/queue.js";
import { prisma } from "../src/lib/prisma.js";
import { runExpiryScan } from "../src/jobs/expiry.js";

await boss.start(); // the scan enqueues touch send-jobs via boss.send

await runExpiryScan("manual");

await boss.stop({ graceful: false });
await prisma.$disconnect();
process.exit(0);
