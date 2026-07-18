# Dunly — Product Plan
### A Dunning & Failed-Payment Recovery SaaS for Stripe Subscription Businesses

**Version:** 0.2 (MVP Plan) · **Date:** June 2026 · **Status:** Core decisions locked — name, pricing model, pre-dunning scope, sender strategy

---

## 1. Executive Summary

Dunly is a SaaS product that helps subscription businesses recover revenue lost to failed payments. Customers connect their Stripe account in minutes, customize a sequence of branded dunning emails, and let the platform automatically chase failed invoices — combining Stripe's Smart Retries with well-timed, personalized recovery emails and a hosted "update your card" experience.

Involuntary churn (failed cards, expired cards, insufficient funds) typically accounts for 20–40% of total churn for subscription companies. Most small and mid-size SaaS businesses either rely on Stripe's bare-bones built-in emails or do nothing at all. Dunly's pitch is simple: **"Connect Stripe, recover 50–70% of failed payments, pay only when we recover money for you."**

The MVP focuses on four pillars: a one-click Stripe integration, pre-dunning (preventing failures before they happen), an email template and sequence editor, and a recovery dashboard that proves ROI.

---

## 2. Problem Statement

1. **Failed payments are silent revenue killers.** Cards expire, get reissued, hit limits, or fail for network reasons. The customer never *chose* to cancel, but the subscription dies anyway.
2. **Stripe's defaults are generic.** Built-in reminder emails are unbranded, not sequenced strategically, and offer limited copy control. Businesses can't A/B test or adjust tone/timing per plan or customer segment.
3. **Building dunning in-house is a distraction.** It requires webhook infrastructure, retry logic, email deliverability work, idempotency handling, and analytics — none of which is core to the customer's product.
4. **Existing tools are pricey or bundled.** Competitors (Churnbuster, Baremetrics Recover, Churnkey) either charge high flat fees or bundle dunning inside larger analytics suites. There's room for a focused, affordable, self-serve tool.

---

## 3. Target Customers

| Segment | Profile | Why they buy |
|---|---|---|
| **Primary:** Indie SaaS & micro-SaaS | $1k–$50k MRR, Stripe Billing, 1–5 person team | No time to build dunning; every recovered dollar matters |
| **Secondary:** Mid-size SaaS | $50k–$500k MRR, small growth team | Wants branded sequences, segmentation, and reporting |
| **Tertiary:** Membership / creator businesses | Patreon-style memberships, communities, newsletters on Stripe | High card-failure rates, non-technical owners |

Initial go-to-market focuses on the primary segment: self-serve onboarding, low entry price, and a performance-based pricing tier that removes purchase risk.

---

## 4. Value Proposition & Differentiators

- **Time-to-value under 10 minutes:** OAuth into Stripe, pick a template, go live.
- **Recovery-aligned pricing:** a percentage-of-recovered-revenue plan so customers only pay when it works.
- **Template-first experience:** beautiful, proven email templates with a visual editor — the heart of the product.
- **Transparent ROI dashboard:** "You recovered $4,310 this month" is the retention engine for *our* product too.
- **Lightweight by design:** not a churn-analytics suite; one job, done extremely well.

---

## 5. MVP Feature Set

### 5.1 Stripe Integration Layer
The foundation. Everything else depends on reliable, real-time payment-event data.

- **Stripe Connect (OAuth) onboarding** — user clicks "Connect Stripe," authorizes read/webhook access; no API keys to copy-paste.
- **Per-workspace webhook routing** — each workspace gets a unique ingestion URL (`dunly.com/webhooks/<userId>/<productId>`) used for routing, isolation, and debugging. With Stripe Connect, events also arrive at the platform endpoint tagged with the connected account ID; both paths converge on the same processor. **Security rule:** URL identifiers are routing hints only — every request is authenticated by Stripe webhook signature verification, never by the URL.
- **Webhook ingestion** for the core event set:
  - `invoice.payment_failed` → triggers/advances a dunning sequence
  - `invoice.paid` / `invoice.payment_succeeded` → marks invoice recovered, stops the sequence, optionally sends a "thanks, you're all set" email
  - `customer.subscription.deleted` → closes the case as lost. **Reads `cancellation_details` to distinguish involuntary (retries exhausted) from voluntary (customer chose to cancel):** involuntary → send the one-shot reactivation email; voluntary → stop everything, never send win-back content.
  - `charge.dispute.created` → pauses dunning for that customer (never dun a disputing customer)
