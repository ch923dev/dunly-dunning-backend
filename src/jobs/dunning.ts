import {
  boss,
  ensureQueue,
  QUEUES,
  type DunningSequenceJob,
  type SendDunningEmailJob,
} from "../lib/queue.js";
import { prisma } from "../lib/prisma.js";
import { Prisma, type EmailSendStatus } from "../generated/prisma/client.js";
import {
  ensureDefaultCampaign,
  REACTIVATION_STAGE_ORDER,
  REACTIVATION_SUBJECT,
  REACTIVATION_TEMPLATE_KEY,
} from "../lib/campaigns.js";
import {
  applyMergeVars,
  applyMergeVarsHtml,
  formatAmount,
  renderDunningEmail,
  sendDunningEmail,
} from "../lib/email.js";
import { makeCaseToken } from "../lib/tokens.js";
import { clampToWindow, hourInZone, isInWindow } from "../lib/send-window.js";
import { deliverExpiryEmail } from "./expiry.js";
import { deliverReplyForward } from "./replies.js";
import { makeReplyAddress } from "../lib/replies.js";
import { env } from "../env.js";

/** Statuses meaning "this stage already left the building" — never reschedule. */
const SENT_STATUSES: EmailSendStatus[] = ["SENT", "DELIVERED", "OPENED", "CLICKED", "BOUNCED"];

/**
 * Sequence engine (docs/phase-1-dunning-core.md "Core design").
 *
 * schedule-ahead: this worker turns an ACTIVE case into EmailSend rows +
 * delayed send jobs. guard-at-send: the send worker (build step 4) is the
 * authority — everything scheduled here is re-checked before anything is
 * actually sent, so over-enqueueing is always safe.
 */
