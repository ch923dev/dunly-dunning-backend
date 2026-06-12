# Phase 3 — Dashboard (Locked Spec)

**Status: ✅ COMPLETE — all 10 exit criteria verified 2026-06-11** (see implementation
notes at bottom)

**Scope:** recovery metrics + trend · cases table with manual pause/resume/stop · case
detail timeline · per-stage email performance · honest churn split · Sequence page
brought to prototype fidelity (timeline restyle).
**Out of scope:** pre-dunning (product Phase 4 — dashboard leaves a slot, no callout),
reply intelligence ([phase-4 candidate](./phase-4-candidate-reply-intelligence.md)),
win-back campaigns, A/B testing, weekly digest email, large-invoice alerts, CSV export,
team invites, Dunly billing.
**Parent doc:** [dunly-product-plan.md](./dunly-product-plan.md) §5.6, §10 (Phase 3, Weeks 7–8)
**Builds on:** [phase-0](./phase-0-foundation.md) ✅ · [phase-1](./phase-1-dunning-core.md) ✅ ·
[phase-2](./phase-2-product-shell.md) ✅
**Design reference:** `dunly-design/project/Dashboard.jsx`, `Cases.jsx`, `CaseDetail.jsx`,
`Sequence.jsx` (intent only — see DESIGN-NOTES.md)

## Locked decisions (proposed)

1. **Case timeline is derived, not stored.** No new activity table: the timeline renders
   from data we already have — `DunningCase` (failedAt, recoveredAt, closedAt, status,
   attemptCount, failureCode), `EmailSend` (scheduledFor, sentAt, openedAt, clickedAt,
   status, error — including CANCELED reasons and deferred sends), `SuppressionEntry`
   (unsubscribe moment). A dedicated event table is deferred until something needs
   events we don't already record (inbound replies, Phase 4 candidate).
2. **Pause = hold, not cancel.** `POST /cases/:id/pause` sets `status: PAUSED`. Pending
   `EmailSend` rows stay `SCHEDULED`; when a delayed job fires for a paused case, the
   send worker (the authority) returns without sending — the row is now *held* (no
   future job). Resume sets `ACTIVE` and re-enqueues every held `SCHEDULED` row at
   `max(now, scheduledFor)`, window-clamped. Same machinery as Phase 2's
   defer-on-window — completed jobs don't block re-sends; all idempotency layers hold.
3. **Stop conditions beat pause.** `invoice.paid` on a `PAUSED` case still closes it
   `RECOVERED` (likewise disputes/cancellations → their terminal states). The Phase 1
   status-guarded handlers currently transition from `ACTIVE`; they widen to
   `ACTIVE | PAUSED`. Pause stops *our emails*, never the case's real-world outcome —
   same doctrine as suppression.
4. **Manual stop → `LOST_INVOLUNTARY`.** "Stop & mark lost" cancels pending rows
   (`CANCELED`, error `"manually stopped"`), sets `closedAt`. No new enum value; a
   merchant abandoning an involuntary failure is an involuntary loss. Irreversible
   (confirm dialog) — same as every other terminal state.
5. **Recovery-rate math (the "honest split"):** recovery rate =
   `RECOVERED / (RECOVERED + LOST_INVOLUNTARY)` over cases *closed in the period*.
   `LOST_VOLUNTARY` is excluded from the denominator and reported separately — you
   can't "recover" someone who quit on purpose. `SUPPRESSED` cases count on whichever
   side they eventually close (a suppressed case can still recover via Smart Retries).
6. **Single-currency display.** Aggregates group by `DunningCase.currency`; the UI
   shows the connection's `defaultCurrency` headline and flags any other currencies
   with a footnote count rather than silently summing apples and oranges. (Dev data is
   all USD; this is a correctness guard, not a feature.)
7. **Opens/clicks come from Resend webhooks, which need a public URL we don't have in
   dev.** The `EmailSend` status ladder + `openedAt`/`clickedAt` columns and the
   `/webhooks/resend` handler exist since Phase 1; dev acceptance uses the existing
   `send-synthetic-resend-event` script. Real tracking lights up at deployment
   (real `RESEND_WEBHOOK_SECRET`) with zero dashboard changes. Email-performance UI
   labels opens/clicks honestly when counts are zero ("no tracking data yet").
