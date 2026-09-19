> Supersedes the completed WH PLAN (shipped @ `0f07f2f`, PLAN PR #15 @ `08e3db4`). That slice is done: webhook subscriptions, HMAC-SHA256 `Marlo-Webhook-Signature`, `booking.created` / `canceled` / `rescheduled` emit, delivery log + retry stub. This work order is the next v1 slice only — **group event type + capacity (GRP)**.

# PLAN — Group event type + capacity (GRP)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder continuous go + VP Product, 19 Sep 2026 ET) — Founder said keep going after the WH slice.

## Goal

Hosts on `marlo-scheduling` can define a **group** event type (`kind: "group"`) with **`maxInvitees`** (`max_invitees`). Guests querying **available_times** for that type see each open start plus **`spots_remaining`**. Booking create admits invitees until the session is full; a **concurrent last-spot race** yields exactly one confirmed success and one **`session_full`** (409) — spec AC-05 spirit. After this ships, group sessions have capacity without collective all-hosts-free, round robin, or managed events.

## Non-goals

- Collective event types (all-hosts-free) — separate slice
- Round-robin event types
- Managed events (host-managed guest lists / admin seat assignment)
- Payments, deposits, or paid event types
- Changing 1:1 `GET /api/event-types/:slug/available-times` response shape (`{ times: string[] }` stays)
- New reschedule/cancel semantics (existing BOOK-lifecycle paths stay; cancelled seats stop counting toward capacity because only `confirmed` rows count)
- Zapier, live internet HTTP, `routing_form` events
- Chrome extension, InboxSDK, embeds
- Live email / real Gmail send (keep the existing `EmailProvider` mock + `notification_log`)
- Outlook / Microsoft 365 calendar
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)
- Live Google Calendar writes (or live OAuth) required in CI — keep mocked `createEvent` / `updateEvent` / `deleteEvent` and the freeBusy fixture
- Neon/Prisma (in-memory stubs only)

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, live-Gmail, live-Google, or live-internet observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | Event-type stub accepts `kind: "group"` with a required positive integer `maxInvitees`. Create/read returns `kind: "group"` and that capacity. Missing, zero, or non-integer `maxInvitees` on a group type is rejected. `collective` / `round_robin` stay rejected. Existing `one_on_one` create/read is unchanged (`maxInvitees` not required). `resetEventTypes()` for tests. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/reject (in-memory is fine) |
| AC-2 | For a group event type, available times include **`spots_remaining`** = `maxInvitees` minus confirmed bookings for that event type at that start. A start with `spots_remaining === 0` is omitted. Host 1:1 bookings and `CalendarProvider.freeBusy` busy windows still hide overlapping group starts. Sibling group bookings on the **same** event type decrement spots; they do **not** hide the start until full. 1:1 `listAvailableTimes` still returns `string[]`. | Solely `PROOF_CMD` (`npm test`) — unit tests composing group event type + schedule + fixture provider + booking stub |
| AC-3 | Booking create for a group type succeeds while seats remain (each invitee is a confirmed booking on that start). When the session is at capacity, create fails with HTTP **409** and error **`session_full`** (not `slot_unavailable`). A start that is outside weekly hours or blocked by host busy / fixture busy remains `slot_unavailable` (409). 1:1 create + `slot_unavailable` race stay unchanged. | Solely `PROOF_CMD` (`npm test`) — unit tests for under-capacity success, at-capacity `session_full`, and unchanged 1:1 conflict |
| AC-4 | **Last-spot race (spec AC-05 spirit):** two overlapping creates for the **last** remaining seat on the same group start yield exactly **one** confirmed success and **one** HTTP 409 `session_full`. No overfill (`confirmed` count ≤ `maxInvitees`). Serialization is required (lock around check+insert), not a naive check-then-act. Two concurrent creates while **two** seats remain may both succeed. | Solely `PROOF_CMD` (`npm test`) — concurrent `Promise.all` (or equivalent) of two last-seat creates; assert statuses `{201, 409}` / `{fulfilled, session_full}` and persisted count = capacity |
| AC-5 | `GET /api/event-types/:slug/available-times` for a **group** slug returns `{ times: { start, spots_remaining }[] }`. `POST /api/event-types/:slug/bookings` on that slug respects capacity (201 while seats remain; 409 `session_full` when full; last-spot concurrent POST is `{201, 409}`). Tests call handlers directly (no live server, no live Google). Existing 1:1 GET `{ times: string[] }`, `/`, and `/api/health` stay public. The superseded availability test that rejected `kind: "group"` is updated — that non-goal is retired for **group only**. | Solely `PROOF_CMD` (`npm test`) — handler unit tests + assert the old “reject group kind” assertion is gone |

