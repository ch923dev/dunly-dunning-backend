import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { boss, QUEUES } from "../lib/queue.js";

export const healthRouter = Router();

/**
 * Health + webhook liveness. "A silent webhook bug = silently lost
 * recoveries" (product plan §7.4) — lastEventReceivedAt going stale on a
 * connected workspace is the cheapest possible alarm signal.
 */
healthRouter.get("/", async (_req, res) => {
  let database = "ok";
  let lastEventReceivedAt: Date | null = null;
  let eventCounts: Record<string, number> = {};
  let queueDepth: number | null = null;

  try {
    const [lastEvent, counts] = await Promise.all([
      prisma.webhookEvent.findFirst({
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true },
      }),
      prisma.webhookEvent.groupBy({ by: ["status"], _count: true }),
    ]);
    lastEventReceivedAt = lastEvent?.receivedAt ?? null;
    eventCounts = Object.fromEntries(counts.map((c) => [c.status, c._count]));
  } catch {
    database = "unreachable";
  }

  try {
    const stats = await boss.getQueueStats(QUEUES.processEvent);
    queueDepth = stats.queuedCount ?? null;
  } catch {
    queueDepth = null;
  }

  res.json({
    status: database === "ok" ? "ok" : "degraded",
    service: "dunly-backend",
    database,
    webhooks: {
      lastEventReceivedAt,
      eventCounts,
      queueDepth,
    },
  });
});
