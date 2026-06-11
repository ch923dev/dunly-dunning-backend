/**
 * Dev utility: render a dunning template with sample data and really send it
 * via Resend. Sandbox note: without a verified domain, Resend only delivers
 * to the account owner's email address.
 *
 * Usage: npx tsx scripts/send-test-email.ts <to> [templateKey]
 */
import "dotenv/config";
import {
  applyMergeVars,
  isKnownTemplate,
  renderDunningEmail,
  sendDunningEmail,
} from "../src/lib/email.js";
import { SAMPLE_PROPS } from "../src/emails/components/layout.js";
import {
  DEFAULT_STEPS,
  REACTIVATION_SUBJECT,
  REACTIVATION_TEMPLATE_KEY,
} from "../src/lib/campaigns.js";

const [, , to, templateKey = "payment-failed-1"] = process.argv;
if (!to?.includes("@") || !isKnownTemplate(templateKey)) {
  console.error("Usage: npx tsx scripts/send-test-email.ts <to> [templateKey]");
  console.error(
    `templateKey: ${DEFAULT_STEPS.map((s) => s.templateKey).join(" | ")} | ${REACTIVATION_TEMPLATE_KEY}`,
  );
  process.exit(1);
}

const subjectTemplate =
  templateKey === REACTIVATION_TEMPLATE_KEY
    ? REACTIVATION_SUBJECT
    : DEFAULT_STEPS.find((s) => s.templateKey === templateKey)!.subject;

const props = SAMPLE_PROPS;
const subject = `[Dunly test] ${applyMergeVars(subjectTemplate, {
  company_name: props.companyName,
  customer_name: props.customerName ?? "there",
  amount_due: props.amountFormatted,
  plan_name: props.planName ?? "subscription",
})}`;

const { html, text } = await renderDunningEmail(templateKey, props);
const id = await sendDunningEmail({
  to,
  fromName: props.companyName,
  replyTo: null,
  subject,
  html,
  text,
  unsubscribeUrl: props.unsubscribeUrl,
  idempotencyKey: `test-${templateKey}-${Date.now()}`,
});

console.log(JSON.stringify({ sent: true, templateKey, to, subject, resendEmailId: id }, null, 2));
