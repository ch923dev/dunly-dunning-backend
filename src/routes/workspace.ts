import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getWorkspace, requireOwner } from "../middleware/workspace.js";

export const workspaceRouter = Router();

// Valid IANA zone names per this Node build — same source the send-window
// scheduler will use, so a saved timezone is guaranteed schedulable.
const TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

async function workspacePayload(organizationId: string, role: string) {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    include: { settings: true },
  });
  if (!org) return null;
  return {
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
          expiryTouch1Enabled: org.settings.expiryTouch1Enabled,
          expiryTouch2Enabled: org.settings.expiryTouch2Enabled,
        }
      : null,
  };
}

/** Workspace shell for the dashboard: org + settings + caller's role. */
workspaceRouter.get("/", async (req, res, next) => {
  try {
    const { organizationId, role } = getWorkspace(req);
    const payload = await workspacePayload(organizationId, role);
    if (!payload) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

// "" means "clear this setting" — the UI submits empty inputs, the emails
// fall back to defaults on null.
const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  logoUrl: z.union([z.url().max(500), z.literal(""), z.null()]).optional(),
  brandColor: z
    .union([z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb hex color"), z.literal(""), z.null()])
    .optional(),
  replyTo: z.union([z.email().max(254), z.literal(""), z.null()]).optional(),
  timezone: z
    .string()
    .refine((tz) => TIMEZONES.has(tz), "unknown IANA timezone")
    .optional(),
  // Pre-dunning per-touch enables (phase-4 locked decision #8). Disabling
  // after touches are scheduled is honored by the send-time guard.
  expiryTouch1Enabled: z.boolean().optional(),
  expiryTouch2Enabled: z.boolean().optional(),
});

const emptyToNull = (v: string | null) => (v === "" ? null : v);

/** Update org name and/or workspace settings. Owner-only. */
workspaceRouter.patch("/", requireOwner, async (req, res, next) => {
  try {
    const { organizationId, role } = getWorkspace(req);
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation",
        details: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const input = parsed.data;

    if (input.name !== undefined) {
      await prisma.organization.update({
        where: { id: organizationId },
        data: { name: input.name },
      });
    }

    const settings: {
      logoUrl?: string | null;
      brandColor?: string | null;
      replyTo?: string | null;
      timezone?: string;
      expiryTouch1Enabled?: boolean;
      expiryTouch2Enabled?: boolean;
    } = {};
    if (input.logoUrl !== undefined) settings.logoUrl = emptyToNull(input.logoUrl);
    if (input.brandColor !== undefined) settings.brandColor = emptyToNull(input.brandColor);
    if (input.replyTo !== undefined) settings.replyTo = emptyToNull(input.replyTo);
    if (input.timezone !== undefined) settings.timezone = input.timezone;
    if (input.expiryTouch1Enabled !== undefined) settings.expiryTouch1Enabled = input.expiryTouch1Enabled;
    if (input.expiryTouch2Enabled !== undefined) settings.expiryTouch2Enabled = input.expiryTouch2Enabled;
    if (Object.keys(settings).length > 0) {
      await prisma.workspaceSettings.upsert({
        where: { organizationId },
        create: { organizationId, ...settings },
        update: settings,
      });
    }

    res.json(await workspacePayload(organizationId, role));
  } catch (err) {
    next(err);
  }
});
