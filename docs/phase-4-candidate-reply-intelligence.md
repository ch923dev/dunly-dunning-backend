# Phase 5 Candidate — Reply Intelligence (Inbound Email)

**Status: 💡 CANDIDATE — idea captured 2026-06-11, slotted for Phase 5 (decided 2026-06-11).**
Lost the Phase 4 slot to pre-dunning ([phase-4-pre-dunning.md](./phase-4-pre-dunning.md)):
pre-dunning is locked MVP scope and fully testable locally, while this feature's core
flow (Resend Inbound webhooks) needs a public HTTPS URL we won't have until launch
hardening — build it when the app is deployed and real inbound email can be verified
end to end.

**One-liner:** when a customer *replies* to a dunning email, automatically pause the
sequence, notify the merchant, and hand the conversation to a human.

## Why it's worth building

Dunning is the one email category where ignoring a reply is dangerous: a customer who
writes "I want a refund, stop charging me" and then receives "Final notice — your
subscription will be canceled" two days later becomes a **chargeback**. Stop-on-reply is
standard in cold-outreach tools but rare in dunning tools — and it directly extends
Dunly's existing dispute-prevention story (portal escape hatch, unsubscribe suppression).

Already covered today (do not rebuild): unsubscribe → suppression → instant cancel of
pending sends is live since Phase 1. Reply intelligence covers the *free-text* version
of the same intent.

## Design sketch

1. **Reply routing:** dunning emails set `Reply-To: reply+<caseToken>@<receiving domain>`
   — the HMAC purpose-scoped case tokens from `lib/tokens.ts` already exist for exactly
   this kind of link-back. (Today `Reply-To` is the merchant's own `replyTo` address;
   this feature reroutes replies through Dunly.)
2. **Inbound:** Resend Inbound (shipped late 2025) — MX record on the receiving
   subdomain; every received email arrives as an `email.received` webhook with parsed
   content. We already run a Svix-verified `/webhooks/resend` endpoint; this is a new
   event type on existing plumbing.
   Docs: https://resend.com/docs/dashboard/receiving/introduction ·
   https://resend.com/blog/inbound-emails
3. **Auto-reply filtering (the #1 false-positive trap):** drop messages with
   `Auto-Submitted: auto-replied/auto-generated`, `Precedence: auto_reply/bulk`,
   `X-Autoreply`/`X-Autorespond` headers — otherwise every out-of-office responder
   pauses a case.
4. **On a real human reply:** pause the case (reuse Phase 3 pause machinery — held
   sends, resume re-enqueues), write a "Customer replied — sequence paused" timeline
   event, **forward the reply to the merchant's real inbox**, and notify.
5. **No intent parsing in v1.** Any human reply pauses; the merchant reads it and
   decides. Sentiment/intent classification is a maybe-later on top.

## Notifications (decided shape, 2026-06-11 brainstorm)

Build a tiny `notify(workspace, event)` abstraction with pluggable channels — then:

| Channel | Priority | Notes |
|---|---|---|
| **Forward-with-actions email** | v1, primary | The forwarded reply IS the notification: short Dunly frame ("Jamie at Acme replied to stage 2 — sequence paused"), reply quoted below, **one-tap Resume / Stop links** (HMAC tokens, no login). |
| **Slack incoming-webhook URL** | v1.5, cheap | One URL field in workspace settings + one formatted `POST`. NOT a full Slack OAuth app (that's a later project, when customers ask). |
| **Daily digest cron** | complement, never primary | pg-boss cron, workspace-timezone morning summary ("3 cases need attention, $87 at risk"). A digest alone is too slow — a refund request sitting 20h sours toward a chargeback. |

## Dependencies & risks

- **Depends on Phase 3:** paused case state + manual resume/stop, cases table where
  flagged cases surface, case timeline. Reply detection without a place to *see* the
  paused case is half a feature.
- **Forwarding must be bulletproof.** Today replies go straight to the merchant's inbox
  and Dunly never touches them; rerouting through Dunly means a dropped forward is
  *worse than not having the feature*. The spec needs delivery guarantees (retry on
  forward failure, alert on repeated failure) before this ships.
- **Receiving domain:** MX on the dev domain (`mail.yt-karaoke.online`) for dev; same
  one-env-var swap story as sending at launch.
