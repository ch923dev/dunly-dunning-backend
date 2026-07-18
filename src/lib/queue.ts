import { PgBoss } from "pg-boss";
import { env } from "../env.js";

/**
 * pg-boss rides on the same Postgres instance as Prisma,
 * isolated in its own "pgboss" schema.
 */
export const boss = new PgBoss({
  connectionString: env.DATABASE_URL,
  schema: "pgboss",
});

boss.on("error", (error) => console.error("[pg-boss]", error));

export const QUEUES = {
  /** Process one stored WebhookEvent (dispatch to type handlers). */
  processEvent: "events.process",
  /** Phase 1: kick off / advance the dunning email sequence for a case. */
  dunningSequence: "dunning.sequence",
  /** Phase 1: send a single dunning email (one EmailSend). */
  sendDunningEmail: "dunning.send-email",
  /** Phase 4: daily card-expiry scan + sweep across all CONNECTED accounts. */
  expiryScan: "expiry.scan",
  /** Periodic sweep for WebhookEvent rows orphaned in RECEIVED/PROCESSING (audit B6). */
  reconcileEvents: "events.reconcile",
} as const;

/**
 * Create (or migrate) a queue with the "short" policy: at most ONE queued
 * (created-state) job per singletonKey. The default "standard" policy
 * silently IGNORES singletonKey, which would let every duplicate webhook or
 * sequence kick stack a duplicate job — discovered live in Phase 1 step 3.
 * Duplicates that still slip through (e.g. re-enqueue while a job is active)
 * are absorbed by the status-guarded handlers, as always.
 */
export async function ensureQueue(name: string) {
  const existing = await boss.getQueue(name);
  if (existing?.policy === "short") return;
  if (existing) {
    // Policy can't be updated in place (UpdateQueueOptions has no `policy`).
    // Recreating drops the queue's jobs — fine: handlers are idempotent and
    // the sequence engine self-heals lost send jobs on the next kick.
    console.warn(`[queue] migrating "${name}" from policy "${existing.policy}" to "short"`);
    await boss.deleteQueue(name);
  }
  await boss.createQueue(name, { policy: "short" });
}

export interface ProcessEventJob {
  /** Stripe event id (evt_…) — doubles as the job's singletonKey. */
  stripeEventId: string;
}

export interface DunningSequenceJob {
  dunningCaseId: string;
}

export interface SendDunningEmailJob {
  emailSendId: string;
}

export interface ExpiryScanJob {
  /** "cron" for the daily schedule, "manual" for the dev script. */
  trigger: "cron" | "manual";
}
