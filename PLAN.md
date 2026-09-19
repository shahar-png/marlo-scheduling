> Supersedes the completed OFF PLAN (shipped @ `f5b6896`, PLAN PR #13 @ `b7e1045`). That slice is done: one-off meeting windows, single-use scheduling links, consume-on-success, HTTP 410 on reuse. This work order is the next v1 slice only — **webhooks (WH)**.

# PLAN — Webhooks: booking.created / canceled / rescheduled + HMAC signature (WH)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED (Founder continuous go + VP Product, 19 Sep 2026 ET) — Founder said keep going after the OFF slice.

## Goal

Hosts on `marlo-scheduling` can create **webhook subscriptions** (HTTPS URL + shared secret + an allowlist of booking lifecycle events). On booking **create / cancel / reschedule**, the app emits `booking.created`, `booking.canceled`, or `booking.rescheduled` with a JSON payload signed HMAC-SHA256 and sent under the `Marlo-Webhook-Signature` header. Each attempt is written to a **delivery log**; a **retry stub** re-POSTs failed rows. After this ships, integrators can verify signed booking events without a Zapier app, live internet delivery in CI, or routing-form events.

## Non-goals

- Zapier app / Zapier developer platform
- Live HTTP delivery to the public internet in CI (inject a mock `fetch` / `WebhookHttp`)
- `routing_form` events (or any intake / questionnaire events)
- Polls / group voting, Chrome extension, InboxSDK, or embeds
- Live email / real Gmail send (keep the existing `EmailProvider` mock + `notification_log`)
- Group, collective, or round-robin event types (one-on-one only)
- Payments, deposits, or paid event types
- Outlook / Microsoft 365 calendar
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)
- Live Google Calendar writes (or live OAuth) required in CI — keep mocked `createEvent` / `updateEvent` / `deleteEvent` and the freeBusy fixture

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, live-Gmail, live-Google, or live-internet observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | A webhook-subscription stub exists: a host can create and read a subscription with `hostId`, `url` (`http://` or `https://`), `secret`, and `events` drawn from `{booking.created, booking.canceled, booking.rescheduled}`. Empty url/secret, non-http(s) url, empty events, or unknown events (including `routing_form.*`) are rejected. `resetWebhookSubscriptions()` / `listWebhookSubscriptions(hostId)` for tests. No production DB. | Solely `PROOF_CMD` (`npm test`) — unit tests for stub create/read/reject (in-memory is fine) |
| AC-2 | HMAC-SHA256 signing: `signWebhookPayload(body, secret)` (name may vary) produces the value for header `Marlo-Webhook-Signature` in the form `sha256=<hex>` over the **exact** JSON body bytes. Tests independently compute HMAC-SHA256 and assert the header matches; a wrong secret fails `verifyWebhookSignature`. | Solely `PROOF_CMD` (`npm test`) — unit tests for sign + verify + mismatch |
| AC-3 | Event payload: emitted envelopes are `{ id, event, createdAt, data: { booking: { id, hostId, eventTypeId, start, end, status, invitee } } }` with `event` one of `booking.created` / `booking.canceled` / `booking.rescheduled`. Tests assert event names and booking fields (invitee name/email, ISO start/end). | Solely `PROOF_CMD` (`npm test`) — unit tests for payload shape on all three events |
| AC-4 | Lifecycle emit: successful `bookAvailableSlot` / `rescheduleBooking` / `cancelBooking` POST to matching host subscriptions via an injectable mock HTTP (no live internet). Each success writes a delivery-log row. 409 / validation failures do **not** emit. Public create / reschedule / cancel route handlers also emit (tests call handlers directly). | Solely `PROOF_CMD` (`npm test`) — library + handler unit tests; assert mock fetch received signed body + `Marlo-Webhook-Signature` |
| AC-5 | Delivery log + retry stub: each attempt records `subscriptionId`, `event`, `status` (`delivered` \| `failed`), `attempts`, and the signed payload. `retryFailedWebhookDeliveries()` (name may vary) re-POSTs `failed` rows through the mock HTTP, increments `attempts`, and updates status. Tests inject a fetch that fails then succeeds — no live internet. `resetWebhookDeliveries()` for tests. | Solely `PROOF_CMD` (`npm test`) — unit tests for log + retry stub with mock fetch |

## Builder

BUILDER: claude — in-memory subscription + HMAC + mock-fetch delivery + a hook on the existing booking lifecycle fit the Claude implement lane. Inspector: codex (separate). Judge: Grok via agent-os.

## Approach

