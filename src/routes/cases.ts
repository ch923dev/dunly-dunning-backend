import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getWorkspace } from "../middleware/workspace.js";
import { enqueueSequence } from "../jobs/dunning.js";
import { REACTIVATION_STAGE_ORDER } from "../lib/campaigns.js";
import { formatAmount } from "../lib/email.js";

export const casesRouter = Router();

const OPEN_STATUSES = ["ACTIVE", "PAUSED", "SUPPRESSED"] as const;
const CASE_STATUSES = [
  "ACTIVE",
  "RECOVERED",
  "LOST_INVOLUNTARY",
  "LOST_VOLUNTARY",
  "SUPPRESSED",
  "PAUSED",
] as const;

/** The workspace's connection, or null when Stripe was never connected. */
async function ownConnection(organizationId: string) {
  return prisma.stripeConnection.findUnique({ where: { organizationId } });
}

/** Workspace-isolated case lookup — cross-workspace ids 404 (same doctrine as findOwnStep). */
async function findOwnCase(organizationId: string, caseId: string) {
  return prisma.dunningCase.findFirst({
    where: { id: caseId, connection: { organizationId } },
  });
}

const listQuerySchema = z.object({
  status: z.enum([...CASE_STATUSES, "all"]).default("all"),
  minAmount: z.coerce.number().int().min(0).optional(),
  maxAmount: z.coerce.number().int().min(0).optional(),
  since: z.coerce.date().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** GET /api/cases — filterable, cursor-paginated case list. */
casesRouter.get("/", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation",
        details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      });
      return;
    }
    const q = parsed.data;
    const connection = await ownConnection(organizationId);
    if (!connection) {
      res.json({ cases: [], nextCursor: null, summary: { count: 0, atRisk: 0, currency: "usd" } });
      return;
    }

    const where = {
      connectionId: connection.id,
      ...(q.status !== "all" ? { status: q.status } : {}),
      ...(q.minAmount !== undefined || q.maxAmount !== undefined
        ? { amountDue: { ...(q.minAmount !== undefined ? { gte: q.minAmount } : {}), ...(q.maxAmount !== undefined ? { lte: q.maxAmount } : {}) } }
        : {}),
      ...(q.since ? { failedAt: { gte: q.since } } : {}),
    };

    const currency = connection.defaultCurrency ?? "usd";
    const [rows, count, atRisk] = await Promise.all([
      prisma.dunningCase.findMany({
        where,
        orderBy: [{ failedAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
        ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
        include: {
          customer: { select: { name: true, email: true } },
          emailSends: {
            select: { kind: true, stageOrder: true, status: true, sentAt: true, scheduledFor: true },
          },
        },
      }),
      prisma.dunningCase.count({ where }),
      // Whole-filter summary (not page-bound): the open-statuses portion OF
      // the current filter — a status filter narrows it, never widens it.
      // Primary currency only; other currencies are never silently summed
      // (phase-3 locked decision #6).
      prisma.dunningCase.aggregate({
        where: {
          ...where,
          status:
            q.status === "all"
              ? { in: [...OPEN_STATUSES] }
              : (OPEN_STATUSES as readonly string[]).includes(q.status)
                ? q.status
                : { in: [] },
          currency,
        },
        _sum: { amountDue: true },
      }),
    ]);

    const nextCursor = rows.length > q.limit ? rows[q.limit]!.id : null;
    const cases = rows.slice(0, q.limit).map((c) => {
      const sequence = c.emailSends.filter((s) => s.kind === "SEQUENCE");
      const pending = sequence
        .filter((s) => s.status === "SCHEDULED")
        .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
      return {
        id: c.id,
        customer: c.customer,
        amountDue: c.amountDue,
        currency: c.currency,
        failureCode: c.failureCode,
        status: c.status,
        failedAt: c.failedAt,
        attemptCount: c.attemptCount,
        sentCount: sequence.filter((s) => s.sentAt !== null).length,
        totalSteps: sequence.length,
        nextSendAt: pending[0]?.scheduledFor ?? null,
      };
    });

    res.json({
      cases,
      nextCursor,
      summary: { count, atRisk: atRisk._sum.amountDue ?? 0, currency },
    });
  } catch (err) {
    next(err);
  }
});