8. **Recovery attribution is last-touch:** a recovered case credits the last stage
   *sent* before `recoveredAt` (cases recovered with no email sent — e.g. Smart Retries
   before stage 1 — count as "no email needed" and credit no stage).
9. **Sequence restyle is presentational only.** The page adopts the prototype's
   vertical timeline (numbered day circles + rail, richer cards, plum reactivation
   circle, read-only Stop conditions card). Controls that have no backing feature are
   **omitted, not faked**: no "Add a touch", no pre-dunning section, no Live/Paused
   campaign master toggle. Phase 1/2 behavior (toggle, edit, locked semantics) is
   untouched.
10. **Trend chart is honest and derived:** weekly buckets, last 8 weeks, each bar =
    amount failed that week split into *recovered-so-far* (brand green) vs *still
    open/lost* (line gray). Computable from `failedAt`/`recoveredAt` alone; no
    snapshotting, no new tables. Div-based stacked bars per the prototype (no chart
    lib needed).

## What already exists (Phase 3 builds reads + 3 writes on top)

| Piece | Status |
|---|---|
| Case state machine incl. `PAUSED` in the enum | ✅ schema; nothing sets PAUSED yet |
| `EmailSend` ladder + `openedAt`/`clickedAt` + Resend webhook handler | ✅ since Phase 1 |
| All timeline raw material (timestamps on case/sends/suppressions) | ✅ |
| App shell with stubbed Dashboard nav slot ("soon" badge) | ✅ Phase 2 |
| Cancel-pending-sends helper (stop conditions) | ✅ `jobs/dunning.ts` |
| Synthetic-event scripts incl. `send-synthetic-resend-event` | ✅ `scripts/` |

## New API surface (all under `/api`, session + `requireWorkspace`)

| Route | What |
|---|---|
| `GET /api/metrics` | headline cards (recovered this month + all time, at risk + open count, recovery rate, avg days-to-recover), 8-week trend buckets, voluntary/involuntary lost split, other-currency flag |
| `GET /api/metrics/email-performance` | per stage: scheduled/sent/opened/clicked counts + last-touch recoveries (+ reactivation row) |
| `GET /api/cases?status=&minAmount=&maxAmount=&since=&cursor=` | paginated case list: customer (name/email), amount, failure reason, stage progress (sent/total), next scheduled send, status |
| `GET /api/cases/:id` | case header + customer card + derived timeline (failed → scheduled/sent/opened/clicked/deferred/canceled → unsubscribed → recovered/lost) + next-touch card |
| `POST /api/cases/:id/pause` | ACTIVE → PAUSED (404 outside workspace, 409 if not ACTIVE) |
| `POST /api/cases/:id/resume` | PAUSED → ACTIVE + re-enqueue held rows |
| `POST /api/cases/:id/stop` | ACTIVE/PAUSED → LOST_INVOLUNTARY + cancel pending rows |

All reads are workspace-scoped through `connection.organizationId` (same `findOwnX`
isolation pattern as campaign steps — cross-workspace IDs 404).

## Frontend (dunly-ui)

- **Sidebar:** Dashboard loses the "soon" badge and becomes the `/app` index (replacing
  the redirect to sequence); **Cases** nav item added with live active-count badge.
- **`/app` — Dashboard** (prototype `Dashboard.jsx`): 4 stat cards (Revenue recovered =
  hero with brand accent bar; at risk; recovery rate; avg days — JetBrains Mono
  numerals), churn-split footnote line, trend chart (stacked div bars), Active-cases
  preview table (top 5, click-through to case detail, "View all" → Cases). No
  pre-dunning callout, no "Sync Stripe" button (data is webhook-driven).
- **`/app/cases`** (prototype `Cases.jsx`): filter chips (status — all six states ·
  amount bands · date), dense table (avatar+customer, amount, reason tag, StageDots
  progress, next email, StatusBadge, row-action menu: view / pause-or-resume /
  stop-and-mark-lost with confirm), at-risk sum in the header, the
  "watching your Stripe account" empty state for real zero-case workspaces.
