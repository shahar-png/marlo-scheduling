> Supersedes the completed OAuth PLAN (shipped @ `ddb1139`). That slice is done: Auth.js Google provider, `/signin` + protected `/host`, calendar-connection stub, `CalendarProvider.freeBusy` fixture adapter. This work order is the next v1 slice only.

# PLAN — Availability schedules + one-on-one event types + available_times (slots)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder continuous go + VP Product, 19 Sep 2026 ET) — Founder said keep going after the OAuth slice.

## Goal

Hosts on `marlo-scheduling` can define a weekly **availability schedule** (IANA timezone + weekday hours) and a **one-on-one event type** (slug, duration, bound schedule). Guests can query **available_times** (bookable slot starts) for that event type: weekly hours minus busy windows from the existing `CalendarProvider.freeBusy` port. After this ships, the product can offer real slots against mocked Google free/busy — unlocking a later booking POST without implementing booking yet.

## Non-goals

- Booking POST (create event / write to Google Calendar / persist a reservation)
- Group, collective, or round-robin event types (one-on-one only)
- Sending mail via Gmail (or any outbound email)
- Chrome extension, InboxSDK, embeds, or webhooks
- Date-specific overrides, buffers, minimum notice, or custom slot increments (weekly hours + duration-aligned slots only)
- Outlook / Microsoft 365 calendar
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)
- Real Google Calendar / OAuth live calls required in CI (use the existing freeBusy fixture + auth stubs)

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, or live-Google observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | An availability-schedule stub exists: a host can create and read a weekly schedule with an IANA timezone and weekday windows (`weekday` 0=Sunday..6=Saturday, `start`/`end` as `HH:MM` local to that timezone). Empty timezone or empty windows are rejected. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/reject (in-memory is fine) |
| AC-2 | A one-on-one event-type stub exists: a host can create and read an event type with `slug`, `name`, `durationMinutes`, `availabilityScheduleId`, and `kind: "one_on_one"`. `group` / `collective` / `round_robin` kinds are rejected. Slug must be unique. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/reject |
| AC-3 | A slot engine `listAvailableTimes` (name may vary) given an event type + `[timeMin, timeMax]` + a `CalendarProvider` that returns **no** busy windows, returns duration-aligned ISO-8601 start times that lie entirely inside the bound schedule's weekly hours (interpreted in the schedule timezone). | Solely `PROOF_CMD` (`npm test`) — unit test with a mock provider returning `[]` |
| AC-4 | The same engine, wired to `createFixtureCalendarProvider` + the existing `tests/fixtures/google-freebusy.json`, **omits** any slot that overlaps a fixture busy window and still returns slots in the remaining free weekly hours. No live Google Calendar API. | Solely `PROOF_CMD` (`npm test`) — fixture unit test against the existing adapter |
| AC-5 | `GET /api/event-types/:slug/available-times` returns `{ times: string[] }` for a seeded one-on-one slug by composing the stubs + mocked `CalendarProvider`. Tests call the route handler directly (no live server, no live Google). Booking POST is absent. Existing `/` and `/api/health` stay public. | Solely `PROOF_CMD` (`npm test`) — handler unit test + assert no booking POST route |

## Builder

BUILDER: claude — in-memory stubs + a deterministic slot engine + App Router GET handler fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Add `lib/availability/schedule.ts` — in-memory schedule stub (same pattern as `lib/calendar/connection.ts`). Fields: `id`, `hostId`, `timezone`, `windows: { weekday, start, end }[]`. `resetAvailabilitySchedules()` for tests. Do not require Neon/Prisma.
2. Add `lib/availability/event-type.ts` — in-memory one-on-one event-type stub. Fields: `id`, `hostId`, `slug`, `name`, `durationMinutes`, `availabilityScheduleId`, `kind: "one_on_one"`. Reject other kinds. Unique slug. `resetEventTypes()` for tests.
3. Add `lib/availability/slots.ts` — `listAvailableTimes({ eventType, schedule, timeMin, timeMax, provider, calendarId })`. Expand weekly windows in the schedule timezone into UTC instants over the query range; subtract `provider.freeBusy(...)` busy intervals; slice remaining free ranges into slots of `durationMinutes` starting at each window's start (interval = duration). Return ISO start strings. Wire `calendarId` from the existing calendar-connection stub when present, else `"primary"`.
4. Add `GET app/api/event-types/[slug]/available-times/route.ts`. Query params: `timeMin`, `timeMax` (ISO). 404 unknown slug; 400 missing range. Compose stubs + `createFixtureCalendarProvider` (or an injectable provider defaulting to the fixture) so CI never calls live Google. Do **not** add a booking POST handler.
5. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit`. Reuse `tests/fixtures/google-freebusy.json` and `createFixtureCalendarProvider`. Fixture date is **Sunday 2026-09-20** UTC with busy `14:00–15:00` and `18:30–19:00`; tests should use a Sunday window that covers those hours (e.g. 09:00–20:00 in `UTC`) so busy subtraction is observable. Update `package.json` `test:unit` to include the new files. Do not change `PROOF_CMD`; do not edit `.github/`.
6. Auth stubs: available-times GET is public (guest-facing). Do not require a session. Reuse existing host-guard only if a host write path is added; host UI for editing schedules is optional and not an AC. If an AC cannot be observed without live Google, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; this slice does not reopen those decisions or add a real DB.
- Founder go continuous after OAuth (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen. It supersedes `ddb1139`'s completed OAuth PLAN.
- Existing `CalendarProvider` / `createFixtureCalendarProvider` / `tests/fixtures/google-freebusy.json` are the free/busy source of truth for this slice (`lib/calendar/provider.ts`, `lib/calendar/google-freebusy.ts`).
- Risk: timezone math is easy to get wrong — pin AC-3/AC-4 tests to `UTC` (or one explicit IANA zone with known offsets) so `npm test` is deterministic in CI.
- Risk: a live Google client would fail `proof` — default the GET handler to the fixture provider; inject a mock in tests.
- Risk: adding booking POST or group/RR kinds would violate non-goals — reject those kinds and do not add a POST booking route.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing OAuth/scaffold checks (home placeholder, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy fixture, README env names). No manual or visual checks for this slice. No live Google.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
