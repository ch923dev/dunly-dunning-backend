import Stripe from "stripe";
import { boss, ensureQueue, QUEUES, type ProcessEventJob } from "../lib/queue.js";
import { prisma } from "../lib/prisma.js";
import { stripe } from "../lib/stripe.js";
import { enqueueSequence, scheduleReactivation } from "./dunning.js";
import type { StripeConnection } from "../generated/prisma/client.js";

/**
 * Event processing worker (docs/phase-0-foundation.md §4).
 *
 * Phase 0 handlers record state only — no emails (locked decision #3).
 * Every handler is idempotent: safe under Stripe redelivery and pg-boss
 * retry alike.
 */
export async function registerEventWorkers() {
  await ensureQueue(QUEUES.processEvent);

  // batchSize > 1: webhook bursts (Stripe fixture cascades, busy merchants)
  // would otherwise drain one job per polling tick. On a thrown error
  // pg-boss fails the whole batch and retries it — safe, because the
  // status guard in processWebhookEvent makes re-runs of already-processed
  // events no-ops.
  await boss.work<ProcessEventJob>(
    QUEUES.processEvent,
    { batchSize: 10 },
    async (jobs) => {
      const failures: unknown[] = [];
      for (const job of jobs) {
        try {
          await processWebhookEvent(job.data.stripeEventId);
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  );
}

export async function processWebhookEvent(stripeEventId: string) {
  const record = await prisma.webhookEvent.findUnique({ where: { stripeEventId } });
  if (!record) return;
  // Terminal statuses: this delivery already ran to completion. Only
  // RECEIVED (fresh) and FAILED (pg-boss retry) may proceed.
  if (record.status !== "RECEIVED" && record.status !== "FAILED") return;

  await prisma.webhookEvent.update({
    where: { id: record.id },
    data: { status: "PROCESSING", error: null },
  });

  const event = record.payload as unknown as Stripe.Event;
  try {
    const handled = await dispatch(event, record.stripeAccountId);
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { status: handled ? "PROCESSED" : "SKIPPED", processedAt: new Date() },
    });
  } catch (err) {
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { status: "FAILED", error: String(err) },
    });
    throw err; // surface to pg-boss so its retry policy applies
  }
}

/** Returns true if the event type has a handler (PROCESSED vs SKIPPED). */
async function dispatch(event: Stripe.Event, accountId: string | null): Promise<boolean> {
  switch (event.type) {
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event, accountId);
    case "invoice.paid":
      return handleInvoicePaid(event);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event);
    case "customer.subscription.updated":
      return handleSubscriptionUpdated(event);
    case "charge.dispute.created":
      return handleDisputeCreated(event, accountId);
    case "account.application.deauthorized":
      return handleDeauthorized(accountId);
    default:
      return false;
  }
}

async function findConnection(accountId: string | null): Promise<StripeConnection | null> {
  if (!accountId) return null;
  return prisma.stripeConnection.findUnique({ where: { stripeAccountId: accountId } });
}

async function handleInvoicePaymentFailed(
  event: Stripe.InvoicePaymentFailedEvent,
  accountId: string | null,
): Promise<boolean> {
  const invoice = event.data.object;
  const connection = await findConnection(accountId);
  if (!connection || !invoice.id || !invoice.customer) return false;

  const customer = await prisma.customer.upsert({
    where: {
      connectionId_stripeCustomerId: {
        connectionId: connection.id,
        stripeCustomerId: String(invoice.customer),
      },
    },
    create: {
      connectionId: connection.id,
      stripeCustomerId: String(invoice.customer),
      email: invoice.customer_email,
      name: invoice.customer_name,
    },
    update: {
      email: invoice.customer_email,
      name: invoice.customer_name,
    },
  });

  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (subscriptionId) {
    await syncSubscription(connection, customer.id, subscriptionId);
  }

  const failureCode = invoice.last_finalization_error?.code ?? null;
  const failureMessage = invoice.last_finalization_error?.message ?? null;

  const existing = await prisma.dunningCase.findUnique({
    where: { stripeInvoiceId: invoice.id },
  });
  if (!existing) {
    const created = await prisma.dunningCase.create({
      data: {
        connectionId: connection.id,
        customerId: customer.id,
        stripeInvoiceId: invoice.id,
        stripeSubscriptionId: subscriptionId,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        amountDue: invoice.amount_due,
        currency: invoice.currency,
        attemptCount: invoice.attempt_count,
        failureCode,
        failureMessage,
        failedAt: new Date(event.created * 1000),
      },
    });
    await enqueueSequence(created.id);
  } else {
    const reopened = existing.status === "RECOVERED";
    await prisma.dunningCase.update({
      where: { id: existing.id },
      data: {
        attemptCount: invoice.attempt_count,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
        failureCode,
        failureMessage,
        // A re-failure reopens a recovered case; every other status
        // (PAUSED, SUPPRESSED, LOST_*) is a deliberate stop — never
        // override it from a webhook. Reopening is a new failure episode,
        // so failedAt re-anchors the resumed sequence's schedule.
        ...(reopened
          ? {
              status: "ACTIVE" as const,
              recoveredAt: null,
              closedAt: null,
              failedAt: new Date(event.created * 1000),
              // A re-failure can bill a different amount (audit B14) —
              // refresh so emails and the amount threshold use the fresh
              // figure instead of the recovered episode's stale one.
              amountDue: invoice.amount_due,
              currency: invoice.currency,
            }
          : {}),
      },
    });
    // Kick the sequence for live cases only; Stripe re-fires payment_failed
    // on every retry attempt, and each kick is an idempotent re-verify.
    if (reopened || existing.status === "ACTIVE") {
      await enqueueSequence(existing.id);
    }
  }

  return true;
}

