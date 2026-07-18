# Phase 5 — Reply Intelligence (Stop-on-Reply) — Locked Spec

**Status: ✅ BUILT — backend acceptance criteria verified 2026-06-13** (see
implementation notes at bottom); final UI eyeball + AC1 inbox header check
pending merchant review.
Promoted from [phase-4-candidate-reply-intelligence.md](./phase-4-candidate-reply-intelligence.md)
(idea captured 2026-06-11). The candidate's deferral reason — Resend Inbound needs a
public HTTPS URL — blocks only the *live MX round-trip*, not the build: every piece is
locally verifiable with synthetic `email.received` webhooks, the same technique already
proven for delivery events (`scripts/send-synthetic-resend-event.ts`). The live
inbound wiring (MX record + Resend Inbound config) is a launch-hardening checklist
item, called out at the bottom.

**One-liner:** when a customer *replies* to a dunning email, automatically pause the
sequence, forward the reply to the merchant with one-tap Resume / Stop links, and
record it on the case timeline.

**Scope:** Reply-To rerouting on dunning sends · inbound `email.received` handling ·
auto-reply filtering · stop-on-reply pause · forward-with-actions email · one-tap
Resume/Stop public routes · timeline + settings toggle UI.
**Out of scope (v1):** intent/sentiment parsing, Slack notifications (v1.5), daily
digest, pre-dunning (card-expiry) reply routing — expiry emails keep the merchant's
own `replyTo`; there is no pause concept on an expiry case. Inbound *attachment*
handling: ignored (text only).
**Parent doc:** [dunly-product-plan.md](./dunly-product-plan.md) §5.7 (stop conditions)
**Builds on:** phase-1 ✅ (EmailSend pipeline, suppression, tokens) ·
phase-3 ✅ (PAUSED state, held sends, resume/stop endpoints, timeline)

## Locked decisions

