# marlo-scheduling

Built by the OLI Agent OS loop with no human merge: `PLAN.md` → plan review → build → `PROOF_CMD` → inspect → judge → PR → CI (`proof`) → auto-merge → deploy.

## Local development

```bash
npm ci
npm test
npm run dev
```

- `npm ci` — install dependencies from the lockfile on a clean checkout
- `npm test` — PROOF_CMD: typecheck, `next build`, and automated tests
- `npm run dev` — start the Next.js App Router app locally

`GET /` serves the branded Marlo Scheduling landing page (cream/ink/lime tokens, Logo) and links to the bookable demo. `GET /api/health` returns `{ "ok": true }`.

## Public booking (demo)

- `/demo/intro-30` — public booking page for the seeded demo event type (`intro-30`, "Intro call", 30 min, weekdays 09:00–20:00 UTC). The demo fixtures are seeded on request (`lib/demo/seed.ts`) so the in-memory store is never empty in production.
- `/b/{token}` — branded confirmation shell after a booking (token = booking id). It renders even when the in-memory row is missing on another serverless isolate, and it branches on the booking's `status`: a row cancelled through the existing cancel route shows the cancellation copy (with a "book again" link only when the event type is a reusable, store-backed one with a representable slug — a cancelled one-off booking omits the link). A row whose `hostId` has no canonical host (only `host-1` / `demo` / Marlo this slice) renders the not-found shell rather than being attributed to Marlo.
- Host chrome on both pages comes from the canonical host of the event being booked (`hostMetaForHostId` in `lib/demo/seed.ts`), never from the URL: `/alice/intro-30` redirects to `/demo/intro-30`. Every public path is built by `lib/api/public-path.ts`, which percent-encodes representable slugs and rejects `/`, `\`, `?`, `#`, control characters, `.`, `..` — such an event type has no public page, no book-again link, and triggers no backend request.
- The picker has one notion of "month": the invitee's browser time zone (resolved on the client after mount). The month window sent to the backend is widened by the event duration in `lib/api` because the slot engine bounds meetings by their *end*; email syntax is validated in the form before any request.
- Brand assets are copied from the in-repo handoff (`handoff/` is the design source of truth; never edit it in an implementation PR): `copy/en.json`, `app/tokens/marlo.css`, and the inline SVG `Logo` in `app/components/Logo.tsx`.
- `lib/api/` is the only module that knows the backend routes; components never call `fetch`. Handoff §7 vs repo differences (paths, shapes, the missing idempotency key) are logged in `lib/api/DIVERGENCES.md`.

## Environment variables

Set these names in the host environment (Vercel / local `.env`). Do not commit secret values.

- `AUTH_SECRET` — Auth.js session secret
- `AUTH_GOOGLE_ID` — Google OAuth client id (Workspace Internal app for myoli.co)
- `AUTH_GOOGLE_SECRET` — Google OAuth client secret

The Google OAuth app is Internal to the `myoli.co` Workspace. Sign-in also allowlists that hosted domain (`hd`) in code.

Future Gmail send (not used in this slice — names only, no values; confirmation mail stays on the `EmailProvider` mock):

- `GMAIL_CLIENT_ID` — Google Cloud OAuth client id for Gmail API
- `GMAIL_CLIENT_SECRET` — Google Cloud OAuth client secret for Gmail API
- `GMAIL_REFRESH_TOKEN` — offline refresh token for the sending mailbox
- `GMAIL_FROM` — sender address for confirmation mail

- Work orders: copy `docs/PLAN-TEMPLATE.md` to `PLAN.md`, review with the VP of Product, then `agent-os dispatch PLAN.md`.
- `PROOF_CMD` for this repo: `npm test`
- Kill switch: label a PR `hold`.
- Rules for every seat: `AGENTS.md`.
