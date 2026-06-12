# Phase 1 — Dunning Core (Locked Spec)

**Status: ✅ COMPLETE — all 9 exit criteria verified 2026-06-11** (see notes at bottom)

**Scope:** sequence engine · default templates · Resend sending · stop conditions · suppression
**Out of scope:** template editor UI, per-stage control *enforcement* (schema only), custom
sending domains, pre-dunning, dashboard, manual pause/resume.
**Parent doc:** [dunly-product-plan.md](./dunly-product-plan.md) §5.2, §5.4, §7.2, §10 (Phase 1, Weeks 3–4)
**Builds on:** [phase-0-foundation.md](./phase-0-foundation.md) (✅ complete)

## Locked decisions

1. **Reactivation email (Stage 5) is IN.** One-shot "your subscription ended — reactivate"
   email on `LOST_INVOLUNTARY` close only. Never sent to voluntary cancels; never a drip.
   Modeled as `EmailSend.kind = REACTIVATION` with reserved `stageOrder = 100`.
2. **Reopen-as-resume.** When a `RECOVERED` invoice fails again and the case reopens to
   `ACTIVE`, the sequence resumes: only stages that have never been sent for that case are
   scheduled. The `@@unique([dunningCaseId, stageOrder])` constraint stays authoritative —
   history is never deleted.
3. **Per-stage controls (send window, skip-if-amount-below, enable/disable) ship as schema
   fields now; enforcement lands with the settings UI in Phase 2.** Only `isEnabled` is
   honored in Phase 1 (trivial and needed for safe defaults).
4. **Sending identity:** dev runs on Resend's sandbox (`onboarding@resend.dev` → account
   owner's inbox only). Launch uses the shared domain `billing@mail.dunly.com` with the
   merchant's name as friendly-from and `WorkspaceSettings.replyTo` as reply-to. Custom
   domains are Phase 2 (paid tier). Only `EMAIL_FROM` changes between these — code is
   identical.

## Core design: schedule-ahead + guard-at-send

- **Case opens** (`invoice.payment_failed`) → enqueue `dunning.sequence` `{ dunningCaseId }`.
  The sequence worker pins the workspace's active campaign on the case (`campaignId`
  snapshot), then for each enabled step with no existing `EmailSend` row: create
  `EmailSend` (`SCHEDULED`) + a delayed `dunning.send-email` `{ emailSendId }` job,
  `startAfter = failedAt + delayHours`, `singletonKey = emailSendId`.
- **Stop condition fires** → handler flips that case's `SCHEDULED` sends to `CANCELED`.
  This is *advisory* (fast, dashboard-visible).
- **Send time is the authority.** The send worker re-checks everything before touching
  Resend: `EmailSend` still `SCHEDULED` → case still `ACTIVE` → connection still
  `CONNECTED` → customer has an email → email not on the workspace suppression list.
  Any guard fails → `CANCELED`, nothing sent. A missed cancellation can never cause a
  wrong email.
- **Idempotency layers (sending):** `@@unique([dunningCaseId, stageOrder])` (DB) +
  pg-boss `singletonKey = emailSendId` (queue) + status guard `SCHEDULED → SENT` (handler)
  + Resend `Idempotency-Key = emailSendId` (provider).

## Stop conditions

| Trigger | Case effect | Sends |
|---|---|---|
| `invoice.paid` | `RECOVERED` (existing) | pending → `CANCELED` |
| `customer.subscription.deleted` | `LOST_VOLUNTARY` / `LOST_INVOLUNTARY` (existing) | pending → `CANCELED`; involuntary additionally schedules the one-shot reactivation email |
| `customer.subscription.updated` → `incomplete_expired` | **new handler** — close `LOST_INVOLUNTARY` (Phase 0 known gap; no `cancellation_details`, classified involuntary because failed-payment-born) | pending → `CANCELED` (no reactivation — they never had a working subscription) |
| `charge.dispute.created` | `PAUSED` (existing) | pending → `CANCELED` (manual resume = Phase 3 dashboard) |
| Unsubscribe click | `SUPPRESSED` + `SuppressionEntry` (workspace-scoped — blocks future cases for that email too) | pending → `CANCELED` |
| Hard bounce (Resend webhook) | `EmailSend` → `BOUNCED` + auto-`SuppressionEntry` | pending → `CANCELED` |

## Default 4-touch campaign (auto-seeded per workspace)

| Stage | Delay | Tone | templateKey |
|---|---|---|---|
| 1 | 0h (Day 0) | friendly heads-up | `payment-failed-1` |
| 2 | 72h (Day 3) | short nudge | `payment-failed-2` |
| 3 | 168h (Day 7) | urgency, interruption risk | `payment-failed-3` |
| 4 | 288h (Day 12) | final notice | `payment-failed-4` |
| — | on involuntary close | one-shot reactivation | `reactivation` |

Seeded in the signup hook (new workspaces) and lazily by the sequence worker
(`ensureDefaultCampaign` — self-heals existing workspaces).

## Email layer

- **React Email** templates in `src/emails/` (5 total). Merge data: customer name,
  amount due (formatted from minor units + currency), plan name, company name, brand
  color/logo (`WorkspaceSettings`), days until cancellation copy where applicable.
- **Primary CTA:** `hostedInvoiceUrl` (pay / fix card — zero PCI scope).
- **Non-removable footer:**
  - Unsubscribe — `GET /r/unsubscribe/:token` (public, HMAC-signed case token, no login).
  - "Manage or cancel your subscription" — `GET /r/portal/:token` creates a *fresh* Stripe
    Billing Portal session on click and 302s (portal session URLs expire; never embed one
    in an email).