1. **Reply routing = `Reply-To: reply+<caseId>.<sig>@<INBOUND_REPLY_DOMAIN>`** on
   SEQUENCE and REACTIVATION sends, applied in the send worker (the authority) when
   the workspace toggle is on AND the env var is set. SMTP local parts cap at 64
   chars, so this is a *compact* codec, not `makeCaseToken`: raw cuid (cuids are
   email-safe) + `.` + HMAC-SHA256 truncated to 128 bits (22 base64url chars), keyed
   like the case tokens but under its own purpose string (`reply-address`). Truncated
   HMAC at 128 bits is cryptographically sound; the namespaces stay mutually
   unforgeable. Toggle off or env unset → `Reply-To` falls back to the merchant's
   `settings.replyTo` (today's behavior, byte-identical).
2. **Inbound rides the existing `/webhooks/resend` endpoint** — `email.received` is
   just a new event type on the same Svix-verified plumbing. Handling is inline
   (DB writes + one pg-boss enqueue, no external calls in the request path), matching
   the delivery-event doctrine. The reply address is parsed out of `data.to`; a
   missing/forged/foreign-domain address → `ignored`, 200 (Resend must not retry junk).
3. **Auto-reply filter (the #1 false-positive trap), header-based:** a reply is AUTO —
   stored but never pauses, never forwards — when any of: `Auto-Submitted` present and
   ≠ `no` · `Precedence: auto_reply | bulk | junk` · `X-Autoreply` / `X-Autorespond`
   present · From matches `mailer-daemon@ | postmaster@`. Everything else is HUMAN.
   AUTO rows keep the tripped header in `autoReason` and appear muted on the timeline
   (visibility beats silence). No content heuristics in v1.
4. **Every reply is persisted as a `CaseReply` row** — `resendInboundId @unique` is the
   replay shield (same doctrine as `WebhookEvent.stripeEventId`): a redelivered
   `email.received` hits P2002 and is absorbed. Body storage is plain text only,
   capped at 10 000 chars; HTML is dropped (the forward quotes text — no risk of
   replaying hostile customer HTML into the merchant's inbox).
5. **On a HUMAN reply:** (a) guarded pause — `updateMany WHERE status='ACTIVE' →
   PAUSED`; pending sends are *held*, not canceled, exactly per phase-3 decision #2,
   so Resume re-enqueues them. A reply to an already-paused or closed case pauses
   nothing but still forwards — the merchant must see it regardless. `pausedCase` on
   the reply row records which happened, and the timeline says so. (b) the forward
   (decision #6) is scheduled. No intent parsing: any human reply pauses; the merchant
   decides.
6. **The forward IS the notification, and it rides the `EmailSend` pipeline** for
   delivery guarantees the candidate demanded: pg-boss retry/backoff, status guard,
   Resend Idempotency-Key = send id, delivery-event ladder — all free. New
   `EmailSendKind: REPLY_FORWARD`, reserved `stageOrder` **300**, parent =
   `caseReplyId @unique` (exactly one forward per reply, ever) with
   `dunningCaseId` left **null** — the `(dunningCaseId, stageOrder)` unique can't
   collide across multiple replies to one case. Parent doctrine extends to:
   SEQUENCE/REACTIVATION → `dunningCaseId`, PRE_DUNNING → `cardExpiryCaseId`,
   REPLY_FORWARD → `caseReplyId`. On Resend failure the row stays SCHEDULED with the
   error recorded and pg-boss retries (5 attempts, backoff) — a dropped forward is
   worse than not having the feature.
7. **Forward recipient & framing:** to the merchant's notification address =
   `settings.replyTo` ?? the workspace owner's login email (resolved at send time).
   Content: Dunly-framed header ("**{customer} replied to {stage label}** — sequence
   paused"), the reply quoted below (text, escaped), then one-tap **Resume sequence**
   / **Stop & mark lost** buttons. The forward's own `Reply-To` is the *customer's*
   address, so the merchant just hits reply to answer them. This is a merchant
   notification, not a customer email: design tokens apply, but the locked
   unsubscribe footer does **not** (merchants can't unsubscribe from their own
   product's operational mail).
8. **Forward guard chain (send worker, REPLY_FORWARD branch):** reply still exists →
   resolvable recipient → send. Deliberately *thin*: no case-status guard (a closed
   case's reply still matters), no suppression check (the suppression list is for
   customer addresses, not merchants). **And the bounce handler gains a kind guard:**
   a bounced forward must never auto-suppress the merchant's address into the
   workspace suppression list or cancel case sends — log and stop.
9. **One-tap actions = two new token purposes** (`case-resume`, `case-stop`) and two
   public HMAC routes mirroring the session API endpoints' guarded transitions:
   `GET /r/case/resume/:token` — PAUSED → ACTIVE + one idempotent sequence kick
   (re-enqueues held rows); `GET /r/case/stop/:token` — ACTIVE/PAUSED →
   LOST_INVOLUNTARY + pending sends CANCELED ("stopped from reply forward"). Both
   render the branded outcome page; a second click or a stale state shows
   "already done / case is X" honestly. Forged tokens 404. GET-with-confirm is not
   needed: both actions are merchant-only, low-blast-radius, and reversible
   (resume↔pause; stop matches the existing irreversible API stop).
10. **Toggle:** `WorkspaceSettings.stopOnReplyEnabled Boolean @default(true)` — on by
    default like pre-dunning (it's a dispute-prevention pillar). Surfaced in Settings
    ("Stop on reply" card). The send worker is the authority: flipping it off changes
    `Reply-To` on *future* sends only; already-rerouted replies still land and still
    pause (an in-flight reply address must never dead-end).
11. **Timeline:** case detail derives reply events from `CaseReply` rows (the phase-3
    no-event-table doctrine holds — replies are rows we already need). HUMAN →
    "Customer replied — sequence paused" (or "— case was {status}") with a 140-char
    snippet as detail; AUTO → "Auto-reply filtered" muted row. New timeline event
    types `replied` / `auto-reply` in the UI (amber ring for `replied` — it pauses;
    gray for `auto-reply`).
12. **Receiving domain is env-level, not workspace-level:**
    `INBOUND_REPLY_DOMAIN` (optional in `env.ts` — feature inert when unset, like
    `RESEND_WEBHOOK_SECRET`). Dev value: `reply.yt-karaoke.online`; same
    one-env-var swap at launch as sending.

## What already exists (Phase 5 reuses)

| Piece | Status |
|---|---|
| Svix-verified `/webhooks/resend` endpoint | ✅ Phase 1 |
| PAUSED status + held-not-canceled sends + resume re-enqueue | ✅ Phase 3 |
| Guarded transitions (`updateMany WHERE status=…`) everywhere | ✅ Phase 1–3 |
| `EmailSend` pipeline: short-policy queue, guard-at-send, Idempotency-Key, ladder | ✅ Phase 1 |
| HMAC token signing pattern (`lib/tokens.ts`) + branded `/r/*` outcome pages | ✅ Phase 1 |
| Synthetic Svix webhook script to model on (`send-synthetic-resend-event.ts`) | ✅ Phase 1 |
| Case timeline derivation (`routes/cases.ts`) | ✅ Phase 3 |

## New data model

```prisma
model CaseReply {
  id              String              @id @default(cuid())
  dunningCaseId   String
  dunningCase     DunningCase         @relation(fields: [dunningCaseId], references: [id], onDelete: Cascade)
  /// Resend inbound email id — UNIQUE absorbs webhook redelivery (decision #4).
  resendInboundId String              @unique
  fromEmail       String?
  subject         String?
  /// Plain text only, capped at 10k chars (decision #4).
  textBody        String?
  classification  ReplyClassification // HUMAN | AUTO
  /// Which auto-reply header tripped (AUTO only).
  autoReason      String?
  /// Did THIS reply flip the case ACTIVE → PAUSED?
  pausedCase      Boolean             @default(false)
  receivedAt      DateTime            @default(now())

  forwardSend EmailSend?

  @@index([dunningCaseId, receivedAt])
}

enum ReplyClassification { HUMAN AUTO }
```

Plus: `EmailSend.caseReplyId String? @unique` + relation; `EmailSendKind` +
`REPLY_FORWARD` (stageOrder 300); `WorkspaceSettings.stopOnReplyEnabled Boolean
@default(true)`; `env.INBOUND_REPLY_DOMAIN` (optional).

## New/changed API surface

| Route | What |
|---|---|
| `POST /webhooks/resend` *(extended)* | handles `email.received`: parse reply address → classify → persist → pause → enqueue forward |
| `GET /r/case/resume/:token` · `GET /r/case/stop/:token` | public one-tap actions (HMAC, purposes `case-resume` / `case-stop`) |
| `GET /api/cases/:id` *(extended)* | timeline gains `replied` / `auto-reply` events; payload gains `replies` summary |
| `PATCH /api/workspace` *(extended)* | accepts `stopOnReplyEnabled` |

## Build steps (each ends with shown output, per the usual rhythm)

1. **Schema + plumbing:** migration (CaseReply, EmailSend.caseReplyId +
   REPLY_FORWARD, settings toggle), `INBOUND_REPLY_DOMAIN` in env, reply-address
   codec (`lib/replies.ts`: `makeReplyAddress` / `parseReplyAddress`, ≤64-char local
   part), token purposes. Output: migration SQL + typecheck.
2. **Reply-To rerouting:** send worker sets the reply address on SEQUENCE /
   REACTIVATION sends when enabled; settings PATCH accepts the toggle. Output: a
   real send showing the rerouted `Reply-To`, then toggle off → merchant replyTo.
3. **Inbound handling:** `email.received` branch in the webhook route +
   `handleInboundEmail` (parse → auto-filter → persist → guarded pause) +
   `scripts/send-synthetic-inbound.ts` (Svix-signed, `--case` / `--auto` /
   `--from` / `--text` flags). Output: synthetic human reply → case PAUSED +
   CaseReply row; synthetic OOO → AUTO row, case untouched.
4. **Forward-with-actions:** `reply-forward` React Email template, REPLY_FORWARD
   branch in the send worker (thin guards, decision #8), bounce-handler kind guard,
   `/r/case/resume|stop` routes. Output: forwarded email in the inbox with working
   one-tap links; resume round-trip re-enqueues held sends.
5. **API + UI:** timeline events + replies in case detail; Settings "Stop on reply"
   card; timeline rendering for the two new event types. Output: case detail
   screenshot-equivalent (eyeballed via dev servers).
6. **Acceptance run** against the criteria below + docs/README/CLAUDE.md updates.

## Acceptance criteria

1. With the toggle on and `INBOUND_REPLY_DOMAIN` set, a dunning send carries
   `Reply-To: reply+<caseId>.<sig>@<domain>` (local part ≤ 64 chars); with the
   toggle off (or env unset) it carries the merchant's `replyTo` exactly as before.
2. A synthetic human `email.received` for an ACTIVE case flips it to PAUSED with
   pending sends **held** (not canceled), writes a HUMAN `CaseReply`
   (`pausedCase: true`), and the timeline shows "Customer replied — sequence paused"
   with the snippet.
3. Auto-replies are filtered by headers (`Auto-Submitted: auto-replied`,
   `Precedence: bulk`, `X-Autoreply`) → AUTO row with `autoReason`, case stays
   ACTIVE, no forward is created.
4. The forward lands at the merchant notification address (`settings.replyTo`,
   falling back to the owner's email): customer + stage framing, quoted reply text,
   Resume and Stop links; its `Reply-To` is the customer's address.
5. The Resume link transitions PAUSED → ACTIVE and the held sends re-enqueue (next
   send fires); the Stop link transitions to LOST_INVOLUNTARY and cancels pending
   sends. Both are guarded: forged tokens 404, a second click reports the already-
   final state instead of double-acting.
6. Redelivering the same `email.received` (same inbound id) creates **no** second
   CaseReply and **no** second forward (unique absorbs; one forward per reply, ever).
7. A reply whose address is malformed, forged (bad sig), or for an unknown case id →
   `ignored`, 200, no rows. A reply to a closed (RECOVERED / LOST) case stores the
   reply, forwards it, and leaves the status untouched (`pausedCase: false`,
   timeline says "case was RECOVERED").
8. A bounced forward does **not** suppress the merchant address, does not cancel any
   case sends, and does not change case status (kind guard in the bounce handler).
9. A forward whose Resend call fails stays SCHEDULED with the error recorded and is
   retried by pg-boss (provable with a synthetic-failure recipient).
10. Replies are workspace-isolated end to end (case detail only ever shows own-case
    replies; foreign tokens 404); `npm run typecheck` (backend) and `npm run build`
    (ui) pass.

## Implementation notes (verified 2026-06-13)

1. **Layout:** codec + inbound handler in `lib/replies.ts`, forward delivery in
   `jobs/replies.ts` (mirrors the predunning.ts / jobs/expiry.ts split); template
   `emails/reply-forward.tsx`; routes in `redirects.ts`; scripts
   `send-synthetic-inbound.ts` (`--case/--to/--auto/--inbound-id/--from/--text`)
   and `print-reply-links.ts`.
2. **Reply address proven ≤ 64:** `reply+<cuid25>.<sig22>@…` = 54-char local part.
3. **Fast-forwarding a held send needs the worker called directly** — updating
   `scheduledFor` + re-kicking is rejected by singletonKey while the original
   delayed job still waits (the "short" policy doing its job). AC1's real send was
   driven through `deliverScheduledEmail` directly.
4. **Resend restricted API keys can't read emails back** (`GET /emails/:id` → 401
   "restricted to only send emails") — the rerouted Reply-To is verified in the
   received message's headers (Gmail "show original"), not via the API.
5. **Acceptance evidence (key ids):** demo case `cmq9lp6ye001tcswe7xxc26ad` —
   human reply `inbound_phase5_ac2` → PAUSED + forward SENT (Resend
   `a798e1b4-…`) to the owner fallback address; redelivery of the same id →
   `duplicate`, no second row/forward; `inbound_phase5_ac3` (Auto-Submitted:
   auto-replied) → AUTO row, no action; forged sig + unknown case → `ignored` /
   `unknown-case`, 200. Resume link: PAUSED → ACTIVE, 3 held sends re-enqueued,
   second click "Nothing to resume", forged token 404. Stop link (case
   `cmq9hw9fw0032xowenkbkl3tx`): → LOST_INVOLUNTARY, 3 sends CANCELED
   "stopped from reply forward", second click "Nothing to stop"; a later reply
   to that closed case → `forwarded`, status untouched, `pausedCase: false`.
   Synthetic `email.bounced` on the forward → row BOUNCED, **no** suppression
   of the merchant address, case untouched (AC8). AC9: `replyTo` set to an
   invalid address → forward stayed SCHEDULED with
   `validation_error` recorded; after restore, the same row delivered SENT.
   Real stage-2 send through the production worker succeeded with the rerouted
   replyTo payload (Resend `ee61c043-…`).

## Launch-hardening handoff (not part of this phase's exit)

- Create the Resend Inbound address/MX on `INBOUND_REPLY_DOMAIN` and point its
  webhook at `POST /webhooks/resend` (same endpoint, same secret).
- Verify the real `email.received` payload field names against the synthetic shape
  (`data.email_id / from / to / subject / text / headers`) — the parser is
  defensive, but confirm before flipping any production workspace's toggle on.
- Repeated forward failures should page someone (alerting is a deployment concern,
  with the rest of ops monitoring).
