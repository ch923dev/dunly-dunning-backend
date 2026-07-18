import Stripe from "stripe";
import { boss, ensureQueue, QUEUES, type ExpiryScanJob, type SendDunningEmailJob } from "../lib/queue.js";
import { prisma } from "../lib/prisma.js";
import { stripe } from "../lib/stripe.js";
import { startOfDayInZone } from "../lib/zoned-time.js";
import { Prisma, type CardExpiryCase, type StripeConnection } from "../generated/prisma/client.js";
import {
  EXPIRY_SCAN_HORIZON_DAYS,
  EXPIRY_SEND_HOUR,
  EXPIRY_TOUCH_1_LEAD_DAYS,
  EXPIRY_TOUCH_1_MIN_LEAD_DAYS,
  EXPIRY_TOUCH_1_STAGE_ORDER,
  EXPIRY_TOUCH_1_SUBJECT,
  EXPIRY_TOUCH_1_TEMPLATE_KEY,
  EXPIRY_TOUCH_2_LEAD_DAYS,
  EXPIRY_TOUCH_2_STAGE_ORDER,
  EXPIRY_TOUCH_2_SUBJECT,
  EXPIRY_TOUCH_2_TEMPLATE_KEY,
  expiryMoment,
  formatCardBrand,
  formatCardExpiry,
} from "../lib/predunning.js";
import { applyMergeVars, renderExpiryEmail, sendDunningEmail } from "../lib/email.js";
import { makeCaseToken } from "../lib/tokens.js";
import { env } from "../env.js";

const DAY = 86_400_000;

/**
 * Pre-dunning scanner + sweep (docs/phase-4-pre-dunning.md, locked decision
 * #1). One daily job walks every CONNECTED account:
 *
 *  - sweep: re-verify OPEN cases against live Stripe — card updated →
 *    RESOLVED (the prevented failure), month over → LAPSED, subscription
 *    gone → CANCELED.
 *  - scan: enumerate active/trialing subscriptions FROM THE STRIPE API (our
 *    Customer mirror only knows customers who failed a payment — pre-dunning
 *    targets the healthy ones), find default cards dying within the horizon,
 *    open cases and schedule touches.
 *
 * Same doctrine as dunning: this is schedule-ahead; the send worker re-runs
 * `checkExpiryCase` immediately before each touch and is the authority.
 */
export async function registerExpiryWorkers() {
  await ensureQueue(QUEUES.expiryScan);

  await boss.work<ExpiryScanJob>(QUEUES.expiryScan, async (jobs) => {
    for (const job of jobs) {
      await runExpiryScan(job.data?.trigger ?? "cron");
    }
  });

  // Daily 03:00 UTC. boss.schedule upserts — safe on every boot.
  await boss.schedule(QUEUES.expiryScan, "0 3 * * *", { trigger: "cron" } satisfies ExpiryScanJob);
}

type ConnectionWithSettings = Prisma.StripeConnectionGetPayload<{
  include: { organization: { include: { settings: true } } };
}>;

type CaseWithCustomer = Prisma.CardExpiryCaseGetPayload<{ include: { customer: true } }>;

export async function runExpiryScan(trigger: string) {
  const connections = await prisma.stripeConnection.findMany({
    where: { status: "CONNECTED" },
    include: { organization: { include: { settings: true } } },
  });
  console.log(`[expiry] scan start (${trigger}): ${connections.length} connection(s)`);

  for (const connection of connections) {
    // One broken account must not starve the rest; handlers are idempotent
    // and the next daily run (or the dev script) picks up where this left off.
    try {
      await sweepConnection(connection);
      await scanConnection(connection);
    } catch (err) {
      console.error(`[expiry] scan failed for ${connection.stripeAccountId}:`, err);
    }
  }
  console.log(`[expiry] scan done (${trigger})`);
}

// ---------------------------------------------------------------------------
// Sweep — re-verify open cases (resolution is never >1 day stale)
// ---------------------------------------------------------------------------

