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

`GET /` serves the Marlo Scheduling placeholder. `GET /api/health` returns `{ "ok": true }`.

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
