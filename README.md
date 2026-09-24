# marlo-scheduling

Built by the OLI Agent OS loop with no human merge: `PLAN.md` → plan review → build → `PROOF_CMD` → inspect → judge → PR → CI (`proof`) → auto-merge → deploy.

## Local development

```bash
npm ci
npm test
npm run dev
```

- `npm ci` — install dependencies from the lockfile on a clean checkout
- `npm test` — PROOF_CMD: typecheck, `next build`, and automated tests
- `npm run dev` — start the Next.js App Router app locally

### Offline contract

`npm test` is **offline once `node_modules` is present; on a clean checkout `npm test` first runs `npm ci` unless `MARLO_OFFLINE=1`.** The proof harness (`scripts/proof.cjs`) provisions dependencies strictly before any proof step, prints `proof: provisioning dependencies via npm ci (network)` when it does, and refuses with exit 2 under `MARLO_OFFLINE=1`. Every proof child is spawned with an explicit disabled environment (`MARLO_PROOF=1 LIVE_CALENDAR=0 LIVE_EMAIL=0 DATABASE_URL=`), `MARLO_PROOF=1` is a hard override in `lib/env.ts`, and a test-setup `fetch` guard throws on any non-localhost URL. No test needs a database, Google, Gmail, or the network.

## Public booking

- `/{ownerSlug}/{eventSlug}` — the product booking page. Event types are **owner-scoped**: two owners may both offer `intro-30`, and each page, availability call, and booking resolves to its own owner's event type, calendar id, host id, and owner email. Every piece of host-facing copy (title, hero, confirmation, email subject and body) uses that owner's `firstName`.
- `/demo/intro-30` — the fixture-backed demo route only. It is not the product URL.
- Owner-scoped API routes:
  - `GET /api/owners/{ownerSlug}/event-types/{eventSlug}/available-times?timeMin&timeMax`
  - `POST /api/owners/{ownerSlug}/event-types/{eventSlug}/bookings`
- Legacy `/api/event-types/{slug}/*` resolve **only** within the `demo` owner; any other slug is 404 `owner_required`. They are kept for fixtures and tests and are not linked from any page.

### Reserved owner slugs

An owner's slug is the validated local-part of their Google email. Application-owned root path segments — `api`, `b`, `host`, `signin`, `tokens`, `components` — are **reserved** (`RESERVED_ROOT_SLUGS` in `lib/owners.ts`). A Google account whose local-part is reserved fails sign-in with `owner_slug_reserved` before any `owners` or `host_tokens` row is written; the sign-in page shows "This Google account's address can't be used as a booking URL — sign in with a different account". Two accounts sharing a local-part fail with `owner_slug_taken` rather than being silently suffixed.

### `Idempotency-Key` on create

`POST …/bookings` requires an `Idempotency-Key: <uuid>` header; a missing or malformed key is 400 `idempotency_key_required`. The browser client mints one key per submission, persists the key **and the payload it was minted for** in `sessionStorage` before sending, and replays that stored payload on every retry. A replay with the same key returns the **same** booking (same `id`, same `token`) with the row's current state — never a second row and never a second calendar event.

The header requirement is scoped to the live product's event kind. It is checked **after** the read-only catalog resolution and after the group/collective kind gate, so a `group` or `collective` event type never reaches it.

### Unresolved-submission recovery on reload

If a response is lost (network error, 503, 5xx, or a page reload mid-submit), the stored `{ key, payload }` record is **retained**. On construction the booking form checks for an unresolved record **before** it loads availability: if one exists it shows "Finishing your booking…" and replays the original request, bypassing the elapsed-start and availability gates for that replay only. A 201 navigates to the original `/b/{token}`; a 503 or 5xx offers **Try again** (replays the same key and payload) and **Start over** (discards the record). The record is cleared only on a response that proves no row exists for the key: 201, 400, 409 `slot_unavailable` / `session_full`, or 422 `idempotency_key_reused`.

### The external-calendar check runs before the booking is saved

Before a booking is written, Marlo reads the host's primary Google Calendar (`events.list`) for the target interval and refuses an externally busy slot with 409 `slot_unavailable` — no row, no operation, no key consumed. That read is a **snapshot taken before the row is committed**: an external event the host adds in the window between the read and the commit is not seen by that booking. The next availability read treats it as busy. The overlap this window can produce is always between a Marlo booking and a host-entered event, never between two Marlo bookings, because Marlo's own occupancy is re-checked under the per-host lock.

