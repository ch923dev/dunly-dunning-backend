import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { createPortalLink } from "../lib/stripe.js";
import { verifyCaseToken } from "../lib/tokens.js";
import { enqueueSequence } from "../jobs/dunning.js";

/**
 * Public, login-free redirect endpoints behind the email footer links
 * (phase-1 spec "Email layer"). The HMAC case token is the authentication.
 */
export const redirectsRouter = Router();

/** Minimal branded page (DESIGN.md palette) for link outcomes. */
function page(title: string, body: string, extra = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#fbfbfa;font-family:Helvetica,Arial,sans-serif;color:#1a1a1a">
<div style="max-width:440px;margin:80px auto;background:#fff;border:1px solid #e8e8e6;border-radius:12px;padding:40px">
<p style="color:#13714c;font-weight:700;font-size:15px;margin:0 0 20px">Dunly</p>
<h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
<p style="color:#3f3f46;font-size:15px;line-height:1.6;margin:0">${body}</p>
${extra}
</div></body></html>`;
}

async function unsubscribe(caseId: string) {
  const dunningCase = await prisma.dunningCase.findUnique({
    where: { id: caseId },
    include: { customer: true, connection: true },
  });
  if (!dunningCase) return null;

  // Workspace-wide suppression: blocks this case AND future cases for the
  // same email (phase-1 spec stop conditions). Idempotent.
  if (dunningCase.customer.email) {
    await prisma.suppressionEntry.upsert({
      where: {
        organizationId_email: {
          organizationId: dunningCase.connection.organizationId,
          email: dunningCase.customer.email,
        },
      },
      create: {
        organizationId: dunningCase.connection.organizationId,
        email: dunningCase.customer.email,
        reason: "UNSUBSCRIBED",
      },
      update: {},
    });
  }

  // Only an ACTIVE case flips — closed states are never overwritten.
  await prisma.dunningCase.updateMany({
    where: { id: dunningCase.id, status: "ACTIVE" },
    data: { status: "SUPPRESSED" },
  });
  await prisma.emailSend.updateMany({
    where: { dunningCaseId: dunningCase.id, status: "SCHEDULED" },
    data: { status: "CANCELED", error: "customer unsubscribed" },
  });

  return dunningCase;
}

redirectsRouter.get("/unsubscribe/:token", async (req: Request, res: Response) => {
  const caseId = verifyCaseToken(String(req.params.token), "unsubscribe");
  const dunningCase = caseId ? await unsubscribe(caseId) : null;
  if (!dunningCase) {
    res.status(404).send(page("This link isn't valid", "The unsubscribe link is incomplete or expired."));
    return;
  }
  const payNote = dunningCase.hostedInvoiceUrl
    ? `<p style="color:#71717a;font-size:13px;line-height:1.6;margin:16px 0 0">If you'd still like to settle the invoice, you can
       <a href="${dunningCase.hostedInvoiceUrl}" style="color:#13714c">pay it here</a> any time.</p>`
    : "";
  res.send(
    page(
      "You're unsubscribed",
      "You won't receive any more payment reminder emails about this subscription. " +
        "Note: automatic payment retries by the card network/Stripe may still occur.",
      payNote,
    ),
  );
});

// RFC 8058 one-click unsubscribe (List-Unsubscribe-Post) — mail clients POST
// here without rendering anything; same effect, empty 200.
redirectsRouter.post("/unsubscribe/:token", async (req: Request, res: Response) => {
  const caseId = verifyCaseToken(String(req.params.token), "unsubscribe");
  if (!caseId || !(await unsubscribe(caseId))) {
    res.status(404).end();
    return;
  }
  res.status(200).end();
});

// ---------------------------------------------------------------------------
// Pre-dunning (phase 4): expiry-case-scoped links. Same doctrine, different
// subject — the token carries a CardExpiryCase id.
// ---------------------------------------------------------------------------

async function unsubscribeExpiry(expiryCaseId: string) {
  const expiryCase = await prisma.cardExpiryCase.findUnique({
    where: { id: expiryCaseId },
    include: { customer: true, connection: true },
  });
  if (!expiryCase) return null;

  const email = expiryCase.customer.email;
  if (email) {
    await prisma.suppressionEntry.upsert({
      where: {
        organizationId_email: {
          organizationId: expiryCase.connection.organizationId,
          email,
        },
      },
      create: {
        organizationId: expiryCase.connection.organizationId,
        email,
        reason: "UNSUBSCRIBED",
      },
      update: {},
    });

    // Advisory fast path (guard-at-send stays the authority): cancel every
    // pending send for this address across the workspace — pre-dunning AND
    // dunning — and flip live dunning cases, exactly as the send guard would.
    await prisma.emailSend.updateMany({
      where: {
        status: "SCHEDULED",
        OR: [
          { cardExpiryCase: { connectionId: expiryCase.connectionId, customer: { email } } },
          { dunningCase: { connectionId: expiryCase.connectionId, customer: { email } } },
        ],
      },
      data: { status: "CANCELED", error: "customer unsubscribed" },
    });
    await prisma.dunningCase.updateMany({
      where: { connectionId: expiryCase.connectionId, customer: { email }, status: "ACTIVE" },
      data: { status: "SUPPRESSED" },
    });
  } else {
    await prisma.emailSend.updateMany({
      where: { cardExpiryCaseId: expiryCase.id, status: "SCHEDULED" },
      data: { status: "CANCELED", error: "customer unsubscribed" },
    });
  }

  // The expiry case itself stays OPEN (phase-4 locked decision #6): a
  // customer we can't email can still update their card, and the prevented
  // metric should record it honestly.
  return expiryCase;
}

redirectsRouter.get("/expiry/unsubscribe/:token", async (req: Request, res: Response) => {
  const expiryCaseId = verifyCaseToken(String(req.params.token), "expiry-unsubscribe");
  const expiryCase = expiryCaseId ? await unsubscribeExpiry(expiryCaseId) : null;
  if (!expiryCase) {
    res.status(404).send(page("This link isn't valid", "The unsubscribe link is incomplete or expired."));
    return;
  }
  res.send(
    page(
      "You're unsubscribed",
      "You won't receive any more card or payment reminder emails about this subscription.",
    ),
  );
});

// RFC 8058 one-click unsubscribe, same as the dunning variant.
redirectsRouter.post("/expiry/unsubscribe/:token", async (req: Request, res: Response) => {
  const expiryCaseId = verifyCaseToken(String(req.params.token), "expiry-unsubscribe");
  if (!expiryCaseId || !(await unsubscribeExpiry(expiryCaseId))) {
    res.status(404).end();
    return;
  }
  res.status(200).end();
});

redirectsRouter.get("/expiry/portal/:token", async (req: Request, res: Response) => {
  const expiryCaseId = verifyCaseToken(String(req.params.token), "expiry-portal");
  const expiryCase = expiryCaseId
    ? await prisma.cardExpiryCase.findUnique({
        where: { id: expiryCaseId },
        include: { customer: true, connection: true },
      })
    : null;
  if (!expiryCase) {
    res.status(404).send(page("This link isn't valid", "The link is incomplete or expired."));
    return;
  }

  try {
    const url = await createPortalLink({
      stripeCustomerId: expiryCase.customer.stripeCustomerId,
      stripeAccountId: expiryCase.connection.stripeAccountId,
    });
    res.redirect(302, url);
  } catch (err) {
    console.error(`[redirects] portal session failed for expiry case ${expiryCase.id}:`, err);
    res
      .status(502)
      .send(
        page(
          "Billing portal unavailable",
          "We couldn't open the card management portal right now. Please try again shortly.",
        ),
      );
  }
});

// ---------------------------------------------------------------------------
// Reply intelligence (phase 5): one-tap merchant actions from the
// reply-forward email. Same guarded transitions as the session API
// endpoints (POST /api/cases/:id/resume|stop); the HMAC token is the
// authentication. Idempotent: a second click reports the state honestly.
// ---------------------------------------------------------------------------

const prettyStatus = (status: string) => status.toLowerCase().replaceAll("_", " ");

redirectsRouter.get("/case/resume/:token", async (req: Request, res: Response) => {
  const caseId = verifyCaseToken(String(req.params.token), "case-resume");
  const dunningCase = caseId
    ? await prisma.dunningCase.findUnique({ where: { id: caseId } })
    : null;
  if (!dunningCase) {
    res.status(404).send(page("This link isn't valid", "The resume link is incomplete or expired."));
    return;
  }

  const { count } = await prisma.dunningCase.updateMany({
    where: { id: dunningCase.id, status: "PAUSED" },
    data: { status: "ACTIVE" },
  });
  if (count === 0) {
    res.send(
      page(
        "Nothing to resume",
        dunningCase.status === "ACTIVE"
          ? "This sequence is already running — maybe you clicked twice."
          : `This case is ${prettyStatus(dunningCase.status)}, so the sequence can't resume.`,
      ),
    );
    return;
  }

  // One idempotent kick re-enqueues every held send (phase-3 self-heal path).
  await enqueueSequence(dunningCase.id);
  console.log(`[redirects] resumed case ${dunningCase.id} via reply-forward link`);
  res.send(
    page(
      "Sequence resumed",
      "Recovery emails for this case are running again. Held emails will go out on their schedule.",
    ),
  );
});

