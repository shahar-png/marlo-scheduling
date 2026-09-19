> Supersedes the completed notification-stubs PLAN (shipped @ `be3a756`, PLAN PR #11 @ `3de2754`). That slice is done: event-type `notificationMode`, pluggable `EmailProvider` mock, calendar-invite vs email attendees, and `notification_log` on create/reschedule/cancel. This work order is the next v1 slice only — **one-off meeting windows + single-use scheduling links (OFF)**.

# PLAN — One-off meetings + single-use links (OFF)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder continuous go + VP Product, 19 Sep 2026 ET) — Founder said keep going after the notification-stubs slice.

## Goal

Hosts on `marlo-scheduling` can create **one-off meeting windows** (date-specific hours in an IANA timezone, not weekly recurrence) and **single-use scheduling links** (a unique token bound to an existing one-on-one event type **or** a one-off meeting). A guest books through the unused token; the first successful booking **consumes** the link. A second use of that token is HTTP **410**. After this ships, the product can offer a one-time booking URL and a date-specific window without polls, routing forms, a Chrome extension, or live email.

## Non-goals

- Polls / group voting (when-to-meet)
- Routing forms or intake questionnaires
- Chrome extension, InboxSDK, embeds, or webhooks
- Live email / real Gmail send (keep the existing `EmailProvider` mock + `notification_log`)
- Group, collective, or round-robin event types (one-on-one only)
- Payments, deposits, or paid event types
- Date-specific overrides on **weekly** schedules, buffers, minimum notice, or custom slot increments
- Outlook / Microsoft 365 calendar
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)
- Live Google Calendar writes (or live OAuth) required in CI — keep mocked `createEvent` / `updateEvent` / `deleteEvent` and the freeBusy fixture

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, live-Gmail, or live-Google observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | A one-off meeting stub exists: a host can create and read a meeting with `hostId`, `name`, `durationMinutes`, an IANA `timezone`, and date-specific `windows` (`date` as `YYYY-MM-DD`, `start`/`end` as `HH:MM` local to that timezone). Empty timezone, empty windows, invalid `date`, or `start >= end` are rejected. `resetOneOffMeetings()` for tests. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/reject (in-memory is fine) |
| AC-2 | A single-use scheduling-link stub exists: a host can create and read an **unused** link with a unique `token`, bound to **exactly one** of `eventTypeId` (existing one-on-one) or `oneOffMeetingId` (existing one-off). Missing/unknown target, blank token, or duplicate token are rejected. Status is `unused`. `resetSingleUseLinks()` / `getSingleUseLinkByToken()` for tests. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/reject |
| AC-3 | A slot helper (name may vary: extend `listAvailableTimes` or add `listOneOffAvailableTimes`) given a one-off meeting + `[timeMin, timeMax]` + a `CalendarProvider` returns duration-aligned ISO-8601 start times that lie entirely inside the one-off windows (interpreted in the meeting timezone). With the existing freeBusy fixture, overlapping busy windows are omitted. No live Google. | Solely `PROOF_CMD` (`npm test`) — unit test with a mock provider returning `[]` **and** a fixture test against `createFixtureCalendarProvider` |
| AC-4 | Booking through an **unused** single-use token succeeds: confirmed booking via the existing `bookAvailableSlot` / `CalendarProvider.createEvent` mock (weekly hours for an event-type target; one-off windows for a one-off target), then the link status becomes `consumed` and stores `bookingId`. Failed / 409 slot conflicts do **not** consume the link. `resetSingleUseLinks()` still clears state. | Solely `PROOF_CMD` (`npm test`) — unit tests for create + consume; assert status `consumed` and that a 409 leaves the link `unused` |
| AC-5 | A second booking (or available-times GET) through a **consumed** token is HTTP **410**. `POST /api/links/:token/bookings` is public (invitee, no session). Success is 201 + a booking payload; unknown token → 404; missing/invalid body → 400; consumed → 410. Tests call the route handler directly (no live server, no live Gmail/Google). Existing `/`, `/api/health`, event-type available-times GET, and booking create/reschedule/cancel stay public. | Solely `PROOF_CMD` (`npm test`) — handler unit tests covering create + consume + reuse rejection (410) |

## Builder

