> Revision 1 of the LIVE-INT PLAN merged on `main` @ `c6be8d0` (PR #39). This revision (a) locks three Founder-verified product decisions that the previous PLAN left open or got wrong, and (b) closes Codex plan-review findings LIVE-01..LIVE-10. It supersedes the merged PLAN in full. Everything live is still behind env flags; `npm test` never leaves the machine.

# PLAN — LIVE-INT (rev 1): durable bookings, live Google Calendar, real emails, per-owner URLs, token reschedule

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Plan review: Codex (LIVE-01..10 addressed below) · Status: REVISED — Founder GO 21 Sep 2026 ET; product locks P1–P3 verified by Founder

BUILDER: claude

## Goal

When a guest books a host on production, the booking is real end to end and survives the guest changing their mind:

1. **Per-owner public URL.** The booking page lives at `/{ownerSlug}/{eventSlug}` and every piece of page chrome and copy that names the host uses that host's `firstName` (title, hero, confirmation, email subject/body). `/demo/intro-30` remains only as the fixture-backed demo route; it is not the product URL.
2. **Durable booking row.** The booking persists in Neon (Postgres) across serverless isolates. `GET /api/bookings/{id}` and `/b/{token}` return the same confirmed row regardless of which isolate serves the request.
3. **Live Google Calendar + real emails on book.** Booking creates a real event on the host's connected calendar (`events.insert` with the host's stored OAuth refresh token) and sends a real confirmation email through the Gmail API to **both** the invitee and the owner, with a minimal `.ics`.
4. **Guest reschedule / cancel via `/b/{token}`.** The guest's change path is the token page, not "reopen the event link and book again". Reschedule moves the live calendar event (patch; or cancel+create when the event is gone) and sends reschedule emails to invitee and owner. Cancel removes the live event and sends cancel emails. Both paths keep parity with the existing `notify` modes (`none | invitee | owner | both`) — live calendar and live email are gated by the same modes that the mock path honors today.
5. **Honest failure semantics.** A booking whose DB write succeeded but whose email failed is still a booking: the API returns HTTP 201 with the booking token and `emailDelivery: "failed" | "pending"`, and an idempotent retry route re-attempts delivery. Calendar failures and Gmail failures are distinguished in the response and in logs. A calendar event created before a DB insert that then rolls back is compensated (deleted) so no orphan event lingers on the host's calendar.

All live implementations sit behind interfaces whose default implementations are the existing in-memory / fixture / mock ones, so `PROOF_CMD` (`npm test`) stays green offline and never needs `DATABASE_URL`, Google, Gmail, or the network. Live code paths activate only when `DATABASE_URL`, `LIVE_CALENDAR=1`, and `LIVE_EMAIL=1` are set in the host environment.

## Non-goals

- Chrome / Gmail extension
- Host dashboard (listing/managing bookings as the host) — hosts see bookings on their Google Calendar and in their inbox; that is the dashboard for this slice
- Cursor cloud / any non-Vercel deploy target
- MJML / HTML email polish beyond the minimum plain-text body + `.ics` needed to send a real confirmation / reschedule / cancel
- Multi-calendar selection UI, calendar-picker, or writing to any calendar other than the host's primary
- Host self-serve creation/editing of event types (event types remain fixture-defined per owner; slugs are data, not a CRUD surface)
- Payments, SMS, reminders, buffer rules, round-robin / collective across hosts beyond the group-capacity check already in scope
- A background job runner / queue for email retry — the retry is an idempotent HTTP route the guest or owner can hit from the confirmation page; no cron, no queue
- Changing the proof harness shape: `PROOF_CMD` remains `npm test` (typecheck + `next build` + unit tests via `scripts/proof.cjs`)

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). No AC requires a database, Google, Gmail, or the network: live implementations are proven against injected fakes (a recording `Queryable` for SQL, a fake `fetch` for Google APIs). The real-inbox / real-calendar check is the **Founder live smoke** in `## Verification`, which is manual and not graded.

