# Stripe Dunning MVP

Failed-payment recovery for Stripe subscriptions. Stripe **Smart Retries** handles retry scheduling; this service listens to webhooks and sends recovery emails via **Resend**.

## How it works

```
Stripe Smart Retries ──(webhook)──> Express server ──> Resend email
```

| Stripe event                    | What we send                                              |
| ------------------------------- | --------------------------------------------------------- |
| `invoice.payment_failed` (1st)  | Gentle heads-up + "update payment method" link            |
| `invoice.payment_failed` (2nd+) | Urgent reminder with next retry date                      |
| `invoice.payment_failed` (last) | Final notice (when `next_payment_attempt` is null)        |
| `invoice.paid`                  | "Payment recovered" email (only if the invoice was dunned)|
| `customer.subscription.deleted` | Cancellation email (only when cancelled for non-payment)  |

The "update payment method" link is Stripe's **hosted invoice page** (`invoice.hosted_invoice_url`) — customers can pay and update their card there with zero extra UI on your end.

## Setup

### 1. Install & configure

```bash
npm install
cp .env.example .env   # fill in your keys
```

### 2. Stripe Dashboard

1. **Enable Smart Retries**: Settings → Billing → **Revenue recovery** → Manage retries → Smart Retries (pick how many retries / over how long, e.g. 4 retries over 2 weeks).
2. In the same area, set the subscription status after retries are exhausted (e.g. **cancel** the subscription).
3. **Disable Stripe's own failed-payment emails** (Settings → Billing → Subscriptions and emails) so customers don't get duplicates.
4. **Create a webhook endpoint** (Developers → Webhooks) pointing to `https://yourdomain.com/webhooks/stripe`, subscribed to:
   - `invoice.payment_failed`
   - `invoice.paid`
   - `customer.subscription.deleted`
5. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

### 3. Resend

1. Verify your sending domain in Resend.
2. Put your API key in `RESEND_API_KEY` and a from-address on that domain in `EMAIL_FROM`.

### 4. Run

```bash
npm start        # or: npm run dev
```

## Local testing with Stripe CLI

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
# copy the whsec_... it prints into .env, then:

stripe trigger invoice.payment_failed
stripe trigger invoice.paid
```

To simulate a real failing subscription, create a test subscription with card `4000 0000 0000 0341` (attaches but fails to charge).

## MVP limitations (known, deliberate)

- **State** lives in a local JSON file (`dunning-state.json`) — for idempotency and "was this invoice dunned" tracking. Swap for Postgres/Redis before scaling past one instance.
- **Email failures after webhook ACK** are only logged. Production-grade: push events onto a queue (e.g. BullMQ) and retry there.
- **One-off invoices are ignored** — only subscription invoices get dunned.
- Templates are inline HTML; move to React Email or Resend templates when you want design polish.