BUILDER: claude — in-memory stubs + a small slot-window extension + App Router token handlers + consume-on-success fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Add `lib/availability/one-off.ts` — in-memory one-off meeting stub (same pattern as `lib/availability/schedule.ts`). Fields: `id`, `hostId`, `name`, `durationMinutes`, `timezone`, `windows: { date, start, end }[]`. Validate IANA timezone (reuse the schedule stub’s check), `YYYY-MM-DD`, `HH:MM`, and `start < end`. `resetOneOffMeetings()` / `getOneOffMeeting()`. Do not require Neon/Prisma.
2. Add `lib/availability/single-use-link.ts` — in-memory unused-link stub. Fields: `id`, `token`, `hostId`, `status: "unused" | "consumed"`, exactly one of `eventTypeId` | `oneOffMeetingId`, optional `bookingId`. Generate a token when omitted; reject blank/duplicate tokens. Resolve the target (`getEventType` / `getOneOffMeeting`) at create time. `resetSingleUseLinks()` / `getSingleUseLinkByToken()`.
3. Extend `lib/availability/slots.ts` so one-off windows expand to UTC instants (date + local `HH:MM` in the meeting timezone) and feed the same duration-aligned, busy-subtracting loop as weekly hours. Keep weekly `listAvailableTimes` unchanged for existing event types. Wire `calendarId` from the calendar-connection stub when present, else `"primary"`.
4. Add `bookSingleUseLink` (name may vary) in `lib/booking/booking.ts` (or a sibling): **under a per-token lock**, load the link; consumed → error mapped to 410; unknown → 404; otherwise resolve availability (event-type schedule **or** one-off windows), call the existing slot check + `createEvent` + `createBooking` + notification dispatch, then mark the link `consumed` with `bookingId`. A slot conflict / validation failure must leave the link `unused`. Reuse `getBookingCalendarProvider()` / `getBookingEmailProvider()`.
5. Add `GET app/api/links/[token]/available-times/route.ts` and `POST app/api/links/[token]/bookings/route.ts`. Available-times query params: `timeMin`, `timeMax` (ISO). Bookings JSON body: `{ start, invitee: { name, email } }`. 410 on consumed; 404 unknown token; 400 missing range/body; 409 slot conflict; 201 on create. Compose stubs + fixture/mock providers so CI never calls live Google or Gmail. Public — no session.
6. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit`. Tests **must** cover create + consume + reuse rejection. Reuse Sunday **2026-09-20** UTC windows that cover the fixture busy `14:00–15:00` and `18:30–19:00` (e.g. one-off `date: "2026-09-20"`, `09:00–20:00` in `UTC`). Update `package.json` `test:unit` to include the new files. Do not change `PROOF_CMD`; do not edit `.github/`.
7. Auth stubs: link GET/POST are public (guest-facing). Do not require a session. Host UI for minting links is optional and not an AC. If an AC cannot be observed without live Gmail/Google, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; this slice does not reopen those decisions or add a real DB. One-off meetings and single-use links are stubs, not Neon rows.
- Founder go continuous after notification stubs (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen. It supersedes `be3a756` / PR #11’s completed notification-stubs PLAN.
- Existing event types, weekly schedules, bookings, slot locks, `notification_log`, `CalendarProvider`, and `createFixtureCalendarProvider` remain the source of truth for weekly 1:1 booking (`lib/availability/*`, `lib/booking/*`, `lib/calendar/*`, `lib/notify/*`).
- Risk: timezone math is easy to get wrong — pin AC-3 tests to `UTC` (or one explicit IANA zone with known offsets) so `npm test` is deterministic in CI.
- Risk: consuming the link before the slot check succeeds would make a 409 permanently kill the URL (AC-4). Consume **after** a confirmed booking only.
- Risk: two in-flight POSTs on the same unused token could both succeed without a per-token lock — serialize consume + book on the token (same Promise-chain pattern as the slot lock).
- Risk: a live Gmail or Google write would fail `proof` — default handlers to mocks; inject mocks in tests.
- Risk: changing `PROOF_CMD` or `.github/` is out of scope.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing OAuth/availability/BOOK-core/BOOK-lifecycle/notification/scaffold checks (home placeholder, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + create/patch/delete fixture, schedule/event-type stubs, slot engine, available-times GET, booking create/reschedule/cancel + 409 race, notificationMode + EmailProvider mock + notification_log, README env names). No manual or visual checks for this slice. No live Gmail. No live Google.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
