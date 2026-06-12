# Phase 0 — Foundation (Locked Spec)

**Status: ✅ COMPLETE — all 8 exit criteria verified 2026-06-11** (see notes at bottom)

**Scope:** Stripe Connect OAuth · webhook ingestion · event store · idempotency · schema rework
**Out of scope:** any email sending (Phase 1), template editor, dashboard UI, pre-dunning.
**Parent doc:** [dunly-product-plan.md](./dunly-product-plan.md) §7.2, §10 (Phase 0, Weeks 1–2)

## Locked decisions

1. **Tenant model:** Better Auth **organization plugin** provides Workspace (= organization), members, and invitations. Workspace-specific settings (brand color, timezone, reply-to, logo) live in a companion `WorkspaceSettings` table keyed 1:1 to the organization — keeps auth-plugin tables unpolluted.
2. **Per-workspace webhook URL format:** `/webhooks/<workspaceId>/<connectionId>`. URL segments are routing hints only; **Stripe signature verification is the only authentication.**
3. **Phase 0 records state but sends nothing.** No customer-facing email of any kind until Phase 1. Merchants keep Stripe's built-in failure emails enabled during this window (the "disable Stripe emails" setup step moves to Phase 1 go-live).

## Exit criteria (acceptance tests)

1. Sign up → workspace auto-created → "Connect Stripe" OAuth round-trip against a Stripe **test** account creates a `StripeConnection`.
2. `stripe trigger invoice.payment_failed` → exactly one `WebhookEvent` row and one `DunningCase` (status `ACTIVE`, `hostedInvoiceUrl` captured).
3. `stripe events resend <evt_id>` (replay) → zero duplicates anywhere; endpoint still returns 200.
4. `invoice.paid` for that invoice → case flips to `RECOVERED`.
5. `customer.subscription.deleted` with involuntary `cancellation_details` → `LOST_INVOLUNTARY`; voluntary → `LOST_VOLUNTARY`.
6. `charge.dispute.created` → case `PAUSED`.
7. Deauthorizing the app from the Stripe dashboard → connection flips to `REVOKED` (via `account.application.deauthorized`).
8. Worker crash mid-processing → pg-boss retry re-runs the handler with no duplicate side effects (handlers are idempotent).

## 1. Schema rework

One fresh migration (`prisma migrate reset` — no production data exists).

### Auth / tenancy (Better Auth organization plugin)
- Plugin-managed tables: `organization`, `member` (role: `owner` | `member`), `invitation` — generated via Better Auth's Prisma schema generator.
- `WorkspaceSettings` (ours): `organizationId (unique, FK)`, `logoUrl?`, `brandColor?`, `replyTo?`, `timezone (default "UTC")`.
- Signup hook: auto-create organization + owner membership + default `WorkspaceSettings` after user creation.

### Stripe layer
- **`StripeConnection`** (replaces `StripeAccount`):
  - `id`, `organizationId (unique — one connection per workspace in MVP)`, `stripeAccountId (unique)`, `livemode`, `scope`, `status: CONNECTED | DISCONNECTED | REVOKED`, `webhookSecret?` (only for the direct per-workspace endpoint path), `businessName?`, `defaultCurrency?`, `connectedAt`, `disconnectedAt?`
- **`OAuthState`**: `id`, `token (unique)`, `organizationId`, `expiresAt`, `usedAt?` — single-use CSRF state for the Connect flow.
- `Customer`, `Subscription` re-parent to `StripeConnection` (unchanged otherwise).

### Event store
- **`WebhookEvent`**: `id`, `stripeEventId (UNIQUE — idempotency keystone)`, `type`, `stripeAccountId?`, `livemode`, `payload (Json)`, `status: RECEIVED | PROCESSING | PROCESSED | FAILED | SKIPPED`, `error?`, `receivedAt`, `processedAt?`
  - Index on `(type, receivedAt)` and `(status)`.

### Dunning domain
- **`DunningCase`** (replaces `FailedPayment`):
  - six-state machine: `status: ACTIVE | RECOVERED | LOST_INVOLUNTARY | LOST_VOLUNTARY | SUPPRESSED | PAUSED`
  - `stripeInvoiceId (unique)`, `hostedInvoiceUrl?` (primary recovery CTA per product plan §5.1), `amountDue`, `currency`, `attemptCount`, `failureCode?`, `failureMessage?`, `failedAt`, `recoveredAt?`, `closedAt?`
- **`EmailSend`** (replaces `RecoveryAttempt`):
  - `@@unique([dunningCaseId, stageOrder])` — Postgres-enforced "never send the same stage twice per invoice" (product plan §7.2). Table exists in Phase 0; rows only get written in Phase 1.
- `DunningCampaign` / `DunningStep` survive unchanged (consumed in Phase 1).

## 2. Stripe Connect OAuth

- Standard accounts, OAuth flow, **`read_write` scope** (needed for billing-portal sessions in Phase 1+).
- Platform setup (manual, one-time): register Connect platform in Stripe Dashboard, set redirect URI, copy `STRIPE_CLIENT_ID`.
- Routes:
  - `GET /api/stripe/connect` (authed, workspace-scoped) → create `OAuthState` row (15-min expiry) → 302 to `connect.stripe.com/oauth/authorize?client_id…&state…&redirect_uri…`
  - `GET /api/stripe/callback` → validate + consume state (single-use) → `stripe.oauth.token({ grant_type: "authorization_code", code })` → upsert `StripeConnection` (status `CONNECTED`) → fetch account details (`businessName`, `defaultCurrency`, `livemode`) → redirect to `{APP_URL}/settings/stripe?connected=1` (or `?error=…`).
  - `POST /api/stripe/disconnect` → `stripe.oauth.deauthorize()` → status `DISCONNECTED`.