## Builder

BUILDER: claude — extending the in-memory event-type stub + per-slot lock + capacity count + App Router GET/POST shape fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Extend `lib/availability/event-type.ts` — allow `kind: "group"` alongside `one_on_one`. Add optional `maxInvitees?: number` on `EventType` (required when `kind === "group"`; omit on 1:1). Reject missing / non-positive / non-integer `maxInvitees` for group. Keep rejecting `collective` and `round_robin` (and any other kind). `REJECTED_EVENT_TYPE_KINDS` becomes `['collective', 'round_robin']`. Do not require Neon/Prisma.
2. Extend `lib/booking/booking.ts` — `createBooking` / `bookAvailableSlot` accept group types. Count **confirmed** bookings for `(eventTypeId, start)` toward capacity. Under the existing per-`(hostId, start)` lock: (a) re-validate the start against `listAvailableTimes` using host busy that **excludes** this group event type’s own bookings (those are seats, not host-busy), (b) if the start is not listed → `slot_unavailable`, (c) if confirmed count ≥ `maxInvitees` → `session_full`, (d) otherwise `createEvent` + persist `confirmed` + existing notify/webhook hooks. `BookingConflictError` already maps to 409; pass `session_full` as the message.
3. Add `hostBookingsAsBusy(hostId, { excludeEventTypeId })` (name may vary) so group availability does not treat sibling seats as calendar busy. 1:1 callers keep passing all confirmed host bookings as `extraBusy` (a group session still occupies the host for 1:1).
4. Add `listAvailableTimesWithCapacity` (name may vary) in `lib/availability/slots.ts` (or a sibling) that maps free starts to `{ start, spots_remaining }` and omits `spots_remaining === 0`. 1:1 `listAvailableTimes(): Promise<string[]>` is unchanged.
5. Update `GET app/api/event-types/[slug]/available-times/route.ts`: if the slug is group, return `{ times: { start, spots_remaining }[] }`; if 1:1, keep `{ times: string[] }`. Update `POST .../bookings` only as needed to surface `session_full` (existing `BookingConflictError` → 409 is enough).
6. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit` (`tests/group.test.ts` + `tests/group-route.test.ts`). Reuse Sunday **2026-09-20** UTC slots (`09:00` / `09:30`) and `tests/fixtures/google-freebusy.json`. Update `tests/availability.test.ts` so it no longer expects `kind: "group"` to be rejected; keep rejecting `collective` / `round_robin`. Update `tests/booking.test.ts` so the “non-one-on-one” reject covers collective/round_robin, not group. Update `package.json` `test:unit` to include the new files. Do not change `PROOF_CMD`; do not edit `.github/`.
7. Auth stubs: group available-times GET and booking POST stay public (guest-facing). If an AC cannot be observed without live Google, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; this slice does not reopen those decisions or add a real DB. Event types and bookings stay stubs.
- Founder go continuous after WH (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen. It supersedes `0f07f2f` / PR #15’s completed WH PLAN.
- Existing schedules, 1:1 event types, `listAvailableTimes`, booking lock, `CalendarProvider`, and `createFixtureCalendarProvider` remain the source of truth for “is this start inside weekly hours and not host-busy?” (`lib/availability/*`, `lib/booking/*`, `lib/calendar/*`).
- Spec AC-05 spirit = last remaining seat, two in-flight creates: one winner, one `session_full`; not a sequential “book until full” only. Tests must overlap in flight.
- Risk: treating group seats as `hostBookingsAsBusy` would hide a start after the first invitee — exclude same-`eventTypeId` bookings from extraBusy for group listing/create.
- Risk: Node is single-threaded but async interleaving still races — AC-4 fails unless check+insert stays serialized on the slot key (reuse the existing lock).
- Risk: leaving the superseded “reject group kind” test in place would make a correct implementation fail `npm test` — that assertion must be retired in this slice (collective/RR remain rejected).
- Risk: changing the 1:1 `{ times: string[] }` JSON shape would break shipped AC-5 tests — branch the GET body on `kind`.
- Risk: a live Google write would fail `proof` — keep fixture/mock providers.
- Risk: adding collective all-hosts-free, round robin, or managed events would violate non-goals.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing OAuth/availability/BOOK-core/BOOK-lifecycle/notification/OFF/WH/scaffold checks (home placeholder, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + create/patch/delete fixture, schedule/event-type stubs, slot engine, available-times GET, booking create/reschedule/cancel + 409 race, notificationMode + EmailProvider mock + notification_log, one-off windows + single-use 410, webhook HMAC + lifecycle emit + retry stub, README env names). No manual or visual checks for this slice. No live Gmail. No live Google. No live internet HTTP.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