redirectsRouter.get("/case/stop/:token", async (req: Request, res: Response) => {
  const caseId = verifyCaseToken(String(req.params.token), "case-stop");
  const dunningCase = caseId
    ? await prisma.dunningCase.findUnique({ where: { id: caseId } })
    : null;
  if (!dunningCase) {
    res.status(404).send(page("This link isn't valid", "The stop link is incomplete or expired."));
    return;
  }

  // Same semantics as the API stop: abandoning an involuntary failure is an
  // involuntary loss (phase-3 locked decision #4). Irreversible.
  const { count } = await prisma.dunningCase.updateMany({
    where: { id: dunningCase.id, status: { in: ["ACTIVE", "PAUSED"] } },
    data: { status: "LOST_INVOLUNTARY", closedAt: new Date() },
  });
  if (count === 0) {
    res.send(
      page(
        "Nothing to stop",
        `This case is already ${prettyStatus(dunningCase.status)} — no emails were pending.`,
      ),
    );
    return;
  }
  await prisma.emailSend.updateMany({
    where: { dunningCaseId: dunningCase.id, status: "SCHEDULED" },
    data: { status: "CANCELED", error: "stopped from reply forward" },
  });
  console.log(`[redirects] stopped case ${dunningCase.id} via reply-forward link (marked lost)`);
  res.send(
    page(
      "Sequence stopped",
      "The case is closed and marked lost — no more recovery emails will be sent for this invoice.",
    ),
  );
});

