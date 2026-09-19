> Supersedes the completed GRP PLAN (shipped @ `1422ff4`, PLAN PR #17 @ `b7a65de`). That slice is done: `kind: "group"` + `maxInvitees`, `spots_remaining` on available_times, last-spot `session_full` race. This work order is the next v1 slice only — **collective event type (COL)**.

# PLAN — Collective event type (COL) — all hosts must be free

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder continuous go + VP Product, 19 Sep 2026 ET) — Founder said keep going after the GRP slice.

## Goal

Hosts on `marlo-scheduling` can define a **collective** event type (`kind: "collective"`) with **multiple hosts**. Guests querying **available_times** see a start only when **every** assigned host is free (intersection of weekly hours minus each host’s `CalendarProvider.freeBusy` and confirmed bookings). Booking create **assigns all hosts** — each becomes busy on that start. Busy-edge cases (one host busy hides the slot for everyone) are covered — spec AC-06 spirit. After this ships, panel-style meetings work without round robin, managed events, or payments.

## Non-goals

- Round-robin event types
- Managed events (host-managed guest lists / admin seat assignment)
- Payments, deposits, or paid event types
- Changing group `spots_remaining` / `session_full` semantics or 1:1 `{ times: string[] }` shape
- Per-host weekly schedules (collective reuses the event type’s one `availabilityScheduleId`; intersection is calendar + booking busy, not different weekday hours)
- New reschedule/cancel semantics (existing BOOK-lifecycle paths stay; a cancelled collective booking stops occupying hosts because only `confirmed` rows count)
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
| AC-1 | Event-type stub accepts `kind: "collective"` with a required `hostIds` array of **at least two** unique non-empty host ids. The organizer `hostId` must be included in `hostIds` (or is auto-included). Create/read returns `kind: "collective"` and that host list. Missing, empty, single-host, blank, or duplicate-only `hostIds` is rejected. `round_robin` stays rejected. Existing `one_on_one` and `group` create/read are unchanged (`hostIds` not required). `resetEventTypes()` for tests. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/reject (in-memory is fine) |
| AC-2 | For a collective event type, available times are the **intersection**: a start is listed only when it lies in the bound schedule **and** **no** assigned host is busy. A start is omitted if **any** host has `CalendarProvider.freeBusy` overlap (per that host’s destination calendar, else `"primary"`) **or** a confirmed booking overlap. 1:1 `listAvailableTimes` still returns `string[]`. Group `spots_remaining` is unchanged. | Solely `PROOF_CMD` (`npm test`) — unit tests composing collective event type + schedule + per-host fixture calendars + booking stub |
| AC-3 | Booking create for a collective type succeeds when all hosts are free. The persisted booking **assigns all hosts** (`hostIds` on the booking equals the event type’s hosts). After confirm, each assigned host is busy: that host’s 1:1 (and any other collective that includes them) omits the start. A start outside weekly hours or where **any** host is busy remains HTTP **409** `slot_unavailable`. Group `session_full` and 1:1 `slot_unavailable` stay unchanged. | Solely `PROOF_CMD` (`npm test`) — unit tests for all-hosts-free success, any-host-busy `slot_unavailable`, and persisted `hostIds` |
| AC-4 | **Busy-edge cases (spec AC-06 spirit):** Host A free + Host B calendar-busy → start omitted. Host A free + Host B confirmed booking → start omitted. Partial overlap on one host hides every slot that intersects that busy window. Both hosts free → start present. Fixture busy on Host A’s `primary` (Sunday 2026-09-20 `14:00–15:00`) hides that start even if Host B is free. Two overlapping creates for the same collective start yield exactly **one** confirmed success and **one** HTTP 409 `slot_unavailable`. No double-assign of the same hosts. Serialization is required (lock every assigned host’s `(hostId, start)`), not a naive check-then-act. | Solely `PROOF_CMD` (`npm test`) — per-host busy fixtures + `Promise.all` of two concurrent creates; assert `{fulfilled, slot_unavailable}` and one persisted confirmed row |
| AC-5 | `GET /api/event-types/:slug/available-times` for a **collective** slug returns `{ times: string[] }` of intersection starts (1:1 shape, not group `{ start, spots_remaining }`). `POST /api/event-types/:slug/bookings` on that slug assigns all hosts (201 + booking.`hostIds`) when all are free; 409 `slot_unavailable` when any host is busy. Tests call handlers directly (no live server, no live Google). Existing 1:1 GET `{ times: string[] }`, group GET shape, `/`, and `/api/health` stay public. The superseded tests that rejected `kind: "collective"` are updated — that non-goal is retired for **collective only**. | Solely `PROOF_CMD` (`npm test`) — handler unit tests + assert the old “reject collective kind” assertion is gone |

## Builder