type TimelineEvent = {
  type:
    | "failed"
    | "sent"
    | "opened"
    | "clicked"
    | "bounced"
    | "pending"
    | "held"
    | "canceled"
    | "suppressed"
    | "recovered"
    | "lost";
  at: Date;
  title: string;
  detail: string | null;
  /** Hasn't happened yet — rendered dashed. */
  future?: boolean;
};

/**
 * GET /api/cases/:id — header + customer + derived timeline (phase-3 locked
 * decision #1: no event table; every moment we know is already a timestamp
 * on the case, its sends, or a suppression entry).
 */
casesRouter.get("/:id", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const caseId = typeof req.params.id === "string" ? req.params.id : "";
    const c = await prisma.dunningCase.findFirst({
      where: { id: caseId, connection: { organizationId } },
      include: {
        customer: true,
        campaign: { include: { steps: { orderBy: { order: "asc" } } } },
        emailSends: { orderBy: { scheduledFor: "asc" } },
      },
    });
    if (!c) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const subscription = c.stripeSubscriptionId
      ? await prisma.subscription.findUnique({
          where: { stripeSubscriptionId: c.stripeSubscriptionId },
        })
      : null;
    const suppression = c.customer.email
      ? await prisma.suppressionEntry.findUnique({
          where: { organizationId_email: { organizationId, email: c.customer.email } },
        })
      : null;

    const stepFor = (order: number) => c.campaign?.steps.find((s) => s.order === order) ?? null;
    const stageLabel = (order: number) =>
      order === REACTIVATION_STAGE_ORDER ? "Reactivation email" : `Email ${order}`;
    const amount = formatAmount(c.amountDue, c.currency);

    const events: TimelineEvent[] = [
      {
        type: "failed",
        at: c.failedAt,
        title: "Payment failed",
        detail: `${amount}${c.failureCode ? ` · ${c.failureCode.replaceAll("_", " ")}` : ""} · attempt ${c.attemptCount}`,
      },
    ];

    for (const s of c.emailSends) {
      const label = stageLabel(s.stageOrder);
      const subject = s.subject ?? stepFor(s.stageOrder)?.subject ?? null;
      if (s.sentAt) {
        events.push({ type: "sent", at: s.sentAt, title: `${label} sent`, detail: subject });
        if (s.openedAt)
          events.push({ type: "opened", at: s.openedAt, title: `${label} opened`, detail: null });
        if (s.clickedAt)
          events.push({
            type: "clicked",
            at: s.clickedAt,
            title: "Update-payment link clicked",
            detail: null,
          });
        if (s.status === "BOUNCED")
          events.push({ type: "bounced", at: s.sentAt, title: `${label} bounced`, detail: null });
      } else if (s.status === "SCHEDULED") {
        const held = c.status === "PAUSED";
        events.push({
          type: held ? "held" : "pending",
          at: s.scheduledFor,
          title: held ? `${label} held (paused)` : `${label} scheduled`,
          detail: subject,
          future: true,
        });
      } else if (s.status === "CANCELED") {
        events.push({
          type: "canceled",
          at: s.scheduledFor,
          title: `${label} canceled`,
          detail: s.error,
        });
      }
    }

    if (suppression) {
      events.push({
        type: "suppressed",
        at: suppression.createdAt,
        title: "Customer unsubscribed",
        detail: "Recovery emails stopped — Stripe retries continue",
      });
    }
    if (c.status === "RECOVERED" && c.recoveredAt) {
      events.push({
        type: "recovered",
        at: c.recoveredAt,
        title: "Payment recovered",
        detail: `${amount} collected`,
      });
    }
    if ((c.status === "LOST_INVOLUNTARY" || c.status === "LOST_VOLUNTARY") && c.closedAt) {
      events.push({
        type: "lost",
        at: c.closedAt,
        title:
          c.status === "LOST_VOLUNTARY"
            ? "Subscription canceled by the customer"
            : "Lost — payment never recovered",
        detail: null,
      });
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    const sequence = c.emailSends.filter((s) => s.kind === "SEQUENCE");
    const nextPending = sequence
      .filter((s) => s.status === "SCHEDULED")
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())[0];
    const nextStep = nextPending ? stepFor(nextPending.stageOrder) : null;

    res.json({
      id: c.id,
      status: c.status,
      amountDue: c.amountDue,
      currency: c.currency,
      failureCode: c.failureCode,
      failureMessage: c.failureMessage,
      attemptCount: c.attemptCount,
      failedAt: c.failedAt,
      recoveredAt: c.recoveredAt,
      closedAt: c.closedAt,
      hostedInvoiceUrl: c.hostedInvoiceUrl,
      customer: {
        name: c.customer.name,
        email: c.customer.email,
        since: c.customer.createdAt,
      },
      subscription: subscription
        ? { planName: subscription.planName, status: subscription.status }
        : null,
      sentCount: sequence.filter((s) => s.sentAt !== null).length,
      totalSteps: sequence.length,
      nextSend: nextPending
        ? {
            stageOrder: nextPending.stageOrder,
            stepId: nextStep?.id ?? null,
            subject: nextPending.subject ?? nextStep?.subject ?? null,
            scheduledFor: nextPending.scheduledFor,
            held: c.status === "PAUSED",
          }
        : null,
      timeline: events,
    });
  } catch (err) {
    next(err);
  }
});