| ID | Criterion | Proof (inside `npm test`) | Closes |
|---|---|---|---|
| AC-1 | `GET /{ownerSlug}/{eventSlug}` renders the booking page for a fixture owner+event; unknown owner or unknown event under a known owner → 404. Page title, hero heading, slot-picker intro, confirmation heading, and email subject/body all interpolate the owner's `firstName` (no hard-coded "Shahar"/"the host" in host-facing copy). `/demo/intro-30` still renders and is explicitly tagged `fixture: true` in its page data; no non-demo owner slug resolves to fixtures when `DATABASE_URL` is set. | Route-handler + render tests with two fixture owners with different `firstName`s; grep-style test that `app/**` and `lib/email/**` contain no hard-coded host first name outside `fixtures/**`. | P1 |
| AC-2 | Owner and event slugs are validated (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`), lower-cased on lookup, and never reach SQL unparameterized. The `bookAgainHref` and all internal links on confirmation/reschedule/cancel pages point at `/{ownerSlug}/{eventSlug}`, not `/demo/intro-30`, for non-demo bookings. | Unit tests for slug validator (valid, upper-case, path traversal, empty, >64); link assertions in page tests. | P1 |
| AC-3 | With `DATABASE_URL` set, bookings are written to and read from Postgres through a `BookingStore` interface; without it, the in-memory store is used. A store-backed round trip (create → `GET /api/bookings/{id}` → `/b/{token}`) returns identical rows from a fresh store instance (simulating a second isolate). | Recording-`Queryable` fake asserts exact parameterized SQL; two `PgBookingStore` instances sharing one fake DB return equal rows. | keep |
| AC-4 | Booking a slot takes a **per-host advisory lock** (`pg_advisory_xact_lock(hash(hostId))`), not a `host:start` lock. Two concurrent bookings for the same host with **different but overlapping** start times serialize: the second sees the first's row and is rejected with 409 `slot_taken`. | Stateful fake DB with an explicit lock queue: test interleaves two overlapping unequal-start bookings and asserts serialization + 409; a second test shows two non-overlapping bookings for the same host both succeed. | LIVE-01 |
| AC-5 | Invitee and owner email addresses are validated as **a single mailbox** (one `addr-spec`, no display name, no comma/semicolon lists, no CR/LF, ≤254 chars). Any input that could inject a header (`\r`, `\n`, leading `To:`/`Cc:`/`Bcc:`/`Subject:`) is rejected with 400 before any store or Google call. Subject, names, and notes are MIME-encoded (RFC 2047 / quoted-printable) and `.ics` text values are escaped per RFC 5545 (`\\`, `;`, `,`, newlines). | Malicious-input tests: `a@b.com,c@d.com`, `"x"<a@b.com>`, `a@b.com\r\nBcc: x@y.z`, notes containing `;` `,` `\n` and non-ASCII; assert 400s and assert the built MIME/ICS bytes contain no raw CRLF injection and correct escapes. | LIVE-02 |
| AC-6 | `npm test` is offline-safe even though `next build` reloads env: the proof harness passes an **explicit disabled env** (`LIVE_CALENDAR=0 LIVE_EMAIL=0 DATABASE_URL=` and `MARLO_PROOF=1`) to the build and test children, and `lib/env` reads flags through a post-load override hook that tests can set. A test asserts that with `MARLO_PROOF=1` every live adapter factory returns the mock even if `LIVE_*` are present in `process.env`. | Unit test on env resolver; `scripts/proof.cjs` asserts the child env it constructs; a fetch-guard in test setup throws on any non-localhost `fetch`. | LIVE-03 |
| AC-7 | `freeBusy` handling is fail-closed: a per-calendar `errors[]` entry, a calendar missing from the response, or a malformed `busy[]` (missing/unparseable `start`/`end`) makes availability for that window **unavailable** (503 `availability_unknown` at the API), never "free". | Fake-`fetch` tests for each of the three shapes plus a happy path. | LIVE-04 |
| AC-8 | Availability distinguishes **managed busy** (bookings in the store for this host, including group-capacity counts) from **external busy** (Google freeBusy). For a group event type with `capacity: n`, the slot stays bookable until `n` confirmed bookings exist in the store and the (n+1)th is rejected with 409 `slot_full`; cancels free capacity. | Stateful capacity test through the store (book n, assert n+1 → 409, cancel one, book again → 201); freeBusy fake contributes only external busy. | LIVE-05 |
| AC-9 | A single `demoMetadata(booking)` helper (in `lib/booking/demo-meta.ts` or the existing equivalent) is used by confirm, cancel, and reschedule; none of the three carries its own copy. The helper tolerates an empty/missing metadata map. Lifecycle tests run book → reschedule → cancel with an empty map and with a populated map. | Import-graph test asserts confirm/cancel/reschedule modules import the helper and contain no inline `metadata[...]` reads; lifecycle tests. | LIVE-06 |
| AC-10 | `POST /api/bookings` (and the page action behind it) returns **HTTP 201** with `{ id, token, emailDelivery: "sent" \| "failed" \| "pending", calendar: "created" \| "failed" \| "skipped" }` whenever the booking row is committed. Email failure never turns a committed booking into a 4xx/5xx. `POST /api/bookings/{id}/notify` with the booking token is **idempotent**: it re-sends only the recipients whose delivery is not `sent`, updates `emailDelivery`, and returns 200 with the new state; a second call after success is a no-op 200. Gmail errors and Calendar errors are reported under separate keys and logged with separate `code`s (`gmail_send_failed` vs `calendar_insert_failed`). | Route tests with an email adapter that throws once then succeeds; assert 201 + `failed`, then retry → 200 + `sent`, then retry → no send call. Test with calendar adapter throwing and email succeeding asserts `calendar: "failed"`, `emailDelivery: "sent"`. | LIVE-07 |
| AC-11 | Order of live effects on book is: lock → insert row (uncommitted) → calendar `events.insert` → commit → email. If commit fails after the calendar event was created, the adapter **compensates** by `events.delete` on the created event id before surfacing the error; the compensation failure (if any) is logged with the orphan event id, never swallowed. | Fake DB whose `COMMIT` throws; assert `events.delete` is called with the id returned by `events.insert`, and the API returns 500 `booking_failed` without `token`. | LIVE-08 |
| AC-12 | `/b/{token}` reschedule: picks a new slot for the same host+event, re-runs the AC-4 lock and AC-7/8 availability, updates the row (`start`, `end`, `rescheduledFrom`), and **moves the live calendar event** via `events.patch`; if the patch returns 404/410 (event deleted on the host's calendar) it falls back to `events.insert` and stores the new event id. Reschedule emails go to invitee and owner per `notify` mode. `/b/{token}` cancel: sets `status: cancelled`, `events.delete` (404 tolerated), sends cancel emails per `notify` mode. Both work identically against mock and live adapters (parity test runs the same scenario against both). | Parity test matrix `{mock, live-with-fake-fetch} × {reschedule, cancel} × {notify: none, invitee, owner, both}` asserts calendar calls and email recipient sets. Patch-404 fallback test. | P2, P3 |
| AC-13 | On book, **both** invitee and owner receive a confirmation (subject and body use the host's `firstName` and the invitee's name; owner copy says who booked; both carry the `.ics`). Cancel emails use cancel-specific intro copy ("… has been cancelled") and **never** the confirmation intro ("You're booked with …"); reschedule emails use reschedule copy with old and new times. | Snapshot-free string assertions on subject and first body line for each of confirm/reschedule/cancel × invitee/owner; negative assertion that cancel bodies do not contain the confirmation intro string. | P3, LIVE-10 |
| AC-14 | Host OAuth on `/signin` requests `calendar.events` + `gmail.send` scopes with `access_type=offline` and `prompt=consent`; the refresh token is stored encrypted at rest (`OAUTH_TOKEN_KEY`, AES-256-GCM) in the store; the live adapters exchange it for an access token with a fake-able `fetch`. A missing/invalid refresh token yields `calendar: "failed"` / `emailDelivery: "failed"` with code `host_not_connected`, never a crash. | Token round-trip encrypt/decrypt test; adapter test with `invalid_grant` response. | keep |
| AC-15 | The "no secret / no env read outside `lib/env`" grep test allows `/api/health` to read deploy SHA env (`VERCEL_GIT_COMMIT_SHA`, `VERCEL_DEPLOYMENT_ID`) via an explicit exception list; `/api/health` returns `{ ok, sha, store: "memory" \| "pg", calendar: "mock" \| "live", email: "mock" \| "live" }` without touching the network. | Grep test exception list contains exactly `app/api/health/route.ts`; health route test. | LIVE-09 |
| AC-16 | README documents every env name (`DATABASE_URL`, `LIVE_CALENDAR`, `LIVE_EMAIL`, `OAUTH_TOKEN_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MARLO_PROOF`), the per-owner URL shape, the `/b/{token}` reschedule/cancel flow, the 201+`emailDelivery` contract and the retry route, and the Founder live-smoke steps. | Doc-presence test asserts each env name and each route appears in README. | keep |

## Approach

Work proceeds in the order below; each step lands with its tests so `npm test` is green at every step.

### 1. Env + proof hardening first (LIVE-03, LIVE-09)
- `lib/env.ts` becomes the single reader: `resolveEnv(overrides?)` with a module-level `setEnvOverride()` used by tests and by `scripts/proof.cjs`. `MARLO_PROOF=1` forces `store=memory, calendar=mock, email=mock` regardless of other vars.
- `scripts/proof.cjs` builds the child env explicitly (`{ ...process.env, MARLO_PROOF: "1", LIVE_CALENDAR: "0", LIVE_EMAIL: "0", DATABASE_URL: "" }`) for both `next build` and the test runner, so Next's own `.env*` loading cannot re-enable live paths. A test-setup `fetch` guard throws on any non-`localhost` URL.
- Grep test gets an explicit exception list; `/api/health` is the only entry and only for the two SHA vars.

### 2. Per-owner routing + host-personalized chrome (P1)
- New route `app/[ownerSlug]/[eventSlug]/page.tsx` replaces the demo route as the product surface; `app/demo/intro-30` becomes a thin re-export that pins `owner=demo, event=intro-30, fixture=true`.
- `lib/owners.ts`: `resolveOwner(slug)` → fixture owner in memory mode; store-backed `owners` table in pg mode. Slug validator shared by route + store.
- All host-facing copy goes through `hostCopy(owner)` returning `{ pageTitle, heroHeading, pickerIntro, confirmHeading, emailSubject(kind), ... }`. Email templates take `owner.firstName` explicitly — no template reads a global.
- `bookAgainHref` and all page links derive from the booking's `ownerSlug`/`eventSlug` columns (added in the migration below).

### 3. Durable store + per-host lock + capacity (AC-3/4/8; LIVE-01, LIVE-05)
- Migration `sql/002_live_int_rev1.sql`: `owners`, `host_tokens` (encrypted refresh token), `bookings` gains `owner_slug`, `event_slug`, `google_event_id`, `email_delivery jsonb` (per-recipient state), `rescheduled_from`, `status`.
- `PgBookingStore.createBooking` runs in one transaction: `SELECT pg_advisory_xact_lock(hashtext($hostId))` → conflict query over `[start,end)` overlap for `status='confirmed'` (and capacity count for group events) → `INSERT` → return uncommitted row to the caller for the calendar step → `COMMIT`. The lock key is **host only** so unequal overlapping starts serialize (LIVE-01).
- Availability = `externalBusy(freeBusy)` ∪ `managedBusy(store)`; group slots compare `count < capacity` from the store, never from freeBusy (LIVE-05).

### 4. Google adapters, fail-closed freeBusy, compensation (AC-7/11/14; LIVE-04, LIVE-08)
- `lib/google/calendar.ts`: `insert`, `patch`, `delete`, `freeBusy`. `freeBusy` throws `AvailabilityUnknown` on `errors[]`, missing calendar key, or a busy entry with unparseable bounds (LIVE-04); the API maps it to 503.
- `lib/google/oauth.ts`: refresh-token exchange with injected `fetch`; `invalid_grant` → `HostNotConnected`.
- Book orchestration (`lib/booking/create.ts`): lock+insert → `calendar.insert` → commit → email. On commit failure after insert succeeded: `calendar.delete(eventId)` in a `finally`-style compensation; log `orphan_event_compensated` or `orphan_event_compensation_failed { eventId }` (LIVE-08).

### 5. Email: validation, MIME/ICS escaping, dual recipients, retry (AC-5/10/13; LIVE-02, LIVE-07, LIVE-10)
- `lib/email/address.ts`: strict single-mailbox parser; reject lists, display names, CR/LF, header-looking prefixes. Called at the API boundary (400) before any side effect.
- `lib/email/mime.ts`: RFC 2047 subject/name encoding, quoted-printable body, base64 `.ics` attachment; `lib/email/ics.ts` escapes RFC 5545 text. Tests feed hostile strings and inspect bytes.
- Templates: `confirm`, `reschedule`, `cancel`, each with `invitee` and `owner` variants. Cancel intro is its own string constant; a test asserts it is disjoint from the confirm intro (LIVE-10).
- Delivery state is per recipient in `email_delivery` jsonb: `{ invitee: "sent"|"failed"|"pending", owner: ... }`; the API summarizes to `emailDelivery` (`sent` iff all required recipients sent; `failed` if any failed; `pending` if a send is in flight/unattempted). `POST /api/bookings/{id}/notify` (token-authenticated) re-sends only non-`sent` recipients — idempotent (LIVE-07 CHOSEN policy: 201 + token + `emailDelivery` + retry route; no 5xx for committed bookings).
- Error classes `GmailSendError` and `CalendarError` are distinct; the route maps them to separate response keys and log codes.

### 6. `/b/{token}` reschedule + cancel with live parity (AC-9/12; P2, P3, LIVE-06)
- `lib/booking/demo-meta.ts` exports `demoMetadata(booking)`; confirm/cancel/reschedule import it; the old inline copies are deleted.
- `lib/booking/reschedule.ts`: re-validate slot (lock + availability), update row, `calendar.patch`; on 404/410 → `calendar.insert` and store new id; emails per `notify`.
- `lib/booking/cancel.ts`: status update, `calendar.delete` (404 tolerated), emails per `notify`.
- Parity test harness runs each scenario against `{mock adapters, live adapters + fake fetch}` and asserts the same observable calls/recipients.

### 7. README + health (AC-15/16)
- README sections: env vars, URL shape, reschedule/cancel via token, 201/`emailDelivery`/retry contract, Founder live smoke.

## Assumptions and risks

- **Assumption:** the host's Google account grants `calendar.events` and `gmail.send` in one consent; sending "as the host" via Gmail API is acceptable to the Founder for this slice (no custom domain / SES).
- **Assumption:** owner records for the first hosts are seeded by migration/fixture (`owners` table); there is no host-facing owner CRUD in this slice.
- **Risk — Next env reload (LIVE-03):** `next build` re-reads `.env.local`. Mitigated by explicit disabled env on the child process plus `MARLO_PROOF=1` hard override in `lib/env`. If a future Next version changes env precedence, the fetch guard still fails the proof loudly rather than silently going live.
- **Risk — Neon advisory locks under pooling:** `pg_advisory_xact_lock` is transaction-scoped so it is safe under PgBouncer transaction pooling; the builder must not use session-level locks.
- **Risk — Google patch vs delete race on reschedule:** if the host deletes the event between our read and patch, we fall back to insert (AC-12); a residual duplicate is possible only if the host re-adds the event manually — accepted.
- **Risk — email "pending" state with no queue:** `pending` exists only for the window inside a request; there is no background retrier by design (Non-goals). The confirmation page shows a "Resend confirmation" action that hits the idempotent notify route.
- **Risk — encryption key rotation:** `OAUTH_TOKEN_KEY` rotation is not handled; documented in README as a manual re-connect.
- **Scope risk:** AC-1/2 (per-owner URLs) touch the front-end shipped in BOOK-FE (#38). The builder must keep the BOOK-FE mobile/CSS tests green; no visual redesign.

## Verification

`PROOF_CMD: npm test`

`npm test` runs `scripts/proof.cjs` → typecheck → `next build` (with the explicit disabled env from AC-6) → unit/route tests. It must pass with no `DATABASE_URL`, no Google credentials, and no network (the test fetch guard enforces this). All AC-1..16 proofs are inside this run.

**Founder live smoke (manual, not graded):** set `DATABASE_URL`, `LIVE_CALENDAR=1`, `LIVE_EMAIL=1`, `OAUTH_TOKEN_KEY`, Google client id/secret on Vercel; sign in at `/signin`; book `/{shahar}/{intro-30}`; confirm the event appears on the host calendar and both inboxes get the confirmation; open `/b/{token}`, reschedule (event moves, two reschedule emails), then cancel (event removed, two cancel emails); hit `/api/health` and confirm `store: "pg", calendar: "live", email: "live"`.

## Round budget

- Build rounds: 3 (builder → inspector → judge per round).
- Round 1: steps 1–4 (env/proof, routing, store+lock, Google adapters). Round 2: steps 5–6 (email, reschedule/cancel parity). Round 3: step 7 + inspector findings.
- Any inspector finding that would require expanding Non-goals is dispositioned `out-of-scope` by the judge and logged for the next PLAN, not built.
- If `npm test` is red at the end of round 3, the PR is labelled `hold` and the PLAN is revised rather than extending rounds.