BUILDER: claude — extending the in-memory event-type stub + multi-host freeBusy union + per-host slot locks + App Router GET/POST fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Extend `lib/availability/event-type.ts` — allow `kind: "collective"` alongside `one_on_one` and `group`. Add optional `hostIds?: string[]` on `EventType` (required when `kind === "collective"`; omit on 1:1 / group). Normalize: trim, drop blanks, dedupe, require ≥ 2 unique ids, ensure `hostId` is in the list (prepend if missing). Reject missing / empty / single-host / blank-only `hostIds` for collective. Keep rejecting `round_robin` (and any other kind). `REJECTED_EVENT_TYPE_KINDS` becomes `['round_robin']`. Do not require Neon/Prisma.
2. Extend `lib/booking/booking.ts` — `Booking` gains optional `hostIds?: string[]`. `createBooking` / `bookAvailableSlot` accept collective types. Persist `hostIds` from the event type. `listConfirmedBookingsForHost(hostId)` includes a confirmed booking when `booking.hostId === hostId` **or** `booking.hostIds` contains that host (so a collective booking occupies every assigned host). 1:1 and group rows stay single-`hostId`.
3. Add `listHostIds(eventType)` / `busyWindowsForHosts(hostIds, { provider, timeMin, timeMax, extraBusy })` (names may vary). For each host: `freeBusy` on `getHostCalendarConnection(hostId)?.destinationCalendarId ?? "primary"`, plus `hostBookingsAsBusy(hostId)`. Union those windows. Collective `listAvailableTimes` uses the event type’s one schedule and this **union** as busy (intersection of free time). 1:1 / group callers keep today’s single-host extraBusy.
4. Slot lock: acquire the existing per-`(hostId, start)` lock for **every** assigned host (stable sorted order) before check+insert, so a 1:1 on host B cannot race a collective that includes B. After the lock: re-validate the start against the collective intersection; if missing → `slot_unavailable`; else `createEvent` (organizer calendar, existing notify/webhook hooks) + persist `confirmed` with `hostIds`.
5. Update `GET app/api/event-types/[slug]/available-times/route.ts`: if the slug is collective, compose multi-host busy and return `{ times: string[] }`. Update `POST .../bookings` only as needed so the persisted booking includes `hostIds` (existing `BookingConflictError` → 409 is enough).
6. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit` (`tests/collective.test.ts` + `tests/collective-route.test.ts`). Use Sunday **2026-09-20** UTC slots (`09:00` / `09:30` / `14:00`) and `tests/fixtures/google-freebusy.json` for Host A `primary`. Give Host B a **distinct** `calendarId` (and/or `extraBusy`) so one-host-busy is observable. Update `tests/availability.test.ts` and `tests/group.test.ts` so they no longer expect `kind: "collective"` to be rejected; keep rejecting `round_robin`. Update `tests/booking.test.ts` so the “non-one-on-one” reject covers `round_robin`, not collective. Update `package.json` `test:unit` to include the new files. Do not change `PROOF_CMD`; do not edit `.github/`.
7. Auth stubs: collective available-times GET and booking POST stay public (guest-facing). If an AC cannot be observed without live Google, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; this slice does not reopen those decisions or add a real DB. Event types and bookings stay stubs.
- Founder go continuous after GRP (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen. It supersedes `1422ff4` / PR #17’s completed GRP PLAN.
- Existing schedules, 1:1 / group event types, `listAvailableTimes`, booking lock, `CalendarProvider`, and `createFixtureCalendarProvider` remain the source of truth for “is this start inside weekly hours?” (`lib/availability/*`, `lib/booking/*`, `lib/calendar/*`). Collective adds a multi-host busy union on top.
- Spec AC-06 spirit = one assigned host busy (calendar **or** confirmed booking, including partial overlap) hides the start for everyone; both-free shows it; concurrent double-book of the same collective start is one winner. Tests must use distinct per-host busy and overlap in flight.
- Risk: querying only the organizer’s `primary` calendar would make every host look identically busy — AC-2/AC-4 fail unless each host’s `calendarId` is resolved and `freeBusy`’d.
- Risk: `listConfirmedBookingsForHost` matching only `booking.hostId` would leave co-hosts bookable after a collective confirm — occupy via `hostIds`.
- Risk: locking only the organizer’s `(hostId, start)` would let a 1:1 on a co-host race the collective — lock every assigned host.
- Risk: leaving the superseded “reject collective kind” tests in place would make a correct implementation fail `npm test` — those assertions must be retired in this slice (`round_robin` remains rejected).
- Risk: returning group `{ start, spots_remaining }` for a collective slug would break the 1:1-shaped GET contract — collective uses `{ times: string[] }`.
- Risk: a live Google write would fail `proof` — keep fixture/mock providers.
- Risk: adding round robin, managed events, or payments would violate non-goals.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing OAuth/availability/BOOK-core/BOOK-lifecycle/notification/OFF/WH/GRP/scaffold checks (home placeholder, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + create/patch/delete fixture, schedule/event-type stubs, slot engine, available-times GET, booking create/reschedule/cancel + 409 race, notificationMode + EmailProvider mock + notification_log, one-off windows + single-use 410, webhook HMAC + lifecycle emit + retry stub, group capacity + last-spot `session_full`, README env names). No manual or visual checks for this slice. No live Gmail. No live Google. No live internet HTTP.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