- **Smart Retries pass-through:** Dunly assumes Stripe Smart Retries is enabled and layers emails on top of Stripe's retry attempts; settings page includes guided instructions (and detection of) the customer's Stripe retry configuration.
- **Idempotent event processing** — every webhook event is deduplicated; an invoice can never receive the same stage email twice.
- **Hosted payment recovery link** — emails deep-link to Stripe's hosted invoice page (`hosted_invoice_url`) so the customer can pay or update their card without us touching card data (keeps the MVP fully out of PCI scope).
- **Sandbox/test mode** — connect a Stripe test account and fire simulated failures to preview the full flow before going live.

### 5.2 Dunning Sequence Engine
The logic that decides *what* to send and *when*.

- **Default 4-touch sequence** (editable):
  1. **Day 0 — "Payment issue"**: friendly heads-up immediately after first failure
  2. **Day 3 — "Quick reminder"**: shorter nudge, restates the update-card link
  3. **Day 7 — "Action needed"**: urgency, mentions service interruption risk
  4. **Day 12 — "Final notice"**: last chance before cancellation per their Stripe settings
- **One-shot reactivation email (Stage 5, involuntary cancels only):** if Stripe cancels the subscription after retries are exhausted, send a single "your subscription ended due to a payment issue — reactivate here" email. Never sent to voluntary cancels; never a multi-touch drip (full win-back campaigns remain Phase 3).
- **Cancellation escape hatch:** every dunning email footer includes a "Manage or cancel your subscription" link to the merchant's **Stripe Customer Portal**. A customer who wants out mid-recovery gets a clean exit instead of disputing the charge or marking the email as spam — converting angry churn into clean churn protects the merchant's dispute rate and our sending reputation.
- **Email unsubscribe (suppression) mid-recovery:** unsubscribe link adds the customer to the workspace suppression list and halts all sends for that case, which flips to `suppressed`. **Stripe's Smart Retries continue regardless** (we control emails, not retries), so a suppressed case can still close as recovered.
- **Per-stage controls:** delay, enable/disable, send window (e.g., only 9am–6pm in customer's timezone), skip-if-amount-below threshold.
- **Automatic stop conditions:** payment recovered, subscription canceled (voluntary or involuntary), customer disputed, or customer unsubscribed from dunning emails.
- **Case states per invoice:** `active → recovered | lost-involuntary | lost-voluntary | suppressed | paused`, visible in the dashboard. Voluntary cancels are excluded from recovery-rate math — you can't "recover" someone who quit on purpose.

### 5.3 Pre-Dunning (Card-Expiry Prevention) — now in MVP
Prevent the failure instead of recovering from it. Industry data consistently shows expired cards are a top driver of involuntary churn, and prevention emails outperform recovery emails.

- **Expiring-card detection:** monthly scan of active subscriptions' default payment methods (card `exp_month`/`exp_year` via the Stripe API), plus listening for card-update events.
- **2-touch pre-dunning sequence:** ~21 days and ~7 days before expiry — "Your card ending {{card_last4}} expires this month — update it to keep your service running."
- **Framing rule baked into default templates:** service-continuity language ("keep your access"), never charge-reminder language ("you will be billed") — the former measurably converts better and minimizes reminder-triggered cancellations.
- **Auto-suppression:** sequence stops the moment a new card is attached; pre-dunning never overlaps with an active failed-payment sequence for the same customer.

### 5.4 Email Template Editor (Account-level Templates)
This is the feature the user explicitly manages — their voice, their brand.

- **Template library:** 3–5 professionally written starter templates (friendly, neutral, urgent tones) the user can clone.
- **Visual editor (MVP scope = rich-text, not drag-and-drop):** edit subject line, body, button text/color, logo, footer.
- **Merge variables:** `{{customer_name}}`, `{{amount_due}}`, `{{card_last4}}`, `{{plan_name}}`, `{{update_payment_link}}`, `{{company_name}}`, `{{days_until_cancellation}}`.
- **Per-stage templates:** each of the 4 sequence stages, the reactivation email, and the 2 pre-dunning touches has its own template (7 total); users can edit each independently or apply one brand style globally.
- **Required footer elements (non-removable):** unsubscribe link and "Manage or cancel your subscription" link (Stripe Customer Portal). Locked in the editor — they protect deliverability and dispute rates.
- **Live preview & test send:** render with sample data; send a test to the account owner's email.
- **Sending identity — staged strategy:**
  - **MVP (shared domain):** sends from `billing@mail.dunly.com` with the user's brand name as the friendly-from and their address as reply-to. One-time SPF/DKIM setup on our domain; every customer is authenticated from day one.
  - **Phase 2 (custom domain — paid tier):** user verifies their own domain via a guided DNS wizard (Resend domain verification API); emails then send as `billing@theirdomain.com` through our infrastructure. No mailbox required — the address doesn't need to exist; replies still route to their real reply-to. This delivers ~95% of the "from us" authenticity at a fraction of the effort.
  - **Phase 3 (bring-your-own provider):** power users can plug in their own Resend/SendGrid/Postmark API key or SMTP credentials to send through their account.
  - **Explicitly skipped:** Gmail/Microsoft 365 mailbox OAuth. Google's security review + paid CASA audit for send scopes, daily send caps, and perpetual token-refresh maintenance aren't justified for transactional billing email.

### 5.5 Account Management
- **Auth:** email + password and Google sign-in; standard session handling.
- **Workspace settings:** company name, logo, brand color, default reply-to, timezone.
- **Stripe connection management:** view connection status, reconnect, disconnect; one Stripe account per workspace in MVP (multi-account is a paid-tier fast-follow).
- **Team members (lite):** owner + invited members with a single shared role in MVP; granular roles deferred.
- **Billing for Dunly itself:** powered by Stripe (naturally) — plan selection, card management, invoices.
- **Notification preferences:** weekly recovery digest email; instant alert on large failed invoices (threshold configurable).

### 5.6 Recovery Dashboard & Analytics
The proof-of-ROI layer that drives retention and word of mouth.

- **Headline metrics:** revenue at risk (open failed invoices), revenue recovered (this month / all time), recovery rate %, average days-to-recovery.
- **Active cases table:** every in-flight dunning sequence — customer, amount, stage, next email date, status (active / recovered / lost-voluntary / lost-involuntary / suppressed / paused) — with the ability to pause or stop a case manually.
- **Honest churn split:** voluntary cancels reported separately from involuntary losses so the recovery-rate metric stays credible.
- **Email performance:** per-stage sends, opens, clicks, and recoveries attributed to each stage (last-touch attribution in MVP).
- **Activity log:** timeline per customer (failure detected → email 1 sent → link clicked → payment recovered).

### 5.7 Compliance & Trust (MVP-mandatory, not optional)
- Unsubscribe handling for dunning emails (suppression list per workspace) — note: transactional billing emails have more legal latitude than marketing email, but honoring opt-outs builds trust and protects deliverability.
- No card data ever stored — all payment updates happen on Stripe-hosted pages.
- Data deletion on workspace close; minimal PII retention (name, email, invoice metadata).
- Webhook signature verification and per-workspace data isolation.

---

## 6. Explicitly Out of Scope for MVP (Fast-Follow Roadmap)

| Feature | Why deferred | Target phase |
|---|---|---|
| Custom sending domains (DNS verification wizard) | Deliverability setup complexity | Phase 2 (first paid-tier differentiator) |
| Bring-your-own email provider (API key / SMTP) | Niche, credential-storage burden | Phase 3 |
| Gmail / Microsoft 365 mailbox OAuth sending | Google security review + CASA audit, send caps | Skipped unless demanded |
| SMS / in-app dunning channels | New channel = new infra & compliance | Phase 2–3 |
| A/B testing of templates & timing | Needs volume to be meaningful | Phase 2 |
| Win-back campaigns post-cancellation | Marketing-email territory | Phase 3 |
| Braintree / Paddle / Chargebee integrations | Stripe-only keeps MVP focused | Phase 3 |
| Drag-and-drop email builder | Rich-text editor is sufficient to launch | Phase 3 |
| Granular team roles & permissions | Lite team sharing covers early customers | Phase 3 |

---

## 7. Technical Architecture & Stack (Final)

### 7.1 Chosen stack — TypeScript end to end

One language across the whole product so every hour of learning compounds, with type safety where it matters most (money-adjacent data).

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript** | Single language for backend, frontend, and email templates; compile-time safety for amounts/states |
| Backend | **Node.js + Express** | Simplest mental model; Stripe docs and examples are Node-first |
| Database | **PostgreSQL + Prisma** | Readable schema file, fully typed queries, one-command migrations; holds the case-state machine |
| Job queue | **pg-boss** (Postgres-backed) | Replaces BullMQ + Redis — one less datastore to learn, deploy, and pay for; ample at MVP scale, swap to BullMQ only if volume demands |
| Frontend | **React + Vite + Tailwind** | Wireframes are already Tailwind; a logged-in SPA + separate API is simpler to reason about than Next.js for this product |
| Email | **react-email + Resend** | Templates as React components — dashboard skills reused; Resend SDK for delivery + event webhooks |
| Payments | **Stripe SDK** | Webhooks, signature verification, Connect OAuth, Customer Portal — the domain skill that is the product's real moat |
| Hosting | **Railway or Render** | Git-push deploys, managed Postgres included, zero DevOps |

### 7.2 Core services

1. **Webhook service** — receives Stripe events (signature-verified, raw-body), deduplicates by event ID, writes to an events table, and enqueues jobs.
2. **Sequence scheduler** — pg-boss jobs that evaluate active dunning cases and schedule stage emails respecting delays, send windows, and stop conditions; delayed-job cancellation handles every stop condition.
3. **Email service** — renders react-email templates with merge variables and sends via Resend; ingests Resend webhooks for delivery/open/click events to power analytics.
4. **API + dashboard app** — REST API consumed by the React dashboard; handles auth, workspace settings, template CRUD, and analytics queries.

**Key data entities:** Workspace, User, StripeConnection, DunningCase (per failed invoice, six states), SequenceStage, EmailTemplate, EmailSend, EventLog, SuppressionEntry.

**Reliability principles:** idempotency on every external event, at-least-once job processing with dedupe keys, and a "never send the same stage twice per invoice" database constraint as the last line of defense.

### 7.3 Founder learning path (~6–8 weeks, ordered)

1. **TypeScript fundamentals + Node basics**
2. **Express + Stripe webhooks** — build a signature-verified webhook endpoint early using Stripe CLI local forwarding; this is the product's beating heart
3. **Postgres + Prisma** — model Workspace, DunningCase, EmailTemplate
4. **pg-boss** — schedule a delayed job ("send email in 3 days") and cancel it; that exercise *is* the sequence engine in miniature
5. **Resend + react-email** — send the first templated email
6. **React + Tailwind** — build the dashboard against your own API

Guiding principle when building with AI assistance (Claude Code): the leverage is in understanding the **architecture** — webhook idempotency, the case-state machine, queue semantics — well enough to review and direct generated code, not in memorizing syntax.

### 7.4 Deployment infrastructure

**Launch requirements (~$20–50/mo total):** one hosting platform running the Express API + worker (Railway/Render, or a small VPS), managed PostgreSQL with backups verified, domain + DNS (`app.`, `api.`, `mail.` subdomains), Resend with `mail.dunly.com` verified, Stripe platform account registered for Connect, frontend on Vercel/Netlify/Cloudflare Pages or served from the same Express app.

**Operational must-haves:** Sentry (a silent webhook bug = silently lost recoveries), uptime monitoring on the webhook endpoint, platform-native secrets management. **Deferred until traction:** staging environment, CI/CD, log aggregation, CDN. No Redis (thanks to pg-boss), no serverless for the worker (the scheduler wants a long-running process), no Kubernetes — ever, hopefully.

---

## 8. Pricing Model (Proposed)

All plans start with a **14-day free trial** (full features, card required at trial end). There is **no permanent free tier** — dunning proves its value within days, and a trial converts better than a capped free plan while avoiding the cost of supporting non-payers.

| Plan | Price | Includes |
|---|---|---|
| **Growth** | $49/mo | Unlimited recovery volume, full template editor, pre-dunning, weekly digest |
| **Performance** | 5% of recovered revenue (min $0) | Everything in Growth; pay-as-you-recover for risk-averse buyers |
| **Scale** (Phase 2) | $199/mo | Custom domain sending, A/B testing, multiple Stripe accounts, priority support |

A "Powered by Dunly" footer link in trial-period emails (removable on any paid plan) preserves a lightweight word-of-mouth loop. Performance pricing converts skeptics — typical MVP target: a customer at $20k MRR with ~7% payment failure and 60% recovery sees roughly $700–$850/mo recovered, making either paid plan an obvious win.

---

## 9. Success Metrics

**Product (per customer):**
- Recovery rate ≥ 50% of failed invoice value within 14 days (north star)
- Time-to-first-recovery < 7 days from signup
- Email deliverability ≥ 99% delivered, < 0.1% spam complaints

**Business:**
- Activation: % of signups that connect Stripe and enable a sequence within 24h (target 60%+)
- Week-4 retention of activated workspaces (target 80%+)
- Trial → paid conversion (target 25–40%, typical for card-required trials with fast time-to-value)

---

## 10. Build Plan & Milestones

| Phase | Duration | Deliverable |
|---|---|---|
| **0 — Foundation** | Week 1–2 | Stripe Connect OAuth, webhook ingestion, event store, idempotency |
| **1 — Dunning core** | Week 3–4 | Sequence engine, default templates, Resend sending, stop conditions |
| **2 — Product shell** | Week 5–6 | Auth, workspace settings, template editor with preview/test-send |
| **3 — Dashboard** | Week 7–8 | Recovery metrics, active cases table, email performance, activity log |
| **4 — Pre-dunning** | Week 9 | Expiring-card scanner, 2-touch prevention sequence, auto-suppression |
| **5 — Launch hardening** | Week 10–11 | Test-mode simulator, suppression/unsubscribe, trial billing, docs |
| **Beta launch** | Week 11 | 10–20 design partners from indie-SaaS communities; iterate on copy/timing defaults |

> **Resequencing note:** the built Phase 5 is **reply intelligence**
> (`phase-5-reply-intelligence.md`) — it displaced the launch-hardening slot
> above. Launch hardening was executed separately as the 2026-06 audit
> remediation (phases A–E); suppression/unsubscribe shipped inside build
> phases 1–2, and trial billing remains deferred.

---

## 11. Risks & Mitigations

- **Deliverability risk:** dunning emails landing in spam destroys the value prop. → Shared sending domain with strict warm-up, Resend's managed infrastructure, transactional-only content, and custom domains as the Phase-2 priority.
- **Platform risk (Stripe ships better built-in dunning):** Stripe keeps improving Billing's revenue-recovery features. → Differentiate on customization, branding, analytics depth, and eventually multi-processor support.
- **Attribution disputes ("would have recovered anyway"):** Smart Retries alone recovers some revenue. → Show stage-level attribution honestly (recovered after click vs. recovered by retry) — transparency is a trust feature.
- **Crowded category:** Churnbuster, Baremetrics Recover, Churnkey, Stunning. → Win on price, self-serve speed, and indie-friendly positioning rather than feature breadth.

---

## 12. Decisions Log & Remaining Questions

**Decided:**
1. ✅ No free tier — 14-day full-feature trial, card required.
2. ✅ Per-workspace webhook URLs (`/webhooks/<userId>/<productId>`) for routing, with Stripe Connect OAuth layered on for onboarding; signature verification is the only authentication.
3. ✅ Pre-dunning (card-expiry prevention) is in MVP scope (+1 week to timeline).
4. ✅ Sender strategy: shared domain → custom domain (Phase 2, paid) → BYO provider (Phase 3); mailbox OAuth skipped.
5. ✅ Name: **Dunly**.
6. ✅ Final stack: TypeScript end to end — Express, Postgres + Prisma, pg-boss (no Redis), React + Vite + Tailwind, react-email + Resend, Railway/Render hosting.

**Still open:**
1. Performance pricing: 5% flat vs. tiered (e.g., 8% on first $1k recovered, 4% after)?
2. Domain availability and trademark check for "Dunly" (dunly.com / dunly.io / getdunly.com).
3. Card required at trial start vs. at trial end? (Start = higher-intent signups; end = more top-of-funnel volume.)