async function sweepConnection(connection: ConnectionWithSettings) {
  const openCases = await prisma.cardExpiryCase.findMany({
    where: { connectionId: connection.id, status: "OPEN" },
    include: { customer: true },
  });

  for (const expiryCase of openCases) {
    try {
      const verdict = await checkExpiryCase(connection, expiryCase);
      await applyExpiryVerdict(expiryCase, verdict);
    } catch (err) {
      console.warn(`[expiry] sweep failed for case ${expiryCase.id}:`, err);
    }
  }
}

export type ExpiryVerdict =
  | { outcome: "open" }
  | { outcome: "resolved"; reason: string }
  | { outcome: "lapsed" }
  | { outcome: "canceled"; reason: string };

/**
 * Live-Stripe verdict on an open expiry case. Shared by the sweep and the
 * send worker's guard chain (locked decision #6) — the watched card counts
 * as handled when it was updated in place (network updater), replaced,
 * detached, or simply is no longer what we'd charge.
 */
export async function checkExpiryCase(
  connection: StripeConnection,
  expiryCase: CaseWithCustomer,
): Promise<ExpiryVerdict> {
  if (expiryMoment(expiryCase.expYear, expiryCase.expMonth).getTime() <= Date.now()) {
    return { outcome: "lapsed" };
  }

  const account = { stripeAccount: connection.stripeAccountId };

  let pm: Stripe.PaymentMethod;
  try {
    pm = await stripe.paymentMethods.retrieve(expiryCase.stripePaymentMethodId, undefined, account);
  } catch (err) {
    // Only a genuinely-missing payment method counts as handled (audit B1).
    // A transient failure (rate limit, 5xx, network) must NOT close the
    // case as a prevented failure — rethrow so the sweep logs and retries
    // next run, and a send-guard call fails the job so the touch stays
    // SCHEDULED for the pg-boss retry.
    if (
      err instanceof Stripe.errors.StripeInvalidRequestError &&
      (err.code === "resource_missing" || err.statusCode === 404)
    ) {
      return { outcome: "resolved", reason: "card removed" };
    }
    throw err;
  }
  const card = pm.card;
  if (!card) return { outcome: "resolved", reason: "payment method changed" };
  if (card.exp_year !== expiryCase.expYear || card.exp_month !== expiryCase.expMonth) {
    // In-place update — Stripe's network card updater keeps the PM id.
    return { outcome: "resolved", reason: `card updated (now expires ${card.exp_month}/${card.exp_year})` };
  }
  if (!pm.customer) return { outcome: "resolved", reason: "card detached" };

  // Same card, same expiry — but is it still what Stripe would charge?
  // past_due counts as live: a failed payment opens a dunning case, it
  // doesn't make the expiring card irrelevant.
  const subs = await stripe.subscriptions.list(
    {
      customer: expiryCase.customer.stripeCustomerId,
      status: "all",
      limit: 100,
      expand: ["data.default_payment_method"],
    },
    account,
  );
  const live = subs.data.filter((s) => ["active", "trialing", "past_due"].includes(s.status));
  if (live.length === 0) return { outcome: "canceled", reason: "no active subscription" };

  let customerDefaultPmId: string | null | undefined;
  for (const sub of live) {
    const subPm = sub.default_payment_method;
    let effectiveId = typeof subPm === "object" && subPm !== null ? subPm.id : (subPm ?? null);
    if (!effectiveId) {
      if (customerDefaultPmId === undefined) {
        const customer = await stripe.customers.retrieve(expiryCase.customer.stripeCustomerId, undefined, account);
        customerDefaultPmId = customer.deleted
          ? null
          : typeof customer.invoice_settings?.default_payment_method === "string"
            ? customer.invoice_settings.default_payment_method
            : (customer.invoice_settings?.default_payment_method?.id ?? null);
      }
      effectiveId = customerDefaultPmId;
    }
    if (effectiveId === expiryCase.stripePaymentMethodId) return { outcome: "open" };
  }
  return { outcome: "resolved", reason: "no longer the default card" };
}

