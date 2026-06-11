import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins";
import { prisma } from "./prisma.js";
import { DEFAULT_CAMPAIGN_NAME, DEFAULT_STEPS } from "./campaigns.js";
import { env } from "../env.js";

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 32);
  return `${base || "workspace"}-${randomUUID().slice(0, 6)}`;
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: [env.APP_URL],
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    organization({
      // MVP: every user gets exactly one auto-created workspace; manual
      // creation stays off until multi-workspace ships.
      allowUserToCreateOrganization: false,
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        // Auto-create workspace (organization + owner membership + settings)
        // for every new signup. Spec: docs/phase-0-foundation.md §5.
        after: async (user) => {
          await prisma.organization.create({
            data: {
              name: `${user.name}'s workspace`,
              slug: slugify(user.name),
              members: {
                create: { userId: user.id, role: "owner" },
              },
              settings: {
                create: { replyTo: user.email },
              },
              campaigns: {
                create: {
                  name: DEFAULT_CAMPAIGN_NAME,
                  steps: { create: [...DEFAULT_STEPS] },
                },
              },
            },
          });
        },
      },
    },
    session: {
      create: {
        // New sessions start scoped to the user's (only) workspace.
        before: async (session) => {
          const member = await prisma.member.findFirst({
            where: { userId: session.userId },
            select: { organizationId: true },
          });
          return {
            data: { ...session, activeOrganizationId: member?.organizationId ?? null },
          };
        },
      },
    },
  },
});

export type Auth = typeof auth;