## Booking `id` vs `token`

A booking has two different identifiers and they are never equal:

- `booking.id` — the API path segment. It grants nothing on its own.
- `booking.token` — the secret capability: the `/b/{token}` page **and** the bearer credential.

Every `/api/bookings/{id}` and `/api/bookings/{id}/*` request must carry `Authorization: Bearer {token}`. A missing header is 401 `token_required`; an unknown id or a wrong token is 404 `booking_not_found` (uniform, so ids cannot be enumerated). The token is never accepted in the query string or the JSON body.

## The 201 + `delivery` contract

A booking whose row was committed is **HTTP 201**, even when email or the calendar failed:

```json
201 {
  "booking": { "id", "token", "ownerSlug", "eventSlug", "start", "end", "status", "revision", "hostFirstName" },
  "delivery": {
    "email": "sent" | "failed" | "pending",
    "calendar": "created" | "failed" | "skipped" | "deleted" | "pending",
    "errors": { "email": "…", "calendar": "…" }
  }
}
```

`delivery.email` is computed against the **required recipient set** (invitee and owner): `sent` only when both recipients have an explicit `sent` row, `failed` when any row failed, and `pending` otherwise — including a recipient with no row at all.

### `calendar_state` and repair on notify

`delivery.calendar` mirrors the row's `calendar_state`, which is one of `pending`, `created`, `failed`, or `deleted`:

- `pending` — the calendar event is still being created and its outcome is not yet known. It appears only on a read (`GET /api/bookings/{id}` or `/b/{token}`), never on a create 201, and renders as a status line with no control and no polling.
- `created` — the event exists.
- `failed` — the insert was definitely refused. `POST /api/bookings/{id}/notify` begins an owned **calendar repair** operation that re-inserts under the same intended event id, serialized with reschedule and cancel.
- `deleted` — the booking was cancelled and its event removed.

### Notify: two request forms

`POST /api/bookings/{id}/notify` takes either form:

- `{ "action": "confirm" | "reschedule" | "cancel", "expectedRevision": n }` — a revision-specific retry, validated against the booking's current `(revision, latest_action)` under the claim lock. A mismatch is 409 `stale_revision` and nothing is sent.
- `{}` — explicit retry-latest: the route resolves the booking's current `(revision, action)` under the same lock and echoes which pair it retried. This is what the page's Resend control uses after a reload.

Supplying `action` without `expectedRevision` (or the reverse) is 400 `notify_request_invalid`.

## `/b/{token}` — the guest's change path

The booking page is where a guest changes their mind; the flow is not "reopen the event link and book again". A confirmed booking shows three controls:

- **Reschedule** — opens a slot picker fed by `GET /api/bookings/{id}/available-times`, which excludes the booking's own occupancy.
- **Cancel** — two-step (button, then an inline confirm).
- **Resend confirmation** — retries delivery through the notify route.

A cancelled booking shows **no** Reschedule or Cancel control. It shows the cancellation delivery status and, whenever that status is `pending` or `failed`, a **Retry notification** control — both immediately after cancelling and on a fresh load of the page. There is no background delivery worker, so that control is the only retry path.

### The 15-minute reschedule grid

The public picker steps by the event's duration, so excluding a booking's own occupancy alone could never offer an overlapping move. The authenticated reschedule picker therefore uses a **15-minute** grid (`RESCHEDULE_SLOT_INCREMENT_MIN`, or the duration when it is shorter). A 30-minute booking at 09:00 is offered 09:15 (overlapping) and 09:30 (adjacent), among others; its own current start is never offered, so an unchanged-time reschedule is 409 `slot_unavailable` and makes no calendar call. The reschedule route and the reschedule mutation use the same generator, so every slot the page offers is one the server accepts.

### Retry semantics

- 409 `operation_in_progress` — another change to this booking is still finishing. The page waits `retryAfterSeconds` and retries once automatically. If that retry is answered the same way, the page stops retrying and offers **Try again** (re-sends the identical request) and **Reload** (re-reads the booking). The page is never left disabled with nothing in flight.
- 409 `booking_changed` — the booking changed elsewhere. The page reloads and shows the latest.
- 503 `booking_outcome_unknown` — "We're not sure that went through". The recovery action **re-reads** the booking; it never re-submits.

