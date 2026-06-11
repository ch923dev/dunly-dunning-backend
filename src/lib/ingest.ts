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
  /** Direct (non-Connect) deliveries carry no event.account — the
   *  per-workspace endpoint passes its connection's account id instead. */
  fallbackAccountId?: string;
}): Promise<{ event: Stripe.Event; duplicate: boolean }> {
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(opts.rawBody, opts.signature, opts.secret);
  } catch (err) {
    throw new InvalidSignatureError(err);
  }

  const { count } = await prisma.webhookEvent.createMany({
    data: [
      {
        stripeEventId: event.id,
        type: event.type,
        stripeAccountId: event.account ?? opts.fallbackAccountId ?? null,
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
