> Supersedes the completed BOOK-core PLAN (shipped @ `8148821`). That slice is done: public `POST /api/event-types/:slug/bookings`, in-memory confirmed bookings, mocked `CalendarProvider.createEvent`, slot re-validation, and race-safe 409 on double-create. This work order is the next v1 slice only — **invitee reschedule + cancel**.

# PLAN — Booking lifecycle: invitee reschedule + cancel

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder continuous go + VP Product, 19 Sep 2026 ET) — Founder said keep going after the booking-create slice.

## Goal

An invitee on `marlo-scheduling` can **reschedule** a confirmed one-on-one booking to a new available slot and **cancel** it with a reason. Reschedule re-validates the new start against the shipped slot engine (`listAvailableTimes` = weekly hours minus `CalendarProvider.freeBusy` minus other confirmed bookings) and patches the mocked calendar event. Cancel marks the booking `cancelled` and deletes the mocked calendar event. Old reminder jobs are canceled conceptually (an in-memory stub is enough). Concurrent reschedules onto the same taken slot are race-safe: one success, the other HTTP **409**. After this ships, BOOK lifecycle (create + reschedule + cancel) exists without host request-reschedule UI polish, mail, group events, or payments.

## Non-goals

- Host request-reschedule UI polish (no host “propose a new time” flow or host booking UI work)
- Workflows / Gmail send (or any outbound email / confirmation / reminder delivery)
- Group, collective, or round-robin event types (one-on-one only)
- Payments, deposits, or paid event types
- Chrome extension, InboxSDK, embeds, or webhooks
- Date-specific overrides, buffers, minimum notice, or custom slot increments
- Outlook / Microsoft 365 calendar
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)
- Live Google Calendar writes (or live OAuth) required in CI — mock `updateEvent` / `deleteEvent`; keep the existing freeBusy fixture and `createEvent` mock

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, or live-Google observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | An invitee can **reschedule** a confirmed 1:1 booking to a new start that `listAvailableTimes` currently returns. The booking stays `confirmed` with updated ISO `start`/`end`. The old start is free again; the new start is omitted from later available times. Empty/invalid start is rejected. Unknown booking → not found. A cancelled booking cannot be rescheduled. `resetBookings()` still clears state. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests composing booking stub + slot engine + fixture provider |
| AC-2 | `CalendarProvider` exposes **`updateEvent` (patch)** and **`deleteEvent`**. The fixture/mock adapter records both and never calls live Google. Successful reschedule **calls** `updateEvent` on the existing `calendarEventId` with the new start/end. Successful cancel **calls** `deleteEvent`. Existing `freeBusy` + `createEvent` fixture behavior is unchanged. | Solely `PROOF_CMD` (`npm test`) — unit tests against the mock adapter; assert patch on reschedule and delete on cancel |
| AC-3 | Reschedule to a start that is busy (fixture), already taken by another confirmed booking, or outside weekly hours is a **conflict (409)**. After reschedule or cancel, **old reminder jobs are canceled conceptually** via an in-memory stub (`cancelReminderJobs` or equivalent; `resetReminderJobs()` for tests). No real Inngest/queue required. | Solely `PROOF_CMD` (`npm test`) — conflict cases + stub recorded a cancel for that booking id on both reschedule and cancel |
| AC-4 | **Reschedule race/conflict:** two overlapping attempts to claim the **same** remaining available slot (two confirmed bookings rescheduling onto it, or one reschedule + one create) yield exactly **one** success and **one** HTTP 409. No two confirmed bookings share that host slot. Serialization is required (lock around check+write), not a naive check-then-act. | Solely `PROOF_CMD` (`npm test`) — concurrent `Promise.all` (or equivalent); assert one success + one 409 and a single confirmed occupant of the target start |
| AC-5 | Invitee can **cancel** a confirmed booking with a **non-empty reason**. Status becomes `cancelled`; the cancelled booking does not occupy a slot (old start returns to available times). Missing/empty reason → 400. Unknown booking → 404. `POST /api/bookings/:id/reschedule` and `POST /api/bookings/:id/cancel` are public (no session). Tests call the handlers directly (no live server, no live Google). Existing `POST /api/event-types/:slug/bookings`, `GET /api/event-types/:slug/available-times`, `/`, and `/api/health` stay public. | Solely `PROOF_CMD` (`npm test`) — handler unit tests for cancel status + public-path assertions |

## Builder

