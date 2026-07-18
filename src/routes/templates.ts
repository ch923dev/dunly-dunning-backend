import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getWorkspace } from "../middleware/workspace.js";
import { zodIssueDetails } from "../middleware/error.js";
import {
  ensureDefaultCampaign,
  REACTIVATION_SUBJECT,
  REACTIVATION_TEMPLATE_KEY,
} from "../lib/campaigns.js";
import {
  applyMergeVars,
  applyMergeVarsHtml,
  renderDunningEmail,
  sendDunningEmail,
} from "../lib/email.js";
import { sanitizeEmailBody } from "../lib/sanitize.js";
import { SAMPLE_PROPS, type DunningEmailProps } from "../emails/components/layout.js";
import { env } from "../env.js";

/**
 * Editor support endpoints: render-with-sample-data preview and a real
 * test send to the signed-in user. Both use the workspace's branding so
 * what merchants see is what their customers get.
 */
export const templatesRouter = Router();

const stageSchema = z.union([z.number().int().min(1).max(100), z.literal("reactivation")]);

interface ResolvedTemplate {
  subjectTemplate: string;
  templateKey: string;
  bodyTemplate: string | null;
}

/** Saved subject/template/body for a stage of this workspace's campaign. */
async function resolveStage(
  organizationId: string,
  stage: number | "reactivation",
): Promise<ResolvedTemplate | null> {
  if (stage === "reactivation") {
    return {
      subjectTemplate: REACTIVATION_SUBJECT,
      templateKey: REACTIVATION_TEMPLATE_KEY,
      bodyTemplate: null,
    };
  }
  const campaign = await ensureDefaultCampaign(organizationId);
  const step = campaign.steps.find((s) => s.order === stage);
  if (!step) return null;
  return {
    subjectTemplate: step.subject,
    templateKey: step.templateKey,
    bodyTemplate: step.bodyHtml,
  };
}

interface RenderedPreview {
  subject: string;
  html: string;
  text: string;
}

/** Render a stage with sample customer data + real workspace branding. */
async function renderWithSampleData(
  organizationId: string,
  resolved: ResolvedTemplate,
): Promise<RenderedPreview> {
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    include: { settings: true },
  });

  const props: DunningEmailProps = {
    ...SAMPLE_PROPS,
    companyName: org.name,
    brandColor: org.settings?.brandColor ?? null,
    logoUrl: org.settings?.logoUrl ?? null,
  };
  const mergeVars = {
    company_name: org.name,
    customer_name: props.customerName ?? "there",
    amount_due: props.amountFormatted,
    plan_name: props.planName ?? "subscription",
    update_payment_link: props.payUrl,
  };

  const subject = applyMergeVars(resolved.subjectTemplate, mergeVars);
  const bodyHtml = resolved.bodyTemplate
    ? applyMergeVarsHtml(resolved.bodyTemplate, mergeVars)
    : null;
  const { html, text } = await renderDunningEmail(resolved.templateKey, props, bodyHtml);
  return { subject, html, text };
}

const previewSchema = z.object({
  stage: stageSchema,
  // Optional unsaved drafts — the editor previews as-you-type.
  subject: z.string().trim().min(1).max(200).optional(),
  bodyHtml: z.union([z.string().max(20_000), z.null()]).optional(),
});

templatesRouter.post("/preview", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation", details: zodIssueDetails(parsed.error) });
      return;
    }
    const { stage, subject, bodyHtml } = parsed.data;

    const resolved = await resolveStage(organizationId, stage);
    if (!resolved) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Drafts override saved content; draft bodies get the same sanitizer the
    // save path uses, so the preview never shows anything a send wouldn't.
    if (subject !== undefined) resolved.subjectTemplate = subject;
    if (bodyHtml !== undefined && stage !== "reactivation") {
      const clean = bodyHtml === null ? "" : sanitizeEmailBody(bodyHtml);
      resolved.bodyTemplate = clean === "" ? null : clean;
    }

    const rendered = await renderWithSampleData(organizationId, resolved);
    res.json({ subject: rendered.subject, html: rendered.html });
  } catch (err) {
    next(err);
  }
});

const testSendSchema = z.object({ stage: stageSchema });

templatesRouter.post("/test-send", async (req, res, next) => {
  try {
    const { organizationId, user } = getWorkspace(req);
    const parsed = testSendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "validation", details: zodIssueDetails(parsed.error) });
      return;
    }

    const resolved = await resolveStage(organizationId, parsed.data.stage);
    if (!resolved) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      include: { settings: true },
    });
    const rendered = await renderWithSampleData(organizationId, resolved);

    await sendDunningEmail({
      to: user.email,
      fromName: org.name,
      replyTo: org.settings?.replyTo ?? null,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      // Sample links in the body are fine, but the RFC 8058 header needs a
      // real URL — point it at the app (test sends are to yourself anyway).
      unsubscribeUrl: env.APP_URL,
      // Every test send is intentional — never dedupe them.
      idempotencyKey: randomUUID(),
    });

    res.json({ sent: true, to: user.email });
  } catch (err) {
    next(err);
  }
});
