import type Stripe from "stripe";
import { stripe } from "./stripe.js";
import { prisma } from "./prisma.js";
import type { Prisma } from "../generated/prisma/client.js";
import { boss, QUEUES, type ProcessEventJob } from "./queue.js";

export class InvalidSignatureError extends Error {
  constructor(cause: unknown) {
    super("Stripe webhook signature verification failed");
    this.cause = cause;
  }
}

/** A validly-signed event whose event.account contradicts the endpoint's
 *  own connection (audit B10) — rejected rather than silently re-scoped. */
export class AccountMismatchError extends Error {
  constructor(eventAccount: string, pinnedAccount: string) {
    super(`event.account ${eventAccount} does not match endpoint account ${pinnedAccount}`);
  }
}

/**
 * The single ingestion path both webhook endpoints converge on
 * (docs/phase-0-foundation.md §3).
 *
 * verify signature → INSERT WebhookEvent (ON CONFLICT DO NOTHING) → enqueue.
 *
 * Ordering note: we insert AND enqueue before the route responds 200. Both are
 * single-digit-ms Postgres writes, so the ACK stays fast — but if the enqueue
 * throws, the route returns 500 and Stripe redelivers: the duplicate insert is
 * absorbed and the enqueue retried. The enqueue also runs for duplicates on
 * purpose (self-healing when a prior delivery crashed between insert and
 * enqueue); singletonKey makes re-sends no-ops while a job is pending, and the
 * worker skips events that already reached a terminal status.
 */
export async function ingestStripeEvent(opts: {
  rawBody: Buffer;
  signature: string;
  secret: string;
  /**
   * The per-workspace endpoint pins events to its own connection's account
   * (audit B10): a validly-signed event carrying a *different*
   * event.account is rejected, and direct (non-Connect) deliveries with no
   * event.account are attributed to the pinned account. The platform
   * Connect endpoint passes nothing and trusts event.account.
   */
  pinnedAccountId?: string;
}): Promise<{ event: Stripe.Event; duplicate: boolean }> {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(opts.rawBody, opts.signature, opts.secret);
  } catch (err) {
    throw new InvalidSignatureError(err);
  }

  if (opts.pinnedAccountId && event.account && event.account !== opts.pinnedAccountId) {
    throw new AccountMismatchError(event.account, opts.pinnedAccountId);
  }

  const { count } = await prisma.webhookEvent.createMany({
    data: [
      {
        stripeEventId: event.id,
        type: event.type,
        stripeAccountId: opts.pinnedAccountId ?? event.account ?? null,
        livemode: event.livemode,
        payload: event as unknown as Prisma.InputJsonValue,
      },
    ],
    skipDuplicates: true,
  });

  await boss.send(
    QUEUES.processEvent,
    { stripeEventId: event.id } satisfies ProcessEventJob,
    {
      singletonKey: event.id,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
    },
  );

  return { event, duplicate: count === 0 };
}
