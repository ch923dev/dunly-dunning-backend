import express, { Router } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { toNodeHandler } from "better-auth/node";
import { env } from "./env.js";
import { auth } from "./lib/auth.js";
import { healthRouter, healthDetailsRouter } from "./routes/health.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { portalRouter } from "./routes/portal.js";
import { workspaceRouter } from "./routes/workspace.js";
import { metricsRouter } from "./routes/metrics.js";
import { casesRouter } from "./routes/cases.js";
import { expiringCardsRouter } from "./routes/expiring-cards.js";
import { campaignRouter } from "./routes/campaign.js";
import { templatesRouter } from "./routes/templates.js";
import { stripeRouter } from "./routes/stripe.js";
import { stripeCallbackRouter } from "./routes/stripe-callback.js";
import { redirectsRouter } from "./routes/redirects.js";
import { requireWorkspace } from "./middleware/workspace.js";
import { errorHandler } from "./middleware/error.js";

/**
 * Public-surface abuse throttles (audit B3). Per-IP, in-memory — right for
 * the single-process deployment; swap in a shared store before scaling out.
 * Production note: behind a proxy/LB set `app.set("trust proxy", 1)` or
 * every client is counted against the proxy's IP.
 */
const limiterDefaults = { windowMs: 60_000, standardHeaders: true, legacyHeaders: false } as const;
/** Generous — Stripe/Resend legitimately burst on redelivery. */
const webhookLimiter = rateLimit({ ...limiterDefaults, limit: 600 });
/** Email footer/action links — humans click these. */
const linkLimiter = rateLimit({ ...limiterDefaults, limit: 30 });
/** Portal links mint a Stripe session (external API call) per hit. */
const portalLimiter = rateLimit({ ...limiterDefaults, limit: 10 });

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: env.APP_URL,
      credentials: true,
    }),
  );

  // Stripe webhooks need the raw body for signature verification —
  // mounted BEFORE express.json(), and never behind session auth
  // (signature verification is their only authentication).
  app.use("/webhooks", webhookLimiter, webhooksRouter);

  // Better Auth handles its own body parsing — mount BEFORE express.json().
  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.use(express.json());

  app.use("/health", healthRouter);

  // Email footer links (unsubscribe / portal) — public by design, the
  // HMAC-signed case token is the authentication. Portal paths get the
  // tighter limiter first (they hit Stripe per request), then the general
  // link limiter applies to all of /r.
  app.use(["/r/portal", "/r/expiry/portal"], portalLimiter);
  app.use("/r", linkLimiter, redirectsRouter);

  // OAuth callback: the browser arrives from Stripe with no guarantees about
  // session state — the single-use state token is the authentication.
  // Mounted before the workspace guard on purpose.
  app.use("/api/stripe/callback", stripeCallbackRouter);

  // Everything under /api (except /api/auth and the callback above) is
  // workspace-scoped.
  const api = Router();
  api.use(requireWorkspace);
  api.use("/health", healthDetailsRouter);
  api.use("/workspace", workspaceRouter);
  api.use("/metrics", metricsRouter);
  api.use("/cases", casesRouter);
  api.use("/expiring-cards", expiringCardsRouter);
  api.use("/campaign", campaignRouter);
  api.use(templatesRouter); // POST /api/preview · POST /api/test-send
  api.use("/stripe", stripeRouter);
  api.use("/portal", portalRouter);
  app.use("/api", api);

  app.use(errorHandler);

  return app;
}