/** Status-guarded close; cancels pending touches. Returns true if applied. */
export async function applyExpiryVerdict(
  expiryCase: CardExpiryCase,
  verdict: ExpiryVerdict,
): Promise<boolean> {
  if (verdict.outcome === "open") return false;

  const now = new Date();
  const data =
    verdict.outcome === "resolved"
      ? { status: "RESOLVED" as const, resolvedAt: now, closedAt: now }
      : verdict.outcome === "lapsed"
        ? { status: "LAPSED" as const, closedAt: now }
        : { status: "CANCELED" as const, closedAt: now };
  const reason =
    verdict.outcome === "lapsed" ? "expiry month ended" : verdict.reason;

  const { count } = await prisma.cardExpiryCase.updateMany({
    where: { id: expiryCase.id, status: "OPEN" },
    data,
  });
  if (count === 0) return false;

  await prisma.emailSend.updateMany({
    where: { cardExpiryCaseId: expiryCase.id, status: "SCHEDULED" },
    data: { status: "CANCELED", error: reason },
  });
  console.log(`[expiry] case ${expiryCase.id} → ${data.status} (${reason})`);
  return true;
}

// ---------------------------------------------------------------------------
// Scan — find expiring default cards on healthy subscriptions
// ---------------------------------------------------------------------------

interface Candidate {
  stripeCustomer: Stripe.Customer;
  pm: Stripe.PaymentMethod;
  /** Sum of matched subscription amounts (minor units) — protectedAmount. */
  amount: number;
  currency: string;
}

async function scanConnection(connection: ConnectionWithSettings) {
  const settings = connection.organization.settings;
  const timezone = settings?.timezone ?? "UTC";
  const touch1Enabled = settings?.expiryTouch1Enabled ?? true;
  const touch2Enabled = settings?.expiryTouch2Enabled ?? true;
  const now = Date.now();
  const horizon = now + EXPIRY_SCAN_HORIZON_DAYS * DAY;
  const account = { stripeAccount: connection.stripeAccountId };

  // One case per (customer, pm, expiry): several subscriptions on one card
  // collapse into a single candidate with summed amounts (locked decision #2).
  const candidates = new Map<string, Candidate>();
  const customerPmCache = new Map<string, Stripe.PaymentMethod | null>();

  for (const status of ["active", "trialing"] as const) {
    const subs = stripe.subscriptions.list(
      { status, limit: 100, expand: ["data.default_payment_method", "data.customer"] },
      account,
    );
    for await (const sub of subs) {
      const customer = sub.customer;
      if (typeof customer === "string" || customer.deleted) continue;

      let pm = typeof sub.default_payment_method === "object" ? sub.default_payment_method : null;
      if (!pm) pm = await defaultPmForCustomer(connection, customer.id, customerPmCache);
      const card = pm?.card;
      if (!pm || !card) continue; // not a card (or no default PM) — out of scope

      const dies = expiryMoment(card.exp_year, card.exp_month).getTime();
      if (dies <= now || dies > horizon) continue;

      const key = `${customer.id}:${pm.id}:${card.exp_year}-${card.exp_month}`;
      const item = sub.items.data[0];
      const amount = (item?.price.unit_amount ?? 0) * (item?.quantity ?? 1);
      const existing = candidates.get(key);
      if (existing) existing.amount += amount;
      else candidates.set(key, { stripeCustomer: customer, pm, amount, currency: sub.currency });
    }
  }

  let opened = 0;
  for (const candidate of candidates.values()) {
    if (await openCaseFor(connection, timezone, touch1Enabled, touch2Enabled, candidate)) opened++;
  }
  if (candidates.size > 0) {
    console.log(
      `[expiry] ${connection.stripeAccountId}: ${candidates.size} expiring card(s), ${opened} new case(s)`,
    );
  }
}

/** Customer-level default PM fallback, cached per scan run. */
async function defaultPmForCustomer(
  connection: ConnectionWithSettings,
  stripeCustomerId: string,
  cache: Map<string, Stripe.PaymentMethod | null>,
): Promise<Stripe.PaymentMethod | null> {
  const cached = cache.get(stripeCustomerId);
  if (cached !== undefined) return cached;

  let pm: Stripe.PaymentMethod | null = null;
  try {
    const customer = await stripe.customers.retrieve(
      stripeCustomerId,
      { expand: ["invoice_settings.default_payment_method"] },
      { stripeAccount: connection.stripeAccountId },
    );
    if (!customer.deleted) {
      const def = customer.invoice_settings?.default_payment_method;
      if (def && typeof def === "object") pm = def;
    }
  } catch (err) {
    console.warn(`[expiry] customer ${stripeCustomerId} PM lookup failed:`, err);
  }
  cache.set(stripeCustomerId, pm);
  return pm;
}

