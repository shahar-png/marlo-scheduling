> Supersedes the BOOK-FE PLAN on main @ `9124f9a` (PR #22), which Codex plan review marked **BLOCKED** (agent-os exit 2) on three findings: BOOK-FE-01 handoff assets not in-repo, BOOK-FE-02 no past-slot cutoff, BOOK-FE-03 AC-4 allowed adapter-only observation. This revise addresses all three. The completed COL slice (shipped @ `f67bafc`) is unchanged. This work order is the next v1 slice only — **public booking page front-end (BOOK-FE)**.

# PLAN — Public booking page front-end (BOOK-FE)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Plan review: Codex (BLOCKED → revised) · Status: APPROVED Founder go + VP Product (plan revise after Codex BLOCKED), 20 Sep 2026 ET

## Goal

An invitee can open a **public booking route**, pick a date/slot, enter name/email, and confirm a booking — **Marlo-branded UI** from the FE handoff — wired to the **existing** in-repo booking APIs. `https://marlo-scheduling.vercel.app` is no longer a placeholder-only homepage: `/` is branded cream/ink/lime chrome that links to a bookable demo, and `/{slug}/{event}` is a real booking page. After confirm, `/b/{token}` shows a branded “Handled.” confirmation shell. All handoff↔repo mapping lives in `lib/api/` (components never `fetch`). The page never offers or confirms a start that has already elapsed.

## Handoff assets (in-repo source of truth)

The FE handoff v1.0 (2026-09-20) is checked into the repository under `handoff/` by this PLAN PR, so brand and copy bytes are reviewable in the git tree. Implementation copies **from these paths only** — there is no cloud-agent upload path in this work order.

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

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, live-Gmail, live-Google, or live-internet observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | `PLAN.md` on main describes this FE slice with APPROVED status (Founder go + VP Product, plan revise after Codex BLOCKED, 20 Sep 2026 ET) and `PROOF_CMD`=`npm test`. `handoff/README.md`, `handoff/copy/en.json`, `handoff/tokens/marlo.css`, `handoff/assets/logo/marlo-mark.svg`, `handoff/assets/logo/marlo-wordmark.svg` exist in the git tree. | This docs+assets PR lands that text and those files. Implementation PR does not rewrite the work order or edit `handoff/**`. Solely `PROOF_CMD` (`npm test`) — existing tests stay green on this docs+assets change |
| AC-2 | Brand assets land in the app (Logo mark/wordmark via `currentColor` / tokens), copied from `handoff/assets/logo/*.svg` and `handoff/tokens/marlo.css`. Homepage or booking chrome uses cream/ink/lime tokens. Homepage is no longer placeholder-only as the sole public UX: it is branded and links to a bookable demo (`/demo/intro-30`). | Solely `PROOF_CMD` (`npm test`) — `tests/app.test.tsx` (and/or a booking-page render test) assert token/logo usage + demo link; no “placeholder-only” homepage; app token/copy files are byte-equal to (or a documented subset of) their `handoff/` sources |
| AC-3 | `lib/api` exports typed helpers for slots + create booking. `lib/api/DIVERGENCES.md` lists handoff §7 vs repo path/shape diffs (`/public/...` vs `/api/event-types/:slug/...`, `{ times }` vs `{ days }`, booking `id` vs `token`, `error` vs `code`). Components never call `fetch`. | Solely `PROOF_CMD` (`npm test`) — adapter unit tests + a grep/source assertion that `app/**/*.tsx` pages/components do not contain `fetch(` |
| AC-4 | **Real form interaction, not adapter-only.** On the booking page, selecting an available slot, filling name + email, and submitting **through the page's actual form/event handlers** creates a booking through the **existing** booking service and navigates to `/b/{token}`. The same UI path handles 409 `slot_unavailable`: error copy from `copy/en.json` (`details.errors.slotTaken`) is shown, availability is refreshed, and the stale selection is cleared. Mapping of 409 `{ error: "slot_unavailable" }` stays in `lib/api`. | Solely `PROOF_CMD` (`npm test`) — `tests/booking-page.test.tsx` (`tsx --test`) drives the UI: select a slot → fill name/email → submit via the form's `onSubmit`/button handler (not by calling `createBooking` in isolation). Assert (a) the create-booking request payload / side-effect on the existing service (`{ start, invitee: { name, email } }`), (b) navigation to `/b/{token}` on 201, (c) on 409: rendered `details.errors.slotTaken` text, `getSlots` re-invoked, and no selected slot remains. A `tests/api-client.test.ts` adapter test alone does **not** satisfy this AC. No Playwright |
| AC-5 | Confirmation route `/b/{token}` renders for a booking token. Copy comes from `copy/en.json`. The page file must not contain a hard-coded `"Handled."` string. Brand tokens + Logo on the shell. | Solely `PROOF_CMD` (`npm test`) — render the confirmation page with a token; assert `copy.confirmation.headline` appears and the page source has no literal `Handled.` |
| AC-6 | Existing tests stay green. Add focused tests for adapter + booking UI/route (`tsx --test` style already used). `package.json` `test:unit` lists the new files. README documents the demo path `/demo/intro-30`. | Solely `PROOF_CMD` (`npm test`) — full existing suite + new files; README assertion for the demo slug/path |
| AC-7 | **Past-slot cutoff.** The public `getSlots` adapter (and/or the booking UI) never offers a start that has already elapsed relative to an injectable clock (`now`): current-month queries clamp `timeMin` to `now` (never to a start-of-month in the past), and returned `times` are filtered to `start >= now`. The `createBooking` path **rechecks** that the selected start is still `>= now` immediately before calling the existing booking service; if it has elapsed, the UI takes the **same path as 409 `slot_unavailable`** (refresh slots + `details.errors.slotTaken` + clear selection) without calling `bookAvailableSlot`. Existing backend fixture semantics (2026-09-20 slots in BOOK-core tests) are untouched. | Solely `PROOF_CMD` (`npm test`) — tests use a **fixed clock** (injectable `now`, no `Date.now()` mocking of the global): (a) with `now` mid-month, slots before `now` are not offered and the outgoing `timeMin` equals `now`, not the 1st; (b) a slot selected while `now` is before it, then `now` advanced past it on the details step, fails the recheck on submit and renders `details.errors.slotTaken` with refreshed slots and cleared selection; (c) existing `tests/booking.test.ts`, `tests/bookings-route.test.ts`, `tests/available-times.test.ts` pass unchanged |

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
   - **Past-slot cutoff (AC-7) lives here:** `getSlots` clamps `timeMin = max(timeMin, now)` and filters returned `times` to `start >= now`. `createBooking` rejects `start < now` **before** touching the backend, surfacing the same typed result as a 409 `slot_unavailable` so the UI has one error path.
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
   - Structure the interactive part as a client component (e.g. `app/(public)/[slug]/[event]/BookingForm.tsx`) that receives its dependencies by props — `api: { getSlots, createBooking }`, `navigate(href)`, and `now()` — with production defaults wired in `page.tsx`. This is what lets `tests/booking-page.test.tsx` drive the real `onSubmit` handler with an in-memory `api` + a fixed clock and no browser.
   - On submit: recheck `selectedStart >= now()`; if elapsed, treat as `slot_unavailable` (no backend call). Otherwise call `createBooking`.
   - On 201: `navigate('/b/{booking.id}')` (map `id` → token in the adapter).
   - On 409 `slot_unavailable` (or elapsed recheck): show `details.errors.slotTaken` from copy; re-invoke `getSlots`; clear the selected slot so the invitee must pick again.
   - No hard-coded user-facing English in page/component files — keys from `copy/en.json`.
6. **Confirmation UI (handoff 6.3 spirit, can be a minimal shell):** lime/`data-surface="lime"` panel, Logo, headline from `confirmation.headline`, subhead from `confirmation.subhead` (substitute host/email when the booking row exists). Page file must not contain the string `Handled.`
7. **Tests** (`tsx --test`, same runner). Add files and append them to `package.json` `test:unit`:
   - `tests/api-client.test.ts` — `getSlots` / `createBooking` map to existing handlers; 201 + 409 `slot_unavailable`; DIVERGENCES.md exists and mentions `/public/` vs `/api/event-types`. **AC-7 adapter cases** with a fixed `now`: `timeMin` clamped to `now` for the current month; elapsed starts filtered out; `createBooking` with `start < now` returns the `slot_unavailable`-shaped result without calling the backend.
   - `tests/booking-page.test.tsx` — **AC-4 real interaction**: render the booking form with an in-memory `api` stub (or the existing route handlers behind the adapter), a recording `navigate`, and a fixed `now`. Select a slot, set name/email, invoke the form's submit handler. Assert the payload the form sent, the booking side-effect (`listConfirmedBookingsForHost` or the stub's call log), and `navigate('/b/{id}')`. Then the 409 case through the same handler: `details.errors.slotTaken` text rendered, `getSlots` called again, selection cleared. **AC-7 UI case**: select a slot with `now` before it, advance the fixed clock past it, submit → recheck fails, same slotTaken path, no `createBooking` call. Also: branded chrome + copy keys render; source of `app/**/*.tsx` has no `fetch(`. Driving the handler may use `react-dom/server` for markup assertions plus direct invocation of the component's exported submit/select handlers, or a minimal DOM shim; **no Playwright, no browser**.
   - `tests/confirmation.test.tsx` — `/b/{token}` markup includes `copy.confirmation.headline` and the page module source has no `Handled.`
   - Update `tests/app.test.tsx`: homepage is branded (tokens and/or Logo) and links to `/demo/intro-30`; drop the “placeholder copy” assertion.
   - Update `tests/host.test.tsx` public-path list to include `/demo/intro-30` and `/b/` as public.
   - Update README (`GET /` is branded + demo path). Keep env-name assertions. Do not change `PROOF_CMD`. Do not edit `.github/`. Do not edit `handoff/**`.