async function handleInvoicePaid(event: Stripe.InvoicePaidEvent): Promise<boolean> {
  const invoice = event.data.object;
  if (!invoice.id) return false;

  // SUPPRESSED cases can still close as recovered — Stripe's retries keep
  // running even when the customer opted out of our emails (product plan §5.2).
  await prisma.dunningCase.updateMany({
    where: {
      stripeInvoiceId: invoice.id,
      status: { in: ["ACTIVE", "PAUSED", "SUPPRESSED"] },
    },
    data: { status: "RECOVERED", recoveredAt: new Date(), closedAt: new Date() },
  });

  // Stop condition: a paid invoice ends every pending send for it, instantly
  // and visibly (the send-time guard would catch them anyway — this is the
  // advisory fast path, phase-1 spec "Core design").
  await prisma.emailSend.updateMany({
    where: { dunningCase: { stripeInvoiceId: invoice.id }, status: "SCHEDULED" },
    data: { status: "CANCELED", error: "invoice paid" },
  });
  return true;
}

async function handleSubscriptionDeleted(
  event: Stripe.CustomerSubscriptionDeletedEvent,
): Promise<boolean> {
  const subscription = event.data.object;

  // cancellation_details distinguishes involuntary (retries exhausted) from
  // voluntary (customer chose to cancel) — the honest-churn split.
  const involuntary = subscription.cancellation_details?.reason === "payment_failed";
  const closedStatus = involuntary ? ("LOST_INVOLUNTARY" as const) : ("LOST_VOLUNTARY" as const);

  await prisma.subscription.updateMany({
    where: { stripeSubscriptionId: subscription.id },
    data: {
      status: "CANCELED",
      canceledAt: subscription.canceled_at ? new Date(subscription.canceled_at * 1000) : new Date(),
    },
  });

  // Capture the cases this deletion closes BEFORE closing them — the
  // involuntary path schedules a reactivation email per closed case.
  const openCases = await prisma.dunningCase.findMany({
    where: {
      stripeSubscriptionId: subscription.id,
      status: { in: ["ACTIVE", "PAUSED", "SUPPRESSED"] },
    },
    select: { id: true },
  });
  const caseIds = openCases.map((c) => c.id);

  await prisma.dunningCase.updateMany({
    where: { id: { in: caseIds } },
    data: { status: closedStatus, closedAt: new Date() },
  });
  await prisma.emailSend.updateMany({
    where: { dunningCaseId: { in: caseIds }, status: "SCHEDULED" },
    data: {
      status: "CANCELED",
      error: `subscription canceled (${involuntary ? "involuntary" : "voluntary"})`,
    },
  });

  // One-shot reactivation on involuntary cancels only (phase-1 spec, locked
  // decision #1) — NEVER for voluntary; the send worker re-verifies both the
  // case status and the suppression list before anything goes out.
  if (involuntary) {
    for (const caseId of caseIds) {
      await scheduleReactivation(caseId);
    }
  }
  return true;
}

/**
 * Phase 0 known gap, now closed (phase-0 notes #5): cancelling an
 * `incomplete` subscription emits subscription.updated with status
 * `incomplete_expired` — NOT subscription.deleted. It carries no
 * cancellation_details; a failed-payment-born incomplete subscription
 * expiring is involuntary by definition. No reactivation — the customer
 * never had a working subscription to restart.
 */