- **`/app/cases/:id`** (prototype `CaseDetail.jsx`): header card (customer, status
  badge, Pause/Resume button, 4 metric tiles), vertical recovery timeline (icon ring
  per event type, dashed future events from SCHEDULED rows), side column: outcome
  callout (engaged / suppressed-≠-lost / recovered / lost), next-scheduled-touch card
  (links to the stage editor), customer card (email, plan, amount — only fields we
  actually mirror; no invented LTV).
- **`/app/sequence` restyle** per locked decision #9.
- **Status colors per DESIGN.md:** active = slate, recovered = green, lost = rose
  (voluntary = neutral gray), suppressed = plum, paused = amber. Brand green never
  marks in-flight cases.
- **Data:** TanStack Query throughout; mutations invalidate `['cases']` / `['metrics']`.

## Worker changes (small, surgical)

- **Send worker:** one new guard — case `PAUSED` → log + return (row stays SCHEDULED,
  job completes ⇒ held). Sits beside the existing suppression/window/threshold guards.
- **Resume path:** re-enqueue held rows (`boss.send` same `emailSendId` + singletonKey,
  `startAfter = clampToWindow(max(now, scheduledFor))`).
- **Stop-condition handlers:** widen status guards `ACTIVE` → `ACTIVE | PAUSED`.
- Nothing else in the engine moves — Phase 0/1/2 invariants all hold.

## Dev data for acceptance

Real Stripe cases are slow to mass-produce, so step 1 includes
`scripts/seed-dashboard-fixture.ts`: writes a believable, **clearly-marked** synthetic
dataset directly to the DB (≈15 cases across all six states spread over 8 weeks, email
sends with opens/clicks, mixed amounts) against the dev workspace, plus a teardown flag
(`--clean`). Used to verify metric math against hand-computed ground truth; the
pause/resume/stop criteria run against *real* Stripe-created cases.

## Build order

1. **Seed fixture + metrics backend:** `seed-dashboard-fixture.ts`, `GET /api/metrics`,
   `GET /api/metrics/email-performance` — verified against hand-computed sums
2. **Cases backend:** list + detail/timeline endpoints; pause/resume/stop endpoints;
   send-worker PAUSED guard; status-guard widening; resume re-enqueue
3. **Dashboard UI:** stat cards, trend, churn footnote, active-cases preview; sidebar
   updates (`/app` index swap, Cases nav + badge)
4. **Cases UI:** table + filters + row actions + empty state; case detail page with
   timeline
5. **Sequence restyle:** prototype-fidelity timeline (presentational only)
6. **Acceptance checklist run**

## Exit criteria (acceptance tests)

