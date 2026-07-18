# Phase 4 — Pre-Dunning (Card-Expiry Prevention) — Locked Spec

**Status: ✅ COMPLETE — all 10 exit criteria verified 2026-06-11** (see implementation
notes at bottom)
Chosen for the Phase 4 slot over reply intelligence (now slotted Phase 5 — see
[phase-4-candidate-reply-intelligence.md](./phase-4-candidate-reply-intelligence.md)):
pre-dunning is locked MVP scope (product plan decision #3) and fully testable locally,
while reply intelligence needs a public webhook URL we won't have until launch hardening.

**Scope:** expiring-card scanner · 2-touch prevention sequence (−21d / −7d before
expiry) · auto-resolution when the card is updated · no-overlap with active dunning ·
"prevented" dashboard callout · pre-dunning section on the Sequence page.
**Out of scope:** editing pre-dunning email bodies (deferred with reactivation editing),
intent/AI anything, reply intelligence, weekly digest, A/B testing.
**Parent doc:** [dunly-product-plan.md](./dunly-product-plan.md) §5.3, §10 (Phase 4, Week 9)
**Builds on:** phase-0 ✅ · phase-1 ✅ · phase-2 ✅ · phase-3 ✅
**Design reference:** `dunly-design/project/Sequence.jsx` (pre-dunning section),
`Dashboard.jsx` (`PreDunningCallout`), `data.js` (PREDUNNING steps) — intent only.

## The one structural fact that shapes everything

Our `Customer` / `Subscription` tables are populated **lazily, on first payment
failure**. Pre-dunning targets healthy customers who have *never* failed — they don't
exist in our database at all. So detection cannot be a DB query: **the scanner
enumerates active subscriptions from the Stripe API** (per connected account), expands
the default payment method, and checks card expiry. It upserts `Customer` /
`Subscription` mirrors as it goes (same upsert the failure handler already does).

## Locked decisions (proposed)

1. **Detection = daily scan + guard-at-send. No new webhook handlers in v1.** A daily
   pg-boss cron (`boss.schedule`, ~03:00 UTC) walks every CONNECTED account:
   `subscriptions.list({ status })` for `active` + `trialing`, expand
   `default_payment_method` (fallback: the customer's
   `invoice_settings.default_payment_method`). A card whose expiry-month end is
   **≤ 35 days away** opens a `CardExpiryCase`. The same sweep re-verifies *open* cases:
   card replaced or expiry extended → `RESOLVED` (the win); expiry month over,
   unchanged → `LAPSED`. The send worker re-fetches the PM from Stripe immediately
   before each touch (the authority) — so resolution is never more than one send or one
   day stale, without subscribing to `payment_method.*` events. (Stripe's network
   card updater mostly fires `payment_method.automatically_updated`; an advisory
   fast-path handler is a cheap later add, not v1.)
2. **One case per human, not per subscription:**
   `@@unique([customerId, stripePaymentMethodId, expYear, expMonth])`. A customer with
   three subscriptions on one expiring card gets one case and one set of emails. The
   same customer attaching *another* expiring card later gets a new case (different PM
   or expiry → different key).
3. **Sends ride the existing `EmailSend` pipeline.** `EmailSendKind` gains
   `PRE_DUNNING`; `EmailSend.dunningCaseId` becomes optional and a nullable
   `cardExpiryCaseId` FK is added, with `@@unique([cardExpiryCaseId, stageOrder])`
   (reserved stage orders **201 / 202**, same convention as reactivation's 100).
   Everything downstream comes free: the Resend delivery-event ladder (lookup by
   `resendEmailId` is table-agnostic), Idempotency-Key = send id, the "short" queue
   policy, the clock-fast-forward test technique. The send worker branches on `kind`
   at the top — the dunning path is untouched.
4. **Touch schedule:** touch 1 at expiry − 21 days, touch 2 at expiry − 7 days
   ("expiry" = last moment of the expiry month, UTC), each clamped to **10:00 workspace
   time** that day (`lib/zoned-time.ts`). If the scan first sees a card with **< 14
   days** left, touch 1 is skipped with a visible `CANCELED` row ("opened too close to
   expiry") — never two near-identical emails 48h apart. No touch ever sends after the
   expiry month ends (guard).
5. **Pre-dunning never overlaps active dunning** (product plan §5.3). Scan skips
   customers with an open dunning case (`ACTIVE | PAUSED | SUPPRESSED`); the send guard
   re-checks and cancels ("customer has an open dunning case"). The reverse needs no
   rule: a payment failure during pre-dunning opens its dunning case normally, and the
   *next* pre-dunning touch cancels itself at send time.
6. **Send-time guard chain (the authority):** case `OPEN` → connection `CONNECTED` →
   touch still enabled → no open dunning case → email not suppressed (same
   `SuppressionEntry` list; unsubscribe in a pre-dunning email suppresses dunning too,
   one list per workspace) → **live Stripe re-check**: subscription still
   active/trialing AND the default PM is still this card with this expiry — otherwise
   resolve `RESOLVED` and cancel. Suppression cancels pending sends but leaves the
   case `OPEN`: a customer we can't email can still update their card, and the metric
   should record it honestly (same doctrine as dunning suppression).
7. **Templates are built-in constants in v1, like reactivation:** `card-expiry-1`
   (friendly, −21d) and `card-expiry-2` (urgent, −7d) React Email templates inside the
   locked layout (footer stays). New merge vars: `card_brand`, `card_last4`,
   `card_expiry` ("June 2026" — workspace-language not attempted, en-US like
   everything else). **Framing rule from the product plan is locked into the copy:**
   service-continuity language ("keep your access running"), never charge-reminder
   language ("you will be billed"). CTA = Stripe billing-portal link via a new
   expiry-scoped token purpose (`lib/tokens.ts` gains `expiry-portal` /
   `expiry-unsubscribe`; subjects are `cardExpiryCase.id`; new public routes
   `/r/expiry/portal/:token`, `/r/expiry/unsubscribe/:token`). Body editing is
   deferred (same boat as reactivation editing).
8. **Per-touch enable toggles on `WorkspaceSettings`** (`expiryTouch1Enabled`,
   `expiryTouch2Enabled`, both **default ON** — pre-dunning is a product pillar, not
   an easter egg), surfaced on the Sequence page per the prototype. Both off = feature
   off (scan still watches and resolves — it just never emails — so the metric keeps
   working). Disabling after scheduling cancels at send via the guard.
   *Go-live note:* when real merchants exist, flipping this on for already-connected
   workspaces deserves an announcement, since it emails customers who never failed.
9. **Case lifecycle:** `OPEN → RESOLVED | LAPSED | CANCELED`. `RESOLVED` = card
   updated before the month ended (counted as "prevented"). `LAPSED` = month ended,
   card unchanged — no loss is booked here; if the charge then fails, normal dunning
   owns the failure (no double-counting between prevented and recovered). `CANCELED` =
   case no longer applicable (subscription canceled/ended, customer deleted).
   `protectedAmount` (minor units) + `currency` snapshot at open = sum of that
   customer's matched subscription amounts — powers the prototype's "prevented"
   callout (`$ saved` = Σ protectedAmount over cases resolved this month).
10. **UI is two surfaces, no new page:** (a) Sequence page gains the prototype's
    "Pre-dunning" section — two timeline rows (−21d / −7d circles, slate accent, not
    brand), per-touch toggles, plus a compact "currently watching" table (customer,
    card brand/last4, expires, touches sent, status) so merchants can always see who
    Dunly is about to email; (b) Dashboard gains the dark `PreDunningCallout` (cards
    updated + amount protected this month, "Manage pre-dunning" → Sequence). Expiry
    cases do **not** appear in `/app/cases` — that table is failed invoices; mixing
    entities muddies both.

## What already exists (Phase 4 reuses)

| Piece | Status |
|---|---|
| `EmailSend` pipeline: short-policy queue, guard-at-send worker, Resend ladder, Idempotency-Key | ✅ Phase 1 |
| Suppression list + unsubscribe redirect machinery | ✅ Phase 1 |
| HMAC purpose-scoped tokens (`lib/tokens.ts`) — extend with two purposes | ✅ Phase 1 |
| `lib/zoned-time.ts` (`startOfDayInZone`) for the 10:00-workspace-time clamp | ✅ Phase 3 |
| Locked email layout/footer, brand settings, merge-var renderer | ✅ Phase 1–2 |
| Customer/Subscription upsert helpers (failure handler) | ✅ Phase 0 |
| pg-boss cron (`boss.schedule`) | ✅ available, first use |

## New data model

```prisma
model CardExpiryCase {
  id                    String           @id @default(cuid())
  connectionId          String
  connection            StripeConnection @relation(...)
  customerId            String
  customer              Customer         @relation(...)
  stripePaymentMethodId String
  cardBrand             String?
  cardLast4             String?
  expMonth              Int
  expYear               Int
  status                CardExpiryStatus @default(OPEN)   // OPEN | RESOLVED | LAPSED | CANCELED
  protectedAmount       Int              // minor units, snapshot at open
  currency              String
  openedAt              DateTime         @default(now())
  resolvedAt            DateTime?
  closedAt              DateTime?

  emailSends EmailSend[]

  @@unique([customerId, stripePaymentMethodId, expYear, expMonth])
  @@index([connectionId, status])
}
```

Plus: `EmailSend.dunningCaseId String?` (now optional) + `cardExpiryCaseId String?` +
`@@unique([cardExpiryCaseId, stageOrder])`; `EmailSendKind` + `PRE_DUNNING`;
`WorkspaceSettings` + the two toggle booleans. New queue `expiry.scan` (short policy).

## New API surface (session + `requireWorkspace`)

| Route | What |
|---|---|
| `GET /api/expiring-cards` | watching list: open cases + recent resolutions (customer, card, expiry, touches sent/pending, status) |
| `GET /api/metrics` *(extended)* | adds `prevented: { cards, amount }` for the month + `watching` count — one payload, no second fetch |
| `PATCH /api/workspace` *(extended)* | accepts the two toggle booleans |

## Build steps (each ends with shown output, per the usual rhythm)

1. **Schema + plumbing:** migration (model, EmailSend widening, toggles), constants
   (stage orders 201/202, subjects, template keys), token purposes + `/r/expiry/*`
   routes, `expiry.scan` queue. Output: migration SQL + typecheck.
2. **Scanner + sweep worker:** the daily cron job (open ≤35d cases, dedupe per
   decision #2, resolve/lapse open ones, schedule touch rows + delayed jobs at
   10:00-workspace-time) + scripts `create-expiring-card-customer.ts` (Stripe test
   token with a near-expiry date → customer + subscription) and `run-expiry-scan.ts`.
   Output: scan log + SQL of the opened case + its two scheduled sends.
3. **Templates + send path:** the two React Email templates (service-continuity copy,
   locked footer, new merge vars) + the `PRE_DUNNING` branch in the send worker with
   the full guard chain (decision #6). Output: rendered preview + a REAL touch-1 send
   through the production worker via clock fast-forward.
4. **Resolution + no-overlap proof:** attach a fresh card to the test customer → sweep
   resolves `RESOLVED`, pending touch cancels; second customer with an open dunning
   case → touch cancels at send. Output: worker logs + case SQL before/after.
5. **API + UI:** `/api/expiring-cards`, metrics extension, settings toggles; Sequence
   page pre-dunning section + watching table; Dashboard `PreDunningCallout`.
   Output: screenshots.
6. **Acceptance run** against the criteria below + docs/README updates.

## Acceptance criteria

1. Daily scan opens exactly one `CardExpiryCase` for a test customer whose card
   expires within 35 days, with touch rows at expiry−21d / expiry−7d clamped to 10:00
   workspace time; re-running the scan changes nothing (idempotent).
2. A customer with **two** subscriptions on the same expiring card gets **one** case;
   `protectedAmount` = sum of both subscription amounts.
3. Touch 1 sends through the real worker (clock fast-forward): service-continuity
   copy, correct `card_brand`/`card_last4`/`card_expiry` merge vars, locked footer,
   JetBrains-Mono-rendered values in the UI, and the portal link opens the connected
   account's billing portal.
4. Attaching a new card → sweep marks the case `RESOLVED`, cancels the pending touch,
   and the Dashboard callout's cards-count and protected amount move accordingly.
5. A case opened with < 14 days to expiry gets a `CANCELED` touch-1 row ("opened too
   close to expiry") and only touch 2 schedules.
6. A customer with an open dunning case is skipped by the scan, and an already
   scheduled touch cancels at send time with a visible reason.
7. The unsubscribe link in a pre-dunning email suppresses the address workspace-wide:
   pending pre-dunning AND dunning sends for that email cancel; the expiry case stays
   `OPEN` and can still resolve.
8. Disabling a touch on the Sequence page prevents it from sending (guard cancels);
   both touches off = nothing ever sends, scan keeps resolving.
9. Expiry month ends unchanged → case `LAPSED`; a subsequent `invoice.payment_failed`
   opens a normal dunning case, untouched by pre-dunning (no double-counting).
10. Workspace isolation: `/api/expiring-cards` only returns own-connection cases;
    `npm run typecheck` (backend) and `npm run build` (ui) pass.

## Implementation notes (verified 2026-06-11)

1. **`prisma migrate dev` refuses non-interactive shells.** Workaround used (and
   reusable): `prisma migrate diff --from-config-datasource --to-schema … --script`
   into a hand-named `prisma/migrations/<ts>_phase_4_pre_dunning/migration.sql`, then
   `prisma migrate deploy`. Properly recorded in `_prisma_migrations`.
2. **Stripe blocks raw card numbers by default, even in test mode** — you cannot mint
   a card with a custom expiry via `tokens.create`. Instead: attach `pm_card_visa`,
   then `paymentMethods.update(pm, { card: { exp_month, exp_year } })`. The same call
   is the network-card-updater simulation (same PM id, new expiry) used to prove
   resolution.
3. **The backend dev server runs plain `tsx` (NO watch)** — restart it manually after
   backend edits. Bit us once: a stale Prisma client threw
   `Value 'PRE_DUNNING' not found in enum` from the send worker until restart.
4. **One queue, two send paths:** PRE_DUNNING rows ride `dunning.send-email`; the
   worker branches on `send.kind` at the top into `deliverExpiryEmail` (jobs/expiry.ts),
   which ends its guard chain with a live-Stripe `checkExpiryCase` — shared verbatim
   with the daily sweep.
5. **Suppression ≠ resolution, proven:** an unsubscribed (suppressed) customer's
   expiry case stays OPEN and later resolved when their card was updated (AC7).
   The expiry unsubscribe is workspace-wide: it also canceled 3 pending *dunning*
   sends and flipped that dunning case ACTIVE → SUPPRESSED.
6. **AC5/AC9 can't occur naturally mid-month** (June cards were 20 days from death on
   test day), so they were proven by running the REAL functions against synthetic
   rows — AC5 with `Date.now` shifted +7 days (13 days left → touch 1 `CANCELED
   "opened too close to expiry"`), AC9 with a May 2026 case (→ `LAPSED "expiry month
   ended"`). Synthetic rows deleted after.
7. **Dev scripts added:** `create-expiring-card-customer` (`--extra-sub` for the
   one-case-per-human proof), `run-expiry-scan`, `update-card-expiry`,
   `add-failing-subscription`, `print-expiry-links`, `render-expiry-preview`.
8. **Acceptance evidence (key ids):** exp1 case `cmq9kpg3e0001h4wej01kp0p6`
   (touch 1 SENT, Resend `5d3bd162-…`, RESOLVED on in-place expiry update 6/2026→6/2028);
   exp2 `cmq9lmbpr0001xgweh3dtrbym` (touch 2 guard-canceled "customer has an open
   dunning case", later expiry-unsubscribe suppressed its dunning case);
   exp3 (open dunning case → scan refused to open: "2 expiring card(s), 0 new case(s)");
   exp4 `cmq9mlpsu0001a0wers1oqknk` (TWO subscriptions → one case, protectedAmount
   6800 = 4900+1900; portal link 302 → billing.stripe.com, forged token 404;
   touch 2 guard-canceled "touch disabled in workspace settings");
   exp5 `cmq9mofik00017cwe8ne2b5s6` (unsubscribe → suppression + touch CANCELED +
   case OPEN → RESOLVED while suppressed). AC10: second workspace saw
   `{"cards":[]}` and `prevented 0 / watching 0`.