## Email

Every booking sends real email to **both** the invitee and the owner, for confirm, reschedule, and cancel alike. Each of the six bodies carries the absolute `/b/{token}` URL of its booking.

### Ordering

Because emails are sent after the booking is saved, an earlier email (for example a confirmation) can occasionally arrive after a later one (for example a cancellation). The order in which emails arrive does not tell you the booking's current state; the booking page linked in every email is the authoritative status.

### Duplicates

A retry can occasionally deliver more than one copy of the same email, and delayed copies may arrive close together; the number of copies never exceeds the number of retries recorded for that email. A retry of an email whose earlier send is still unresolved is accepted at most once per 2-minute stale window; an email that Gmail definitely refused can be retried immediately.

## Late-landed calendar events

Google does not guarantee that a request it has accepted executes promptly, nor that a re-used event id is rejected. An insert Marlo gave up on can therefore land on the host's calendar later. Such an event is **never offered as free time**, **never becomes a booking**, and **never persists** — it is deleted by the next call that observes it.

What is *not* promised: a slot's occupancy is not held for as long as an insert might still execute, because Google bounds nothing about delayed execution. So a late insert that lands after its booking was cancelled and the slot re-booked produces a **transient** overlap on the host's Google Calendar until the next observing call removes it. The new booking is never rejected, undone, or re-notified because of it.

A Marlo event the host moves by hand in Google Calendar blocks both its old interval (from the store) and its new one (conservatively, from the calendar) until the host moves it back or the guest reschedules. No calendar-to-store synchronization is attempted.

## Durable store

Live code paths activate only when `DATABASE_URL`, `LIVE_CALENDAR=1`, and `LIVE_EMAIL=1` are set **and** the database schema is current.

```bash
npm install pg            # the Postgres driver; see below
export DATABASE_URL=postgres://…
npm run db:migrate
export LIVE_CALENDAR=1 LIVE_EMAIL=1
```

**The driver is a deployment prerequisite.** The whole durable path is written
against the `Queryable` seam, so `npm test` proves it offline with no driver at
all, and `lib/db/driver.ts` loads one at runtime through a computed
`createRequire` specifier — `pg` or `@neondatabase/serverless`, whichever is
installed. Neither is a dependency of this package today: install one alongside
it (`npm install pg`) before `npm run db:migrate`, or the store answers
`store_driver_unavailable` (503) and `/api/health` reports `db: "unreachable"`.
Because the specifier is computed, Next's file tracing cannot see it either;
`next.config.ts` lists both candidates in `serverExternalPackages` and
`outputFileTracingIncludes` so the installed one is shipped with the serverless
functions.

In that order: install the driver, set `DATABASE_URL`, run `npm run db:migrate`, then set the `LIVE_*` flags. `scripts/migrate.cjs` applies `sql/*.sql` in filename order, one transaction each, skipping versions already recorded in `schema_migrations`; it is idempotent. The store refuses to serve with `store_not_migrated` until the latest version is applied.

### Group and collective event types

Group (capacity-N) sessions and collective (multi-host) bookings are **memory-mode fixtures outside the live product**. In pg/live mode they are never seeded or materialized, and a slug that resolves to one is refused 501 `group_not_supported` / `collective_not_supported` after the read-only catalog lookup and before any booking side effect.

### One-off links are fixture-only

`GET /api/links/{token}/available-times` and `POST /api/links/{token}/bookings` are a fixture/test entry point, not part of the live product. In memory mode they book through the shared create path (same host lock, same occupancy, same idempotency record keyed on the link token), and a `POST` on a **consumed** link with the identical payload replays the original booking as 201 — a lost response is recoverable — while a different payload is 410. In pg mode both routes return 501 `links_not_supported` before any store, calendar, or email side effect.

## Health

`GET /api/health` returns:

```json
{ "ok", "sha", "store": "memory" | "pg", "schema": "current" | "behind" | "missing" | "unknown" | "n/a",
  "db": "ok" | "unreachable" | "n/a", "calendar": "mock" | "live", "email": "mock" | "live" }
```

