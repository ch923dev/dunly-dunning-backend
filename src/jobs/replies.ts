import { createElement } from "react";
import { render } from "@react-email/components";
import { prisma } from "../lib/prisma.js";
import { resend } from "../lib/resend.js";
import { env } from "../env.js";
import { formatAmount } from "../lib/email.js";
import { makeCaseToken } from "../lib/tokens.js";
import { REACTIVATION_STAGE_ORDER } from "../lib/campaigns.js";
import ReplyForward from "../emails/reply-forward.js";

/**
 * REPLY_FORWARD delivery (docs/phase-5-reply-intelligence.md, locked
 * decisions #6–8). Rides the dunning.send-email queue; the send worker
 * dispatches here on kind, like deliverExpiryEmail.
 *
 * The guard chain is deliberately THIN: no case-status guard (a closed
 * case's reply still matters to the merchant), no suppression check (the
 * suppression list is for customer addresses, not merchants).
 */
export async function deliverReplyForward(emailSendId: string) {
  const send = await prisma.emailSend.findUnique({
    where: { id: emailSendId },
    include: {
      caseReply: {
        include: {
          dunningCase: {
            include: {
              customer: true,
              connection: { include: { organization: { include: { settings: true } } } },
              emailSends: { where: { sentAt: { not: null } }, orderBy: { sentAt: "desc" }, take: 1 },
            },
          },
        },
      },
    },
  });
  if (!send) return;
  if (send.status !== "SCHEDULED") return; // sent or canceled — done
  if (send.kind !== "REPLY_FORWARD" || !send.caseReply) return;

  const reply = send.caseReply;
  const dunningCase = reply.dunningCase;
  const organization = dunningCase.connection.organization;

  const cancel = async (reason: string) => {
    await prisma.emailSend.updateMany({
      where: { id: send.id, status: "SCHEDULED" },
      data: { status: "CANCELED", error: reason },
    });
    console.log(`[replies] canceled forward ${send.id}: ${reason}`);
  };

  // Merchant notification address: settings.replyTo, else the workspace
  // owner's login email (locked decision #7) — resolved at send time.
  let toEmail = organization.settings?.replyTo ?? null;
  if (!toEmail) {
    const owner = await prisma.member.findFirst({
      where: { organizationId: organization.id, role: "owner" },
      include: { user: true },
    });
    toEmail = owner?.user.email ?? null;
  }
  if (!toEmail) return cancel("no merchant notification address");

  // "replied to stage 2" framing — the most recent email that actually went
  // out. (Which exact message they replied to isn't tracked in v1.)
  const lastSent = dunningCase.emailSends[0];
  const stageLabel = lastSent
    ? lastSent.stageOrder === REACTIVATION_STAGE_ORDER
      ? "the reactivation email"
      : `Email ${lastSent.stageOrder}`
    : null;

  const props = {
    customerName: dunningCase.customer.name,
    customerEmail: dunningCase.customer.email,
    companyName: organization.name,
    amountFormatted: formatAmount(dunningCase.amountDue, dunningCase.currency),
    stageLabel,
    pausedCase: reply.pausedCase,
    caseStatus: dunningCase.status,
    replySubject: reply.subject,
    replyText: reply.textBody,
    resumeUrl: `${env.API_URL}/r/case/resume/${makeCaseToken(dunningCase.id, "case-resume")}`,
    stopUrl: `${env.API_URL}/r/case/stop/${makeCaseToken(dunningCase.id, "case-stop")}`,
    caseUrl: `${env.APP_URL}/app/cases/${dunningCase.id}`,
  };

  const element = createElement(ReplyForward, props);
  const html = await render(element);
  const text = await render(element, { plainText: true });

  const who = props.customerName ?? props.customerEmail ?? "A customer";
  const subject = props.pausedCase
    ? `${who} replied — sequence paused (${props.amountFormatted})`
    : `${who} replied (case ${dunningCase.status.toLowerCase().replaceAll("_", " ")})`;

  try {
    // Operational mail from Dunly itself — no merchant friendly-from, no
    // unsubscribe headers. Reply-To = the customer, so the merchant just
    // hits reply to answer them.
    const { data, error } = await resend.emails.send(
      {
        from: `"Dunly" <${env.EMAIL_FROM}>`,
        to: [toEmail],
        ...(props.customerEmail ? { replyTo: props.customerEmail } : {}),
        subject,
        html,
        text,
      },
      { idempotencyKey: send.id },
    );
    if (error) throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
    if (!data) throw new Error("Resend send returned neither data nor error");

    await prisma.emailSend.update({
      where: { id: send.id },
      data: { status: "SENT", sentAt: new Date(), resendEmailId: data.id, toEmail, subject, error: null },
    });
    console.log(`[replies] forwarded reply ${reply.id} (case ${dunningCase.id}) → ${toEmail}`);
  } catch (err) {
    // Stay SCHEDULED so the pg-boss retry passes the status guard; a dropped
    // forward is worse than not having the feature.
    await prisma.emailSend.updateMany({
      where: { id: send.id, status: "SCHEDULED" },
      data: { error: String(err) },
    });
    throw err;
  }
}