/** POST /api/cases/:id/pause — ACTIVE → PAUSED (held sends, decision #2). */
casesRouter.post("/:id/pause", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const caseId = typeof req.params.id === "string" ? req.params.id : "";
    const existing = await findOwnCase(organizationId, caseId);
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Guarded transition — a concurrent stop condition wins the race.
    const { count } = await prisma.dunningCase.updateMany({
      where: { id: existing.id, status: "ACTIVE" },
      data: { status: "PAUSED" },
    });
    if (count === 0) {
      res.status(409).json({ error: "not_active", status: existing.status });
      return;
    }
    console.log(`[cases] paused case ${existing.id}`);
    res.json({ id: existing.id, status: "PAUSED" });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/cases/:id/resume — PAUSED → ACTIVE, then one idempotent sequence
 * kick: its self-heal path re-enqueues every held SCHEDULED row (past times
 * fire immediately, window clamps still apply at the send authority).
 */
casesRouter.post("/:id/resume", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const caseId = typeof req.params.id === "string" ? req.params.id : "";
    const existing = await findOwnCase(organizationId, caseId);
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { count } = await prisma.dunningCase.updateMany({
      where: { id: existing.id, status: "PAUSED" },
      data: { status: "ACTIVE" },
    });
    if (count === 0) {
      res.status(409).json({ error: "not_paused", status: existing.status });
      return;
    }
    await enqueueSequence(existing.id);
    console.log(`[cases] resumed case ${existing.id}`);
    res.json({ id: existing.id, status: "ACTIVE" });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/cases/:id/stop — ACTIVE/PAUSED → LOST_INVOLUNTARY (decision #4:
 * abandoning an involuntary failure is an involuntary loss). Irreversible;
 * pending sends become CANCELED history. No reactivation email — that is
 * reserved for Stripe-side cancellations.
 */
casesRouter.post("/:id/stop", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const caseId = typeof req.params.id === "string" ? req.params.id : "";
    const existing = await findOwnCase(organizationId, caseId);
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { count } = await prisma.dunningCase.updateMany({
      where: { id: existing.id, status: { in: ["ACTIVE", "PAUSED"] } },
      data: { status: "LOST_INVOLUNTARY", closedAt: new Date() },
    });
    if (count === 0) {
      res.status(409).json({ error: "not_open", status: existing.status });
      return;
    }
    await prisma.emailSend.updateMany({
      where: { dunningCaseId: existing.id, status: "SCHEDULED" },
      data: { status: "CANCELED", error: "manually stopped" },
    });
    console.log(`[cases] stopped case ${existing.id} (marked lost)`);
    res.json({ id: existing.id, status: "LOST_INVOLUNTARY" });
  } catch (err) {
    next(err);
  }
});
