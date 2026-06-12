# Phase 2 — Product Shell (Locked Spec)

**Status: ✅ COMPLETE — all 9 exit criteria verified 2026-06-11** (see implementation
notes at bottom)

**Scope:** auth UI · app shell · workspace settings · Stripe connection UI · template &
sequence editor with live preview/test-send · per-stage control enforcement · verified
dev sending domain
**Out of scope:** dashboard/metrics (Phase 3), custom-domain DNS wizard (deferred — see
decision #2), Google sign-in (deferred — decision #1), team invites, Dunly's own billing,
pre-dunning, A/B testing.
**Parent doc:** [dunly-product-plan.md](./dunly-product-plan.md) §5.4, §5.5, §10 (Phase 2, Weeks 5–6)
**Builds on:** [phase-0-foundation.md](./phase-0-foundation.md) ✅ ·
[phase-1-dunning-core.md](./phase-1-dunning-core.md) ✅

## Locked decisions

1. **Google sign-in deferred.** Email + password only in Phase 2. Better Auth makes a
   social provider a drop-in addition later (config + button, no schema change).
2. **Custom-domain feature (DNS wizard) deferred** — it's a paid-tier differentiator
   with no customers until the dashboard exists. Instead, the founder's own domain is
   verified in Resend as the **dev sending domain**, which escapes the sandbox
   restriction (sandbox = owner-inbox-only). `EMAIL_FROM` flips from
   `onboarding@resend.dev` to `billing@<dev-domain>`; per Phase 1 locked decision #4
   the code is identical — env var only.
3. **Send windows use the *workspace* timezone, not the customer's.** The product plan
   says "customer's timezone," but Stripe doesn't reliably give us one (it requires
   address data many test/real customers lack). Workspace timezone
   (`WorkspaceSettings.timezone`, already in schema) is deterministic and good enough;
   customer-timezone refinement is a fast-follow when we have address coverage data.
4. **Template storage: editable content moves into `DunningStep` rows; the React layout
   stays code.** See design below. The locked footer (unsubscribe + portal links) is
   enforced **server-side at render time** — it is not part of the editable content, so
   no editor or API call can remove it.
5. **First step of the phase is housekeeping:** rotate `BETTER_AUTH_SECRET` to a real
   random value (it starts signing real user sessions; rotating invalidates Phase 1
   test-email footer tokens, which is acceptable), verify the dev domain in Resend,
   and type `req.workspace`/`req.session` properly (the known `requireWorkspace`
   cleanup from CLAUDE.md).

## Core design: template editing without losing the locked layout

Today a stage's email = compiled React component picked by `DunningStep.templateKey`,
with `subject` already a DB column. Phase 2 splits **content** (user-owned, DB) from
**chrome** (code-owned, locked):

- **`DunningStep.bodyHtml String?`** — new column. Sanitized rich-text HTML produced by
  the editor (allowed marks: paragraphs, bold, italic, links, lists). `null` means
  "use the built-in template" — existing campaigns keep working untouched.
- **Render path:** if `bodyHtml` is set, the send worker and preview endpoint render it
  inside `DunningLayout` (same header, CTA button, locked footer) instead of the
  `templateKey` component's body. Merge variables (`{{customer_name}}`,
  `{{amount_due}}`, …) are substituted in both subject and body via the existing
  `applyMergeVars`.
- **Sanitization happens server-side on save** (allowlist-based, e.g. `sanitize-html`)
  — never trust editor output; emails render in customers' inboxes.
- **Editor:** TipTap (headless rich text, React 19 compatible) constrained to the
  allowed marks, with a merge-variable insert menu.
- The 4 built-in templates remain the defaults and the "reset to default" target.

## What already exists (backend inventory — Phase 2 builds UI on top)

| Piece | Status |
|---|---|
| Better Auth email+password + signup hook (org + settings + default campaign) | ✅ working, no UI |
| `GET /api/workspace` (org + settings + role) | ✅ |
| Stripe Connect OAuth (`/api/stripe/connect`, `/callback`, `/disconnect`) | ✅, no UI |
| Render + merge vars + test send (`scripts/send-test-email.ts` logic) | ✅, script-only |
| `DunningStep.isEnabled` honored; `sendWindow*`, `skipIfAmountBelow` schema-only | per Phase 1 decision #3 |
| DESIGN.md tokens in `dunly-ui` (`@theme` sheet, fonts, badges) | ✅ landing page only |

## New API surface (all under `/api`, session + `requireWorkspace`)