- **Headers:** `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  (RFC 8058 — Gmail/Yahoo bulk-sender requirement).
- **Resend send:** from `EMAIL_FROM`, friendly-from = workspace name, reply-to =
  `WorkspaceSettings.replyTo`, `Idempotency-Key = emailSendId`.
- **Resend event webhooks:** `POST /webhooks/resend` (Svix-signature verified) ingests
  `email.delivered|opened|clicked|bounced` → `EmailSend` status/timestamps; hard bounce
  auto-suppresses. Tested with synthetic signed events (no Resend CLI tunnel exists).

## Schema changes (one migration)

- **`SuppressionEntry`**: `organizationId` (FK), `email`, `reason: UNSUBSCRIBED | BOUNCED | MANUAL`,
  `@@unique([organizationId, email])`.
- **`DunningCase.campaignId?`** — campaign pinned at case open (snapshot semantics).
- **`EmailSend`** gains `kind: SEQUENCE | REACTIVATION`, `toEmail`, `subject`, `error`.
- **`DunningStep`** gains `isEnabled` (honored), `sendWindowStart?`, `sendWindowEnd?`,
  `skipIfAmountBelow?` (schema-only until Phase 2).

## Dev-loop notes

- Resend sandbox delivers **only to the account owner's inbox** — dev test customers are
  created with that real email (`scripts/create-failing-subscription.ts` takes the email
  as an argument already).
- `delivered@resend.dev` / `bounced@resend.dev` simulate outcomes + webhook events
  deterministically (used for the bounce exit criterion).
- Acceptance runs use a compressed campaign (minute-scale delays), seeded by script.
- Go-live instruction (deferred from Phase 0, decision #3): merchants disable Stripe's
  built-in failure emails when their Dunly sequence goes live — documented, not enforced.

## Build order

1. Schema migration + default-campaign seeding (signup hook + `ensureDefaultCampaign`)
2. Email layer: React Email templates, render helper, Resend wiring, test-send script
3. Sequence engine: `dunning.sequence` worker + hook into `invoice.payment_failed`
4. Send worker (full guard chain) + unsubscribe/portal redirect routes + suppression
5. Stop conditions: cancellations in handlers, `incomplete_expired` handler, reactivation
   send, Resend event webhooks
6. Dev-loop docs + acceptance checklist run

## Exit criteria (acceptance tests)

1. Failing invoice → stage-1 email lands in a real inbox; footer unsubscribe + portal
   links work.
2. Stages 2–4 exist as `SCHEDULED` `EmailSend` rows + delayed pg-boss jobs at the right
   times.
3. `invoice.paid` before stage 2 → case `RECOVERED`, pending sends `CANCELED`, inbox
   stays quiet.
4. Webhook replay → zero duplicate emails (constraint + singletonKey + idempotency key).
5. Unsubscribe click → case `SUPPRESSED` + `SuppressionEntry`; a *new* failure for the
   same customer sends nothing.
6. Dispute → `PAUSED`, pending sends `CANCELED`.
7. Cancelling an `incomplete` subscription → case closes `LOST_INVOLUNTARY` (Phase 0
   TODO verified dead).
8. Resend events update `EmailSend` (delivered/opened/clicked); `bounced@resend.dev` →
   `BOUNCED` + auto-suppression.
9. Involuntary `subscription.deleted` → exactly one reactivation email; voluntary →
   none; replay → still one (`stageOrder = 100` constraint).

## Implementation notes (discovered during the build)

1. **pg-boss 12 `standard` queue policy silently IGNORES `singletonKey`** — the dedupe
   layer Phase 0 believed it had on `events.process` never existed (DB constraint +
   status guards were covering). All queues now use the `short` policy (≤1 queued job
   per key) via `ensureQueue`, which self-migrates by delete+recreate — policy can't be
   updated in place (`UpdateQueueOptions` has no `policy`).
2. **Resume anchoring:** on reopen (re-failure after `RECOVERED`), `failedAt` re-anchors
   to the new failure event and remaining stages shift so the first owed stage sends
   immediately with original spacing preserved (`delayHours − min(owed delays)`).
3. **Send-before-mark ordering:** the send worker calls Resend BEFORE flipping the row to
   `SENT`; a crash in between retries into the provider's `Idempotency-Key` dedupe
   instead of losing the email. (Resend idempotency window: 24h.)
4. **Resend sandbox** only delivers to the account owner's address — dev test customers
   are created with that email; `delivered@/bounced@resend.dev` simulate outcomes.
   Resend has no CLI tunnel, so `/webhooks/resend` is tested with synthetic Svix-signed
   events (`scripts/send-synthetic-resend-event.ts`; verification hand-rolled, no SDK).
5. **Reactivation CTA points at the portal**, not `hostedInvoiceUrl` — the invoice may be
   void/uncollectible after cancellation.
6. **Dispute hardening beyond spec:** `charge.dispute.created` cancels pending sends for
   ALL the customer's cases (any status), so a scheduled reactivation can't slip out to
   a disputing customer.
7. **`tsx watch` hangs silently on this Z: network drive** — dev server runs as plain
   `npx tsx src/index.ts` (restart manually after changes).
8. **Verification evidence (2026-06-11):** full compressed 4-stage run delivered in
   order; byte-level replay → 1 event row / 4 sends / no fifth email; real
   `invoice.paid` → `RECOVERED` + "invoice paid" cancellations; synthetic involuntary
   delete → reactivation sent; real `incomplete_expired` → `LOST_INVOLUNTARY` (Phase 0
   gap closed); unsubscribe click → `SUPPRESSED` + entry; suppressed email's next case
   auto-canceled all 4 stages; opened/bounced ladder + bounce auto-suppression; dispute
   → `PAUSED` + "dispute opened" cancellations; forged HMAC/Svix tokens → 404/400.
