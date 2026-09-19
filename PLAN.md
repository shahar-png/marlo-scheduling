> Supersedes the completed BOOK-lifecycle PLAN (shipped @ `bf51fea`, PLAN PR #9 @ `77cfded`). That slice is done: invitee reschedule + cancel, mocked `CalendarProvider.updateEvent` / `deleteEvent`, reminder-job stub, and race-safe 409. This work order is the next v1 slice only — **notification mode stubs** (`calendar_invitation` vs `email_confirmation`) plus `notification_log`.

# PLAN — Notification mode stubs: calendar_invitation vs email_confirmation + notification_log

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder continuous go + VP Product, 19 Sep 2026 ET) — Founder said keep going after the reschedule/cancel slice.

## Goal

On `marlo-scheduling`, every successful booking **create**, **reschedule**, and **cancel** records a `notification_log` entry. An event type chooses a **notification mode**: `calendar_invitation` (guest is notified via a mocked calendar invite — `CalendarProvider.createEvent` / `updateEvent`) or `email_confirmation` (guest is notified via a pluggable `EmailProvider` mock — no real Gmail). After this ships, BOOK lifecycle emits an auditable notification record per action, with both modes covered by `npm test`, without sending real mail or talking to live Google.

## Non-goals

- Real Gmail API (or any live outbound email / SMTP)
- Twilio SMS (or any SMS / WhatsApp / push channel)
- Full workflow engine UI (no host “workflows” editor, no template designer)
- Chrome extension, InboxSDK, embeds, or webhooks
- Host request-reschedule UI polish
- Group, collective, or round-robin event types (one-on-one only)
- Payments, deposits, or paid event types
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)
- Live Google Calendar writes (or live OAuth) required in CI — keep mocked `createEvent` / `updateEvent` / `deleteEvent` and the freeBusy fixture

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, live-Gmail, or live-Google observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | A one-on-one event type can be created and read with `notificationMode`: `calendar_invitation` or `email_confirmation`. Omitted mode defaults to `calendar_invitation` (existing seeds stay valid). Any other / empty mode is rejected. `resetEventTypes()` still clears state. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/default/reject |
| AC-2 | A pluggable `EmailProvider` port exists with a mock adapter that **records** `send({ to, subject, template, bookingId })` and **never** calls Gmail. Successful create / reschedule / cancel on an `email_confirmation` event type **calls** `send` (templates: confirmation / rescheduled / cancelled). The `calendar_invitation` path does **not** call `EmailProvider`. `resetEmailMessages()` (or equivalent) for tests. | Solely `PROOF_CMD` (`npm test`) — mock adapter unit tests + lifecycle assertions |
| AC-3 | The `calendar_invitation` path uses the existing `CalendarProvider` mock: create → `createEvent` **with the invitee as an attendee**; reschedule → `updateEvent` (patch) on the existing `calendarEventId`. The `email_confirmation` path still writes the host calendar block (create / patch / delete for occupancy) but **omits attendees** (no calendar invitation). No live Google. | Solely `PROOF_CMD` (`npm test`) — fixture adapter assertions for create/patch + attendee presence/absence |
| AC-4 | An in-memory `notification_log` records **one** entry per successful create / reschedule / cancel: `{ bookingId, action, mode, channel }` where `channel` is `calendar` for `calendar_invitation` and `email` for `email_confirmation`. Failed / 409 actions write no row. `resetNotificationLog()` / `listNotificationLog()` for tests. | Solely `PROOF_CMD` (`npm test`) — log contents after create/reschedule/cancel and after a 409 |
| AC-5 | README documents **future** Gmail env **names** (no secret values): `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_FROM`. Existing public booking routes (`POST` create / reschedule / cancel) still work and emit a log row. Tests call handlers / stubs directly (no live server, no live Gmail/Google). | Solely `PROOF_CMD` (`npm test`) — README name assertions + handler/stub log assertion |

## Builder

BUILDER: claude — in-memory stubs + a pluggable EmailProvider mock + wiring the existing booking stub / CalendarProvider mock fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Extend `lib/availability/event-type.ts`: add `notificationMode: "calendar_invitation" | "email_confirmation"`. Accept it on create; default omitted/undefined to `calendar_invitation`. Reject any other string (including blank). Keep unique slug + one-on-one-only. `resetEventTypes()` unchanged in spirit.
2. Add `lib/notify/email.ts` — `EmailProvider` port + `createMockEmailProvider()` that records sent messages in memory and never touches the network. Export `resetEmailMessages()` / `listSentEmails()` (names may vary). Templates: `booking_confirmation`, `booking_rescheduled`, `booking_cancelled`.
3. Add `lib/notify/log.ts` — in-memory `notification_log`. `recordNotification({ bookingId, action, mode, channel, providerMessageId? })`; `listNotificationLog()`; `resetNotificationLog()`. Do not require Neon/Prisma.
4. Add `lib/notify/dispatch.ts` (name may vary) invoked **after** a successful `bookAvailableSlot` / `rescheduleBooking` / `cancelBooking`: read the event type’s `notificationMode`; if `email_confirmation`, `EmailProvider.send` then log `channel: "email"`; if `calendar_invitation`, the calendar create/patch **is** the guest notification — log `channel: "calendar"` (do not send email). Pass `EmailProvider` as an injectable defaulting to the mock so CI never calls Gmail.
5. Attendee rule in the booking stub: `calendar_invitation` → include invitee on `createEvent` / `updateEvent`; `email_confirmation` → omit `attendees` so the host calendar block is not a guest invite. Keep `deleteEvent` on cancel for both modes (occupancy cleanup, not a new channel).
6. Wire create / reschedule / cancel (lib + existing public App Router POSTs) so a successful handler records exactly one log row. 409 / 400 / 404 must not append. Reuse `getBookingCalendarProvider()`; add a parallel injectable email provider if the handler path needs it.
7. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit`. Reuse seeded one-on-one slugs, Sunday 2026-09-20 UTC windows, and `tests/fixtures/google-freebusy.json`. Update `package.json` `test:unit` to include the new files. Extend `tests/readme.test.ts` to require the Gmail env **names** and still forbid credential-shaped values. Do not change `PROOF_CMD`; do not edit `.github/`.
8. Auth stubs: no new session requirement. Notification dispatch is a side effect of the existing public invitee routes. If an AC cannot be observed without live Gmail/Google, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; this slice does not reopen those decisions or add a real DB. Email and the log are stubs, not live Gmail / Inngest.
- Founder go continuous after reschedule/cancel (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen. It supersedes `bf51fea` / PR #9’s completed BOOK-lifecycle PLAN.
- Existing event types, bookings, slot locks, `CalendarProvider.createEvent` / `updateEvent` / `deleteEvent`, and `createFixtureCalendarProvider` remain the calendar source of truth (`lib/availability/*`, `lib/booking/*`, `lib/calendar/*`).
- Future real Gmail will read `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_FROM` from the host environment. This slice only documents the names.
- Risk: a live Gmail or Google write would fail `proof` — default to mocks; inject mocks in tests.
- Risk: forgetting to skip the log on 409 would make AC-4 fail.
- Risk: putting attendees on `email_confirmation` calendar writes would blur the two modes (AC-3).
- Risk: changing `PROOF_CMD` or `.github/` is out of scope.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing OAuth/availability/BOOK-core/BOOK-lifecycle/scaffold checks (home placeholder, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + create/patch/delete fixture, schedule/event-type stubs, slot engine, available-times GET, booking create/reschedule/cancel + 409 race, README env names). No manual or visual checks for this slice. No live Gmail. No live Google.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
