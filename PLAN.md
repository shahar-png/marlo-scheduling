> Supersedes the completed availability PLAN (shipped @ `9123475`). That slice is done: weekly availability schedules, one-on-one event types, `listAvailableTimes`, and public `GET /api/event-types/:slug/available-times` against `CalendarProvider.freeBusy` fixtures. This work order is the next v1 slice only — **BOOK core**.

# PLAN — Public 1:1 booking create (BOOK core)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder continuous go + VP Product, 19 Sep 2026 ET) — Founder said keep going after the availability slice.

## Goal

An invitee on `marlo-scheduling` can **create a confirmed one-on-one booking** against an available slot for an existing event type. Create is public (no host session). The server re-validates the start against the shipped slot engine (`listAvailableTimes` = weekly hours minus `CalendarProvider.freeBusy` minus already-confirmed bookings) and writes a calendar event through a **mocked** `CalendarProvider.createEvent`. Concurrent creates for the same slot are race-safe: one confirmed success, the other HTTP **409**. After this ships, the product has BOOK core without payments, mail, or live Google writes in CI.

## Non-goals

- Group, collective, or round-robin event types (one-on-one only)
- Payments, deposits, or paid event types
- Sending mail via Gmail (or any outbound email / confirmation workflow)
- Chrome extension, InboxSDK, embeds, or webhooks
- Cancel / reschedule / host booking UI (create + conflict only)
- Date-specific overrides, buffers, minimum notice, or custom slot increments
- Outlook / Microsoft 365 calendar
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)
- Live Google Calendar writes (or live OAuth) required in CI — mock `createEvent`; keep the existing freeBusy fixture

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, or live-Google observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | A booking stub exists: create and read a **confirmed** 1:1 booking bound to an existing one-on-one event type, an ISO-8601 `start`, and invitee `name` + `email`. Empty name/email or a non-one-on-one event type are rejected. Status is `confirmed`. `resetBookings()` for tests. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/reject (in-memory is fine) |
| AC-2 | `CalendarProvider` exposes `createEvent`; a mock/fixture adapter records the event and returns an id. Booking create **calls** that mock. No live Google Calendar API. Existing `freeBusy` fixture behavior is unchanged. | Solely `PROOF_CMD` (`npm test`) — unit test against the mock adapter; assert create is invoked on a successful booking |
| AC-3 | Create succeeds only when `start` is currently returned by `listAvailableTimes` for that event type (weekly hours minus fixture busy minus already-confirmed bookings). After a confirmed booking, that start is omitted from available times. A start that is busy, already booked, or outside weekly hours is a conflict (409). Unknown slug → 404; missing/invalid body → 400. | Solely `PROOF_CMD` (`npm test`) — unit tests composing event-type + schedule + slot engine + fixture provider + booking stub |
| AC-4 | **Double-book race (spec AC-04 spirit):** two overlapping create attempts for the **same** available slot yield exactly **one** confirmed success and **one** HTTP 409. No two confirmed bookings share that host slot. Serialization is required (lock around check+insert), not a naive check-then-act. | Solely `PROOF_CMD` (`npm test`) — concurrent `Promise.all` (or equivalent) of two creates; assert statuses `{201, 409}` in either order and a single persisted booking |
| AC-5 | `POST /api/event-types/:slug/bookings` is public (invitee, no session). Tests call the route handler directly (no live server, no live Google). Success is 201 + a booking payload (`id`, `status: "confirmed"`, `start`, `end`, invitee). Conflict is 409. Existing `GET /api/event-types/:slug/available-times`, `/`, and `/api/health` stay public. The superseded availability test that asserted “no booking POST route” is updated — that non-goal is retired. | Solely `PROOF_CMD` (`npm test`) — handler unit tests + public-path assertions |

## Builder

BUILDER: claude — in-memory booking stub + provider mock + App Router POST + a race-safe lock fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Extend `lib/calendar/provider.ts` with `createEvent({ calendarId, start, end, summary, attendees })` returning `{ id }`. Keep `freeBusy`. Add a mock/fixture implementation (extend `createFixtureCalendarProvider` or a sibling factory) that records created events in memory and **never** calls live Google. CI must stay secret-free.
2. Add `lib/booking/booking.ts` — in-memory confirmed-booking stub (same pattern as `lib/availability/event-type.ts`). Fields: `id`, `eventTypeId`, `hostId`, `start`, `end`, `status: "confirmed"`, `invitee: { name, email }`, `calendarEventId`. `resetBookings()` for tests. Reject empty invitee fields. One-on-one only.
3. Add a race-safe `createBooking` (name may vary) that, **under a per-(hostId, start) lock**: (a) loads the event type + bound schedule, (b) asks `listAvailableTimes` for a range covering `start`…`start+duration` (provider = injectable, default fixture), (c) treats already-confirmed bookings as busy so a taken slot is not listed, (d) if `start` is not in that list → conflict, (e) otherwise `createEvent` then persist `confirmed`. Do not require Neon/Prisma; a mutex/`Promise` chain is enough for AC-4 in Node tests.
4. Add `POST app/api/event-types/[slug]/bookings/route.ts`. JSON body: `{ start, invitee: { name, email } }`. 201 on success; 400 missing/invalid; 404 unknown slug; 409 conflict (unavailable or lost race). Compose stubs + mocked `CalendarProvider` (injectable, default fixture) so CI never writes live Google. Public — no session. Wire `calendarId` from the calendar-connection stub when present, else `"primary"`.
5. Compose available times with bookings: `GET /api/event-types/:slug/available-times` (and/or `listAvailableTimes`) must omit starts covered by confirmed bookings so AC-3 is observable on the existing GET. Update `tests/available-times.test.ts` — remove the “no booking POST route” assertion from the superseded PLAN; keep public `/` + `/api/health` + available-times GET.
6. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit`. Reuse seeded one-on-one slugs, Sunday 2026-09-20 UTC windows, and `tests/fixtures/google-freebusy.json` (busy `14:00–15:00` and `18:30–19:00`). AC-4 must fire two concurrent handler or service calls at the same free start (e.g. `2026-09-20T09:00:00.000Z`). Update `package.json` `test:unit` to include the new files. Do not change `PROOF_CMD`; do not edit `.github/`.
7. Auth stubs: booking POST is public (invitee-facing). Do not require a session. If an AC cannot be observed without live Google, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; this slice does not reopen those decisions or add a real DB.
- Founder go continuous after availability (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen. It supersedes `9123475`'s completed availability PLAN.
- Existing event types, schedules, `listAvailableTimes`, `CalendarProvider.freeBusy`, and `createFixtureCalendarProvider` are the source of truth for “is this slot available?” (`lib/availability/*`, `lib/calendar/*`).
- Spec AC-04 spirit = double-book race: one winner, one 409; not a sequential “book then book again” only. Tests must overlap in flight.
- Risk: a live Google `events.insert` would fail `proof` — default the POST handler to the mock `createEvent`; inject a mock in tests.
- Risk: Node is single-threaded but async interleaving still races — AC-4 fails unless check+insert is serialized on the slot key.
- Risk: leaving the superseded “no booking POST” test in place would make a correct implementation fail `npm test` — that assertion must be retired in this slice.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing OAuth/availability/scaffold checks (home placeholder, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy fixture, schedule/event-type stubs, slot engine, available-times GET, README env names). No manual or visual checks for this slice. No live Google.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
