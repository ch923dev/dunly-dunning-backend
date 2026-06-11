import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const workspaceRouter = Router();

/** Workspace shell for the dashboard: org + settings + caller's role. */
workspaceRouter.get("/", async (req, res, next) => {
  try {
    const { organizationId, role } = req.workspace!;

    const org = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: { settings: true },
    });
    if (!org) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    res.json({
      id: org.id,
      name: org.name,
      slug: org.slug,
      role,
      settings: org.settings
        ? {
            logoUrl: org.settings.logoUrl,
            brandColor: org.settings.brandColor,
            replyTo: org.settings.replyTo,
            timezone: org.settings.timezone,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});