1. Add `lib/webhooks/subscription.ts` — in-memory webhook-subscription stub (same pattern as `lib/availability/schedule.ts`). Fields: `id`, `hostId`, `url`, `secret`, `events: WebhookEvent[]`. Allowlist: `booking.created`, `booking.canceled`, `booking.rescheduled`. Reject blank hostId/url/secret, non-`http(s)` URLs, empty events, duplicates, and unknown events (explicitly `routing_form.*`). `resetWebhookSubscriptions()` / `getWebhookSubscription()` / `listWebhookSubscriptions(hostId)`. Do not require Neon/Prisma.
2. Add `lib/webhooks/signature.ts` — `signWebhookPayload(body, secret)` → `sha256=<hex>` using Node `crypto.createHmac('sha256', secret)` over the exact UTF-8 body. Export `WEBHOOK_SIGNATURE_HEADER = "Marlo-Webhook-Signature"`. `verifyWebhookSignature(body, secret, header)` for tests.
3. Add `lib/webhooks/events.ts` — `buildWebhookPayload({ event, booking })` returning `{ id, event, createdAt, data: { booking } }` with the booking fields in AC-3. Use American `canceled` in the **event name**; keep existing booking `status: "cancelled"`.
4. Add `lib/webhooks/http.ts` — `WebhookHttp` port with `post(url, body, headers) → { status }`. Default `createMockWebhookHttp()` records posts and returns 200. Injectable via `setWebhookHttp` / `getWebhookHttp` (same pattern as `lib/notify/email-runtime.ts`). Never call the real global `fetch` from CI defaults.
5. Add `lib/webhooks/log.ts` + `lib/webhooks/deliver.ts` — delivery log rows: `id`, `subscriptionId`, `event`, `bookingId`, `status`, `attempts`, `payload`, `signature`, optional `responseStatus`, `createdAt`. `deliverBookingWebhook({ booking, event })` finds the host’s subscriptions that include `event`, signs `JSON.stringify(payload)`, POSTs via `WebhookHttp`, records delivered/failed without throwing into the booking caller. `retryFailedWebhookDeliveries()` re-POSTs `failed` rows, increments `attempts`, updates status. `resetWebhookDeliveries()`.
6. Hook emit into `lib/booking/booking.ts` after a successful `bookAvailableSlot` (covers single-use book too), `rescheduleBooking`, and `cancelBooking` — **after** the existing `dispatchBookingNotification`. Do not emit from low-level `createBooking` or on 409 / validation failure.
7. Extend `tests/` (same Node test runner) so AC-1..5 are covered by `npm run test:unit` (`tests/webhooks.test.ts` + `tests/webhooks-route.test.ts`). Reuse Sunday **2026-09-20** UTC slots (`09:00` / `09:30`) and the existing freeBusy fixture. Update `package.json` `test:unit` to include the new files. Do not change `PROOF_CMD`; do not edit `.github/`.
8. Auth stubs: no new public subscription-management route is required (host UI is optional and not an AC). Existing public booking create/reschedule/cancel stay public. If an AC cannot be observed without live internet / Gmail / Google, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026, VP Product + Shahar go). Stack remains Next/Vercel/Neon/Inngest; this slice does not reopen those decisions or add a real DB. Subscriptions and the delivery log are stubs, not Neon rows.
- Founder go continuous after OFF (19 Sep 2026 ET): this PLAN is the next dispatched work order, not a product-reopen. It supersedes `f5b6896` / PR #13’s completed OFF PLAN.
- Existing bookings, slot locks, `notification_log`, `CalendarProvider`, and `createFixtureCalendarProvider` remain the source of truth for 1:1 booking (`lib/availability/*`, `lib/booking/*`, `lib/calendar/*`, `lib/notify/*`).
- Event names are `booking.canceled` (American, integrator-facing). Persist status stays `cancelled` (already shipped).
- Risk: signing a re-serialized object would break verification — sign the exact string that is POSTed.
- Risk: a thrown delivery error would fail the booking after the calendar write — swallow HTTP failures into `status: "failed"`; never throw from deliver into the booking caller.
- Risk: a live `fetch` to the internet would fail or flake `proof` — default to the mock HTTP; inject a failing mock to cover AC-5.
- Risk: emitting `routing_form` events or adding a Zapier app would violate non-goals.
- Risk: changing `PROOF_CMD` or `.github/` is out of scope.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-1..5 and the existing OAuth/availability/BOOK-core/BOOK-lifecycle/notification/OFF/scaffold checks (home placeholder, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + create/patch/delete fixture, schedule/event-type stubs, slot engine, available-times GET, booking create/reschedule/cancel + 409 race, notificationMode + EmailProvider mock + notification_log, one-off windows + single-use 410, README env names). No manual or visual checks for this slice. No live Gmail. No live Google. No live internet HTTP.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