1. With the seeded fixture, every dashboard headline number equals a hand-computed SQL
   ground truth (recovered, at risk, recovery rate per decision #5, avg days).
2. Trend-chart weekly buckets match SQL sums; churn footnote shows voluntary and
   involuntary separately and voluntary provably does not move the recovery rate.
3. Cases table: each status filter returns exactly the matching rows; header at-risk
   sum matches; a workspace with zero cases shows the monitoring empty state.
4. **Pause holds a live send:** real failing invoice, pause the case before a due
   stage → job fires, nothing sends, row stays `SCHEDULED` with no future job; resume
   → email actually delivered.
5. **Stop conditions beat pause:** pay a paused case's invoice → case `RECOVERED`,
   held rows `CANCELED` — proving pause never traps a case.
6. Stop & mark lost (with confirm) → case `LOST_INVOLUNTARY`, pending rows `CANCELED`
   ("manually stopped"), and the case appears in the lost split.
7. Case detail timeline on a real case shows failed → scheduled → sent → opened →
   clicked (synthetic Resend events) → recovered, in order with correct timestamps;
   future sends render dashed.
8. Email-performance counts match `EmailSend` rows exactly; a recovered case credits
   only its last-sent stage (last-touch).
9. Cross-workspace isolation: case IDs from another workspace 404 on detail and all
   three actions.
10. Sequence page matches the prototype timeline visually; toggling and editing still
    work identically (no behavior change).

## Founder inputs needed during the phase

**None.** No DNS, no purchases, no third-party setup — Phase 3 is entirely reads +
three case actions on data we already collect. (Real open/click tracking arrives free
at deployment time, per decision #7.)

## Implementation notes (discovered during the build)

1. **Status-guard widening was already done.** Phase 1 had widened the stop-condition
   handlers to `ACTIVE | PAUSED | SUPPRESSED` for the dispute handler — "stop
   conditions beat pause" needed zero handler code, only the send-worker hold guard.
2. **Resume is `enqueueSequence()`, nothing more.** The sequence worker's existing
   self-heal path (re-enqueue a possibly-lost job for any SCHEDULED row) is exactly
   "re-enqueue held rows". One status flip + one idempotent kick.
3. **Hold guard placement:** in the send worker, PAUSED is checked *before* the
   not-ACTIVE cancel guard — a paused case logs `held send …` and returns with the row
   still SCHEDULED and the job completed (= no pending job, verifiable in pgboss.job).
4. **Filter-summary bug caught in step 2:** the at-risk aggregate originally spread the
   list filter and then *overrode* its `status` clause with the open-statuses list, so
   `?status=PAUSED` showed the global at-risk figure. The summary is now the
   open-statuses portion OF the filter (narrowing, never widening).
5. **Timeline timestamps for CANCELED rows are their `scheduledFor`** (we don't store a
   canceledAt) — a stage canceled by recovery can render with a future date, reading as
   "would have sent Jun 13 — canceled: invoice paid". Honest and informative; revisit
   only if users misread it.
6. **Fixture discipline:** synthetic rows get NO pg-boss jobs, so they can never send
   (the engine is job-driven, nothing scans for due rows). Consequently UI *resume* was
   never exercised on fixture data — resume would mint real future jobs against
   @example.com addresses. Pause/stop are status-only and safe anywhere.
7. **Manual stop does not cancel the Stripe subscription** — it closes Dunly's case and
   cancels Dunly's emails; Stripe keeps retrying unless the merchant cancels in Stripe.
   Documented behavior, mirrors the suppression doctrine. (A later subscription
   deletion event correctly leaves the already-terminal case untouched — verified.)
8. **Resuming a dispute-paused case would resurrect its dispute-canceled sends** (the
   sequence worker reschedules CANCELED rows by design — that's the reopen path). The
   manual-resume button is only offered on PAUSED cases, which today means
   manually-paused or dispute-paused; a merchant deliberately resuming a disputing
   customer is their call, but a future confirm-copy tweak could warn about it.
9. **Acceptance evidence (2026-06-11):** AC1/AC2 every dashboard number + two trend
   buckets matched independent SQL; voluntary exclusion proven (83% vs 71% if counted).
   AC3 filters matched SQL counts (the lone failure was a test artifact: an unencoded
   `+00:00` in a hand-built query string — API correctly 400'd); AC1-account empty
   state rendered. AC4 on a REAL case (clock fast-forwarded by backdating
   `scheduledFor` + the job's `start_after`): real worker fired while paused → `held
   send` log, row SCHEDULED, job completed; UI Resume → stage 2 SENT for real
   (Resend id 5e4af089…) seconds later. AC5 paid the paused case's invoice →
   RECOVERED, held rows CANCELED "invoice paid". AC6 UI Stop & mark lost (confirm
   dialog) → LOST_INVOLUNTARY + "manually stopped" rows + involuntary split rose
   $129→$158. AC7 real-case timeline: failed → sent → opened → clicked (synthetic
   Resend events) → stage-2 sent → recovered → 3/4 canceled, in order. AC8
   email-performance matched SQL; case A last-touch credited stage 2 (3→4). AC9 all
   four endpoints 404 cross-workspace. AC10 sequence timeline verified in step 5
   (toggle round-trip, campaign restored to stock). Cleanup: case A RECOVERED, case B
   LOST_INVOLUNTARY + Stripe sub canceled, campaign stock, queue depth 0.