BUILDER: claude — extend the in-memory booking stub + provider mock + App Router POSTs + the existing slot lock fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Extend `lib/calendar/provider.ts` with `updateEvent({ calendarId, eventId, start, end, summary, attendees })` returning `{ id }` and `deleteEvent({ calendarId, eventId })`. Keep `freeBusy` and `createEvent`. Extend `createFixtureCalendarProvider` so it records patched and deleted events in memory and **never** calls live Google. Update existing test doubles that implement `CalendarProvider` to include the new methods (no-ops or delegate to the fixture).
2. Extend `lib/booking/booking.ts`: booking `status` is `"confirmed" | "cancelled"`. Add optional `cancelReason` on cancelled rows. `listConfirmedBookingsForHost` / `hostBookingsAsBusy` must **omit cancelled** bookings so a cancelled (or vacated) slot is bookable again. Keep `resetBookings()`.
3. Add `rescheduleBooking` (name may vary) that, **under a per-(hostId, newStart) lock** (reuse the existing slot mutex): (a) load the booking (404 if missing; 400 if not confirmed), (b) load event type + bound schedule, (c) ask `listAvailableTimes` for a range covering the new start…start+duration with `extraBusy` = other confirmed host bookings **excluding this booking’s current window**, (d) if the new start is not listed → `BookingConflictError` 409, (e) `updateEvent` on the existing `calendarEventId`, (f) persist the new `start`/`end`, (g) cancel old reminder jobs via the stub. Do not require Neon/Prisma.
4. Add `cancelBooking` (name may vary): require a trimmed non-empty `reason` (400 if missing). 404 if unknown; 400 if not confirmed. Set `status: "cancelled"` + `cancelReason`. Call `deleteEvent`. Cancel reminder jobs via the stub. Cancelled rows remain readable so AC-5 can assert status.
5. Add an in-memory reminder stub (`lib/booking/reminders.ts` or equivalent): `cancelReminderJobs(bookingId)` records the id; `listCancelledReminderJobs()` / `resetReminderJobs()` for tests. Invoked on both reschedule and cancel. No Inngest, no Gmail, no real job runner.
6. Add public handlers: `POST app/api/bookings/[id]/reschedule/route.ts` body `{ start }` and `POST app/api/bookings/[id]/cancel/route.ts` body `{ reason }`. Map the existing booking errors to 400/404/409. Compose stubs + mocked `CalendarProvider` (injectable, default fixture) so CI never writes live Google. Wire `calendarId` from the calendar-connection stub when present, else `"primary"`.
7. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit`. Reuse seeded one-on-one slugs, Sunday 2026-09-20 UTC windows, and `tests/fixtures/google-freebusy.json` (busy `14:00–15:00` and `18:30–19:00`). AC-4 must overlap in flight (delay `freeBusy` like the create-race test). Suggested free starts: `2026-09-20T09:00:00.000Z`, `09:30`, `10:00`. Update `package.json` `test:unit` to include the new files. Do not change `PROOF_CMD`; do not edit `.github/`.
8. Auth stubs: reschedule and cancel POSTs are public (invitee-facing). Do not require a session. If an AC cannot be observed without live Google, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; this slice does not reopen those decisions or add a real DB. Reminder cancel is a stub, not a live Inngest function.
- Founder go continuous after booking-create (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen. It supersedes `8148821`'s completed BOOK-core PLAN.
- Existing event types, schedules, `listAvailableTimes`, `bookAvailableSlot`, slot locks, `CalendarProvider.freeBusy` / `createEvent`, and `createFixtureCalendarProvider` are the source of truth (`lib/availability/*`, `lib/booking/booking.ts`, `lib/calendar/*`).
- Spec race spirit matches BOOK-core AC-4: overlapping in-flight writes, not only sequential “reschedule then reschedule again”.
- Risk: a live Google `events.patch` / `events.delete` would fail `proof` — default handlers to the mock provider; inject a mock in tests.
- Risk: Node is single-threaded but async interleaving still races — AC-4 fails unless check+write is serialized on the **target** slot key (and create already serializes on that same key).
- Risk: forgetting to exclude the current booking from `extraBusy` would make every reschedule look like a conflict with itself.
- Risk: leaving cancelled bookings in `hostBookingsAsBusy` would violate AC-5 (slot must free).

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing OAuth/availability/BOOK-core/scaffold checks (home placeholder, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + createEvent fixture, schedule/event-type stubs, slot engine, available-times GET, booking create + 409 race, README env names). No manual or visual checks for this slice. No live Google.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
