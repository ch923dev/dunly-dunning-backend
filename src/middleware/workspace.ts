import type { Request, RequestHandler } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";

/**
 * Typed accessor for the workspace context set by requireWorkspace.
 * Throws (→ 500) if called on a route that isn't behind the middleware —
 * a programming error, not a client error.
 */
export function getWorkspace(req: Request) {
  if (!req.workspace) {
    throw new Error("getWorkspace called outside requireWorkspace middleware");
  }
  return req.workspace;
}

/**
 * Resolves the session and the caller's workspace, attaching both to
 * `req.workspace`. Applied once to the whole /api router (webhooks and
 * /api/auth are exempt — they authenticate differently).
 */
/** Owner-gated actions (connect/disconnect Stripe, billing, settings). */
export const requireOwner: RequestHandler = (req, res, next) => {
  if (req.workspace?.role !== "owner") {
    res.status(403).json({ error: "owner_required" });
    return;
  }
  next();
};

export const requireWorkspace: RequestHandler = async (req, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    // activeOrganizationId is null on the signup-flow session (the workspace
    // hook finishes after Better Auth creates the session row), so fall back
    // to the user's first membership. The membership query also verifies the
    // user actually belongs to the active org — never trust the id alone.
    const activeOrganizationId = session.session.activeOrganizationId ?? null;
    const member = await prisma.member.findFirst({
      where: {
        userId: session.user.id,
        ...(activeOrganizationId ? { organizationId: activeOrganizationId } : {}),
      },
      orderBy: { createdAt: "asc" },
    });
    if (!member) {
      res.status(403).json({ error: "no_workspace" });
      return;
    }

    req.workspace = {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
      },
      organizationId: member.organizationId,
      role: member.role,
    };
    next();
  } catch (err) {
    next(err);
  }
};