| Route | What |
|---|---|
| `PATCH /api/workspace` | org name + settings (logoUrl, brandColor, replyTo, timezone) — Zod-validated |
| `GET /api/campaign` | the workspace's active campaign + ordered steps |
| `PATCH /api/campaign/steps/:id` | subject, bodyHtml (sanitized), delayHours, isEnabled, sendWindowStart/End, skipIfAmountBelow |
| `POST /api/campaign/steps/:id/reset` | clear bodyHtml/subject back to built-in defaults |
| `POST /api/preview` | render a step (or reactivation) with sample data → `{ html, subject }` |
| `POST /api/test-send` | render with sample data and send to the signed-in user's email |
| `GET /api/stripe/connection` | connection status card data (account, businessName, status, connectedAt) |

## Frontend (dunly-ui becomes the app)

- **Routing:** React Router 7 (`/` landing stays public; `/app/*` authenticated).
- **Auth:** Better Auth React client (`createAuthClient`) — sign-up, sign-in, sign-out,
  session hook; unauthenticated `/app/*` redirects to `/login`.
- **App shell:** DESIGN.md layout — 248px sidebar rail, content max 1180px. Nav for
  Phase 2: Sequence (editor), Settings (workspace + Stripe). Dashboard slot stubbed
  for Phase 3.
- **Pages:**
  1. `/login`, `/signup` — minimal card forms (DESIGN.md paper/ink styles)
  2. `/app/sequence` — stage list (order, delay, enabled toggle, subject) →
     stage editor: subject input, TipTap body, merge-var menu, per-stage controls,
     **live preview pane** (debounced `POST /api/preview` in an iframe), test-send button
  3. `/app/settings` — workspace form (name, logo URL, brand color picker, reply-to,
     timezone select) + Stripe connection card (status, connect/disconnect)
- **Data:** TanStack Query 5 (already a dep) for all `/api` calls; Vite proxy already
  forwards `/api` → :4000.

## Per-stage control enforcement (closes Phase 1 locked decision #3)

- **`skipIfAmountBelow`** — sequence worker: when creating rows, a stage whose
  threshold exceeds `case.amountDue` gets an `EmailSend` row created as `CANCELED`
  (`error: "amount below stage threshold"`) — visible in history, never queued.
