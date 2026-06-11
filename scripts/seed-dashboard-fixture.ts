/**
 * Dev utility: seed a clearly-marked synthetic dataset for dashboard
 * verification (phase-3 spec, "Dev data for acceptance").
 *
 *   npx tsx scripts/seed-dashboard-fixture.ts          # wipe + reseed
 *   npx tsx scripts/seed-dashboard-fixture.ts --clean  # wipe only
 *
 * Targets the workspace of the latest CONNECTED Stripe connection. Every row
 * is marked: invoices in_fixture_*, customers cus_fixture_*, subscriptions
 * sub_fixture_*, emails fixture+*@example.com. DB-only — SCHEDULED EmailSend
 * rows get NO pg-boss jobs on purpose, so nothing here can ever actually
 * send. The engine never scans for due rows (it is job-driven), so these
 * rows are inert.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import {
  ensureDefaultCampaign,
  DEFAULT_STEPS,
  REACTIVATION_STAGE_ORDER,
  REACTIVATION_SUBJECT,
} from "../src/lib/campaigns.js";

const clean = process.argv.includes("--clean");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.now();
const daysAgo = (d: number) => new Date(now - d * DAY);

// Per-stage outcome: s = sent, o = opened, c = clicked (ladder),
// "pending" = SCHEDULED, otherwise a cancel reason string.
type StageSpec = "s" | "so" | "soc" | "pending" | { canceled: string };

type CaseSpec = {
  n: number;
  name: string;
  status: "ACTIVE" | "RECOVERED" | "LOST_INVOLUNTARY" | "LOST_VOLUNTARY" | "SUPPRESSED" | "PAUSED";
  amount: number; // minor units
  currency: string;
  failedDaysAgo: number;
  recoveredDaysAgo?: number;
  closedDaysAgo?: number;
  failureCode: string;
  attemptCount: number;
  plan: string;
  stages: [StageSpec, StageSpec, StageSpec, StageSpec];
  reactivation?: "s" | "so";
  suppressed?: boolean;
};

const PAID = { canceled: "stop condition: invoice paid" };
const UNSUB = { canceled: "stop condition: customer unsubscribed" };
const VOLUNTARY = { canceled: "stop condition: subscription canceled" };

// Deterministic dataset — designed so every dashboard number is
// hand-verifiable. Expected (usd): recovered this month = cases 1+2+4,
// at risk = 5+6+7+8+9, recovery rate this month = 3/(3+1) [case 12 is
// voluntary, excluded], last-touch: s1×2 s2×2 s3×1 + 1 no-email recovery.
const CASES: CaseSpec[] = [
  { n: 1,  name: "Maya Chen",     status: "RECOVERED",        amount: 4900,  currency: "usd", failedDaysAgo: 2,    recoveredDaysAgo: 1,    failureCode: "card_declined",      attemptCount: 2, plan: "Pro — monthly",     stages: ["soc", PAID, PAID, PAID] },
  { n: 2,  name: "Liam Ortega",   status: "RECOVERED",        amount: 9900,  currency: "usd", failedDaysAgo: 10,   recoveredDaysAgo: 5,    failureCode: "insufficient_funds", attemptCount: 3, plan: "Growth — monthly",  stages: ["so", "soc", PAID, PAID] },
  { n: 3,  name: "Priya Raman",   status: "RECOVERED",        amount: 2900,  currency: "usd", failedDaysAgo: 20,   recoveredDaysAgo: 18,   failureCode: "expired_card",       attemptCount: 1, plan: "Starter — monthly", stages: ["s", PAID, PAID, PAID] },
  { n: 4,  name: "Jonas Weber",   status: "RECOVERED",        amount: 1900,  currency: "usd", failedDaysAgo: 6,    recoveredDaysAgo: 5.99, failureCode: "card_declined",      attemptCount: 1, plan: "Starter — monthly", stages: [PAID, PAID, PAID, PAID] }, // Smart Retry won before stage 1 fired
  { n: 5,  name: "Ava Thompson",  status: "ACTIVE",           amount: 5900,  currency: "usd", failedDaysAgo: 1,    failureCode: "card_declined",      attemptCount: 1, plan: "Pro — monthly",     stages: ["so", "pending", "pending", "pending"] },
  { n: 6,  name: "Noah Kim",      status: "ACTIVE",           amount: 14900, currency: "usd", failedDaysAgo: 5,    failureCode: "insufficient_funds", attemptCount: 2, plan: "Scale — monthly",   stages: ["soc", "so", "pending", "pending"] },
  { n: 7,  name: "Zoe Almeida",   status: "ACTIVE",           amount: 900,   currency: "usd", failedDaysAgo: 0.125, failureCode: "card_declined",     attemptCount: 1, plan: "Starter — monthly", stages: ["s", "pending", "pending", "pending"] },
  { n: 8,  name: "Felix Bauer",   status: "PAUSED",           amount: 7900,  currency: "usd", failedDaysAgo: 4,    failureCode: "expired_card",       attemptCount: 1, plan: "Pro — monthly",     stages: ["so", "pending", "pending", "pending"] },
  { n: 9,  name: "Ines Costa",    status: "SUPPRESSED",       amount: 3900,  currency: "usd", failedDaysAgo: 8,    failureCode: "card_declined",      attemptCount: 2, plan: "Pro — monthly",     stages: ["so", UNSUB, UNSUB, UNSUB], suppressed: true },
  { n: 10, name: "Omar Haddad",   status: "LOST_INVOLUNTARY", amount: 12900, currency: "usd", failedDaysAgo: 25,   closedDaysAgo: 6,       failureCode: "card_declined",      attemptCount: 4, plan: "Scale — monthly",   stages: ["s", "so", "s", "s"], reactivation: "s" },
  { n: 11, name: "Lucia Marino",  status: "LOST_INVOLUNTARY", amount: 2500,  currency: "usd", failedDaysAgo: 45,   closedDaysAgo: 31,      failureCode: "expired_card",       attemptCount: 4, plan: "Starter — monthly", stages: ["s", "s", "s", "s"], reactivation: "so" },
  { n: 12, name: "Ethan Walsh",   status: "LOST_VOLUNTARY",   amount: 4900,  currency: "usd", failedDaysAgo: 9,    closedDaysAgo: 7,       failureCode: "card_declined",      attemptCount: 1, plan: "Pro — monthly",     stages: ["s", VOLUNTARY, VOLUNTARY, VOLUNTARY] },
  { n: 13, name: "Hana Suzuki",   status: "LOST_VOLUNTARY",   amount: 19900, currency: "usd", failedDaysAgo: 35,   closedDaysAgo: 33,      failureCode: "insufficient_funds", attemptCount: 1, plan: "Scale — annual",    stages: ["so", VOLUNTARY, VOLUNTARY, VOLUNTARY] },
  { n: 14, name: "Ruben Silva",   status: "RECOVERED",        amount: 34900, currency: "usd", failedDaysAgo: 26,   recoveredDaysAgo: 22,   failureCode: "card_declined",      attemptCount: 2, plan: "Scale — annual",    stages: ["so", "soc", PAID, PAID] },
  { n: 15, name: "Greta Nilsson", status: "RECOVERED",        amount: 8900,  currency: "usd", failedDaysAgo: 52,   recoveredDaysAgo: 41,   failureCode: "insufficient_funds", attemptCount: 3, plan: "Growth — monthly",  stages: ["s", "s", "soc", PAID] },
  { n: 16, name: "Marc Dubois",   status: "ACTIVE",           amount: 45000, currency: "eur", failedDaysAgo: 2,    failureCode: "card_declined",      attemptCount: 1, plan: "Growth — monthly",  stages: ["s", "pending", "pending", "pending"] },
];

async function wipe(organizationId: string) {
  // Deleting fixture customers cascades their subscriptions, cases, and
  // email sends; suppression entries are org-scoped, removed by email.
  const customers = await prisma.customer.deleteMany({
    where: { stripeCustomerId: { startsWith: "cus_fixture_" } },
  });
  const suppressions = await prisma.suppressionEntry.deleteMany({
    where: { organizationId, email: { startsWith: "fixture+" } },
  });
  console.log(`wiped: ${customers.count} fixture customers (cases/sends cascade), ${suppressions.count} suppressions`);
}

const connection = await prisma.stripeConnection.findFirst({
  where: { status: "CONNECTED" },
  orderBy: { connectedAt: "desc" },
  include: { organization: true },
});
if (!connection) {
  console.error("no CONNECTED Stripe connection found — connect one first");
  process.exit(1);
}
console.log(`target workspace: ${connection.organization.name} (${connection.organizationId}), connection ${connection.stripeAccountId}`);

await wipe(connection.organizationId);
if (clean) {
  await prisma.$disconnect();
  process.exit(0);
}

const campaign = await ensureDefaultCampaign(connection.organizationId);

for (const spec of CASES) {
  const email = `fixture+${spec.n}@example.com`;
  const failedAt = daysAgo(spec.failedDaysAgo);
  const recoveredAt = spec.recoveredDaysAgo !== undefined ? daysAgo(spec.recoveredDaysAgo) : null;
  const closedAt =
    spec.closedDaysAgo !== undefined ? daysAgo(spec.closedDaysAgo) : recoveredAt;

  const customer = await prisma.customer.create({
    data: {
      connectionId: connection.id,
      stripeCustomerId: `cus_fixture_${spec.n}`,
      email,
      name: spec.name,
    },
  });
  await prisma.subscription.create({
    data: {
      customerId: customer.id,
      stripeSubscriptionId: `sub_fixture_${spec.n}`,
      status:
        spec.status === "RECOVERED"
          ? "ACTIVE"
          : spec.status.startsWith("LOST")
            ? "CANCELED"
            : "PAST_DUE",
      planName: spec.plan,
      amount: spec.amount,
      currency: spec.currency,
      canceledAt: spec.status.startsWith("LOST") ? closedAt : null,
    },
  });

  const sends = spec.stages.map((stage, i) => {
    const step = DEFAULT_STEPS[i]!;
    const scheduledFor = new Date(failedAt.getTime() + step.delayHours * HOUR);
    const base = {
      kind: "SEQUENCE" as const,
      stageOrder: step.order,
      toEmail: email,
      subject: step.subject,
      scheduledFor,
    };
    if (stage === "pending") return { ...base, status: "SCHEDULED" as const };
    if (typeof stage === "object")
      return { ...base, status: "CANCELED" as const, error: stage.canceled };
    const sentAt = new Date(scheduledFor.getTime() + 5 * 60_000);
    const openedAt = stage !== "s" ? new Date(sentAt.getTime() + 2 * HOUR) : null;
    const clickedAt = stage === "soc" ? new Date(sentAt.getTime() + 3 * HOUR) : null;
    return {
      ...base,
      status: (clickedAt ? "CLICKED" : openedAt ? "OPENED" : "SENT") as "CLICKED" | "OPENED" | "SENT",
      sentAt,
      openedAt,
      clickedAt,
    };
  });
  if (spec.reactivation && closedAt) {
    const sentAt = new Date(closedAt.getTime() + 5 * 60_000);
    sends.push({
      kind: "REACTIVATION" as const,
      stageOrder: REACTIVATION_STAGE_ORDER,
      toEmail: email,
      subject: REACTIVATION_SUBJECT,
      scheduledFor: closedAt,
      status: spec.reactivation === "so" ? ("OPENED" as const) : ("SENT" as const),
      sentAt,
      openedAt: spec.reactivation === "so" ? new Date(sentAt.getTime() + 2 * HOUR) : null,
      clickedAt: null,
    });
  }

  await prisma.dunningCase.create({
    data: {
      connectionId: connection.id,
      customerId: customer.id,
      stripeInvoiceId: `in_fixture_${spec.n}`,
      stripeSubscriptionId: `sub_fixture_${spec.n}`,
      hostedInvoiceUrl: `https://invoice.stripe.com/i/fixture_${spec.n}`,
      amountDue: spec.amount,
      currency: spec.currency,
      attemptCount: spec.attemptCount,
      failureCode: spec.failureCode,
      failureMessage: null,
      status: spec.status,
      campaignId: campaign.id,
      failedAt,
      recoveredAt,
      closedAt: spec.status === "RECOVERED" || spec.status.startsWith("LOST") ? closedAt : null,
      emailSends: { create: sends },
    },
  });

  if (spec.suppressed) {
    await prisma.suppressionEntry.upsert({
      where: { organizationId_email: { organizationId: connection.organizationId, email } },
      create: { organizationId: connection.organizationId, email, reason: "UNSUBSCRIBED" },
      update: {},
    });
  }
  console.log(
    `  #${String(spec.n).padStart(2)} ${spec.status.padEnd(16)} ${(spec.amount / 100).toFixed(2).padStart(7)} ${spec.currency}  ${spec.name}`,
  );
}

console.log(`seeded ${CASES.length} cases for "${connection.organization.name}"`);
await prisma.$disconnect();
