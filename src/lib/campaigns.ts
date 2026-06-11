import { prisma } from "./prisma.js";

/**
 * Default 4-touch dunning sequence (product plan §5.2, phase-1 spec).
 * Delays are measured from DunningCase.failedAt. Subjects support the same
 * merge variables as the templates ({{company_name}} etc.).
 */
// Subject copy follows the design prototype (dunly-design data.js), limited
// to merge vars supported in Phase 1 ({{days_until_cancellation}} is Phase 2).
export const DEFAULT_STEPS = [
  {
    order: 1,
    delayHours: 0, // Day 0 — friendly heads-up
    subject: "A quick hiccup with your {{company_name}} payment",
    templateKey: "payment-failed-1",
  },
  {
    order: 2,
    delayHours: 72, // Day 3 — quick reminder
    subject: "Your {{company_name}} access is at risk",
    templateKey: "payment-failed-2",
  },
  {
    order: 3,
    delayHours: 168, // Day 7 — urgency
    subject: "Action needed: update your card to keep access",
    templateKey: "payment-failed-3",
  },
  {
    order: 4,
    delayHours: 288, // Day 12 — final notice
    subject: "Final notice — your {{company_name}} subscription will be canceled soon",
    templateKey: "payment-failed-4",
  },
] as const;

export const DEFAULT_CAMPAIGN_NAME = "Default sequence";

/**
 * One-shot reactivation email on LOST_INVOLUNTARY close (phase-1 spec,
 * locked decision #1). Not a campaign step — reserved stageOrder keeps the
 * EmailSend "never twice per case" constraint authoritative for it too.
 */
export const REACTIVATION_STAGE_ORDER = 100;
export const REACTIVATION_TEMPLATE_KEY = "reactivation";
export const REACTIVATION_SUBJECT =
  "Your {{company_name}} subscription has ended — restart in one click";

/**
 * Returns the workspace's active campaign, creating the default 4-touch one
 * if none exists. Called from the signup hook (new workspaces) and lazily by
 * the sequence worker (self-heals workspaces created before Phase 1).
 * Oldest active campaign wins, so concurrent creation stays deterministic.
 */
export async function ensureDefaultCampaign(organizationId: string) {
  const existing = await prisma.dunningCampaign.findFirst({
    where: { organizationId, isActive: true },
    orderBy: { createdAt: "asc" },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (existing) return existing;

  return prisma.dunningCampaign.create({
    data: {
      organizationId,
      name: DEFAULT_CAMPAIGN_NAME,
      steps: { create: [...DEFAULT_STEPS] },
    },
    include: { steps: { orderBy: { order: "asc" } } },
  });
}
