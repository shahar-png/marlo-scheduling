# `lib/api` — handoff §7 vs repo divergences

The FE handoff (`handoff/README.md` §7) describes `/public/...` routes and
response shapes that this repository does not implement. `lib/api` is the only
module that knows the repo's real routes and JSON; components never `fetch`.
Every mismatch is logged here so the UI-facing types stay stable when the
backend catches up.

## Paths

| Handoff §7 | Repo (actual) | Adapter |
|---|---|---|
| `GET /public/event_types/{id}/slots?month=&timezone=` | `GET /api/event-types/:slug/available-times?timeMin&timeMax` | `getSlots({ slug, timeMin, timeMax, durationMinutes, now })` — the form builds the month window in the displayed time zone, the adapter clamps `timeMin` to `now` and widens the outgoing `timeMax` by the duration (see below) |
| `POST /public/bookings` | `POST /api/event-types/:slug/bookings` | `createBooking({ slug, start, invitee, now })` — the event type is addressed by slug in the path, not by `event_type_id` in the body |
| `GET /public/bookings/{token}` | `GET /api/bookings/:id` (thin adapter added this slice) | `getBooking(token)`; the confirmation Server page reads the row through `lib/api/server.ts` without HTTP |
| `POST /public/bookings/{token}/reschedule`, `.../cancel` | `POST /api/bookings/:id/reschedule`, `.../cancel` | Not wired this slice (reschedule/cancel UI is a non-goal) |

There are **no** `/public/...` routes in this repo. Do not invent them.

## Shapes

| Handoff §7 | Repo (actual) | Adapter |
|---|---|---|
| `{ month, timezone, days: { "YYYY-MM-DD": [{ start, spots_remaining? }] } }` | `{ times: string[] }` (1:1 / collective) or `{ times: [{ start, spots_remaining }] }` (group) | Normalised to `{ times: { start, spotsRemaining? }[] }`; grouping by local date happens in the form at render time |
| Booking identified by `token` | Booking identified by `id` | `id` ↦ `token`; `/b/{token}` is `/b/{booking.id}`. No second token column this slice |
| `201 { booking: { token, start_at, end_at, status, … }, invitee, calendar_links }` | `201 { booking: { id, start, end, status, eventTypeId, invitee, … } }` | Mapped to `{ ok: true, booking: { token, start, end, status, eventTypeId, invitee } }`; `status` is preserved so the confirmation page can branch on it (`confirmed` vs `cancelled`) |
| `GET /public/bookings/{token}` → `event_type: { slug, … }` for a "book again" link | The row carries only `eventTypeId`; a one-off booking made through `POST /api/links/:token/bookings` has a **synthetic** event type (`eventTypeFromOneOff`, `slug` `one-off-{id}`) that is never inserted into the event-type store | `lib/api/server.ts` resolves `eventTypeId` through the existing `getEventType`; only a store-backed event type yields `bookAgainHref` (`/demo/{slug}`), otherwise it is `undefined` and the cancelled shell omits `cancel.bookAgain` (no guessed `/one-off-…` path, no `#`) |
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

## Slot `timeMax` bounds the meeting end, not the start (BOOK-FE-12)

Handoff §7 `/public/event_types/.../slots?from&to` — and the UI's month window
`[timeMin, timeMax)` built in the displayed time zone — is a range of **start**
instants: every start inside it is offered. The repo
`GET /api/event-types/:slug/available-times?timeMin&timeMax`, via
`lib/availability/slots.ts` (`if (start < timeMin || end > timeMax) continue;`),
excludes any slot whose **end** is after `timeMax`.

Example (`Asia/Kathmandu`, UTC+5:45): local September ends at
`2026-09-30T18:15:00.000Z`. The demo's 30-min `2026-09-30T18:00:00.000Z` start is
Sep 30 23:45 local — inside September — but its end `18:30Z` exceeds the bound,
so the raw handler drops it from September; October drops it too because its
start precedes October's `timeMin`. A bookable slot would be offered by nobody.

The adapter absorbs this, backend untouched:

- `getSlots` computes `backendTimeMax = timeMax + durationMinutes * 60_000` and
  sends that widened `timeMax` to the handler (`durationMinutes` is the event
  type's duration, passed by the form from the Server page's event meta);
- on resolve it keeps only returned starts with `start >= now()` **and**
  `start < timeMax` (the **original** logical bound), so the widening never
  leaks the next month's first starts into the current month;
- the clamp to `now` and the empty-range guard both compare against the
  **original** `timeMax` — the widening is applied only to a query that is
  actually sent, and never un-elapses a window that is over.

The widening is adapter-only; the slot engine's `end > timeMax` rule is not
changed (BOOK-core / GRP / COL tests depend on it). The form's out-of-month day
filter (a start whose local date is outside the displayed month is not
rendered) is a second, independent guard.

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

## Public paths are constructed, never interpolated (BOOK-FE-19)

Handoff §7 addresses event types by a URL-safe slug. The repo's
`createEventType` (`lib/availability/event-type.ts`) accepts **any non-empty
trimmed slug** and stores it unchanged — `intro#follow-up`, `intro?x=1`, `a/b`
are all valid store slugs — and that contract is untouched (BOOK-core / OFF /
GRP / COL tests seed through it). Interpolating such a slug into a path
(`/demo/${slug}`, `/api/event-types/${slug}/…`) yields a URL that is split on
the delimiter and resolves to a **different or missing** event.

`lib/api/public-path.ts` is therefore the single place a slug is joined into a
path: `encodePathSegment` percent-encodes representable segments
(`café 30` → `caf%C3%A9%2030`) and **rejects** empty, `.`, `..`, `/`, `\`,
`?`, `#`, control characters, and anything that does not round-trip through
`encodeURIComponent` / `decodeURIComponent`; `publicBookingPath(host, event)`
joins two accepted segments or returns `null`. Consumers:

- the Server booking page's canonical `redirect()` — `null` ⇒ the
  `states.notFound` shell, no redirect;
- the confirmation adapter's `bookAgainHref` — `null` ⇒ no link;
- the client helpers' request paths — a rejected slug ⇒ `getSlots` returns
  empty availability and `createBooking` returns the `unknown` code, with
  **zero** backend calls.

Rejecting rather than encoding `#` / `?` / `/` is deliberate: those are the
characters a `Location` header, a proxy, a router, or Next's param decoder is
most likely to decode once and re-split. A slug that needs them simply has no
public URL this slice.
