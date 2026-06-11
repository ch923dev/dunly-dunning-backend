/** Dev utility: backfill the default campaign for workspaces that predate Phase 1. */
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { ensureDefaultCampaign } from "../src/lib/campaigns.js";

const orgs = await prisma.organization.findMany({ select: { id: true, name: true } });
for (const org of orgs) {
  const campaign = await ensureDefaultCampaign(org.id);
  console.log(`${org.name} (${org.id}) → "${campaign.name}" (${campaign.steps.length} steps)`);
}
await prisma.$disconnect();
