import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getWorkspace, requireOwner } from "../middleware/workspace.js";
import {
  DEFAULT_STEPS,
  ensureDefaultCampaign,
  REACTIVATION_SUBJECT,
  REACTIVATION_TEMPLATE_KEY,
} from "../lib/campaigns.js";
import { sanitizeEmailBody } from "../lib/sanitize.js";
import type { DunningStep } from "../generated/prisma/client.js";

export const campaignRouter = Router();

function stepPayload(step: DunningStep) {
  return {
    id: step.id,
    order: step.order,
    delayHours: step.delayHours,
    subject: step.subject,
    templateKey: step.templateKey,
    bodyHtml: step.bodyHtml,
    isCustomized: step.bodyHtml !== null,
    isEnabled: step.isEnabled,
    sendWindowStart: step.sendWindowStart,
    sendWindowEnd: step.sendWindowEnd,
    skipIfAmountBelow: step.skipIfAmountBelow,
  };
}

/** The workspace's active campaign + steps (self-heals a missing default). */
campaignRouter.get("/", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const campaign = await ensureDefaultCampaign(organizationId);
    res.json({
      id: campaign.id,
      name: campaign.name,
      isActive: campaign.isActive,
      steps: campaign.steps.map(stepPayload),
      // Read-only in Phase 2: the reactivation email isn't a campaign step.
      reactivation: {
        subject: REACTIVATION_SUBJECT,
        templateKey: REACTIVATION_TEMPLATE_KEY,
      },
    });
  } catch (err) {
    next(err);
  }
});

const patchStepSchema = z.object({
  subject: z.string().trim().min(1).max(200).optional(),
  // null / "" = back to the built-in template body.
  bodyHtml: z.union([z.string().max(20_000), z.null()]).optional(),
  delayHours: z.number().int().min(0).max(8_760).optional(),
  isEnabled: z.boolean().optional(),
  sendWindowStart: z.number().int().min(0).max(23).nullable().optional(),
  sendWindowEnd: z.number().int().min(0).max(23).nullable().optional(),
  skipIfAmountBelow: z.number().int().min(0).max(100_000_000).nullable().optional(),
});

/** Load a step and verify it belongs to the caller's workspace (404 either way). */
async function findOwnStep(stepId: string, organizationId: string) {
  const step = await prisma.dunningStep.findUnique({
    where: { id: stepId },
    include: { campaign: { select: { organizationId: true } } },
  });
  if (!step || step.campaign.organizationId !== organizationId) return null;
  return step;
}

campaignRouter.patch("/steps/:id", requireOwner, async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const parsed = patchStepSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation",
        details: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const input = parsed.data;

    const stepId = typeof req.params.id === "string" ? req.params.id : "";
    const step = await findOwnStep(stepId, organizationId);
    if (!step) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Send-window coherence after merging with current values: both ends or
    // neither, and never a zero-length window. (start > end = overnight.)
    const windowStart =
      input.sendWindowStart !== undefined ? input.sendWindowStart : step.sendWindowStart;
    const windowEnd = input.sendWindowEnd !== undefined ? input.sendWindowEnd : step.sendWindowEnd;
    if ((windowStart === null) !== (windowEnd === null)) {
      res.status(400).json({
        error: "validation",
        details: [{ field: "sendWindow", message: "set both window hours or neither" }],
      });
      return;
    }
    if (windowStart !== null && windowStart === windowEnd) {
      res.status(400).json({
        error: "validation",
        details: [{ field: "sendWindow", message: "window must span at least one hour" }],
      });
      return;
    }

    // Sanitize on save — stored bodyHtml is always already-safe HTML.
    let bodyHtml: string | null | undefined = undefined;
    if (input.bodyHtml !== undefined) {
      const clean = input.bodyHtml === null ? "" : sanitizeEmailBody(input.bodyHtml);
      bodyHtml = clean === "" ? null : clean;
    }

    const updated = await prisma.dunningStep.update({
      where: { id: step.id },
      data: {
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        ...(bodyHtml !== undefined ? { bodyHtml } : {}),
        ...(input.delayHours !== undefined ? { delayHours: input.delayHours } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        ...(input.sendWindowStart !== undefined ? { sendWindowStart: input.sendWindowStart } : {}),
        ...(input.sendWindowEnd !== undefined ? { sendWindowEnd: input.sendWindowEnd } : {}),
        ...(input.skipIfAmountBelow !== undefined
          ? { skipIfAmountBelow: input.skipIfAmountBelow }
          : {}),
      },
    });

    res.json(stepPayload(updated));
  } catch (err) {
    next(err);
  }
});

/** Reset a step to its built-in default: stock subject, no custom body. */
campaignRouter.post("/steps/:id/reset", requireOwner, async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const stepId = typeof req.params.id === "string" ? req.params.id : "";
    const step = await findOwnStep(stepId, organizationId);
    if (!step) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const defaults = DEFAULT_STEPS.find((d) => d.order === step.order);
    const updated = await prisma.dunningStep.update({
      where: { id: step.id },
      data: {
        bodyHtml: null,
        ...(defaults ? { subject: defaults.subject } : {}),
      },
    });
    res.json(stepPayload(updated));
  } catch (err) {
    next(err);
  }
});