async function handleSubscriptionUpdated(
  event: Stripe.CustomerSubscriptionUpdatedEvent,
): Promise<boolean> {
  const subscription = event.data.object;
  if (subscription.status !== "incomplete_expired") return false; // stored as SKIPPED

  await prisma.subscription.updateMany({
    where: { stripeSubscriptionId: subscription.id },
    data: { status: "INCOMPLETE_EXPIRED", canceledAt: new Date(event.created * 1000) },
  });

  await prisma.dunningCase.updateMany({
    where: {
      stripeSubscriptionId: subscription.id,
      status: { in: ["ACTIVE", "PAUSED", "SUPPRESSED"] },
    },
    data: { status: "LOST_INVOLUNTARY", closedAt: new Date() },
  });
  await prisma.emailSend.updateMany({
    where: { dunningCase: { stripeSubscriptionId: subscription.id }, status: "SCHEDULED" },
    data: { status: "CANCELED", error: "subscription expired (incomplete_expired)" },
  });
  return true;
}

async function handleDisputeCreated(
  event: Stripe.ChargeDisputeCreatedEvent,
  accountId: string | null,
): Promise<boolean> {
  const dispute = event.data.object;
  const connection = await findConnection(accountId);
  if (!connection) return false;

  // The dispute object carries no customer id — resolve it via the charge.
  // Failure here throws so pg-boss retries: never silently skip pausing a
  // disputing customer (we must never dun them).
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
  const charge = await stripe.charges.retrieve(chargeId, undefined, {
    stripeAccount: connection.stripeAccountId,
  });
  if (!charge.customer) return false;

  const customer = await prisma.customer.findUnique({
    where: {
      connectionId_stripeCustomerId: {
        connectionId: connection.id,
        stripeCustomerId: String(charge.customer),
      },
    },
  });
  if (!customer) return false;

  await prisma.dunningCase.updateMany({
    where: { customerId: customer.id, status: "ACTIVE" },
    data: { status: "PAUSED" },
  });

  // Never email a disputing customer — kill EVERY pending send across all
  // their cases, including a scheduled reactivation.
  await prisma.emailSend.updateMany({
    where: { dunningCase: { customerId: customer.id }, status: "SCHEDULED" },
    data: { status: "CANCELED", error: "dispute opened" },
  });
  return true;
}

async function handleDeauthorized(accountId: string | null): Promise<boolean> {
  if (!accountId) return false;

  const { count } = await prisma.stripeConnection.updateMany({
    where: { stripeAccountId: accountId, status: { not: "REVOKED" } },
    data: { status: "REVOKED", disconnectedAt: new Date() },
  });
  if (count > 0) console.warn(`[events] Stripe access revoked for ${accountId}`);
  return true;
}

/** API 2025+ moved invoice.subscription into invoice.parent. */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const sub = invoice.parent?.subscription_details?.subscription;
  if (!sub) return null;
  return typeof sub === "string" ? sub : sub.id;
}

/** Best-effort Subscription mirror — a sync failure must not fail the case. */
async function syncSubscription(
  connection: StripeConnection,
  customerId: string,
  stripeSubscriptionId: string,
) {
  try {
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, undefined, {
      stripeAccount: connection.stripeAccountId,
    });
    const item = sub.items.data[0];
    const status = mapSubscriptionStatus(sub.status);

    await prisma.subscription.upsert({
      where: { stripeSubscriptionId },
      create: {
        customerId,
        stripeSubscriptionId,
        status,
        planName: item?.price.nickname ?? item?.price.id ?? null,
        amount: item?.price.unit_amount ?? null,
        currency: sub.currency,
        currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : null,
      },
      update: {
        status,
        planName: item?.price.nickname ?? item?.price.id ?? null,
        amount: item?.price.unit_amount ?? null,
        currentPeriodEnd: item ? new Date(item.current_period_end * 1000) : null,
      },
    });
  } catch (err) {
    // Best-effort holds only for Stripe API failures (revoked connection,
    // rate limit, deleted subscription) — degraded personalization, not a
    // failed case. Anything else is a programming error and must surface
    // (audit B9).
    if (!(err instanceof Stripe.errors.StripeError)) throw err;
    console.warn(`[events] subscription sync failed for ${stripeSubscriptionId}:`, err);
  }
}

function mapSubscriptionStatus(
  status: Stripe.Subscription.Status,
): "ACTIVE" | "PAST_DUE" | "UNPAID" | "CANCELED" | "INCOMPLETE" | "INCOMPLETE_EXPIRED" | "TRIALING" | "PAUSED" {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "past_due":
      return "PAST_DUE";
    case "unpaid":
      return "UNPAID";
    case "canceled":
      return "CANCELED";
    case "incomplete":
      return "INCOMPLETE";
    case "incomplete_expired":
      return "INCOMPLETE_EXPIRED";
    case "trialing":
      return "TRIALING";
    case "paused":
      return "PAUSED";
    default:
      // A Stripe API version can introduce statuses this build doesn't know
      // (audit B13). The mirror is advisory (plan-name personalization), so
      // log loudly and store ACTIVE rather than returning undefined.
      console.warn(`[events] unknown Stripe subscription status "${String(status)}" — mirroring as ACTIVE`);
      return "ACTIVE";
  }
}