/** Returns true when a NEW case was opened (existing open cases self-heal). */
async function openCaseFor(
  connection: ConnectionWithSettings,
  timezone: string,
  touch1Enabled: boolean,
  touch2Enabled: boolean,
  candidate: Candidate,
): Promise<boolean> {
  const card = candidate.pm.card!;

  // Mirror the customer — same upsert as the failure handler; pre-dunning is
  // usually their first contact with our database.
  const customer = await prisma.customer.upsert({
    where: {
      connectionId_stripeCustomerId: {
        connectionId: connection.id,
        stripeCustomerId: candidate.stripeCustomer.id,
      },
    },
    create: {
      connectionId: connection.id,
      stripeCustomerId: candidate.stripeCustomer.id,
      email: candidate.stripeCustomer.email,
      name: candidate.stripeCustomer.name ?? null,
    },
    update: {
      email: candidate.stripeCustomer.email,
      name: candidate.stripeCustomer.name ?? null,
    },
  });

  // Never overlap an active dunning sequence (locked decision #5) — the
  // failed payment owns the conversation. The send guard re-checks this.
  const openDunning = await prisma.dunningCase.findFirst({
    where: { customerId: customer.id, status: { in: ["ACTIVE", "PAUSED", "SUPPRESSED"] } },
    select: { id: true },
  });
  if (openDunning) return false;

  let expiryCase: CardExpiryCase;
  let isNew = true;
  try {
    expiryCase = await prisma.cardExpiryCase.create({
      data: {
        connectionId: connection.id,
        customerId: customer.id,
        stripePaymentMethodId: candidate.pm.id,
        cardBrand: card.brand ?? null,
        cardLast4: card.last4 ?? null,
        expMonth: card.exp_month,
        expYear: card.exp_year,
        protectedAmount: candidate.amount,
        currency: candidate.currency,
      },
    });
    console.log(
      `[expiry] opened case ${expiryCase.id}: ${customer.email ?? customer.id} ` +
        `${card.brand} •••• ${card.last4} expires ${card.exp_month}/${card.exp_year}`,
    );
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // Already watched (or already closed once — closed cases never reopen).
    // Re-kick scheduling for open cases so lost jobs self-heal, like the
    // dunning sequence engine.
    const existing = await prisma.cardExpiryCase.findUnique({
      where: {
        customerId_stripePaymentMethodId_expYear_expMonth: {
          customerId: customer.id,
          stripePaymentMethodId: candidate.pm.id,
          expYear: card.exp_year,
          expMonth: card.exp_month,
        },
      },
    });
    if (!existing || existing.status !== "OPEN") return false;
    expiryCase = existing;
    isNew = false;
  }

  await scheduleExpiryTouches(expiryCase, timezone, touch1Enabled, touch2Enabled);
  return isNew;
}

/**
 * Touch rows + delayed jobs: −21d and −7d before the end of the expiry
 * month, clamped to 10:00 workspace time, never in the past (locked decision
 * #4). A case first seen with <14 days left skips touch 1 with a visible
 * CANCELED row. Disabled touches get no row — re-enabling before their
 * moment lets a later scan schedule them; disabling after scheduling is
 * caught by the send guard.
 */