8. Auth: booking + confirmation + demo homepage stay public. If an AC cannot be observed without live Google/Neon, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026). Stack remains Next/Vercel/in-memory stubs. This slice does not add a real DB or live calendar.
- Founder + VP Product GO 20 Sep 2026 ET; plan revised the same day after Codex BLOCKED (BOOK-FE-01/02/03). This PLAN is the next dispatched work order, not a product-reopen. It supersedes `9124f9a` / PR #22.
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
- Risk: a booking form whose submit handler is not reachable from a test (e.g. only wired through a browser-only hook) cannot satisfy AC-4 — inject `api`/`navigate`/`now` via props.
- Risk: using `Date.now()` directly in the adapter or form makes AC-7 tests flaky and, on 2026-09-20 itself, could hide the fixture slots — always read the injected clock.
- Risk: leaving the homepage “Placeholder — the first scheduling slice is on the way.” as the only public UX fails AC-2.
- Risk: sourcing brand/copy from any cloud-agent upload path or anything outside the git tree fails AC-1/AC-2 — only in-repo `handoff/**` is the source.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-2..7 and the existing OAuth/availability/BOOK-core/BOOK-lifecycle/notification/OFF/WH/GRP/COL/scaffold checks (branded home + demo link, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + create/patch/delete fixture, schedule/event-type stubs, slot engine, available-times GET, booking create/reschedule/cancel + 409 race, notificationMode + EmailProvider mock + notification_log, one-off windows + single-use 410, webhook HMAC + lifecycle emit + retry stub, group capacity + last-spot `session_full`, collective intersection + all-hosts booking, README env names + demo path, real-form submit → `/b/{token}` + 409 path, past-slot cutoff with fixed clock). No live Gmail. No live Google. No live internet HTTP. No axe/Lighthouse/Playwright gate this slice.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
