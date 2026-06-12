import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { getWorkspace } from "../middleware/workspace.js";

export const expiringCardsRouter = Router();

/**
 * GET /api/expiring-cards — the pre-dunning watching list (phase-4 spec,
 * locked decision #10): merchants can always see whose card Dunly is
 * watching and what it's about to send. OPEN cases first (Postgres enum
 * declaration order), then recently closed ones.
 */
expiringCardsRouter.get("/", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const connection = await prisma.stripeConnection.findUnique({ where: { organizationId } });
    if (!connection) {
      res.json({ cards: [] });
      return;
    }

    const cases = await prisma.cardExpiryCase.findMany({
      where: { connectionId: connection.id },
      include: {
        customer: { select: { name: true, email: true } },
        emailSends: {
          select: { stageOrder: true, status: true, sentAt: true, scheduledFor: true },
        },
      },
      orderBy: [{ status: "asc" }, { openedAt: "desc" }],
      take: 50,
    });

    res.json({
      cards: cases.map((c) => {
        const touchesSent = c.emailSends.filter((s) => s.sentAt !== null).length;
        const nextTouch = c.emailSends
          .filter((s) => s.status === "SCHEDULED")
          .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0];
        return {
          id: c.id,
          customerName: c.customer.name,
          customerEmail: c.customer.email,
          cardBrand: c.cardBrand,
          cardLast4: c.cardLast4,
          expMonth: c.expMonth,
          expYear: c.expYear,
          status: c.status,
          protectedAmount: c.protectedAmount,
          currency: c.currency,
          touchesSent,
          nextTouchAt: nextTouch?.scheduledFor.toISOString() ?? null,
          openedAt: c.openedAt.toISOString(),
          resolvedAt: c.resolvedAt?.toISOString() ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});
