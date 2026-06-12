# dunly-backend

Dunly API: Express 5 + TypeScript, Prisma 7 (PostgreSQL), pg-boss 12, Stripe Connect,
Better Auth, Resend + React Email.

**Specs:** [Phase 0 — Foundation](../docs/phase-0-foundation.md) ·
[Phase 1 — Dunning core](../docs/phase-1-dunning-core.md) ·
**Product plan:** [docs/dunly-product-plan.md](../docs/dunly-product-plan.md) ·
**Design system:** [DESIGN.md](../dunly-ui/DESIGN.md)

## Setup

```bash
cp .env.example .env          # then fill in the values below
npm install --include=dev     # --include=dev matters: this shell exports NODE_ENV=production
docker compose up -d          # Postgres 17 (db: dunly, user/pass: postgres)
npm run db:migrate
npm run dev                   # API on http://localhost:4000
```

> **NODE_ENV quirk:** this machine's shell exports `NODE_ENV=production`. It makes npm skip
> devDependencies AND makes dev tooling (Vite, react-email) behave like a prod build. Start
> dev servers with `$env:NODE_ENV='development'` set.

| Env var | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Dashboard → Developers → API keys (test mode; `rk_` restricted key preferred) |
| `STRIPE_CLIENT_ID` | Dashboard → Settings → Connect → Onboarding options → OAuth (test mode `ca_…`) |
| `STRIPE_WEBHOOK_SECRET` | printed by `stripe listen` (below) |
| `BETTER_AUTH_SECRET` | any random 32+ char string (also signs email footer link tokens) |
| `RESEND_API_KEY` / `EMAIL_FROM` | Resend dashboard. Dev uses a verified dev domain (`billing@mail.yt-karaoke.online`) so sends reach any address; without one, `onboarding@resend.dev` works but delivers ONLY to the Resend account owner's email |
| `RESEND_WEBHOOK_SECRET` | Resend dashboard → Webhooks (Svix `whsec_…`). Optional; `/webhooks/resend` returns 503 until set. Dev uses a random placeholder + synthetic signed events |

## Webhook dev loop (Stripe CLI)

```bash
stripe login                                              # one-time browser pairing
stripe listen --forward-to localhost:4000/webhooks/stripe # leave running; prints whsec_…
```

Put the printed `whsec_…` in `.env` as `STRIPE_WEBHOOK_SECRET` and (re)start the API.

```bash
# Realistic dunning case: subscription-backed invoice that fails (card 4000 0000 0000 0341)
npx tsx scripts/create-failing-subscription.ts acct_XXX you@example.com

# Watch it land:
curl localhost:4000/health      # webhooks.lastEventReceivedAt / eventCounts / queueDepth
```

In dev, use **your own email** for test customers — the Resend sandbox refuses all other
recipients. `delivered@resend.dev` / `bounced@resend.dev` simulate outcomes safely.

### Exercising the rest of the lifecycle

```bash
npx tsx scripts/pay-invoice.ts acct_XXX in_XXX            # → invoice.paid → case RECOVERED
npx tsx scripts/cancel-subscription.ts acct_XXX sub_XXX   # voluntary cancel; on an
                                                          #   `incomplete` sub this emits
                                                          #   subscription.updated → incomplete_expired
Get-Content my-event.json -Raw | npx tsx scripts/send-synthetic-event.ts [url] [whsec]
                                                          # signed synthetic Stripe events —
                                                          #   disputes, deauth, deleted-with-reason,
                                                          #   and byte-level replay testing
npx tsx scripts/send-synthetic-resend-event.ts email.opened <resendEmailId>
                                                          # Svix-signed Resend delivery events
```

To watch a full 4-touch sequence without waiting 12 days, zero the campaign delays and
create a failing subscription (restore after):

```sql
UPDATE "DunningStep" SET "delayHours" = 0;          -- compressed test
-- restore: 0 / 72 / 168 / 288 per "order" (or delete the campaign and re-seed)
```

## How it works

```
POST /webhooks/stripe ──▶ WebhookEvent (UNIQUE stripeEventId — replays absorbed)
        ▼ pg-boss events.process ("short" policy: 1 queued job per event)
processWebhookEvent ──▶ handlers (status-guarded, idempotent)
        │
        ├─ invoice.payment_failed ──▶ DunningCase ACTIVE ──▶ dunning.sequence
        │       sequence worker: pins campaign on the case, creates one SCHEDULED
        │       EmailSend per enabled step + a delayed dunning.send-email job
        │       (startAfter = failedAt + delayHours)
        ▼
dunning.send-email worker = guard-at-send AUTHORITY
        send SCHEDULED? case ACTIVE? connection CONNECTED? email present? not suppressed?
        ──▶ render React Email ──▶ Resend (Idempotency-Key = emailSendId) ──▶ SENT
        any guard fails ──▶ CANCELED + reason (never mails)

POST /webhooks/resend (Svix-verified) ──▶ EmailSend ladder SENT→DELIVERED→OPENED→CLICKED
        email.bounced ──▶ BOUNCED + auto-SuppressionEntry + case SUPPRESSED
```

**Sending idempotency layers:** `@@unique([dunningCaseId, stageOrder])` (DB) →
pg-boss `short` policy + singletonKey (queue) → status guard (handler) →
Resend Idempotency-Key (provider). The send happens BEFORE the row flips to SENT, so a
crash in between retries into provider-side dedupe instead of skipping the email.

### Stop conditions (all cancel pending sends instantly; the send guard backstops)

| Trigger | Case → |
|---|---|
| `invoice.paid` | `RECOVERED` (also from `PAUSED`/`SUPPRESSED` — Stripe retries keep running) |
| `customer.subscription.deleted` | `cancellation_details.reason` → `LOST_INVOLUNTARY` (+ one-shot reactivation email) / `LOST_VOLUNTARY` (never emailed again) |
| `customer.subscription.updated` → `incomplete_expired` | `LOST_INVOLUNTARY`, no reactivation |
| `charge.dispute.created` | `PAUSED` + every pending send for that customer killed |
| Unsubscribe click (`/r/unsubscribe/:token`) | `SUPPRESSED` + workspace-wide `SuppressionEntry` |
| Hard bounce (Resend webhook) | send `BOUNCED` + auto-suppression |

### Email footer links (locked, in every send)

`GET|POST /r/unsubscribe/:token` (RFC 8058 one-click) and `GET /r/portal/:token`
(mints a fresh Stripe Billing Portal session per click). Public routes; the
purpose-scoped HMAC case token is the only authentication.

## Scripts

| Command | What |
|---|---|
| `npm run dev` | tsx watch dev server (plain `npx tsx src/index.ts` is more reliable on this network drive) |
| `npm run db:migrate` / `db:studio` | Prisma migrate / data browser |
| `npm run email:dev` | React Email template preview on :3000 |
| `npm run typecheck` | `tsc --noEmit` |
| `scripts/create-failing-subscription.ts` | product+price+customer with the always-fail card |
| `scripts/pay-invoice.ts` | pay out-of-band → `invoice.paid` |
| `scripts/cancel-subscription.ts` | cancel (voluntary / `incomplete_expired` path) |
| `scripts/send-synthetic-event.ts` | signed Stripe event delivery + replay testing |
| `scripts/send-synthetic-resend-event.ts` | Svix-signed Resend delivery events |
| `scripts/send-test-email.ts` | render + really send any template with sample data |
| `scripts/ensure-default-campaigns.ts` | backfill the default 4-touch campaign |
| `scripts/process-one.ts` | re-run the processor on one stored event |
