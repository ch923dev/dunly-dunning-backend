import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { getWorkspace } from "../middleware/workspace.js";
import { REACTIVATION_STAGE_ORDER } from "../lib/campaigns.js";
import { startOfMonthInZone, startOfDayInZone } from "../lib/zoned-time.js";

export const metricsRouter = Router();

const DAY_MS = 86_400_000;
const TREND_WEEKS = 8;
const OPEN_STATUSES = new Set(["ACTIVE", "PAUSED", "SUPPRESSED"]);

type CaseRow = {
  amountDue: number;
  currency: string;
  status: string;
  failedAt: Date;
  recoveredAt: Date | null;
  closedAt: Date | null;
};

/** When a case left the open pool — recovery timestamp or terminal close. */
function closedMoment(c: CaseRow): Date | null {
  if (c.status === "RECOVERED") return c.recoveredAt ?? c.closedAt;
  if (c.status === "LOST_INVOLUNTARY" || c.status === "LOST_VOLUNTARY") return c.closedAt;
  return null;
}

/**
 * GET /api/metrics — dashboard headline cards + 8-week trend + churn split.
 * Aggregated in-process: case volume is small in MVP and the trend bucketing
 * reads every row anyway. All sums are minor units in the primary currency;
 * open cases in any other currency are flagged, never silently added
 * (phase-3 locked decision #6).
 */