- Revocation from Stripe's side handled by the `account.application.deauthorized` webhook → status `REVOKED`.
- New env (Zod-validated): `STRIPE_CLIENT_ID`, `CONNECT_REDIRECT_URL`.

## 3. Webhook ingestion

Two entry points, one processor:

| Path | Verified with | Notes |
|---|---|---|
| `POST /webhooks/stripe` | platform `STRIPE_WEBHOOK_SECRET` | Connect delivery; `event.account` identifies the merchant |
| `POST /webhooks/:workspaceId/:connectionId` | that connection's stored `webhookSecret` | Routing hint only; 404→200-silent on unknown IDs is NOT acceptable — unknown route IDs return 404 **before** signature check; signature failure returns 400 |

Shared `ingestEvent(rawBody, signature, secret, routingHint?)`:

```
verify signature (constructEvent)
→ INSERT WebhookEvent ON CONFLICT (stripeEventId) DO NOTHING
→ conflict?  respond 200 (replay absorbed)
→ inserted?  respond 200 immediately, then enqueue pg-boss `events:process`
             with { webhookEventId }, singletonKey = stripeEventId
```

Layered idempotency: DB unique constraint (layer 1) + pg-boss singletonKey (layer 2) + idempotent handlers (layer 3).

## 4. Event processing worker

pg-boss queue `events:process` (retryLimit 3, exponential backoff). Worker loads the `WebhookEvent`, sets `PROCESSING`, dispatches:

| Event type | Handler action (Phase 0 — state only, **no emails**) |
|---|---|
| `invoice.payment_failed` | Upsert `Customer` + `Subscription` mirrors; open or update `DunningCase` → `ACTIVE`; capture `hosted_invoice_url`, `attempt_count`, failure code/message |
| `invoice.paid` | If a case exists for the invoice → `RECOVERED` (+ `recoveredAt`) |
| `customer.subscription.deleted` | Read `cancellation_details.reason`: `payment_failed`/retries-exhausted → `LOST_INVOLUNTARY`; otherwise → `LOST_VOLUNTARY`; close open cases for that subscription |
| `charge.dispute.created` | All `ACTIVE` cases for that customer → `PAUSED` |
| `account.application.deauthorized` | `StripeConnection` → `REVOKED` |
| anything else | Mark `SKIPPED` (still stored for debugging) |

Handlers are pure `(event, tx)` functions, idempotent under re-delivery and pg-boss retry. Success → `PROCESSED` + `processedAt`; exhausted retries → `FAILED` + `error`.

## 5. Workspace plumbing (minimum viable)

- Better Auth: enable organization plugin + Google sign-in stays deferred (email/password only in Phase 0 is fine; Google is config-only later).
- `requireWorkspace` middleware → resolves session → active organization → attaches `{ user, organizationId }` to request; all `/api/*` routes behind it (except auth + webhooks).
- Read endpoints for the UI: `GET /api/workspace` (org + settings), `GET /api/stripe/connection` (status, businessName, livemode).

## 6. Dev loop & observability

- README: `stripe listen --forward-to localhost:4000/webhooks/stripe`, `stripe trigger …`, failing test card `4000 0000 0000 0341`.
- `/health` extended: DB ping, pg-boss queue depth, timestamp of last received `WebhookEvent` (webhook-liveness signal per product-plan risk "a silent webhook bug = silently lost recoveries").
- Structured one-line log per event: `evt_id type account status duration`.

## Build order

1. Schema rework + fresh migration + Better Auth org plugin wiring + signup hook
2. Workspace middleware + the two read endpoints
3. OAuth connect / callback / disconnect + `OAuthState`
4. Ingestion endpoints + event store + ACK-fast pattern
5. `events:process` worker + the five thin handlers
6. Stripe CLI dev-loop docs + run the acceptance checklist

## Explicitly deferred to Phase 1

Sequence engine, all email sending (incl. the old prototype's immediate-send behavior), Resend event webhooks, suppression/unsubscribe, templates, send windows, "disable Stripe's built-in emails" instruction, dashboard UI beyond connection status.

## Implementation notes (discovered during the build)

1. **pg-boss 12 queue names** reject `:` (alphanumerics + `_-./` only) → queues are `events.process`, `dunning.sequence`, `dunning.send-email`.
2. **Signup-flow sessions** are created before the workspace hook runs, so their `activeOrganizationId` is null. `requireWorkspace` falls back to a membership lookup (which also validates membership in the claimed active org).
3. **Worker batching:** `boss.work` defaults to `batchSize: 1` ≈ one job per polling tick; a single trigger's ~12-event cascade took ~40s to drain. Set to `batchSize: 10`; on batch error, all batch jobs retry — safe, because handlers no-op on already-processed events.
4. **`stripe events resend` does not redeliver through `stripe listen` sessions** — replay testing uses `scripts/send-synthetic-event.ts` (byte-level re-POST signed with the webhook secret).
5. **Phase 1 TODO — `incomplete_expired`:** cancelling an `incomplete` subscription emits `customer.subscription.updated` (status → `incomplete_expired`), NOT `customer.subscription.deleted`. Such cases currently stay `ACTIVE`; the Phase 1 stop-condition work must listen for that transition (it carries no `cancellation_details`, so classify via prior status: failed-payment-born `incomplete` → involuntary).
6. **OAuth `read_write` token responses** carry `livemode` + `scope`; account display name comes from `business_profile.name ?? settings.dashboard.display_name` (best-effort).