`ok` is true iff `schema` is `current` or `n/a`; the response is HTTP 200 when `ok` and **HTTP 503** otherwise, so an unmigrated, behind, or unreachable database fails a post-deploy check loudly. In pg mode the route issues exactly one bounded `schema_migrations` readiness query (2 s deadline) per request, including the first request a fresh isolate serves; it caches nothing. In memory mode it performs zero I/O. `calendar` and `email` report **configuration**, never connectivity: the route makes no Google or Gmail call of any kind.

## Environment variables

Set these names in the host environment (Vercel / local `.env`). Do not commit secret values.

- `AUTH_SECRET` — Auth.js session secret
- `AUTH_GOOGLE_ID` — Google OAuth client id
- `AUTH_GOOGLE_SECRET` — Google OAuth client secret
- `DATABASE_URL` — Neon Postgres connection string. Its presence selects the durable store.
- `LIVE_CALENDAR` — `1` to use the live Google Calendar adapter
- `LIVE_EMAIL` — `1` to use the live Gmail adapter
- `OAUTH_TOKEN_KEY` — AES-256-GCM key material for the refresh tokens in `host_tokens`. Rotation is not handled automatically; rotating it requires every host to re-connect.
- `GOOGLE_CLIENT_ID` — Google Cloud OAuth client id for the Calendar and Gmail APIs
- `GOOGLE_CLIENT_SECRET` — Google Cloud OAuth client secret
- `MARLO_PROOF` — `1` forces the in-memory store and the mock adapters, overriding every value above
- `MARLO_OFFLINE` — `1` forbids the proof harness's `npm ci` bootstrap

Host OAuth requests exactly these scopes, with `access_type=offline` and `prompt=consent`:
`openid email profile https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send`.

Legacy names, kept for the fixture email path (names only, no values):

- `GMAIL_CLIENT_ID` — Google Cloud OAuth client id for Gmail API
- `GMAIL_CLIENT_SECRET` — Google Cloud OAuth client secret
- `GMAIL_REFRESH_TOKEN` — offline refresh token for the sending mailbox
- `GMAIL_FROM` — sender address for confirmation mail

## Founder live smoke (manual)

1. Set `DATABASE_URL` on Vercel; run `npm run db:migrate`.
2. Set `LIVE_CALENDAR=1`, `LIVE_EMAIL=1`, `OAUTH_TOKEN_KEY`, and the Google client id/secret.
3. Hit `/api/health` as the **first** request after the deploy: expect 200 with `store: "pg"`, `schema: "current"`, `db: "ok"`, `calendar: "live"`, `email: "live"`. Against an empty database expect 503 with `schema: "missing"`.
4. Sign in at `/signin` (this creates the owner row and materializes its event types).
5. Book `/{ownerSlug}/intro-30`. Confirm the event appears on the host calendar with a `marlo…` event id and that both inboxes receive a confirmation carrying a booking-page link.
6. Open `/b/{token}`: use **Reschedule** (the event moves; two reschedule emails), then **Cancel** (the event is removed; two cancel emails).
7. Submit the booking form twice quickly and confirm exactly one booking exists.
8. Reload the booking page mid-submit (throttle the network) and confirm the reload finishes the original booking.
9. In the Google Calendar UI, move a Marlo event by hand and confirm its new interval is no longer offered.
10. Retention/reap check: with the calendar debug script, insert an event carrying a cancelled booking's `marloBookingId` and the `marloAttemptId` of one of that row's retained entries, under a retired id. Request that window's availability — the interval is not offered — and on the next request confirm the event is gone and exactly that entry was retired.
11. ETag check: patch a live Marlo event with a stale `If-Match` and expect 412.

## Agent OS

- Work orders: copy `docs/PLAN-TEMPLATE.md` to `PLAN.md`, review with the VP of Product, then `agent-os dispatch PLAN.md`.
- `PROOF_CMD` for this repo: `npm test`
- Kill switch: label a PR `hold`.
- Rules for every seat: `AGENTS.md`.
- `lib/api/` is the only module that knows the backend routes; components never call `fetch`. Handoff §7 vs repo differences are logged in `lib/api/DIVERGENCES.md`.
- Brand assets come from the in-repo handoff (`handoff/` is the design source of truth; never edit it in an implementation PR): `copy/en.json`, `app/tokens/marlo.css`, and the inline SVG `Logo` in `app/components/Logo.tsx`.