export async function scheduleExpiryTouches(
  expiryCase: CardExpiryCase,
  timezone: string,
  touch1Enabled: boolean,
  touch2Enabled: boolean,
) {
  const dies = expiryMoment(expiryCase.expYear, expiryCase.expMonth).getTime();
  const now = Date.now();

  const touches = [
    {
      order: EXPIRY_TOUCH_1_STAGE_ORDER,
      enabled: touch1Enabled,
      leadDays: EXPIRY_TOUCH_1_LEAD_DAYS,
      tooClose: dies - now < EXPIRY_TOUCH_1_MIN_LEAD_DAYS * DAY,
    },
    {
      order: EXPIRY_TOUCH_2_STAGE_ORDER,
      enabled: touch2Enabled,
      leadDays: EXPIRY_TOUCH_2_LEAD_DAYS,
      tooClose: false,
    },
  ];

  const existingSends = await prisma.emailSend.findMany({
    where: { cardExpiryCaseId: expiryCase.id },
  });
  const byStage = new Map(existingSends.map((s) => [s.stageOrder, s]));

  for (const touch of touches) {
    if (!touch.enabled) continue;

    const prior = byStage.get(touch.order);
    if (prior && prior.status !== "SCHEDULED") continue; // sent or canceled — done forever

    let emailSendId: string;
    let scheduledFor: Date;

    if (prior) {
      // Keep its time; just self-heal a possibly lost job (singletonKey
      // rejects the enqueue while the original delayed job still waits).
      emailSendId = prior.id;
      scheduledFor = prior.scheduledFor;
    } else {
      // 10:00 workspace time on the touch's natural day, floored to now.
      const naturalDay = new Date(dies - touch.leadDays * DAY);
      scheduledFor = new Date(
        Math.max(
          now,
          startOfDayInZone(naturalDay, timezone).getTime() + EXPIRY_SEND_HOUR * 3_600_000,
        ),
      );
      try {
        const created = await prisma.emailSend.create({
          data: {
            cardExpiryCaseId: expiryCase.id,
            kind: "PRE_DUNNING",
            stageOrder: touch.order,
            scheduledFor,
            ...(touch.tooClose
              ? { status: "CANCELED" as const, error: "opened too close to expiry" }
              : {}),
          },
        });
        if (touch.tooClose) continue; // visible history row, never a job
        emailSendId = created.id;
      } catch (err) {
        // P2002 = a concurrent run created this touch; that run enqueues it.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }

    await boss.send(QUEUES.sendDunningEmail, { emailSendId } satisfies SendDunningEmailJob, {
      startAfter: scheduledFor,
      singletonKey: emailSendId,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Send path — guard-at-send for PRE_DUNNING touches (locked decision #6)
// ---------------------------------------------------------------------------

/**
 * Delivers one pre-dunning touch. Same doctrine as deliverScheduledEmail
 * (jobs/dunning.ts) — everything the scanner promised is re-verified here,
 * ending with a LIVE Stripe re-check of the card itself: a customer who
 * already updated their card gets a resolved case, never an email.
 *
 * Duplicate-send safety is identical: status guard + "short" queue policy +
 * Resend Idempotency-Key = emailSendId.
 */
export async function deliverExpiryEmail(emailSendId: string) {
  const send = await prisma.emailSend.findUnique({
    where: { id: emailSendId },
    include: {
      cardExpiryCase: {
        include: {
          customer: true,
          connection: { include: { organization: { include: { settings: true } } } },
        },
      },
    },
  });
  if (!send) return;
  if (send.status !== "SCHEDULED") return; // sent or canceled — done
  const expiryCase = send.cardExpiryCase;
  if (!expiryCase) return;

  const cancel = async (reason: string) => {
    await prisma.emailSend.updateMany({
      where: { id: send.id, status: "SCHEDULED" },
      data: { status: "CANCELED", error: reason },
    });
    console.log(`[expiry] canceled touch ${send.stageOrder} (${send.id}): ${reason}`);
  };

  // Guard chain — cheapest state checks first, live Stripe last.
  if (expiryCase.status !== "OPEN") {
    return cancel(`case is ${expiryCase.status}`);
  }
  if (expiryCase.connection.status !== "CONNECTED") {
    return cancel(`connection is ${expiryCase.connection.status}`);
  }
  const settings = expiryCase.connection.organization.settings;
  const enabled =
    send.stageOrder === EXPIRY_TOUCH_1_STAGE_ORDER
      ? (settings?.expiryTouch1Enabled ?? true)
      : (settings?.expiryTouch2Enabled ?? true);
  if (!enabled) {
    return cancel("touch disabled in workspace settings");
  }
  // Never overlap an active dunning sequence (locked decision #5) — the
  // failed payment owns the conversation.
  const openDunning = await prisma.dunningCase.findFirst({
    where: { customerId: expiryCase.customerId, status: { in: ["ACTIVE", "PAUSED", "SUPPRESSED"] } },
    select: { id: true },
  });
  if (openDunning) {
    return cancel("customer has an open dunning case");
  }
  const toEmail = expiryCase.customer.email;
  if (!toEmail) {
    return cancel("customer has no email address");
  }
  const suppression = await prisma.suppressionEntry.findUnique({
    where: {
      organizationId_email: {
        organizationId: expiryCase.connection.organizationId,
        email: toEmail,
      },
    },
  });
  if (suppression) {
    // Cancel the touch but keep the case OPEN (locked decision #6): a
    // customer we can't email can still update their card.
    return cancel(`email suppressed (${suppression.reason})`);
  }

  // The authority: is the watched card still the live, unexpired default?
  const verdict = await checkExpiryCase(expiryCase.connection, expiryCase);
  if (verdict.outcome !== "open") {
    // Closes the case and cancels every pending touch, including this row.
    await applyExpiryVerdict(expiryCase, verdict);
    return;
  }

  const organization = expiryCase.connection.organization;
  const isTouch1 = send.stageOrder === EXPIRY_TOUCH_1_STAGE_ORDER;
  const subjectTemplate = isTouch1 ? EXPIRY_TOUCH_1_SUBJECT : EXPIRY_TOUCH_2_SUBJECT;
  const templateKey = isTouch1 ? EXPIRY_TOUCH_1_TEMPLATE_KEY : EXPIRY_TOUCH_2_TEMPLATE_KEY;

  // Plan name is best-effort: healthy customers usually have no Subscription
  // mirror row (those are written on payment failure).
  const subscription = await prisma.subscription.findFirst({
    where: { customerId: expiryCase.customerId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
    orderBy: { createdAt: "asc" },
  });

  const cardBrand = formatCardBrand(expiryCase.cardBrand);
  const cardExpiry = formatCardExpiry(expiryCase.expYear, expiryCase.expMonth);
  const updateUrl = `${env.API_URL}/r/expiry/portal/${makeCaseToken(expiryCase.id, "expiry-portal")}`;
  const unsubscribeUrl = `${env.API_URL}/r/expiry/unsubscribe/${makeCaseToken(expiryCase.id, "expiry-unsubscribe")}`;

  const subject = applyMergeVars(subjectTemplate, {
    company_name: organization.name,
    customer_name: expiryCase.customer.name ?? "there",
    plan_name: subscription?.planName ?? "subscription",
    card_brand: cardBrand ?? "card",
    card_last4: expiryCase.cardLast4 ?? "on file",
    card_expiry: cardExpiry,
    update_payment_link: updateUrl,
  });

  try {
    const { html, text } = await renderExpiryEmail(templateKey, {
      customerName: expiryCase.customer.name,
      companyName: organization.name,
      planName: subscription?.planName ?? null,
      cardBrand,
      cardLast4: expiryCase.cardLast4,
      cardExpiry,
      brandColor: settings?.brandColor ?? null,
      logoUrl: settings?.logoUrl ?? null,
      updateUrl,
      unsubscribeUrl,
    });

    const resendEmailId = await sendDunningEmail({
      to: toEmail,
      fromName: organization.name,
      replyTo: settings?.replyTo ?? null,
      subject,
      html,
      text,
      unsubscribeUrl,
      idempotencyKey: send.id,
    });

    await prisma.emailSend.update({
      where: { id: send.id },
      data: { status: "SENT", sentAt: new Date(), resendEmailId, toEmail, subject, error: null },
    });
    console.log(
      `[expiry] sent touch ${send.stageOrder} (${templateKey}) for case ${expiryCase.id} → ${toEmail}`,
    );
  } catch (err) {
    // Stay SCHEDULED so the pg-boss retry passes the status guard; record
    // the error for visibility. Rethrow → retry policy applies.
    await prisma.emailSend.updateMany({
      where: { id: send.id, status: "SCHEDULED" },
      data: { error: String(err) },
    });
    throw err;
  }
}