redirectsRouter.get("/portal/:token", async (req: Request, res: Response) => {
  const caseId = verifyCaseToken(String(req.params.token), "portal");
  const dunningCase = caseId
    ? await prisma.dunningCase.findUnique({
        where: { id: caseId },
        include: { customer: true, connection: true },
      })
    : null;
  if (!dunningCase) {
    res.status(404).send(page("This link isn't valid", "The link is incomplete or expired."));
    return;
  }

  try {
    // Portal session URLs are short-lived — mint a fresh one per click
    // (never embed a session URL in an email).
    const url = await createPortalLink({
      stripeCustomerId: dunningCase.customer.stripeCustomerId,
      stripeAccountId: dunningCase.connection.stripeAccountId,
      ...(dunningCase.hostedInvoiceUrl ? { returnUrl: dunningCase.hostedInvoiceUrl } : {}),
    });
    res.redirect(302, url);
  } catch (err) {
    console.error(`[redirects] portal session failed for case ${dunningCase.id}:`, err);
    const fallback = dunningCase.hostedInvoiceUrl
      ? `<p style="margin:16px 0 0"><a href="${dunningCase.hostedInvoiceUrl}" style="color:#13714c;font-weight:600">Pay or update your card on the invoice page →</a></p>`
      : "";
    res
      .status(502)
      .send(
        page(
          "Billing portal unavailable",
          "We couldn't open the subscription management portal right now. Please try again shortly.",
          fallback,
        ),
      );
  }
});
