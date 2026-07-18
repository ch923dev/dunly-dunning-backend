# dunly-backend

Express 5 + TypeScript (ESM, NodeNext — relative imports need `.js` extensions). Postgres 17 in Docker, Prisma 7 (driver adapter), pg-boss job queue, Better Auth (organization plugin), Stripe Connect, Resend + React Email.

## Commands

```bash
npm install --include=dev        # NODE_ENV quirk — never plain npm install
docker compose up -d             # Postgres 17 (postgres/postgres, db: dunly, :5432)
npm run dev                      # tsx watch, API on :4000
npm run typecheck                # tsc --noEmit — run after every change set
npm run db:migrate               # prisma migrate dev (interactive)
npm run db:deploy                # prisma migrate deploy (non-interactive)
npm run db:generate              # regenerate Prisma client after schema changes
npm run db:studio                # Prisma Studio on :5555
npm run email:dev                # React Email preview on :3000
stripe listen --forward-to localhost:4000/webhooks/stripe   # webhook tunnel
```

Test/replay scripts (all `npx tsx scripts/<name>.ts`): `create-failing-subscription`, `pay-invoice`, `cancel-subscription`, `send-synthetic-event`, `send-synthetic-resend-event`, `send-test-email`, `process-one`, `ensure-default-campaigns`, (phase 4) `create-expiring-card-customer` (`--extra-sub`), `run-expiry-scan`, `update-card-expiry`, `add-failing-subscription`, `print-expiry-links`, `render-expiry-preview`, and (phase 5) `send-synthetic-inbound` (`--case/--auto/--inbound-id`), `print-reply-links`.

**Dev server reload gotcha:** `npm run dev` may be started as plain `tsx` (no watch) in this environment — after backend edits or `db:generate`, restart it manually or workers run stale code (symptom: Prisma enum errors from the send worker).

## Layout

- `src/env.ts` — Zod-validated env; add any new env var here first or boot fails
- `src/lib/` — core logic (ingest, queue, email, campaigns, tokens, auth, stripe)
- `src/routes/` — webhooks (signature-auth, no session), `/api/*` (Better Auth session + `requireWorkspace`), `/r/*` (HMAC token links)
- `src/jobs/` — pg-boss workers: `process-events.ts` (event dispatcher), `dunning.ts` (sequence engine + send worker)
- `src/emails/` — React Email templates; shared `components/layout.tsx` owns the locked footer
- `src/generated/prisma/` — generated client, **never hand-edit**; run `npm run db:generate`

## Invariants — do not break

- **Idempotency is layered**: `WebhookEvent` UNIQUE on `stripeEventId`, pg-boss `singletonKey`, status-guarded handlers, Resend Idempotency-Key. Keep all layers.
- **pg-boss queues use the "short" policy intentionally** — the default "standard" policy silently ignores `singletonKey` and lets duplicate jobs through. Never change it back.
- **`EmailSend` UNIQUE on `(dunningCaseId, stageOrder)`** — a case never sends the same stage twice; re-opened cases resume, not restart.
- **Email pattern is schedule-ahead + guard-at-send**: rows + delayed jobs created at case open, then everything re-verified (case state, suppression, connection) immediately before calling Resend.
- **Webhooks ack fast**: verify signature, store event, enqueue, return 200. No business logic in the request handler.
- Case state machine: ACTIVE → RECOVERED / LOST_INVOLUNTARY / LOST_VOLUNTARY / SUPPRESSED / PAUSED. Handlers are status-guarded — check current state before transitioning.

## Gotchas

- Resend sandbox only delivers to the account owner's email; use `delivered@resend.dev` / `bounced@resend.dev` for synthetic tests.
- Stripe Smart Retries keep running even for SUPPRESSED cases — a suppressed case can still recover via `invoice.paid`.
- Workspace context: routes behind `requireWorkspace` read it via `getWorkspace(req)` (throws if the middleware wasn't applied) — never `req.workspace!`.
- Migrations in `prisma/migrations/` are locked — create new migrations, never edit existing ones.
