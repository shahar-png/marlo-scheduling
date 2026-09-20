> Supersedes the BOOK-FE PLAN on main @ `f89d9b4` (PR #23), which the agent-os IMPL dispatch Codex plan review marked **REVISE** (no builder started) on two findings: BOOK-FE-04 function-valued props across the Server→Client component boundary, BOOK-FE-05 empty/invalid slot range when the clamped `timeMin` reaches `timeMax`. This revise addresses both. The earlier BLOCKED findings (BOOK-FE-01/02/03, fixed in PR #23: handoff in-repo, past-slot cutoff, real-form AC-4) stay addressed. The completed COL slice (shipped @ `f67bafc`) is unchanged. This work order is the next v1 slice only — **public booking page front-end (BOOK-FE)**.

# PLAN — Public booking page front-end (BOOK-FE)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Plan review: Codex (BLOCKED → revised → REVISE → revised) · Status: APPROVED Founder go + VP Product (plan revise after Codex REVISE BOOK-FE-04/05), 20 Sep 2026 ET

## Goal

An invitee can open a **public booking route**, pick a date/slot, enter name/email, and confirm a booking — **Marlo-branded UI** from the FE handoff — wired to the **existing** in-repo booking APIs. `https://marlo-scheduling.vercel.app` is no longer a placeholder-only homepage: `/` is branded cream/ink/lime chrome that links to a bookable demo, and `/{slug}/{event}` is a real booking page. After confirm, `/b/{token}` shows a branded “Handled.” confirmation shell. All handoff↔repo mapping lives in `lib/api/` (components never `fetch`). The page never offers or confirms a start that has already elapsed. Production dependencies (API helpers, router navigation, clock) are created **inside client components**; the Server page passes only serializable props. An availability window that has fully elapsed yields empty availability, never a backend error.

## Handoff assets (in-repo source of truth)

The FE handoff v1.0 (2026-09-20) is checked into the repository under `handoff/` (landed on main by PR #23; this revise PR does not touch it), so brand and copy bytes are reviewable in the git tree. Implementation copies **from these paths only** — there is no cloud-agent upload path in this work order.

```
handoff/
  README.md                        ← FE handoff v1.0 (brand rules, §3 architecture, §6 screens, §7 API contract)
  copy/en.json                     ← every user-facing string, ICU MessageFormat
  tokens/marlo.css                 ← design tokens + light/dark/surface theming (source of truth)
  tokens/tailwind.preset.js        ← same tokens for Tailwind (optional; Tailwind stays a non-goal this slice)
  assets/logo/marlo-mark.svg       ← icon, currentColor
  assets/logo/marlo-wordmark.svg   ← wordmark, currentColor
  marlo-scheduling-spec.md         ← product + backend spec v1.0 (reference only)
```

Origin of these bytes: Drive folder **Marlo Scheduling** → `marlo-scheduling-fe-handoff-v1.zip`. If the brand team ships new masters, update `handoff/**` in a docs PR first; implementation never edits `handoff/**`.

## Non-goals

- Host dashboard / NavRail / event-type editor
- Gmail extension, MJML emails, Storybook, Playwright E2E, Sentry, TanStack Query (unless a tiny helper is strictly required — prefer none)
- Live Google OAuth / Neon / real calendar — keep mocks and in-memory stubs
- Full a11y/Lighthouse gate from handoff §9 (basic keyboard focus is ok; axe is not required this slice)
- Changing existing backend booking semantics except **thin public route adapters** (e.g. a GET-by-id for confirmation). The past-slot cutoff (AC-7) lives in the public adapter/UI layer, **not** in `lib/booking` / `lib/availability` / existing route handlers
- Reschedule/cancel UI (`/b/{token}/reschedule`, `/b/{token}/cancel`)
- Adding Zod, Radix, `react-intl`, Tailwind, or date-fns **unless** CSS tokens + a tiny copy helper cannot ship the slice
- Editing `handoff/**` (design source of truth; docs PRs only)
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)
- Passing function-valued props (or any non-serializable value) from a Server Component into a Client Component — dependency injection is client→client only

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, live-Gmail, live-Google, or live-internet observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | `PLAN.md` on main describes this FE slice with APPROVED status (Founder go + VP Product, plan revise after Codex REVISE BOOK-FE-04/05, 20 Sep 2026 ET) and `PROOF_CMD`=`npm test`. `handoff/README.md`, `handoff/copy/en.json`, `handoff/tokens/marlo.css`, `handoff/assets/logo/marlo-mark.svg`, `handoff/assets/logo/marlo-wordmark.svg` exist in the git tree (already on main via PR #23). | This docs PR lands that text; the handoff files are already in the tree. Implementation PR does not rewrite the work order or edit `handoff/**`. Solely `PROOF_CMD` (`npm test`) — existing tests stay green on this docs-only change |
| AC-2 | Brand assets land in the app (Logo mark/wordmark via `currentColor` / tokens), copied from `handoff/assets/logo/*.svg` and `handoff/tokens/marlo.css`. Homepage or booking chrome uses cream/ink/lime tokens. Homepage is no longer placeholder-only as the sole public UX: it is branded and links to a bookable demo (`/demo/intro-30`). | Solely `PROOF_CMD` (`npm test`) — `tests/app.test.tsx` (and/or a booking-page render test) assert token/logo usage + demo link; no “placeholder-only” homepage; app token/copy files are byte-equal to (or a documented subset of) their `handoff/` sources |
| AC-3 | `lib/api` exports typed helpers for slots + create booking. `lib/api/DIVERGENCES.md` lists handoff §7 vs repo path/shape diffs (`/public/...` vs `/api/event-types/:slug/...`, `{ times }` vs `{ days }`, booking `id` vs `token`, `error` vs `code`). Components never call `fetch`. | Solely `PROOF_CMD` (`npm test`) — adapter unit tests + a grep/source assertion that `app/**/*.tsx` pages/components do not contain `fetch(` |
| AC-4 | **Real form interaction, not adapter-only.** On the booking page, selecting an available slot, filling name + email, and submitting **through the page's actual form/event handlers** creates a booking through the **existing** booking service and navigates to `/b/{token}`. The same UI path handles 409 `slot_unavailable`: error copy from `copy/en.json` (`details.errors.slotTaken`) is shown, availability is refreshed, and the stale selection is cleared. Mapping of 409 `{ error: "slot_unavailable" }` stays in `lib/api`. **RSC boundary:** the Server page (`page.tsx`) passes only serializable props (slugs, event meta, host meta, initial month); the production `api` / `navigate` / `now` are created inside a Client wrapper and injected client→client into the form component. No function-valued prop crosses Server→Client. | Solely `PROOF_CMD` (`npm test`) — `tests/booking-page.test.tsx` (`tsx --test`) renders the **client** form component (`BookingForm`, not the Server page) with an in-memory `api` stub, a recording `navigate`, and a fixed `now`, then drives the UI: select a slot → fill name/email → submit via the form's `onSubmit`/button handler (not by calling `createBooking` in isolation). Assert (a) the create-booking request payload / side-effect on the existing service (`{ start, invitee: { name, email } }`), (b) navigation to `/b/{token}` on 201, (c) on 409: rendered `details.errors.slotTaken` text, `getSlots` re-invoked, and no selected slot remains. Also assert (d) the Server page module (`app/(public)/[slug]/[event]/page.tsx`) source does not reference `getSlots`, `createBooking`, `useRouter`, or pass `api=` / `navigate=` / `now=` props — production deps live in the `'use client'` wrapper. A `tests/api-client.test.ts` adapter test alone does **not** satisfy this AC. No Playwright |
| AC-5 | Confirmation route `/b/{token}` renders for a booking token. Copy comes from `copy/en.json`. The page file must not contain a hard-coded `"Handled."` string. Brand tokens + Logo on the shell. | Solely `PROOF_CMD` (`npm test`) — render the confirmation page with a token; assert `copy.confirmation.headline` appears and the page source has no literal `Handled.` |
| AC-6 | Existing tests stay green. Add focused tests for adapter + booking UI/route (`tsx --test` style already used). `package.json` `test:unit` lists the new files. README documents the demo path `/demo/intro-30`. | Solely `PROOF_CMD` (`npm test`) — full existing suite + new files; README assertion for the demo slug/path |
| AC-7 | **Past-slot cutoff.** The public `getSlots` adapter (and/or the booking UI) never offers a start that has already elapsed relative to an injectable clock (`now`): current-month queries clamp `timeMin` to `now` (never to a start-of-month in the past), and returned `times` are filtered to `start >= now`. **Empty range:** when the clamped lower bound is `>= timeMax` (the whole requested window has elapsed), `getSlots` returns empty availability (`{ times: [] }` / no days) **without calling the backend** — it never sends an inverted range to the slot engine and never throws. The `createBooking` path **rechecks** that the selected start is still `>= now` immediately before calling the existing booking service; if it has elapsed, the UI takes the **same path as 409 `slot_unavailable`** (refresh slots + `details.errors.slotTaken` + clear selection) without calling `bookAvailableSlot`. **Month-boundary recovery:** on that refresh, if the displayed month's window end is `<= now`, the UI advances the displayed month to the month containing `now` before re-invoking `getSlots`; otherwise it stays on the displayed month. Existing backend fixture semantics (2026-09-20 slots in BOOK-core tests) are untouched. | Solely `PROOF_CMD` (`npm test`) — tests use a **fixed clock** (injectable `now`, no `Date.now()` mocking of the global): (a) with `now` mid-month, slots before `now` are not offered and the outgoing `timeMin` equals `now`, not the 1st; (b) a slot selected while `now` is before it, then `now` advanced past it on the details step, fails the recheck on submit and renders `details.errors.slotTaken` with refreshed slots and cleared selection; (c) existing `tests/booking.test.ts`, `tests/bookings-route.test.ts`, `tests/available-times.test.ts` pass unchanged; (d) **expired window:** `getSlots` with `now >= timeMax` returns empty availability and the backend stub/handler records zero calls; (e) **submit across a month boundary:** a slot selected in month M while `now` is in M, then `now` advanced into month M+1 before submit → recheck fails, `details.errors.slotTaken` renders, no `createBooking` call, and the refresh `getSlots` call carries the M+1 month window (displayed month advanced) — no thrown error or 500-shaped result anywhere in the path |

## Builder

BUILDER: claude — public App Router pages + `lib/api` adapters + branded CSS tokens + existing handler wiring fit the Claude implement lane. Inspector spirit: keep `proof` green. Judge: merge only when `npm test` passes.

## Approach

1. **Copy brand assets from in-repo `handoff/` into the app** (`handoff/` is the design source of truth; never edit it in the implementation PR):
   - `copy/en.json` ← `handoff/copy/en.json` (ICU keys, byte-copy). A tiny `lib/copy.ts` reader (`t(path, vars?)`) — no `react-intl` unless already present.
   - `app/tokens/marlo.css` (or `tokens/marlo.css` imported from `app/layout.tsx`) ← `handoff/tokens/marlo.css` (cream/ink/lime/slate tokens + `data-surface`).
   - Logo: inline SVG through `<Logo variant="mark" \| "wordmark" />` using `handoff/assets/logo/marlo-mark.svg` and `handoff/assets/logo/marlo-wordmark.svg` (`currentColor`, `color: var(--logo)`, no tile/background). Mark + wordmark files may live next to the component or under `src`/`app` paths that match Next conventions.
   - `handoff/tokens/tailwind.preset.js` is **not** copied (Tailwind is a non-goal this slice).
   - Import tokens + Google Fonts (Outfit display, Manrope text, `display=swap`) in `app/layout.tsx`. **Do not add Tailwind** unless CSS tokens cannot match the brand this slice; CSS tokens alone are the default.
2. **Demo seed** so Production is not an empty in-memory store:
   - `lib/demo/seed.ts` — `DEMO_HOST_SLUG = "demo"`, `DEMO_EVENT_SLUG = "intro-30"`. `ensureDemoFixtures()` creates (if missing) a weekly schedule (all weekdays 09:00–20:00 UTC so the demo stays bookable after 2026-09-20) and a 1:1 event type `intro-30` / “Intro call” / 30 min / `host-1`.
   - Call `ensureDemoFixtures()` from public booking page load and from the existing available-times GET + bookings POST (no-op if the slug already exists — tests that `resetEventTypes()` then seed their own `intro-30` stay valid).
   - Document `/demo/intro-30` in README.
3. **Routes (App Router)** — prefer handoff `(public)` group; must not break `/`, `/api/*`, `/host`, `/signin`:
   - `app/(public)/[slug]/[event]/page.tsx` — public booking (step 1 date/slot + step 2 name/email). URL `/demo/intro-30`. The `[event]` param is the **existing event-type slug**. `[slug]` is host/workspace chrome only (`demo`); it is not a new backend resource.
   - `app/(public)/b/[token]/page.tsx` — confirmation shell. Static `b` wins over `[slug]` for `/b/{token}`.
   - `app/page.tsx` — replace placeholder-only copy with branded cream/ink/lime landing (Logo + tokens + link to `/demo/intro-30`). Keep visible “Marlo Scheduling” so existing title assertions can be updated, not orphaned.
4. **`lib/api/` is the only module that knows the backend** (handoff §3 / §7):
   - Typed helpers: `getSlots({ slug, timeMin, timeMax, now? })`, `createBooking({ slug, start, invitee: { name, email }, now? })`, `getBooking(token)` (token = existing booking `id`). `now` defaults to `new Date()` and is injectable for tests (a `clock`/`now` parameter or a small `lib/api/clock.ts` with `setClockForTests`) — never mock the global `Date`.
   - **Past-slot cutoff (AC-7) lives here:** `getSlots` clamps `timeMin = max(timeMin, now)` and filters returned `times` to `start >= now`. **Empty-range guard (BOOK-FE-05):** if the clamped `timeMin >= timeMax`, `getSlots` short-circuits and returns empty availability (`{ times: [] }` — or the equivalent empty `days`) **without** calling the available-times handler or `lib/availability`; the existing slot engine must never receive `timeMin >= timeMax` from this adapter. `createBooking` rejects `start < now` **before** touching the backend, surfacing the same typed result as a 409 `slot_unavailable` so the UI has one error path.
   - UI-facing types may mirror handoff (`days` / `token` / `slot_unavailable` code) **or** a thin mapped shape — either is fine if adapters are the only place that know repo JSON.
   - Repo truths (do not invent `/public/...` routes):
     - `GET /api/event-types/:slug/available-times?timeMin&timeMax` → `{ times: string[] }` (group: `{ times: { start, spots_remaining }[] }`).
     - `POST /api/event-types/:slug/bookings` `{ start, invitee: { name, email } }` → 201 `{ booking }` (`id`, `start`, `end`, `status`, `invitee`) or 409 `{ error: "slot_unavailable" \| "session_full" }`.
   - **Thin adapter allowed:** `GET /api/bookings/[id]/route.ts` returning `getBooking(id)` so the confirmation page can load a token without changing create/reschedule/cancel semantics. If the in-memory row is missing (serverless), the confirmation **page still renders** the branded shell for that token (AC-5 is render, not persistence).
   - `lib/api/DIVERGENCES.md` logs every handoff vs repo path/shape diff (and notes that the past-slot cutoff is client-side because the backend fixtures are historical).
   - Server helpers may call existing `lib/booking` / `lib/availability` functions or the route handlers. Client helpers may `fetch` the existing `/api/...` paths. **`app/**` components/pages never call `fetch`.**
5. **Booking UI (handoff 6.1–6.2 spirit, time-boxed) — must be testable as a real form under `tsx --test`:**
   - Cream page, wordmark header, white card, host/event meta, month/date picker of days that have slots, slot list, name + email fields, primary CTA using `details.submit` (“Lock it in”).
   - Slots from `getSlots` over a month window (current month clamped to `now`); group `times` by local date. Keyboard-focusable controls (no axe gate).
   - **Component split (BOOK-FE-04 — no function props across the Server→Client boundary):**
     - `app/(public)/[slug]/[event]/page.tsx` — **Server Component.** Does only serializable work: `await ensureDemoFixtures()`, resolves the event type / host meta, and renders `<BookingClient slug={slug} event={event} eventMeta={...} initialMonth="YYYY-MM" />` with **plain data props only** (strings, numbers, plain objects). It must not import `lib/api` client helpers, `useRouter`, or pass `api` / `navigate` / `now`.
     - `app/(public)/[slug]/[event]/BookingClient.tsx` — `'use client'` wrapper. Creates the production dependencies **inside the client bundle**: `api = { getSlots, createBooking }` from `lib/api` (client helpers that `fetch` the existing `/api/...` routes), `navigate = (href) => router.push(href)` via `useRouter()` from `next/navigation`, and `now = () => new Date()`. Renders `<BookingForm ... api={api} navigate={navigate} now={now} />`.
     - `app/(public)/[slug]/[event]/BookingForm.tsx` — `'use client'` presentational + stateful form. Receives `api`, `navigate`, `now` **by props from its client parent** (no defaults that reach for globals). This is the unit `tests/booking-page.test.tsx` renders directly with an in-memory `api` + recording `navigate` + fixed `now` and no browser. Dependency injection is client→client only; RSC serialization is never asked to carry a function.
   - On submit: recheck `selectedStart >= now()`; if elapsed, treat as `slot_unavailable` (no backend call). Otherwise call `createBooking`.
   - On 201: `navigate('/b/{booking.id}')` (map `id` → token in the adapter).
   - On 409 `slot_unavailable` (or elapsed recheck): show `details.errors.slotTaken` from copy; re-invoke `getSlots`; clear the selected slot so the invitee must pick again.
   - **Recovery across a month boundary (BOOK-FE-05):** before that refresh `getSlots` call, compare the displayed month's window end (`timeMax`) with `now()`. If `timeMax <= now()`, set the displayed month to the month containing `now()` and query that window (clamped to `now()`); otherwise keep the displayed month. Either way the adapter's empty-range guard means a fully elapsed window renders as empty availability (no days / no slots), never a thrown error.
   - No hard-coded user-facing English in page/component files — keys from `copy/en.json`.
6. **Confirmation UI (handoff 6.3 spirit, can be a minimal shell):** lime/`data-surface="lime"` panel, Logo, headline from `confirmation.headline`, subhead from `confirmation.subhead` (substitute host/email when the booking row exists). Page file must not contain the string `Handled.`
7. **Tests** (`tsx --test`, same runner). Add files and append them to `package.json` `test:unit`:
   - `tests/api-client.test.ts` — `getSlots` / `createBooking` map to existing handlers; 201 + 409 `slot_unavailable`; DIVERGENCES.md exists and mentions `/public/` vs `/api/event-types`. **AC-7 adapter cases** with a fixed `now`: `timeMin` clamped to `now` for the current month; elapsed starts filtered out; `createBooking` with `start < now` returns the `slot_unavailable`-shaped result without calling the backend; **expired window:** `getSlots` with `now >= timeMax` (e.g. a whole prior month) returns empty availability and the backend stub / available-times handler records **zero** calls (no inverted range reaches the slot engine).
   - `tests/booking-page.test.tsx` — **AC-4 real interaction**: render the booking form with an in-memory `api` stub (or the existing route handlers behind the adapter), a recording `navigate`, and a fixed `now`. Select a slot, set name/email, invoke the form's submit handler. Assert the payload the form sent, the booking side-effect (`listConfirmedBookingsForHost` or the stub's call log), and `navigate('/b/{id}')`. Then the 409 case through the same handler: `details.errors.slotTaken` text rendered, `getSlots` called again, selection cleared. **AC-7 UI cases**: select a slot with `now` before it, advance the fixed clock past it, submit → recheck fails, same slotTaken path, no `createBooking` call; **month boundary:** select a slot in month M with `now` in M, advance the fixed clock into M+1, submit → recheck fails, slotTaken renders, no `createBooking` call, and the recovery `getSlots` call is for the M+1 window (displayed month advanced); with the `api` stub returning `{ times: [] }` the form renders an empty state rather than throwing. **BOOK-FE-04 boundary check:** the tests render `BookingForm` (client) directly; a source assertion on `page.tsx` confirms it passes no `api=` / `navigate=` / `now=` props and does not import `useRouter` or the client `lib/api` helpers. Also: branded chrome + copy keys render; source of `app/**/*.tsx` has no `fetch(`. Driving the handler may use `react-dom/server` for markup assertions plus direct invocation of the component's exported submit/select handlers, or a minimal DOM shim; **no Playwright, no browser**.
   - `tests/confirmation.test.tsx` — `/b/{token}` markup includes `copy.confirmation.headline` and the page module source has no `Handled.`
   - Update `tests/app.test.tsx`: homepage is branded (tokens and/or Logo) and links to `/demo/intro-30`; drop the “placeholder copy” assertion.
   - Update `tests/host.test.tsx` public-path list to include `/demo/intro-30` and `/b/` as public.
   - Update README (`GET /` is branded + demo path). Keep env-name assertions. Do not change `PROOF_CMD`. Do not edit `.github/`. Do not edit `handoff/**`.
8. Auth: booking + confirmation + demo homepage stay public. If an AC cannot be observed without live Google/Neon, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026). Stack remains Next/Vercel/in-memory stubs. This slice does not add a real DB or live calendar.
- Founder + VP Product GO 20 Sep 2026 ET; plan revised the same day after Codex BLOCKED (BOOK-FE-01/02/03, PR #23) and again after the IMPL-dispatch Codex REVISE (BOOK-FE-04/05, this PR). This PLAN is the next dispatched work order, not a product-reopen. It supersedes `f89d9b4` / PR #23.
- FE handoff v1 (2026-09-20) is the brand/UI source of truth and is checked in under `handoff/`. Handoff §7 `/public/event_types/.../slots` and `/public/bookings` **are not implemented in this repo**. Existing routes in `app/api/event-types/[slug]/available-times` and `.../bookings` plus `lib/booking/booking.ts` are the contract. Adapters absorb the mismatch.
- Booking `id` is the confirmation token. Do not add a second token column this slice.
- In-memory event types/bookings do not persist across Vercel isolates. Seed-on-request makes the **demo event type** visible; a confirmation page must still render if `getBooking(token)` is null.
- Existing BOOK-core fixtures book `2026-09-20T09:00:00.000Z` and similar historical starts. The backend must keep accepting them; the past-slot cutoff is enforced only in `lib/api` / the booking UI with an injectable clock. **Do not** add `now` checks to `lib/booking`, `lib/availability`, or the existing route handlers.
- Risk: putting booking at `app/[slug]/[event]` without a static `app/b/[token]` would steal `/b/{token}` — use the static `b` segment.
- Risk: seeding `intro-30` inside `resetEventTypes()` would break tests that expect an empty store — seed only via `ensureDemoFixtures()` when the slug is missing.
- Risk: calling `fetch` from a component would violate AC-3 — keep it in `lib/api`.
- Risk: a hard-coded `"Handled."` in the confirmation page file fails AC-5 even if the rendered text is correct.
- Risk: adding Tailwind/Zod/TanStack/Playwright would violate non-goals unless strictly required (it is not).
- Risk: changing POST body semantics or 409 codes would break existing BOOK-core tests — adapt in `lib/api` only.
- Risk: a booking form whose submit handler is not reachable from a test (e.g. only wired through a browser-only hook) cannot satisfy AC-4 — inject `api`/`navigate`/`now` via props **from a client parent**.
- Risk (BOOK-FE-04): passing `api` / `navigate` / `now` (functions) from the Server `page.tsx` into a Client Component fails at runtime — RSC serialization rejects ordinary functions (“Functions cannot be passed directly to Client Components”). Create them in `BookingClient.tsx` (`'use client'`); `page.tsx` passes only strings/numbers/plain objects.
- Risk (BOOK-FE-05): clamping `timeMin` to `now` without an empty-range guard can produce `timeMin >= timeMax` (e.g. the displayed month has fully elapsed, or a 409/elapsed recovery fires after a month boundary); the slot engine throws on an inverted range and the recovery path 500s instead of showing empty availability — short-circuit in `getSlots` and advance the displayed month on recovery.
- Risk: using `Date.now()` directly in the adapter or form makes AC-7 tests flaky and, on 2026-09-20 itself, could hide the fixture slots — always read the injected clock.
- Risk: leaving the homepage “Placeholder — the first scheduling slice is on the way.” as the only public UX fails AC-2.
- Risk: sourcing brand/copy from any cloud-agent upload path or anything outside the git tree fails AC-1/AC-2 — only in-repo `handoff/**` is the source.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-2..7 and the existing OAuth/availability/BOOK-core/BOOK-lifecycle/notification/OFF/WH/GRP/COL/scaffold checks (branded home + demo link, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + create/patch/delete fixture, schedule/event-type stubs, slot engine, available-times GET, booking create/reschedule/cancel + 409 race, notificationMode + EmailProvider mock + notification_log, one-off windows + single-use 410, webhook HMAC + lifecycle emit + retry stub, group capacity + last-spot `session_full`, collective intersection + all-hosts booking, README env names + demo path, real-form submit → `/b/{token}` + 409 path, past-slot cutoff with fixed clock, expired-window empty availability without a backend call, month-boundary recovery, Server page passes no function props). No live Gmail. No live Google. No live internet HTTP. No axe/Lighthouse/Playwright gate this slice.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
