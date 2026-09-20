# `lib/api` — handoff §7 vs repo divergences

The FE handoff (`handoff/README.md` §7) describes `/public/...` routes and
response shapes that this repository does not implement. `lib/api` is the only
module that knows the repo's real routes and JSON; components never `fetch`.
Every mismatch is logged here so the UI-facing types stay stable when the
backend catches up.

## Paths

| Handoff §7 | Repo (actual) | Adapter |
|---|---|---|
| `GET /public/event_types/{id}/slots?month=&timezone=` | `GET /api/event-types/:slug/available-times?timeMin&timeMax` | `getSlots({ slug, timeMin, timeMax, now })` builds the month window client-side and clamps `timeMin` to `now` |
| `POST /public/bookings` | `POST /api/event-types/:slug/bookings` | `createBooking({ slug, start, invitee, now })` — the event type is addressed by slug in the path, not by `event_type_id` in the body |
| `GET /public/bookings/{token}` | `GET /api/bookings/:id` (thin adapter added this slice) | `getBooking(token)`; the confirmation Server page reads the row through `lib/api/server.ts` without HTTP |
| `POST /public/bookings/{token}/reschedule`, `.../cancel` | `POST /api/bookings/:id/reschedule`, `.../cancel` | Not wired this slice (reschedule/cancel UI is a non-goal) |

There are **no** `/public/...` routes in this repo. Do not invent them.

## Shapes

| Handoff §7 | Repo (actual) | Adapter |
|---|---|---|
| `{ month, timezone, days: { "YYYY-MM-DD": [{ start, spots_remaining? }] } }` | `{ times: string[] }` (1:1 / collective) or `{ times: [{ start, spots_remaining }] }` (group) | Normalised to `{ times: { start, spotsRemaining? }[] }`; grouping by local date happens in the form at render time |
| Booking identified by `token` | Booking identified by `id` | `id` ↦ `token`; `/b/{token}` is `/b/{booking.id}`. No second token column this slice |
| `201 { booking: { token, start_at, end_at, status, … }, invitee, calendar_links }` | `201 { booking: { id, start, end, status, invitee, … } }` | Mapped to `{ ok: true, booking: { token, start, end, status, invitee } }` |
| `409 { type, code: "slot_unavailable" \| "session_full", detail }` | `409 { error: "slot_unavailable" \| "session_full" }` | `error` ↦ typed `code`; each 409 maps to its **own** code (`slot_unavailable` vs `session_full`). An unrecognised 409 body surfaces as `code: "unknown"` — it is never coerced to `slot_unavailable` |
| `422 { code: "validation_error", errors: [...] }` | `400 { error: string }` | Surfaced as `{ ok: false, code: "unknown", status: 400, error }`; the form shows `details.errors.generic` |
| `timezone`, `guests`, `answers`, `phone`, `utm`, `captcha_token` in the POST body | Not accepted | Not sent |

## Past-slot cutoff is client-side

The backend fixtures are historical (`2026-09-20T09:00:00.000Z` and similar
starts in the BOOK-core tests) and the existing route handlers, `lib/booking`,
and `lib/availability` must keep accepting them unchanged. The cutoff therefore
lives in `lib/api` and the booking UI only, against an injectable clock (`now`
is a function, never a captured timestamp):

- `getSlots` clamps `timeMin = max(timeMin, now())` at request time and filters
  the returned `times` to `start >= now()` read **again** when the response
  resolves, so a slow response never offers a start that elapsed in flight.
- If the clamped `timeMin >= timeMax` (the whole window has elapsed), `getSlots`
  returns `{ times: [] }` **without** calling the backend — the slot engine
  never receives an inverted range.
- `createBooking` rejects `start < now()` before touching the backend and
  returns the same `{ ok: false, code: "slot_unavailable" }` result as a 409,
  so the UI has one recovery path.

## Missing backend idempotency (BOOK-FE-08)

Handoff §6.2 / §7 send an `idempotency_key` with `POST /public/bookings` (a
UUID minted when the details step opens and reused on retry). The repo
`POST /api/event-types/:slug/bookings` accepts **no** idempotency key — neither
a body field nor an `Idempotency-Key` header — and the existing `lib/booking`
host/start lock only *serializes* concurrent writes; it does not deduplicate
the same invitee. A group event type with `capacity > 1` will hold two seats
for one email if two requests arrive.

Duplicate protection in this slice is therefore the **client in-flight guard
only** (`BookingForm` — a synchronous latch set before the first `await`, the
submit control disabled while pending, and the latch held through navigation
on success). That guard covers a double-click or repeated Enter. It does
**not** make an ambiguous network retry safe: if the request was sent and the
response was lost, re-submitting may create a second booking. For that reason:

- the client never auto-retries `createBooking` (one call per submit gesture,
  no retry loop on network error — the error is surfaced, the guard is
  released, and the invitee decides);
- `lib/api` does **not** fake an idempotency key (no client-side dedupe cache,
  no synthetic key the backend would ignore);
- a server-side `Idempotency-Key` on the bookings POST is a **deferred backend
  item**, not implemented here (backend semantics are a non-goal this slice).
