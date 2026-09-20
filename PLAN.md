> Supersedes the completed COL PLAN (shipped @ `f67bafc`, PLAN PR #20 @ `e6a4c92`). That slice is done: `kind: "collective"` + multi-host intersection + all-hosts booking. This work order is the next v1 slice only — **public booking page front-end (BOOK-FE)**.

# PLAN — Public booking page front-end (BOOK-FE)

Spec owner: Shahar + VP of Product · Product review: Shahar + Grok · Status: APPROVED Founder go + VP Product, 20 Sep 2026 ET

## Goal

An invitee can open a **public booking route**, pick a date/slot, enter name/email, and confirm a booking — **Marlo-branded UI** from the FE handoff — wired to the **existing** in-repo booking APIs. `https://marlo-scheduling.vercel.app` is no longer a placeholder-only homepage: `/` is branded cream/ink/lime chrome that links to a bookable demo, and `/{slug}/{event}` is a real booking page. After confirm, `/b/{token}` shows a branded “Handled.” confirmation shell. All handoff↔repo mapping lives in `lib/api/` (components never `fetch`).

## Non-goals

- Host dashboard / NavRail / event-type editor
- Gmail extension, MJML emails, Storybook, Playwright E2E, Sentry, TanStack Query (unless a tiny helper is strictly required — prefer none)
- Live Google OAuth / Neon / real calendar — keep mocks and in-memory stubs
- Full a11y/Lighthouse gate from handoff §9 (basic keyboard focus is ok; axe is not required this slice)
- Changing existing backend booking semantics except **thin public route adapters** (e.g. a GET-by-id for confirmation)
- Reschedule/cancel UI (`/b/{token}/reschedule`, `/b/{token}/cancel`)
- Adding Zod, Radix, `react-intl`, Tailwind, or date-fns **unless** CSS tokens + a tiny copy helper cannot ship the slice
- Changing `.github/`, branch protection, or the `PROOF_CMD` name (`npm test` stays)

## Acceptance criteria

Every criterion is observed **only** via `PROOF_CMD` (`npm test`). The existing proof harness already folds typecheck + `next build` + unit tests into `npm test` (`scripts/proof.cjs`); keep that. No manual, curl-only, preview-URL, live-Gmail, live-Google, or live-internet observation.

| ID | Criterion | How it is observed |
|---|---|---|
| AC-1 | `PLAN.md` on main describes this FE slice with APPROVED status (Founder go + VP Product, 20 Sep 2026 ET) and `PROOF_CMD`=`npm test`. | This docs PR lands that text. Implementation PR does not rewrite the work order. Solely `PROOF_CMD` (`npm test`) — existing tests stay green on this docs-only change |
| AC-2 | Brand assets land (Logo mark/wordmark via `currentColor` / tokens). Homepage or booking chrome uses cream/ink/lime tokens. Homepage is no longer placeholder-only as the sole public UX: it is branded and links to a bookable demo (`/demo/intro-30`). | Solely `PROOF_CMD` (`npm test`) — `tests/app.test.tsx` (and/or a booking-page render test) assert token/logo usage + demo link; no “placeholder-only” homepage |
| AC-3 | `lib/api` exports typed helpers for slots + create booking. `lib/api/DIVERGENCES.md` lists handoff §7 vs repo path/shape diffs (`/public/...` vs `/api/event-types/:slug/...`, `{ times }` vs `{ days }`, booking `id` vs `token`, `error` vs `code`). Components never call `fetch`. | Solely `PROOF_CMD` (`npm test`) — adapter unit tests + a grep/source assertion that `app/**/*.tsx` pages/components do not contain `fetch(` |
| AC-4 | Selecting an available slot and submitting name+email creates a booking through the **existing** booking service. Happy path 201 + 409 `slot_unavailable` are covered. Mapping of 409 `{ error: "slot_unavailable" }` stays in `lib/api`. | Solely `PROOF_CMD` (`npm test`) — adapter + route tests call the existing POST handler (or `bookAvailableSlot`) via `lib/api`; assert 201 confirmed + 409 `slot_unavailable` |
| AC-5 | Confirmation route `/b/{token}` renders for a booking token. Copy comes from `copy/en.json`. The page file must not contain a hard-coded `"Handled."` string. Brand tokens + Logo on the shell. | Solely `PROOF_CMD` (`npm test`) — render the confirmation page with a token; assert `copy.confirmation.headline` appears and the page source has no literal `Handled.` |
| AC-6 | Existing tests stay green. Add focused tests for adapter + booking UI/route (`tsx --test` style already used). `package.json` `test:unit` lists the new files. README documents the demo path `/demo/intro-30`. | Solely `PROOF_CMD` (`npm test`) — full existing suite + new files; README assertion for the demo slug/path |

## Builder

BUILDER: claude — public App Router pages + `lib/api` adapters + branded CSS tokens + existing handler wiring fit the Claude implement lane. Inspector spirit: keep `proof` green. Judge: merge only when `npm test` passes.

## Approach

1. **Copy brand assets into the app** (handoff is the design source of truth):
   - `copy/en.json` ← uploads/handoff copy (ICU keys). A tiny `lib/copy.ts` reader (`t(path, vars?)`) — no `react-intl` unless already present.
   - `app/tokens/marlo.css` (or `tokens/marlo.css` imported from `app/layout.tsx`) ← cream/ink/lime/slate tokens + `data-surface`.
   - Logo: inline SVG through `<Logo variant="mark" \| "wordmark" />` using the handoff SVGs (`currentColor`, `color: var(--logo)`, no tile/background). Mark + wordmark files may live next to the component or under `src`/`app` paths that match Next conventions.
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
   - Typed helpers: `getSlots({ slug, timeMin, timeMax })`, `createBooking({ slug, start, invitee: { name, email } })`, `getBooking(token)` (token = existing booking `id`).
   - UI-facing types may mirror handoff (`days` / `token` / `slot_unavailable` code) **or** a thin mapped shape — either is fine if adapters are the only place that know repo JSON.
   - Repo truths (do not invent `/public/...` routes):
     - `GET /api/event-types/:slug/available-times?timeMin&timeMax` → `{ times: string[] }` (group: `{ times: { start, spots_remaining }[] }`).
     - `POST /api/event-types/:slug/bookings` `{ start, invitee: { name, email } }` → 201 `{ booking }` (`id`, `start`, `end`, `status`, `invitee`) or 409 `{ error: "slot_unavailable" \| "session_full" }`.
   - **Thin adapter allowed:** `GET /api/bookings/[id]/route.ts` returning `getBooking(id)` so the confirmation page can load a token without changing create/reschedule/cancel semantics. If the in-memory row is missing (serverless), the confirmation **page still renders** the branded shell for that token (AC-5 is render, not persistence).
   - `lib/api/DIVERGENCES.md` logs every handoff vs repo path/shape diff.
   - Server helpers may call existing `lib/booking` / `lib/availability` functions or the route handlers. Client helpers may `fetch` the existing `/api/...` paths. **`app/**` components/pages never call `fetch`.**
5. **Booking UI (handoff 6.1–6.2 spirit, time-boxed):**
   - Cream page, wordmark header, white card, host/event meta, month/date picker of days that have slots, slot list, name + email fields, primary CTA using `details.submit` (“Lock it in”).
   - Slots from `getSlots` over a month window; group `times` by local date. Keyboard-focusable controls (no axe gate).
   - On 201: navigate to `/b/{booking.id}` (map `id` → token in the adapter).
   - On 409 `slot_unavailable`: show `details.errors.slotTaken` from copy; refresh slots.
   - No hard-coded user-facing English in page/component files — keys from `copy/en.json`.
6. **Confirmation UI (handoff 6.3 spirit, can be a minimal shell):** lime/`data-surface="lime"` panel, Logo, headline from `confirmation.headline`, subhead from `confirmation.subhead` (substitute host/email when the booking row exists). Page file must not contain the string `Handled.`
7. **Tests** (`tsx --test`, same runner). Add files and append them to `package.json` `test:unit`:
   - `tests/api-client.test.ts` — `getSlots` / `createBooking` map to existing handlers; 201 + 409 `slot_unavailable`; DIVERGENCES.md exists and mentions `/public/` vs `/api/event-types`.
   - `tests/booking-page.test.tsx` — booking page renders branded chrome + copy keys; submitting via the helper creates a booking; source of `app/**/*.tsx` has no `fetch(`.
   - `tests/confirmation.test.tsx` — `/b/{token}` markup includes `copy.confirmation.headline` and the page module source has no `Handled.`
   - Update `tests/app.test.tsx`: homepage is branded (tokens and/or Logo) and links to `/demo/intro-30`; drop the “placeholder copy” assertion.
   - Update `tests/host.test.tsx` public-path list to include `/demo/intro-30` and `/b/` as public.
   - Update README (`GET /` is branded + demo path). Keep env-name assertions. Do not change `PROOF_CMD`. Do not edit `.github/`.
8. Auth: booking + confirmation + demo homepage stay public. If an AC cannot be observed without live Google/Neon, report it as impossible rather than adding a manual AC.

## Assumptions and risks

- Phase 0 locks **D-01..D-05** (v1 packet APPROVED 19 Sep 2026). Stack remains Next/Vercel/in-memory stubs. This slice does not add a real DB or live calendar.
- Founder + VP Product GO 20 Sep 2026 ET: this PLAN is the next dispatched work order, not a product-reopen. It supersedes `f67bafc` / PR #20’s completed COL PLAN.
- FE handoff v1 (2026-09-20) is the brand/UI source of truth. Handoff §7 `/public/event_types/.../slots` and `/public/bookings` **are not implemented in this repo**. Existing routes in `app/api/event-types/[slug]/available-times` and `.../bookings` plus `lib/booking/booking.ts` are the contract. Adapters absorb the mismatch.
- Booking `id` is the confirmation token. Do not add a second token column this slice.
- In-memory event types/bookings do not persist across Vercel isolates. Seed-on-request makes the **demo event type** visible; a confirmation page must still render if `getBooking(token)` is null.
- Risk: putting booking at `app/[slug]/[event]` without a static `app/b/[token]` would steal `/b/{token}` — use the static `b` segment.
- Risk: seeding `intro-30` inside `resetEventTypes()` would break tests that expect an empty store — seed only via `ensureDemoFixtures()` when the slug is missing.
- Risk: calling `fetch` from a component would violate AC-3 — keep it in `lib/api`.
- Risk: a hard-coded `"Handled."` in the confirmation page file fails AC-5 even if the rendered text is correct.
- Risk: adding Tailwind/Zod/TanStack/Playwright would violate non-goals unless strictly required (it is not).
- Risk: changing POST body semantics or 409 codes would break existing BOOK-core tests — adapt in `lib/api` only.
- Risk: leaving the homepage “Placeholder — the first scheduling slice is on the way.” as the only public UX fails AC-2.

## Verification

```text
PROOF_CMD: npm test
```

`PROOF_CMD` remains exactly `npm test`. Green (exit code 0) means typecheck + `next build` + unit tests all pass, including AC-2..6 and the existing OAuth/availability/BOOK-core/BOOK-lifecycle/notification/OFF/WH/GRP/COL/scaffold checks (branded home + demo link, `/api/health`, Auth.js Google provider, host redirect, calendar stub, freeBusy + create/patch/delete fixture, schedule/event-type stubs, slot engine, available-times GET, booking create/reschedule/cancel + 409 race, notificationMode + EmailProvider mock + notification_log, one-off windows + single-use 410, webhook HMAC + lifecycle emit + retry stub, group capacity + last-spot `session_full`, collective intersection + all-hosts booking, README env names + demo path). No live Gmail. No live Google. No live internet HTTP. No axe/Lighthouse/Playwright gate this slice.

## Round budget

MAX_JUDGE_ROUNDS: 3 · MAX_FIX_ROUNDS (proof retries per round): 2 · Escalate to Shahar on exhaustion.