metricsRouter.get("/", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const [connection, settings] = await Promise.all([
      prisma.stripeConnection.findUnique({ where: { organizationId } }),
      prisma.workspaceSettings.findUnique({ where: { organizationId } }),
    ]);
    const timezone = settings?.timezone ?? "UTC";

    const cases: CaseRow[] = connection
      ? await prisma.dunningCase.findMany({
          where: { connectionId: connection.id },
          select: {
            amountDue: true,
            currency: true,
            status: true,
            failedAt: true,
            recoveredAt: true,
            closedAt: true,
          },
        })
      : [];

    // Primary currency: the connected account's default, else the most
    // common across cases, else usd.
    const byCurrency = new Map<string, number>();
    for (const c of cases) byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + 1);
    const currency =
      connection?.defaultCurrency ??
      [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      "usd";
    const primary = cases.filter((c) => c.currency === currency);
    const otherOpenCases = cases.filter(
      (c) => c.currency !== currency && OPEN_STATUSES.has(c.status),
    ).length;

    const now = new Date();
    const monthStart = startOfMonthInZone(now, timezone);

    const recoveredCases = primary.filter((c) => c.status === "RECOVERED");
    const recoveredThisMonth = recoveredCases.filter(
      (c) => c.recoveredAt && c.recoveredAt >= monthStart,
    );
    const open = primary.filter((c) => OPEN_STATUSES.has(c.status));

    // Recovery rate over cases CLOSED this month; voluntary cancels are
    // excluded from the denominator (locked decision #5).
    const closedThisMonth = primary.filter((c) => {
      const at = closedMoment(c);
      return at !== null && at >= monthStart;
    });
    const rateRecovered = closedThisMonth.filter((c) => c.status === "RECOVERED").length;
    const rateLost = closedThisMonth.filter((c) => c.status === "LOST_INVOLUNTARY").length;

    const recoveryDays = recoveredThisMonth
      .filter((c) => c.recoveredAt)
      .map((c) => (c.recoveredAt!.getTime() - c.failedAt.getTime()) / DAY_MS);

    const lostThisMonth = (status: string) =>
      primary
        .filter((c) => c.status === status && c.closedAt && c.closedAt >= monthStart)
        .reduce((s, c) => s + c.amountDue, 0);

    // Trend: TREND_WEEKS buckets of 7 calendar days, the last one ending at
    // the end of "today" in the workspace timezone. Boundaries are plain
    // 7-day strides in ms (a DST week is ±1h — irrelevant at this grain) and
    // are returned in the payload so verification is mechanical. Each bucket:
    // amount that FAILED in the bucket, split by whether it has since been
    // recovered (locked decision #10).
    const trendEnd = new Date(startOfDayInZone(now, timezone).getTime() + DAY_MS);
    const trend = Array.from({ length: TREND_WEEKS }, (_, i) => {
      const start = new Date(trendEnd.getTime() - (TREND_WEEKS - i) * 7 * DAY_MS);
      const end = new Date(start.getTime() + 7 * DAY_MS);
      const inBucket = primary.filter((c) => c.failedAt >= start && c.failedAt < end);
      const recovered = inBucket
        .filter((c) => c.status === "RECOVERED")
        .reduce((s, c) => s + c.amountDue, 0);
      const failed = inBucket.reduce((s, c) => s + c.amountDue, 0);
      return {
        weekStart: start.toISOString(),
        label: new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          month: "short",
          day: "numeric",
        }).format(start),
        failed,
        recoveredSoFar: recovered,
      };
    });

    res.json({
      currency,
      timezone,
      periodStart: monthStart.toISOString(),
      recovered: {
        thisMonth: recoveredThisMonth.reduce((s, c) => s + c.amountDue, 0),
        allTime: recoveredCases.reduce((s, c) => s + c.amountDue, 0),
        casesThisMonth: recoveredThisMonth.length,
      },
      atRisk: {
        amount: open.reduce((s, c) => s + c.amountDue, 0),
        openCases: open.length,
      },
      recoveryRate: {
        rate: rateRecovered + rateLost > 0 ? rateRecovered / (rateRecovered + rateLost) : null,
        recovered: rateRecovered,
        lostInvoluntary: rateLost,
      },
      avgDaysToRecover:
        recoveryDays.length > 0
          ? Math.round((recoveryDays.reduce((s, d) => s + d, 0) / recoveryDays.length) * 10) / 10
          : null,
      lostThisMonth: {
        involuntary: lostThisMonth("LOST_INVOLUNTARY"),
        voluntary: lostThisMonth("LOST_VOLUNTARY"),
      },
      trend,
      otherCurrencies: otherOpenCases > 0 ? { openCases: otherOpenCases } : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/metrics/email-performance — per-stage funnel + last-touch
 * recovery attribution (locked decision #8). Opens/clicks populate from
 * Resend webhooks; in dev these arrive only via the synthetic-event script
 * (locked decision #7), so zeros here mean "no tracking data", not failure.
 */
metricsRouter.get("/email-performance", async (req, res, next) => {
  try {
    const { organizationId } = getWorkspace(req);
    const connection = await prisma.stripeConnection.findUnique({ where: { organizationId } });

    const sends = connection
      ? await prisma.emailSend.findMany({
          where: { dunningCase: { connectionId: connection.id } },
          select: {
            stageOrder: true,
            status: true,
            sentAt: true,
            openedAt: true,
            clickedAt: true,
            dunningCaseId: true,
          },
        })
      : [];
    const recovered = connection
      ? await prisma.dunningCase.findMany({
          where: { connectionId: connection.id, status: "RECOVERED" },
          select: { id: true, recoveredAt: true },
        })
      : [];

    const stageOrders = [
      ...new Set([1, 2, 3, 4, REACTIVATION_STAGE_ORDER, ...sends.map((s) => s.stageOrder)]),
    ].sort((a, b) => a - b);
    const stages = new Map(
      stageOrders.map((order) => [
        order,
        { stageOrder: order, pending: 0, sent: 0, opened: 0, clicked: 0, recoveries: 0 },
      ]),
    );

    const sendsByCase = new Map<string, { stageOrder: number; sentAt: Date }[]>();
    for (const s of sends) {
      const row = stages.get(s.stageOrder)!;
      if (s.status === "SCHEDULED") row.pending++;
      if (s.sentAt) {
        row.sent++;
        const list = sendsByCase.get(s.dunningCaseId) ?? [];
        list.push({ stageOrder: s.stageOrder, sentAt: s.sentAt });
        sendsByCase.set(s.dunningCaseId, list);
      }
      if (s.openedAt) row.opened++;
      if (s.clickedAt) row.clicked++;
    }

    // Last-touch: the latest stage SENT at or before the recovery moment.
    // Recovered with nothing sent = "no email needed" (Smart Retries won
    // before stage 1) — credited to no stage.
    let noEmailRecoveries = 0;
    for (const c of recovered) {
      const cutoff = c.recoveredAt ?? new Date();
      const candidates = (sendsByCase.get(c.id) ?? []).filter((s) => s.sentAt <= cutoff);
      if (candidates.length === 0) {
        noEmailRecoveries++;
        continue;
      }
      candidates.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
      stages.get(candidates[0]!.stageOrder)!.recoveries++;
    }

    res.json({ stages: [...stages.values()], noEmailRecoveries });
  } catch (err) {
    next(err);
  }
});