export async function registerDunningWorkers() {
  await ensureQueue(QUEUES.dunningSequence);
  await ensureQueue(QUEUES.sendDunningEmail);

  await boss.work<DunningSequenceJob>(
    QUEUES.dunningSequence,
    { batchSize: 5 },
    async (jobs) => {
      const failures: unknown[] = [];
      for (const job of jobs) {
        try {
          await runSequenceForCase(job.data.dunningCaseId);
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  );

  await boss.work<SendDunningEmailJob>(
    QUEUES.sendDunningEmail,
    { batchSize: 5 },
    async (jobs) => {
      const failures: unknown[] = [];
      for (const job of jobs) {
        try {
          await deliverScheduledEmail(job.data.emailSendId);
        } catch (err) {
          failures.push(err);
        }
      }
      if (failures.length > 0) throw failures[0];
    },
  );
}

/**
 * Idempotent kick: safe to call on every invoice.payment_failed delivery
 * (Stripe re-fires it per retry attempt — each call just re-verifies the
 * schedule). singletonKey collapses concurrent kicks for the same case.
 */
export async function enqueueSequence(dunningCaseId: string) {
  await boss.send(QUEUES.dunningSequence, { dunningCaseId } satisfies DunningSequenceJob, {
    singletonKey: dunningCaseId,
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  });
}

export async function runSequenceForCase(dunningCaseId: string) {
  const dunningCase = await prisma.dunningCase.findUnique({
    where: { id: dunningCaseId },
    include: {
      connection: { include: { organization: { include: { settings: true } } } },
      emailSends: true,
    },
  });
  if (!dunningCase) return;
  // A stop condition may have closed the case before this job ran.
  if (dunningCase.status !== "ACTIVE") return;

  const timezone = dunningCase.connection.organization.settings?.timezone ?? "UTC";

  // Pin the campaign at first scheduling (snapshot semantics — mid-sequence
  // campaign edits never shift an in-flight case).
  let campaign = dunningCase.campaignId
    ? await prisma.dunningCampaign.findUnique({
        where: { id: dunningCase.campaignId },
        include: { steps: { orderBy: { order: "asc" } } },
      })
    : null;
  if (!campaign) {
    campaign = await ensureDefaultCampaign(dunningCase.connection.organizationId);
    await prisma.dunningCase.update({
      where: { id: dunningCase.id },
      data: { campaignId: campaign.id },
    });
  }

  const sendsByStage = new Map(dunningCase.emailSends.map((s) => [s.stageOrder, s]));
  const enabledSteps = campaign.steps.filter((s) => s.isEnabled);

  // Per-stage amount threshold (phase-2 step 6): below-threshold stages get a
  // CANCELED row for history but never a job.
  const skippedByAmount = (step: (typeof enabledSteps)[number]) =>
    step.skipIfAmountBelow !== null && dunningCase.amountDue < step.skipIfAmountBelow;

  // Stages still owed to this case: never created, or CANCELED before sending
  // (reopen-as-resume, locked decision #2 — sent stages never repeat).
  // Threshold-skipped stages don't count — they'd skew the resume anchor.
  const owed = enabledSteps.filter((step) => {
    if (skippedByAmount(step)) return false;
    const existing = sendsByStage.get(step.order);
    return !existing || existing.status === "CANCELED";
  });

  // Resume anchoring: when earlier stages already went out (case re-failed
  // after recovery), shift the remaining schedule so the first owed stage
  // sends immediately and the original spacing between stages is preserved.
  // Fresh cases keep their natural delays (offset 0 — stage 1 is delay 0).
  const anySent = dunningCase.emailSends.some((s) => SENT_STATUSES.includes(s.status));
  const offsetHours = anySent && owed.length > 0 ? Math.min(...owed.map((s) => s.delayHours)) : 0;

  const now = Date.now();
  let scheduled = 0;

  // Natural send time, clamped forward into the stage's send window (if any).
  const scheduleTimeFor = (step: (typeof enabledSteps)[number]) => {
    const natural = new Date(
      Math.max(now, dunningCase.failedAt.getTime() + (step.delayHours - offsetHours) * 3_600_000),
    );
    if (step.sendWindowStart === null || step.sendWindowEnd === null) return natural;
    return clampToWindow(natural, timezone, step.sendWindowStart, step.sendWindowEnd);
  };

  for (const step of enabledSteps) {
    const existing = sendsByStage.get(step.order);
    if (existing && SENT_STATUSES.includes(existing.status)) continue;

    if (skippedByAmount(step)) {
      const reason = `amount below stage threshold (${dunningCase.amountDue} < ${step.skipIfAmountBelow})`;
      if (!existing) {
        // History row, never a job — the stage visibly skipped, not missing.
        try {
          await prisma.emailSend.create({
            data: {
              dunningCaseId: dunningCase.id,
              kind: "SEQUENCE",
              stageOrder: step.order,
              scheduledFor: scheduleTimeFor(step),
              status: "CANCELED",
              error: reason,
            },
          });
        } catch (err) {
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
            throw err;
          }
        }
      } else {
        // Threshold added after scheduling — cancel the pending send.
        await prisma.emailSend.updateMany({
          where: { id: existing.id, status: "SCHEDULED" },
          data: { status: "CANCELED", error: reason },
        });
      }
      continue;
    }

    let emailSendId: string;
    let scheduledFor: Date;

    if (!existing) {
      scheduledFor = scheduleTimeFor(step);
      try {
        const created = await prisma.emailSend.create({
          data: {
            dunningCaseId: dunningCase.id,
            kind: "SEQUENCE",
            stageOrder: step.order,
            scheduledFor,
          },
        });
        emailSendId = created.id;
        scheduled++;
      } catch (err) {
        // P2002 = a concurrent run created this stage; that run enqueues it.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    } else if (existing.status === "CANCELED") {
      scheduledFor = scheduleTimeFor(step);
      // Guarded resume — a concurrent stop condition can't be overwritten.
      const { count } = await prisma.emailSend.updateMany({
        where: { id: existing.id, status: "CANCELED" },
        data: { status: "SCHEDULED", scheduledFor, error: null },
      });
      if (count === 0) continue;
      emailSendId = existing.id;
      scheduled++;
    } else {
      // Already SCHEDULED — keep its time, just self-heal a possibly lost job
      // (singletonKey rejects the enqueue while the original job still waits).
      emailSendId = existing.id;
      scheduledFor = existing.scheduledFor;
    }

    await boss.send(QUEUES.sendDunningEmail, { emailSendId } satisfies SendDunningEmailJob, {
      startAfter: scheduledFor,
      singletonKey: emailSendId,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });
  }

  if (scheduled > 0) {
    console.log(
      `[dunning] case ${dunningCase.id}: scheduled ${scheduled} send(s) (campaign ${campaign.name})`,
    );
  }
}

/**
 * One-shot reactivation email for a case closed LOST_INVOLUNTARY (phase-1
 * spec, locked decision #1). The reserved stageOrder makes the "never twice
 * per case" constraint cover it; the send worker re-verifies case status and
 * suppression before delivery.
 */
export async function scheduleReactivation(dunningCaseId: string) {
  let emailSendId: string;
  try {
    const created = await prisma.emailSend.create({
      data: {
        dunningCaseId,
        kind: "REACTIVATION",
        stageOrder: REACTIVATION_STAGE_ORDER,
        scheduledFor: new Date(),
      },
    });
    emailSendId = created.id;
  } catch (err) {
    // P2002: already scheduled once for this case — one-shot means one-shot.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }

  await boss.send(QUEUES.sendDunningEmail, { emailSendId } satisfies SendDunningEmailJob, {
    singletonKey: emailSendId,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
  });
  console.log(`[dunning] scheduled reactivation email for case ${dunningCaseId}`);
}

/**
 * Send worker — THE authority of guard-at-send (phase-1 spec "Core design").
 * Everything the scheduler promised is re-verified here; any failed guard
 * cancels the send instead of mailing. A missed cancellation upstream can
 * therefore never cause a wrong email.
 *
 * Duplicate-send safety: status guard (DB) + "short" queue policy (queue) +
 * Resend Idempotency-Key = emailSendId (provider). Send happens BEFORE the
 * row flips to SENT so a crash in between retries into the provider-side
 * dedupe rather than skipping the email.
 */
export async function deliverScheduledEmail(emailSendId: string) {
  const send = await prisma.emailSend.findUnique({
    where: { id: emailSendId },
    include: {
      dunningCase: {
        include: {
          customer: true,
          connection: { include: { organization: { include: { settings: true } } } },
          campaign: { include: { steps: true } },
        },
      },
    },
  });
  if (!send) return;
  if (send.status !== "SCHEDULED") return; // sent or canceled — done

  // PRE_DUNNING sends take the phase-4 expiry path (separate guards, merge
  // vars and tokens); REPLY_FORWARD takes the phase-5 merchant-notification
  // path (thin guards). The dunning kinds always carry a case.
  if (send.kind === "PRE_DUNNING") return deliverExpiryEmail(send.id);
  if (send.kind === "REPLY_FORWARD") return deliverReplyForward(send.id);
  if (!send.dunningCase) return;

  const dunningCase = send.dunningCase;
  const cancel = async (reason: string) => {
    await prisma.emailSend.updateMany({
      where: { id: send.id, status: "SCHEDULED" },
      data: { status: "CANCELED", error: reason },
    });
    console.log(`[dunning] canceled send ${send.id} (stage ${send.stageOrder}): ${reason}`);
  };

  // Guard chain — order matters: cheapest state checks first.
  // PAUSED holds, never cancels (phase-3 locked decision #2): the row stays
  // SCHEDULED and this job completes, leaving no future job — "held". The
  // resume endpoint re-enqueues held rows via the sequence worker's
  // self-heal path. Stop conditions still close paused cases directly.
  if (send.kind === "SEQUENCE" && dunningCase.status === "PAUSED") {
    console.log(`[dunning] held send ${send.id} (stage ${send.stageOrder}): case is paused`);
    return;
  }
  if (send.kind === "SEQUENCE" && dunningCase.status !== "ACTIVE") {
    return cancel(`case is ${dunningCase.status}`);
  }
  // Reactivation only ever goes to involuntary cancellations (locked
  // decision #1); a recovery/voluntary reclassification after scheduling
  // must kill it.
  if (send.kind === "REACTIVATION" && dunningCase.status !== "LOST_INVOLUNTARY") {
    return cancel(`reactivation but case is ${dunningCase.status}`);
  }
  if (dunningCase.connection.status !== "CONNECTED") {
    return cancel(`connection is ${dunningCase.connection.status}`);
  }
  const toEmail = dunningCase.customer.email;
  if (!toEmail) {
    return cancel("customer has no email address");
  }
  const suppression = await prisma.suppressionEntry.findUnique({
    where: {
      organizationId_email: {
        organizationId: dunningCase.connection.organizationId,
        email: toEmail,
      },
    },
  });
  if (suppression) {
    await cancel(`email suppressed (${suppression.reason})`);
    // Keep the case state honest: a still-ACTIVE case for a suppressed
    // address becomes SUPPRESSED (Stripe retries continue regardless).
    if (send.kind === "SEQUENCE") {
      await prisma.dunningCase.updateMany({
        where: { id: dunningCase.id, status: "ACTIVE" },
        data: { status: "SUPPRESSED" },
      });
      await prisma.emailSend.updateMany({
        where: { dunningCaseId: dunningCase.id, status: "SCHEDULED" },
        data: { status: "CANCELED", error: `email suppressed (${suppression.reason})` },
      });
    }
    return;
  }

  const organization = dunningCase.connection.organization;
  const settings = organization.settings;

  // Resolve subject + template (+ optional custom body) for this stage.
  let subjectTemplate: string;
  let templateKey: string;
  let bodyTemplate: string | null = null;
  if (send.kind === "REACTIVATION") {
    subjectTemplate = REACTIVATION_SUBJECT;
    templateKey = REACTIVATION_TEMPLATE_KEY;
  } else {
    const step = dunningCase.campaign?.steps.find((s) => s.order === send.stageOrder);
    if (!step) return cancel(`campaign step ${send.stageOrder} no longer exists`);

    // Per-stage controls, re-checked at the authority (settings may have
    // changed since scheduling).
    if (step.skipIfAmountBelow !== null && dunningCase.amountDue < step.skipIfAmountBelow) {
      return cancel(
        `amount below stage threshold (${dunningCase.amountDue} < ${step.skipIfAmountBelow})`,
      );
    }
    if (step.sendWindowStart !== null && step.sendWindowEnd !== null) {
      const timezone = settings?.timezone ?? "UTC";
      const now = new Date();
      if (!isInWindow(hourInZone(now, timezone), step.sendWindowStart, step.sendWindowEnd)) {
        // Outside the window: DEFER, never cancel — re-enqueue this same
        // emailSendId at the next window opening. The row stays SCHEDULED,
        // so every idempotency layer keeps holding.
        const next = clampToWindow(now, timezone, step.sendWindowStart, step.sendWindowEnd);
        await prisma.emailSend.update({
          where: { id: send.id },
          data: { scheduledFor: next },
        });
        await boss.send(QUEUES.sendDunningEmail, { emailSendId: send.id } satisfies SendDunningEmailJob, {
          startAfter: next,
          singletonKey: send.id,
          retryLimit: 3,
          retryDelay: 60,
          retryBackoff: true,
        });
        console.log(
          `[dunning] deferred send ${send.id} (stage ${send.stageOrder}) to ${next.toISOString()} (window ${step.sendWindowStart}–${step.sendWindowEnd} ${timezone})`,
        );
        return;
      }
    }

    subjectTemplate = step.subject;
    templateKey = step.templateKey;
    bodyTemplate = step.bodyHtml;
  }
  const subscription = dunningCase.stripeSubscriptionId
    ? await prisma.subscription.findUnique({
        where: { stripeSubscriptionId: dunningCase.stripeSubscriptionId },
      })
    : null;

  const amountFormatted = formatAmount(dunningCase.amountDue, dunningCase.currency);
  const portalUrl = `${env.API_URL}/r/portal/${makeCaseToken(dunningCase.id, "portal")}`;
  const unsubscribeUrl = `${env.API_URL}/r/unsubscribe/${makeCaseToken(dunningCase.id, "unsubscribe")}`;

  const payUrl = dunningCase.hostedInvoiceUrl ?? portalUrl;
  const mergeVars = {
    company_name: organization.name,
    customer_name: dunningCase.customer.name ?? "there",
    amount_due: amountFormatted,
    plan_name: subscription?.planName ?? "subscription",
    update_payment_link: payUrl,
  };

  const subject = applyMergeVars(subjectTemplate, mergeVars);
  // Custom bodies are stored sanitized; values are escaped at substitution
  // (customer-controlled data must never reach the HTML raw).
  const bodyHtml = bodyTemplate ? applyMergeVarsHtml(bodyTemplate, mergeVars) : null;

  try {
    const { html, text } = await renderDunningEmail(
      templateKey,
      {
        customerName: dunningCase.customer.name,
        companyName: organization.name,
        planName: subscription?.planName ?? null,
        amountFormatted,
        brandColor: settings?.brandColor ?? null,
        logoUrl: settings?.logoUrl ?? null,
        payUrl,
        portalUrl,
        unsubscribeUrl,
      },
      bodyHtml,
    );

    // Stop-on-reply (phase-5, locked decision #1): reroute replies through
    // Dunly when the workspace toggle is on and the receiving domain is
    // configured; otherwise byte-identical to the old behavior.
    const replyAddress =
      (settings?.stopOnReplyEnabled ?? true) ? makeReplyAddress(dunningCase.id) : null;

    const resendEmailId = await sendDunningEmail({
      to: toEmail,
      fromName: organization.name,
      replyTo: replyAddress ?? settings?.replyTo ?? null,
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
      `[dunning] sent stage ${send.stageOrder} (${templateKey}) for case ${dunningCase.id} → ${toEmail}`,
    );
  } catch (err) {
    // Stay SCHEDULED so the pg-boss retry passes the status guard; record
    // the error for /health-style visibility. Rethrow → retry policy applies.
    await prisma.emailSend.updateMany({
      where: { id: send.id, status: "SCHEDULED" },
      data: { error: String(err) },
    });
    throw err;
  }
}