- **Send windows** — both halves of schedule-ahead + guard-at-send:
  - *Sequence worker:* after computing `scheduledFor = failedAt + delayHours`, clamp
    forward to the next window opening in the workspace timezone.
  - *Send worker (authority):* if "now" lands outside the (possibly edited-since)
    window, do **not** cancel — re-enqueue the same `emailSendId` delayed to the next
    window start and leave the row `SCHEDULED`. Statuses unchanged; all idempotency
    layers still hold (same singletonKey, completed jobs don't block re-sends).
- **Delay edits** apply to future cases only (existing cases already have jobs
  scheduled) — documented in the UI copy.

## Build order

1. **Housekeeping:** rotate `BETTER_AUTH_SECRET` · verify dev domain in Resend
   (founder adds SPF/DKIM DNS records — guided) · swap `EMAIL_FROM` · type
   `req.workspace` properly
2. **Auth UI + app shell:** login/signup pages, session handling, protected `/app/*`,
   sidebar layout
3. **Workspace settings:** `PATCH /api/workspace` + settings page + Stripe connection
   card (`GET /api/stripe/connection`)
4. **Editor backend:** `bodyHtml` migration, sanitizer, campaign/step CRUD, preview +
   test-send endpoints
5. **Editor UI:** sequence page, stage editor with TipTap + merge vars + live preview +
   test send
6. **Enforcement:** skip-threshold + send-window logic in both workers
7. **Acceptance checklist run**

## Exit criteria (acceptance tests)

1. Fresh signup **through the UI** → workspace + default campaign auto-created; sign
   out / sign in round-trip works; `/app/*` unauthenticated → redirected to login.
2. Settings edits (brand color, logo, reply-to) persist and visibly change a test-send
   email's rendering and reply-to header.
3. "Connect Stripe" button completes the OAuth round-trip from the UI; the card shows
   `CONNECTED` + business name; disconnect flips it.
4. Editing stage 2's subject + body in the editor updates the live preview, and the
   test send lands in the inbox with the edits, merge vars substituted, **locked footer
   intact**.
5. A `PATCH` attempting to inject footer-stripping markup is sanitized server-side;
   the rendered email still contains unsubscribe + portal links (server-side guarantee,
   verified via preview HTML).
6. Stage 3 disabled in the UI → a new failing invoice schedules only stages 1, 2, 4.
7. A stage with a send window set → an email that would fire outside the window is
   deferred to the window start (verify `start_after` / sent timestamp in workspace tz).
8. `skipIfAmountBelow` above the invoice amount → that stage's row is `CANCELED`
   ("amount below stage threshold"), other stages unaffected.
9. With the dev domain verified, a test customer using a **non-owner email address**
   receives a real dunning email (sandbox escape proven).

## Founder inputs needed during the phase

- **Step 1:** add the SPF/DKIM DNS records Resend shows for the dev domain (~10 min,
  guided), then tell me the domain so `EMAIL_FROM` can be set.
- Everything else (Google OAuth, dunly.com purchase, hosting, real Resend webhook
  secret) is explicitly **not** needed for Phase 2.

## Implementation notes (discovered during the build)

1. **Dev sending domain:** `mail.yt-karaoke.online` verified in Resend via the Vercel
   auto-config integration; `EMAIL_FROM=billing@mail.yt-karaoke.online`. Sandbox escape
   proven twice (test-send to a +alias; a real stage-2 dunning email to a non-owner
   address in the acceptance run). The launch swap to `mail.dunly.com` is one env var.
2. **Auth-form lessons (found in browser testing):** browser/password-manager autofill
   sets input values without firing React `onChange` — auth + settings forms read via
   `FormData` on submit. And navigating right after `signIn()` resolves races the
   `useSession` store update (the guard bounces back to /login) — navigation is
   session-driven via `useEffect` on both auth pages.
3. **Timezone select trap:** plain `UTC` (the DB default) is not in
   `Intl.supportedValuesOf("timeZone")` — without an explicit option the browser
   silently selects the first list entry (Africa/Abidjan). UTC is pinned at the top.
4. **Merge-var escaping (hardening beyond spec):** stored bodies are sanitized, but
   merge-var VALUES resolve at send time from Stripe data a hostile end-customer
   controls (e.g. customer name) — `applyMergeVarsHtml` escapes them at substitution.
   JSX templates get this for free; `dangerouslySetInnerHTML` does not.
5. **Send-window math is Intl-based, never offset arithmetic** (`lib/send-window.ts`):
   re-derives the zone hour per instant, so DST and half-hour zones can't drift it.
   Out-of-window sends DEFER (row stays SCHEDULED, re-enqueued at the window opening);
   below-threshold stages become CANCELED history rows with the reason inline.
6. **Disconnect ends as `REVOKED`, not `DISCONNECTED`:** our endpoint marks
   DISCONNECTED, then Stripe's `account.application.deauthorized` webhook (fired by the
   deauthorize call) lands and the Phase 0 handler marks REVOKED. Both mean
   not-connected; the webhook is authoritative. Reconnecting in test mode mints a new
   `acct_…` (current: `acct_1Th6wnBkLDS84mAm`), orphaning events from the old one
   (SKIPPED — expected in dev).
7. **Windows Defender false positive:** `Trojan:Script/Wacatac.H!ml` quarantines
   `node_modules/prisma/build/index.js` (phantom `UNKNOWN -4094` file errors). Fixed
   with a Defender exclusion for `dunly-backend\node_modules\prisma`. Also: Z: is a
   small local NTFS volume (10 GB), not a network drive — watch free space.
8. **Deferred to later phases:** prefill the body editor with the built-in template's
   copy (needs JSX→editable-HTML export); reactivation email editing; per-customer
   timezone send windows; `skipIfAmountBelow` UI in real currency units.
9. **Acceptance evidence (2026-06-11):** AC1 fresh UI signup → workspace + 4-step
   campaign, guard bounce + bounce-back verified. AC2 plum brand color + logo rendered
   in test send; reply-to header set. AC3 Disconnect → REVOKED → reconnect →
   CONNECTED via UI OAuth. AC4 editor draft → live preview (iframe a11y-verified) →
   save → test send ✓. AC5 footer-stripping payload (closing table tags, style,
   overlay) reduced to plain text; both footer links survive. AC6/7/8/9 one real
   failing $29 subscription: stage 3 (disabled) created NO row; stage 1 clamped to
   09:00 Asia/Manila (01:00Z); stage 4 CANCELED "amount below stage threshold
   (2900 < 10000000)"; stage 2 SENT to a non-owner address through the production
   path. Case closed RECOVERED via real `invoice.paid`; campaign restored to stock.
