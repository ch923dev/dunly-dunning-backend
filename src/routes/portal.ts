import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { createPortalLink } from "../lib/stripe.js";

export const portalRouter = Router();

const portalLinkSchema = z.object({
  dunningCaseId: z.string().min(1),
  returnUrl: z.url().optional(),
});

/**
 * Generate a Stripe customer portal link for an end-customer.
 * Per the product plan this is the "Manage or cancel your subscription"
 * escape hatch in email footers — the primary recovery CTA is the case's
 * hostedInvoiceUrl.
 */
portalRouter.post("/link", async (req, res, next) => {
  try {
    const input = portalLinkSchema.parse(req.body);

    const dunningCase = await prisma.dunningCase.findUnique({
      where: { id: input.dunningCaseId },
      include: { customer: true, connection: true },
    });
    // Per-workspace isolation: a workspace can only mint links for its own
    // cases. Unknown and not-yours look identical (404) on purpose.
    if (!dunningCase || dunningCase.connection.organizationId !== req.workspace!.organizationId) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const url = await createPortalLink({
      stripeCustomerId: dunningCase.customer.stripeCustomerId,
      stripeAccountId: dunningCase.connection.stripeAccountId,
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
    });

    res.json({ url });
  } catch (err) {
    next(err);
  }
});
